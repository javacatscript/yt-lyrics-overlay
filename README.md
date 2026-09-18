# Lyrics Overlay

Real-time synced lyrics for YouTube Music, in a window that floats above every
browser tab **and** above other applications.

Built on [Document Picture-in-Picture][pip] — the only browser API that gives
you an always-on-top window containing arbitrary DOM. Lyrics come from
[LRCLIB][lrclib], which is free, needs no API key, and returns timestamped LRC.

[pip]: https://developer.chrome.com/docs/web-platform/document-picture-in-picture
[lrclib]: https://lrclib.net

## Requirements

- A Chromium browser at 116+ with Document Picture-in-Picture — Chrome, Edge,
  **Brave**, Vivaldi, Opera
- Node 22+

### Brave and other Chromium builds

Loads and runs the same way as in Chrome, but two APIs are optional across
Chromium builds and the extension feature-detects both rather than assuming:

| API | If missing |
| --- | --- |
| `chrome.sidePanel` | The toolbar icon opens the same controls page in a normal tab. Brave ships its own sidebar and can withhold the extension API. |
| `documentPictureInPicture` | The launcher button says so plainly instead of clicking into nothing. There is no floating window without it. |

`chrome.sidePanel` needed real care: calling a method on an absent namespace
throws a **synchronous** `TypeError`, which no `.catch()` on the returned
promise can rescue. It is checked with `typeof chrome.sidePanel?.open ===
'function'` before use.

**If lyrics never load in Brave**, check Shields on the site — extension
background requests are not normally filtered, but if `lrclib.net` is blocked
the panel will show "lyrics unavailable". Brave's built-in ad blocking also
makes the ad-detection path largely moot, which is no loss.

## Build and load

```bash
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `dist/` folder in this repo
4. Open <https://music.youtube.com> and play something
5. Click the extension icon to open the side panel, then
   **Open floating overlay**

`npm run dev` rebuilds on save. Chrome needs a manual reload of the extension
after each rebuild (the ↻ button on its card in `chrome://extensions`).

## Verification gate — please check these first

Two assumptions underpin the whole architecture. Both have graceful fallbacks
already implemented, but which path actually fires tells us whether the design
holds:

**1. Does user activation reach the content script?**

Click **Open floating overlay** in the side panel.

- *Overlay appears immediately* → activation propagates. Ideal.
- *A "♪ Show lyrics overlay" button appears on the YouTube Music page instead*
  → Chrome refused for want of a gesture, and the fallback kicked in. Clicking
  that button works. Costs one extra click; nothing else changes.

**2. Can an isolated-world content script write to the PiP document?**

If the floating window opens and shows styled lyrics, this holds. If it opens
**blank or unstyled**, it does not — and that is the one finding that would
force an architecture change (to an extension-origin PiP page fed by a message
relay). Report it if you see it.

Also worth noting which metadata source wins: `navigator.mediaSession.metadata`
is preferred, with the player-bar DOM as a guaranteed fallback. Both are wired,
so detection works either way.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Production build into `dist/` |
| `npm run dev` | Rebuild on save |
| `npm test` | Vitest — 88 tests over the parser, title normaliser and LRCLIB client |
| `npm run typecheck` | `tsc --noEmit` |

## How it works

```
music.youtube.com / www.youtube.com tab
├─ content/ytm.ts ─────── entry: starts the controller with the Music detector
├─ content/yt.ts ──────── entry: starts the controller with the YouTube detector
├─ content/controller.ts  owns the PiP window and the rAF loop that paints
│                         the karaoke lines (shared by both sites)
├─ content/*Detector.ts   per-site strategy: what is playing, and is it an ad
├─ pip/overlay.ts ─────── builds the UI in a shadow root in the PiP document
└─ background/sw.ts ───── fetches + caches LRCLIB (a content-script fetch
                          would be blocked by YouTube's CSP)
```

Only the detector differs between the two sites. The render loop, overlay,
lyrics lookup, cache and offset handling are shared.

The render loop reads `video.currentTime` in the same JS context and on the
same frame it paints, so there is no cross-context clock, no interpolation and
no drift. This is why the content script — not the side panel — opens the PiP
window.

### Testing boundaries

`lib/lrc.ts`, `lib/lrclib.ts`, `pip/viewModel.ts` and
`content/normalizeTitle.ts` are pure and fully unit tested. The YouTube Music DOM scraping and the PiP plumbing are **verified
manually**, on purpose: mocking YTM's DOM would only test the mock, and that
DOM is the thing most likely to break.

### Known unverified bit

Ad detection in `content/detectTrack.ts` uses best-guess selectors — YouTube
Music's ad markup could not be reproduced during development, and Premium
accounts never show one. If ads slip through, the symptom is lyrics drifting
during the ad, not a crash. Adjust `getIsAdPlaying()`.

## Sync offset

If lyrics run behind the audio, press `+0.5s`; if ahead, `−0.5s`. Positive
advances the lyrics. Offsets are saved **per track**, since a given upload with
an intro is out by the same amount every play. The side panel also has a global
default for the rare case where everything is off.

## Supported sites

| Site | Detection | Reliability |
| --- | --- | --- |
| `music.youtube.com` | Player bar gives clean artist / title / album | High — album + duration pin the exact record |
| `www.youtube.com` | Video title parsed heuristically | Lower — no album, so duration alone disambiguates |

### How regular YouTube detection works

YouTube gives you `Artist - Song (Official Video) [4K]`, not metadata, so
`content/normalizeTitle.ts` parses it:

- **Production noise is stripped** — `(Official Video)`, `[4K]`, `(Remastered
  2011)`, `| Official Video`, feature credits.
- **Content markers are kept** — `(Live)`, `(Acoustic)`, `(Remix)`,
  `(Single Album Version)`. Stripping these would let a concert recording match
  a studio track's timings; keeping them means the lookup misses, which is the
  honest outcome.
- **Artist comes from the dash split**, falling back to the channel name. An
  auto-generated `Artist - Topic` channel counts as high confidence, since
  YouTube only creates those for licensed music.
- **Low confidence means no lookup at all.** Most YouTube videos aren't songs,
  and no overlay beats a confident overlay of wrong lyrics over a podcast.

Expect worse match rates here than on Music: a live take, a sped-up edit or a
lyric-video re-upload all have durations that won't match the album cut, and
duration is what disambiguates LRCLIB. The per-track offset control fixes a
constant lag; it cannot fix a genuinely different recording.

Design doc: [`docs/superpowers/specs/2026-09-03-lyrics-overlay-design.md`](docs/superpowers/specs/2026-09-03-lyrics-overlay-design.md)

## Licensing

Lyrics are copyrighted, and LRCLIB's corpus is community-contributed rather
than licensed. Fine for a personal build loaded unpacked on one machine; it
would need resolving before any public distribution. That is why this is scoped
to personal use.
