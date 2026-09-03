import type { LrcLine } from './types';

/**
 * Matches `[mm:ss]`, `[mm:ss.xx]` and `[mm:ss.xxx]`. Minutes are unbounded so
 * that long mixes parse. Metadata tags such as `[ar:…]` cannot match, because
 * the pattern requires digits immediately after the bracket.
 */
const TIMESTAMP_PATTERN = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** `[offset:+500]` — milliseconds. Positive means "show the lyrics sooner". */
const OFFSET_PATTERN = /^\[offset:\s*([+-]?\d+)\s*\]$/i;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const FRACTION_DIGITS = 3;

/** `13` (centiseconds) becomes 130ms; `135` stays 135ms. */
function getFractionMs(fraction: string | undefined): number {
  if (fraction === undefined) {
    return 0;
  }
  return Number(fraction.padEnd(FRACTION_DIGITS, '0'));
}

function getOffsetMs(rawLines: readonly string[]): number {
  for (const rawLine of rawLines) {
    const match = OFFSET_PATTERN.exec(rawLine.trim());
    if (match?.[1] !== undefined) {
      return Number(match[1]);
    }
  }
  return 0;
}

function getTimestampsMs(rawLine: string): number[] {
  const timestamps: number[] = [];
  TIMESTAMP_PATTERN.lastIndex = 0;

  let match = TIMESTAMP_PATTERN.exec(rawLine);
  while (match !== null) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    timestamps.push(
      minutes * SECONDS_PER_MINUTE * MS_PER_SECOND +
        seconds * MS_PER_SECOND +
        getFractionMs(match[3]),
    );
    match = TIMESTAMP_PATTERN.exec(rawLine);
  }

  return timestamps;
}

/**
 * Parses an LRC document into ascending timed lines.
 *
 * Unparseable lines are skipped rather than fatal — community-contributed
 * lyrics are frequently ragged, and one bad line should not cost the song.
 * A timestamped line with no text is kept: it marks a deliberate silent gap.
 */
export function parseLrc(raw: string): LrcLine[] {
  const rawLines = raw.split(/\r?\n/);
  const offsetMs = getOffsetMs(rawLines);
  const lines: LrcLine[] = [];

  for (const rawLine of rawLines) {
    const timestamps = getTimestampsMs(rawLine);
    if (timestamps.length === 0) {
      continue;
    }

    const text = rawLine.replace(TIMESTAMP_PATTERN, '').trim();
    for (const timestamp of timestamps) {
      lines.push({ text, timeMs: Math.max(0, timestamp - offsetMs) });
    }
  }

  return lines.sort((left, right) => left.timeMs - right.timeMs);
}

/** True when `index` is precisely the line that should be showing. */
function isIndexActive(
  lines: readonly LrcLine[],
  positionMs: number,
  index: number,
): boolean {
  if (index >= lines.length) {
    return false;
  }

  const first = lines[0];
  if (index === -1) {
    return first !== undefined && positionMs < first.timeMs;
  }

  const current = lines[index];
  if (current === undefined || current.timeMs > positionMs) {
    return false;
  }

  const next = lines[index + 1];
  return next === undefined || next.timeMs > positionMs;
}

function searchActiveLineIndex(lines: readonly LrcLine[], positionMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = lines[mid];
    if (candidate !== undefined && candidate.timeMs <= positionMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

/**
 * Index of the line that should be showing at `positionMs`, or -1 before the
 * first line is due.
 *
 * `hintIndex` is the previously active index. During normal playback the
 * answer is either that index or the one after it, so the hint turns the
 * common case into two comparisons; anything else (a seek) falls back to a
 * binary search. Passing a stale or out-of-range hint is always safe.
 */
export function findActiveLineIndex(
  lines: readonly LrcLine[],
  positionMs: number,
  hintIndex?: number,
): number {
  if (lines.length === 0) {
    return -1;
  }

  if (hintIndex !== undefined && hintIndex >= -1 && hintIndex < lines.length) {
    if (isIndexActive(lines, positionMs, hintIndex)) {
      return hintIndex;
    }
    if (isIndexActive(lines, positionMs, hintIndex + 1)) {
      return hintIndex + 1;
    }
  }

  return searchActiveLineIndex(lines, positionMs);
}
