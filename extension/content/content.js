  /**
   * LyricPiP — main content script (isolated world)
   * - Receives track metadata + playback position from the MAIN-world script
   * - Fetches lyrics via the background service worker (LRCLIB)
   * - Renders a draggable on-page overlay with karaoke-style synced lyrics
   * - Opens a Document Picture-in-Picture window with the same synced view
   */
(() => {
  let VER = '';
  try { VER = chrome.runtime.getManifest().version; } catch (_e) { /* chrome.runtime may be unavailable in some contexts */ }
  if (VER && window.__lyricpipLoaded === VER) return;
  window.__lyricpipLoaded = VER || Date.now().toString();

  const PLATFORM = location.hostname.includes('spotify') ? 'spotify' : 'youtube';
  const LRC = window.LyricPiPLRC;

  const state = {
    metaKey: null,
    meta: null, // { title, artist, album, artwork }
    time: { current: null, duration: null, paused: true, rate: 1, at: 0 },
    spotifyDom: { sec: null, at: 0, paused: true },
    lyrics: { status: 'idle', synced: null, plain: null, source: null }, // status: idle|loading|synced|plain|instrumental|notfound|error
    activeIdx: -2,
    activeProgress: 1,
    offset: 0,
    theme: 'dark',
    fontSize: 20,
    fontAlign: 'center',
    pipWin: null,
    fetchTimer: null,
    fetchSeq: 0,
    lastMediaSessionAt: 0,
    lastFetchTitle: null,
  };

  /** Render targets: (optional) PiP window. */
  const targets = [];

  // ============================================================
  // Settings
  // ============================================================
  chrome.storage.sync.get({ theme: 'dark', fontSize: 20, fontAlign: 'center' }, (cfg) => {
    state.theme = cfg.theme;
    state.fontSize = cfg.fontSize;
    state.fontAlign = cfg.fontAlign;
    applyTheme();
    applySettings();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.theme) {
      state.theme = changes.theme.newValue;
      applyTheme();
    }
    if (changes.fontSize) {
      state.fontSize = changes.fontSize.newValue;
      applySettings();
    }
    if (changes.fontAlign) {
      state.fontAlign = changes.fontAlign.newValue;
      applySettings();
    }
  });

  function saveSetting(key, value) {
    try {
      chrome.storage.sync.set({ [key]: value });
    } catch (_e) {
      /* extension context invalidated */
    }
  }

  // ============================================================
  // Media state from MAIN world
  // ============================================================
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'lyricpip-main') return;
    if (e.data.type === 'MEDIA_STATE') handleMediaState(e.data.payload);
  });

  function handleMediaState(p) {
    if (p.currentTime !== null && p.currentTime !== undefined) {
      state.time = {
        current: p.currentTime,
        duration: p.duration,
        paused: p.paused,
        rate: p.playbackRate || 1,
        at: Date.now(),
      };
      if (state.lyrics.status === 'synced') {
        if (!state.time.paused) startSyncLoop();
        syncDisplay();
      }
    }
    if (targets.length > 0) updatePlayPauseIcon();
    if (p.meta && p.meta.title) {
      state.lastMediaSessionAt = Date.now();
      const key = `${p.meta.title}|${p.meta.artist}`;
      if (key !== state.metaKey) {
        state.metaKey = key;
        state.meta = p.meta;
        // Only trigger a full re-fetch if the title actually changed.
        // Artist/album fluctuation on Spotify mediaSession should not reset lyrics.
        if (p.meta.title !== state.lastFetchTitle) {
          onTrackChange();
        }
      }
    }
  }

  // ============================================================
  // Spotify DOM fallback for playback position
  // ============================================================
  function parseClock(text) {
    if (!text) return null;
    const parts = text.trim().split(':').map(Number);
    if (parts.some(Number.isNaN)) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function readSpotifyDom() {
    // Strategy 1: explicit playback-position text element
    let posEl = document.querySelector('[data-testid="playback-position"]');
    let sec = parseClock(posEl && posEl.textContent);
    let src = 'playback-position';

    // Strategy 2: progress bar slider with aria-valuenow
    if (sec === null) {
      const slider = document.querySelector('[role="slider"][aria-valuenow]');
      if (slider) {
        const v = parseFloat(slider.getAttribute('aria-valuenow'));
        if (Number.isFinite(v) && v >= 0) { sec = v; src = 'slider'; }
      }
    }

    // Strategy 3: alternate testid for playback time
    if (sec === null) {
      const alt = document.querySelector('[data-testid="playback-progress"]');
      sec = parseClock(alt && alt.textContent);
      if (sec !== null) src = 'playback-progress';
    }

    if (sec === null) return;
    const playBtn = document.querySelector('[data-testid="control-button-playpause"]');
    const label = (playBtn && (playBtn.getAttribute('aria-label') || '')).toLowerCase();
    const paused = label.startsWith('play');
    if (sec !== state.spotifyDom.sec || paused !== state.spotifyDom.paused) {
      state.spotifyDom = { sec, at: Date.now(), paused };
    }
  }

  /** Best-known playback position in seconds (with interpolation).
   *  Prefers the media-element snapshot (state.time), but falls through to the
   *  DOM-based Spotify clock when the snapshot is stale (>2 s old) — the DOM
   *  is re-read every tick and stays fresh even after the tab was hidden while
   *  the media-snapshot source (main-world.js) may have stopped sending updates. */
  function nowSeconds() {
    const t = state.time;
    // Fresh media-element snapshot (<2s old) — trust paused flag.
    if (t.current !== null) {
      const elapsed = Date.now() - t.at;
      if (elapsed < 2000) {
        if (t.paused) return t.current;
        return t.current + (elapsed / 1000) * (t.rate || 1);
      }
    }
    // Spotify DOM clock — refreshed every tick, trust its paused flag.
    const d = state.spotifyDom;
    if (d.sec !== null) {
      if (d.paused) return d.sec;
      return d.sec + (Date.now() - d.at) / 1000;
    }
    // Last resort: stale media-snapshot. Always interpolate — paused
    // may itself be stale (main-world.js can't find a media element).
    if (t.current !== null) {
      if (!t.paused) return t.current + ((Date.now() - t.at) / 1000) * (t.rate || 1);
      // Stale + paused: interpolate anyway — a drifting clock beats a frozen one.
      return t.current + ((Date.now() - t.at) / 1000);
    }
    return null;
  }

  // ============================================================
  // Title cleaning / query building
  // ============================================================
  const NOISE_RE = /(official\s*(music|lyric|lyrics)?\s*(video|audio|visualizer|mv)?|lyrics?\s*video|\blyrics?\b|\baudio\b|visuali[sz]er|remaster(ed)?(\s*\d{4})?|\bhd\b|\b4k\b|full\s*(song|video)|color\s*coded|\bm\/?v\b|sub\s*espa\u00f1ol|legendado)/i;

  function cleanTitle(raw) {
    let t = raw || '';
    // Drop bracketed segments that are noise or feat credits.
    t = t.replace(/\([^()]*\)|\[[^\[\]]*\]|\u3010[^\u3011]*\u3011|\u300c[^\u300d]*\u300d/g, (seg) =>
      NOISE_RE.test(seg) || /\b(ft\.?|feat\.?|featuring|with)\b/i.test(seg) ? ' ' : seg
    );
    // Drop pipe-separated noise segments ("Song | Official Video").
    const segs = t.split('|');
    if (segs.length > 1) {
      const kept = segs.filter((s) => !NOISE_RE.test(s));
      t = (kept.length ? kept : [segs[0]]).join(' ');
    }
    t = t.replace(/\b(ft\.?|feat\.?|featuring)\b.*$/i, '');
    t = t.replace(/\s{2,}/g, ' ').replace(/[|\-–—\s]+$/g, '').trim();
    return t;
  }

  function cleanArtist(raw) {
    return (raw || '')
      .replace(/\s*-\s*Topic\s*$/i, '')
      .replace(/VEVO\s*$/i, '')
      .replace(/\s*(official)\s*$/i, '')
      .trim();
  }

  function buildQueries() {
    const m = state.meta;
    if (!m) return [];
    const queries = [];
    if (PLATFORM === 'spotify') {
      const artist = (m.artist || '').split(',')[0].trim();
      queries.push({ artist: m.artist, track: m.title, album: m.album });
      if (artist && artist !== m.artist) queries.push({ artist, track: m.title });
    } else {
      const cleaned = cleanTitle(m.title);
      const channel = cleanArtist(m.artist);
      const dashMatch = cleaned.split(/\s+[-–—]\s+/);
      if (dashMatch.length >= 2) {
        const left = dashMatch[0].trim();
        const right = dashMatch.slice(1).join(' - ').trim();
        queries.push({ artist: left, track: right });
        queries.push({ artist: right, track: left });
      }
      if (channel) queries.push({ artist: channel, track: cleaned });
      queries.push({ artist: '', track: cleaned });
    }
    const seen = new Set();
    return queries.filter((q) => {
      const k = `${(q.artist || '').toLowerCase()}|${(q.track || '').toLowerCase()}`;
      if (!q.track || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ============================================================
  // Track change + lyrics fetching
  // ============================================================
  function onTrackChange() {
    state.lyrics = { status: 'loading', synced: null, plain: null, source: null };
    state.activeIdx = -2;
    state.time = { current: null, duration: null, paused: true, rate: 1, at: 0 };
    state.spotifyDom = { sec: null, at: 0, paused: true };
    state.lastFetchTitle = (state.meta && state.meta.title) || null;
    renderAllTargets();
    clearTimeout(state.fetchTimer);
    state.fetchTimer = setTimeout(fetchLyricsNow, 900);
  }

  function fetchLyricsNow() {
    const seq = ++state.fetchSeq;
    const queries = buildQueries();
    if (queries.length === 0) {
      state.lyrics.status = 'notfound';
      renderAllTargets();
      return;
    }
    const duration = state.time.duration || null;
    let responded = false;
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_LYRICS', queries, duration }, (resp) => {
        responded = true;
        if (seq !== state.fetchSeq) return;
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          state.lyrics.status = 'error';
          renderAllTargets();
          return;
        }
        applyLyricsResult(resp.result);
      });
    } catch (_e) {
      state.lyrics.status = 'error';
      renderAllTargets();
    }
    setTimeout(() => {
      if (!responded && seq === state.fetchSeq && state.lyrics.status === 'loading') {
        state.lyrics.status = 'error';
        renderAllTargets();
      }
    }, 15000);
  }

  function applyLyricsResult(result) {
    if (!result) {
      state.lyrics = { status: 'notfound', synced: null, plain: null, source: null };
    } else if (result.instrumental) {
      state.lyrics = { status: 'instrumental', synced: null, plain: null, source: result };
    } else {
      const synced = result.syncedLyrics ? LRC.parse(result.syncedLyrics) : null;
      if (synced && synced.length) {
        state.lyrics = { status: 'synced', synced, plain: result.plainLyrics, source: result };
      } else if (result.plainLyrics) {
        state.lyrics = { status: 'plain', synced: null, plain: result.plainLyrics, source: result };
      } else {
        state.lyrics = { status: 'notfound', synced: null, plain: null, source: null };
      }
    }
    state.activeIdx = -2;
    state.activeProgress = 1;
    renderAllTargets();
    if (state.lyrics.status === 'synced') startSyncLoop();
  }

  // ============================================================
  // Sync engine (setInterval + rAF hybrid, anticipatory line detection)
  // ============================================================
  let syncIntervalId = null;
  let syncRafId = null;
  let lastTickAt = 0;

  function startSyncLoop() {
    if (syncIntervalId) return;
    if (state.lyrics.status !== 'synced') return;
    syncIntervalId = setInterval(syncTick, 100);
    syncTick();
  }

  function stopSyncLoop() {
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
      syncIntervalId = null;
    }
    if (syncRafId) {
      cancelAnimationFrame(syncRafId);
      syncRafId = null;
    }
  }

  function isPlaybackPaused() {
    if (state.time.current !== null) return state.time.paused;
    if (state.spotifyDom.sec !== null) return state.spotifyDom.paused;
    return true;
  }

  function syncTick() {
    if (state.lyrics.status !== 'synced') {
      stopSyncLoop();
      return;
    }
    if (PLATFORM === 'spotify') readSpotifyDom();

    const t = nowSeconds();
    if (t === null) {
      scheduleRafTick();
      return;
    }

    const adjusted = t + state.offset;
    const { index: idx, progress } = LRC.indexAtSmooth(state.lyrics.synced, adjusted, 0.3);

    if (idx !== state.activeIdx || Math.abs(progress - state.activeProgress) > 0.01) {
      const idxChanged = idx !== state.activeIdx;
      state.activeIdx = idx;
      state.activeProgress = progress;
      lastTickAt = Date.now();
      if (targets.length > 0) {
        for (const target of targets) setActiveLine(target, idx, progress, idxChanged ? 'smooth' : false);
      }
    }

    scheduleRafTick();
  }

  function scheduleRafTick() {
    if (syncRafId) return;
    syncRafId = requestAnimationFrame(function onRaf() {
      syncRafId = null;
      syncTick();
    });
  }

  function syncDisplay() {
    if (state.lyrics.status !== 'synced' || targets.length === 0) return;
    if (PLATFORM === 'spotify') readSpotifyDom();
    const t = nowSeconds();
    if (t === null) return;
    const adjusted = t + state.offset;
    const { index: idx, progress } = LRC.indexAtSmooth(state.lyrics.synced, adjusted, 0.3);
    if (idx !== state.activeIdx || Math.abs(progress - state.activeProgress) > 0.01) {
      const idxChanged = idx !== state.activeIdx;
      state.activeIdx = idx;
      state.activeProgress = progress;
      lastTickAt = Date.now();
      for (const target of targets) setActiveLine(target, idx, progress, idxChanged ? 'smooth' : false);
    }
  }

  // ============================================================
  // Rendering (shared by overlay + PiP)
  // ============================================================
  const ICONS = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="8,5 19,12 8,19" stroke-linejoin="round"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="6" y="4" width="4" height="16" rx="0.5"/><rect x="14" y="4" width="4" height="16" rx="0.5"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="17,5 7,12 17,19" stroke-linejoin="round"/><rect x="5" y="4" width="2" height="16" rx="0.5"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="17" y="4" width="2" height="16" rx="0.5"/><polygon points="7,5 17,12 7,19" stroke-linejoin="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };

  function statusText() {
    switch (state.lyrics.status) {
      case 'loading':
        return 'Searching lyrics\u2026';
      case 'notfound':
        return 'No lyrics found for this track.';
      case 'instrumental':
        return 'Instrumental track \u2014 enjoy the music.';
      case 'error':
        return 'Could not reach the lyrics service.';
      case 'idle':
        return 'Play a song to see lyrics.';
      default:
        return '';
    }
  }

  /** Rebuild the lyric line elements inside a target's scroller. */
  function renderTarget(target) {
    const { scroller, doc } = target;
    scroller.innerHTML = '';
    target.lineEls = [];
    if (target.titleEl) target.titleEl.textContent = (state.meta && state.meta.title) || 'No track detected';
    if (target.artistEl) target.artistEl.textContent = (state.meta && state.meta.artist) || '';
    if (target.artworkEl) {
      if (state.meta && state.meta.artwork) {
        target.artworkEl.src = state.meta.artwork;
        target.artworkEl.style.display = '';
      } else {
        target.artworkEl.style.display = 'none';
      }
    }

    if (state.lyrics.status === 'synced') {
      const topPad = doc.createElement('div');
      topPad.style.height = '50%';
      topPad.style.flexShrink = '0';
      scroller.appendChild(topPad);
      for (let i = 0; i < state.lyrics.synced.length; i++) {
        const div = doc.createElement('div');
        div.className = 'lpp-line';
        div.textContent = state.lyrics.synced[i].text || '\u266a';
        div.setAttribute('data-testid', 'lyric-line');
        scroller.appendChild(div);
      }
      target.lineEls = Array.from(scroller.querySelectorAll('.lpp-line'));
      const bottomPad = doc.createElement('div');
      bottomPad.style.height = '50%';
      bottomPad.style.flexShrink = '0';
      scroller.appendChild(bottomPad);
      setActiveLine(target, state.activeIdx, state.activeProgress, 'instant');
    } else if (state.lyrics.status === 'plain') {
      const div = doc.createElement('div');
      div.className = 'lpp-plain';
      div.setAttribute('data-testid', 'plain-lyrics');
      div.textContent = state.lyrics.plain;
      scroller.appendChild(div);
    } else {
      const div = doc.createElement('div');
      div.className = 'lpp-status';
      div.setAttribute('data-testid', 'lyrics-status');
      div.textContent = statusText();
      scroller.appendChild(div);
    }
  }

  /**
   * Update line classes and frame-by-frame progress styling.
   * scroll: false | 'smooth' | 'instant' — whether to scroll the active line.
   */
  function setActiveLine(target, idx, progress, scroll) {
    const els = target.lineEls;
    if (!els || els.length === 0) return;
    for (let i = 0; i < els.length; i++) {
      let cls = 'lpp-line';
      if (i === idx) cls += ' lpp-active';
      else if (i < idx) cls += ' lpp-past';
      else if (Math.abs(i - idx) === 1) cls += ' lpp-near';
      if (els[i].className !== cls) els[i].className = cls;
      if (i !== idx) {
        els[i].style.transform = '';
        els[i].style.opacity = '';
      }
    }
    if (idx >= 0 && els[idx]) {
      const p = typeof progress === 'number' ? progress : 1;
      const scale = 1 + p * 0.03;
      const opacity = 0.75 + p * 0.25;
      els[idx].style.transform = 'scale(' + scale.toFixed(3) + ')';
      els[idx].style.opacity = opacity.toFixed(3);
      if (scroll === 'instant') {
        els[idx].scrollIntoView({ behavior: 'auto', block: 'center' });
      } else if (scroll === 'smooth') {
        els[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else if (idx === -1) {
      target.scroller.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

  function renderAllTargets() {
    for (const target of targets) renderTarget(target);
    updateOffsetLabels();
  }

  function updateOffsetLabels() {
    const label = `${state.offset >= 0 ? '+' : ''}${state.offset.toFixed(1)}s`;
    for (const target of targets) {
      if (target.offsetEl) target.offsetEl.textContent = label;
    }
  }

  function applyTheme() {
    if (state.pipWin && !state.pipWin.closed) {
      state.pipWin.document.documentElement.setAttribute('data-lpp-theme', state.theme);
    }
    for (const target of targets) {
      if (target.themeBtn) target.themeBtn.innerHTML = state.theme === 'dark' ? ICONS.sun : ICONS.moon;
    }
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    saveSetting('theme', state.theme);
    applyTheme();
  }

  function applySettings() {
    for (const target of targets) {
      if (target.scroller) {
        target.scroller.style.setProperty('--lpp-font-size', state.fontSize + 'px');
        target.scroller.setAttribute('data-align', state.fontAlign);
      }
      if (target.fontVal) {
        target.fontVal.textContent = state.fontSize;
      }
    }
  }

  function adjustOffset(delta) {
    state.offset = Math.round((state.offset + delta) * 10) / 10;
    updateOffsetLabels();
    if (state.lyrics.status === 'synced') startSyncLoop();
  }

  function togglePlayback() {
    const video = document.querySelector('video');
    if (video) {
      if (video.paused) video.play();
      else video.pause();
    } else if (PLATFORM === 'spotify') {
      const btn = document.querySelector('[data-testid="control-button-playpause"]');
      if (btn) btn.click();
    }
    updatePlayPauseIcon();
  }

  function prevTrack() {
    if (PLATFORM === 'spotify') {
      const btn = document.querySelector('[data-testid="control-button-skip-back"]');
      if (btn) btn.click();
    } else {
      const btns = document.querySelectorAll('[aria-label*="Previous" i], .ytp-prev-button');
      for (const b of btns) { b.click(); break; }
    }
  }

  function nextTrack() {
    if (PLATFORM === 'spotify') {
      const btn = document.querySelector('[data-testid="control-button-skip-forward"]');
      if (btn) btn.click();
    } else {
      const btns = document.querySelectorAll('[aria-label*="Next" i], .ytp-next-button');
      for (const b of btns) { b.click(); break; }
    }
  }

  function updatePlayPauseIcon() {
    const paused = isPlaybackPaused();
    for (const target of targets) {
      if (target.playBtn) {
        target.playBtn.innerHTML = ICONS[paused ? 'play' : 'pause'];
      }
    }
  }

  function btn(doc, icon, title, testid, onClick) {
    const b = doc.createElement('button');
    b.className = 'lpp-btn';
    b.innerHTML = ICONS[icon];
    b.title = title;
    b.setAttribute('data-testid', testid);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  const PIP_BTN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor" stroke="none"/></svg>';
  let pipBtn = null;

  function ensurePipButton() {
    if (pipBtn) return;
    if (!document.body) return;
    pipBtn = document.createElement('div');
    pipBtn.id = 'lyricpip-pip-trigger';
    pipBtn.setAttribute('data-testid', 'lyricpip-pip-trigger');
    pipBtn.innerHTML = PIP_BTN_ICON;
    pipBtn.title = 'Open Picture-in-Picture lyrics';
    Object.assign(pipBtn.style, {
      all: 'initial', position: 'fixed', bottom: '24px', right: '24px',
      zIndex: '2147483646', width: '44px', height: '44px', borderRadius: '50%',
      background: '#18181b', border: '1px solid rgba(250,250,250,0.12)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.6)', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#fafafa', opacity: '0.6', transition: 'opacity 0.3s ease, transform 0.2s ease',
    });
    pipBtn.addEventListener('mouseenter', () => {
      pipBtn.style.opacity = '1';
      pipBtn.style.transform = 'scale(1.05)';
    });
    pipBtn.addEventListener('mouseleave', () => {
      pipBtn.style.opacity = '0.6';
      pipBtn.style.transform = 'scale(1)';
    });
    pipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPip();
    });
    document.body.appendChild(pipBtn);
  }

  function buildChrome(doc, root) {
    const target = { doc };

    const header = doc.createElement('div');
    header.className = 'lpp-header';

    const artwork = doc.createElement('img');
    artwork.className = 'lpp-artwork';
    artwork.alt = '';
    artwork.style.display = 'none';
    header.appendChild(artwork);
    target.artworkEl = artwork;

    const info = doc.createElement('div');
    info.className = 'lpp-track-info';
    const title = doc.createElement('div');
    title.className = 'lpp-track-title';
    title.setAttribute('data-testid', 'pip-track-title');
    const artist = doc.createElement('div');
    artist.className = 'lpp-track-artist';
    info.appendChild(title);
    info.appendChild(artist);
    header.appendChild(info);
    target.titleEl = title;
    target.artistEl = artist;

    const controls = doc.createElement('div');
    controls.className = 'lpp-controls';
    const themeBtn = btn(doc, state.theme === 'dark' ? 'sun' : 'moon', 'Toggle theme', 'pip-theme-toggle', toggleTheme);
    target.themeBtn = themeBtn;
    controls.appendChild(themeBtn);
    const gearBtn = btn(doc, 'gear', 'Settings', 'pip-settings-toggle', () => {
      const panel = root.querySelector('.lpp-settings-panel');
      if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });
    controls.appendChild(gearBtn);
    header.appendChild(controls);

    root.appendChild(header);

    const settingsPanel = doc.createElement('div');
    settingsPanel.className = 'lpp-settings-panel';
    settingsPanel.style.display = 'none';
    const fontGroup = doc.createElement('div');
    fontGroup.className = 'lpp-setting-row';
    const fontLabel = doc.createElement('span');
    fontLabel.className = 'lpp-setting-label';
    fontLabel.textContent = 'Size';
    fontGroup.appendChild(fontLabel);
    fontGroup.appendChild(btn(doc, 'minus', 'Decrease font size', 'pip-font-minus', () => {
      state.fontSize = Math.max(10, state.fontSize - 2);
      saveSetting('fontSize', state.fontSize);
      applySettings();
    }));
    const fontVal = doc.createElement('span');
    fontVal.className = 'lpp-setting-value';
    fontVal.setAttribute('data-testid', 'pip-font-value');
    fontGroup.appendChild(fontVal);
    fontGroup.appendChild(btn(doc, 'plus', 'Increase font size', 'pip-font-plus', () => {
      state.fontSize = Math.min(48, state.fontSize + 2);
      saveSetting('fontSize', state.fontSize);
      applySettings();
    }));
    settingsPanel.appendChild(fontGroup);
    target.fontVal = fontVal;

    const alignGroup = doc.createElement('div');
    alignGroup.className = 'lpp-setting-row';
    const alignLabel = doc.createElement('span');
    alignLabel.className = 'lpp-setting-label';
    alignLabel.textContent = 'Align';
    alignGroup.appendChild(alignLabel);
    ['left', 'center', 'right'].forEach((a) => {
      const abtn = doc.createElement('button');
      abtn.className = 'lpp-btn lpp-align-btn' + (state.fontAlign === a ? ' lpp-align-active' : '');
      abtn.textContent = a[0].toUpperCase();
      abtn.title = 'Align ' + a;
      abtn.setAttribute('data-testid', 'pip-align-' + a);
      abtn.addEventListener('click', () => {
        state.fontAlign = a;
        saveSetting('fontAlign', state.fontAlign);
        applySettings();
        alignGroup.querySelectorAll('.lpp-align-btn').forEach((b) => b.classList.remove('lpp-align-active'));
        abtn.classList.add('lpp-align-active');
      });
      alignGroup.appendChild(abtn);
    });
    settingsPanel.appendChild(alignGroup);
    root.appendChild(settingsPanel);

    const body = doc.createElement('div');
    body.className = 'lpp-body';
    body.setAttribute('data-testid', 'pip-lyrics-container');
    root.appendChild(body);
    target.scroller = body;

    const mediaRow = doc.createElement('div');
    mediaRow.className = 'lpp-media-row';
    const prevBtn = btn(doc, 'prev', 'Previous track', 'pip-prev', prevTrack);
    mediaRow.appendChild(prevBtn);
    const playBtn = btn(doc, 'play', 'Play / Pause', 'pip-playpause', togglePlayback);
    mediaRow.appendChild(playBtn);
    target.playBtn = playBtn;
    const nextBtn = btn(doc, 'next', 'Next track', 'pip-next', nextTrack);
    mediaRow.appendChild(nextBtn);
    root.appendChild(mediaRow);

    const footer = doc.createElement('div');
    footer.className = 'lpp-footer';
    const offsetGroup = doc.createElement('div');
    offsetGroup.className = 'lpp-offset-group';
    offsetGroup.appendChild(btn(doc, 'minus', 'Lyrics earlier (-0.5s)', 'pip-offset-minus', () => adjustOffset(-0.5)));
    const offsetValue = doc.createElement('span');
    offsetValue.className = 'lpp-offset-value';
    offsetValue.textContent = '+0.0s';
    offsetValue.setAttribute('data-testid', 'pip-offset-value');
    offsetGroup.appendChild(offsetValue);
    offsetGroup.appendChild(btn(doc, 'plus', 'Lyrics later (+0.5s)', 'pip-offset-plus', () => adjustOffset(0.5)));
    footer.appendChild(offsetGroup);
    target.offsetEl = offsetValue;

    const source = doc.createElement('span');
    source.className = 'lpp-source';
    source.textContent = 'Lyrics \u00b7 LRCLIB';
    footer.appendChild(source);
    root.appendChild(footer);

    return target;
  }

  // ============================================================
  // Picture-in-Picture (Document PiP API)
  // ============================================================
  const PIP_CSS = `
    :root { --lpp-bg:#09090b; --lpp-bg-hover:#27272a; --lpp-text:#fafafa; --lpp-text-secondary:#a1a1aa;
      --lpp-muted:#52525b; --lpp-active:#fafafa; --lpp-inactive:#52525b; --lpp-border:rgba(250,250,250,0.12); }
    :root[data-lpp-theme='light'] { --lpp-bg:#f4f4f5; --lpp-bg-hover:#e4e4e7; --lpp-text:#09090b;
      --lpp-text-secondary:#71717a; --lpp-muted:#a1a1aa; --lpp-active:#09090b; --lpp-inactive:#a1a1aa;
      --lpp-border:rgba(9,9,11,0.12); }
    * { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body { font-family:'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; background:var(--lpp-bg);
      color:var(--lpp-text); display:flex; flex-direction:column; overflow:hidden;
      transition: background-color .3s ease, color .3s ease; }
    .lpp-header { display:flex; align-items:center; gap:10px; padding:10px 14px;
      border-bottom:1px solid var(--lpp-border); flex-shrink:0; }
    .lpp-artwork { width:32px; height:32px; border-radius:6px; object-fit:cover; background:var(--lpp-bg-hover); }
    .lpp-track-info { flex:1; min-width:0; }
    .lpp-track-title { font-size:13px; font-weight:700; letter-spacing:-0.01em; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; }
    .lpp-track-artist { font-size:11px; color:var(--lpp-text-secondary); white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; }
    .lpp-controls { display:flex; gap:2px; }
    .lpp-btn { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px;
      border:none; background:transparent; border-radius:6px; cursor:pointer; color:var(--lpp-text-secondary);
      transition: background-color .2s ease, color .2s ease; }
    .lpp-btn:hover { background:var(--lpp-bg-hover); color:var(--lpp-text); }
    .lpp-btn svg { width:15px; height:15px; stroke:currentColor; fill:none; stroke-width:2;
      stroke-linecap:round; stroke-linejoin:round; }
    .lpp-body { flex:1; overflow-y:auto; padding:0 20px; scroll-behavior:smooth;
      scroll-snap-type:y mandatory; scrollbar-width:thin; scrollbar-color:var(--lpp-muted) transparent; }
    .lpp-body::-webkit-scrollbar { width:4px; }
    .lpp-body::-webkit-scrollbar-thumb { background:var(--lpp-muted); border-radius:2px; }
    .lpp-line { font-size:var(--lpp-font-size, clamp(20px, 5.5vw, 22px)); font-weight:500; letter-spacing:-0.01em; line-height:1.4;
      padding:6px 0; color:var(--lpp-inactive); opacity:.75;
      transition: color .25s ease; transform-origin:left center;
      scroll-snap-align:center; }
    .lpp-line.lpp-active { color:var(--lpp-active); font-weight:800; transform:scale(1.04); opacity:1; transition: color .25s ease; }
    .lpp-line.lpp-near { opacity:.9; }
    .lpp-line.lpp-past { opacity:.4; }
    .lpp-body[data-align="center"] .lpp-line { text-align:center; transform-origin:center center; }
    .lpp-body[data-align="right"] .lpp-line { text-align:right; transform-origin:right center; }
    .lpp-plain { font-size:14px; color:var(--lpp-text-secondary); white-space:pre-wrap; line-height:1.7; }
    .lpp-status { display:flex; align-items:center; justify-content:center; height:100%; text-align:center;
      font-size:14px; color:var(--lpp-text-secondary); padding:0 16px; }
    .lpp-media-row { display:flex; align-items:center; justify-content:center; gap:2px;
      padding:2px 0; border-top:1px solid var(--lpp-border); flex-shrink:0; }
    .lpp-media-row .lpp-btn { width:32px; height:28px; }
    .lpp-media-row .lpp-btn svg { width:16px; height:16px; }
    .lpp-settings-panel { display:flex; flex-direction:column; gap:4px; padding:6px 14px;
      border-top:1px solid var(--lpp-border); flex-shrink:0; }
    .lpp-setting-row { display:flex; align-items:center; gap:6px; }
    .lpp-setting-label { font-size:10px; color:var(--lpp-text-secondary); min-width:32px;
      text-transform:uppercase; letter-spacing:.08em; }
    .lpp-setting-value { font-size:11px; color:var(--lpp-text); min-width:20px; text-align:center; }
    .lpp-align-btn { font-size:11px; font-weight:700; width:24px; height:22px !important; }
    .lpp-align-active { background:var(--lpp-bg-hover) !important; color:var(--lpp-text) !important; }
    .lpp-footer { display:flex; align-items:center; justify-content:space-between; padding:8px 14px;
      border-top:1px solid var(--lpp-border); flex-shrink:0; }
    .lpp-offset-group { display:flex; align-items:center; gap:4px; }
    .lpp-offset-value { font-size:11px; color:var(--lpp-text-secondary); min-width:44px; text-align:center;
      font-variant-numeric:tabular-nums; }
    .lpp-source { font-size:10px; text-transform:uppercase; letter-spacing:.14em; color:var(--lpp-muted); }
  `;

  async function openPip() {
    if (state.pipWin && !state.pipWin.closed) {
      try {
        state.pipWin.focus();
      } catch (_e) {
        /* noop */
      }
      return;
    }
    if (!('documentPictureInPicture' in window)) {
      toast('Picture-in-Picture lyrics need Chrome 116 or newer.');
      return;
    }
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 420, height: 340, title: 'LyricPiP' });
      state.pipWin = win;
      const doc = win.document;
      doc.title = 'LyricPiP';
      doc.documentElement.setAttribute('data-lpp-theme', state.theme);
      const style = doc.createElement('style');
      style.textContent = PIP_CSS;
      doc.head.appendChild(style);

      const target = buildChrome(doc, doc.body);
      targets.push(target);
      renderTarget(target);
      updateOffsetLabels();
      applySettings();
      setActiveLine(target, state.activeIdx, state.activeProgress, 'instant');
      startSyncLoop();

      win.addEventListener('pagehide', () => {
        const i = targets.indexOf(target);
        if (i >= 0) targets.splice(i, 1);
        state.pipWin = null;
      });
    } catch (err) {
      toast(`Could not open PiP: ${err.message}`);
    }
  }

  // ============================================================
  // Toast
  // ============================================================
  let toastEl = null;
  let toastTimer = null;

  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'lyricpip-toast';
      toastEl.setAttribute('data-testid', 'lyricpip-toast');
      Object.assign(toastEl.style, {
        all: 'initial', position: 'fixed', bottom: '24px', left: '50%',
        transform: 'translateX(-50%)', zIndex: '2147483647',
        fontFamily: "'Inter', system-ui, sans-serif", fontSize: '13px',
        fontWeight: '600', color: '#fafafa', background: '#18181b',
        border: '1px solid rgba(250,250,250,0.15)', borderRadius: '9999px',
        padding: '10px 20px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        opacity: '0', transition: 'opacity 0.3s ease', pointerEvents: 'none',
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 3000);
  }

  // ============================================================
  // Popup messaging
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    switch (msg.type) {
      case 'GET_STATE': {
        const synced = state.lyrics.synced;
        sendResponse({
          ok: true,
          platform: PLATFORM,
          meta: state.meta,
          lyricsStatus: state.lyrics.status,
          currentLine:
            state.lyrics.status === 'synced' && state.activeIdx >= 0 && synced[state.activeIdx]
              ? synced[state.activeIdx].text || '\u266a'
              : null,
          pipOpen: !!(state.pipWin && !state.pipWin.closed),
          offset: state.offset,
          theme: state.theme,
          fontSize: state.fontSize,
          fontAlign: state.fontAlign,
          debug: {
            activeIdx: state.activeIdx,
            activeProgress: state.activeProgress,
            currentTime: nowSeconds(),
            syncLoopRunning: syncIntervalId !== null,
          },
        });
        return false;
      }
      case 'SET_OFFSET': {
        adjustOffset(msg.delta || 0);
        sendResponse({ ok: true, offset: state.offset });
        return false;
      }
      case 'SET_FONT_SIZE': {
        state.fontSize = Math.max(10, Math.min(48, msg.value || 20));
        saveSetting('fontSize', state.fontSize);
        applySettings();
        sendResponse({ ok: true, fontSize: state.fontSize });
        return false;
      }
      case 'SET_FONT_ALIGN': {
        if (msg.value && ['left', 'center', 'right'].indexOf(msg.value) >= 0) {
          state.fontAlign = msg.value;
          saveSetting('fontAlign', state.fontAlign);
          applySettings();
        }
        sendResponse({ ok: true, fontAlign: state.fontAlign });
        return false;
      }
      case 'RESYNC': {
        onTrackChange();
        sendResponse({ ok: true });
        return false;
      }
      case 'TOGGLE_PIP': {
        (async function () {
          if (state.pipWin && !state.pipWin.closed) {
            state.pipWin.close();
            state.pipWin = null;
            sendResponse({ ok: true, action: 'closed' });
          } else {
            ensurePipButton();
            try {
              await openPip();
              sendResponse({ ok: true, action: 'opened' });
            } catch (_err) {
              if (pipBtn) {
                pipBtn.style.transform = 'scale(1.15)';
                pipBtn.style.opacity = '1';
                setTimeout(function () {
                  pipBtn.style.transform = 'scale(1)';
                  pipBtn.style.opacity = '0.6';
                }, 600);
              }
              sendResponse({ ok: true, action: 'blocked' });
            }
          }
        })();
        return true;
      }
      default:
        return false;
    }
  });

  // ============================================================
  // Keyboard shortcuts (page-wide)
  // ============================================================
  document.addEventListener('keydown', function (e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    switch (e.key.toLowerCase()) {
      case 'j':
        e.preventDefault();
        openPip();
        break;
      case 'd':
        e.preventDefault();
        toast('LyricPiP active');
        break;
    }
  });

  // ============================================================
  // DOM metadata fallback
  // ============================================================
  function detectDomMeta() {
    if (PLATFORM === 'youtube') {
      const titleEl = document.querySelector('h1 yt-formatted-string');
      const channelEl = document.querySelector('ytd-channel-name yt-formatted-string');
      if (titleEl && titleEl.textContent) {
        return { title: titleEl.textContent.trim(), artist: channelEl ? channelEl.textContent.trim() : '' };
      }
    } else if (PLATFORM === 'spotify') {
      const titleEl = document.querySelector('[data-testid="context-item-info-title"]');
      const artistEl = document.querySelector('[data-testid="context-item-info-artist"]');
      if (titleEl && titleEl.textContent) {
        return { title: titleEl.textContent.trim(), artist: artistEl ? artistEl.textContent.trim() : '' };
      }
    }
    return null;
  }

  setInterval(function () {
    if (Date.now() - state.lastMediaSessionAt < 5000) return;
    const domMeta = detectDomMeta();
    if (domMeta && domMeta.title && domMeta.title !== state.lastFetchTitle) {
      state.metaKey = domMeta.title + '|' + domMeta.artist;
      state.meta = domMeta;
      onTrackChange();
    }
  }, 2000);

  // ============================================================
  // Boot
  // ============================================================
  const bootInterval = setInterval(() => {
    if (document.body) {
      clearInterval(bootInterval);
      ensurePipButton();
    }
  }, 300);
})();
