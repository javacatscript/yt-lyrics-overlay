import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  NEGATIVE_CACHE_TTL_MS,
  buildTrackKey,
  createLyricsResolver,
  deriveStatus,
  selectBestCandidate,
} from './lrclib';
import type { CacheEntry, LrclibRecord, LyricsCache, TrackInfo } from './types';

/** A real Map-backed cache, so the resolver is exercised against real storage. */
class MemoryCache implements LyricsCache {
  private readonly entries = new Map<string, CacheEntry>();

  async get(key: string): Promise<CacheEntry | null> {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
  }

  get size(): number {
    return this.entries.size;
  }
}

function buildRecord(overrides: Partial<LrclibRecord> = {}): LrclibRecord {
  return {
    duration: 200,
    instrumental: false,
    plainLyrics: 'plain text',
    syncedLyrics: '[00:01.00] line',
    ...overrides,
  };
}

const TRACK: TrackInfo = {
  album: 'After Hours',
  artist: 'The Weeknd',
  durationSec: 200,
  title: 'Blinding Lights',
};

describe('buildTrackKey', () => {
  test('combines artist, title, album and rounded duration', () => {
    expect(buildTrackKey(TRACK)).toBe('The Weeknd|Blinding Lights|After Hours|200');
  });

  test('rounds a fractional duration', () => {
    expect(buildTrackKey({ ...TRACK, durationSec: 200.6 })).toContain('|201');
  });

  test('represents a missing album consistently', () => {
    expect(buildTrackKey({ ...TRACK, album: null })).toBe(
      'The Weeknd|Blinding Lights||200',
    );
  });

  test('distinguishes the same song at a different duration', () => {
    expect(buildTrackKey({ ...TRACK, durationSec: 240 })).not.toBe(buildTrackKey(TRACK));
  });
});

describe('selectBestCandidate', () => {
  test('returns null when there are no candidates', () => {
    expect(selectBestCandidate([], 200)).toBeNull();
  });

  test('rejects a candidate outside the duration tolerance', () => {
    const candidates = [buildRecord({ duration: 260 })];
    expect(selectBestCandidate(candidates, 200)).toBeNull();
  });

  test('accepts a candidate exactly on the tolerance boundary', () => {
    const candidate = buildRecord({ duration: 203 });
    expect(selectBestCandidate([candidate], 200)).toBe(candidate);
  });

  test('prefers a synced candidate over a closer plain-only one', () => {
    const plainExactMatch = buildRecord({ duration: 200, syncedLyrics: null });
    const syncedNearMatch = buildRecord({ duration: 202 });

    expect(selectBestCandidate([plainExactMatch, syncedNearMatch], 200)).toBe(
      syncedNearMatch,
    );
  });

  test('picks the closest duration among synced candidates', () => {
    const near = buildRecord({ duration: 201 });
    const far = buildRecord({ duration: 203 });

    expect(selectBestCandidate([far, near], 200)).toBe(near);
  });

  test('falls back to a plain-only candidate when none are synced', () => {
    const plain = buildRecord({ duration: 200, syncedLyrics: null });
    expect(selectBestCandidate([plain], 200)).toBe(plain);
  });

  test('excludes a candidate whose duration is unknown', () => {
    expect(selectBestCandidate([buildRecord({ duration: null })], 200)).toBeNull();
  });

  test('treats an empty synced string as not synced', () => {
    const empty = buildRecord({ duration: 202, syncedLyrics: '' });
    const synced = buildRecord({ duration: 203 });

    expect(selectBestCandidate([empty, synced], 200)).toBe(synced);
  });
});

describe('deriveStatus', () => {
  test('reports not_found for a null record', () => {
    expect(deriveStatus(null)).toBe('not_found');
  });

  test('reports instrumental ahead of any lyric text', () => {
    expect(deriveStatus(buildRecord({ instrumental: true }))).toBe('instrumental');
  });

  test('reports synced when timestamped lyrics exist', () => {
    expect(deriveStatus(buildRecord())).toBe('synced');
  });

  test('reports plain_only when only untimed text exists', () => {
    expect(deriveStatus(buildRecord({ syncedLyrics: null }))).toBe('plain_only');
  });

  test('reports not_found when both lyric fields are empty', () => {
    expect(deriveStatus(buildRecord({ plainLyrics: '', syncedLyrics: '' }))).toBe(
      'not_found',
    );
  });
});

