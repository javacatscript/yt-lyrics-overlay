/** Shared shapes. No behaviour lives here. */

/** What the content script manages to work out about the current track. */
export interface TrackInfo {
  album: string | null;
  artist: string;
  durationSec: number;
  title: string;
}

/** One timed lyric line. `text` may be empty (a deliberate silent gap). */
export interface LrcLine {
  text: string;
  timeMs: number;
}

/** A lyrics record as LRCLIB returns it, narrowed to what we use. */
export interface LrclibRecord {
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export type LyricsStatus = 'instrumental' | 'not_found' | 'plain_only' | 'synced';

/** Resolved lyrics for a track, plus how usable they turned out to be. */
export interface LyricsResult {
  record: LrclibRecord | null;
  status: LyricsStatus;
}

/** A cache entry. A `null` record is a negative cache marker. */
export interface CacheEntry {
  fetchedAtMs: number;
  record: LrclibRecord | null;
}

/** Storage port, so the resolver can be tested without `chrome.storage`. */
export interface LyricsCache {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/** Messages the content script and side panel send to the service worker. */
export type WorkerRequest =
  | { deltaMs: number; trackKey: string; type: 'NUDGE_OFFSET' }
  | { patch: Partial<{ fontScale: number; globalOffsetMs: number }>; type: 'SET_SETTINGS' }
  | { track: TrackInfo; type: 'GET_LYRICS' }
  | { type: 'GET_STATE' }
  | { type: 'OPEN_OVERLAY' };

/** Messages the service worker forwards to the content script. */
export type ContentRequest = { type: 'OPEN_OVERLAY' } | { type: 'REPORT_STATE' };

/**
 * Why the overlay could not be opened.
 * `gesture_required` is the interesting one: the browser refused for want of
 * user activation, so the content script falls back to an in-page button.
 */
export type OverlayFailure = 'gesture_required' | 'no_player' | 'unsupported';

export interface OverlayOpenResult {
  isOpen: boolean;
  reason: OverlayFailure | null;
}

/** What the service worker sends back or broadcasts. */
export interface NowPlayingState {
  effectiveOffsetMs: number;
  lyrics: LyricsResult | null;
  track: TrackInfo | null;
  trackKey: string | null;
}
