import type {
  LrclibRecord,
  LyricsCache,
  LyricsResult,
  LyricsStatus,
  TrackInfo,
} from './types';

const API_BASE = 'https://lrclib.net';

/**
 * How far a candidate's duration may sit from the playing track's, in seconds.
 * LRCLIB's own exact-match endpoint is similarly forgiving — a request for
 * 354s matches a 355s record — and this is what separates the album cut from
 * a remaster or a live version.
 */
const DURATION_TOLERANCE_SEC = 3;

/** A miss is remembered this long, so a track on repeat spares a free service. */
export const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * LRCLIB asks callers for a descriptive User-Agent, but `User-Agent` is a
 * forbidden header name for `fetch`, so a browser extension cannot set it —
 * the attempt is silently dropped. Identifying the client would need
 * `declarativeNetRequest` and its permission, which is not worth it here.
 */

interface ResolverDeps {
  cache: LyricsCache;
  fetchFn: typeof fetch;
  getNowMs: () => number;
}

export function buildTrackKey(track: TrackInfo): string {
  return [
    track.artist,
    track.title,
    track.album ?? '',
    String(Math.round(track.durationSec)),
  ].join('|');
}

function hasSyncedLyrics(record: LrclibRecord): boolean {
  return record.syncedLyrics !== null && record.syncedLyrics.trim() !== '';
}

function hasPlainLyrics(record: LrclibRecord): boolean {
  return record.plainLyrics !== null && record.plainLyrics.trim() !== '';
}

/** Instrumental wins over any lyric text — a marked instrumental has none. */
export function deriveStatus(record: LrclibRecord | null): LyricsStatus {
  if (record === null) {
    return 'not_found';
  }
  if (record.instrumental) {
    return 'instrumental';
  }
  if (hasSyncedLyrics(record)) {
    return 'synced';
  }
  if (hasPlainLyrics(record)) {
    return 'plain_only';
  }
  return 'not_found';
}

function getDurationDelta(record: LrclibRecord, durationSec: number): number {
  return Math.abs((record.duration ?? 0) - durationSec);
}

/**
 * Picks the best row from a fuzzy search.
 *
 * Search returns up to 20 rows for almost any query, so duration filtering is
 * mandatory, not an optimisation. A synced candidate always beats a plain one
 * even when the plain one's duration matches more closely — timestamps are the
 * entire point, and being a second or two out is what the offset control fixes.
 */
export function selectBestCandidate(
  candidates: readonly LrclibRecord[],
  durationSec: number,
): LrclibRecord | null {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.duration !== null &&
      getDurationDelta(candidate, durationSec) <= DURATION_TOLERANCE_SEC,
  );
  if (eligible.length === 0) {
    return null;
  }

  const synced = eligible.filter(hasSyncedLyrics);
  const pool = synced.length > 0 ? synced : eligible;

  return pool.reduce((best, candidate) =>
    getDurationDelta(candidate, durationSec) < getDurationDelta(best, durationSec)
      ? candidate
      : best,
  );
}

/** Narrows an API row to the fields we rely on, tolerating anything else. */
function normaliseRecord(payload: unknown): LrclibRecord | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const row = payload as Record<string, unknown>;

  return {
    duration: typeof row.duration === 'number' ? row.duration : null,
    instrumental: row.instrumental === true,
    plainLyrics: typeof row.plainLyrics === 'string' ? row.plainLyrics : null,
    syncedLyrics: typeof row.syncedLyrics === 'string' ? row.syncedLyrics : null,
  };
}

export function createLyricsResolver(deps: ResolverDeps): {
  getLyrics(track: TrackInfo): Promise<LyricsResult>;
} {
  const inFlight = new Map<string, Promise<LyricsResult>>();

  async function requestExact(track: TrackInfo): Promise<LrclibRecord | null> {
    const url = new URL('/api/get', API_BASE);
    url.searchParams.set('artist_name', track.artist);
    url.searchParams.set('track_name', track.title);
    if (track.album !== null && track.album !== '') {
      url.searchParams.set('album_name', track.album);
    }
    url.searchParams.set('duration', String(Math.round(track.durationSec)));

    const response = await deps.fetchFn(url.toString());
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`LRCLIB /api/get failed with ${response.status}`);
    }
    return normaliseRecord(await response.json());
  }

  async function requestSearch(track: TrackInfo): Promise<LrclibRecord | null> {
    const url = new URL('/api/search', API_BASE);
    url.searchParams.set('track_name', track.title);
    url.searchParams.set('artist_name', track.artist);

    const response = await deps.fetchFn(url.toString());
    if (!response.ok) {
      return null;
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      return null;
    }

    const candidates = payload
      .map(normaliseRecord)
      .filter((record): record is LrclibRecord => record !== null);

    return selectBestCandidate(candidates, track.durationSec);
  }

  async function getLyrics(track: TrackInfo): Promise<LyricsResult> {
    const key = buildTrackKey(track);

    const cached = await deps.cache.get(key);
    if (cached !== null) {
      if (cached.record !== null) {
        return { record: cached.record, status: deriveStatus(cached.record) };
      }
      if (deps.getNowMs() - cached.fetchedAtMs < NEGATIVE_CACHE_TTL_MS) {
        return { record: null, status: 'not_found' };
      }
    }

    const existing = inFlight.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const pending = (async (): Promise<LyricsResult> => {
      const exact = await requestExact(track);
      const record = exact ?? (await requestSearch(track));
      // Only reached on success, so a network failure caches nothing and the
      // next attempt retries rather than reusing a rejection.
      await deps.cache.set(key, { fetchedAtMs: deps.getNowMs(), record });
      return { record, status: deriveStatus(record) };
    })();

    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(key);
    }
  }

  return { getLyrics };
}