describe('createLyricsResolver', () => {
  let cache: MemoryCache;
  let requestedUrls: string[];
  let nowMs: number;

  beforeEach(() => {
    cache = new MemoryCache();
    requestedUrls = [];
    nowMs = 1_000_000;
  });

  type FetchRoute = '/api/get' | '/api/search' | 'lyrics.ovh';

  /**
   * Responds from a queue keyed by route, recording every URL requested.
   * lyrics.ovh's path is dynamic (`/v1/{artist}/{title}`), so it is matched by
   * host rather than by exact pathname.
   */
  function buildFetch(handlers: Partial<Record<FetchRoute, () => Response>>): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedUrls.push(url.toString());
      const pathname = url.pathname as '/api/get' | '/api/search';
      const route: FetchRoute = url.hostname === 'api.lyrics.ovh' ? 'lyrics.ovh' : pathname;
      const handler = handlers[route];
      if (handler === undefined) {
        return new Response(null, { status: 404 });
      }
      return handler();
    }) as unknown as typeof fetch;
  }

  function buildResolver(fetchFn: typeof fetch) {
    return createLyricsResolver({ cache, fetchFn, getNowMs: () => nowMs });
  }

  test('returns a cached record without touching the network', async () => {
    await cache.set(buildTrackKey(TRACK), {
      fetchedAtMs: nowMs,
      record: buildRecord(),
      source: 'lrclib',
    });
    const fetchFn = buildFetch({});

    const result = await buildResolver(fetchFn).getLyrics(TRACK);

    expect(result.status).toBe('synced');
    expect(requestedUrls).toEqual([]);
  });

  test('requests /api/get with artist, title, album and duration', async () => {
    const fetchFn = buildFetch({
      '/api/get': () => new Response(JSON.stringify(buildRecord()), { status: 200 }),
    });

    await buildResolver(fetchFn).getLyrics(TRACK);

    const url = new URL(requestedUrls[0] ?? '');
    expect(url.pathname).toBe('/api/get');
    expect(url.searchParams.get('artist_name')).toBe('The Weeknd');
    expect(url.searchParams.get('track_name')).toBe('Blinding Lights');
    expect(url.searchParams.get('album_name')).toBe('After Hours');
    expect(url.searchParams.get('duration')).toBe('200');
  });

  test('caches a successful record', async () => {
    const fetchFn = buildFetch({
      '/api/get': () => new Response(JSON.stringify(buildRecord()), { status: 200 }),
    });

    await buildResolver(fetchFn).getLyrics(TRACK);

    const entry = await cache.get(buildTrackKey(TRACK));
    expect(entry?.record?.syncedLyrics).toBe('[00:01.00] line');
  });

  test('falls back to search when /api/get finds nothing', async () => {
    const searchHit = buildRecord({ duration: 201 });
    const fetchFn = buildFetch({
      '/api/get': () => new Response(null, { status: 404 }),
      '/api/search': () => new Response(JSON.stringify([searchHit]), { status: 200 }),
    });

    const result = await buildResolver(fetchFn).getLyrics(TRACK);

    expect(result.status).toBe('synced');
    expect(requestedUrls.map((url) => new URL(url).pathname)).toEqual([
      '/api/get',
      '/api/search',
    ]);
  });

  test('falls back to search when /api/get finds a row with no lyric text', async () => {
    // LRCLIB is crowd-sourced: an exact-match row can exist (right artist,
    // title, album and duration) with both lyric fields still empty, while a
    // different album pressing turned up by search has the real lyrics.
    const emptyExactMatch = buildRecord({ plainLyrics: null, syncedLyrics: null });
    const searchHit = buildRecord({ duration: 201 });
    const fetchFn = buildFetch({
      '/api/get': () => new Response(JSON.stringify(emptyExactMatch), { status: 200 }),
      '/api/search': () => new Response(JSON.stringify([searchHit]), { status: 200 }),
    });

    const result = await buildResolver(fetchFn).getLyrics(TRACK);

    expect(result.status).toBe('synced');
    expect(requestedUrls.map((url) => new URL(url).pathname)).toEqual([
      '/api/get',
      '/api/search',
    ]);
  });

  test('reports not_found when search returns only mismatched durations', async () => {
    const fetchFn = buildFetch({
      '/api/get': () => new Response(null, { status: 404 }),
      '/api/search': () =>
        new Response(JSON.stringify([buildRecord({ duration: 999 })]), { status: 200 }),
    });

    const result = await buildResolver(fetchFn).getLyrics(TRACK);

    expect(result.status).toBe('not_found');
    expect(result.record).toBeNull();
  });

  test('falls back to lyrics.ovh when LRCLIB has nothing at all', async () => {
    const fetchFn = buildFetch({
      '/api/get': () => new Response(null, { status: 404 }),
      '/api/search': () => new Response(JSON.stringify([]), { status: 200 }),
      'lyrics.ovh': () =>
        new Response(JSON.stringify({ lyrics: 'Yeah\nI have been tryna call' }), {
          status: 200,
        }),
    });

    const result = await buildResolver(fetchFn).getLyrics(TRACK);

    expect(result.status).toBe('plain_only');
    expect(result.source).toBe('lyrics.ovh');
    expect(result.record?.plainLyrics).toBe('Yeah\nI have been tryna call');
    expect(result.record?.syncedLyrics).toBeNull();

    const entry = await cache.get(buildTrackKey(TRACK));
    expect(entry?.source).toBe('lyrics.ovh');
  });

  test('does not query lyrics.ovh once LRCLIB already found a record', async () => {
    const fetchFn = buildFetch({
      '/api/get': () => new Response(JSON.stringify(buildRecord()), { status: 200 }),
      'lyrics.ovh': () => new Response(JSON.stringify({ lyrics: 'unused' }), { status: 200 }),
    });

    await buildResolver(fetchFn).getLyrics(TRACK);

    expect(requestedUrls.map((url) => new URL(url).hostname)).not.toContain('api.lyrics.ovh');
  });

  test('propagates a lyrics.ovh network failure without caching', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.lyrics.ovh') {
        throw new Error('offline');
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    await expect(buildResolver(fetchFn).getLyrics(TRACK)).rejects.toThrow('offline');
    expect(cache.size).toBe(0);
  });

  test('negative-caches a total miss across every source', async () => {
    const fetchFn = buildFetch({
      '/api/get': () => new Response(null, { status: 404 }),
      '/api/search': () => new Response(JSON.stringify([]), { status: 200 }),
      'lyrics.ovh': () => new Response(null, { status: 404 }),
    });

    await buildResolver(fetchFn).getLyrics(TRACK);

    const entry = await cache.get(buildTrackKey(TRACK));
    expect(entry).not.toBeNull();
    expect(entry?.record).toBeNull();
    expect(entry?.source).toBeNull();
  });

  test('honours a fresh negative cache without fetching', async () => {
    await cache.set(buildTrackKey(TRACK), { fetchedAtMs: nowMs, record: null, source: null });
    const fetchFn = buildFetch({});

    const result = await buildResolver(fetchFn).getLyrics(TRACK);

    expect(result.status).toBe('not_found');
    expect(requestedUrls).toEqual([]);
  });

  test('refetches once the negative cache has expired', async () => {
    await cache.set(buildTrackKey(TRACK), {
      fetchedAtMs: nowMs - NEGATIVE_CACHE_TTL_MS - 1,
      record: null,
      source: null,
    });
    const fetchFn = buildFetch({
      '/api/get': () => new Response(JSON.stringify(buildRecord()), { status: 200 }),
    });

    const result = await buildResolver(fetchFn).getLyrics(TRACK);

    expect(result.status).toBe('synced');
    expect(requestedUrls).toHaveLength(1);
  });

  test('deduplicates concurrent requests for the same track', async () => {
    let getCalls = 0;
    const fetchFn = buildFetch({
      '/api/get': () => {
        getCalls += 1;
        return new Response(JSON.stringify(buildRecord()), { status: 200 });
      },
    });
    const resolver = buildResolver(fetchFn);

    const results = await Promise.all([
      resolver.getLyrics(TRACK),
      resolver.getLyrics(TRACK),
      resolver.getLyrics(TRACK),
    ]);

    expect(getCalls).toBe(1);
    expect(results.map((result) => result.status)).toEqual([
      'synced',
      'synced',
      'synced',
    ]);
  });

  test('propagates a network failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(buildResolver(fetchFn).getLyrics(TRACK)).rejects.toThrow('offline');
  });

  test('caches nothing when the network fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await buildResolver(fetchFn)
      .getLyrics(TRACK)
      .catch(() => undefined);

    expect(cache.size).toBe(0);
  });

  test('retries after a failed request rather than reusing the rejection', async () => {
    let attempts = 0;
    const fetchFn = buildFetch({
      '/api/get': () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify(buildRecord()), { status: 200 });
      },
    });
    const resolver = buildResolver(fetchFn);

    await resolver.getLyrics(TRACK).catch(() => undefined);
    const result = await resolver.getLyrics(TRACK);

    expect(result.status).toBe('synced');
    expect(attempts).toBe(2);
  });
});
