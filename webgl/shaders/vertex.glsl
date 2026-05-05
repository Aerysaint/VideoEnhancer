// webgl/shaders/vertex.glsl
// Pass-through vertex shader for a full-screen quad.
// Input geometry is two triangles covering clip-space [-1, 1].

attribute vec2 a_position;
varying vec2 v_texCoord;

void main() {
  // Convert clip-space [-1,1] to UV [0,1].
  // Flip Y because WebGL texture origin is bottom-left, video is top-left.
  v_texCoord = vec2(
    (a_position.x + 1.0) * 0.5,
    1.0 - (a_position.y + 1.0) * 0.5
  );
  gl_Position = vec4(a_position, 0.0, 1.0);
}
