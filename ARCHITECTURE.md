# ARCHITECTURE.md — Flyrics Technical Deep Dive

Companion to `ANCHORED.md` (read that first). This document explains exactly how data flows
through the extension and why each piece exists.

## 1. Component diagram

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser tab: youtube.com / open.spotify.com                        │
│                                                                    │
│  ┌──────────────────────────┐      window.postMessage              │
│  │ main-world.js (MAIN)     │ ───────────────────────────┐         │
│  │ • navigator.mediaSession │   { source:'flyrics-main',│         │
│  │   .metadata (title/artist│     type:'MEDIA_STATE',    │         │
│  │   /album/artwork)        │     payload }  every 100ms │         │
│  │ • <video>/<audio>:       │                            ▼         │
│  │   currentTime, duration, │   ┌─────────────────────────────┐    │
│  │   paused, playbackRate   │   │ content.js (ISOLATED)       │    │
│  └──────────────────────────┘   │ • track-change detection    │    │
│  (every 100ms)                  │ • cleanTitle / buildQueries │    │
│                                 │ • floating PiP trigger btn   │    │
│  ┌──────────────────────────┐   │ • Document PiP window       │    │
│  │ lrc-parser.js (ISOLATED) │◄──│   (lyrics + media controls  │    │
│  │ window.FlyricsLRC       │   │    + settings panel)        │    │
│  │ .parse() / .indexAtSmooth() │   │ • rAF sync loop             │    │
│  └──────────────────────────┘   │ • popup message handler     │    │
│                                 │ • DOM metadata fallback     │    │
│                                 └──────────┬──────────────────┘    │
└────────────────────────────────────────────┼───────────────────────┘
                                              │ chrome.runtime
                                              ▼
                           ┌────────────────────────────────┐
                           │ background.js (service worker) │
                           │ • FETCH_LYRICS handler         │
                           │ • LRCLIB 3-strategy lookup     │
                           │ • mem Map + storage.session    │
                           └────────────────────────────────┘
                                             ▲
                   chrome.tabs.sendMessage   │ (popup never talks to background)
                          ┌──────────────────┴─────────────┐
                          │ popup/popup.js                 │
                          │ GET_STATE poll (2s) → render   │
                          │ SET_OFFSET / SET_FONT_SIZE     │
                          │ SET_FONT_ALIGN / RESYNC        │
                          └────────────────────────────────┘
```

## 2. Why two JS worlds?

`navigator.mediaSession.metadata` is set by the page's own scripts. Isolated-world content
scripts get their **own** `navigator.mediaSession`, which is always empty. So `main-world.js`
(registered with `"world": "MAIN"` in the manifest, Chrome 111+) reads the real metadata and the
real media element, then relays a snapshot every 100ms via `window.postMessage`.

The isolated `content.js` validates `e.source === window && e.data.source === 'flyrics-main'`
before trusting any message.

### DOM-based fallback (when mediaSession is unavailable)

Not all pages populate `navigator.mediaSession.metadata` reliably. A `setInterval`-based safety
net polls the page DOM every 2s for track metadata:

- **YouTube / YouTube Music**: reads the `<h1>` video title element and the channel name from
  the page DOM (`#owner ytd-channel-name`). Falls back to `document.title` (stripping
  `" - YouTube"` suffix).
- **Spotify Web**: reads `[data-testid="context-item-info-title"]` and
  `[data-testid="context-item-info-artist"]` elements.

When DOM-detected metadata differs from the last known key, `onTrackChange()` is called
identically as if the metadata came from MEDIA_STATE.

## 3. Track detection & title cleaning

