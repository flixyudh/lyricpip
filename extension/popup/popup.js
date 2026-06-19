(function () {
'use strict';

var SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
var MOON = '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';

var els = {
  themeToggle: document.getElementById('theme-toggle'),
  unsupported: document.getElementById('unsupported'),
  trackPanel: document.getElementById('track-panel'),
  artwork: document.getElementById('artwork'),
  trackTitle: document.getElementById('track-title'),
  trackArtist: document.getElementById('track-artist'),
  statusBadge: document.getElementById('status-badge'),
  platformBadge: document.getElementById('platform-badge'),
  currentLine: document.getElementById('current-line'),
  offsetMinus: document.getElementById('offset-minus'),
  offsetPlus: document.getElementById('offset-plus'),
  offsetValue: document.getElementById('offset-value'),
  debugSection: document.getElementById('debug-section'),
  debugToggle: document.getElementById('debug-toggle'),
  debugContent: document.getElementById('debug-content'),
  debugTabId: document.getElementById('debug-tab-id'),
  debugMessage: document.getElementById('debug-message'),
  debugLastError: document.getElementById('debug-last-error'),
  debugResponse: document.getElementById('debug-response'),
  debugRetry: document.getElementById('debug-retry'),
  debugInject: document.getElementById('debug-inject'),
  settingsGear: document.getElementById('settings-gear'),
  settingsPopover: document.getElementById('settings-popover'),
  fontSizeMinus: document.getElementById('font-size-minus'),
  fontSizePlus: document.getElementById('font-size-plus'),
  fontSizeValue: document.getElementById('font-size-value'),
  alignBtns: document.querySelectorAll('.align-btn'),
};

var activeTabId = null;
var theme = 'dark';

var STATUS_LABELS = {
  idle: 'Waiting',
  loading: 'Searching\u2026',
  synced: 'Synced lyrics',
  plain: 'Plain lyrics',
  instrumental: 'Instrumental',
  notfound: 'No lyrics',
  error: 'Service error',
};

function applyTheme(t) {
  theme = t;
  document.body.setAttribute('data-lpp-theme', t);
  els.themeToggle.innerHTML = t === 'dark' ? SUN : MOON;
}

chrome.storage.sync.get({ theme: 'dark' }, function (cfg) { applyTheme(cfg.theme); });

els.themeToggle.addEventListener('click', function () {
  var next = theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  chrome.storage.sync.set({ theme: next });
});

function sendToTab(message) {
  return new Promise(function (resolve) {
    if (activeTabId === null) return resolve(null);
    chrome.tabs.sendMessage(activeTabId, message, function (resp) {
      if (chrome.runtime.lastError) {
        return resolve(null);
      }
      resolve(resp || null);
    });
  });
}

function setDebug(field, value) {
  switch (field) {
    case 'tabId': els.debugTabId.textContent = value; break;
    case 'message': els.debugMessage.textContent = value; break;
    case 'lastError': els.debugLastError.textContent = value; break;
    case 'response': els.debugResponse.textContent = value; break;
  }
}

function showUnsupported() {
  els.unsupported.classList.remove('hidden');
  els.trackPanel.classList.add('hidden');
}

var _prevStateKey = '';

function renderState(s) {
  els.unsupported.classList.add('hidden');
  els.trackPanel.classList.remove('hidden');

  if (s.meta && s.meta.title) {
    els.trackTitle.textContent = s.meta.title;
    els.trackArtist.textContent = s.meta.artist || '';
  } else {
    els.trackTitle.textContent = 'Waiting for track info\u2026';
    els.trackArtist.textContent = 'The main-world script is connecting';
  }
  if (s.meta && s.meta.artwork) {
    els.artwork.src = s.meta.artwork;
    els.artwork.style.display = '';
  } else {
    els.artwork.style.display = 'none';
  }

  var newKey = (s.meta ? s.meta.title + '|' + s.meta.artist + '|' : '') + s.lyricsStatus + '|' + s.currentLine;
  if (newKey !== _prevStateKey) {
    console.debug('[LyricPiP:popup] state: ' + s.lyricsStatus + ' platform=' + s.platform + ' line=' + (s.currentLine ? s.currentLine.slice(0, 30) : 'null'));
    _prevStateKey = newKey;
  }

  els.statusBadge.textContent = STATUS_LABELS[s.lyricsStatus] || s.lyricsStatus;
  els.platformBadge.textContent = s.platform === 'spotify' ? 'Spotify Web' : 'YouTube';

  if (s.currentLine) {
    els.currentLine.textContent = s.currentLine;
    els.currentLine.classList.remove('hidden');
  } else {
    els.currentLine.classList.add('hidden');
  }

  var off = typeof s.offset === 'number' ? s.offset : 0;
  els.offsetValue.textContent = (off >= 0 ? '+' : '') + off.toFixed(1) + 's';
}

var _settings = { fontSize: 20, fontAlign: 'center' };

function renderSettings(s) {
  if (!s) return;
  _settings = { fontSize: s.fontSize || 20, fontAlign: s.fontAlign || 'center' };
  els.fontSizeValue.textContent = _settings.fontSize;
  els.alignBtns.forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-align') === _settings.fontAlign);
  });
}

