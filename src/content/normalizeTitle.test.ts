import { describe, expect, test } from 'vitest';

import { parseVideoTitle } from './normalizeTitle';

describe('parseVideoTitle — production noise', () => {
  test('splits artist and title on a plain dash and drops "(Official Video)"', () => {
    expect(parseVideoTitle('Linkin Park - In The End (Official Video)')).toMatchObject({
      artist: 'Linkin Park',
      title: 'In The End',
    });
  });

  test('drops "(Official Music Video)"', () => {
    expect(
      parseVideoTitle('Evanescence - Bring Me To Life (Official Music Video)'),
    ).toMatchObject({ artist: 'Evanescence', title: 'Bring Me To Life' });
  });

  test('drops square-bracketed noise', () => {
    expect(
      parseVideoTitle('Green Day - Boulevard Of Broken Dreams [Official Music Video]'),
    ).toMatchObject({ artist: 'Green Day', title: 'Boulevard Of Broken Dreams' });
  });

  test('drops several noise groups at once', () => {
    expect(
      parseVideoTitle('Linkin Park - Numb (Official Video) [4K UPGRADE]'),
    ).toMatchObject({ artist: 'Linkin Park', title: 'Numb' });
  });

  test('drops a trailing pipe-delimited noise segment', () => {
    expect(parseVideoTitle('Ed Sheeran - Shape of You | Official Video')).toMatchObject({
      artist: 'Ed Sheeran',
      title: 'Shape of You',
    });
  });

  test('drops a remaster marker', () => {
    expect(parseVideoTitle('Queen - Bohemian Rhapsody (Remastered 2011)')).toMatchObject({
      artist: 'Queen',
      title: 'Bohemian Rhapsody',
    });
  });

  test('drops a bracketed feature credit', () => {
    expect(
      parseVideoTitle('Daft Punk - Get Lucky (feat. Pharrell Williams) [Official Video]'),
    ).toMatchObject({ artist: 'Daft Punk', title: 'Get Lucky' });
  });

  test('drops a bare trailing feature credit', () => {
    expect(parseVideoTitle('Calvin Harris - Summer feat. Example')).toMatchObject({
      artist: 'Calvin Harris',
      title: 'Summer',
    });
  });
});

describe('parseVideoTitle — separators', () => {
  test('accepts an en dash', () => {
    expect(parseVideoTitle('Adele – Hello')).toMatchObject({
      artist: 'Adele',
      title: 'Hello',
    });
  });

  test('accepts an em dash', () => {
    expect(parseVideoTitle('Adele — Hello')).toMatchObject({
      artist: 'Adele',
      title: 'Hello',
    });
  });

  test('splits on the first separator only, leaving the rest in the title', () => {
    expect(parseVideoTitle('Nirvana - All Apologies - Unplugged')).toMatchObject({
      artist: 'Nirvana',
      title: 'All Apologies - Unplugged',
    });
  });

  test('ignores a hyphen that is not a separator', () => {
    expect(parseVideoTitle('Jay-Z - Empire State of Mind')).toMatchObject({
      artist: 'Jay-Z',
      title: 'Empire State of Mind',
    });
  });
});

describe('parseVideoTitle — content markers are preserved', () => {
  // Stripping these would risk matching a studio recording's timings against a
  // different performance. The duration filter then rejects it, which is the
  // honest outcome.
  test('keeps a live marker', () => {
    expect(parseVideoTitle('Nirvana - Something In The Way (Live)').title).toBe(
      'Something In The Way (Live)',
    );
  });

  test('keeps an acoustic marker', () => {
    expect(parseVideoTitle('Oasis - Wonderwall (Acoustic)').title).toBe(
      'Wonderwall (Acoustic)',
    );
  });

  test('keeps a remix marker', () => {
    expect(parseVideoTitle('Avicii - Levels (Skrillex Remix)').title).toBe(
      'Levels (Skrillex Remix)',
    );
  });

  test('keeps a version marker', () => {
    expect(
      parseVideoTitle('Green Day - Boulevard of Broken Dreams (Single Album Version)')
        .title,
    ).toBe('Boulevard of Broken Dreams (Single Album Version)');
  });
});

describe('parseVideoTitle — channel fallback', () => {
  test('uses the channel as artist when there is no separator', () => {
    expect(parseVideoTitle('Bohemian Rhapsody', 'Queen Official')).toMatchObject({
      artist: 'Queen Official',
      confidence: 'medium',
      title: 'Bohemian Rhapsody',
    });
  });

  test('treats an auto-generated "- Topic" channel as high confidence', () => {
    expect(parseVideoTitle('In the End', 'Linkin Park - Topic')).toMatchObject({
      artist: 'Linkin Park',
      confidence: 'high',
      title: 'In the End',
    });
  });

  test('prefers a dash split over the channel name', () => {
    expect(
      parseVideoTitle('Linkin Park - In The End', 'Some Uploader Channel'),
    ).toMatchObject({ artist: 'Linkin Park', confidence: 'high' });
  });

  test('reports low confidence with no separator and no channel', () => {
    expect(parseVideoTitle('My holiday vlog 2024')).toMatchObject({
      artist: null,
      confidence: 'low',
    });
  });

  test('strips a "VEVO" suffix from a channel name used as artist', () => {
    expect(parseVideoTitle('Hello', 'AdeleVEVO').artist).toBe('Adele');
  });
});

describe('parseVideoTitle — degenerate input', () => {
  test('returns low confidence for an empty title', () => {
    expect(parseVideoTitle('')).toMatchObject({ artist: null, confidence: 'low' });
  });

  test('returns low confidence when noise removal empties the title', () => {
    expect(parseVideoTitle('(Official Video)')).toMatchObject({ confidence: 'low' });
  });

  test('collapses repeated whitespace', () => {
    expect(parseVideoTitle('Linkin   Park  -   In  The   End')).toMatchObject({
      artist: 'Linkin Park',
      title: 'In The End',
    });
  });

  test('trims stray punctuation left behind by noise removal', () => {
    expect(parseVideoTitle('Linkin Park - In The End -').title).toBe('In The End');
  });
});