A "track change" = the string `` `${meta.title}|${meta.artist}` `` differs from the last seen key.
On change: lyrics state → `loading`, then a **900ms debounce** before fetching (lets the media
element's `duration` settle — duration matters for LRCLIB matching).

YouTube titles are noisy (`"Artist - Song (Official Video) [4K] ft. X"`). `cleanTitle()`:
1. Removes bracketed segments `()`/`[]`/`【】`/`「」` **only if** they match the noise regex
   (official/video/lyrics/4k/remaster/…) or contain feat-credits.
2. Splits on `|` and drops noise segments.
3. Truncates from `ft./feat./featuring` onward.

`buildQueries()` produces ordered lookup variants:
- **Spotify**: `{artist: meta.artist, track, album}`, then first artist before the comma.
- **YouTube**: if cleaned title contains ` - `: `{left→artist, right→track}` AND the reversed pair;
  then `{channel (minus " - Topic"/"VEVO") → artist, cleaned title → track}`; then track-only.
Duplicates removed; empty tracks filtered.

## 4. Lyric lookup (background.js)

Three strategies in order, first hit wins:

**LRCLIB:**
1. `GET /api/get?track_name&artist_name&album_name&duration` — exact match (LRCLIB matches
   duration ±2s). Skipped when no artist or duration.
2. `GET /api/search?track_name&artist_name` — candidates scored by `pickBest`.
3. `GET /api/search?q=<artist track>` — free-text fallback, same scoring.

`scoreCandidate`: synced +5 · duration within ±7s +4 · artist substring match +2 · plain +1 ·
instrumental −2. A result must have synced/plain lyrics or be instrumental to be returned.

**Caching**: `memCache` Map (FIFO-capped at 200) + `chrome.storage.session`, keyed by
`norm(artist)|norm(track)|duration-bucket(5s)`. Negative results (null) are cached too.

Every LRCLIB request sends header `Lrclib-Client: Flyrics v1.1.7 (Chrome Extension)`.

## 5. Sync engine

A `requestAnimationFrame` loop in content.js (`tick()` / `startSyncLoop()`):
1. Guard `shouldSync()` — loop runs only while the PiP window is visible.
2. Compute position via `nowSeconds()`: prefer media-element snapshot
   `current + (now − snapshotAt)/1000 × playbackRate` (frozen when paused); else Spotify DOM clock
   `[data-testid="playback-position"]` parsed + interpolated.
   3. `result = FlyricsLRC.indexAtSmooth(lines, position + userOffset, ANIMATE_DURATION)`
   — returns `{ index, progress }` via O(log n) binary search. Progress is 0…1 within the
   active line for per-frame karaoke highlighting.
4. If `result.index` changed → `setActiveLine()` on **every render target**.

Media time is provided by `main-world.js` every 100ms via `window.postMessage`. The sync engine
also starts immediately when synced lyrics are loaded (`startSyncLoop()` called from
`applyLyricsResult()`), so the first line highlights without waiting for the next message.

When `nowSeconds()` returns a time >2s stale from the main-world snapshot, it falls through to
the DOM-based Spotify clock (re-read every tick). If that's also stale, it falls back to
the main-world snapshot regardless — preventing the sync from freezing when the tab is hidden
and main-world rAF pauses.

**Render targets** (`targets[]`) manage the PiP window: each target is
`{ doc, scroller, lineEls, titleEl, artistEl, artworkEl, offsetEl, themeBtn }`. `renderTarget()`
rebuilds line DOM; `setActiveLine()` toggles `lpp-active`/`lpp-near`/`lpp-past` classes, applies a
scale transform (up to 1.03×) and smooth-scrolls the active line to the vertical center. Past lines
(before the active index) receive `lpp-past` with opacity 0.4, the next line after active gets
`lpp-near` with opacity 0.9, all others stay at 0.75.

Lyrics states: `idle | loading | synced | plain | instrumental | notfound | error`.
`plain` renders the whole text scrollable; the rest render a centered status message.

## 6. Document Picture-in-Picture

`openPip()` (must run inside a user gesture — the floating PiP button or <kbd>J</kbd> key):
```js
const win = await window.documentPictureInPicture.requestWindow({ width: 420, height: 340 });
```
A `<style>` with `PIP_CSS` is injected, `buildChrome()` constructs the header/body/footer with
media controls (prev/play-pause/next) and a settings panel (gear toggle for font-size, alignment)
inside `win.document.body`, and the target joins `targets[]`. On `pagehide` the target is removed
and `state.pipWin` cleared. Feature detection shows a toast on Chrome < 116.

## 7. Theming & settings

`chrome.storage.sync` keys: `theme`, `fontSize`, `fontAlign`, `offset`. All surfaces react to
`chrome.storage.onChanged`, so changes anywhere sync everywhere. Theme is applied via
`data-lpp-theme="dark|light"` attributes; all colors are CSS custom properties (zinc palette,
Swiss high-contrast). Font size is a `--lpp-font-size` CSS custom property (10–48px range,
default 20). Alignment (`fontAlign`: `left`/`center`/`right`) is applied via `data-align`
attribute on the scroller.

## 8. Popup

`GET_STATE` polling every 2s. **The popup never inspects `tab.url`** (unavailable without the `tabs`
permission). On the first failed `GET_STATE`, the popup auto-injects content scripts via
`chrome.scripting.executeScript` and retries after 500ms. After 2 consecutive failures the
unsupported page panel is shown (no refresh hint needed — injection handles stale tabs).
Quick-links to YouTube and Spotify are provided.

Messages to content script: `SET_OFFSET`, `SET_FONT_SIZE`, `SET_FONT_ALIGN`, `RESYNC`.
Theme writes to `chrome.storage.sync` (content listens to `onChanged`).
The popup renders: current line preview, font-size controls (±, 10–48px), alignment buttons
(L/C/R), offset (±0.5s), resync button, theme toggle, and debug section.
All messaging logged with `[Flyrics:popup]`.

## 9. Landing page (landing/)

Single-file React page (`src/App.tsx`, plain CSS with Swiss zinc-palette design).
Built with Rsbuild (`npm run build`), output in `dist/`. Deployed to GitHub Pages via
GitHub Actions (`.github/workflows/deploy-landing.yml`). No backend calls — purely a marketing page.

## 10. Failure modes & handling

| Failure | Behavior |
|---|---|
| LRCLIB down / network error | status `error`; "Could not reach the lyrics service." (15s watchdog timeout) |
| Track not on LRCLIB | status `notfound`; negative result cached for the session |
| Only plain lyrics exist | status `plain`, full text shown, no karaoke |
| Instrumental flag | "Instrumental track — enjoy the music." |
| Lyrics drift | user offset ±0.5s steps (PiP footer / popup) |
| Spotify DOM change | media-element path still works; DOM clock is only the fallback |
| Extension reloaded under an old tab | popup auto-injects content scripts on first failed GET_STATE |
| `navigator.mediaSession` unavailable | DOM-based fallback (2s poll) reads track info from page DOM |
| `music.youtube.com` | Not yet matched in manifest; use `www.youtube.com` instead |
