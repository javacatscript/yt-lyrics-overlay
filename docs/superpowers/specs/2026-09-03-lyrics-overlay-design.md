# Lyrics Overlay — Design

**Date:** 2026-09-03
**Status:** Approved for planning
**Scope:** v1 — YouTube Music, plus regular YouTube (added post-v1);
personal use, loaded unpacked

## Purpose

A Chrome extension that shows real-time synchronised lyrics for whatever is
playing on YouTube Music, in a window that floats above every browser tab and
every other application.

The overlay must not live inside the YouTube Music tab. Switching tabs, or
switching to another application entirely, must not hide it.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Overlay surface | Document Picture-in-Picture, launched from a side panel | The only browser API that yields an always-on-top window containing arbitrary DOM |
| Detection scope | `music.youtube.com` only | Clean artist/title/album metadata; no title-parsing guesswork |
| Lyrics source | LRCLIB (`lrclib.net`) | Free, no API key, returns synchronised LRC with per-line timestamps |
| Layout | Karaoke focus — current line large, neighbours dimmed | Readable at a glance in a small window; makes drift visible so the offset control is usable |
| Tooling | TypeScript + Vite | Types earn their keep on the parser and playback state |
| Distribution | Unpacked, personal | No store assets, no privacy policy, licensing stays academic |

### Architecture: content-script-owned PiP

`documentPictureInPicture.requestWindow()` returns a `Window` whose document is
same-origin with the opener. When the content script on `music.youtube.com` is
the opener, that content script can build the overlay UI directly in the PiP
document with ordinary DOM calls, and drive it from a `requestAnimationFrame`
loop that reads `video.currentTime` in the same JS context on the same frame it
paints.

This eliminates the hardest part of the problem. There is no cross-context
clock to reconcile, no position messages, no interpolation, and no accumulated
drift. Three further consequences follow:

- **Playback rate needs no handling.** Reading `currentTime` directly is
  already rate-correct.
- **The service worker may sleep freely.** MV3 evicts an idle worker after ~30s,
  but the hot path never touches it, so no keep-alive is required.
- **Overlay lifetime is coupled to the music tab.** This is the correct
  coupling: no music tab means no music.

The rejected alternative was an extension-origin PiP page fed by a message
relay. It buys extension privileges inside the overlay at the cost of
once-a-second position messages plus local interpolation, a class of drift bug
that this design cannot have, and an opener that must be kept alive.

## Verification gate

Two assumptions are load-bearing and cheap to disprove. They are verified in
the first commit, before any UI is built.

1. **User activation reaches the content script.** `requestWindow()` requires
   transient user activation. It is unclear whether clicking the toolbar action
   or a side-panel button propagates activation into the content script that
   must make the call.
   *Fallback:* a small button injected into the YTM page as the trigger.
2. **An isolated-world content script can write to the PiP document.** Isolated
   worlds have full DOM access, so this is expected to hold.
   *Fallback:* if it fails, the whole approach fails — revert to the
   extension-origin PiP page with a message relay.

Neither fallback is speculative work. If (1) fails the cost is one button; if
(2) fails the architecture changes, which is exactly why it is tested first.

## Components

```
lyrics-overlay/
├─ src/
│  ├─ content/ytm.ts        detect track, own the PiP window, drive the render loop
│  ├─ background/sw.ts      LRCLIB fetch, cache, in-flight dedupe
│  ├─ pip/
│  │  ├─ overlay.ts         karaoke DOM construction + repaint
│  │  └─ overlay.css        imported as a string, not linked
│  ├─ sidepanel/
│  │  ├─ panel.html
│  │  └─ panel.ts           launcher, status, settings, plain-lyrics fallback
│  └─ lib/
│     ├─ lrclib.ts          API client, candidate selection, cache keys
│     ├─ lrc.ts             LRC parse + active-line lookup
│     └─ types.ts           shared message and record types
├─ manifest.config.ts
├─ vite.config.ts
└─ package.json
```

Each unit has one job. `lib/lrc.ts` and `lib/lrclib.ts` are pure and hold every
piece of logic worth unit testing. `content/ytm.ts` is the only file that
touches YouTube's DOM. `pip/overlay.ts` receives parsed lines and an index and
knows nothing about YouTube or LRCLIB.

## Manifest and permissions

```json
{
  "manifest_version": 3,
  "name": "Lyrics Overlay",
  "version": "0.1.0",
  "permissions": ["storage", "sidePanel"],
  "host_permissions": ["https://lrclib.net/*"],
  "background": { "service_worker": "background/sw.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://music.youtube.com/*"],
      "js": ["content/ytm.js"],
      "run_at": "document_idle"
    }
  ],
  "side_panel": { "default_path": "sidepanel/panel.html" },
  "action": { "default_title": "Lyrics Overlay" }
}
```

