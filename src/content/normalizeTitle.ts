/**
 * Turns a YouTube video title into an artist and a track name.
 *
 * Regular YouTube gives you `Artist - Song (Official Video) [4K]` rather than
 * clean metadata, so this is unavoidably heuristic. The guiding rule: strip
 * *production* noise, never *content* markers. Removing "(Live)" would let a
 * concert recording match a studio track's timings; leaving it in means the
 * lookup misses, which is the honest answer.
 */

export type TitleConfidence = 'high' | 'low' | 'medium';

export interface ParsedVideoTitle {
  artist: string | null;
  confidence: TitleConfidence;
  title: string;
}

/** Upload-format cruft that says nothing about which recording this is. */
const NOISE_PATTERN =
  /(official|lyrics?|audio|visuali[sz]er|\bhd\b|\bhq\b|\b[48]k\b|remaster|\bmv\b|m\/v|explicit|music\s*video|video\s*oficial|clip\s*officiel|dolby|atmos|colou?r[-\s]?coded|upgrade)/i;

/** Markers that identify a *different recording*, so they must survive. */
const KEEP_PATTERN =
  /(live|acoustic|remix|cover|instrumental|sped[-\s]?up|slowed|reverb|demo|radio\s*edit|extended|version|mix|edit|session)/i;

const BRACKET_GROUP_PATTERN = /[([{][^)\]}]*[)\]}]/g;
const FEATURE_BRACKET_PATTERN = /[([{]\s*(?:feat|ft|featuring|with)\b[^)\]}]*[)\]}]/gi;
const FEATURE_BARE_PATTERN = /\s+(?:feat|ft|featuring)\.?\s+.*$/i;

/** Separators that split artist from title. Spaces required, so "Jay-Z" survives. */
const SEPARATOR_PATTERN = /\s+[-–—]\s+/;

const TOPIC_CHANNEL_PATTERN = /\s+-\s+Topic$/i;
const VEVO_SUFFIX_PATTERN = /VEVO$/;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Drops leading and trailing separator or punctuation debris. */
function trimDebris(value: string): string {
  return collapseWhitespace(value).replace(/^[-–—|:,.\s]+|[-–—|:,.\s]+$/g, '');
}

function getIsNoise(fragment: string): boolean {
  return NOISE_PATTERN.test(fragment) && !KEEP_PATTERN.test(fragment);
}

function removeNoise(rawTitle: string): string {
  let working = rawTitle.replace(FEATURE_BRACKET_PATTERN, ' ');

  working = working.replace(BRACKET_GROUP_PATTERN, (group) =>
    getIsNoise(group) ? ' ' : group,
  );

  // Pipe-delimited tails such as "| Official Video".
  working = working
    .split('|')
    .filter((segment, index) => index === 0 || !getIsNoise(segment))
    .join(' | ');

  return trimDebris(working);
}

function getChannelArtist(channelName: string | null | undefined): {
  artist: string | null;
  isTopicChannel: boolean;
} {
  if (channelName === null || channelName === undefined) {
    return { artist: null, isTopicChannel: false };
  }

  const isTopicChannel = TOPIC_CHANNEL_PATTERN.test(channelName);
  const cleaned = trimDebris(
    channelName.replace(TOPIC_CHANNEL_PATTERN, '').replace(VEVO_SUFFIX_PATTERN, ''),
  );

  return { artist: cleaned === '' ? null : cleaned, isTopicChannel };
}

/**
 * `channelName` is used as the artist only when the title has no separator.
 * An auto-generated "Artist - Topic" channel is treated as high confidence,
 * because YouTube only creates those for licensed music.
 */
export function parseVideoTitle(
  videoTitle: string,
  channelName?: string | null,
): ParsedVideoTitle {
  const cleaned = removeNoise(videoTitle);
  const channel = getChannelArtist(channelName);

  if (cleaned === '') {
    return { artist: channel.artist, confidence: 'low', title: '' };
  }

  const separatorMatch = SEPARATOR_PATTERN.exec(cleaned);
  if (separatorMatch !== null && separatorMatch.index > 0) {
    const artist = trimDebris(cleaned.slice(0, separatorMatch.index));
    const remainder = cleaned.slice(separatorMatch.index + separatorMatch[0].length);
    const title = trimDebris(remainder.replace(FEATURE_BARE_PATTERN, ''));

    if (artist !== '' && title !== '') {
      return { artist, confidence: 'high', title };
    }
  }

  const title = trimDebris(cleaned.replace(FEATURE_BARE_PATTERN, ''));
  if (title === '') {
    return { artist: channel.artist, confidence: 'low', title: '' };
  }

  if (channel.artist === null) {
    // No separator and no channel: nothing identifies the artist, so do not
    // spend an API call guessing.
    return { artist: null, confidence: 'low', title };
  }

  return {
    artist: channel.artist,
    confidence: channel.isTopicChannel ? 'high' : 'medium',
    title,
  };
}
