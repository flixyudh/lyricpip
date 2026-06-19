/**
 * LyricPiP — LRC format parser (isolated world)
 * Parses standard LRC text into a sorted array of { time, text } lines.
 * Supports multiple timestamps per line: [00:12.34][00:45.67] lyric text
 */
(() => {
  let VER = '';
  try { VER = chrome.runtime.getManifest().version; } catch (_e) { /* chrome.runtime may be unavailable */ }
  if (VER && window.__lyricpipLrcVer === VER) return;
  window.__lyricpipLrcVer = VER || Date.now().toString();

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

  /** Binary search: index of the active line at time t (or -1 before first line). */
  function indexAt(lines, t) {
    if (!lines || lines.length === 0) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /**
   * Anticipatory active-line detection with transition progress.
   * Mirrors the sync logic in mantou132/spotify-lyrics canvas renderer:
   * the upcoming line becomes the "active" line animateDuration seconds
   * before its timestamp, with progress 0..1 reaching 1 at startTime.
   */
  function indexAtSmooth(lines, t, animateDuration) {
    const duration = typeof animateDuration === 'number' && animateDuration > 0
      ? animateDuration
      : 0;
    if (!lines || lines.length === 0) return { index: -1, progress: 1 };
    let currentIndex = -1;
    let progress = 1;
    for (let i = 0; i < lines.length; i++) {
      const startTime = lines[i].time;
      if (typeof startTime === 'number' && !Number.isNaN(startTime) && t > startTime - duration) {
        currentIndex = i;
        if (t < startTime) {
          progress = (t - startTime + duration) / duration;
        } else {
          progress = 1;
        }
      }
    }
    return { index: currentIndex, progress };
  }

  window.LyricPiPLRC = { parse, indexAt, indexAtSmooth };
})();
