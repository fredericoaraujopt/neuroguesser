// EM format 2 viewer: GLSL ES 3.0 sources (three ShaderMaterial, glslVersion GLSL3). Spec: em-v2-spec.md §8.2, §9.
// Every quad is the unit square (0…1)², placed by its object matrix; vUv runs down the image (row 0 at v = 0), so a
// texture uploaded with flipY = false is sampled without any flip. ShaderMaterials write raw values: the EM grey
// levels reach the screen exactly (no colour-space conversion, no tone mapping, no blending).

export const QUAD_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * One EM image (or one tile of an atlas): uTile = (origin x, origin y, width, height) in texels of uTex (uTexSize).
 * LOD: texel_dev = device px per texel along the most minified axis (1 / fwidth); a non-coarsest quad discards where
 * texel_dev < 0.5, so the next coarser level shows (≤ 2× minification without mipmaps). Magnified ≥ 2×: nearest, i.e.
 * honest square voxels as in Neuroglancer; below that, bilinear. t is clamped half a texel inside the tile, so atlas
 * tiles never bleed into each other. uTranspose: the YZ panel shows z right and y down, the image stores y along its
 * columns. uScrim: a luminance-only scrim towards surface-sunken outside uScrimRect (local uv), for XY levels whose
 * section is not the one on screen. uSolid.a > 0.5: a flat colour (a lost section: surface-sunken).
 */
export const QUAD_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec4 uTile;
uniform float uTranspose;
uniform float uCoarsest;
uniform vec4 uSolid;
uniform vec4 uScrimRect;
uniform float uScrim;
uniform float uScrimGrey;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = uTranspose > 0.5 ? vUv.yx : vUv;
  vec2 t = uv * uTile.zw;
  vec2 fw = fwidth(t);
  float texelDev = 1.0 / max(max(fw.x, fw.y), 1e-8);
  if (uSolid.a > 0.5) { outColor = vec4(uSolid.rgb, 1.0); return; }
  if (uCoarsest < 0.5 && texelDev < 0.5) discard;
  if (texelDev >= 2.0) t = floor(t) + 0.5;
  t = clamp(t, vec2(0.5), uTile.zw - 0.5);
  float g = texture(uTex, (uTile.xy + t) / uTexSize).r;
  if (uScrim > 0.0) {
    bool inside = vUv.x >= uScrimRect.x && vUv.y >= uScrimRect.y && vUv.x <= uScrimRect.z && vUv.y <= uScrimRect.w;
    if (!inside) g = mix(g, uScrimGrey, uScrim);
  }
  outColor = vec4(vec3(g), 1.0);
}`;

/** Mesh coverage into an R8 target (the footprint): any covered fragment writes 1. */
export const COVER_VERT = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
export const COVER_FRAG = /* glsl */ `
precision mediump float;
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

/**
 * Footprint contour: a 1 device px line where a covered texel of the coverage target has an uncovered neighbour one
 * device px away (nearest lookups, so the contour follows the footprint's texels). Drawn after the EM, blended; the EM
 * pixels themselves are never touched (no fill).
 */
export const CONTOUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uFoot;
uniform vec2 uFootSize;
uniform vec3 uColor;
uniform float uAlpha;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
float cover(vec2 t) {
  ivec2 p = ivec2(floor(t));
  if (p.x < 0 || p.y < 0 || p.x >= int(uFootSize.x) || p.y >= int(uFootSize.y)) return 0.0;
  return texelFetch(uFoot, p, 0).r;
}
void main() {
  vec2 t = vUv * uFootSize;
  vec2 dx = dFdx(t);
  vec2 dy = dFdy(t);
  if (uAlpha <= 0.0) discard;
  float c = cover(t);
  if (c < 0.5) discard;
  float n = min(min(cover(t + dx), cover(t - dx)), min(cover(t + dy), cover(t - dy)));
  if (n >= 0.5) discard;
  outColor = vec4(uColor, uAlpha);
}`;

/** Plane frames and the stack frame in 3D: a flat display-space colour (the renderer writes it as is). */
export const LINE_VERT = COVER_VERT;
export const LINE_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uColor;
uniform float uAlpha;
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(uColor, uAlpha); }`;

/** The neuron in the 3D panel: a soft Lambert in the outline's data-orange (stage.js), written in display space. */
export const MESH_VERT = /* glsl */ `
uniform float uInflate;   // µm along the normal (≈ 1 device px): neurites thinner than a pixel stay visible
out vec3 vN;
void main() {
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uInflate, 1.0);
}`;
export const MESH_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
in vec3 vN;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 key = normalize(vec3(0.6, 1.0, 1.2));
  float lam = max(dot(n, key), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  float k = 0.42 + 0.38 * lam + 0.2 * hemi;
  outColor = vec4(uColor * clamp(k, 0.0, 1.0), 1.0);
}`;
