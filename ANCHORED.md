# ANCHORED.md — LyricPiP Project Anchor Document

> **Purpose**: This is the single source of truth for any AI agent or developer working on this
> project. Read this first. It anchors the project's intent, architecture, invariants, and
> conventions so changes never drift from the original design.

---

## 1. What this project IS

**LyricPiP** is a production-ready **Google Chrome extension (Manifest V3)** that shows
**karaoke-style synced lyrics** for music playing on **YouTube** (`youtube.com`) and
**Spotify Web** (`open.spotify.com`), including an **always-on-top Picture-in-Picture lyrics
window** built on the **Document Picture-in-Picture API** (Chrome 116+).

Lyrics come from **LRCLIB** (`https://lrclib.net`). It is free and keyless.

A **React landing page** (the `landing/` app, Rsbuild + plain CSS) exists only to market the
extension. Deployed to GitHub Pages via GitHub Actions.

### Locked user choices (do not change without user approval)
| Decision | Choice |
|---|---|
| Lyrics source | LRCLIB (3 strategies: exact get, structured search, free-text search) |
| Platforms | YouTube + Spotify Web **only** |
| PiP behavior | Floating Document PiP window, always-on-top |
| Lyrics display | Synced karaoke-style (auto-scroll, multi-line: past/active/near/upcoming) |
| Theme | Dark/light **toggle** (synced across popup and PiP) |

---

## 2. Repository map

```
.
├── extension/                  ← THE PRODUCT (Manifest V3 Chrome extension)
│   ├── manifest.json           MV3 manifest (version, scripts, permissions)
│   ├── background.js           Service worker: LRCLIB lookups, caching
│   ├── content/
│   │   ├── main-world.js       MAIN-world script: reads mediaSession + media element time
│   │   ├── lrc-parser.js       LRC format parser (window.LyricPiPLRC)
│   │   ├── content.js          Core: floating PiP button, Document PiP window, sync engine,
│   │   │                       DOM metadata fallback, messaging handler
│   ├── popup/                  Extension popup (popup.html / popup.js + inline styles)
│   ├── icons/                  Generated PNGs (16/32/48/128)
│   └── README.md               End-user docs (install, features, troubleshooting)
├── landing/                    Rsbuild + React landing page (npm, plain CSS)
│   ├── src/App.tsx             Entire landing page (single component file)
│   ├── src/App.css             All styles (Swiss zinc palette, no framework)
│   └── dist/                   Built output (html + hashed JS bundles)
├── .github/workflows/
│   └── deploy-landing.yml      GitHub Actions: build + deploy landing to GitHub Pages
├── AGENTS.md                   Operating rules for AI agents (commands, invariants)
├── ANCHORED.md                 ← you are here
├── ARCHITECTURE.md             Deep technical architecture + message protocols
└── README.md                   Project overview
```

---

## 3. Non-negotiable invariants

1. **No API keys, no tracking.** LRCLIB is keyless. Never add analytics or remote code to the
   extension (Chrome Web Store policy + project promise).
2. **Manifest V3 only.** `minimum_chrome_version: 116` (Document PiP requirement).
3. **Permissions stay minimal**: `storage` + `activeTab` + `scripting` + host permissions
   `https://lrclib.net/*` only.
   The popup deliberately has **no `tabs` permission** — therefore `tab.url` is NOT available in
   `popup.js`; support detection works by messaging the content script (see §5).
4. **PiP must be opened from a user gesture on the page** (the floating PiP button or <kbd>J</kbd> key).
   Chrome forbids `documentPictureInPicture.requestWindow()` from the popup or background
   context — never "fix" this by moving the PiP trigger off the page.
5. **Two JS worlds**: `main-world.js` runs in the page's MAIN world (to read
   `navigator.mediaSession`); everything else runs isolated. They talk via `window.postMessage`
   with `source: 'lyricpip-main'`. Never merge these files.
6. **All interactive elements carry `data-testid`** attributes (kebab-case).
7. **Every interactive element gets a data-testid**: each `<button>` and interactive element in
   the PiP window and popup has a kebab-case `data-testid` attribute.
8. Frontend tooling: the extension uses **no bundler** (raw JS); the landing page uses **npm**
   (not yarn) with plain CSS (no Tailwind, no design token JSON).

---

## 4. How the extension works (10-second version)

```
Page (YouTube / Spotify Web)
  main-world.js  → every 100ms postMessage { meta(title/artist/album/art), currentTime, duration, paused, rate }
  content.js     → detects track change (from MEDIA_STATE or DOM fallback) → cleans title → asks background for lyrics
                  → renders floating PiP trigger button + Document PiP window
                  → rAF sync loop: interpolated position + user offset → active LRC line
                  → past lines fade (lpp-past), active highlighted (lpp-active), next dim (lpp-near)
                  → DOM fallback: reads YouTube <h1>/channel or Spotify context-item-info every 2s
  background.js  → LRCLIB: /api/get (exact) → /api/search (track+artist) → /api/search?q= (free text)
                  → scoring: synced(+5) duration±7s(+4) artist-match(+2) plain(+1) instrumental(−2)
                  → cache: in-memory Map (≤200) + chrome.storage.session
```

Full details: `ARCHITECTURE.md`.

---

## 5. Known tricky bits (bugs already fixed — do not regress)

