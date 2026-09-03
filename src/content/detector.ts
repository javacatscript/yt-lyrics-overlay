import type { TrackInfo } from '../lib/types';

/**
 * Per-site strategy for working out what is playing. Everything else — the
 * render loop, the overlay, lyrics lookup, the offset control — is shared.
 */
export interface TrackDetector {
  /** Identifies the site in log output. */
  readonly name: string;
  getCurrentTrack(): TrackInfo | null;
  getIsAdPlaying(): boolean;
  /** Calls back when the page suggests the track changed. Returns a teardown. */
  watchTrackChanges(onChange: () => void): () => void;
}

const DEFAULT_DEBOUNCE_MS = 300;

export function normaliseText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

/** First non-empty text content among the given selectors. */
export function getFirstText(selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const text = normaliseText(document.querySelector(selector)?.textContent);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

/**
 * Observes the given containers for changes, debounced.
 *
 * Both sites are single-page apps, so a track change is a DOM mutation rather
 * than a navigation. When none of the containers exist yet — normal on a cold
 * load — this falls back to watching the body until they mount.
 */
export function watchDomForChanges(
  containerSelectors: readonly string[],
  onChange: () => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(onChange, debounceMs);
  };

  const observer = new MutationObserver(schedule);
  const targets = containerSelectors
    .map((selector) => document.querySelector(selector))
    .filter((node): node is Element => node !== null);

  if (targets.length === 0) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    for (const target of targets) {
      observer.observe(target, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
  }

  return (): void => {
    observer.disconnect();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}
