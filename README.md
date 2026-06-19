# LyricPiP — Synced Lyrics & Picture-in-Picture

Karaoke-style synced lyrics for **YouTube** and **Spotify Web**, with an always-on-top PiP lyrics window. Powered by [LRCLIB](https://lrclib.net) — free, no API key required.

**[Install](https://lyricpip.github.io/)** &nbsp;·&nbsp; **[Source](https://github.com/lyricpip/lyricpip)**

[![Landing page](https://github.com/lyricpip/lyricpip/actions/workflows/deploy-landing.yml/badge.svg)](.github/workflows/deploy-landing.yml)

## Quick start

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select `extension/`.
2. Go to **YouTube** or **Spotify Web** and play a song.
3. Click the floating **PiP button** (bottom-right) or press <kbd>J</kbd> to open lyrics in an always-on-top window.

Requires Chrome 116+ (Document Picture-in-Picture API).

## Features

- **Karaoke sync** — auto-scrolling lyrics with current line highlighted, past lines faded, next line dimmed
- **Picture-in-Picture** — always-on-top lyrics window with media controls (prev/play-pause/next) and settings panel
- **Dark / light theme** — synced across popup and PiP, persisted in Chrome storage
- **Smart track matching** — cleans noisy YouTube titles, tries multiple LRCLIB lookup strategies with duration scoring
- **Sync offset** — ±0.5s steps to correct drift
- **Platform-aware controls** — YouTube `<video>` and Spotify `[data-testid]` media controls
- **DOM fallback** — reads track info from page DOM when `navigator.mediaSession` is unavailable
- **Session caching** — in-memory + `chrome.storage.session` for instant repeat lookups

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist theme, font size, alignment; cache lyrics |
| `activeTab` | Inject content scripts on demand |
| `scripting` | Programmatic script injection (popup auto-injection) |
| `https://lrclib.net/*` | Fetch lyrics from LRCLIB |
| Content scripts on `youtube.com` / `open.spotify.com` | Detect tracks and render the PiP button |

No analytics, no tracking, no remote code.

## Project layout

```
extension/          Chrome extension
  background.js     LRCLIB fetcher + scoring + caching
  content/
    content.js      Sync engine, floating PiP button, PiP window, DOM fallback
    main-world.js   MAIN-world media snapshot (100ms interval)
    lrc-parser.js   LRC parser (window.LyricPiPLRC)
  popup/            Settings popup
  manifest.json     MV3 manifest
landing/            Marketing landing page (Rsbuild + React)
  src/App.tsx       Single-file page component
.github/workflows/  GitHub Actions (landing → GitHub Pages)
```

See `ARCHITECTURE.md` for the technical deep dive and `ANCHORED.md` for project invariants.

## License

MIT
