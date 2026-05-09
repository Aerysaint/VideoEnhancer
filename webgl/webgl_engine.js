// webgl/webgl_engine.js

export class WebGLEngine {
  constructor() {
    this.video = null;
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.animationFrameId = null;
    this.params = {};
    
    // ResizeObserver to keep canvas snapped to the video
    this.resizeObserver = null;
  }

  async init(video) {
    this.video = video;

    // Create the canvas
    this.canvas = document.createElement('canvas');
    this.canvas.dataset.enhancerCanvas = 'true';
    this.canvas.style.position = 'absolute';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '99999';

    // Inject canvas into DOM exactly next to the video
    // To handle UI overlays, we insert it right after the video.
    // If the video's parent handles z-indexes weirdly, this usually works best.
    if (this.video.parentNode) {
      this.video.parentNode.insertBefore(this.canvas, this.video.nextSibling);
    }

    const isHDR = window.matchMedia && window.matchMedia('(dynamic-range: high)').matches;
    
    this.gl = this.canvas.getContext('webgl2', { 
        alpha: false, 
        antialias: false,
        colorSpace: isHDR ? 'display-p3' : 'srgb'
    });

    if (!this.gl) {
       this.destroy();
       return false;
    }

    // Attempt to compile shaders and upload first frame to check for DRM
    const success = await this._setupGL();
    if (!success) {
      this.destroy();
      return false; // Fallback to SVG
    }

    // Hide original video but keep it playing
    this.video.style.opacity = '0.001';

    // Sync canvas size to video size
    this._syncRect();
    this.resizeObserver = new ResizeObserver(() => this._syncRect());
    this.resizeObserver.observe(this.video);

    this._renderLoop = this._renderLoop.bind(this);
    this.animationFrameId = requestAnimationFrame(this._renderLoop);

    return true;
  }

  _syncRect() {
      if (!this.video || !this.canvas) return;
      const rect = this.video.getBoundingClientRect();
      const style = window.getComputedStyle(this.video);
      
      this.canvas.style.left = this.video.offsetLeft + 'px';
      this.canvas.style.top = this.video.offsetTop + 'px';
      this.canvas.style.width = style.width;
      this.canvas.style.height = style.height;
      this.canvas.style.margin = style.margin;
      this.canvas.style.transform = style.transform;
      this.canvas.style.objectFit = style.objectFit;
      
      // Upscale ratio for FSR-style detail. 1.5x gives great quality vs performance.
      const upscaleFactor = 1.5; 
      this.canvas.width = this.video.videoWidth * upscaleFactor || rect.width * upscaleFactor;
      this.canvas.height = this.video.videoHeight * upscaleFactor || rect.height * upscaleFactor;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  async _setupGL() {
    const gl = this.gl;

    // A simple full-screen quad vertex shader
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
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1
    ]), gl.STATIC_DRAW);

    const a_position = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(a_position);
    gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Initial texture upload to check for DRM (CORS/SecurityError)
    try {
        if (this.video.readyState >= 2) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
        } else {
          // If video isn't ready, pass a tiny blank buffer just to init the texture correctly
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
        }
    } catch (e) {
        console.error('WebGL Texture Upload failed. This is likely a DRM restriction:', e);
        return false; // Fallback to SVG engine
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
    if (!this.video || !this.gl) return;
    const gl = this.gl;

    if (this.video.readyState >= 2 && !this.video.paused && !this.video.ended) {
        try {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
        } catch(e) {
            // DRM might have kicked in later, or cross-origin change
            console.error('Texture upload failed mid-stream.', e);
        }
    }

    gl.useProgram(this.program);

    gl.uniform2f(gl.getUniformLocation(this.program, 'u_texResolution'), this.video.videoWidth || 1, this.video.videoHeight || 1);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_blackPoint'), this.params.blackPoint ?? 0.03);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_whitePoint'), this.params.whitePoint ?? 1.0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gamma'), this.params.gamma ?? 1.0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_saturation'), this.params.saturation ?? 1.2);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_vibrance'), this.params.vibrance ?? 0.3);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_contrastMid'), this.params.contrastMid ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_contrastStrength'), this.params.contrastStrength ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_brightness'), this.params.brightness ?? 0.0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_sharpness'), this.params.sharpness ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_enabled'), this.params.enabled ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.animationFrameId = requestAnimationFrame(this._renderLoop);
  }

  destroy() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    
    if (this.video) {
        this.video.style.opacity = '1.0';
    }
    
    if (this.canvas) {
        this.canvas.remove();
    }
    
    this.video = null;
    this.canvas = null;
    this.gl = null;
    this.program = null;
  }
}

