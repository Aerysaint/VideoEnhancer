// content/profile_engine.js
// Auto-tuning brain:
//  - Samples frames via FrameAnalyzer on a timer
//  - Classifies content as anime / live-action / dark-ambient
//  - Derives and adapts shader parameters from histogram statistics
//  - Smoothly interpolates parameter changes (no jarring visual jumps)
//  - Persists profiles to chrome.storage.local via the service worker

const SAMPLE_INTERVAL_MS    = 3_000;   // 3s sampling
const INITIAL_WINDOW_MS     = 15_000;  // 15s initial generic type 
const REFINE_INTERVAL_MS    = 5_000;   // Continuous refinement every 5 s
const MAX_ROLLING_SAMPLES   = 12;      // Longer memory (last ~60s) to smooth out sudden scene variations
const PRELIMINARY_THRESHOLD = 3;       // Smooth grade quickly but not instantly

// ── Default parameters ─────────────────────────────────────────────────────

const DEFAULTS = {
  blackPoint:       0.02,
  whitePoint:       1.0,
  gamma:            1.0,
  saturation:       1.05,
  vibrance:         0.2,
  contrastMid:      0.5,
  contrastStrength: 0.35,
  brightness:       0.0,
  sharpness:        0.1,
};

// ── Per-content-type presets ───────────────────────────────────────────────

const PRESET_ANIME = {
  blackPoint:       0.03,
  whitePoint:       0.98,
  gamma:            0.96,   
  saturation:       1.15,   // Less forced, punchy but balanced
  vibrance:         0.35,
  contrastMid:      0.48,
  contrastStrength: 0.55,
  brightness:       0.01,
  sharpness:        0.2,
};

const PRESET_LIVE_ACTION = {
  blackPoint:       0.015,  // Preserve natural shadows
  whitePoint:       1.0,
  gamma:            1.0,    // Near perfect natural tone curve
  saturation:       1.02,   // Only micro-boost for realism
  vibrance:         0.15,   // Gently lift pale scenery without nuking faces
  contrastMid:      0.50,
  contrastStrength: 0.25,   // Very soft S-Curve to prevent gamey look
  brightness:       0.0,
  sharpness:        0.05,
};

const PRESET_DARK_AMBIENT = {
  blackPoint:       0.01,  
  whitePoint:       0.96,   // Soft highlights
  gamma:            0.92,   // Pull down midtones heavily for cinematic picture
  saturation:       1.05,
  vibrance:         0.25,
  contrastMid:      0.45,
  contrastStrength: 0.40,
  brightness:       0.02,
  sharpness:        0.1,
};

const PRESET_CUSTOM_LEGACY = {
  blackPoint:       0.03,
  whitePoint:       1.0,
  gamma:            1.0,
  saturation:       1.05,
  vibrance:         0.2,
  contrastMid:      0.5,
  contrastStrength: 0.3,
  brightness:       0.0,
  sharpness:        0.3, 
};

// ── Engine ─────────────────────────────────────────────────────────────────