`storage` caches lyrics and settings; `sidePanel` provides the panel;
`host_permissions` lets the service worker reach LRCLIB. Deliberately absent:

- **`tabs`** — not needed. The content script announces itself, so there is no
  need to enumerate tabs or read their URLs.
- **`scripting`** — the static `content_scripts` declaration suffices.
- **`web_accessible_resources`** — see styling below.

### Styling without a CSP fight

The PiP document is same-origin with `music.youtube.com` and inherits its
Content Security Policy, so an inline `<style>` element or a `<link>` to a
`chrome-extension://` URL may be blocked.

The overlay is therefore built inside a **shadow root** attached to a container
in the PiP document, with CSS imported as a string (`import css from
'./overlay.css?inline'`) and applied via `adoptedStyleSheets`. The shadow root
also isolates the overlay from YouTube Music's own styles.

One detail: a `CSSStyleSheet` constructed in one document cannot be adopted by
another. The sheet must be built with the PiP window's own constructor —
`new pipWindow.CSSStyleSheet()` — not the content script's.

*Fallback:* a `<style>` element inside the shadow root. Shadow DOM may exempt
it from the host page's `style-src`; if not, the only remaining route is a
web-accessible stylesheet, which would reintroduce the permission.

## Track detection

The content script resolves the current track from two sources, in order:

1. `navigator.mediaSession.metadata` → `title`, `artist`, `album`.
2. The player bar DOM — `ytmusic-player-bar`, reading `.title` and `.byline`.
   The byline is `Artist • Album • Year`; split on `•` and take the first two
   fields.

Source 2 is a guaranteed fallback because isolated-world content scripts have
full DOM access, whereas `mediaSession.metadata` may read `null` from an
isolated world. Duration always comes from `video.duration`, which is
authoritative and avoids parsing formatted time strings.

YouTube Music is a single-page app, so track changes are detected by a
`MutationObserver` on the player bar title and byline, plus the `<video>`
element's `loadedmetadata`, `durationchange` and `emptied` events, debounced
300ms.

A track is identified by

```
trackKey = `${artist}|${title}|${album}|${Math.round(duration)}`
```

which is also the cache key. A change in `trackKey` triggers a lyrics request.

## LRCLIB client

Requests are made from the service worker, never the content script — a
content-script `fetch()` is subject to YouTube's page CSP and would likely be
blocked.

```
GET https://lrclib.net/api/get
    ?artist_name=…&track_name=…&album_name=…&duration=…
```

**Correction, found during implementation:** LRCLIB asks callers for a
descriptive `User-Agent`, but `User-Agent` is a *forbidden header name* for
`fetch`, so a browser extension cannot set it — the attempt is silently
dropped rather than erroring. Identifying the client would require
`declarativeNetRequest` and its permission, which is not worth it for a
personal build, so no custom header is sent.

The endpoint tolerates small duration deltas — a request for 354s matched a 355s record during
feasibility testing — and correctly rejects a badly wrong duration, which makes
duration a real disambiguator between the album cut, a remaster and a live
version.

Resolution order:

1. `/api/get` with all four fields. On a hit, done.
2. On 404, `/api/search?track_name=…&artist_name=…`. Filter to
   `|candidate.duration - duration| <= 3`, prefer entries with non-empty
   `syncedLyrics`, take the first. Search returns up to 20 rows for almost any
   query, so it must never be used without duration filtering.
3. Otherwise `{ status: 'not_found' }`.

### Caching

`chrome.storage.local`, keys namespaced `lrc:v1:<trackKey>`:

- **Hits are cached indefinitely.** Lyrics do not change.
- **Misses are negative-cached for 24h**, so a track played on repeat does not
  hammer a free community service.
- **In-flight requests are deduplicated** by `trackKey` in a service-worker
  `Map`.
- **LRU eviction at 500 entries**, or on a quota error. ~500 LRC records is
  on the order of 1MB, comfortably inside the default ~10MB quota, so
  `unlimitedStorage` is not requested.

## LRC parsing and lookup

`lib/lrc.ts` parses to `Array<{ timeMs: number; text: string }>`, sorted
ascending, and must handle:

- `[mm:ss.xx]` and `[mm:ss.xxx]` precision.
- Multiple timestamps on one line — `[00:12.00][01:30.00] chorus line` expands
  to two entries.
- Metadata tags `[ar:]`, `[ti:]`, `[al:]`, `[offset:]`. An `[offset:]` value is
  in milliseconds and shifts display time by `timestamp - offset`.
- Interlude markers. Feasibility testing returned real lines such as
  `[00:16.56] ♪`; these are preserved and rendered as a subtle marker rather
  than as an empty line.
