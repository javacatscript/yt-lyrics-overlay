import { describe, expect, test } from 'vitest';

import { findActiveLineIndex, parseLrc } from './lrc';

describe('parseLrc', () => {
  test('parses a line with centisecond precision', () => {
    expect(parseLrc('[00:13.13] Yeah')).toEqual([{ text: 'Yeah', timeMs: 13130 }]);
  });

  test('parses a line with millisecond precision', () => {
    expect(parseLrc('[00:13.135] Yeah')).toEqual([{ text: 'Yeah', timeMs: 13135 }]);
  });

  test('parses a line with no fractional part', () => {
    expect(parseLrc('[01:05] Hello')).toEqual([{ text: 'Hello', timeMs: 65000 }]);
  });

  test('converts minutes and seconds to milliseconds', () => {
    expect(parseLrc('[02:07.50] Line')).toEqual([{ text: 'Line', timeMs: 127500 }]);
  });

  test('handles minute values above 59', () => {
    expect(parseLrc('[100:00.00] Long')).toEqual([{ text: 'Long', timeMs: 6_000_000 }]);
  });

  test('expands multiple timestamps on one line into separate entries', () => {
    expect(parseLrc('[00:12.00][01:30.00] Chorus')).toEqual([
      { text: 'Chorus', timeMs: 12000 },
      { text: 'Chorus', timeMs: 90000 },
    ]);
  });

  test('sorts entries ascending regardless of input order', () => {
    const lines = parseLrc('[00:30.00] second\n[00:10.00] first');
    expect(lines.map((line) => line.text)).toEqual(['first', 'second']);
  });

  test('skips metadata tags', () => {
    const raw = '[ar:The Weeknd]\n[ti:Blinding Lights]\n[al:After Hours]\n[00:05.00] Yeah';
    expect(parseLrc(raw)).toEqual([{ text: 'Yeah', timeMs: 5000 }]);
  });

  test('shifts timestamps earlier for a positive offset tag', () => {
    // A positive [offset:] means lyrics should appear sooner.
    expect(parseLrc('[offset:+500]\n[00:10.00] Line')).toEqual([
      { text: 'Line', timeMs: 9500 },
    ]);
  });

  test('shifts timestamps later for a negative offset tag', () => {
    expect(parseLrc('[offset:-500]\n[00:10.00] Line')).toEqual([
      { text: 'Line', timeMs: 10500 },
    ]);
  });

  test('never emits a negative timestamp when an offset overshoots', () => {
    expect(parseLrc('[offset:+5000]\n[00:01.00] Line')).toEqual([
      { text: 'Line', timeMs: 0 },
    ]);
  });

  test('preserves an interlude marker as its own line', () => {
    expect(parseLrc('[00:16.56] ♪')).toEqual([{ text: '♪', timeMs: 16560 }]);
  });

  test('preserves a timestamped line with no text as a silent gap', () => {
    expect(parseLrc('[00:20.00]')).toEqual([{ text: '', timeMs: 20000 }]);
  });

  test('trims surrounding whitespace from lyric text', () => {
    expect(parseLrc('[00:05.00]    padded   ')).toEqual([{ text: 'padded', timeMs: 5000 }]);
  });

  test('skips malformed lines instead of throwing', () => {
    const raw = 'not a lyric line\n[garbage] nope\n[00:05.00] real';
    expect(parseLrc(raw)).toEqual([{ text: 'real', timeMs: 5000 }]);
  });

  test('returns an empty array for empty input', () => {
    expect(parseLrc('')).toEqual([]);
  });

  test('handles CRLF line endings', () => {
    expect(parseLrc('[00:01.00] a\r\n[00:02.00] b')).toEqual([
      { text: 'a', timeMs: 1000 },
      { text: 'b', timeMs: 2000 },
    ]);
  });
});

describe('findActiveLineIndex', () => {
  const lines = [
    { text: 'first', timeMs: 1000 },
    { text: 'second', timeMs: 2000 },
    { text: 'third', timeMs: 3000 },
  ];

  test('returns -1 before the first line is due', () => {
    expect(findActiveLineIndex(lines, 500)).toBe(-1);
  });

  test('returns the first index exactly on its timestamp', () => {
    expect(findActiveLineIndex(lines, 1000)).toBe(0);
  });

  test('returns the last line whose timestamp has passed', () => {
    expect(findActiveLineIndex(lines, 2500)).toBe(1);
  });

  test('returns the final index once past the last timestamp', () => {
    expect(findActiveLineIndex(lines, 99_000)).toBe(2);
  });

  test('returns -1 for an empty line list', () => {
    expect(findActiveLineIndex([], 5000)).toBe(-1);
  });

  test('advances by one when the hint is one line stale', () => {
    expect(findActiveLineIndex(lines, 2100, 0)).toBe(1);
  });

  test('corrects a hint left stale by a forward seek', () => {
    expect(findActiveLineIndex(lines, 3500, 0)).toBe(2);
  });

  test('corrects a hint left stale by a backward seek', () => {
    expect(findActiveLineIndex(lines, 1100, 2)).toBe(0);
  });

  test('ignores an out-of-range hint', () => {
    expect(findActiveLineIndex(lines, 2500, 99)).toBe(1);
  });

  test('agrees with the unhinted result at every position', () => {
    for (let positionMs = 0; positionMs <= 4000; positionMs += 100) {
      const expected = findActiveLineIndex(lines, positionMs);
      for (let hint = -1; hint < lines.length; hint += 1) {
        expect(findActiveLineIndex(lines, positionMs, hint)).toBe(expected);
      }
    }
  });
});
