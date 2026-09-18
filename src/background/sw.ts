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

const PANEL_PATH = 'src/sidepanel/panel.html';

/**
 * `chrome.sidePanel` is not guaranteed across Chromium builds — Brave ships
 * its own sidebar and can withhold the extension API. Feature-detect rather
 * than assume: calling a method on an absent namespace throws a *synchronous*
 * TypeError, which no `.catch()` on the returned promise can rescue.
 */
function getIsSidePanelSupported(): boolean {
  return typeof chrome.sidePanel?.open === 'function';
}

/**
 * Make the toolbar icon open the side panel.
 *
 * Re-applied on every worker start, not just on install: MV3 evicts the worker
 * constantly, and reloading an unpacked extension does not reliably fire
 * `onInstalled`. Failures are logged rather than swallowed, because silently
 * losing the way into the UI is indistinguishable from a broken extension.
 */
async function enableActionOpensPanel(): Promise<void> {
  if (!getIsSidePanelSupported()) {
    // The onClicked handler below covers this case.
    return;
  }
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
 * Opens the controls, degrading rather than failing.
 *
 * Where the side panel exists this uses it. Where it does not, the same page
 * opens in an ordinary tab — which matters because the in-page overlay toggle
 * lives there, and that surface needs no special API, so it must stay
 * reachable even on a browser with neither side panel nor Document PiP.
 */
async function openControls(tabId: number | undefined): Promise<void> {
  if (getIsSidePanelSupported() && tabId !== undefined) {
    try {
      await chrome.sidePanel.open({ tabId });
      return;
    } catch (error) {
      console.warn('[lyrics-overlay] sidePanel.open failed, opening a tab', error);
    }
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) });
}

/**
 * When `openPanelOnActionClick` is in effect the browser opens the panel
 * itself and this never fires; otherwise this is the only thing that makes the
 * toolbar icon do anything at all.
 */
chrome.action.onClicked.addListener((tab) => void openControls(tab.id));

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