- Malformed input — unparseable lines are skipped, not fatal.

Active-line lookup returns the last index with `timeMs <= positionMs`. It first
checks whether the cached index is still valid (the common case, costing two
comparisons) and falls back to binary search after a seek.

## Render loop

```
while pipWindow is open and video is playing:
  onAnimationFrame:
    positionMs = video.currentTime * 1000 + effectiveOffsetMs
    idx = activeLineIndex(lines, positionMs)
    if idx !== lastIdx:
      repaint(prev, current, next)
      lastIdx = idx
```

Repainting happens only when the index changes, not every frame. The loop stops
on `pause` and runs once more on `seeked` and `play`. The overlay closes and
the loop tears down on `pagehide` and on PiP window close.

## Offset control

The mockup's footer carries `−0.5s` / `+0.5s` buttons. Offsets persist per
track, because a track whose upload has an intro is habitually out of sync by
the same amount:

```
effectiveOffsetMs = trackOffset[trackKey] ?? globalOffset ?? 0
positionMs        = video.currentTime * 1000 + effectiveOffsetMs
```

**Sign convention, stated once so the UI cannot drift from it:** a *positive*
offset advances the lyrics, i.e. lines appear **earlier** relative to the
audio. So if the lyrics are lagging behind what you hear, press `+`. This is
independent of, and applied after, any `[offset:]` tag baked into the LRC file
itself.

Stored under `offset:<trackKey>`. The global default is a side-panel setting.

## Side panel

- Now-playing readout and lyrics status: `synced`, `plain only`, `not found`,
  `instrumental`.
- **Open floating overlay** button — the launcher, and the candidate
  user-activation source pending the verification gate.
- Settings: global offset, font size, theme.
- When only unsynchronised text exists, the panel renders it inline. There is
  no value in floating a static block of text.

## Error handling

| Case | Behaviour |
| --- | --- |
| Nothing playing / no `<video>` | Overlay shows "nothing playing" |
| `instrumental: true` | "♪ instrumental" |
| Synced missing, plain present | Notice plus a pointer to the side panel. Never fake sync by interpolating plain text |
| LRCLIB 404 | "no lyrics found", negative-cached 24h |
| Network failure | One retry with backoff, then a "lyrics unavailable" state with a retry button |
| Duration mismatch > 3s vs the matched record | "sync may be off" hint beside the offset controls |
| Document PiP unsupported | Side panel remains fully functional; overlay button disabled with an explanatory tooltip |
| A PiP window already exists | The browser permits only one. Focus and reuse the existing window rather than failing |
| An advertisement is playing | Suspend highlighting and show "advertisement" — ad playback moves `currentTime` against a different media source |

## Testing

**Unit tested with Vitest** — the pure logic, which is where the bugs are:

- `lib/lrc.ts` — multi-timestamp lines, `[offset:]` handling, malformed input,
  interlude markers, and boundary behaviour when the position lands exactly on
  a timestamp.
- `lib/lrclib.ts` — candidate selection from search results, duration
  filtering, cache-key derivation, negative-cache TTL expiry. `fetch` is
  stubbed.

**Verified manually against live YouTube Music** — the content script's DOM
scraping and the PiP plumbing. Mocking YouTube Music's DOM would only test the
mock, and the DOM is the thing most likely to break. A `debug` flag logs
detected metadata to make this quick.

## Milestones

0. **Verification gate** — prove user activation and isolated-world writes to
   the PiP document. Blocks everything below.
1. Skeleton — manifest, Vite build, side panel displaying the detected track.
2. `lib/lrc.ts` with tests.
3. `lib/lrclib.ts`, service-worker fetch, cache, with tests.
4. PiP overlay — karaoke rendering and the render loop.
5. Offset control, persistence, error states.
6. Polish — theme, font size, instrumental and interlude markers.

## Out of scope for v1

- ~~`youtube.com/watch` support.~~ **Added after v1** — the user's actual
  listening turned out to be on regular YouTube, not Music. Implemented as a
  second content script (`content/yt.ts`) plus a tested title normaliser
  (`content/normalizeTitle.ts`), with the render loop and lookup extracted into
  a shared `content/controller.ts`. Detection returns null on low confidence
  rather than guessing, since most YouTube videos are not songs.
- Word-level enhanced LRC karaoke.
- Translation and romanisation.
- Contributing lyrics back to LRCLIB.
- Non-YouTube sources.
- Chrome Web Store packaging.

## Licensing note

Lyrics are copyrighted, and LRCLIB's corpus is community-contributed rather
than licensed. That is unremarkable for a personal build loaded unpacked on one
machine. It would need resolving before any public distribution — which is the
actual reason v1 is scoped to personal use, and why no store packaging appears
above.
