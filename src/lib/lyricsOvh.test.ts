import { describe, expect, test, vi } from 'vitest';

import { requestLyricsOvh } from './lyricsOvh';

const TRACK = { artist: 'The Weeknd', title: 'Blinding Lights' };

function buildFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe('requestLyricsOvh', () => {
  test('requests the artist/title endpoint with URL-encoded segments', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ lyrics: 'la la' }), { status: 200 }),
    ) as unknown as typeof fetch;

    await requestLyricsOvh({ artist: 'Jay-Z & Friends', title: 'Song/Title' }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.lyrics.ovh/v1/Jay-Z%20%26%20Friends/Song%2FTitle',
    );
  });

  test('returns trimmed lyrics text on a hit', async () => {
    const fetchFn = buildFetch(
      new Response(JSON.stringify({ lyrics: '\n  Yeah\nI have been tryna call  \n' }), {
        status: 200,
      }),
    );

    await expect(requestLyricsOvh(TRACK, fetchFn)).resolves.toBe(
      'Yeah\nI have been tryna call',
    );
  });

  test('returns null on a 404', async () => {
    const fetchFn = buildFetch(new Response(null, { status: 404 }));

    await expect(requestLyricsOvh(TRACK, fetchFn)).resolves.toBeNull();
  });

  test('returns null when the lyrics field is empty or whitespace-only', async () => {
    const fetchFn = buildFetch(
      new Response(JSON.stringify({ lyrics: '   \n  ' }), { status: 200 }),
    );

    await expect(requestLyricsOvh(TRACK, fetchFn)).resolves.toBeNull();
  });

  test('returns null when the payload has no lyrics field', async () => {
    const fetchFn = buildFetch(new Response(JSON.stringify({}), { status: 200 }));

    await expect(requestLyricsOvh(TRACK, fetchFn)).resolves.toBeNull();
  });

  test('throws on a non-404 error status', async () => {
    const fetchFn = buildFetch(new Response(null, { status: 500 }));

    await expect(requestLyricsOvh(TRACK, fetchFn)).rejects.toThrow('lyrics.ovh');
  });
});
