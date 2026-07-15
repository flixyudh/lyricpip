/* Flyrics — MAIN-world media snapshot
 * Runs as a MAIN-world content script to access navigator.mediaSession.
 * Always restarts its interval on injection — clears any stale one from
 * a prior extension version that persisted in the MAIN world's global scope.
 */
(function () {
  if (window.__flyricsMainInterval) {
    clearInterval(window.__flyricsMainInterval);
    window.__flyricsMainInterval = null;
  }
  if (window.__flyricsMainRafId) {
    cancelAnimationFrame(window.__flyricsMainRafId);
    window.__flyricsMainRafId = null;
  }

  function findActiveMedia() {
    var els = document.querySelectorAll('video, audio');
    var best = null, bestDur = 0;
    var fallback = null;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.duration || Number.isNaN(el.duration) || !Number.isFinite(el.duration)) continue;
      if (!el.paused && el.currentTime > 0) {
        if (el.duration > bestDur) { best = el; bestDur = el.duration; }
      }
      if (!fallback && el.currentTime > 0) fallback = el;
    }
    return best || fallback;
  }

  function snapshot() {
    var meta = null;
    try {
      var m = navigator.mediaSession && navigator.mediaSession.metadata;
      if (m && m.title) {
        meta = {
          title: m.title || '',
          artist: m.artist || '',
          album: m.album || '',
          artwork: (m.artwork && m.artwork.length && m.artwork[m.artwork.length - 1].src) || null,
        };
      }
    } catch (_e) {
      meta = null;
    }

    var el = findActiveMedia();
    return {
      meta: meta,
      currentTime: el ? el.currentTime : null,
      duration: el && Number.isFinite(el.duration) ? el.duration : null,
      paused: el ? el.paused : true,
      playbackRate: el ? el.playbackRate || 1 : 1,
    };
  }

  function postSnapshot() {
    try {
      window.postMessage({ source: 'flyrics-main', type: 'MEDIA_STATE', payload: snapshot() }, '*');
    } catch (_e) {
      /* page may be unloading */
    }
  }

  window.__lyricpipMainInterval = setInterval(postSnapshot, 100);

  // Push immediate updates on playback changes so the lyric sync reacts instantly.
  var MEDIA_EVENTS = ['timeupdate', 'play', 'pause', 'seeked', 'ratechange'];
  for (var k = 0; k < MEDIA_EVENTS.length; k++) {
    document.addEventListener(MEDIA_EVENTS[k], postSnapshot, true);
  }

  // Feed the content script's rAF sync loop with fresh currentTime every frame
  // while media is playing (mirrors direct audio.currentTime reads).
  function rafLoop() {
    var el = findActiveMedia();
    if (el && !el.paused) postSnapshot();
    window.__lyricpipMainRafId = requestAnimationFrame(rafLoop);
  }
  window.__lyricpipMainRafId = requestAnimationFrame(rafLoop);
})();
