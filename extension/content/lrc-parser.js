/**
 * Flyrics — LRC format parser (isolated world)
 * Parses standard LRC text into a sorted array of { time, text } lines.
 * Supports multiple timestamps per line: [00:12.34][00:45.67] lyric text
 */
(() => {
  let VER = '';
  try { VER = chrome.runtime.getManifest().version; } catch (_e) { /* chrome.runtime may be unavailable */ }
  if (VER && window.__flyricsLrcVer === VER) return;
  window.__flyricsLrcVer = VER || Date.now().toString();

  const TIME_TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  function parse(lrcText) {
    if (!lrcText || typeof lrcText !== 'string') return null;
    const lines = [];
    for (const raw of lrcText.split(/\r?\n/)) {
      TIME_TAG.lastIndex = 0;
      const stamps = [];
      let match;
      let lastEnd = 0;
      while ((match = TIME_TAG.exec(raw)) !== null) {
        const min = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        const fracRaw = match[3] || '0';
        const frac = parseInt(fracRaw, 10) / Math.pow(10, fracRaw.length);
        stamps.push(min * 60 + sec + frac);
        lastEnd = TIME_TAG.lastIndex;
      }
      if (stamps.length === 0) continue;
      const text = raw.slice(lastEnd).trim();
      for (const t of stamps) {
        lines.push({ time: t, text });
      }
    }
    if (lines.length === 0) return null;
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  /**
   * Anticipatory active-line detection with transition progress.
   * Uses binary search (O(log n)) to find the current line, then checks the
   * next line for anticipation — the upcoming line becomes "active"
   * animateDuration seconds before its timestamp, with progress 0..1.
   */
  function indexAtSmooth(lines, t, animateDuration) {
    if (!lines || lines.length === 0) return { index: -1, progress: 1 };
    const dur = animateDuration > 0 ? animateDuration : 0;

    // Binary search for the last line whose time <= t.
    let idx = -1;
    let lo = 0, hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) { idx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }

    // Check if the next line is within the anticipation window.
    if (dur > 0) {
      const nextIdx = idx + 1;
      if (nextIdx < lines.length && t > lines[nextIdx].time - dur) {
        if (t < lines[nextIdx].time) {
          return { index: nextIdx, progress: (t - lines[nextIdx].time + dur) / dur };
        }
        return { index: nextIdx, progress: 1 };
      }
    }

    return { index: idx, progress: 1 };
  }

  window.FlyricsLRC = { parse, indexAtSmooth };
})();
