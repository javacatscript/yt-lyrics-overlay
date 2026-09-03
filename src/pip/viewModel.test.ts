import { describe, expect, test } from 'vitest';

import { buildOverlayView } from './viewModel';
import type { LrcLine } from '../lib/types';

const LINES: LrcLine[] = [
  { text: 'first', timeMs: 1000 },
  { text: 'second', timeMs: 2000 },
  { text: 'third', timeMs: 3000 },
];

describe('buildOverlayView', () => {
  test('returns an empty view for no lines', () => {
    expect(buildOverlayView([], -1)).toEqual({
      current: null,
      isPending: true,
      next: null,
      previous: null,
    });
  });

  test('shows the upcoming line while waiting for the first lyric', () => {
    expect(buildOverlayView(LINES, -1)).toEqual({
      current: null,
      isPending: true,
      next: 'first',
      previous: null,
    });
  });

  test('surrounds the active line with its neighbours', () => {
    expect(buildOverlayView(LINES, 1)).toEqual({
      current: 'second',
      isPending: false,
      next: 'third',
      previous: 'first',
    });
  });

  test('has no previous line on the first lyric', () => {
    expect(buildOverlayView(LINES, 0)).toEqual({
      current: 'first',
      isPending: false,
      next: 'second',
      previous: null,
    });
  });

  test('has no next line on the last lyric', () => {
    expect(buildOverlayView(LINES, 2)).toEqual({
      current: 'third',
      isPending: false,
      next: null,
      previous: 'second',
    });
  });

  test('passes an interlude marker through as the active line', () => {
    const withMarker: LrcLine[] = [
      { text: 'intro', timeMs: 1000 },
      { text: '♪', timeMs: 2000 },
    ];

    expect(buildOverlayView(withMarker, 1).current).toBe('♪');
  });

  test('clamps an active index beyond the end of the lines', () => {
    expect(buildOverlayView(LINES, 99).current).toBe('third');
  });
});
