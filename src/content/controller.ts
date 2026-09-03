import type { TrackDetector } from './detector';
import { getVideoElement } from './media';
import {
  getIsPipSupported,
  hideLauncherButton,
  openPipSession,
  showLauncherButton,
} from './pipHost';
import type { PipSession } from './pipHost';
import { findActiveLineIndex, parseLrc } from '../lib/lrc';
import { buildTrackKey } from '../lib/lrclib';
import { SETTINGS_KEY, getSettings } from '../lib/storage';
import type {
  ContentRequest,
  LrcLine,
  NowPlayingState,
  OverlayOpenResult,
  TrackInfo,
  WorkerRequest,
} from '../lib/types';

/** A duration this far from the matched record means the timings will not fit. */
const DURATION_MISMATCH_TOLERANCE_SEC = 3;
const NUDGE_STATUS_TIMEOUT_MS = 1200;

interface PlaybackState {
  fontScale: number;
  lines: LrcLine[];
  offsetMs: number;
  session: PipSession | null;
  status: string | null;
  track: TrackInfo | null;
  trackKey: string | null;
  warning: string | null;
}

const state: PlaybackState = {
  fontScale: 1,
  lines: [],
  offsetMs: 0,
  session: null,
  status: 'Waiting for a track…',
  track: null,
  trackKey: null,
  warning: null,
};

/** Exactly one detector runs per page, assigned by `startController`. */
let detector: TrackDetector | null = null;

let frameHandle: number | null = null;
let lastActiveIndex = -1;
let attachedVideo: HTMLVideoElement | null = null;
let detachMedia: (() => void) | null = null;

async function sendToWorker<T>(request: WorkerRequest): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(request)) as T;
  } catch {
    // The worker is asleep or the extension reloaded; the next event retries.
    return null;
  }
}

function getStatusForState(nowPlaying: NowPlayingState): string | null {
  switch (nowPlaying.lyrics?.status) {
    case 'synced':
      return null;
    case 'instrumental':
      return '♪ instrumental';
    case 'plain_only':
      return 'Only untimed lyrics found — open the side panel to read them.';
    case 'not_found':
      return 'No lyrics found for this track.';
    default:
      return 'Looking up lyrics…';
  }
}

/**
 * A record whose duration disagrees with what is playing will drift no matter
 * what, so say so rather than letting it look broken. This fires often on
 * regular YouTube, where a re-upload or lyric video rarely matches the album
 * cut exactly.
 */
function getWarningForState(nowPlaying: NowPlayingState): string | null {
  const recordDuration = nowPlaying.lyrics?.record?.duration;
  const trackDuration = nowPlaying.track?.durationSec;
  if (
    typeof recordDuration !== 'number' ||
    typeof trackDuration !== 'number' ||
    Math.abs(recordDuration - trackDuration) <= DURATION_MISMATCH_TOLERANCE_SEC
  ) {
    return null;
  }
  return 'Sync may be off — this version differs from the matched lyrics.';
}

function paintFrame(): void {
  const { session } = state;
  if (session === null) {
    return;
  }

  const video = getVideoElement();
  const positionSec = video?.currentTime ?? 0;
  const durationSec = video?.duration ?? 0;
  const isPlaying = video !== null && !video.paused && !video.ended;

  if (detector?.getIsAdPlaying() === true) {
    session.handles.setStatus('Advertisement…');
    return;
  }
  session.handles.setStatus(state.status);
  session.handles.setWarning(state.warning);

  const activeIndex =
    state.lines.length === 0
      ? -1
      : findActiveLineIndex(
          state.lines,
          positionSec * 1000 + state.offsetMs,
          lastActiveIndex,
        );
  lastActiveIndex = activeIndex;

  session.handles.update({
    activeIndex,
    durationSec,
    fontScale: state.fontScale,
    isPlaying,
    lines: state.lines,
    offsetMs: state.offsetMs,
    positionSec,
  });
}

/**
 * The render loop. `paintFrame` reads `currentTime` in the same context and on
 * the same frame it paints, so there is no clock to reconcile and no drift.
 */
function runFrameLoop(): void {
  if (state.session === null) {
    return;
  }
  paintFrame();

  const video = getVideoElement();
  if (video === null || video.paused || video.ended) {
    frameHandle = null;
    return;
  }
  frameHandle = requestAnimationFrame(runFrameLoop);
}

function startFrameLoop(): void {
  if (frameHandle !== null || state.session === null) {
    return;
  }
  frameHandle = requestAnimationFrame(runFrameLoop);
}

