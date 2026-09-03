import { getFirstText, normaliseText, watchDomForChanges } from './detector';
import type { TrackDetector } from './detector';
import { getVideoElement } from './media';
import type { TrackInfo } from '../lib/types';

const PLAYER_BAR_SELECTOR = 'ytmusic-player-bar';
const BYLINE_SEPARATOR = '•';

interface TrackFields {
  album: string | null;
  artist: string | null;
  title: string | null;
}

const EMPTY_FIELDS: TrackFields = { album: null, artist: null, title: null };

/**
 * Preferred source. May yield nothing: `mediaSession.metadata` is set by page
 * script, and an isolated-world content script cannot always read it. The DOM
 * fallback below covers that case.
 */
function getMediaSessionFields(): TrackFields {
  const metadata = navigator.mediaSession?.metadata;
  if (metadata === null || metadata === undefined) {
    return EMPTY_FIELDS;
  }
  return {
    album: normaliseText(metadata.album),
    artist: normaliseText(metadata.artist),
    title: normaliseText(metadata.title),
  };
}

/** The byline reads `Artist • Album • Year`; a single or radio has fewer parts. */
function getPlayerBarFields(): TrackFields {
  const bar = document.querySelector(PLAYER_BAR_SELECTOR);
  if (bar === null) {
    return EMPTY_FIELDS;
  }

  const byline = normaliseText(bar.querySelector('.byline')?.textContent);
  const parts =
    byline
      ?.split(BYLINE_SEPARATOR)
      .map((part) => part.trim())
      .filter((part) => part !== '') ?? [];

  return {
    album: parts[1] ?? null,
    artist: parts[0] ?? null,
    title: normaliseText(bar.querySelector('.title')?.textContent),
  };
}

/**
 * Best guess at ad playback. Unverified: YouTube Music's ad markup could not
 * be reproduced during development, and Premium accounts never show one. The
 * failure mode is drift during an ad, not a crash.
 */
function getIsAdPlaying(): boolean {
  if (document.querySelector('ytmusic-ad-slot-renderer') !== null) {
    return true;
  }
  return document.querySelector('ytmusic-player')?.classList.contains('ad-showing') === true;
}

export const ytmDetector: TrackDetector = {
  name: 'youtube-music',

  getCurrentTrack(): TrackInfo | null {
    const video = getVideoElement();
    if (video === null || !Number.isFinite(video.duration) || video.duration <= 0) {
      return null;
    }

    const session = getMediaSessionFields();
    const dom = getPlayerBarFields();

    const title = session.title ?? dom.title ?? getFirstText([`${PLAYER_BAR_SELECTOR} .title`]);
    const artist = session.artist ?? dom.artist;
    if (title === null || artist === null) {
      return null;
    }

    return {
      album: session.album ?? dom.album,
      artist,
      durationSec: video.duration,
      title,
    };
  },

  getIsAdPlaying,

  watchTrackChanges(onChange: () => void): () => void {
    return watchDomForChanges([PLAYER_BAR_SELECTOR], onChange);
  },
};
