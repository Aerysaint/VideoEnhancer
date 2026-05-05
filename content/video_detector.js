// content/video_detector.js
// Detects <video> elements on the current page, including:
//  - Videos already present in the DOM when the content script loads
//  - Videos dynamically injected by SPAs (Netflix, Crunchyroll, YouTube)
//  - New videos after SPA navigation (History API pushState / replaceState)
//
// Fires onVideoFound / onVideoLost / onNavigate callbacks.

export class VideoDetector {
  constructor({ onVideoFound, onVideoLost, onNavigate }) {
    this.onVideoFound = onVideoFound;
    this.onVideoLost  = onVideoLost;
    this.onNavigate   = onNavigate;

    this.currentVideo    = null;
    this.mutationObs     = null;
    this.pollInterval    = null;
    this.lastHref        = location.href;
  }

  start() {
    // ── 1. Check DOM immediately ──────────────────────────────────────────────
    this._scanForVideo();

    // ── 2. MutationObserver for dynamically inserted/removed video elements ──
    this.mutationObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const vid = node.matches?.('video') ? node : node.querySelector?.('video');
          if (vid) { this._handleFound(vid); return; }
        }
        for (const node of m.removedNodes) {
          if (node === this.currentVideo || node.contains?.(this.currentVideo)) {
            this._handleLost();
          }
        }
      }
    });
    this.mutationObs.observe(document.documentElement, { childList: true, subtree: true });

    // ── 3. SPA navigation detection ───────────────────────────────────────────
    // Netflix and Crunchyroll both use History API for routing.
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);

    history.pushState = (...args) => {
      origPush(...args);
      this._handleNavigate();
    };
    history.replaceState = (...args) => {
      origReplace(...args);
      this._handleNavigate();
    };
    window.addEventListener('popstate', () => this._handleNavigate());

    // ── 4. Polling fallback ────────────────────────────────────────────────────
    // Catches edge cases the MutationObserver may miss and acts as a
    // heartbeat to re-acquire video after SPA navigation.
    this.pollInterval = setInterval(() => {
      if (location.href !== this.lastHref) {
        this.lastHref = location.href;
        this._handleNavigate();
      }
      if (!this.currentVideo || !document.contains(this.currentVideo)) {
        this._scanForVideo();
      }
    }, 1000);
  }

  stop() {
    this.mutationObs?.disconnect();
    clearInterval(this.pollInterval);
  }

  // ── Video selection ────────────────────────────────────────────────────────

  _scanForVideo() {
    const candidates = Array.from(document.querySelectorAll('video'))
      .filter(v => !v.dataset.enhancerCanvas &&   // never our own analysis canvas
                    v.offsetWidth  >= 400 &&        // exclude tiny preview thumbnails
                    v.offsetHeight >= 250);

    if (candidates.length === 0) return;

    // Prefer videos that are actively playing; fall back to the largest.
    const playing = candidates.find(v => !v.paused && !v.ended && v.readyState >= 2);
    const best    = playing || candidates.reduce((a, b) =>
      a.offsetWidth * a.offsetHeight >= b.offsetWidth * b.offsetHeight ? a : b
    );

    if (best !== this.currentVideo) {
      this._handleFound(best);
    }
  }

  _handleFound(video) {
    // Ignore tiny preview videos (Netflix shows hover-preview at ~160×90).
    if (video.offsetWidth < 200 || video.offsetHeight < 120) return;
    // Ignore our own injected canvases (shouldn't be a <video>, but belt-and-braces).
    if (video.dataset.enhancerCanvas) return;

    if (video !== this.currentVideo) {
      this.currentVideo = video;
      this.onVideoFound(video);
    }
  }

  _handleLost() {
    if (this.currentVideo) {
      this.currentVideo = null;
      this.onVideoLost();
    }
  }

  _handleNavigate() {
    const href = location.href;
    if (href !== this.lastHref) {
      this.lastHref = href;
    }
    // Give the SPA ~500 ms to render the new page before we scan.
    setTimeout(() => {
      this.currentVideo = null; // Force state reset so YouTube/Crunchyroll reusing the same video element retriggers initialization
      this.onNavigate(location.href);
      this._scanForVideo();
    }, 500);
  }
}
