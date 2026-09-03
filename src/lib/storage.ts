import type { CacheEntry, LyricsCache, NowPlayingState } from './types';

const CACHE_PREFIX = 'lrc:v1:';
const CACHE_INDEX_KEY = 'lrc:index:v1';
const CACHE_LIMIT = 500;
/** How many entries to drop when a write hits the storage quota. */
const QUOTA_EVICTION_COUNT = 100;

const OFFSET_PREFIX = 'offset:v1:';
/** Exported so listeners can watch for changes to exactly this key. */
export const SETTINGS_KEY = 'settings:v1';
const SESSION_STATE_KEY = 'nowPlaying';
const SESSION_TAB_KEY = 'playerTabId';

export interface Settings {
  fontScale: number;
  globalOffsetMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  fontScale: 1,
  globalOffsetMs: 0,
};

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.fetchedAtMs === 'number' && 'record' in entry;
}

async function getCacheIndex(): Promise<string[]> {
  const bag = await chrome.storage.local.get(CACHE_INDEX_KEY);
  const raw = bag[CACHE_INDEX_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((key): key is string => typeof key === 'string');
}

/**
 * Keeps the cache bounded. `chrome.storage.local` has no intrinsic ordering,
 * so recency is tracked in a companion index: most recently written last.
 */
async function pruneCache(storageKey: string): Promise<void> {
  const index = await getCacheIndex();
  const next = [...index.filter((key) => key !== storageKey), storageKey];

  const overflow = next.length - CACHE_LIMIT;
  if (overflow > 0) {
    const evicted = next.splice(0, overflow);
    await chrome.storage.local.remove(evicted);
  }

  await chrome.storage.local.set({ [CACHE_INDEX_KEY]: next });
}

async function evictOldest(count: number): Promise<void> {
  const index = await getCacheIndex();
  const evicted = index.slice(0, count);
  if (evicted.length === 0) {
    return;
  }
  await chrome.storage.local.remove(evicted);
  await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index.slice(evicted.length) });
}

export function createStorageCache(): LyricsCache {
  return {
    async get(key: string): Promise<CacheEntry | null> {
      const storageKey = CACHE_PREFIX + key;
      const bag = await chrome.storage.local.get(storageKey);
      const entry = bag[storageKey];
      return isCacheEntry(entry) ? entry : null;
    },

    async set(key: string, entry: CacheEntry): Promise<void> {
      const storageKey = CACHE_PREFIX + key;
      try {
        await chrome.storage.local.set({ [storageKey]: entry });
      } catch {
        // Almost certainly the quota. Make room and try once more; if this
        // fails too, a missing cache entry is survivable.
        await evictOldest(QUOTA_EVICTION_COUNT);
        try {
          await chrome.storage.local.set({ [storageKey]: entry });
        } catch {
          return;
        }
      }
      await pruneCache(storageKey);
    },
  };
}

export async function getSettings(): Promise<Settings> {
  const bag = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = bag[SETTINGS_KEY];
  if (typeof stored !== 'object' || stored === null) {
    return DEFAULT_SETTINGS;
  }
  const settings = stored as Record<string, unknown>;

  return {
    fontScale:
      typeof settings.fontScale === 'number' ? settings.fontScale : DEFAULT_SETTINGS.fontScale,
    globalOffsetMs:
      typeof settings.globalOffsetMs === 'number'
        ? settings.globalOffsetMs
        : DEFAULT_SETTINGS.globalOffsetMs,
  };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getTrackOffsetMs(trackKey: string): Promise<number | null> {
  const storageKey = OFFSET_PREFIX + trackKey;
  const bag = await chrome.storage.local.get(storageKey);
  const stored = bag[storageKey];
  return typeof stored === 'number' ? stored : null;
}

export async function setTrackOffsetMs(trackKey: string, offsetMs: number): Promise<void> {
  await chrome.storage.local.set({ [OFFSET_PREFIX + trackKey]: offsetMs });
}

/**
 * A per-track offset wins over the global default, because a specific upload
 * with an intro is reliably out by the same amount every play.
 */
export async function getEffectiveOffsetMs(trackKey: string): Promise<number> {
  const trackOffset = await getTrackOffsetMs(trackKey);
  if (trackOffset !== null) {
    return trackOffset;
  }
  return (await getSettings()).globalOffsetMs;
}

/**
 * Session storage, not local: the now-playing state is worth surviving a
 * service-worker eviction but must not outlive the browser session.
 */
export async function setSessionState(state: NowPlayingState): Promise<void> {
  await chrome.storage.session.set({ [SESSION_STATE_KEY]: state });
}

export async function getSessionState(): Promise<NowPlayingState | null> {
  const bag = await chrome.storage.session.get(SESSION_STATE_KEY);
  const state = bag[SESSION_STATE_KEY];
  if (typeof state !== 'object' || state === null) {
    return null;
  }
  return state as NowPlayingState;
}

export async function setPlayerTabId(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [SESSION_TAB_KEY]: tabId });
}

export async function getPlayerTabId(): Promise<number | null> {
  const bag = await chrome.storage.session.get(SESSION_TAB_KEY);
  const tabId = bag[SESSION_TAB_KEY];
  return typeof tabId === 'number' ? tabId : null;
}
