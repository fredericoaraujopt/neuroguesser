// Shared three.js plumbing for the viewers (ARCHITECTURE.md §4.4): renderer factory (DPR capped at 2),
// orthographic camera + fit, resize observer, GLB parsing (+ meshopt decoder), client-side normals,
// Charcoal data materials, on-demand render loop, disposal. Units are µm everywhere (assets.md).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export { THREE, Line2, LineSegments2, LineGeometry, LineSegmentsGeometry, LineMaterial };

/** Charcoal app-dark values (css/tokens.css). data-* only inside data areas. */
export const COLORS = Object.freeze({
  sunken: 0x171e29,
  canvas: 0x1c222b,
  ink: 0xeceff3,
  dataBlack: 0xeceff3,
  dataOrange: 0xdf9a00,
  dataSky: 0x50afe3,
  inkMuted: 0x8593a9,
});

export const MAX_DPR = 2;

/** WebGL renderer appended to container (canvas fills it). Returns null when WebGL is unavailable. */
export function createRenderer(container, { alpha = false, antialias = true } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias, alpha, powerPreference: 'low-power', preserveDrawingBuffer: false });
  } catch (err) {
    console.warn('[viewer] WebGL unavailable', err);
    return null;
  }
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, MAX_DPR));
  renderer.setClearColor(COLORS.sunken, alpha ? 0 : 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);
  const { width, height } = container.getBoundingClientRect();
  renderer.setSize(Math.max(1, width), Math.max(1, height), false);
  return renderer;
}

/** Orthographic camera looking down −Z (+Y up), frustum `viewHeight` µm tall. */
export function createOrthoCamera(aspect = 1, viewHeight = 100) {
  const h = viewHeight / 2;
  const cam = new THREE.OrthographicCamera(-h * aspect, h * aspect, h, -h, -1e5, 1e5);
  cam.position.set(0, 0, 1000);
  cam.lookAt(0, 0, 0);
  return cam;
}

/** Fit an ortho camera to a Box3 (or bbox_um array [x0,y0,z0,x1,y1,z1]) with a margin (0.86 fills 86%). */
export function fitOrtho(camera, box, aspect, fill = 0.86) {
  const b = Array.isArray(box) ? new THREE.Box3(new THREE.Vector3(box[0], box[1], box[2]), new THREE.Vector3(box[3], box[4], box[5])) : box;
  const size = b.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1e-3);   // rotation-safe: the bounding sphere
  const half = radius / fill;
  const a = aspect > 0 ? aspect : 1;
  const h = a >= 1 ? half : half / a;
  camera.left = -h * a; camera.right = h * a; camera.top = h; camera.bottom = -h;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  return b.getCenter(new THREE.Vector3());
}

/** Keep camera aspect in sync with the container; returns disconnect(). */
export function observeResize(container, onResize) {
  if (typeof ResizeObserver === 'undefined') {
    const fn = () => { const r = container.getBoundingClientRect(); onResize(r.width, r.height); };
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }
  const ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    if (r.width > 0 && r.height > 0) onResize(r.width, r.height);
  });
  ro.observe(container);
  return () => ro.disconnect();
}

/** Resize renderer + ortho camera, keeping the vertical extent. */
export function resizeOrtho(renderer, camera, width, height) {
  renderer.setSize(Math.max(1, width), Math.max(1, height), false);
  const aspect = width / Math.max(1, height);
  const h = (camera.top - camera.bottom) / 2;
  const cx = (camera.left + camera.right) / 2;
  camera.left = cx - h * aspect; camera.right = cx + h * aspect;
  camera.updateProjectionMatrix();
  for (const m of LINE_MATERIALS) m.resolution.set(width, height);
}

