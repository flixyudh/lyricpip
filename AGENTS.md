# AGENTS.md — Operating Manual for AI Agents

Rules and commands for any agentic AI (or human) modifying this repository.
Read `ANCHORED.md` first for project intent and invariants.

## Project type
Chrome extension (Manifest V3) at `extension/` with a marketing landing page at `landing/`.

## Commands

| Task | Command |
|---|---|
| Syntax-check all extension JS | `for f in extension/background.js extension/content/*.js extension/popup/popup.js; do node --check "$f"; done` |
| Validate manifest | `python3 -c "import json; json.load(open('extension/manifest.json'))"` |
| Build landing page | `cd landing && npm run build` |
| Dev landing page | `cd landing && npm run dev` |
| Deploy landing page + release zip | push to `main` — GitHub Actions builds `landing/dist`, zips `extension/` as a GitHub Release asset (`latest`), and deploys to GitHub Pages |

## Release checklist (run after ANY change in extension/)
1. Bump `"version"` in `extension/manifest.json` (semver).
2. `node --check` every changed JS file.
3. Update `ANCHORED.md` §6 if state changed.

## Hard rules (violations break the product)
- **Never** add permissions to `manifest.json` beyond `storage` + `activeTab` + `scripting` +
  `https://lrclib.net/*` without explicit user approval (least-privilege is a feature).
- **Never** gate popup behavior on `tab.url` — it is `undefined` without the `tabs` permission.
  Support detection = "does the content script answer `GET_STATE`?"
- **Never** trigger Document PiP from the popup or background — Chrome requires a user gesture **on the page**
  (the floating PiP button or <kbd>J</kbd> key). This is a browser security rule, not a bug.
- **Never** use global-flag (`/g`) regexes with `.test()` in cleaning logic (stateful lastIndex).
- Keep `main-world.js` dependency-free and tiny — it runs inside YouTube/Spotify's own JS world.
- Every interactive element gets a kebab-case `data-testid`.
- LRC parsing goes through `window.LyricPiPLRC` (lrc-parser.js); don't duplicate parsers.
- Debug logs use `[LyricPiP:popup]` / `[LyricPiP:content]` / `[LyricPiP:background]` /
  `[LyricPiP:main]` prefixes consistently.
- Content script has a DOM-based fallback for track metadata that polls every 2s when
  `navigator.mediaSession.metadata` is unavailable (YouTube `<h1>` / channel name, Spotify
  `context-item-info-title/artist`). Never remove this — some pages don't set mediaSession.

## Message protocols (do not change shapes without updating all three sides)
- **MAIN world → content**: `window.postMessage({ source:'lyricpip-main', type:'MEDIA_STATE', payload })`
- **content → background**: `chrome.runtime.sendMessage({ type:'FETCH_LYRICS', queries:[{artist,track,album?}], duration })` → `{ ok, result|error }`
- **popup → content**: `GET_STATE` / `SET_OFFSET {delta}` / `SET_FONT_SIZE {value}` / `SET_FONT_ALIGN {value}` / `RESYNC` (sendResponse-based)
- **settings**: `chrome.storage.sync` keys `theme` (`'dark'|'light'`), `fontSize`, `fontAlign`;
  both content.js and popup.js listen to `chrome.storage.onChanged`.

## Where things live
- Sync engine + floating PiP button + PiP window: `extension/content/content.js` (single IIFE, sections marked
  with `// ====` banners — keep new code inside the matching section)
- LRCLIB strategy/scoring: `extension/background.js` (`fetchLyrics`, `pickBest`)
- MAIN-world media snapshot: `extension/content/main-world.js` (postMessage every 100ms)
- Title cleaning for YouTube: `cleanTitle()` / `buildQueries()` in content.js
- DOM-based metadata fallback: inline in content.js (polls every 2s when mediaSession is unavailable)
- Popup with auto-injection + 2× retry: `extension/popup/popup.js`
