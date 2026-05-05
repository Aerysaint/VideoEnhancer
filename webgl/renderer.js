// webgl/renderer.js
// Native SVG Filter Renderer. Kept named WebGLRenderer for backwards compatibility.
// Applies OLED-optimized color grading using native SVG filters.
// Bypasses DRM blocking because it's a CSS presentation layer.
// Restores UI interactivity because there is no overlay canvas.

export class WebGLRenderer {
  constructor() {
    this.video = null;
    this.svgContainer = null;
    this.feTransfer = null;
    this.feColorMatrix = null;
    this.filterId = "";
    this._originalFilter = "";

    this.params = {
      blackPoint: 0.03,
      whitePoint: 1.0,
      gamma: 1.0,
      saturation: 1.2,
      vibrance: 0.3,
      contrastMid: 0.5,
      contrastStrength: 0.5,
      brightness: 0.0,
      sharpness:  0.0,
      enabled:    true,
    };
    
    // HDR Support Detection (Windows Auto-HDR / True HDR Macs)
    this.isHDR = window.matchMedia && window.matchMedia('(dynamic-range: high)').matches;
  }

  // ── Initialisation ─────────────────────────────────────────────────────────

  async init(video) {
    this.video = video;
    this._originalFilter = this.video.style.filter || '';

    // Create the SVG container
    this.svgContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svgContainer.setAttribute("width", "0");
    this.svgContainer.setAttribute("height", "0");
    this.svgContainer.style.position = "fixed";
    this.svgContainer.style.pointerEvents = "none";
    this.svgContainer.style.opacity = "0";
    
    // Create the filter
    this.filterId = "video-enhancer-filter-" + Math.random().toString(36).substr(2, 9);
    
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", this.filterId);
    filter.setAttribute("color-interpolation-filters", "sRGB");

    // Component Transfer for curves (brightness, contrast, gamma)
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

    // Color Matrix for Saturation
    this.feColorMatrix = document.createElementNS("http://www.w3.org/2000/svg", "feColorMatrix");
    this.feColorMatrix.setAttribute("type", "saturate");
    this.feColorMatrix.setAttribute("values", "1.0");

    // Proper Unsharp Mask using Blur + Composite (Replaces feConvolveMatrix for artifact-free sharpening)
    this.feBlur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    this.feBlur.setAttribute("stdDeviation", "1.5");
    this.feBlur.setAttribute("result", "blurred");

    // Math: Sharpened = Original + Amount * (Original - Blurred)
    // In arithmetic composite: k1*i1*i2 + k2*i1 + k3*i2 + k4
    // where i1 = Original (SourceGraphic), i2 = blurred
    // k2 = 1.0 + Amount
    // k3 = -Amount
    this.feComposite = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
    this.feComposite.setAttribute("operator", "arithmetic");
    this.feComposite.setAttribute("in2", "blurred"); // in1 is implicitly the output of feColorMatrix
    this.feComposite.setAttribute("k1", "0");
    this.feComposite.setAttribute("k4", "0");
    
    // HDR color interpolation logic
    if (this.isHDR) {
      filter.setAttribute("color-interpolation-filters", "linearRGB");
    } else {
      filter.setAttribute("color-interpolation-filters", "sRGB");
    }

    filter.appendChild(this.feTransfer);
    filter.appendChild(this.feColorMatrix);
    filter.appendChild(this.feBlur);
    filter.appendChild(this.feComposite);
    this.svgContainer.appendChild(filter);

    document.documentElement.appendChild(this.svgContainer);

    this._updateSvgNodes();
    this._applyFilter();
    
    return true;
  }

  // ── S-Curve Math (matching fragment.glsl) ──────────────────────────────────

  _sCurve(x, mid, strength) {
    const xm = x - mid;
    const k = strength * 6.0;
    const curved = xm / (1.0 + k * Math.abs(xm));

    const normLow = (-mid) / (1.0 + k * mid);
    const normHigh = (1.0 - mid) / (1.0 + k * (1.0 - mid));

    const scale = (curved < 0.0)
      ? (mid > 0.0001 ? -mid / normLow : 1.0)
      : ((1.0 - mid) > 0.0001 ? (1.0 - mid) / normHigh : 1.0);

    return mid + curved * scale;
  }

