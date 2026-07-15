# Flyrics — Synced Lyrics & Picture-in-Picture

A production-ready Chrome extension (Manifest V3) that shows **karaoke-style synced lyrics** for music playing on **YouTube** and **Spotify Web**, with an **always-on-top Picture-in-Picture lyrics window** (Document PiP API).

Lyrics are provided by [LRCLIB](https://lrclib.net) — free, no API key required.

## Features

- 🎤 Karaoke-style synced lyrics — auto-scrolling, current line highlighted, past lines faded
- 🪟 Always-on-top PiP lyrics window with **media controls** (prev/play-pause/next) and **settings panel** (font size, alignment)
- 🎬 Works on YouTube (`youtube.com`) and Spotify Web (`open.spotify.com`)
- 🌗 Dark / light theme toggle (synced across popup and PiP)
- 🎯 Smart track matching: cleans noisy YouTube titles ("Official Video", "[4K]", "ft. …") and tries multiple LRCLIB lookup strategies with duration scoring
- ⏱ Sync offset control (±0.5s steps) when lyrics drift
- 📝 Plain-lyrics fallback when no synced lyrics exist
- ⚡ In-memory + session caching of lyric lookups

## Install (Load unpacked)

1. Download / clone this folder (`extension/`).
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension` folder.
5. Open YouTube or Spotify Web, play a song — the floating **PiP button** appears (bottom-right).
6. Press <kbd>J</kbd> or click the **PiP button** to open lyrics in an always-on-top window.

> Requires Chrome 116+ (Document Picture-in-Picture API).

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│ Page (YouTube / Spotify Web)                                │
│                                                             │
│  main-world.js (MAIN world)                                 │
│   • reads navigator.mediaSession.metadata (title/artist)    │
│   • reads <video>/<audio> currentTime / duration / paused   │
│   • postMessage → content script every 100ms                │
│                                                             │
│  content.js (isolated world)                                │
│   • track-change detection + title cleaning                 │
│   • renders floating PiP trigger button                     │
│   • opens Document PiP window with synced lyrics + controls │
│   • rAF sync loop with playback-time interpolation          │
│   • DOM metadata fallback (reads page DOM every 2s)         │
└──────────────────────────┬──────────────────────────────────┘
                           │ chrome.runtime.sendMessage
┌──────────────────────────▼──────────────────────────────────┐
│ background.js (service worker)                              │
│   • LRCLIB lookup: /api/get → /api/search (track+artist)    │
│     → /api/search?q= free text, with duration scoring       │
│   • caching (memory + chrome.storage.session)               │
└─────────────────────────────────────────────────────────────┘
```

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist theme, font size, alignment; cache lyrics |
| `activeTab` | Inject content scripts into the active tab on demand |
| `scripting` | Programmatic script injection (popup auto-injection) |
| `host_permissions: https://lrclib.net/*` | Fetch lyrics from LRCLIB |
| Content scripts on `youtube.com` / `open.spotify.com` | Detect songs and render the PiP button |

No analytics, no tracking, no remote code.

## Notes & troubleshooting

- **PiP must be opened from the page** — Chrome only allows Document PiP from a user gesture (clicking the floating PiP button or pressing <kbd>J</kbd>), not from the extension popup.
- If lyrics drift, use the **−/+ offset** buttons (PiP footer or extension popup).
- Some tracks don't exist on LRCLIB; the extension falls back to plain lyrics or shows "No lyrics found".
- On Spotify Web, playback position is read from the player's DOM; if Spotify changes their DOM the media-element fallback still works.
- The <kbd>J</kbd> and <kbd>D</kbd> keyboard shortcuts don't fire when typing in a text input, textarea, or contenteditable field.
