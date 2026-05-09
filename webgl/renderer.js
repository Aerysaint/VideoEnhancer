// webgl/renderer.js
// Hybrid Renderer Orchestrator:
// Path A: Tries WebGL2 (Spatial Upscaling + Sharpening + HDR Grading)
// Path B: Falls back to SVG Filters for DRM-protected videos (Netflix)

import { WebGLEngine } from './webgl_engine.js';
import { SVGEngine } from './svg_engine.js';

export class WebGLRenderer {
  constructor() {
    this.video = null;
    this.engine = null;
    this.params = {
      blackPoint: 0.03,
      whitePoint: 1.0,
      gamma: 1.0,
      saturation: 1.2,
      vibrance: 0.3,
      contrastMid: 0.5,
      contrastStrength: 0.5,
      brightness: 0.0,
      sharpness: 0.5,
      enabled: true,
    };
  }

  async init(video) {
    this.video = video;

    this.engine = new WebGLEngine();
    const webglSuccess = await this.engine.init(video);

    if (!webglSuccess) {
      console.log('WebGL blocked by DRM/CORS. Falling back to SVG filters.');
      this.engine = new SVGEngine();
      await this.engine.init(video);
    } else {
      console.log('WebGL Spatial Upscaling Engine initialised.');
    }

    this.updateParams(this.params);
    return true;
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
}
