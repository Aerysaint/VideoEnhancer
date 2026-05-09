// webgl/svg_engine.js
// Native SVG Filter Renderer.
// Applies OLED-optimized color grading using native SVG filters.

export class SVGEngine {
  constructor() {
    this.video = null;
    this.svgContainer = null;
    this.feTransfer = null;
    this.feColorMatrix = null;
    this.filterId = "";
    this._originalFilter = "";

    this.params = {};
    this.isHDR = window.matchMedia && window.matchMedia('(dynamic-range: high)').matches;
  }

  async init(video) {
    this.video = video;
    this._originalFilter = this.video.style.filter || '';

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
    const k = strength * 6.0;
    const curved = xm / (1.0 + k * Math.abs(xm));
    const normLow = (-mid) / (1.0 + k * mid);
    const normHigh = (1.0 - mid) / (1.0 + k * (1.0 - mid));
    const scale = (curved < 0.0)
      ? (mid > 0.0001 ? -mid / normLow : 1.0)
      : ((1.0 - mid) > 0.0001 ? (1.0 - mid) / normHigh : 1.0);
    return mid + curved * scale;
  }

  _updateSvgNodes() {
    const p = this.params;
    if (!p) return;

    const table = new Array(256);
    for (let i = 0; i < 256; i++) {
        let val = i / 255.0;
        val = Math.max(val - p.blackPoint, 0.0) / Math.max(1.0 - p.blackPoint, 0.001);
        val += p.brightness;
        val = this._sCurve(val, p.contrastMid, p.contrastStrength);
        val = val / Math.max(p.whitePoint, 0.001);
        val = Math.pow(Math.max(val, 0.001), p.gamma);
        table[i] = Math.max(0, Math.min(1, val)).toFixed(4);
    }

    const tableString = table.join(" ");
    this.feFuncR.setAttribute("tableValues", tableString);
    this.feFuncG.setAttribute("tableValues", tableString);
    this.feFuncB.setAttribute("tableValues", tableString);

    const finalSaturation = p.saturation + (p.vibrance * 0.4);
    this.feColorMatrix.setAttribute("values", finalSaturation.toFixed(3));      
    this.feColorMatrix.setAttribute("result", "graded");

    if (p.sharpness > 0.0) {
      this.feBlur.removeAttribute("display");
      this.feComposite.removeAttribute("display");
      const amount = p.sharpness * 1.5;
      this.feBlur.setAttribute("in", "graded");
      this.feComposite.setAttribute("in", "graded");
      this.feComposite.setAttribute("k2", (1.0 + amount).toFixed(3));
      this.feComposite.setAttribute("k3", (-amount).toFixed(3));
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
      this.video.style.imageRendering = 'auto';
    } else {
      this.video.style.filter = this._originalFilter;
      this.video.style.imageRendering = 'auto';
    }
  }

  destroy() {
    if (this.video) this.video.style.filter = this._originalFilter;
    if (this.svgContainer) this.svgContainer.remove();
    this.video = null;
    this.svgContainer = null;
  }
}
