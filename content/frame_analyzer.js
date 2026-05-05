// content/frame_analyzer.js
// Samples a downscaled (128×128) copy of the current video frame and computes
// luminance + saturation histograms, skin-tone detection, and key statistics.
//
// Deliberately runs on a SEPARATE timer (not the WebGL rAF render loop) to
// avoid GPU readback stalls. willReadFrequently is set on the 2D context.

export class FrameAnalyzer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width  = 128;
    this.canvas.height = 128;
    this.canvas.dataset.enhancerIgnore = 'true';
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  // Returns an analysis result object, or null if the frame isn't ready.
  analyzeFrame(video) {
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
    if (this.drmActive) return null;

    try {
      this.ctx.drawImage(video, 0, 0, 128, 128);
      const imageData = this.ctx.getImageData(0, 0, 128, 128);
      return this._compute(imageData);
    } catch (e) {
      // SecurityError on some edge-case CORS configs or DRM content
      this.drmActive = true;
      return null;
    }
  }

  _compute(imageData) {
    const data = imageData.data;   // Uint8ClampedArray, RGBA interleaved
    const N    = 128 * 128;        // total pixels

    const lumHist = new Float32Array(256);  // luminance histogram (256 bins)
    const satHist = new Float32Array(64);   // saturation histogram (64 bins)

    let blackPx = 0;       // L < 0.05
    let shadowPx = 0;      // L < 0.25
    let highlightPx = 0;   // L > 0.90
    let satSum = 0;
    let satSqSum = 0;
    let skinPx = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]     / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;

      // Rec. 709 luminance
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumHist[Math.min(255, lum * 255 | 0)]++;

      // HSL saturation + hue
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const delta = maxC - minC;
      const l = (maxC + minC) * 0.5;
      const sat = delta < 0.0001 ? 0 : delta / (1 - Math.abs(2 * l - 1));

      let hue = 0;
      if (delta > 0.0001) {
        if (maxC === r)      hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        else if (maxC === g) hue = ((b - r) / delta + 2) / 6;
        else                 hue = ((r - g) / delta + 4) / 6;
      }

      satHist[Math.min(63, sat * 64 | 0)]++;
      satSum   += sat;
      satSqSum += sat * sat;

      if (lum < 0.05) blackPx++;
      if (lum < 0.25) shadowPx++;
      if (lum > 0.90) highlightPx++;

      // Skin-tone: hue 10°–40° (0.028–0.111), moderate sat, mid lightness.
      if (hue >= 0.028 && hue <= 0.111 && sat > 0.15 && l > 0.25 && l < 0.75) skinPx++;
    }

    // Normalise histograms.
    for (let i = 0; i < 256; i++) lumHist[i] /= N;
    for (let i = 0; i < 64;  i++) satHist[i] /= N;

    const meanSat = satSum / N;
    const satVar  = satSqSum / N - meanSat * meanSat;

    // Luminance percentiles via CDF walk.
    const lumP10 = this._percentile(lumHist, 0.10);
    const lumP50 = this._percentile(lumHist, 0.50);
    const lumP90 = this._percentile(lumHist, 0.90);

    // Bimodal saturation: mass above 0.40 AND mass below 0.11.
    // Anime: high-sat color regions + near-zero-sat outlines/sky = bimodal.
    const highSatMass = satHist.slice(26).reduce((a, b) => a + b, 0);  // sat > 0.40
    const lowSatMass  = satHist.slice(0, 7).reduce((a, b) => a + b, 0); // sat < 0.11
    const isBimodal   = highSatMass > 0.25 && lowSatMass > 0.20;

    return {
      blackLevelPct:  blackPx    / N,
      shadowPct:      shadowPx   / N,
      highlightPct:   highlightPx / N,
      skinTonePct:    skinPx     / N,
      meanSaturation: meanSat,
      satVariance:    satVar,
      highSatMass,
      lumP10,
      lumP50,
      lumP90,
      isBimodalSat:   isBimodal,
      timestamp:      Date.now(),
    };
  }

  _percentile(hist, p) {
    let cum = 0;
    for (let i = 0; i < hist.length; i++) {
      cum += hist[i];
      if (cum >= p) return i / 255;
    }
    return 1.0;
  }

  destroy() {
    this.ctx = null;
    this.canvas = null;
  }
}
