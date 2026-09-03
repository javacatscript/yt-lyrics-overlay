import type { LrcLine } from '../lib/types';

/** The three lines the karaoke layout shows, plus the pre-first-lyric state. */
export interface OverlayView {
  current: string | null;
  /** True before the first lyric is due — the overlay shows a waiting state. */
  isPending: boolean;
  next: string | null;
  previous: string | null;
}

const EMPTY_VIEW: OverlayView = {
  current: null,
  isPending: true,
  next: null,
  previous: null,
};

function getText(lines: readonly LrcLine[], index: number): string | null {
  return lines[index]?.text ?? null;
}

/**
 * Maps an active line index onto what the overlay should display.
 *
 * An out-of-range index is clamped rather than rejected, so a stale index
 * never blanks the overlay mid-song.
 */
export function buildOverlayView(
  lines: readonly LrcLine[],
  activeIndex: number,
): OverlayView {
  if (lines.length === 0) {
    return EMPTY_VIEW;
  }

  if (activeIndex < 0) {
    return { ...EMPTY_VIEW, next: getText(lines, 0) };
  }

  const index = Math.min(activeIndex, lines.length - 1);

  return {
    current: getText(lines, index),
    isPending: false,
    next: getText(lines, index + 1),
    previous: index > 0 ? getText(lines, index - 1) : null,
  };
}