  // ── Uniform management ─────────────────────────────────────────────────────

  _updateSvgNodes() {
    const p = this.params;
    
    // Generate 256-point lookup table matching the GLSL logic exactly
    const table = new Array(256);
    for (let i = 0; i < 256; i++) {
        let val = i / 255.0;
        
        // 1. Black Point
        val = Math.max(val - p.blackPoint, 0.0) / Math.max(1.0 - p.blackPoint, 0.001);
        
        // 2. Brightness
        val += p.brightness;
        
        // 3. S-Curve Contrast
        val = this._sCurve(val, p.contrastMid, p.contrastStrength);
        
        // 4. White Point
        val = val / Math.max(p.whitePoint, 0.001);
        
        // 5. Gamma
        val = Math.pow(Math.max(val, 0.001), p.gamma);
        
        // Output Clamp
        table[i] = Math.max(0, Math.min(1, val)).toFixed(4);
    }
    
    const tableString = table.join(" ");
    
    // Update SVG properties (Component Transfer)
    this.feFuncR.setAttribute("tableValues", tableString);
    this.feFuncG.setAttribute("tableValues", tableString);
    this.feFuncB.setAttribute("tableValues", tableString);

    // Approximate vibrance + saturation via single saturate matrix
    const finalSaturation = p.saturation + (p.vibrance * 0.4);
    this.feColorMatrix.setAttribute("values", finalSaturation.toFixed(3));
    this.feColorMatrix.setAttribute("result", "graded");

    // Dynamic True Gaussian Unsharp Mask (Replaces basic convolution for 4K crispness)
    if (p.sharpness > 0.0) {
      this.feBlur.removeAttribute("display");
      this.feComposite.removeAttribute("display");
      
      // Calculate unsharp mask intensity. 
      // Multiplier ensures a 0.5 sharpness slider provides a meaningful pop.
      const amount = p.sharpness * 1.5; 
      
      // We apply the blur specifically on the graded layer
      this.feBlur.setAttribute("in", "graded");
      this.feComposite.setAttribute("in", "graded");
      
      // The math: Graded + Amount * (Graded - Blurred)
      // Therefore: Graded * (1 + Amount) + Blurred * (-Amount)
      this.feComposite.setAttribute("k2", (1.0 + amount).toFixed(3));
      this.feComposite.setAttribute("k3", (-amount).toFixed(3));
      
      // Adapt the blur radius depending on how hard we are pushing it
      // A larger radius creates broader local contrast, avoiding fine high-frequency noise
      const radius = 1.0 + (p.sharpness * 0.5);
      this.feBlur.setAttribute("stdDeviation", radius.toFixed(2));
    } else {
      this.feBlur.setAttribute("display", "none");
      this.feComposite.setAttribute("display", "none");
    }
  }

  updateParams(newParams) {
    Object.assign(this.params, newParams);
    if (this.svgContainer) this._updateSvgNodes();
  }

  setEnabled(enabled) {
    this.params.enabled = enabled;
    this._applyFilter();
  }

  _applyFilter() {
    if (!this.video) return;
    if (this.params.enabled) {
      this.video.style.filter = `url(#${this.filterId})`;
      // Force 'auto' scaling. Crisp-edges causes nearest-neighbor pixelation which ruins lower resolution videos on 4K displays.
      // 'auto' allows the GPU to use high-quality Bilinear, Bicubic, or Lanczos interpolation organically.
      this.video.style.imageRendering = 'auto';
    } else {
      this.video.style.filter = this._originalFilter;
      this.video.style.imageRendering = 'auto';
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  destroy() {
    if (this.video) {
        this.video.style.filter = this._originalFilter;
    }
    if (this.svgContainer) {
        this.svgContainer.remove();
    }
    this.video = null;
    this.svgContainer = null;
  }
}

