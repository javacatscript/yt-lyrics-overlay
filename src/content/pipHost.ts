import { mountOverlay } from '../pip/overlay';
import type { OverlayCallbacks, OverlayHandles } from '../pip/overlay';
import type { OverlayFailure } from '../lib/types';

const PIP_WIDTH = 380;
const PIP_HEIGHT = 260;
const LAUNCHER_ID = 'lyrics-overlay-launcher';

export interface PipSession {
  handles: OverlayHandles;
  window: Window;
}

export type PipOpenOutcome =
  | { reason: OverlayFailure; session: null }
  | { reason: null; session: PipSession };

function getPipApi(): DocumentPictureInPicture | undefined {
  return window.documentPictureInPicture;
}

export function getIsPipSupported(): boolean {
  return getPipApi() !== undefined;
}

/**
 * A refusal for want of user activation is the one failure worth telling
 * apart: it is recoverable via an in-page button, whereas the others are not.
 */
function getFailureReason(error: unknown): OverlayFailure {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'gesture_required';
  }
  return 'unsupported';
}

/**
 * Opens the floating window and mounts the overlay into it.
 *
 * The browser permits only one Document PiP window at a time, so an existing
 * one is reused rather than allowed to fail.
 */
export async function openPipSession(
  callbacks: OverlayCallbacks,
  onClose: () => void,
): Promise<PipOpenOutcome> {
  const api = getPipApi();
  if (api === undefined) {
    return { reason: 'unsupported', session: null };
  }

  const existing = api.window;
  if (existing !== null && !existing.closed) {
    existing.focus();
    return {
      reason: null,
      session: { handles: mountOverlay(existing, callbacks), window: existing },
    };
  }

  let pipWindow: Window;
  try {
    pipWindow = await api.requestWindow({ height: PIP_HEIGHT, width: PIP_WIDTH });
  } catch (error) {
    return { reason: getFailureReason(error), session: null };
  }

  const handles = mountOverlay(pipWindow, callbacks);
  pipWindow.addEventListener('pagehide', onClose, { once: true });

  return { reason: null, session: { handles, window: pipWindow } };
}

/**
 * Fallback for a refused `requestWindow`: a button on the page itself, whose
 * click is unambiguously a user gesture.
 *
 * Injected only after the browser has actually refused, so it never appears if
 * activation does propagate from the side panel.
 */
export function showLauncherButton(onClick: () => void): void {
  if (document.getElementById(LAUNCHER_ID) !== null) {
    return;
  }

  const button = document.createElement('button');
  button.id = LAUNCHER_ID;
  button.type = 'button';
  button.textContent = '♪ Show lyrics overlay';
  button.setAttribute(
    'style',
    [
      'position:fixed',
      'right:18px',
      'bottom:88px',
      'z-index:2147483647',
      'padding:9px 14px',
      'border-radius:999px',
      'border:1px solid #2b2b31',
      'background:#0c0c0f',
      'color:#f4f4f5',
      'font:500 12.5px/1 ui-sans-serif,system-ui,sans-serif',
      'cursor:pointer',
      'box-shadow:0 4px 18px rgba(0,0,0,0.45)',
    ].join(';'),
  );

  button.addEventListener('click', () => {
    button.remove();
    onClick();
  });

  document.body.append(button);
}

export function hideLauncherButton(): void {
  document.getElementById(LAUNCHER_ID)?.remove();
}