export class ProfileEngine {
  constructor({ frameAnalyzer, onParamsUpdated }) {
    this.frameAnalyzer   = frameAnalyzer;
    this.onParamsUpdated = onParamsUpdated;

    this.video           = null;
    this.profileKey      = null;
    this.contentType     = 'unknown';

    this.currentParams   = { ...DEFAULTS };
    this.targetParams    = { ...DEFAULTS };
    this.interpFrom      = { ...DEFAULTS };
    this.manualOverrides = {};

    this.analyses        = [];
    this.isInitialPhase  = false;

    this._sampleTimer    = null;
    this._refineTimer    = null;
    this._interpRafId    = null;
    this._interpStart    = 0;
    this._interpDuration = 2000;
    this._isInterpolating = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(video, profileKey) {
    this.video      = video;
    this.profileKey = profileKey;

    // Try loading a stored profile first.
    const stored = await this._loadProfile(profileKey);

    if (stored && !stored.isDefault) {
      this.currentParams   = { ...stored.params };
      this.targetParams    = { ...stored.params };
      this.interpFrom      = { ...stored.params };
      this.manualOverrides = stored.manualOverrides || {};
      this.contentType     = stored.contentType     || 'unknown';

      if (stored.analysisData) {
        this.analyses = [stored.analysisData];
      }

      // Push current params to renderer immediately.
      this.onParamsUpdated({ ...this.currentParams });

      // Still schedule background refinement even for known profiles.
      this._scheduleRefinement();
    } else {
      // Fresh content — start 2-min initial analysis phase.
      this.onParamsUpdated({ ...this.currentParams });
      this._startInitialPhase();
    }
  }

  stop() {
    clearTimeout(this._sampleTimer);
    clearTimeout(this._refineTimer);
    if (this._interpRafId) cancelAnimationFrame(this._interpRafId);
    this.video = null;
  }

  // ── Manual overrides (from popup sliders) ──────────────────────────────────

  applyManualOverride(name, value) {
    this.manualOverrides[name]  = value;
    this.currentParams[name]    = value;
    this.targetParams[name]     = value;
    this.onParamsUpdated({ ...this.currentParams });
    this._saveProfile();
  }

  clearManualOverrides() {
    this.manualOverrides = {};
    // Re-derive from existing analyses.
    if (this.analyses.length > 0) {
      this._classifyAndTune(false);
    } else {
      this.currentParams = { ...DEFAULTS };
      this.onParamsUpdated({ ...this.currentParams });
    }
    this._saveProfile();
  }

  getState() {
    return {
      params:          { ...this.currentParams },
      manualOverrides: { ...this.manualOverrides },
      contentType:     this.contentType,
      profileKey:      this.profileKey,
      sampleCount:     this.analyses.length,
    };
  }

  // ── Initial analysis phase ─────────────────────────────────────────────────

  _startInitialPhase() {
    this.isInitialPhase = true;
    this.analyses       = [];
    this._collectSample();

    // After 2 minutes, finalise and switch to continuous refinement.
    setTimeout(() => {
      this.isInitialPhase = false;
      clearTimeout(this._sampleTimer);
      this._classifyAndTune(false);
      this._scheduleRefinement();
    }, INITIAL_WINDOW_MS);
  }

  _collectSample() {
    if (!this.video) return;
    const result = this.frameAnalyzer.analyzeFrame(this.video);
    if (result) {
      this.analyses.push(result);
      // Apply a quick preliminary grade once we have a handful of samples.
      if (this.analyses.length === PRELIMINARY_THRESHOLD) {
        this._classifyAndTune(true);
      }
    }
    if (this.isInitialPhase) {
      this._sampleTimer = setTimeout(() => this._collectSample(), SAMPLE_INTERVAL_MS);
    }
  }

  _scheduleRefinement() {
    this._refineTimer = setTimeout(async () => {
      if (!this.video) return;
      const result = this.frameAnalyzer.analyzeFrame(this.video);
      if (result) {
        this.analyses.push(result);
        if (this.analyses.length > MAX_ROLLING_SAMPLES) this.analyses.shift();
        this._classifyAndTune(false);
      }
      this._scheduleRefinement();
    }, REFINE_INTERVAL_MS);
  }

  // ── Classification ─────────────────────────────────────────────────────────

  _classifyAndTune(preliminary) {
    if (this.analyses.length === 0) return;

    const avg         = this._averageAnalyses(this.analyses);
    const contentType = this._classifyContent(avg);
    this.contentType  = contentType;

    const derived      = this._deriveParams(contentType, avg);
    const final        = { ...derived, ...this.manualOverrides };

    // Increase the transition duration massively (10 seconds) for invisible continual shifts instead of rapid pops
    this._transitionTo(final, preliminary ? 2000 : 10000);
    this._saveProfile();
  }

  _averageAnalyses(analyses) {
    const keys = [
      'blackLevelPct', 'shadowPct', 'highlightPct', 'meanSaturation',
      'satVariance', 'skinTonePct', 'lumP10', 'lumP50', 'lumP90', 'highSatMass',
    ];
    const avg = {};
    for (const k of keys) {
      avg[k] = analyses.reduce((s, a) => s + (a[k] ?? 0), 0) / analyses.length;
    }
    // Bimodal if majority of samples show it.
    avg.isBimodalSat = analyses.filter(a => a.isBimodalSat).length > analyses.length * 0.5;
    return avg;
  }

  _classifyContent(avg) {
    // Prevent false dark-ambient flags on average indoor/Game of Thrones scenes
    // Only classify as dark-ambient if the scene is literally completely black 
    if (avg.lumP50 < 0.10 && avg.lumP90 < 0.35) return 'dark-ambient';

    let animeScore = 0;
    let liveScore  = 0;

    // Anime signals
    if (avg.isBimodalSat)          animeScore += 3;  // flat colors + black outlines = bimodal sat
    if (avg.highSatMass > 0.35)    animeScore += 2;  // lots of vivid color regions
    if (avg.blackLevelPct > 0.15)  animeScore += 2;  // thick black outlines → many dark pixels
    if (avg.satVariance < 0.05)    animeScore += 2;  // flat-color regions = low variance
    if (avg.skinTonePct < 0.04)    animeScore += 1;  // stylized skin, not natural
    if (avg.meanSaturation > 0.50) animeScore += 1;

    // Live-action signals (Game of thrones / regular films)
    if (avg.skinTonePct > 0.06)    liveScore += 3;   // natural skin tones present
    if (avg.satVariance > 0.09)    liveScore += 2;   // continuous photographic gradients
    if (avg.meanSaturation < 0.30) liveScore += 2;   // muted naturalistic palette (e.g. GoT)
    if (!avg.isBimodalSat)         liveScore += 2;
    if (avg.blackLevelPct < 0.05)  liveScore += 1;

    if (animeScore > liveScore + 3) return 'anime';
    if (liveScore > animeScore + 1) return 'live-action';
    
    // Leeway for mixed types / generic fallback
    return 'general';
  }

  // ── Parameter derivation ───────────────────────────────────────────────────

  _deriveParams(contentType, avg) {
    let base;
    if (contentType === 'anime')        base = { ...PRESET_ANIME };
    else if (contentType === 'dark-ambient') base = { ...PRESET_DARK_AMBIENT };
    else if (contentType === 'live-action') base = { ...PRESET_LIVE_ACTION };
    else                                base = { ...DEFAULTS }; // Fallback general generic type

    // Adaptive nudges based on dynamic scene changes (e.g. bright outdoors vs neon bar)
    
    // Scene: Dark, high contrast (e.g. neon lights in a dim bar)
    if (avg.lumP50 < 0.25) {
      base.brightness = Math.min(base.brightness + 0.03, 0.06);     // Lift out of the crushing threshold 
      base.vibrance = Math.min(base.vibrance + 0.15, 0.45);           // Punch up those neon colors
      base.blackPoint = Math.max(base.blackPoint - 0.015, 0.0);       // Don't crush what little texture is left
      base.contrastStrength = Math.max(base.contrastStrength - 0.1, 0.2); // Soften S-curve to prevent blotching
    } 
    // Scene: Very bright, high dynamic range (e.g. bright sunlight outdoors)
    else if (avg.lumP50 > 0.65) {
      base.brightness = Math.max(base.brightness - 0.03, -0.05);      // Pull down exposure to save sky highlights
      base.gamma = Math.min(base.gamma + 0.05, 1.05);                 // Add midtone weight for a richer sunlit sky
      base.contrastStrength = Math.min(base.contrastStrength + 0.1, 0.5); // Add depth to bright scenery
      base.vibrance = Math.max(base.vibrance - 0.15, 0.05);           // Prevent extreme sunburn on grass/faces
    }

    // Nudges based on histogram details:
    if (avg.blackLevelPct < 0.05 && avg.lumP50 > 0.3) {
      base.blackPoint = Math.min(base.blackPoint + 0.015, 0.06); // Increase black pop if scene is milky
    } else if (avg.blackLevelPct > 0.25) {
      base.blackPoint = Math.max(base.blackPoint - 0.01, 0.0);
    }

    if (avg.meanSaturation > 0.55) {
      base.saturation = Math.max(base.saturation - 0.1, 1.0); // Source is already saturated
    } else if (avg.meanSaturation < 0.20 && avg.lumP50 > 0.15) {
      base.saturation = Math.min(base.saturation + 0.15, 1.3); // Source is muddy/gray
    }

    if (avg.highlightPct > 0.15) {
      base.contrastStrength = Math.max(base.contrastStrength - 0.1, 0.2);
      base.whitePoint       = 0.97; // Preserve bright details
    }

    return base;
  }

  // ── Smooth parameter interpolation ────────────────────────────────────────
  // Smoothstep easing over `duration` ms via rAF so parameter updates never
  // produce a jarring visual jump.

  _transitionTo(newParams, duration = 2000) {
    this.targetParams    = { ...newParams };
    this.interpFrom      = { ...this.currentParams };
    this._interpStart    = performance.now();
    this._interpDuration = duration;

    if (!this._isInterpolating) {
      this._isInterpolating = true;
      this._tickInterp();
    }
  }

  _tickInterp() {
    const elapsed = performance.now() - this._interpStart;
    const t       = Math.min(elapsed / this._interpDuration, 1.0);
    const eased   = t < 1.0 ? t * t * (3 - 2 * t) : 1.0;  // smoothstep

    for (const key of Object.keys(this.targetParams)) {
      if (!(key in this.manualOverrides)) {
        const from = this.interpFrom[key]   ?? 0;
        const to   = this.targetParams[key] ?? 0;
        this.currentParams[key] = from + (to - from) * eased;
      }
    }

    this.onParamsUpdated({ ...this.currentParams });

    if (t < 1.0) {
      this._interpRafId = requestAnimationFrame(() => this._tickInterp());
    } else {
      this._isInterpolating = false;
    }
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  _loadProfile(key) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'LOAD_PROFILE', key }, resolve);
    });
  }

  _saveProfile() {
    if (!this.profileKey) return;
    const data = {
      params:          { ...this.currentParams },
      manualOverrides: { ...this.manualOverrides },
      contentType:     this.contentType,
      analysisData:    this.analyses.length > 0 ? this._averageAnalyses(this.analyses) : null,
      lastUpdated:     Date.now(),
    };
    chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', key: this.profileKey, data });
  }
}