// Gear toggle
els.settingsGear.addEventListener('click', function (e) {
  e.stopPropagation();
  els.settingsPopover.classList.toggle('hidden');
});

document.addEventListener('click', function () {
  els.settingsPopover.classList.add('hidden');
});

els.settingsPopover.addEventListener('click', function (e) {
  e.stopPropagation();
});

function injectContentScript() {
  if (activeTabId === null) return;
  console.debug('[LyricPiP:popup] injecting content scripts into tab ' + activeTabId);
  setDebug('message', 'injecting...');
  Promise.all([
    chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['content/lrc-parser.js', 'content/content.js'],
    }),
    chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['content/main-world.js'],
      world: 'MAIN',
    }),
  ]).then(function () {
    console.debug('[LyricPiP:popup] injection ok');
    setDebug('message', 'injection ok');
    setTimeout(refresh, 500);
  }).catch(function (err) {
    console.warn('[LyricPiP:popup] injection failed:', err.message);
    setDebug('lastError', 'inject: ' + err.message);
  });
}

var _refreshInterval = null;

function refresh() {
  sendToTab({ type: 'GET_STATE' }).then(function (state) {
    if (!state || !state.ok) {
      showUnsupported();
      return;
    }
    renderState(state);
    renderSettings(state);
  });
}

els.offsetMinus.addEventListener('click', async function () {
  await sendToTab({ type: 'SET_OFFSET', delta: -0.5 });
  refresh();
});

els.offsetPlus.addEventListener('click', async function () {
  await sendToTab({ type: 'SET_OFFSET', delta: 0.5 });
  refresh();
});

els.debugToggle.addEventListener('click', function () {
  els.debugSection.classList.remove('hidden');
  var hidden = els.debugContent.classList.toggle('hidden');
  els.debugToggle.textContent = hidden ? '\u2699 Debug' : '\u2699 Hide debug';
});

els.debugRetry.addEventListener('click', function () {
  setDebug('lastError', '\u2014');
  setDebug('response', '\u2014');
  refresh();
});

els.debugInject.addEventListener('click', function () {
  injectContentScript();
});

// Font size
els.fontSizeMinus.addEventListener('click', function () {
  var v = Math.max(10, _settings.fontSize - 1);
  sendToTab({ type: 'SET_FONT_SIZE', value: v }).then(function (r) {
    if (r && r.ok) {
      _settings.fontSize = r.fontSize;
      els.fontSizeValue.textContent = r.fontSize;
    }
  });
});

els.fontSizePlus.addEventListener('click', function () {
  var v = Math.min(48, _settings.fontSize + 1);
  sendToTab({ type: 'SET_FONT_SIZE', value: v }).then(function (r) {
    if (r && r.ok) {
      _settings.fontSize = r.fontSize;
      els.fontSizeValue.textContent = r.fontSize;
    }
  });
});

// Alignment
els.alignBtns.forEach(function (btn) {
  btn.addEventListener('click', function () {
    var align = btn.getAttribute('data-align');
    sendToTab({ type: 'SET_FONT_ALIGN', value: align }).then(function (r) {
      if (r && r.ok) {
        _settings.fontAlign = r.fontAlign;
        els.alignBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-align') === r.fontAlign); });
      }
    });
  });
});

// Resync
document.getElementById('resync-btn').addEventListener('click', function () {
  sendToTab({ type: 'RESYNC' });
  refresh();
});

document.addEventListener('keydown', function (e) {
  if (e.key.toLowerCase() === 'd') {
    e.preventDefault();
    els.debugSection.classList.toggle('hidden');
    if (els.debugContent.classList.contains('hidden')) {
      els.debugContent.classList.remove('hidden');
      els.debugToggle.textContent = '\u2699 Hide debug';
    }
  }
});

function boot() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab) {
      console.warn('[LyricPiP:popup] no active tab found');
      showUnsupported();
      setDebug('tabId', 'none');
      return;
    }
    activeTabId = tab.id;
    setDebug('tabId', String(tab.id));
    console.debug('[LyricPiP:popup] boot tab=' + tab.id);

    // Try GET_STATE immediately, then retry with injection if needed
    sendToTab({ type: 'GET_STATE' }).then(function firstTry(state) {
      if (state && state.ok) {
        renderState(state);
        renderSettings(state);
        startPolling();
        return;
      }
      showUnsupported();
      setDebug('lastError', 'content script unresponsive');
      console.debug('[LyricPiP:popup] first GET_STATE failed, trying injection...');
      setDebug('message', 'first fail, injecting...');
      injectContentScript();
      // After injection attempt, wait and retry once more
      setTimeout(function () {
        sendToTab({ type: 'GET_STATE' }).then(function secondTry(s2) {
          if (s2 && s2.ok) {
            console.debug('[LyricPiP:popup] injection recovery worked');
            renderState(s2);
            renderSettings(s2);
            startPolling();
          } else {
            console.debug('[LyricPiP:popup] injection recovery failed, showing unsupported');
            setDebug('message', 'injection did not help');
          }
        });
      }, 1500);
    });
  });
}

function startPolling() {
  if (_refreshInterval) return;
  _refreshInterval = setInterval(refresh, 2000);
}

boot();

})();