let loader = null;
function gltfLoader() {
  if (!loader) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

/** Parse a GLB ArrayBuffer (api.assetArrayBuffer) → THREE.Group (gltf.scene). */
export function parseGLB(arrayBuffer) {
  return new Promise((resolve, reject) => {
    gltfLoader().parse(arrayBuffer, '', (gltf) => resolve(gltf.scene), reject);
  });
}

/** The GLB profile ships no NORMAL attribute: compute smooth normals for every mesh in obj. */
export function computeNormals(obj) {
  obj.traverse((o) => {
    if (o.isMesh && o.geometry && !o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
  });
  return obj;
}

/** Bounds of an object in world space. */
export function boundsOf(obj) { return new THREE.Box3().setFromObject(obj); }

const LINE_MATERIALS = new Set();

/**
 * Charcoal data materials (assets.md / ARCHITECTURE §3):
 *  'neuron'        shaded surface, data-black (v1.1: always single colour)
 *  'axon'          shaded surface, data-orange (reveal assets only)
 *  'context-face'  ink faces; opts.style 'box' → 3.5% / 'surface' → ~10%, depth-write off
 *  'context-edge'  ink edges @35%
 *  'layer'         dashed ink @22% (call line.computeLineDistances())
 *  'siblings'      data-sky @55% lines (fat lines: opts.width px)
 *  'mask'          data-orange @32% (EM overlay)
 */
export function dataMaterial(kind, opts = {}) {
  switch (kind) {
    case 'neuron':
      return new THREE.MeshLambertMaterial({ color: COLORS.dataBlack, side: THREE.DoubleSide });
    case 'axon':
      return new THREE.MeshLambertMaterial({ color: COLORS.dataOrange, side: THREE.DoubleSide });
    case 'context-face':
      return new THREE.MeshBasicMaterial({
        color: COLORS.ink, transparent: true, opacity: opts.style === 'box' ? 0.035 : 0.10,
        depthWrite: false, side: THREE.DoubleSide,
      });
    case 'context-edge':
      return new THREE.LineBasicMaterial({ color: COLORS.ink, transparent: true, opacity: 0.35, depthWrite: false });
    case 'layer':
      return new THREE.LineDashedMaterial({ color: COLORS.ink, transparent: true, opacity: 0.22, dashSize: opts.dash || 6, gapSize: opts.gap || 6, depthWrite: false });
    case 'siblings': {
      if (opts.width) {
        const m = new LineMaterial({ color: COLORS.dataSky, linewidth: opts.width, transparent: true, opacity: 0.55, depthWrite: false });
        LINE_MATERIALS.add(m);
        return m;
      }
      return new THREE.LineBasicMaterial({ color: COLORS.dataSky, transparent: true, opacity: 0.55, depthWrite: false });
    }
    case 'mask':
      return new THREE.MeshBasicMaterial({ color: COLORS.dataOrange, transparent: true, opacity: 0.32, depthWrite: false });
    default:
      throw new Error(`unknown data material: ${kind}`);
  }
}

/** Soft key + fill lighting for the shaded neuron surface (no shadows, Charcoal). */
export function addLights(scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x3a4250, 1.1);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.6, 1, 1.2);
  scene.add(hemi, key);
  return { hemi, key };
}

/**
 * On-demand render loop: invalidate() schedules one frame; setContinuous(true) renders every frame
 * (auto-rotate, animations). tick(dtSeconds) runs before each render.
 */
export function createRenderLoop(render, { tick } = {}) {
  let raf = 0;
  let continuous = false;
  let last = 0;
  let disposed = false;
  const frame = (t) => {
    raf = 0;
    if (disposed) return;
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    if (tick) tick(dt);
    render();
    if (continuous) raf = requestAnimationFrame(frame);
    else last = 0;
  };
  return {
    invalidate() { if (!raf && !disposed) raf = requestAnimationFrame(frame); },
    setContinuous(on) { continuous = !!on; if (on) this.invalidate(); },
    get continuous() { return continuous; },
    dispose() { disposed = true; if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
}

/** Dispose geometries, materials and textures under obj (and remove it from its parent). */
export function disposeObject(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      LINE_MATERIALS.delete(m);
      m.dispose();
    }
  });
  if (obj.parent) obj.parent.remove(obj);
}

/** Dispose a renderer and remove its canvas. */
export function disposeRenderer(renderer) {
  if (!renderer) return;
  renderer.dispose();
  if (renderer.forceContextLoss) renderer.forceContextLoss();
  const c = renderer.domElement;
  if (c && c.parentNode) c.parentNode.removeChild(c);
}

/** Tap vs drag (handoff: < 4 px movement counts as a tap). */
export const TAP_SLOP_PX = 4;
export const AUTO_ROTATE_RAD_S = 0.28;
