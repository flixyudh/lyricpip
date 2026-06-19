import React from 'react';

function Feature({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="feature">
      <span className="feature-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export default function App() {
  return (
    <div className="page">
      <header className="hero">
        <div className="hero-badge">Chrome Extension</div>
        <h1>
          <span className="hero-brand">LyricPiP</span>
          <span className="hero-tagline">Synced Lyrics &amp; Picture-in-Picture</span>
        </h1>
        <p className="hero-desc">
          Karaoke-style lyrics for <strong>YouTube</strong> and <strong>Spotify Web</strong>,
           with an always-on-top PiP window. Powered by LRCLIB.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary" href="#install">Install</a>
          <a className="btn btn-secondary" href="https://github.com/flixyudh/lyricpip" target="_blank" rel="noopener noreferrer">Source</a>
        </div>
      </header>

      <section className="section features">
        <h2>Features</h2>
        <div className="features-grid">
          <Feature icon="🎤" title="Karaoke Sync">
            Auto-scrolling synced lyrics with the current line highlighted, driven by 100ms precision
            polling and playback-time interpolation.
          </Feature>
          <Feature icon="🪟" title="Picture-in-Picture">
            Pop lyrics into an always-on-top PiP window that stays visible across all tabs and apps
            (Chrome 116+, Document PiP API).
          </Feature>
           <Feature icon="🌗" title="Dark / Light Theme">
             Toggle between dark and light themes — synced across the popup and PiP
             window. Preference persisted in Chrome storage.
           </Feature>
           <Feature icon="🎯" title="Smart Track Matching">
             Cleans noisy YouTube titles ("Official Video", " [4K]", "ft. …") and tries multiple lookup
             strategies against LRCLIB with duration-based scoring.
           </Feature>
          <Feature icon="⏱" title="Sync Offset">
            Fine-tune lyric timing with ±0.5s steps when playback drifts from the LRC timestamps.
          </Feature>
           <Feature icon="📝" title="Plain Lyrics Fallback">
             When no synced LRC is available, displays plain lyrics with a scrollable view in PiP.
           </Feature>
           <Feature icon="⚡" title="Session Caching">
            Lookup results cached in memory and Chrome storage — duplicate queries return instantly.
          </Feature>
        </div>
      </section>

      <section className="section how-it-works">
        <h2>How It Works</h2>
        <div className="diagram">
          <div className="diagram-box">
            <div className="diagram-label">Page (YouTube / Spotify Web)</div>
            <div className="diagram-row">
              <div className="diagram-item">
                <strong>main-world.js</strong>
                 <span>reads mediaSession + video element → postMessage every 100ms</span>
              </div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-item">
                <strong>content.js</strong>
                 <span>track detection, floating PiP trigger button, PiP window with lyrics + controls, 100ms sync loop</span>
              </div>
            </div>
            <div className="diagram-arrow-down">↓ chrome.runtime.sendMessage</div>
            <div className="diagram-item diagram-item-wide">
              <strong>background.js</strong>
               <span>LRCLIB multi-strategy lookup with duration-based scoring &amp; caching</span>
            </div>
          </div>
        </div>
      </section>

      <section id="install" className="section install">
        <h2>Install</h2>

        <div className="install-download">
          <a className="btn btn-download" href="./extension.crx" download="lyricpip.crx">
            ⬇ Download .crx
          </a>
          <span className="install-download-note">
            Then drag the file into <code>chrome://extensions</code> with Developer mode enabled.
          </span>
        </div>

        <div className="install-or"><span>or</span></div>

        <ol>
          <li>Clone or <a href="https://github.com/flixyudh/lyricpip" target="_blank" rel="noopener noreferrer">download</a> this repository.</li>
          <li>Open Chrome and go to <code>chrome://extensions</code>.</li>
          <li>Enable <strong>Developer mode</strong> (top-right toggle).</li>
          <li>Click <strong>Load unpacked</strong> and select the <code>extension</code> folder.</li>
           <li>Open YouTube or Spotify Web, play a song — the floating PiP button appears.</li>
           <li>Press <kbd>J</kbd> or click the <strong>PiP button</strong> to open lyrics in an always-on-top window.</li>
        </ol>
        <p className="note">Requires Chrome 116+ (Document Picture-in-Picture API).<br/>The <code>.crx</code> is rebuilt on every push — always points at the latest commit.</p>
      </section>

      <section className="section permissions">
        <h2>Permissions</h2>
        <table>
          <thead>
            <tr><th>Permission</th><th>Why</th></tr>
          </thead>
          <tbody>
            <tr><td><code>storage</code></td><td>Persist theme, font size, alignment; cache lyrics</td></tr>
             <tr><td><code>https://lrclib.net/*</code></td><td>Fetch lyrics from LRCLIB</td></tr>
             <tr><td>Content scripts on <code>youtube.com</code> / <code>open.spotify.com</code></td><td>Detect tracks and render the PiP button</td></tr>
          </tbody>
        </table>
        <p className="note">No analytics, no tracking, no remote code, no unnecessary host access.</p>
      </section>

      <footer className="footer">
        <p>LyricPiP — MIT License</p>
        <p>Lyrics from <a href="https://lrclib.net" target="_blank" rel="noopener noreferrer">LRCLIB</a>.</p>
      </footer>
    </div>
  );
}
