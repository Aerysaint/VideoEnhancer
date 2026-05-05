// content/content.js
// Orchestrator — entry point bundled by esbuild into dist/content.bundle.js.
// Wires VideoDetector → WebGLRenderer + FrameAnalyzer + ProfileEngine together,
// and handles messages from the popup.

import { VideoDetector } from './video_detector.js';
import { FrameAnalyzer  } from './frame_analyzer.js';
import { ProfileEngine  } from './profile_engine.js';
import { WebGLRenderer  } from '../webgl/renderer.js';

// ── Content title scraping ─────────────────────────────────────────────────
// Returns a stable human-readable title for keying profiles in storage.
// Tries platform-specific selectors before falling back to document.title.

function scrapeTitle() {
  const host = location.hostname;

  // ── Netflix ────────────────────────────────────────────────────────────────
  if (host.includes('netflix.com')) {
    const main = document.querySelector('[data-uia="video-title"] .main-title')
              || document.querySelector('[data-uia="player-title-main"]');
    const sub  = document.querySelector('[data-uia="video-title"] .subtitle');
    if (main) {
      const title = main.textContent.trim();
      const ep    = sub?.textContent?.trim();
      return ep ? `${title} - ${ep}` : title;
    }
    // Fallback: "Show: S1:E1 "Episode" | Netflix"
    return document.title.replace(/\s*\|\s*Netflix\s*$/i, '').trim() || 'Unknown';
  }

  // ── Crunchyroll ────────────────────────────────────────────────────────────
  if (host.includes('crunchyroll.com')) {
    // URL is the most reliable source on Crunchyroll.
    const urlMatch = location.pathname.match(/\/watch\/[^/]+\/([^/?#]+)/);

    const epEl  = document.querySelector('[class*="EpisodeTitle"], [class*="episode-title"]');
    const serEl = document.querySelector('[class*="SeriesTitle"],  [class*="series-title"]');

    if (epEl && serEl) {
      return `${serEl.textContent.trim()} - ${epEl.textContent.trim()}`;
    }
    if (epEl) return epEl.textContent.trim();

    if (urlMatch) {
      return urlMatch[1]
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }

    return document.title.replace(/\s*[-|]\s*Crunchyroll\s*$/i, '').trim() || 'Unknown';
  }

  // ── YouTube ────────────────────────────────────────────────────────────────
  if (host.includes('youtube.com')) {
    const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')
               || document.querySelector('#title h1 yt-formatted-string');
    if (title) return title.textContent.trim();
    return document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim() || 'Unknown';
  }

  // ── Generic fallback ───────────────────────────────────────────────────────
  return document.title.split(' - ')[0].split(' | ')[0].trim() || 'Unknown';
}

function buildProfileKey() {
  return `${location.hostname}::${scrapeTitle()}`;
}

// ── Main class ─────────────────────────────────────────────────────────────

class VideoEnhancer {
  constructor() {
    this.renderer      = null;
    this.profileEngine = null;
    this.frameAnalyzer = new FrameAnalyzer();
    this.detector      = null;
    this.currentVideo  = null;
    this.isEnabled     = true;

    // Watch the <title> element so we can update the profile key when an
    // episode changes mid-session (both Netflix and Crunchyroll update it).
    this._titleObserver = null;
    this._titleReconnectTimer = null;
  }

  init() {
    // Restore persisted enabled state.
    chrome.storage.local.get('globalEnabled', ({ globalEnabled }) => {
      this.isEnabled = globalEnabled !== false;
    });

    // Observe <title> changes for mid-session episode transitions.
    this._watchTitle();

    this.detector = new VideoDetector({
      onVideoFound: (v) => this._onVideoFound(v),
      onVideoLost:  ()  => this._onVideoLost(),
      onNavigate:   (href) => this._onNavigate(href),
    });

    this.detector.start();

    // Listen for popup messages.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      this._handleMessage(msg, sendResponse);
      return true; // keep port open for async handlers
    });
  }

  // ── Video lifecycle ────────────────────────────────────────────────────────

  async _onVideoFound(video) {
    await this._teardown();
    this.currentVideo = video;

    this.renderer = new WebGLRenderer();
    const ok = await this.renderer.init(video);
    if (!ok) {
      console.warn('[VideoEnhancer] Renderer failed to initialise — site may block WebGL');
      return;
    }

    this.renderer.setEnabled(this.isEnabled);

    this.profileEngine = new ProfileEngine({
      frameAnalyzer:   this.frameAnalyzer,
      onParamsUpdated: (params) => this.renderer.updateParams(params),
    });

    await this.profileEngine.start(video, buildProfileKey());

    this._setBadge(this.isEnabled ? 'ON' : 'OFF', this.isEnabled ? '#4CAF50' : '#9E9E9E');
  }

  _onVideoLost() {
    this._teardown();
  }

  async _onNavigate(_href) {
    await this._teardown();
    // The detector will call _scanForVideo itself after the SPA settles.
  }

  async _teardown() {
    clearTimeout(this._titleReconnectTimer);
    this.profileEngine?.stop();
    this.renderer?.destroy();
    this.profileEngine = null;
    this.renderer      = null;
    this.currentVideo  = null;
  }

  // ── Title observation (episode change detection) ───────────────────────────

  _watchTitle() {
    const titleEl = document.querySelector('title');
    if (!titleEl) {
      // Retry — some SPAs create <title> late.
      this._titleReconnectTimer = setTimeout(() => this._watchTitle(), 2000);
      return;
    }
    this._titleObserver?.disconnect();
    this._titleObserver = new MutationObserver(() => {
      // If we have an active profile, rebuild the key and reload the profile.
      if (this.profileEngine && this.renderer) {
        const newKey = buildProfileKey();
        if (newKey !== this.profileEngine.profileKey) {
          this.profileEngine.start(this.currentVideo, newKey);
        }
      }
    });
    this._titleObserver.observe(titleEl, { childList: true });
  }

  // ── Popup message handling ─────────────────────────────────────────────────

  _handleMessage(msg, sendResponse) {
    switch (msg.type) {
      case 'GET_STATE': {
        sendResponse({
          isEnabled: this.isEnabled,
          hasVideo:  !!this.currentVideo,
          profile:   this.profileEngine?.getState() ?? null,
        });
        break;
      }

      case 'SET_ENABLED': {
        this.isEnabled = msg.enabled;
        this.renderer?.setEnabled(this.isEnabled);
        chrome.storage.local.set({ globalEnabled: this.isEnabled });
        this._setBadge(this.isEnabled ? 'ON' : 'OFF', this.isEnabled ? '#4CAF50' : '#9E9E9E');
        sendResponse({ ok: true });
        break;
      }

      case 'TOGGLE_ENABLED': {
        this.isEnabled = !this.isEnabled;
        this.renderer?.setEnabled(this.isEnabled);
        chrome.storage.local.set({ globalEnabled: this.isEnabled });
        this._setBadge(this.isEnabled ? 'ON' : 'OFF', this.isEnabled ? '#4CAF50' : '#9E9E9E');
        sendResponse({ isEnabled: this.isEnabled });
        break;
      }

      case 'SET_PARAM': {
        this.profileEngine?.applyManualOverride(msg.name, msg.value);
        sendResponse({ ok: true });
        break;
      }

      case 'RESET_PARAMS': {
        this.profileEngine?.clearManualOverrides();
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  }

  // ── Badge ──────────────────────────────────────────────────────────────────

  _setBadge(text, color) {
    chrome.runtime.sendMessage({ type: 'SET_BADGE', text, color });
  }
}

// Boot.
const enhancer = new VideoEnhancer();
enhancer.init();
