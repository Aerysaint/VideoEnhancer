(() => {
  // content/video_detector.js
  var VideoDetector = class {
    constructor({ onVideoFound, onVideoLost, onNavigate }) {
      this.onVideoFound = onVideoFound;
      this.onVideoLost = onVideoLost;
      this.onNavigate = onNavigate;
      this.currentVideo = null;
      this.mutationObs = null;
      this.pollInterval = null;
      this.lastHref = location.href;
    }
    start() {
      this._scanForVideo();
      this.mutationObs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE)
              continue;
            const vid = node.matches?.("video") ? node : node.querySelector?.("video");
            if (vid) {
              this._handleFound(vid);
              return;
            }
          }
          for (const node of m.removedNodes) {
            if (node === this.currentVideo || node.contains?.(this.currentVideo)) {
              this._handleLost();
            }
          }
        }
      });
      this.mutationObs.observe(document.documentElement, { childList: true, subtree: true });
      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);
      history.pushState = (...args) => {
        origPush(...args);
        this._handleNavigate();
      };
      history.replaceState = (...args) => {
        origReplace(...args);
        this._handleNavigate();
      };
      window.addEventListener("popstate", () => this._handleNavigate());
      this.pollInterval = setInterval(() => {
        if (location.href !== this.lastHref) {
          this.lastHref = location.href;
          this._handleNavigate();
        }
        if (!this.currentVideo || !document.contains(this.currentVideo)) {
          this._scanForVideo();
        }
      }, 1e3);
    }
    stop() {
      this.mutationObs?.disconnect();
      clearInterval(this.pollInterval);
    }
    // ── Video selection ────────────────────────────────────────────────────────
    _scanForVideo() {
      const candidates = Array.from(document.querySelectorAll("video")).filter((v) => !v.dataset.enhancerCanvas && // never our own analysis canvas
      v.offsetWidth >= 400 && // exclude tiny preview thumbnails
      v.offsetHeight >= 250);
      if (candidates.length === 0)
        return;
      const playing = candidates.find((v) => !v.paused && !v.ended && v.readyState >= 2);
      const best = playing || candidates.reduce(
        (a, b) => a.offsetWidth * a.offsetHeight >= b.offsetWidth * b.offsetHeight ? a : b
      );
      if (best !== this.currentVideo) {
        this._handleFound(best);
      }
    }
    _handleFound(video) {
      if (video.offsetWidth < 200 || video.offsetHeight < 120)
        return;
      if (video.dataset.enhancerCanvas)
        return;
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
      setTimeout(() => {
        this.currentVideo = null;
        this.onNavigate(location.href);
        this._scanForVideo();
      }, 500);
    }
  };

  // content/frame_analyzer.js
  var FrameAnalyzer = class {
    constructor() {
      this.canvas = document.createElement("canvas");
      this.canvas.width = 128;
      this.canvas.height = 128;
      this.canvas.dataset.enhancerIgnore = "true";
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    // Returns an analysis result object, or null if the frame isn't ready.
    analyzeFrame(video) {
      if (!video || video.readyState < 2 || video.videoWidth === 0)
        return null;
      if (this.drmActive)
        return null;
      try {
        this.ctx.drawImage(video, 0, 0, 128, 128);
        const imageData = this.ctx.getImageData(0, 0, 128, 128);
        return this._compute(imageData);
      } catch (e) {
        this.drmActive = true;
        return null;
      }
    }
    _compute(imageData) {
      const data = imageData.data;
      const N = 128 * 128;
      const lumHist = new Float32Array(256);
      const satHist = new Float32Array(64);
      let blackPx = 0;
      let shadowPx = 0;
      let highlightPx = 0;
      let satSum = 0;
      let satSqSum = 0;
      let skinPx = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumHist[Math.min(255, lum * 255 | 0)]++;
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const delta = maxC - minC;
        const l = (maxC + minC) * 0.5;
        const sat = delta < 1e-4 ? 0 : delta / (1 - Math.abs(2 * l - 1));
        let hue = 0;
        if (delta > 1e-4) {
          if (maxC === r)
            hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
          else if (maxC === g)
            hue = ((b - r) / delta + 2) / 6;
          else
            hue = ((r - g) / delta + 4) / 6;
        }
        satHist[Math.min(63, sat * 64 | 0)]++;
        satSum += sat;
        satSqSum += sat * sat;
        if (lum < 0.05)
          blackPx++;
        if (lum < 0.25)
          shadowPx++;
        if (lum > 0.9)
          highlightPx++;
        if (hue >= 0.028 && hue <= 0.111 && sat > 0.15 && l > 0.25 && l < 0.75)
          skinPx++;
      }
      for (let i = 0; i < 256; i++)
        lumHist[i] /= N;
      for (let i = 0; i < 64; i++)
        satHist[i] /= N;
      const meanSat = satSum / N;
      const satVar = satSqSum / N - meanSat * meanSat;
      const lumP10 = this._percentile(lumHist, 0.1);
      const lumP50 = this._percentile(lumHist, 0.5);
      const lumP90 = this._percentile(lumHist, 0.9);
      const highSatMass = satHist.slice(26).reduce((a, b) => a + b, 0);
      const lowSatMass = satHist.slice(0, 7).reduce((a, b) => a + b, 0);
      const isBimodal = highSatMass > 0.25 && lowSatMass > 0.2;
      return {
        blackLevelPct: blackPx / N,
        shadowPct: shadowPx / N,
        highlightPct: highlightPx / N,
        skinTonePct: skinPx / N,
        meanSaturation: meanSat,
        satVariance: satVar,
        highSatMass,
        lumP10,
        lumP50,
        lumP90,
        isBimodalSat: isBimodal,
        timestamp: Date.now()
      };
    }
    _percentile(hist, p) {
      let cum = 0;
      for (let i = 0; i < hist.length; i++) {
        cum += hist[i];
        if (cum >= p)
          return i / 255;
      }
      return 1;
    }
    destroy() {
      this.ctx = null;
      this.canvas = null;
    }
  };

  // content/profile_engine.js
  var SAMPLE_INTERVAL_MS = 3e3;
  var INITIAL_WINDOW_MS = 15e3;
  var REFINE_INTERVAL_MS = 5e3;
  var MAX_ROLLING_SAMPLES = 12;
  var PRELIMINARY_THRESHOLD = 3;
  var DEFAULTS = {
    blackPoint: 0.02,
    whitePoint: 1,
    gamma: 1,
    saturation: 1.05,
    vibrance: 0.2,
    contrastMid: 0.5,
    contrastStrength: 0.35,
    brightness: 0,
    sharpness: 0.1
  };
  var PRESET_ANIME = {
    blackPoint: 0.03,
    whitePoint: 0.98,
    gamma: 0.96,
    saturation: 1.15,
    // Less forced, punchy but balanced
    vibrance: 0.35,
    contrastMid: 0.48,
    contrastStrength: 0.55,
    brightness: 0.01,
    sharpness: 0.2
  };
  var PRESET_LIVE_ACTION = {
    blackPoint: 0.015,
    // Preserve natural shadows
    whitePoint: 1,
    gamma: 1,
    // Near perfect natural tone curve
    saturation: 1.02,
    // Only micro-boost for realism
    vibrance: 0.15,
    // Gently lift pale scenery without nuking faces
    contrastMid: 0.5,
    contrastStrength: 0.25,
    // Very soft S-Curve to prevent gamey look
    brightness: 0,
    sharpness: 0.05
  };
  var PRESET_DARK_AMBIENT = {
    blackPoint: 0.01,
    whitePoint: 0.96,
    // Soft highlights
    gamma: 0.92,
    // Pull down midtones heavily for cinematic picture
    saturation: 1.05,
    vibrance: 0.25,
    contrastMid: 0.45,
    contrastStrength: 0.4,
    brightness: 0.02,
    sharpness: 0.1
  };
  var ProfileEngine = class {
    constructor({ frameAnalyzer, onParamsUpdated }) {
      this.frameAnalyzer = frameAnalyzer;
      this.onParamsUpdated = onParamsUpdated;
      this.video = null;
      this.profileKey = null;
      this.contentType = "unknown";
      this.currentParams = { ...DEFAULTS };
      this.targetParams = { ...DEFAULTS };
      this.interpFrom = { ...DEFAULTS };
      this.manualOverrides = {};
      this.analyses = [];
      this.isInitialPhase = false;
      this._sampleTimer = null;
      this._refineTimer = null;
      this._interpRafId = null;
      this._interpStart = 0;
      this._interpDuration = 2e3;
      this._isInterpolating = false;
    }
    // ── Lifecycle ──────────────────────────────────────────────────────────────
    async start(video, profileKey) {
      this.video = video;
      this.profileKey = profileKey;
      const stored = await this._loadProfile(profileKey);
      if (stored && !stored.isDefault) {
        this.currentParams = { ...stored.params };
        this.targetParams = { ...stored.params };
        this.interpFrom = { ...stored.params };
        this.manualOverrides = stored.manualOverrides || {};
        this.contentType = stored.contentType || "unknown";
        if (stored.analysisData) {
          this.analyses = [stored.analysisData];
        }
        this.onParamsUpdated({ ...this.currentParams });
        this._scheduleRefinement();
      } else {
        this.onParamsUpdated({ ...this.currentParams });
        this._startInitialPhase();
      }
    }
    stop() {
      clearTimeout(this._sampleTimer);
      clearTimeout(this._refineTimer);
      if (this._interpRafId)
        cancelAnimationFrame(this._interpRafId);
      this.video = null;
    }
    // ── Manual overrides (from popup sliders) ──────────────────────────────────
    applyManualOverride(name, value) {
      this.manualOverrides[name] = value;
      this.currentParams[name] = value;
      this.targetParams[name] = value;
      this.onParamsUpdated({ ...this.currentParams });
      this._saveProfile();
    }
    clearManualOverrides() {
      this.manualOverrides = {};
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
        params: { ...this.currentParams },
        manualOverrides: { ...this.manualOverrides },
        contentType: this.contentType,
        profileKey: this.profileKey,
        sampleCount: this.analyses.length
      };
    }
    // ── Initial analysis phase ─────────────────────────────────────────────────
    _startInitialPhase() {
      this.isInitialPhase = true;
      this.analyses = [];
      this._collectSample();
      setTimeout(() => {
        this.isInitialPhase = false;
        clearTimeout(this._sampleTimer);
        this._classifyAndTune(false);
        this._scheduleRefinement();
      }, INITIAL_WINDOW_MS);
    }
    _collectSample() {
      if (!this.video)
        return;
      const result = this.frameAnalyzer.analyzeFrame(this.video);
      if (result) {
        this.analyses.push(result);
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
        if (!this.video)
          return;
        const result = this.frameAnalyzer.analyzeFrame(this.video);
        if (result) {
          this.analyses.push(result);
          if (this.analyses.length > MAX_ROLLING_SAMPLES)
            this.analyses.shift();
          this._classifyAndTune(false);
        }
        this._scheduleRefinement();
      }, REFINE_INTERVAL_MS);
    }
    // ── Classification ─────────────────────────────────────────────────────────
    _classifyAndTune(preliminary) {
      if (this.analyses.length === 0)
        return;
      const avg = this._averageAnalyses(this.analyses);
      const contentType = this._classifyContent(avg);
      this.contentType = contentType;
      const derived = this._deriveParams(contentType, avg);
      const final = { ...derived, ...this.manualOverrides };
      this._transitionTo(final, preliminary ? 2e3 : 1e4);
      this._saveProfile();
    }
    _averageAnalyses(analyses) {
      const keys = [
        "blackLevelPct",
        "shadowPct",
        "highlightPct",
        "meanSaturation",
        "satVariance",
        "skinTonePct",
        "lumP10",
        "lumP50",
        "lumP90",
        "highSatMass"
      ];
      const avg = {};
      for (const k of keys) {
        avg[k] = analyses.reduce((s, a) => s + (a[k] ?? 0), 0) / analyses.length;
      }
      avg.isBimodalSat = analyses.filter((a) => a.isBimodalSat).length > analyses.length * 0.5;
      return avg;
    }
    _classifyContent(avg) {
      if (avg.lumP50 < 0.1 && avg.lumP90 < 0.35)
        return "dark-ambient";
      let animeScore = 0;
      let liveScore = 0;
      if (avg.isBimodalSat)
        animeScore += 3;
      if (avg.highSatMass > 0.35)
        animeScore += 2;
      if (avg.blackLevelPct > 0.15)
        animeScore += 2;
      if (avg.satVariance < 0.05)
        animeScore += 2;
      if (avg.skinTonePct < 0.04)
        animeScore += 1;
      if (avg.meanSaturation > 0.5)
        animeScore += 1;
      if (avg.skinTonePct > 0.06)
        liveScore += 3;
      if (avg.satVariance > 0.09)
        liveScore += 2;
      if (avg.meanSaturation < 0.3)
        liveScore += 2;
      if (!avg.isBimodalSat)
        liveScore += 2;
      if (avg.blackLevelPct < 0.05)
        liveScore += 1;
      if (animeScore > liveScore + 3)
        return "anime";
      if (liveScore > animeScore + 1)
        return "live-action";
      return "general";
    }
    // ── Parameter derivation ───────────────────────────────────────────────────
    _deriveParams(contentType, avg) {
      let base;
      if (contentType === "anime")
        base = { ...PRESET_ANIME };
      else if (contentType === "dark-ambient")
        base = { ...PRESET_DARK_AMBIENT };
      else if (contentType === "live-action")
        base = { ...PRESET_LIVE_ACTION };
      else
        base = { ...DEFAULTS };
      if (avg.lumP50 < 0.25) {
        base.brightness = Math.min(base.brightness + 0.03, 0.06);
        base.vibrance = Math.min(base.vibrance + 0.15, 0.45);
        base.blackPoint = Math.max(base.blackPoint - 0.015, 0);
        base.contrastStrength = Math.max(base.contrastStrength - 0.1, 0.2);
      } else if (avg.lumP50 > 0.65) {
        base.brightness = Math.max(base.brightness - 0.03, -0.05);
        base.gamma = Math.min(base.gamma + 0.05, 1.05);
        base.contrastStrength = Math.min(base.contrastStrength + 0.1, 0.5);
        base.vibrance = Math.max(base.vibrance - 0.15, 0.05);
      }
      if (avg.blackLevelPct < 0.05 && avg.lumP50 > 0.3) {
        base.blackPoint = Math.min(base.blackPoint + 0.015, 0.06);
      } else if (avg.blackLevelPct > 0.25) {
        base.blackPoint = Math.max(base.blackPoint - 0.01, 0);
      }
      if (avg.meanSaturation > 0.55) {
        base.saturation = Math.max(base.saturation - 0.1, 1);
      } else if (avg.meanSaturation < 0.2 && avg.lumP50 > 0.15) {
        base.saturation = Math.min(base.saturation + 0.15, 1.3);
      }
      if (avg.highlightPct > 0.15) {
        base.contrastStrength = Math.max(base.contrastStrength - 0.1, 0.2);
        base.whitePoint = 0.97;
      }
      return base;
    }
    // ── Smooth parameter interpolation ────────────────────────────────────────
    // Smoothstep easing over `duration` ms via rAF so parameter updates never
    // produce a jarring visual jump.
    _transitionTo(newParams, duration = 2e3) {
      this.targetParams = { ...newParams };
      this.interpFrom = { ...this.currentParams };
      this._interpStart = performance.now();
      this._interpDuration = duration;
      if (!this._isInterpolating) {
        this._isInterpolating = true;
        this._tickInterp();
      }
    }
    _tickInterp() {
      const elapsed = performance.now() - this._interpStart;
      const t = Math.min(elapsed / this._interpDuration, 1);
      const eased = t < 1 ? t * t * (3 - 2 * t) : 1;
      for (const key of Object.keys(this.targetParams)) {
        if (!(key in this.manualOverrides)) {
          const from = this.interpFrom[key] ?? 0;
          const to = this.targetParams[key] ?? 0;
          this.currentParams[key] = from + (to - from) * eased;
        }
      }
      this.onParamsUpdated({ ...this.currentParams });
      if (t < 1) {
        this._interpRafId = requestAnimationFrame(() => this._tickInterp());
      } else {
        this._isInterpolating = false;
      }
    }
    // ── Storage ────────────────────────────────────────────────────────────────
    _loadProfile(key) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "LOAD_PROFILE", key }, resolve);
      });
    }
    _saveProfile() {
      if (!this.profileKey)
        return;
      const data = {
        params: { ...this.currentParams },
        manualOverrides: { ...this.manualOverrides },
        contentType: this.contentType,
        analysisData: this.analyses.length > 0 ? this._averageAnalyses(this.analyses) : null,
        lastUpdated: Date.now()
      };
      chrome.runtime.sendMessage({ type: "SAVE_PROFILE", key: this.profileKey, data });
    }
  };

  // webgl/webgl_engine.js
  var WebGLEngine = class {
    constructor(onFallback) {
      this.onFallback = onFallback;
      this.video = null;
      this.canvas = null;
      this.gl = null;
      this.program = null;
      this.texture = null;
      this.animationFrameId = null;
      this.params = {};
      this.resizeObserver = null;
    }
    async init(video) {
      this.video = video;
      if (this.video.mediaKeys) {
        console.log("DRM detected via mediaKeys - aborting WebGL, switching to fallback.");
        return false;
      }
      this.canvas = document.createElement("canvas");
      this.canvas.dataset.enhancerCanvas = "true";
      this.canvas.style.position = "absolute";
      this.canvas.style.pointerEvents = "none";
      this.canvas.style.zIndex = "99999";
      if (this.video.parentNode) {
        this.video.parentNode.insertBefore(this.canvas, this.video.nextSibling);
      }
      const isHDR = window.matchMedia && window.matchMedia("(dynamic-range: high)").matches;
      this.gl = this.canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        colorSpace: isHDR ? "display-p3" : "srgb"
      });
      if (!this.gl) {
        this.destroy();
        return false;
      }
      const success = await this._setupGL();
      if (!success) {
        this.destroy();
        return false;
      }
      this.video.style.opacity = "0.001";
      this._syncRect();
      this.resizeObserver = new ResizeObserver(() => this._syncRect());
      this.resizeObserver.observe(this.video);
      this._renderLoop = this._renderLoop.bind(this);
      this.animationFrameId = requestAnimationFrame(this._renderLoop);
      return true;
    }
    _syncRect() {
      if (!this.video || !this.canvas)
        return;
      const rect = this.video.getBoundingClientRect();
      const style = window.getComputedStyle(this.video);
      this.canvas.style.left = this.video.offsetLeft + "px";
      this.canvas.style.top = this.video.offsetTop + "px";
      this.canvas.style.width = style.width;
      this.canvas.style.height = style.height;
      this.canvas.style.margin = style.margin;
      this.canvas.style.transform = style.transform;
      this.canvas.style.objectFit = style.objectFit;
      const upscaleFactor = 1.5;
      this.canvas.width = this.video.videoWidth * upscaleFactor || rect.width * upscaleFactor;
      this.canvas.height = this.video.videoHeight * upscaleFactor || rect.height * upscaleFactor;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    async _setupGL() {
      const gl = this.gl;
      const vsSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_texcoord;
    void main() {
        v_texcoord = (a_position + 1.0) * 0.5;
        v_texcoord.y = 1.0 - v_texcoord.y;
        gl_Position = vec4(a_position, 0.0, 1.0);
    }`;
      const fsSource = `#version 300 es
    precision highp float;
    in vec2 v_texcoord;
    out vec4 outColor;

    uniform sampler2D u_texture;
    uniform vec2 u_texResolution;
    
    uniform float u_blackPoint;
    uniform float u_whitePoint;
    uniform float u_gamma;
    uniform float u_saturation;
    uniform float u_vibrance;
    uniform float u_contrastMid;
    uniform float u_contrastStrength;
    uniform float u_brightness;
    uniform float u_sharpness;
    uniform float u_enabled;

    vec3 rgb2hsl(vec3 c) {
      float maxC = max(c.r, max(c.g, c.b));
      float minC = min(c.r, min(c.g, c.b));
      float delta = maxC - minC;
      float l = (maxC + minC) * 0.5;
      if (delta < 0.0001) return vec3(0.0, 0.0, l);
      float s = l > 0.5 ? delta / (2.0 - maxC - minC) : delta / (maxC + minC);
      float h;
      if (maxC == c.r) { h = (c.g - c.b) / delta; if (c.g < c.b) h += 6.0; }
      else if (maxC == c.g) h = (c.b - c.r) / delta + 2.0;
      else h = (c.r - c.g) / delta + 4.0;
      return vec3(h / 6.0, s, l);
    }
    float hue2rgb(float p, float q, float t) {
      if (t < 0.0) t += 1.0;
      if (t > 1.0) t -= 1.0;
      if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
      if (t < 0.5) return q;
      if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
      return p;
    }
    vec3 hsl2rgb(vec3 c) {
      if (c.y < 0.0001) return vec3(c.z);
      float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y;
      float p = 2.0 * c.z - q;
      return vec3(hue2rgb(p, q, c.x + 1.0 / 3.0), hue2rgb(p, q, c.x), hue2rgb(p, q, c.x - 1.0 / 3.0));
    }
    float sCurve(float x, float mid, float strength) {
      float xm = x - mid;
      float k = strength * 6.0;
      float curved = xm / (1.0 + k * abs(xm));
      float normLow = (-mid) / (1.0 + k * mid);
      float normHigh = (1.0 - mid) / (1.0 + k * (1.0 - mid));
      float scale = (curved < 0.0)
        ? (mid > 0.0001 ? -mid / normLow : 1.0)
        : ((1.0 - mid) > 0.0001 ? (1.0 - mid) / normHigh : 1.0);
      return mid + curved * scale;
    }

    void main() {
      // Contrast Adaptive Sharpening (Edge-Directed)
      vec3 color = texture(u_texture, v_texcoord).rgb;
      
      if (u_enabled < 0.5) {
        outColor = vec4(color, 1.0);
        return;
      }
      
      if (u_sharpness > 0.0) {
          vec2 texelSize = 1.0 / u_texResolution;
          vec3 up = texture(u_texture, v_texcoord + vec2(0.0, -texelSize.y)).rgb;
          vec3 down = texture(u_texture, v_texcoord + vec2(0.0, texelSize.y)).rgb;
          vec3 left = texture(u_texture, v_texcoord + vec2(-texelSize.x, 0.0)).rgb;
          vec3 right = texture(u_texture, v_texcoord + vec2(texelSize.x, 0.0)).rgb;
          vec3 sharp = color * 5.0 - (up + down + left + right);
          color = mix(color, sharp, u_sharpness * 0.5);
      }

      // Color Grading
      color = max(color - vec3(u_blackPoint), vec3(0.0));
      color = color / max(1.0 - u_blackPoint, 0.001);
      color += vec3(u_brightness);
      
      color.r = sCurve(color.r, u_contrastMid, u_contrastStrength);
      color.g = sCurve(color.g, u_contrastMid, u_contrastStrength);
      color.b = sCurve(color.b, u_contrastMid, u_contrastStrength);
      
      color = color / max(u_whitePoint, 0.001);
      color = pow(max(color, vec3(0.001)), vec3(u_gamma));
      
      vec3 hsl = rgb2hsl(color);
      hsl.y = clamp(hsl.y * u_saturation, 0.0, 1.0);
      color = hsl2rgb(hsl);
      
      vec3 hsl2 = rgb2hsl(color);
      float satLift = u_vibrance * (1.0 - hsl2.y);
      hsl2.y = clamp(hsl2.y + satLift * 0.6, 0.0, 1.0);
      color = hsl2rgb(hsl2);
      
      outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }`;
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsSource);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSource);
      gl.compileShader(fs);
      this.program = gl.createProgram();
      gl.attachShader(this.program, vs);
      gl.attachShader(this.program, fs);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(this.program));
        return false;
      }
      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1,
        -1,
        1,
        -1,
        -1,
        1,
        -1,
        1,
        1,
        -1,
        1,
        1
      ]), gl.STATIC_DRAW);
      const a_position = gl.getAttribLocation(this.program, "a_position");
      gl.enableVertexAttribArray(a_position);
      gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      try {
        if (this.video.readyState >= 2) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        }
      } catch (e) {
        console.error("WebGL Texture Upload failed. This is likely a DRM restriction:", e);
        return false;
      }
      return true;
    }
    updateParams(newParams) {
      this.params = { ...this.params, ...newParams };
    }
    setEnabled(enabled) {
      this.params.enabled = enabled;
    }
    _renderLoop() {
      if (!this.video || !this.gl)
        return;
      const gl = this.gl;
      if (this.video.mediaKeys) {
        console.log("DRM mediaKeys attached mid-stream. Triggering fallback.");
        if (this.onFallback)
          this.onFallback();
        this.destroy();
        return;
      }
      if (this.video.readyState >= 2 && !this.video.paused && !this.video.ended) {
        try {
          gl.bindTexture(gl.TEXTURE_2D, this.texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
        } catch (e) {
          console.error("Texture upload failed mid-stream.", e);
          if (this.onFallback)
            this.onFallback();
          this.destroy();
          return;
        }
      }
      gl.useProgram(this.program);
      gl.uniform2f(gl.getUniformLocation(this.program, "u_texResolution"), this.video.videoWidth || 1, this.video.videoHeight || 1);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_blackPoint"), this.params.blackPoint ?? 0.03);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_whitePoint"), this.params.whitePoint ?? 1);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_gamma"), this.params.gamma ?? 1);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_saturation"), this.params.saturation ?? 1.2);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_vibrance"), this.params.vibrance ?? 0.3);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_contrastMid"), this.params.contrastMid ?? 0.5);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_contrastStrength"), this.params.contrastStrength ?? 0.5);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_brightness"), this.params.brightness ?? 0);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_sharpness"), this.params.sharpness ?? 0.5);
      gl.uniform1f(gl.getUniformLocation(this.program, "u_enabled"), this.params.enabled ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.animationFrameId = requestAnimationFrame(this._renderLoop);
    }
    destroy() {
      if (this.animationFrameId)
        cancelAnimationFrame(this.animationFrameId);
      if (this.resizeObserver)
        this.resizeObserver.disconnect();
      if (this.video) {
        this.video.style.opacity = "1.0";
      }
      if (this.canvas) {
        this.canvas.remove();
      }
      this.video = null;
      this.canvas = null;
      this.gl = null;
      this.program = null;
    }
  };

  // webgl/svg_engine.js
  var SVGEngine = class {
    constructor() {
      this.video = null;
      this.svgContainer = null;
      this.feTransfer = null;
      this.feColorMatrix = null;
      this.filterId = "";
      this._originalFilter = "";
      this.params = {};
      this.isHDR = window.matchMedia && window.matchMedia("(dynamic-range: high)").matches;
    }
    async init(video) {
      this.video = video;
      this._originalFilter = this.video.style.filter || "";
      this.svgContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svgContainer.setAttribute("width", "0");
      this.svgContainer.setAttribute("height", "0");
      this.svgContainer.style.position = "fixed";
      this.svgContainer.style.pointerEvents = "none";
      this.svgContainer.style.opacity = "0";
      this.filterId = "video-enhancer-filter-" + Math.random().toString(36).substr(2, 9);
      const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
      filter.setAttribute("id", this.filterId);
      filter.setAttribute("color-interpolation-filters", this.isHDR ? "linearRGB" : "sRGB");
      this.feTransfer = document.createElementNS("http://www.w3.org/2000/svg", "feComponentTransfer");
      this.feFuncR = document.createElementNS("http://www.w3.org/2000/svg", "feFuncR");
      this.feFuncG = document.createElementNS("http://www.w3.org/2000/svg", "feFuncG");
      this.feFuncB = document.createElementNS("http://www.w3.org/2000/svg", "feFuncB");
      this.feFuncR.setAttribute("type", "table");
      this.feFuncG.setAttribute("type", "table");
      this.feFuncB.setAttribute("type", "table");
      this.feTransfer.appendChild(this.feFuncR);
      this.feTransfer.appendChild(this.feFuncG);
      this.feTransfer.appendChild(this.feFuncB);
      this.feColorMatrix = document.createElementNS("http://www.w3.org/2000/svg", "feColorMatrix");
      this.feColorMatrix.setAttribute("type", "saturate");
      this.feBlur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
      this.feBlur.setAttribute("stdDeviation", "1.5");
      this.feBlur.setAttribute("result", "blurred");
      this.feComposite = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
      this.feComposite.setAttribute("operator", "arithmetic");
      this.feComposite.setAttribute("in2", "blurred");
      this.feComposite.setAttribute("k1", "0");
      this.feComposite.setAttribute("k4", "0");
      filter.appendChild(this.feTransfer);
      filter.appendChild(this.feColorMatrix);
      filter.appendChild(this.feBlur);
      filter.appendChild(this.feComposite);
      this.svgContainer.appendChild(filter);
      document.documentElement.appendChild(this.svgContainer);
      this._applyFilter();
      return true;
    }
    _sCurve(x, mid, strength) {
      const xm = x - mid;
      const k = strength * 6;
      const curved = xm / (1 + k * Math.abs(xm));
      const normLow = -mid / (1 + k * mid);
      const normHigh = (1 - mid) / (1 + k * (1 - mid));
      const scale = curved < 0 ? mid > 1e-4 ? -mid / normLow : 1 : 1 - mid > 1e-4 ? (1 - mid) / normHigh : 1;
      return mid + curved * scale;
    }
    _updateSvgNodes() {
      const p = this.params;
      if (!p)
        return;
      const table = new Array(256);
      for (let i = 0; i < 256; i++) {
        let val = i / 255;
        val = Math.max(val - p.blackPoint, 0) / Math.max(1 - p.blackPoint, 1e-3);
        val += p.brightness;
        val = this._sCurve(val, p.contrastMid, p.contrastStrength);
        val = val / Math.max(p.whitePoint, 1e-3);
        val = Math.pow(Math.max(val, 1e-3), p.gamma);
        table[i] = Math.max(0, Math.min(1, val)).toFixed(4);
      }
      const tableString = table.join(" ");
      this.feFuncR.setAttribute("tableValues", tableString);
      this.feFuncG.setAttribute("tableValues", tableString);
      this.feFuncB.setAttribute("tableValues", tableString);
      const finalSaturation = p.saturation + p.vibrance * 0.4;
      this.feColorMatrix.setAttribute("values", finalSaturation.toFixed(3));
      this.feColorMatrix.setAttribute("result", "graded");
      if (p.sharpness > 0) {
        this.feBlur.removeAttribute("display");
        this.feComposite.removeAttribute("display");
        const amount = p.sharpness * 1.5;
        this.feBlur.setAttribute("in", "graded");
        this.feComposite.setAttribute("in", "graded");
        this.feComposite.setAttribute("k2", (1 + amount).toFixed(3));
        this.feComposite.setAttribute("k3", (-amount).toFixed(3));
        const radius = 1 + p.sharpness * 0.5;
        this.feBlur.setAttribute("stdDeviation", radius.toFixed(2));
      } else {
        this.feBlur.setAttribute("display", "none");
        this.feComposite.setAttribute("display", "none");
      }
    }
    updateParams(newParams) {
      Object.assign(this.params, newParams);
      if (this.svgContainer)
        this._updateSvgNodes();
    }
    setEnabled(enabled) {
      this.params.enabled = enabled;
      this._applyFilter();
    }
    _applyFilter() {
      if (!this.video)
        return;
      if (this.params.enabled) {
        this.video.style.filter = `url(#${this.filterId})`;
        this.video.style.imageRendering = "auto";
      } else {
        this.video.style.filter = this._originalFilter;
        this.video.style.imageRendering = "auto";
      }
    }
    destroy() {
      if (this.video)
        this.video.style.filter = this._originalFilter;
      if (this.svgContainer)
        this.svgContainer.remove();
      this.video = null;
      this.svgContainer = null;
    }
  };

  // webgl/renderer.js
  var WebGLRenderer = class {
    constructor() {
      this.video = null;
      this.engine = null;
      this.params = {
        blackPoint: 0.03,
        whitePoint: 1,
        gamma: 1,
        saturation: 1.2,
        vibrance: 0.3,
        contrastMid: 0.5,
        contrastStrength: 0.5,
        brightness: 0,
        sharpness: 0.5,
        enabled: true
      };
    }
    async init(video) {
      this.video = video;
      this.engine = new WebGLEngine(() => this._triggerFallback());
      const webglSuccess = await this.engine.init(video);
      if (!webglSuccess) {
        await this._triggerFallback();
      } else {
        console.log("WebGL Spatial Upscaling Engine initialised.");
        this.updateParams(this.params);
      }
      return true;
    }
    async _triggerFallback() {
      console.log("WebGL blocked by DRM/CORS. Falling back to SVG filters.");
      if (this.engine) {
        this.engine.destroy();
      }
      this.engine = new SVGEngine();
      await this.engine.init(this.video);
      this.updateParams(this.params);
    }
    updateParams(newParams) {
      this.params = { ...this.params, ...newParams };
      if (this.engine) {
        this.engine.updateParams(this.params);
      }
    }
    setEnabled(enabled) {
      this.params.enabled = enabled;
      if (this.engine) {
        if (this.engine.setEnabled) {
          this.engine.setEnabled(enabled);
        } else {
          this.engine.updateParams({ enabled });
        }
      }
    }
    destroy() {
      if (this.engine) {
        this.engine.destroy();
        this.engine = null;
      }
      this.video = null;
    }
  };

  // content/content.js
  function scrapeTitle() {
    const host = location.hostname;
    if (host.includes("netflix.com")) {
      const main = document.querySelector('[data-uia="video-title"] .main-title') || document.querySelector('[data-uia="player-title-main"]');
      const sub = document.querySelector('[data-uia="video-title"] .subtitle');
      if (main) {
        const title = main.textContent.trim();
        const ep = sub?.textContent?.trim();
        return ep ? `${title} - ${ep}` : title;
      }
      return document.title.replace(/\s*\|\s*Netflix\s*$/i, "").trim() || "Unknown";
    }
    if (host.includes("crunchyroll.com")) {
      const urlMatch = location.pathname.match(/\/watch\/[^/]+\/([^/?#]+)/);
      const epEl = document.querySelector('[class*="EpisodeTitle"], [class*="episode-title"]');
      const serEl = document.querySelector('[class*="SeriesTitle"],  [class*="series-title"]');
      if (epEl && serEl) {
        return `${serEl.textContent.trim()} - ${epEl.textContent.trim()}`;
      }
      if (epEl)
        return epEl.textContent.trim();
      if (urlMatch) {
        return urlMatch[1].split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      }
      return document.title.replace(/\s*[-|]\s*Crunchyroll\s*$/i, "").trim() || "Unknown";
    }
    if (host.includes("youtube.com")) {
      const title = document.querySelector("h1.ytd-watch-metadata yt-formatted-string") || document.querySelector("#title h1 yt-formatted-string");
      if (title)
        return title.textContent.trim();
      return document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim() || "Unknown";
    }
    return document.title.split(" - ")[0].split(" | ")[0].trim() || "Unknown";
  }
  function buildProfileKey() {
    return `${location.hostname}::${scrapeTitle()}`;
  }
  var VideoEnhancer = class {
    constructor() {
      this.renderer = null;
      this.profileEngine = null;
      this.frameAnalyzer = new FrameAnalyzer();
      this.detector = null;
      this.currentVideo = null;
      this.isEnabled = true;
      this._titleObserver = null;
      this._titleReconnectTimer = null;
    }
    init() {
      chrome.storage.local.get("globalEnabled", ({ globalEnabled }) => {
        this.isEnabled = globalEnabled !== false;
      });
      this._watchTitle();
      this.detector = new VideoDetector({
        onVideoFound: (v) => this._onVideoFound(v),
        onVideoLost: () => this._onVideoLost(),
        onNavigate: (href) => this._onNavigate(href)
      });
      this.detector.start();
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        this._handleMessage(msg, sendResponse);
        return true;
      });
    }
    // ── Video lifecycle ────────────────────────────────────────────────────────
    async _onVideoFound(video) {
      await this._teardown();
      this.currentVideo = video;
      this.renderer = new WebGLRenderer();
      const ok = await this.renderer.init(video);
      if (!ok) {
        console.warn("[VideoEnhancer] Renderer failed to initialise \u2014 site may block WebGL");
        return;
      }
      this.renderer.setEnabled(this.isEnabled);
      this.profileEngine = new ProfileEngine({
        frameAnalyzer: this.frameAnalyzer,
        onParamsUpdated: (params) => this.renderer.updateParams(params)
      });
      await this.profileEngine.start(video, buildProfileKey());
      this._setBadge(this.isEnabled ? "ON" : "OFF", this.isEnabled ? "#4CAF50" : "#9E9E9E");
    }
    _onVideoLost() {
      this._teardown();
    }
    async _onNavigate(_href) {
      await this._teardown();
    }
    async _teardown() {
      clearTimeout(this._titleReconnectTimer);
      this.profileEngine?.stop();
      this.renderer?.destroy();
      this.profileEngine = null;
      this.renderer = null;
      this.currentVideo = null;
    }
    // ── Title observation (episode change detection) ───────────────────────────
    _watchTitle() {
      const titleEl = document.querySelector("title");
      if (!titleEl) {
        this._titleReconnectTimer = setTimeout(() => this._watchTitle(), 2e3);
        return;
      }
      this._titleObserver?.disconnect();
      this._titleObserver = new MutationObserver(() => {
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
        case "GET_STATE": {
          sendResponse({
            isEnabled: this.isEnabled,
            hasVideo: !!this.currentVideo,
            profile: this.profileEngine?.getState() ?? null
          });
          break;
        }
        case "SET_ENABLED": {
          this.isEnabled = msg.enabled;
          this.renderer?.setEnabled(this.isEnabled);
          chrome.storage.local.set({ globalEnabled: this.isEnabled });
          this._setBadge(this.isEnabled ? "ON" : "OFF", this.isEnabled ? "#4CAF50" : "#9E9E9E");
          sendResponse({ ok: true });
          break;
        }
        case "TOGGLE_ENABLED": {
          this.isEnabled = !this.isEnabled;
          this.renderer?.setEnabled(this.isEnabled);
          chrome.storage.local.set({ globalEnabled: this.isEnabled });
          this._setBadge(this.isEnabled ? "ON" : "OFF", this.isEnabled ? "#4CAF50" : "#9E9E9E");
          sendResponse({ isEnabled: this.isEnabled });
          break;
        }
        case "SET_PARAM": {
          this.profileEngine?.applyManualOverride(msg.name, msg.value);
          sendResponse({ ok: true });
          break;
        }
        case "RESET_PARAMS": {
          this.profileEngine?.clearManualOverrides();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    }
    // ── Badge ──────────────────────────────────────────────────────────────────
    _setBadge(text, color) {
      chrome.runtime.sendMessage({ type: "SET_BADGE", text, color });
    }
  };
  var enhancer = new VideoEnhancer();
  enhancer.init();
})();
