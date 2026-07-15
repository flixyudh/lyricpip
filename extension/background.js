/**
 * Flyrics — background service worker
 * Fetches lyrics from LRCLIB (https://lrclib.net) with a multi-strategy
 * lookup (exact get -> search by track+artist -> free-text search) and
 * caches results in memory + chrome.storage.session.
 */

const LRCLIB = 'https://lrclib.net/api';
const CLIENT_HEADER = { 'Lrclib-Client': 'Flyrics v1.1.7 (Chrome Extension)' };

const memCache = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'FETCH_LYRICS') {
    fetchLyrics(msg)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // async response
  }
  return false;
});

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKey(queries, duration) {
  const q = queries[0] || {};
  const bucket = duration ? Math.round(duration / 5) * 5 : 0;
  return `${norm(q.artist)}|${norm(q.track)}|${bucket}`;
}

async function getSessionCache(key) {
  try {
    const data = await chrome.storage.session.get(key);
    return data[key] || null;
  } catch (_e) {
    return null;
  }
}

async function setSessionCache(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (_e) {
    /* session storage may be unavailable; mem cache still works */
  }
}

async function lrcGet(path, params) {
  const url = new URL(`${LRCLIB}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), { headers: CLIENT_HEADER });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

function scoreCandidate(c, duration, artist) {
  let s = 0;
  if (c.syncedLyrics) s += 10;
  if (duration && c.duration && Math.abs(c.duration - duration) <= 7) s += 4;
  if (artist) {
    const a = norm(artist.split(',')[0]);
    const ca = norm(c.artistName);
    if (a && ca && (ca.includes(a) || a.includes(ca))) s += 2;
  }
  if (c.plainLyrics) s += 1;
  if (c.instrumental) s -= 2;
  return s;
}

function pickBest(list, duration, artist) {
  if (!Array.isArray(list) || list.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const c of list) {
    const s = scoreCandidate(c, duration, artist);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (!best) return null;
  return best.syncedLyrics || best.plainLyrics || best.instrumental ? best : null;
}

function toResult(c) {
  if (!c) return null;
  return {
    trackName: c.trackName || '',
    artistName: c.artistName || '',
    albumName: c.albumName || '',
    duration: c.duration || null,
    instrumental: !!c.instrumental,
    syncedLyrics: c.syncedLyrics || null,
    plainLyrics: c.plainLyrics || null,
  };
}

async function fetchLyrics({ queries, duration }) {
  const validQueries = (queries || []).filter((q) => q && q.track);
  if (validQueries.length === 0) return null;

  const key = cacheKey(validQueries, duration);
  if (memCache.has(key)) return memCache.get(key);
  const cached = await getSessionCache(key);
  if (cached) {
    memCache.set(key, cached);
    return cached;
  }

  let result = null;

  // Strategy 1: exact signature match (/api/get)
  for (const q of validQueries) {
    if (!q.artist || !duration) continue;
    try {
      const c = await lrcGet('/get', {
        track_name: q.track,
        artist_name: q.artist,
        album_name: q.album || undefined,
        duration: Math.round(duration),
      });
      if (c && (c.syncedLyrics || c.plainLyrics || c.instrumental)) {
        result = toResult(c);
        break;
      }
    } catch (_e) {
      /* try next strategy */
    }
  }

  // Strategy 2: structured search (/api/search?track_name=&artist_name=)
  if (!result) {
    for (const q of validQueries) {
      try {
        const list = await lrcGet('/search', {
          track_name: q.track,
          artist_name: q.artist || undefined,
        });
        const best = pickBest(list, duration, q.artist);
        if (best) {
          result = toResult(best);
          break;
        }
      } catch (_e) {
        /* try next */
      }
    }
  }

  // Strategy 3: free-text search (/api/search?q=)
  if (!result) {
    for (const q of validQueries) {
      try {
        const text = q.artist ? `${q.artist} ${q.track}` : q.track;
        const list = await lrcGet('/search', { q: text });
        const best = pickBest(list, duration, q.artist);
        if (best) {
          result = toResult(best);
          break;
        }
      } catch (_e) {
        /* give up on this variant */
      }
    }
  }

  memCache.set(key, result);
  if (memCache.size > 200) {
    memCache.delete(memCache.keys().next().value);
  }
  await setSessionCache(key, result);
  return result;
}