function stopFrameLoop(): void {
  if (frameHandle !== null) {
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
}

function attachMediaListeners(video: HTMLVideoElement): () => void {
  // `seeked` and `play` each need one repaint even when the loop is stopped.
  const onResume = (): void => startFrameLoop();
  const onSettle = (): void => {
    paintFrame();
    startFrameLoop();
  };
  const onTrackMaybeChanged = (): void => void refreshTrack();

  const renderEvents: readonly [string, EventListener][] = [
    ['play', onResume],
    ['playing', onResume],
    ['seeked', onSettle],
    ['pause', paintFrame],
    ['loadedmetadata', onTrackMaybeChanged],
    ['durationchange', onTrackMaybeChanged],
    ['emptied', onTrackMaybeChanged],
  ];

  for (const [event, handler] of renderEvents) {
    video.addEventListener(event, handler);
  }

  return (): void => {
    for (const [event, handler] of renderEvents) {
      video.removeEventListener(event, handler);
    }
  };
}

/**
 * Both sites mount their `<video>` after `document_idle` and swap it out on
 * some navigations, so binding once at startup silently binds to nothing.
 * Re-binds whenever the element identity changes; safe to call repeatedly.
 */
function ensureMediaListeners(): void {
  const video = getVideoElement();
  if (video === attachedVideo) {
    return;
  }
  detachMedia?.();
  attachedVideo = video;
  detachMedia = video === null ? null : attachMediaListeners(video);
}

function getTrackLabel(track: TrackInfo | null): string {
  if (track === null) {
    return 'Nothing playing';
  }
  return `${track.title} — ${track.artist}`;
}

function applyNowPlaying(nowPlaying: NowPlayingState): void {
  state.track = nowPlaying.track;
  state.trackKey = nowPlaying.trackKey;
  state.offsetMs = nowPlaying.effectiveOffsetMs;
  state.status = getStatusForState(nowPlaying);
  state.warning = getWarningForState(nowPlaying);

  const synced = nowPlaying.lyrics?.record?.syncedLyrics ?? null;
  state.lines = synced === null ? [] : parseLrc(synced);
  lastActiveIndex = -1;

  state.session?.handles.setTrackLabel(getTrackLabel(nowPlaying.track));
  refreshLauncher();
  paintFrame();
  startFrameLoop();
}

async function refreshTrack(): Promise<void> {
  ensureMediaListeners();

  const track = detector?.getCurrentTrack() ?? null;
  if (track === null) {
    state.status = 'Waiting for a track…';
    state.lines = [];
    state.track = null;
    state.trackKey = null;
    refreshLauncher();
    paintFrame();
    // Still talk to the worker: this is what registers our tab id, and without
    // it the side panel cannot reach us to open the overlay.
    await sendToWorker({ type: 'GET_STATE' });
    return;
  }

  // Compare the full identity, not just the title: the same song at a
  // different duration is a different upload and needs a different lookup.
  if (buildTrackKey(track) === state.trackKey && state.lines.length > 0) {
    return;
  }

  state.status = 'Looking up lyrics…';
  state.track = track;
  state.session?.handles.setTrackLabel(getTrackLabel(track));
  refreshLauncher();
  paintFrame();

  const nowPlaying = await sendToWorker<NowPlayingState>({ track, type: 'GET_LYRICS' });
  if (nowPlaying !== null) {
    applyNowPlaying(nowPlaying);
  }
}

async function handleNudge(deltaMs: number): Promise<void> {
  if (state.trackKey === null) {
    return;
  }
  state.offsetMs += deltaMs;
  paintFrame();

  await sendToWorker({ deltaMs, trackKey: state.trackKey, type: 'NUDGE_OFFSET' });

  // Briefly confirm the change, since a nudge during a long instrumental gap
  // has no visible effect on the lyric rows.
  const previousWarning = state.warning;
  state.warning = `Offset ${state.offsetMs >= 0 ? '+' : '−'}${(
    Math.abs(state.offsetMs) / 1000
  ).toFixed(1)}s`;
  paintFrame();
  setTimeout(() => {
    state.warning = previousWarning;
    paintFrame();
  }, NUDGE_STATUS_TIMEOUT_MS);
}

/**
 * Keeps an in-page launcher visible whenever there is something to show and no
 * overlay showing it.
 *
 * A click on this button is unambiguously a user gesture in the content
 * script's own context, which is the only route to a PiP window that does not
 * depend on activation propagating from the side panel.
 */
function refreshLauncher(): void {
  if (state.session !== null || state.track === null) {
    hideLauncherButton();
    return;
  }
  showLauncherButton(() => void openOverlay());
}

function teardownSession(): void {
  stopFrameLoop();
  state.session?.handles.destroy();
  state.session = null;
  lastActiveIndex = -1;
  refreshLauncher();
}

async function openOverlay(): Promise<OverlayOpenResult> {
  if (!getIsPipSupported()) {
    return { isOpen: false, reason: 'unsupported' };
  }
  if (getVideoElement() === null) {
    return { isOpen: false, reason: 'no_player' };
  }
  if (state.session !== null) {
    state.session.window.focus();
    return { isOpen: true, reason: null };
  }

  const outcome = await openPipSession(
    { onNudge: (deltaMs) => void handleNudge(deltaMs) },
    teardownSession,
  );

  if (outcome.session === null) {
    if (outcome.reason === 'gesture_required') {
      showLauncherButton(() => void openOverlay());
    }
    return { isOpen: false, reason: outcome.reason };
  }

  hideLauncherButton();
  state.session = outcome.session;
  state.session.handles.setTrackLabel(getTrackLabel(state.track));
  paintFrame();
  startFrameLoop();
  await refreshTrack();

  return { isOpen: true, reason: null };
}

function handleMessage(
  request: ContentRequest,
  _sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
): boolean {
  switch (request.type) {
    case 'OPEN_OVERLAY':
      void openOverlay().then(respond);
      return true;
    case 'REPORT_STATE':
      void refreshTrack().then(() => respond({ isOpen: state.session !== null }));
      return true;
    default:
      return false;
  }
}

/**
 * Font scale is read straight from storage rather than relayed through the
 * worker — a content script has `chrome.storage` access, and watching for
 * changes keeps the overlay live while the side-panel slider moves.
 */
async function syncSettings(): Promise<void> {
  const settings = await getSettings();
  state.fontScale = settings.fontScale;
  paintFrame();
}

export function startController(activeDetector: TrackDetector): void {
  detector = activeDetector;

  chrome.runtime.onMessage.addListener(handleMessage);
  activeDetector.watchTrackChanges(() => void refreshTrack());
  ensureMediaListeners();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SETTINGS_KEY in changes) {
      void syncSettings();
    }
  });
  window.addEventListener('pagehide', teardownSession);

  // Register this tab with the worker straight away, before any track exists.
  void sendToWorker({ type: 'GET_STATE' });
  void syncSettings();
  void refreshTrack();
}
