import css from './overlay.css?inline';
import { buildOverlayView } from './viewModel';
import type { LrcLine } from '../lib/types';

const INTERLUDE_MARKERS = new Set(['♪', '♫', '...', '…']);

export interface OverlayCallbacks {
  onNudge(deltaMs: number): void;
}

export interface OverlayHandles {
  destroy(): void;
  /** A message shown instead of lyrics (not found, instrumental, and so on). */
  setStatus(message: string | null): void;
  setTrackLabel(label: string): void;
  setWarning(message: string | null): void;
  update(state: OverlayFrame): void;
}

export interface OverlayFrame {
  activeIndex: number;
  durationSec: number;
  fontScale: number;
  isPlaying: boolean;
  lines: readonly LrcLine[];
  offsetMs: number;
  positionSec: number;
}

/**
 * Applies styles without tripping the host page's CSP.
 *
 * The PiP document is same-origin with music.youtube.com and inherits its
 * policy, so a constructed stylesheet is preferred. It must be built with the
 * PiP window's own constructor — a sheet made in another document cannot be
 * adopted. The `<style>` path is the documented fallback.
 */
function attachStyles(pipWindow: Window, root: ShadowRoot): void {
  const SheetConstructor = (
    pipWindow as Window & { CSSStyleSheet?: typeof CSSStyleSheet }
  ).CSSStyleSheet;

  if (SheetConstructor !== undefined) {
    try {
      const sheet = new SheetConstructor();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Fall through to the <style> element.
    }
  }

  const style = pipWindow.document.createElement('style');
  style.textContent = css;
  root.append(style);
}

function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0:00';
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatOffset(offsetMs: number): string {
  if (offsetMs === 0) {
    return '0.0s';
  }
  const sign = offsetMs > 0 ? '+' : '−';
  return `${sign}${(Math.abs(offsetMs) / 1000).toFixed(1)}s`;
}

function setLine(element: HTMLElement, text: string | null): void {
  element.textContent = text ?? '';
  element.classList.toggle('marker', text !== null && INTERLUDE_MARKERS.has(text));
}

/** Builds the overlay UI inside the PiP document and returns handles to it. */
export function mountOverlay(
  pipWindow: Window,
  callbacks: OverlayCallbacks,
): OverlayHandles {
  const { document: pipDocument } = pipWindow;
  pipDocument.body.style.margin = '0';

  const host = pipDocument.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  attachStyles(pipWindow, root);

  const shell = pipDocument.createElement('div');
  shell.className = 'shell';
  shell.innerHTML = `
    <div class="header">
      <span class="pulse"></span>
      <span class="track"></span>
    </div>
    <div class="body">
      <div class="line neighbour" data-role="previous"></div>
      <div class="line active" data-role="current"></div>
      <div class="line neighbour" data-role="next"></div>
      <p class="status" hidden></p>
      <p class="warn" hidden></p>
    </div>
    <div class="footer">
      <button type="button" data-role="back" title="Lyrics are ahead of the audio">−0.5s</button>
      <span class="clock"></span>
      <span class="offset-badge" data-zero="true"></span>
      <button type="button" data-role="forward" title="Lyrics are behind the audio">+0.5s</button>
    </div>
  `;
  root.append(shell);
  pipDocument.body.append(host);

  const query = <T extends HTMLElement>(selector: string): T => {
    const element = shell.querySelector<T>(selector);
    if (element === null) {
      throw new Error(`Overlay element missing: ${selector}`);
    }
    return element;
  };

  const elements = {
    back: query<HTMLButtonElement>('[data-role="back"]'),
    body: query('.body'),
    clock: query('.clock'),
    current: query('[data-role="current"]'),
    forward: query<HTMLButtonElement>('[data-role="forward"]'),
    next: query('[data-role="next"]'),
    offsetBadge: query('.offset-badge'),
    previous: query('[data-role="previous"]'),
    status: query('.status'),
    track: query('.track'),
    warn: query('.warn'),
  };

  const NUDGE_MS = 500;
  elements.back.addEventListener('click', () => callbacks.onNudge(-NUDGE_MS));
  elements.forward.addEventListener('click', () => callbacks.onNudge(NUDGE_MS));

  let lastRenderedIndex = Number.NaN;

  return {
    destroy(): void {
      host.remove();
    },

    setStatus(message: string | null): void {
      elements.status.textContent = message ?? '';
      elements.status.hidden = message === null;
      const areLinesVisible = message === null;
      for (const line of [elements.previous, elements.current, elements.next]) {
        line.hidden = !areLinesVisible;
      }
    },

    setTrackLabel(label: string): void {
      elements.track.textContent = label;
    },

    setWarning(message: string | null): void {
      elements.warn.textContent = message ?? '';
      elements.warn.hidden = message === null;
    },

    update(state: OverlayFrame): void {
      shell.dataset.playing = String(state.isPlaying);
      elements.body.style.setProperty('--scale', String(state.fontScale));
      elements.clock.textContent = `${formatClock(state.positionSec)} / ${formatClock(
        state.durationSec,
      )}`;
      elements.offsetBadge.textContent = formatOffset(state.offsetMs);
      elements.offsetBadge.dataset.zero = String(state.offsetMs === 0);

      // Repaint the lyric rows only when the active line actually changes.
      if (state.activeIndex === lastRenderedIndex) {
        return;
      }
      lastRenderedIndex = state.activeIndex;

      const view = buildOverlayView(state.lines, state.activeIndex);
      setLine(elements.previous, view.previous);
      setLine(elements.current, view.isPending ? '' : view.current);
      setLine(elements.next, view.next);
    },
  };
}
