import { getFirstText, normaliseText, watchDomForChanges } from './detector';
import type { TrackDetector } from './detector';
import { getVideoElement } from './media';
import { parseVideoTitle } from './normalizeTitle';
import type { TrackInfo } from '../lib/types';

const TITLE_SELECTORS = [
  'ytd-watch-metadata h1 yt-formatted-string',
  'ytd-watch-metadata h1',
  '#title h1 yt-formatted-string',
  'h1.ytd-watch-metadata',
] as const;

const CHANNEL_SELECTORS = [
  'ytd-video-owner-renderer #channel-name a',
  '#owner #channel-name a',
  'ytd-channel-name#channel-name a',
  '#upload-info #channel-name a',
] as const;

const WATCH_CONTAINER_SELECTORS = ['ytd-watch-metadata', '#title', '#above-the-fold'] as const;

/** `(3) Artist - Song - YouTube` → `Artist - Song` */
function getTitleFromDocument(): string | null {
  return normaliseText(
    document.title.replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube$/, ''),
  );
}

/**
 * On a watch page `mediaSession.metadata.title` is usually the raw video
 * title and `artist` the channel, so both still go through the normaliser
 * rather than being trusted as clean metadata.
 */
function getRawFields(): { channel: string | null; rawTitle: string | null } {
  const metadata = navigator.mediaSession?.metadata;

  return {
    channel:
      normaliseText(metadata?.artist) ?? getFirstText(CHANNEL_SELECTORS),
    rawTitle:
      normaliseText(metadata?.title) ?? getFirstText(TITLE_SELECTORS) ?? getTitleFromDocument(),
  };
}

/**
 * `#movie_player` carries `ad-showing` / `ad-interrupting` while an ad plays.
 * Unlike the YouTube Music equivalent this selector is well established.
 */
function getIsAdPlaying(): boolean {
  const player = document.querySelector('#movie_player');
  if (player === null) {
    return false;
  }
  return (
    player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')
  );
}

export const ytDetector: TrackDetector = {
  name: 'youtube',

  /**
   * Returns null on low confidence rather than guessing. Most YouTube videos
   * are not songs, and a confident-looking overlay of wrong lyrics over a
   * podcast is worse than no overlay at all.
   */
  getCurrentTrack(): TrackInfo | null {
    const video = getVideoElement();
    if (video === null || !Number.isFinite(video.duration) || video.duration <= 0) {
      return null;
    }

    const { channel, rawTitle } = getRawFields();
    if (rawTitle === null) {
      return null;
    }

    const parsed = parseVideoTitle(rawTitle, channel);
    if (parsed.confidence === 'low' || parsed.artist === null || parsed.title === '') {
      return null;
    }

    return {
      // YouTube exposes no reliable album, so LRCLIB's exact-match endpoint
      // will usually miss and the duration-filtered search carries the lookup.
      album: null,
      artist: parsed.artist,
      durationSec: video.duration,
      title: parsed.title,
    };
  },

  getIsAdPlaying,

  watchTrackChanges(onChange: () => void): () => void {
    return watchDomForChanges(WATCH_CONTAINER_SELECTORS, onChange);
  },
};
