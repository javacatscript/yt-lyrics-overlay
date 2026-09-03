import { getSettings } from '../lib/storage';
import type {
  LyricsStatus,
  NowPlayingState,
  OverlayFailure,
  OverlayOpenResult,
  WorkerRequest,
} from '../lib/types';

const POLL_INTERVAL_MS = 2000;

function query<T extends HTMLElement>(role: string): T {
  const element = document.querySelector<T>(`[data-role="${role}"]`);
  if (element === null) {
    throw new Error(`Panel element missing: ${role}`);
  }
  return element;
}

const elements = {
  hint: query('hint'),
  now: query('now'),
  offset: query<HTMLInputElement>('offset'),
  offsetOut: query<HTMLOutputElement>('offset-out'),
  open: query<HTMLButtonElement>('open'),
  plainSection: query('plain-section'),
  plainText: query('plain-text'),
  scale: query<HTMLInputElement>('scale'),
  scaleOut: query<HTMLOutputElement>('scale-out'),
  status: query('status'),
};

async function sendToWorker<T>(request: WorkerRequest): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(request)) as T;
  } catch {
    return null;
  }
}

const STATUS_COPY: Record<LyricsStatus, { text: string; tone: string }> = {
  instrumental: { text: 'Instrumental — no lyrics to show', tone: 'neutral' },
  not_found: { text: 'No lyrics found on LRCLIB', tone: 'warn' },
  plain_only: { text: 'Untimed lyrics only — shown below', tone: 'warn' },
  synced: { text: 'Synced lyrics ready', tone: 'good' },
};

const FAILURE_COPY: Record<OverlayFailure, string> = {
  gesture_required:
    'Chrome needs a click on the page itself. Look for the “Show lyrics overlay” button on YouTube Music.',
  no_player: 'Open a YouTube Music tab and start playing something first.',
  unsupported:
    'This Chrome build does not support Document Picture-in-Picture (needs Chrome 116+).',
};

function renderState(state: NowPlayingState | null): void {
  if (state === null || state.track === null) {
    elements.now.textContent = 'Nothing playing';
    elements.status.textContent = 'Waiting for YouTube Music…';
    elements.status.dataset.tone = 'neutral';
    elements.plainSection.hidden = true;
    return;
  }

  elements.now.textContent = `${state.track.title} — ${state.track.artist}`;

  const status = state.lyrics?.status;
  if (status === undefined) {
    elements.status.textContent = 'Looking up lyrics…';
    elements.status.dataset.tone = 'neutral';
  } else {
    const copy = STATUS_COPY[status];
    elements.status.textContent = copy.text;
    elements.status.dataset.tone = copy.tone;
  }

  // Untimed text is worth reading in the panel; it is not worth floating.
  const plain = state.lyrics?.record?.plainLyrics ?? null;
  const shouldShowPlain = status === 'plain_only' && plain !== null;
  elements.plainSection.hidden = !shouldShowPlain;
  if (shouldShowPlain) {
    elements.plainText.textContent = plain;
  }
}

function formatOffset(offsetMs: number): string {
  const sign = offsetMs > 0 ? '+' : offsetMs < 0 ? '−' : '';
  return `${sign}${(Math.abs(offsetMs) / 1000).toFixed(1)}s`;
}

async function refresh(): Promise<void> {
  renderState(await sendToWorker<NowPlayingState>({ type: 'GET_STATE' }));
}

async function handleOpenClick(): Promise<void> {
  elements.open.disabled = true;
  elements.hint.hidden = true;

  const result = await sendToWorker<OverlayOpenResult>({ type: 'OPEN_OVERLAY' });

  if (result === null) {
    elements.hint.textContent =
      'Could not reach the extension. Try reloading the YouTube Music tab.';
    elements.hint.hidden = false;
  } else if (!result.isOpen && result.reason !== null) {
    elements.hint.textContent = FAILURE_COPY[result.reason];
    elements.hint.hidden = false;
  }

  elements.open.disabled = false;
  void refresh();
}

async function start(): Promise<void> {
  const settings = await getSettings();

  elements.offset.value = String(settings.globalOffsetMs);
  elements.offsetOut.textContent = formatOffset(settings.globalOffsetMs);
  elements.scale.value = String(settings.fontScale);
  elements.scaleOut.textContent = `${settings.fontScale.toFixed(1)}×`;

  elements.open.addEventListener('click', () => void handleOpenClick());

  elements.offset.addEventListener('input', () => {
    const globalOffsetMs = Number(elements.offset.value);
    elements.offsetOut.textContent = formatOffset(globalOffsetMs);
    void sendToWorker({ patch: { globalOffsetMs }, type: 'SET_SETTINGS' });
  });

  elements.scale.addEventListener('input', () => {
    const fontScale = Number(elements.scale.value);
    elements.scaleOut.textContent = `${fontScale.toFixed(1)}×`;
    void sendToWorker({ patch: { fontScale }, type: 'SET_SETTINGS' });
  });

  await refresh();
  // The worker cannot push to a panel that may not be open, so poll gently.
  setInterval(() => void refresh(), POLL_INTERVAL_MS);
}

void start();
