// webgl/shaders/fragment.glsl
// OLED-optimized color grading shader.
//
// Pipeline: black crush → brightness → S-curve contrast → white point
//           → gamma → saturation (HSL) → vibrance → clamp
//
// All parameters are exposed as uniforms so the JS side can update them
// without recompiling the shader.

precision mediump float;

uniform sampler2D u_texture;

// ── Grading parameters ───────────────────────────────────────────────────────
uniform float u_blackPoint;       // [0.0 – 0.15]  Crush near-blacks to pure black
uniform float u_whitePoint;       // [0.80 – 1.05] Compress highlight headroom
uniform float u_gamma;            // [0.70 – 1.30] Midtone power curve (< 1 = darker)
uniform float u_saturation;       // [0.50 – 2.00] Global saturation multiplier
uniform float u_vibrance;         // [0.00 – 1.00] Smart selective saturation boost
uniform float u_contrastMid;      // [0.30 – 0.70] S-curve inflection point
uniform float u_contrastStrength; // [0.00 – 1.00] S-curve aggressiveness
uniform float u_brightness;       // [-0.30 – 0.30] Additive brightness offset
uniform float u_enabled;          // 1.0 = grade, 0.0 = passthrough

varying vec2 v_texCoord;

// ── RGB ↔ HSL conversion ─────────────────────────────────────────────────────

vec3 rgb2hsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float delta = maxC - minC;
  float l = (maxC + minC) * 0.5;

  if (delta < 0.0001) {
    return vec3(0.0, 0.0, l);
  }

  float s = l > 0.5
    ? delta / (2.0 - maxC - minC)
    : delta / (maxC + minC);

  float h;
  if (maxC == c.r) {
    h = (c.g - c.b) / delta;
    if (c.g < c.b) h += 6.0;
  } else if (maxC == c.g) {
    h = (c.b - c.r) / delta + 2.0;
  } else {
    h = (c.r - c.g) / delta + 4.0;
  }
  h /= 6.0;

  return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5)        return q;
  if (t < 2.0 / 3.0)  return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 c) {
  if (c.y < 0.0001) {
    return vec3(c.z);
  }
  float q = c.z < 0.5
    ? c.z * (1.0 + c.y)
    : c.z + c.y - c.z * c.y;
  float p = 2.0 * c.z - q;
  return vec3(
    hue2rgb(p, q, c.x + 1.0 / 3.0),
    hue2rgb(p, q, c.x),
    hue2rgb(p, q, c.x - 1.0 / 3.0)
  );
}

// ── S-curve via rational sigmoid ──────────────────────────────────────────────
// f(x) = x / (1 + k * |x|) centered at `mid`.
// Passes through (0,0) and (1,1). Strength 0 = linear, 1 = aggressive.
// Applied per-channel for the "color punch" OLED look.
// For a more naturalistic look, applying only to luminance is optional.

float sCurve(float x, float mid, float strength) {
  float xm = x - mid;
  float k = strength * 6.0;
  float curved = xm / (1.0 + k * abs(xm));

  // Renormalise so endpoints map correctly even as k varies.
  float normLow  = (-mid)       / (1.0 + k * mid);
  float normHigh = (1.0 - mid)  / (1.0 + k * (1.0 - mid));

  float scale = (curved < 0.0)
    ? (mid > 0.0001 ? -mid / normLow : 1.0)
    : ((1.0 - mid) > 0.0001 ? (1.0 - mid) / normHigh : 1.0);

  return mid + curved * scale;
}

// ── Main ──────────────────────────────────────────────────────────────────────

void main() {
  vec4 texColor = texture2D(u_texture, v_texCoord);
  vec3 color = texColor.rgb;

  // Passthrough when disabled — no teardown, just identity.
  if (u_enabled < 0.5) {
    gl_FragColor = texColor;
    return;
  }

  // ── 1. Black Point Crush ───────────────────────────────────────────────────
  // Remap [blackPoint, 1] → [0, 1]. Drives near-black pixels to true black.
  // This is the most impactful step for OLED: near-black → absolute black = off pixel.
  color = max(color - vec3(u_blackPoint), vec3(0.0));
  color = color / max(1.0 - u_blackPoint, 0.001);

  // ── 2. Brightness ──────────────────────────────────────────────────────────
  color += vec3(u_brightness);

  // ── 3. S-Curve Contrast (per-channel) ─────────────────────────────────────
  // Per-channel S-curve (vs. luminance-only) produces the punchy color-pop
  // look seen in cinematic anime edits — it naturally boosts saturation
  // slightly in the shadows/highlights where complements diverge.
  color.r = sCurve(color.r, u_contrastMid, u_contrastStrength);
  color.g = sCurve(color.g, u_contrastMid, u_contrastStrength);
  color.b = sCurve(color.b, u_contrastMid, u_contrastStrength);

  // ── 4. White Point ─────────────────────────────────────────────────────────
  color = color / max(u_whitePoint, 0.001);

  // ── 5. Gamma ───────────────────────────────────────────────────────────────
  // Gamma < 1 darkens midtones (more punch, cinematic look on OLED).
  // max() guards against NaN from negative values after crush + contrast.
  color = pow(max(color, vec3(0.001)), vec3(u_gamma));

  // ── 6. Saturation (HSL) ────────────────────────────────────────────────────
  vec3 hsl = rgb2hsl(color);
  hsl.y = clamp(hsl.y * u_saturation, 0.0, 1.0);
  color = hsl2rgb(hsl);

  // ── 7. Vibrance ────────────────────────────────────────────────────────────
  // Vibrance = adaptive saturation: boosts desaturated pixels more than
  // already-vivid ones. Formula: boost = vibrance * (1 - currentSat).
  // This protects skin tones and avoids blowing out primary colors.
  vec3 hsl2 = rgb2hsl(color);
  float satLift = u_vibrance * (1.0 - hsl2.y);
  hsl2.y = clamp(hsl2.y + satLift * 0.6, 0.0, 1.0);
  color = hsl2rgb(hsl2);

  // ── 8. Clamp & output ──────────────────────────────────────────────────────
  color = clamp(color, 0.0, 1.0);
  gl_FragColor = vec4(color, texColor.a);
}
