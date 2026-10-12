// EM format 2: the mesh footprint (em-v2-spec.md §8.2 "Footprint"). One-off orthographic projections of the public
// mesh (EM-local nm) into R8 coverage targets: along z over the coarsest XY level, along y over the XZ context rect,
// along x over the YZ context rect (≤ 3 renders of ≤ 50k triangles). The 2D panels then draw a 1 device px
// data-black contour where covered meets uncovered (shaders.js CONTOUR_FRAG), faded in at cell zoom.
import * as THREE from 'three';
import { COVER_VERT, COVER_FRAG } from './shaders.js';

export const FOOTPRINT_MAX_PX = 1024;

/** Coordinate permutation per projection: panel (h, v, depth) from EM-local (x, y, z). */
const PERMUTE = {
  xy: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],    // (x, y, z)
  xz: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0],    // (x, z, y)
  yz: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0],    // (z, y, x)
};

/** Target size for a rect: the long side 1024 px, the other in proportion (≥ 16). */
export function footprintSize(rect, max = FOOTPRINT_MAX_PX) {
  const w = Math.abs(rect[2] - rect[0]);
  const h = Math.abs(rect[3] - rect[1]);
  if (!(w > 0) || !(h > 0)) return [16, 16];
  return w >= h ? [max, Math.max(16, Math.round((max * h) / w))] : [Math.max(16, Math.round((max * w) / h)), max];
}

/**
 * Render the coverage of `geometry` (EM-local nm) seen along the plane's normal into an R8 target covering
 * rect = [h0, v0, h1, v1] (panel coordinates; row 0 of the target is v0, as in the EM images).
 * → { target, rect, size } (target.texture is sampled with texelFetch).
 */
export function renderFootprint(renderer, geometry, plane, rect, max = FOOTPRINT_MAX_PX) {
  const size = footprintSize(rect, max);
  const target = new THREE.WebGLRenderTarget(size[0], size[1], {
    format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  drawInto(renderer, target, geometry, plane, rect);
  return { target, rect: [...rect], size, plane };
}

/** (Re)draw a footprint target (also after a context restore). */
export function drawInto(renderer, target, geometry, plane, rect) {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: COVER_VERT, fragmentShader: COVER_FRAG,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.matrixAutoUpdate = false;
  const m = PERMUTE[plane] || PERMUTE.xy;
  mesh.matrix.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(rect[0], rect[2], rect[3], rect[1], -1e9, 1e9);
  cam.position.set(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  const prevTarget = renderer.getRenderTarget();
  const prevScissor = renderer.getScissorTest();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setScissorTest(false);
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.setScissorTest(prevScissor);
  mat.dispose();
}