| Area | Trap | Resolution |
|---|---|---|
| popup.js | `chrome.tabs.query` does **not** expose `tab.url` without `tabs` permission → URL-regex gating made every page look "unsupported" | Never gate on URL. Send `GET_STATE` to the active tab; if the content script answers → supported. Auto-inject content scripts on first failure, then retry once. (Fixed in v1.1.0) |
| content.js `cleanTitle` | Global-flag regexes (`/g`) are stateful with `.test()` → intermittent wrong cleaning | All noise regexes are non-global (`/i` only) |
| Spotify | No guaranteed accessible media element | DOM fallback: parse `[data-testid="playback-position"]` clock text + interpolate |
| YouTube SPA | Navigation doesn't reload the page | Track change detected by polling mediaSession metadata key (`title|artist`) |
| Extension update listener death | After extension update, old content script's `chrome.runtime.onMessage` stops working, but the guard (`window.__lyricpipLoaded`) prevents re-injected scripts from registering a new listener | Version-aware guard (`__lyricpipLoaded = manifest.version`) bypassed on version mismatch; popup resets guard before injection; old intervals/event listeners are cleaned up via stored global references. (Fixed in v1.1.0) |
| PiP cleanup | PiP window outliving render targets | `pagehide` listener removes the PiP render target from `targets[]` |
| Sync drift | 500ms main-world poll + 250ms sync loop caused sluggish line updates | Increased poll to 100ms and switched to rAF sync loop. (Fixed in v1.1.0) |
| Sync paused on playing tracks | rAF loop gated on `isPlaybackPaused()` which incorrectly returned `true` on some pages | Removed `isPlaybackPaused()` gate; loop runs while PiP is visible. (Fixed) |
| Track transition uses stale time | Previous song's `currentTime` lingered when new song's lyrics loaded first | `onTrackChange()` resets `state.time` to null, forcing sync to wait for fresh snapshot. (Fixed) |
| LRCLIB miss rate | Some tracks not found with single query | Added 3 search strategies (exact → structured → free-text) with duration scoring. |
| Past-line clutter | All lines look the same — no sense of "already sung" vs "coming up" | `lpp-past` class fades lines before active index (opacity 0.4). (Added in v1.2.0) |
| Track detection when mediaSession empty | Content script relied solely on `navigator.mediaSession.metadata` via postMessage — null if page doesn't set it | Added DOM-based fallback: YouTube reads `<h1>` title + channel name; Spotify reads `[data-testid="context-item-info-title/artist"]`. Polls every 2s as safety net. (Added in v1.2.0) |
| YouTube Music not supported | `music.youtube.com` not in manifest content_scripts matches | Not yet added; use `www.youtube.com` instead. |
| Tab-hide breaks sync + scrolls to top | Returning to a hidden tab: `state.time` goes stale (main-world rAF paused), `nowSeconds()` interpolates wildly; `applyLyricsResult` renders at `activeIdx=-2` which scrolls to top, but `state.time` was cleared by `onTrackChange()` so `tick()` cant fix it | `nowSeconds()` falls through to DOM clock when media snapshot is >2 s stale; `setActiveLine` only scrolls to top on `idx === -1` (sync-confirmed before-first-line), not uninitialized `idx < -1`. (Fixed) |
| findActiveMedia() bounces between videos | Multiple `<video>` elements (ads, previews, main content) returned different elements on each poll → `currentTime` jumps erratically | Prefer the element with the longest `duration` to reliably identify the main video. (Fixed in v1.2.0) |
| PiP sync freezes in background tabs | Pure `requestAnimationFrame` chain breaks silently when the tab is throttled/backgrounded, killing the sync loop permanently (no recovery mechanism). | Replaced rAF-only loop with hybrid `setInterval` (100ms backbone) + `rAF` (smooth frame-by-frame). `syncTick()` kills both timers cleanly on track change. `syncDisplay()` hooks into `handleMediaState` for direct PiP updates. (Fixed in v1.1.5) |

---

## 6. Current state & where to go next

- **Version**: 1.1.5 (see `extension/manifest.json`)
  - Added floating PiP trigger button (bottom-right of any supported page)
  - Added media controls (prev/play-pause/next) inside PiP window
  - Added settings panel in PiP (font-size ±2, alignment L/C/R) via gear toggle
  - `findActiveMedia()` prefers element with longest `duration` (avoids ads/previews)
  - Landing page synced, GitHub Actions deployment added
  - `chrome.commands` global shortcut removed (could not open PiP without gesture)
- **Lyrics sources**: LRCLIB (primary, 3 strategies)
- **Permissions**: `storage` + `activeTab` + `scripting` + host `https://lrclib.net/*`
- **Settings**: theme, font size (default 20, range 10–48), font align (left/center/right, default center), offset
- **Sync engine**: `requestAnimationFrame` loop with anticipatory line detection
  (0.3 s transition window) and frame-by-frame progress styling, aligned with
  `mantou132/spotify-lyrics` sync behavior. Runs while PiP is visible
  (not gated on `paused`). On track change, stale time is reset so the previous
  song's `currentTime` never pollutes the new song's initial sync.
  Tab-hide resilience: `nowSeconds()` prefers DOM clock when media snapshot is >2 s stale;
  `setActiveLine` only scrolls to top at `idx === -1` (sync-confirmed before-first-line),
  not uninitialized sentinel values.
- **Extension zips**: zipped on every push via GitHub Actions (`deploy-landing.yml`) and uploaded
  as a GitHub Release asset (`latest`).
- **Backlog** (prioritized): click-to-seek lyric lines, per-track offset persistence, more
  platforms (YouTube Music, SoundCloud), Chrome Web Store assets.

**Companion docs**: `AGENTS.md` (agent operating manual) · `ARCHITECTURE.md` (deep dive) ·
`extension/README.md` (end-user docs).
