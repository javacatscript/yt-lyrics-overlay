import { buildTrackKey, createLyricsResolver } from '../lib/lrclib';
import {
  createStorageCache,
  getEffectiveOffsetMs,
  getPlayerTabId,
  getSessionState,
  getTrackOffsetMs,
  setPlayerTabId,
  setSessionState,
  setTrackOffsetMs,
  updateSettings,
} from '../lib/storage';
import type {
  ContentRequest,
  NowPlayingState,
  OverlayOpenResult,
  TrackInfo,
  WorkerRequest,
} from '../lib/types';

const EMPTY_STATE: NowPlayingState = {
  effectiveOffsetMs: 0,
  lyrics: null,
  track: null,
  trackKey: null,
};

const resolver = createLyricsResolver({
  cache: createStorageCache(),
  fetchFn: (...args) => fetch(...args),
  getNowMs: () => Date.now(),
});

/**
 * Make the toolbar icon open the side panel.
 *
 * This must be re-applied on every worker start, not just on install: MV3
 * evicts the worker constantly, and reloading an unpacked extension does not
 * reliably fire `onInstalled`. A failure here is logged rather than swallowed,
 * because silently losing the only way into the UI is indistinguishable from
 * the extension being broken.
 */
async function enableActionOpensPanel(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('[lyrics-overlay] setPanelBehavior failed', error);
  }
}

chrome.runtime.onInstalled.addListener(() => void enableActionOpensPanel());
chrome.runtime.onStartup.addListener(() => void enableActionOpensPanel());
void enableActionOpensPanel();

/**
 * Fallback path. When `openPanelOnActionClick` is in effect Chrome opens the
 * panel itself and this never fires; when it is not, this is the only thing
 * that makes the toolbar icon do anything at all.
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) {
    return;
  }
  void chrome.sidePanel.open({ tabId: tab.id }).catch((error: unknown) => {
    console.warn('[lyrics-overlay] sidePanel.open failed', error);
  });
});

async function resolveNowPlaying(track: TrackInfo): Promise<NowPlayingState> {
  const trackKey = buildTrackKey(track);

  let lyrics: NowPlayingState['lyrics'] = null;
  try {
    lyrics = await resolver.getLyrics(track);
  } catch {
    // A network failure is left uncached, so the next track event retries.
    lyrics = null;
  }

  const state: NowPlayingState = {
    effectiveOffsetMs: await getEffectiveOffsetMs(trackKey),
    lyrics,
    track,
    trackKey,
  };

  await setSessionState(state);
  return state;
}

/**
 * Forwards a request into the YouTube Music tab.
 *
 * The tab id comes from `sender.tab` on the content script's own messages,
 * which needs no `tabs` permission, and is kept in session storage so it
 * survives the worker being evicted between the panel opening and a click.
 */
async function forwardToPlayer(request: ContentRequest): Promise<OverlayOpenResult> {
  const tabId = await getPlayerTabId();
  if (tabId === null) {
    return { isOpen: false, reason: 'no_player' };
  }

  try {
    const result = (await chrome.tabs.sendMessage(tabId, request)) as OverlayOpenResult;
    return result ?? { isOpen: false, reason: 'no_player' };
  } catch {
    // The tab is gone or has no content script.
    return { isOpen: false, reason: 'no_player' };
  }
}

async function handleRequest(
  request: WorkerRequest,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  if (sender.tab?.id !== undefined) {
    await setPlayerTabId(sender.tab.id);
  }

  switch (request.type) {
    case 'GET_LYRICS':
      return resolveNowPlaying(request.track);

    case 'GET_STATE':
      return (await getSessionState()) ?? EMPTY_STATE;

    case 'NUDGE_OFFSET': {
      const current = (await getTrackOffsetMs(request.trackKey)) ?? 0;
      const next = current + request.deltaMs;
      await setTrackOffsetMs(request.trackKey, next);

      const state = await getSessionState();
      if (state !== null && state.trackKey === request.trackKey) {
        await setSessionState({ ...state, effectiveOffsetMs: next });
      }
      return { offsetMs: next };
    }

    case 'SET_SETTINGS':
      return updateSettings(request.patch);

    case 'OPEN_OVERLAY':
      return forwardToPlayer({ type: 'OPEN_OVERLAY' });

    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((request: WorkerRequest, sender, respond) => {
  void handleRequest(request, sender).then(respond, () => respond(null));
  return true;
});
