/**
 * Fallback lyrics source used only once LRCLIB has come up empty. No API key,
 * no duration disambiguation — a plain artist/title lookup that returns
 * untimed text or nothing.
 */
const API_BASE = 'https://api.lyrics.ovh';

interface Track {
  artist: string;
  title: string;
}

export async function requestLyricsOvh(
  track: Track,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const artist = encodeURIComponent(track.artist);
  const title = encodeURIComponent(track.title);
  const url = `${API_BASE}/v1/${artist}/${title}`;

  const response = await fetchFn(url);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`lyrics.ovh failed with ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const lyrics = (payload as Record<string, unknown>).lyrics;
  if (typeof lyrics !== 'string') {
    return null;
  }

  const trimmed = lyrics.trim();
  return trimmed === '' ? null : trimmed;
}
