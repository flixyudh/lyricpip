#!/usr/bin/env node
/**
 * Node-based unit tests for Flyrics extension logic:
 *   - LRC parser (lrc-parser.js)
 *   - cleanTitle regex extracted from content.js
 *   - pickBest/scoreCandidate from background.js
 *   - Live LRCLIB endpoints
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
const fails = [];

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log(`PASS  ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`FAIL  ${name}\n      ${e.message}`);
      failed++;
      fails.push({ name, err: e.message });
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---------- Load LRC parser in a sandboxed window ----------
function loadParser() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'lrc-parser.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.FlyricsLRC;
}

// ---------- Load cleanTitle + cleanArtist by extracting from content.js ----------
function loadCleanTitle() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'content.js'), 'utf8');
  // Slice between NOISE_RE declaration and buildQueries definition.
  const startIdx = src.indexOf('const NOISE_RE');
  const endIdx = src.indexOf('function buildQueries');
  if (startIdx < 0 || endIdx < 0) throw new Error('Could not locate cleanTitle in content.js');
  const snippet = src.slice(startIdx, endIdx);
  const wrapper = `${snippet}; module.exports = { cleanTitle, cleanArtist };`;
  const m = { exports: {} };
  vm.runInNewContext(wrapper, { module: m, exports: m.exports });
  return m.exports;
}

// ---------- Load scoreCandidate + pickBest from background.js ----------
function loadBackgroundFns() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  // We need: norm, scoreCandidate, pickBest. Extract by slicing function blocks.
  const need = ['function norm', 'function scoreCandidate', 'function pickBest'];
  let snippet = '';
  for (const tag of need) {
    const i = src.indexOf(tag);
    assert(i >= 0, `missing ${tag}`);
    // find matching closing brace
    let depth = 0;
    let j = i;
    let started = false;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; if (started && depth === 0) { j++; break; } }
      j++;
    }
    snippet += src.slice(i, j) + '\n';
  }
  const wrapper = `${snippet}; module.exports = { norm, scoreCandidate, pickBest };`;
  const m = { exports: {} };
  vm.runInNewContext(wrapper, { module: m, exports: m.exports });
  return m.exports;
}

(async () => {
  const LRC = loadParser();
  const { cleanTitle, cleanArtist } = loadCleanTitle();
  const { pickBest, scoreCandidate } = loadBackgroundFns();

  // ===== LRC parser =====
  await test('parse: basic timestamped line', () => {
    const lines = LRC.parse('[00:12.34]Hello world');
    eq(lines.length, 1);
    eq(lines[0].text, 'Hello world');
    assert(Math.abs(lines[0].time - 12.34) < 0.001, `time was ${lines[0].time}`);
  });

  await test('parse: multi-timestamp line expands', () => {
    const lines = LRC.parse('[00:01.00][00:05.00]Same lyric');
    eq(lines.length, 2);
    eq(lines[0].text, 'Same lyric');
    eq(lines[1].text, 'Same lyric');
    assert(lines[0].time < lines[1].time);
  });

  await test('parse: ignores lines without timestamp + sorts', () => {
    const lines = LRC.parse('[ti:Title]\n[00:10.00]Second\n[00:05.00]First\n');
    eq(lines.length, 2);
    eq(lines[0].text, 'First');
    eq(lines[1].text, 'Second');
  });

  await test('parse: empty/null returns null', () => {
    eq(LRC.parse(''), null);
    eq(LRC.parse(null), null);
    eq(LRC.parse('no lyrics here'), null);
  });

  await test('indexAtSmooth: binary search returns active line with no anticipation', () => {
    const lines = LRC.parse('[00:01.00]A\n[00:05.00]B\n[00:10.00]C');
    eq(LRC.indexAtSmooth(lines, 0, 0).index, -1);
    eq(LRC.indexAtSmooth(lines, 1.0, 0).index, 0);
    eq(LRC.indexAtSmooth(lines, 4.99, 0).index, 0);
    eq(LRC.indexAtSmooth(lines, 5.0, 0).index, 1);
    eq(LRC.indexAtSmooth(lines, 99, 0).index, 2);
  });

  await test('indexAtSmooth: anticipatory active line with progress', () => {
    const lines = LRC.parse('[00:01.00]A\n[00:05.00]B\n[00:10.00]C');
    const r1 = LRC.indexAtSmooth(lines, 0, 0.3);
    eq(r1.index, -1);
    eq(r1.progress, 1);
    const r2 = LRC.indexAtSmooth(lines, 0.85, 0.3);
    eq(r2.index, 0);
    assert(Math.abs(r2.progress - 0.5) < 0.001, 'progress was ' + r2.progress);
    const r3 = LRC.indexAtSmooth(lines, 1.0, 0.3);
    eq(r3.index, 0);
    eq(r3.progress, 1);
    const r4 = LRC.indexAtSmooth(lines, 4.85, 0.3);
    eq(r4.index, 1);
    assert(Math.abs(r4.progress - 0.5) < 0.001, 'progress was ' + r4.progress);
    const r5 = LRC.indexAtSmooth(lines, 5.0, 0.3);
    eq(r5.index, 1);
    eq(r5.progress, 1);
    const r6 = LRC.indexAtSmooth(lines, 99, 0.3);
    eq(r6.index, 2);
    eq(r6.progress, 1);
  });

  await test('indexAtSmooth: empty array returns -1', () => {
    const r = LRC.indexAtSmooth([], 5, 0.3);
    eq(r.index, -1);
    eq(r.progress, 1);
  });

  await test('indexAtSmooth: single line', () => {
    const lines = LRC.parse('[00:05.00]Only');
    eq(LRC.indexAtSmooth(lines, 4.8, 0.5).index, 0);
    eq(LRC.indexAtSmooth(lines, 6, 0.3).index, 0);
  });

  await test('indexAtSmooth: all lines in past', () => {
    const lines = LRC.parse('[00:01.00]A\n[00:02.00]B');
    const r = LRC.indexAtSmooth(lines, 10, 0.3);
    eq(r.index, 1);
    eq(r.progress, 1);
  });

  await test('indexAtSmooth: zero anticipation disables progress', () => {
    const lines = LRC.parse('[00:01.00]A\n[00:05.00]B');
    const r = LRC.indexAtSmooth(lines, 4.85, 0);
    eq(r.index, 0);
    eq(r.progress, 1);
  });

  // ===== cleanTitle =====
  await test('cleanTitle: removes Official Video / 4K noise', () => {
    eq(cleanTitle('Coldplay - Yellow (Official Video) [4K]'), 'Coldplay - Yellow');
  });
  await test('cleanTitle: strips lyrics video brackets', () => {
    eq(cleanTitle('Imagine Dragons - Believer (Lyric Video)'), 'Imagine Dragons - Believer');
  });
  await test('cleanTitle: removes feat/ft suffix', () => {
    const out = cleanTitle('Artist - Song ft. SomeoneElse');
    eq(out, 'Artist - Song');
  });
  await test('cleanTitle: pipe-separated noise', () => {
    const out = cleanTitle('Some Song | Official Video');
    eq(out.trim(), 'Some Song');
  });
  await test('cleanArtist: strips - Topic suffix', () => {
    eq(cleanArtist('Coldplay - Topic'), 'Coldplay');
    eq(cleanArtist('ArtistVEVO'), 'Artist');
  });

  // ===== pickBest scoring =====
  await test('pickBest: prefers syncedLyrics over plainLyrics', () => {
    const list = [
      { trackName: 'A', artistName: 'X', plainLyrics: 'plain', duration: 200 },
      { trackName: 'A', artistName: 'X', syncedLyrics: '[00:01.00]hi', duration: 200 },
    ];
    const best = pickBest(list, 200, 'X');
    assert(best && best.syncedLyrics, 'expected synced winner');
  });
  await test('pickBest: returns null on empty', () => {
    eq(pickBest([], 100, 'x'), null);
    eq(pickBest(null, 100, 'x'), null);
  });
  await test('scoreCandidate: duration proximity boost', () => {
    const cMatch = { syncedLyrics: 's', duration: 200, artistName: 'X' };
    const cFar = { syncedLyrics: 's', duration: 400, artistName: 'X' };
    assert(scoreCandidate(cMatch, 200, 'X') > scoreCandidate(cFar, 200, 'X'));
  });

  // ===== LRCLIB live endpoints =====
  const UA = { 'Lrclib-Client': 'Flyrics v1.1.7 (Chrome Extension)' };
  await test('LRCLIB /api/get returns syncedLyrics for Coldplay - Yellow', async () => {
    const url = 'https://lrclib.net/api/get?track_name=Yellow&artist_name=Coldplay&album_name=Parachutes&duration=269';
    const res = await fetch(url, { headers: UA });
    assert(res.ok, `HTTP ${res.status}`);
    const data = await res.json();
    assert(data && (data.syncedLyrics || data.plainLyrics), 'no lyrics in response');
    assert(typeof data.syncedLyrics === 'string' && data.syncedLyrics.length > 100, 'synced lyrics missing/too short');
    // Make sure it parses
    const lines = LRC.parse(data.syncedLyrics);
    assert(lines && lines.length > 5, 'parser failed on real LRCLIB synced lyrics');
  });

  await test('LRCLIB /api/search returns candidates + pickBest picks synced', async () => {
    const url = 'https://lrclib.net/api/search?track_name=Yellow&artist_name=Coldplay';
    const res = await fetch(url, { headers: UA });
    assert(res.ok, `HTTP ${res.status}`);
    const list = await res.json();
    assert(Array.isArray(list) && list.length > 0, 'no candidates');
    const best = pickBest(list, 269, 'Coldplay');
    assert(best, 'pickBest returned null');
    assert(best.syncedLyrics, 'best candidate has no syncedLyrics');
  });

  await test('Landing page download endpoint returns valid zip', async () => {
    const url = (process.env.REACT_APP_BACKEND_URL || 'https://music-lyrics-viewer.preview.emergentagent.com').replace(/\/$/, '') + '/lyricpip-extension.zip';
    const res = await fetch(url);
    assert(res.ok, `HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf.length > 5000, `zip too small: ${buf.length}`);
    // PK zip magic
    assert(buf[0] === 0x50 && buf[1] === 0x4b, 'not a valid zip file (PK header missing)');
  });

  console.log(`\n----\nPASSED ${passed}   FAILED ${failed}`);
  if (failed > 0) {
    console.log('Failures:');
    fails.forEach((f) => console.log(`  - ${f.name}: ${f.err}`));
    process.exit(1);
  }
})();
