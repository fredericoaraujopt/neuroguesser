// MeshViewer (ARCHITECTURE.md §4.4): three.js, orthographic, the neuron GLB as a shaded data-black surface
// (normals computed here: the GLB profile ships none), auto-rotating ≈0.28 rad/s until the first touch (never
// under reduced motion / Celebrations off), drag → yaw/tilt (tilt clamped ±1.4 rad) or pan, zoom 0.5–8× by
// wheel, pinch (2 pointers) or zoomBy(), tap (< 4 px) callback, onChange({ pxPerUm, … }) for scale bars,
// render on demand.
//
// Context (assets.md "Shared frame"): setContext({ volume, labels, offsetUm }) draws the context volume per
// labels.volume_style (box: faces ink @3.5 % + edges @35 %; surface: faces ink @~10 %, depth-write off), the
// layer planes dashed ink @22 % with HTML-overlay labels, neuropil points as small labels, places the neuron at
// offsetUm in the context frame and frames the camera on the context bbox (animated zoom-out). setSiblings()
// adds the reveal's same-type cells (LINES → 0.5 px data-sky @35 % fat lines; TRIANGLES → lower still).
//
// Today's cell stays dominant in context (W4): its surface is inflated along the normals so every process is at
// least CELL_MIN_PX wide on screen (a 1 µm dendrite in a 1 mm volume is otherwise sub-pixel and vanishes while the
// fat-line siblings stay visible); in context a dark keyline (HALO_PX, surface-sunken) is drawn under it, after
// the siblings, and the soma marker stays on until the soma itself is large on screen. Labels go through a
// screen-space collision pass each frame they move (nearest to today's cell first; a label that cannot sit to
// the right or left of its anchor without overlapping a kept one, or the soma marker, is hidden).
//
// View units: yaw/tilt in rad (tilt > 0 tips the top towards the viewer); zoom 1 = fitted; panX/panY = screen-
// aligned shift of the specimen in µm (+x right, +y up). Auto-rotation alone does not emit onChange (scale bars
// only depend on pxPerUm); every other change does, at most once per rendered frame.
import {
  THREE, LineSegments2, LineSegmentsGeometry, COLORS, MAX_DPR, TAP_SLOP_PX, AUTO_ROTATE_RAD_S,
  createRenderer, createOrthoCamera, parseGLB, dataMaterial, addLights, createRenderLoop, disposeObject,
  disposeRenderer, observeResize,
} from './three-common.js';
import { loadCss } from '../ui/html.js';
import { motionAllowed } from '../fx/celebrate.js';

loadCss('css/viewer.css');

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/viewer-mesh.test.js)

export const DEFAULT_VIEW = Object.freeze({ yaw: 0, tilt: 0.22, zoom: 1, panX: 0, panY: 0 });
/** A 3/4 view so a box or brain outline reads as a volume (used when the viewer frames a context untouched). */
export const CONTEXT_VIEW = Object.freeze({ yaw: -0.5, tilt: 0.3, zoom: 1, panX: 0, panY: 0 });
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 8;
export const TILT_MAX = 1.4;
export const FILL = 0.86;            // the fitted specimen fills ≈86 % of the frame (thumbnail rule, assets.md)
export const YAW_PER_PX = 0.012;     // handoff prototype drag rates
export const TILT_PER_PX = 0.01;
export const DASH_PX = 3;            // layer planes: 3 px dash, 3 px gap (handoff)
export const SIBLING_LINE_PX = 0.5;
export const SIBLING_OPACITY = 0.35;     // data-sky ≤ 45 %: a dozen overlapping siblings never bury today's cell
export const SIBLING_TRI_OPACITY = 0.2;  // sibling meshes (no skeleton): faces stack, so lower still
export const CELL_MIN_PX = 1.4;          // today's cell: every process at least this wide on screen
export const HALO_PX = 1.5;              // in context: dark keyline around today's cell, over the siblings
export const SOMA_MARKER_MAX_PX_PER_UM = 1;   // soma marker shown in context until a ~10 µm soma is ≥ 10 px
export const LABEL_GAP_PX = 4;           // a label is (re)shown only with this much air round it (4: fewer show/hide blinks than 2)
export const LABEL_HOLD_PX = 4;          // …one already shown may use up that air (hysteresis), but never overlaps

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finite = (v, d) => (Number.isFinite(v) ? v : d);

/** Clamp a (partial) view onto the allowed ranges; missing fields come from `base`. */
export function clampView(view = {}, base = DEFAULT_VIEW) {
  return {
    yaw: finite(view.yaw, base.yaw),
    tilt: clamp(finite(view.tilt, base.tilt), -TILT_MAX, TILT_MAX),
    zoom: clamp(finite(view.zoom, base.zoom), ZOOM_MIN, ZOOM_MAX),
    panX: finite(view.panX, base.panX),
    panY: finite(view.panY, base.panY),
  };
}

/** [x0,y0,z0,x1,y1,z1] → valid bbox (null when unusable). */
export function normBbox(b) {
  if (!Array.isArray(b) || b.length !== 6 || !b.every(Number.isFinite)) return null;
  return [Math.min(b[0], b[3]), Math.min(b[1], b[4]), Math.min(b[2], b[5]), Math.max(b[0], b[3]), Math.max(b[1], b[4]), Math.max(b[2], b[5])];
}

export const bboxCentre = (b) => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
export const offsetBbox = (b, o) => [b[0] + o[0], b[1] + o[1], b[2] + o[2], b[3] + o[0], b[4] + o[1], b[5] + o[2]];

/**
 * Half the frustum height (µm) that frames `bbox` in a viewport of `aspect` (w/h) at zoom 1:
 * horizontally safe for any yaw (the bbox diagonal in x–z), vertically for the default tilt.
 */
export function frameHalfHeight(bbox, aspect = 1, { fill = FILL, tilt = DEFAULT_VIEW.tilt } = {}) {
  const b = normBbox(bbox);
  if (!b) return 50;
  const sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2];
  const xz = Math.hypot(sx, sz);
  const horiz = xz / 2;
  const vert = (sy * Math.cos(tilt) + xz * Math.abs(Math.sin(tilt))) / 2;
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  return Math.max(vert, horiz / a, 1e-3) / fill;
}

/** CSS px per µm for a viewport `heightPx` tall showing 2·halfH/zoom µm. */
export function pxPerUmOf(heightPx, halfH, zoom = 1) {
  if (!(heightPx > 0) || !(halfH > 0)) return 0;
  return (heightPx * zoom) / (2 * halfH);
}

/**
 * Zoom by `factor` about a screen point (sx, sy) given in px from the viewport centre (+y up), so the
 * specimen point under it stays put. Returns the new { zoom, panX, panY } (zoom clamped).
 */
export function zoomAbout(view, factor, sx, sy, pxPerUm) {
  const zoom = clamp(view.zoom * (Number.isFinite(factor) && factor > 0 ? factor : 1), ZOOM_MIN, ZOOM_MAX);
  if (!(pxPerUm > 0)) return { zoom, panX: view.panX, panY: view.panY };
  const k1 = pxPerUm;
  const k2 = pxPerUm * (zoom / view.zoom);
  return { zoom, panX: view.panX - sx * (1 / k1 - 1 / k2), panY: view.panY - sy * (1 / k1 - 1 / k2) };
}

/** Movement under TAP_SLOP_PX (4 px) between pointer down and up counts as a tap. */
export const isTap = (dx, dy) => Math.hypot(dx, dy) < TAP_SLOP_PX;

/** Corners of a context layer plane (context_labels.planes[i]) spanning the bbox, plus its label anchor. */
export function planeGeometry(plane, bbox) {
  const b = normBbox(bbox);
  if (!b || !plane || !Number.isFinite(plane.at_um)) return null;
  const a = plane.at_um;
  const [x0, y0, z0, x1, y1, z1] = b;
  switch (plane.axis) {
    case 'x': return { corners: [[a, y0, z0], [a, y1, z0], [a, y1, z1], [a, y0, z1]], anchor: [a, y1, z1] };
    case 'z': return { corners: [[x0, y0, a], [x1, y0, a], [x1, y1, a], [x0, y1, a]], anchor: [x0, y1, a] };
    case 'y':
    default: return { corners: [[x0, a, z0], [x1, a, z0], [x1, a, z1], [x0, a, z1]], anchor: [x0, a, z1] };
  }
}

/**
 * Per-layer opacity so that two stacked double-sided layers (the front and back face of a closed shell) blend to
 * `fill`: 1 − (1 − a)² = fill.
 */
export function shellLayerOpacity(fill) {
  const f = Math.max(0, Math.min(1, Number(fill) || 0));
  return 1 - Math.sqrt(1 - f);
}

// Point labels: the element's box starts at its anchor and 8 px above it (css/viewer.css .mv-label.is-point:
// margin -8px 0 0 0), the 6 px leader line first; 'left' mirrors it (line last, text to the left of the anchor).
// Plane labels: the box starts at the anchor with padding 3px 0 0 6px; only the text counts.
const POINT_DX = 0;
const POINT_DY = -8;
const PLANE_PAD_X = 6;
const PLANE_PAD_Y = 3;

/** Screen rect [x0, y0, x1, y1] of a label item { kind: 'point'|'plane', x, y, w, h } placed on `side`. */
export function labelRect(it, side = 'right') {
  if (it.kind === 'plane') return [it.x + PLANE_PAD_X, it.y + PLANE_PAD_Y, it.x + it.w, it.y + it.h];
  const y0 = it.y + POINT_DY;
  return side === 'left'
    ? [it.x - POINT_DX - it.w, y0, it.x - POINT_DX, y0 + it.h]
    : [it.x + POINT_DX, y0, it.x + POINT_DX + it.w, y0 + it.h];
}

const overlapArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * Greedy screen-space label placement. items: [{ kind, x, y, w, h, priority (lower = placed first), prev
 * ('right'|'left'|null: last frame's placement, kept unless the other side is clearly better, so labels do not
 * flip while the view turns) }]. Point labels may sit right or left of their anchor; plane labels only on their
 * own spot. A side must clear every kept rect and the hard `obstacles` (the soma marker) by `gap` px; among the
 * sides that do, one inside [0, width] wins, then the one covering less of the `soft` rects (today's cell on
 * screen). Returns per item 'right' | 'left' | null (hidden). O(n²) on ≤ 52 labels: well under 0.1 ms a frame.
 * Items with the same `text` (a region named in both hemispheres: "ME", "LA", "AL") are labelled once: only the
 * first in priority order (the one nearest today's cell) is tried; the others stay hidden (App Design Guide §4).
 */
export function layoutLabels(items, { obstacles = [], soft = [], gap = LABEL_GAP_PX, width = Infinity } = {}) {
  const order = items.map((_, i) => i).sort((a, b) => (items[a].priority - items[b].priority) || a - b);
  const kept = obstacles.slice();
  const hits = (r, g) => kept.some((p) => r[0] < p[2] + g && r[2] + g > p[0] && r[1] < p[3] + g && r[3] + g > p[1]);
  const out = new Array(items.length).fill(null);
  const named = new Set();
  for (const i of order) {
    const it = items[i];
    if (it.text) {
      if (named.has(it.text)) continue;
      named.add(it.text);
    }
    const sides = it.kind === 'plane' ? ['right'] : it.prev === 'left' ? ['left', 'right'] : ['right', 'left'];
    let pick = null;
    for (const s of sides) {
      const r = labelRect(it, s);
      // hysteresis: a label keeps last frame's side until it would touch-and-overlap a neighbour (it may use up
      // the LABEL_HOLD_PX of air); a new side, or a hidden label, needs the full gap — so a label on the edge does
      // not blink as it turns. Never below 0: a held label must not overlap (W4 review: −3 px let "LO" run into
      // "GNG" on FlyWire and "ME(L)" into "GNG" on male CNS).
      if (hits(r, s === it.prev ? Math.max(0, gap - LABEL_HOLD_PX) : gap)) continue;
      let cost = r[0] < 0 || r[2] > width ? 1e9 : 0;
      for (const q of soft) cost += overlapArea(r, q);
      const margin = pick && pick.s === it.prev ? 24 : 0;   // px² a later side must save to replace last frame's
      if (!pick || cost < pick.cost - margin) pick = { s, r, cost };
    }
    if (pick) { out[i] = pick.s; kept.push(pick.r); }
  }
  return out;
}

/**
 * Label priority: screen distance (px) from today's cell; layer planes first; a label shown last frame counts
 * as 30 % nearer (hysteresis against flicker while the view turns).
 */
export function labelPriority(it, cell) {
  if (it.kind === 'plane') return -1e6;
  const d = cell ? Math.hypot(it.x - cell.x, it.y - cell.y) : 0;
  return it.prev ? d * 0.7 : d;
}

/**
 * Push every vertex out along its normal by material.userData.inflate.value µm (set each frame from px/µm), so
 * thin processes keep a minimum on-screen width. Zero-length normals stay put. With { pushBack: true } the result
 * is also moved material.userData.push.value µm away from the (orthographic) camera after projection set-up: same
 * pixels on screen, only its depth changes.
 */
export function inflatable(material, { pushBack = false } = {}) {
  const inflate = { value: 0 };
  const push = { value: 0 };
  material.userData.inflate = inflate;
  if (pushBack) material.userData.push = push;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.ngInflate = inflate;
    let vs = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float ngInflate;${pushBack ? '\nuniform float ngPush;' : ''}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tfloat ngLen = length( normal );\n\tif ( ngLen > 0.0 ) transformed += normal / ngLen * ngInflate;');
    if (pushBack) {
      shader.uniforms.ngPush = push;
      vs = vs.replace('#include <project_vertex>', '#include <project_vertex>\n\tmvPosition.z -= ngPush;\n\tgl_Position = projectionMatrix * mvPosition;');
    }
    shader.vertexShader = vs;
  };
  material.customProgramCacheKey = () => (pushBack ? 'ng-inflate-push' : 'ng-inflate');
  return material;
}

/** Box-only datasets ship a 12-triangle box (assets.md); used when labels are missing. */
export const guessVolumeStyle = (triangles) => (triangles === 12 ? 'box' : 'surface');

/** Endpoint pairs (x,y,z,x,y,z per segment) of LINES / LINE_STRIP / LINE_LOOP objects under obj, in obj's frame. */
export function lineSegmentPositions(obj) {
  const out = [];
  const v = new THREE.Vector3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!o.isLine || !o.geometry) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const idx = o.geometry.getIndex();
    const n = idx ? idx.count : pos.count;
    const at = (k) => (idx ? idx.getX(k) : k);
    const push = (i) => { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); out.push(v.x, v.y, v.z); };
    if (o.isLineSegments) {
      for (let k = 0; k + 1 < n; k += 2) { push(at(k)); push(at(k + 1)); }
    } else {
      for (let k = 0; k + 1 < n; k++) { push(at(k)); push(at(k + 1)); }
      if (o.isLineLoop && n > 2) { push(at(n - 1)); push(at(0)); }
    }
  });
  return new Float32Array(out);
}

/** Total triangle count of the meshes under obj. */
export function triangleCount(obj) {
  let n = 0;
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const idx = o.geometry.getIndex();
    n += Math.floor((idx ? idx.count : o.geometry.getAttribute('position').count) / 3);
  });
  return n;
}

/**
 * Parse the neuron GLB into a Group of meshes with client-side smooth normals and our material
 * (the loader's default materials are disposed). Exported for tests; works without a DOM.
 */
export async function buildNeuron(arrayBuffer, material) {
  const scene = await parseGLB(arrayBuffer);
  scene.updateMatrixWorld(true);
  const group = new THREE.Group();
  const loose = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    if (!o.matrixWorld.equals(IDENTITY)) g.applyMatrix4(o.matrixWorld);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    loose.push(o.material);
    const m = new THREE.Mesh(g, material);
    m.matrixAutoUpdate = false;
    m.renderOrder = 3;   // after context faces (1) and siblings (2): today's cell is never veiled by them
    group.add(m);
  });
  for (const m of loose) if (m && m.dispose) m.dispose();
  if (!group.children.length) throw new Error('The mesh asset has no triangles.');
  return group;
}
const IDENTITY = new THREE.Matrix4();

/**
 * data-black shaded surface. Drawn in the transparent pass at opacity 1 (identical pixels, one pass) so that, by
 * renderOrder, it comes after the translucent context and siblings and stays crisp on top of them.
 */
export function neuronMaterial() {
  const m = dataMaterial('neuron');
  m.transparent = true;
  m.opacity = 1;
  m.depthWrite = true;
  m.forceSinglePass = true;
  return inflatable(m);
}

/**
 * In context: a surface-sunken keyline drawn under today's cell (renderOrder 2.5: after the siblings, before the
 * cell), inflated HALO_PX further than the cell. Its depth is pushed behind the whole cell (userData.push, set per
 * frame from the cell's size), so the cell always draws over it and only the rim shows; nothing in the volume or
 * the siblings writes depth, so nothing there can hide it. Depth-tested and -written among its own layers, so the
 * heavily overlapping inflated triangles are mostly rejected by early-z. (W4 review: without a depth test the same
 * pixels cost +0.8–1.8 ms per GPU-synced frame on real reveals, ≈ the rest of the scene; this costs ≈ 0. An
 * inverted hull was tried and fails: the inflation is many times a dendrite's radius, the hull tangles and its
 * "back" faces cover the cell.)
 */
export function haloMaterial() {
  return inflatable(new THREE.MeshBasicMaterial({
    color: COLORS.sunken, transparent: true, opacity: 1, depthWrite: true, depthTest: true, side: THREE.DoubleSide,
  }), { pushBack: true });
}

function reducedMotion() {
  try { return !motionAllowed(); } catch (_) { return true; }
}

/** Layout size (untransformed: the full view opens with a scale() entrance) → [w, h] in CSS px. */
function layoutSize(el) {
  const r = el.getBoundingClientRect();
  return [el.clientWidth || r.width, el.clientHeight || r.height];
}

const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const lerp = (a, b, t) => a + (b - a) * t;

// An opaque overlay over the whole column (the full view) hides every viewer outside it: those stop their
// continuous loop (auto-rotation, tweens) instead of drawing 60 frames a second nobody sees.
const LIVE = new Set();
let exclusiveHost = null;
/** While `el` is open, only viewers inside it may render continuously; null lifts that. */
export function setExclusiveHost(el) {
  exclusiveHost = el || null;
  for (const v of LIVE) {
    v._syncContinuous();
    if (!exclusiveHost && v._loop) v._loop.invalidate();
  }
}

// ---------------------------------------------------------------------------------------------------------

export class MeshViewer {
  constructor(container, { autoRotate = true, interactive = true, initialView } = {}) {
    this.container = container;
    this.options = { autoRotate, interactive };
    this._disposed = false;
    this._view = clampView(initialView || {}, DEFAULT_VIEW);
    this._hadInitialView = !!initialView;
    this._touched = false;
    this._dragMode = 'rotate';
    this._layers = { volume: true, siblings: true, labels: true };
    this._changeCbs = new Set();
    this._tapCbs = new Set();
    this._emitDirty = true;
    this._lastEmit = null;
    this._neuronBbox = null;          // neuron frame (soma at origin)
    this._ctx = null;                 // { volume, labels, bbox, offset, group, planes, labelEls, style }
    this._ctxActive = false;
    this._frame = { centre: new THREE.Vector3(), bbox: [-50, -50, -50, 50, 50, 50] };
    this._tween = null;
    this._visible = true;
    this._lost = false;
    this._size = { w: 1, h: 1 };
    this._pointers = new Map();
    this._gesture = null;
    this._tokens = { neuron: 0, ctx: 0, sib: 0 };
    this._stats = { frames: 0, last: 0, sum: 0, max: 0, cpu: 0 };
    this._listeners = [];

    // DOM: wrapper (canvas + label overlay + status line); the screen owns `container`.
    const root = document.createElement('div');
    root.className = 'mv-root';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-roledescription', '3D viewer');
    root.setAttribute('aria-label', interactive
      ? '3D view of the neuron. Drag to rotate, pinch or scroll to zoom; arrow keys rotate, plus and minus zoom, 0 resets.'
      : '3D view of the neuron.');
    if (interactive) root.tabIndex = 0;
    this._root = root;
    this._labelsEl = document.createElement('div');
    this._labelsEl.className = 'mv-labels';
    this._labelsEl.setAttribute('aria-hidden', 'true');
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'mv-status';
    this._statusEl.setAttribute('role', 'status');
    container.appendChild(root);

    this.renderer = createRenderer(root, { antialias: true });
    root.appendChild(this._labelsEl);
    root.appendChild(this._statusEl);
    if (!this.renderer) {
      this._setStatus('3D view needs WebGL, which this browser has turned off.');
      return;
    }
    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-hidden', 'true');

    this.scene = new THREE.Scene();
    this.camera = createOrthoCamera(1, 100);
    addLights(this.scene);
    this._rootGroup = new THREE.Group();      // rotation (tilt about X after yaw about Y)
    this._rootGroup.rotation.order = 'XYZ';
    this._content = new THREE.Group();        // position = −frame centre (rotation pivots on the framed bbox)
    this._neuronGroup = new THREE.Group();
    this._sibGroup = new THREE.Group();
    this._content.add(this._neuronGroup, this._sibGroup);
    this._rootGroup.add(this._content);
    this.scene.add(this._rootGroup);

    this._loop = createRenderLoop(() => this._render(), { tick: (dt) => this._tick(dt) });
    this._autoRotating = !!autoRotate && !reducedMotion();
    LIVE.add(this);

    this._applySize(...layoutSize(root));
    this._unobserve = observeResize(root, (w, h) => { this._applySize(w, h); this._emitDirty = true; this._loop.invalidate(); });
    if (typeof IntersectionObserver !== 'undefined') {
      this._io = new IntersectionObserver((entries) => {
        const vis = entries.some((e) => e.isIntersecting);
        if (vis !== this._visible) { this._visible = vis; this._syncContinuous(); if (vis) this._loop.invalidate(); }
      });
      this._io.observe(root);
    }
    this._on(canvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      this._lost = true;
      this._loop.setContinuous(false);
      this._setStatus('3D view paused · restoring…');
    });
    this._on(canvas, 'webglcontextrestored', () => {
      this._lost = false;
      this._setStatus(null);
      this._syncContinuous();
      this._loop.invalidate();
    });
    if (interactive) this._bindInput();
    // label sizes measured before the web font arrived are re-measured once it has. fonts.ready alone is not
    // enough: it is often already settled here, and NG Sans may only start loading when the first label renders
    // (W4 review: widths 1–2 px short in the fallback face let shown labels overlap), so also on 'loadingdone'.
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    const remeasure = () => {
      if (this._disposed || !this._ctx) return;
      for (const l of this._ctx.labelEls) l.w = 0;
      this._ctx.needsMeasure = true;
      this._ctx.layoutKey = null;
      this._loop.invalidate();
    };
    if (fonts && fonts.ready && typeof fonts.ready.then === 'function') fonts.ready.then(remeasure, () => {});
    if (fonts && typeof fonts.addEventListener === 'function') this._on(fonts, 'loadingdone', remeasure);
    this._syncContinuous();
    this._loop.invalidate();
  }

  // ---- loading ----

  /** Load the neuron GLB (api.assetArrayBuffer). bboxUm = round_public.mesh.bbox_um (else computed). */
  async loadNeuron(arrayBuffer, { bboxUm } = {}) {
    if (this._disposed || !this.renderer) return;
    const token = ++this._tokens.neuron;
    this._setStatus('Loading 3D…', 'is-loading');
    let group;
    try {
      group = await buildNeuron(arrayBuffer, neuronMaterial());
    } catch (err) {
      if (token === this._tokens.neuron && !this._disposed) this._setStatus('Could not draw this mesh.');
      throw err;
    }
    if (this._disposed || token !== this._tokens.neuron) { disposeObject(group); return; }
    for (const old of [...this._neuronGroup.children]) disposeObject(old);
    this._neuronTris = triangleCount(group);
    // the keyline shares the cell's geometry (shown in context only, see _render)
    const halo = haloMaterial();
    halo.visible = false;
    const cell = group.children[0].material;
    for (const m of [...group.children]) {
      const k = new THREE.Mesh(m.geometry, halo);
      k.matrixAutoUpdate = false;
      k.renderOrder = 2.5;
      group.add(k);
    }
    this._cellMats = { cell, halo };
    this._neuronGroup.add(group);
    const box = new THREE.Box3().setFromObject(group);
    this._neuronBbox = normBbox(bboxUm) || (box.isEmpty() ? [-50, -50, -50, 50, 50, 50] : [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]);
    this._setStatus(null);
    if (this._ctxActive && this._ctx) {
      this._neuronGroup.position.fromArray(this._ctx.offset);
    } else {
      this._neuronGroup.position.set(0, 0, 0);
      this._setFrame(this._neuronBbox, { animate: false });
    }
    this._changed();
  }

  /** setContext({ volume: ArrayBuffer, labels: context_labels JSON, offsetUm: [x,y,z] }) or null to clear. */
  async setContext(ctx) {
    if (this._disposed || !this.renderer) return;
    const token = ++this._tokens.ctx;
    if (!ctx || !ctx.volume) {
      if (!this._ctxActive) return;
      this._ctxActive = false;
      this._syncLayers();
      this._neuronGroup.position.set(0, 0, 0);
      if (this._neuronBbox) {
        // keep the cell where it is on screen, then zoom back in on it
        const from = this._frame;
        const nb = this._neuronBbox;
        const offs = this._ctx ? this._ctx.offset : [0, 0, 0];
        this._frame = { centre: from.centre.clone().sub(new THREE.Vector3().fromArray(offs)), bbox: offsetBbox(from.bbox, offs.map((v) => -v)) };
        this._setFrame(nb, { animate: true, view: { zoom: 1, panX: 0, panY: 0 } });
      }
      this._changed();
      return;
    }
    const offset = Array.isArray(ctx.offsetUm) && ctx.offsetUm.length === 3 ? ctx.offsetUm.map(Number) : [0, 0, 0];
    const labels = ctx.labels && typeof ctx.labels === 'object' ? ctx.labels : null;
    if (!this._ctx || this._ctx.volume !== ctx.volume || this._ctx.labels !== labels) {
      const built = await this._buildContext(ctx.volume, labels);
      if (this._disposed || token !== this._tokens.ctx) { this._disposeContext(built); return; }
      if (this._ctx) this._disposeContext(this._ctx);
      this._ctx = { ...built, volume: ctx.volume, labels };
      this._content.add(built.group);
      this._content.add(built.planes);
    }
    this._ctx.offset = offset;
    const wasActive = this._ctxActive;
    this._ctxActive = true;
    this._syncLayers();
    this._neuronGroup.position.fromArray(offset);
    if (!wasActive) {
      // the frame so far was the neuron's: move it into the context frame (no jump), then zoom out
      this._frame = { centre: this._frame.centre.clone().add(new THREE.Vector3().fromArray(offset)), bbox: offsetBbox(this._frame.bbox, offset) };
      const untouched = !this._touched && !this._hadInitialView;
      // untouched: ease into the 3/4 context view (keeping the yaw while it auto-rotates)
      const view = !untouched ? { zoom: 1, panX: 0, panY: 0 }
        : this._autoRotating ? { tilt: CONTEXT_VIEW.tilt, zoom: 1, panX: 0, panY: 0 } : { ...CONTEXT_VIEW };
      this._setFrame(this._ctx.bbox, { animate: true, view });
    } else {
      this._setFrame(this._ctx.bbox, { animate: false });
    }
    this._changed();
  }

  /** Same-type siblings GLB (reveal.context.siblings, context frame) or null to clear. */
  async setSiblings(arrayBuffer) {
    if (this._disposed || !this.renderer) return;
    const token = ++this._tokens.sib;
    if (!arrayBuffer) {
      for (const o of [...this._sibGroup.children]) disposeObject(o);
      this._loop.invalidate();
      return;
    }
    const scene = await parseGLB(arrayBuffer);
    if (this._disposed || token !== this._tokens.sib) { disposeObject(scene); return; }
    for (const o of [...this._sibGroup.children]) disposeObject(o);
    const built = new THREE.Group();
    const segs = lineSegmentPositions(scene);
    if (segs.length) {
      const g = new LineSegmentsGeometry();
      g.setPositions(segs);
      const m = dataMaterial('siblings', { width: SIBLING_LINE_PX });
      m.opacity = SIBLING_OPACITY;
      m.resolution.set(this._size.w, this._size.h);
      const lines = new LineSegments2(g, m);
      lines.renderOrder = 2;
      built.add(lines);
    }
    scene.updateMatrixWorld(true);
    const triMat = new THREE.MeshLambertMaterial({ color: COLORS.dataSky, transparent: true, opacity: SIBLING_TRI_OPACITY, depthWrite: false, side: THREE.DoubleSide });
    let anyTri = false;
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, triMat);
      mesh.renderOrder = 2;
      built.add(mesh);
      anyTri = true;
    });
    if (!anyTri) triMat.dispose();
    disposeObject(scene);
    this._sibGroup.add(built);
    this._syncLayers();
    this._loop.invalidate();
  }

  /** Layer toggles (reveal "✓ Volume · ✓ <type> · N · ✓ Layers"). */
  setLayers({ volume = true, siblings = true, labels = true } = {}) {
    this._layers = { volume: !!volume, siblings: !!siblings, labels: !!labels };
    if (!this.renderer) return;   // no WebGL: the status line stands in for the scene
    this._syncLayers();
    this._loop.invalidate();
  }

  // ---- view ----

  setView(view = {}) {
    this._tween = null;
    this._view = clampView(view, this._view);
    this._changed();
  }

  getView() { return { ...this._view }; }

  setDragMode(mode) { this._dragMode = mode === 'pan' ? 'pan' : 'rotate'; }
  getDragMode() { return this._dragMode; }

  zoomBy(factor) {
    this.stopAutoRotate();
    this._tween = null;
    this._view = { ...this._view, ...zoomAbout(this._view, factor, 0, 0, this._pxPerUm()) };
    this._changed();
  }

  resetView() {
    const target = this._ctxActive ? CONTEXT_VIEW : DEFAULT_VIEW;
    this._animateView(target);
  }

  stopAutoRotate() {
    if (!this._autoRotating) return;
    this._autoRotating = false;
    this._syncContinuous();
    this._emitDirty = true;
    this._loop.invalidate();
  }

  /** cb({ pxPerUm, zoom, yaw, tilt, panX, panY }); returns unsubscribe. Fires once with the current state. */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this._changeCbs.add(cb);
    this._emitDirty = true;
    this._forceEmit = true;
    if (this._loop) this._loop.invalidate();
    return () => { this._changeCbs.delete(cb); };
  }

  /** cb({ x, y }) on pointer up with < 4 px movement (x, y in px within the viewer); returns unsubscribe. */
  onTap(cb) {
    if (typeof cb !== 'function') return () => {};
    this._tapCbs.add(cb);
    return () => { this._tapCbs.delete(cb); };
  }

  /** Re-measure the container (the ResizeObserver does this automatically). */
  resize() {
    if (this._disposed || !this.renderer) return;
    this._applySize(...layoutSize(this._root));
    this._emitDirty = true;
    this._loop.invalidate();
  }

  /** Frame-time stats for dev pages: { frames, avgMs, maxMs, triangles }. */
  stats() {
    const s = this._stats;
    return {
      frames: s.frames,
      avgMs: s.frames > 1 ? s.sum / (s.frames - 1) : 0,   // frame interval while rendering continuously
      maxMs: s.max,
      cpuMs: s.frames ? (s.cpu || 0) / s.frames : 0,       // main-thread time per frame (camera, render submit, labels)
      triangles: this._neuronTris || 0,
    };
  }
  resetStats() { this._stats = { frames: 0, last: 0, sum: 0, max: 0, cpu: 0 }; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    LIVE.delete(this);
    this._tokens.neuron++; this._tokens.ctx++; this._tokens.sib++;
    this._changeCbs.clear();
    this._tapCbs.clear();
    if (this._loop) this._loop.dispose();
    if (this._unobserve) this._unobserve();
    if (this._io) this._io.disconnect();
    for (const [el, type, fn, opts] of this._listeners) el.removeEventListener(type, fn, opts);
    this._listeners = [];
    if (this._ctx) this._disposeContext(this._ctx);
    this._ctx = null;
    if (this.scene) {
      this.scene.traverse((o) => { if (o.dispose && (o.isLight)) o.dispose(); });
      disposeObject(this._rootGroup);
    }
    disposeRenderer(this.renderer);
    this.renderer = null;
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
  }

  // ---- internals ----

  _on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this._listeners.push([el, type, fn, opts]);
  }

  _setStatus(text, cls = '') {
    if (!this._statusEl) return;
    this._statusEl.textContent = text || '';
    this._statusEl.className = `mv-status ${cls}`.trim();
    this._statusEl.hidden = !text;
  }

  _applySize(w, h) {
    if (!this.renderer || !(w > 0) || !(h > 0)) return;
    this._size = { w, h };
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, MAX_DPR));
    this.renderer.setSize(w, h, false);
    this._sibGroup.traverse((o) => { if (o.material && o.material.resolution) o.material.resolution.set(w, h); });
  }

  _aspect() { return this._size.w / Math.max(1, this._size.h); }

  _halfH() {
    if (this._tween && this._tween.frame) {
      const t = this._tween;
      return lerp(t.fromHalf, frameHalfHeight(t.toBbox, this._aspect()), t.e);
    }
    return frameHalfHeight(this._frame.bbox, this._aspect());
  }

  _pxPerUm() { return pxPerUmOf(this._size.h, this._halfH(), this._view.zoom); }

  /** Frame bbox (in the content frame). animate: tween centre/extent (and `view` fields) over ~450 ms. */
  _setFrame(bbox, { animate = false, view = null } = {}) {
    const b = normBbox(bbox) || [-50, -50, -50, 50, 50, 50];
    const centre = new THREE.Vector3().fromArray(bboxCentre(b));
    const toView = view ? clampView(view, this._view) : null;
    if (!animate || reducedMotion()) {
      this._tween = null;
      this._frame = { centre, bbox: b };
      if (toView) this._view = toView;
      this._changed();
      return;
    }
    this._tween = {
      t0: performance.now(), dur: 450, e: 0, frame: true,
      fromCentre: this._frame.centre.clone(), toCentre: centre,
      fromHalf: this._halfH(), toBbox: b,
      fromView: { ...this._view }, toView: toView ? { ...toView, yaw: view.yaw === undefined ? null : toView.yaw } : null,
    };
    this._frame = { centre: this._frame.centre.clone(), bbox: b };
    this._syncContinuous();
    this._changed();
  }

  _animateView(target) {
    const to = clampView(target, DEFAULT_VIEW);
    if (reducedMotion()) { this._tween = null; this._view = to; this._changed(); return; }
    // shortest way round for yaw
    const from = { ...this._view };
    const twoPi = Math.PI * 2;
    let dy = ((to.yaw - from.yaw) % twoPi + twoPi * 1.5) % twoPi - Math.PI;
    if (!Number.isFinite(dy)) dy = 0;
    this._tween = { t0: performance.now(), dur: 320, e: 0, frame: false, fromView: from, toView: { ...to, yaw: from.yaw + dy } };
    this._syncContinuous();
    this._changed();
  }

  _tick(dt) {
    const t = this._tween;
    if (t) {
      const p = Math.min(1, (performance.now() - t.t0) / t.dur);
      t.e = easeOutCubic(p);
      if (t.frame) this._frame.centre.lerpVectors(t.fromCentre, t.toCentre, t.e);
      if (t.toView) {
        const v = {};
        for (const k of ['yaw', 'tilt', 'zoom', 'panX', 'panY']) {
          v[k] = t.toView[k] === null || t.toView[k] === undefined ? this._view[k] : lerp(t.fromView[k], t.toView[k], t.e);
        }
        this._view = v;
      }
      this._emitDirty = true;
      if (p >= 1) { this._tween = null; this._syncContinuous(); }
    }
    if (this._autoRotating && this._visible && !this._pointers.size) this._view.yaw += AUTO_ROTATE_RAD_S * dt;
  }

  _syncContinuous() {
    if (!this._loop) return;
    const covered = !!exclusiveHost && !!this._root && !exclusiveHost.contains(this._root);
    this._loop.setContinuous(!covered && !this._lost && this._visible && !!(this._tween || this._autoRotating));
  }

  _changed() {
    this._emitDirty = true;
    if (this._loop) this._loop.invalidate();
  }

  _syncLayers() {
    if (!this._sibGroup) return;
    const on = this._ctxActive;
    if (this._ctx) {
      this._ctx.group.visible = on && this._layers.volume;
      this._ctx.planes.visible = on && this._layers.labels;
      this._ctx.labelsVisible = on && this._layers.labels;
      for (const l of this._ctx.labelEls) l.el.hidden = !this._ctx.labelsVisible;
      if (this._ctx.labelsVisible) {
        if (this._ctx.labelEls.some((l) => !(l.w > 0))) this._ctx.needsMeasure = true;
        this._ctx.layoutKey = null;
      }
    }
    this._sibGroup.visible = on && this._layers.siblings;
  }

  async _buildContext(volumeBuf, labels) {
    const scene = await parseGLB(volumeBuf);
    scene.updateMatrixWorld(true);
    const style = labels && (labels.volume_style === 'box' || labels.volume_style === 'surface')
      ? labels.volume_style : guessVolumeStyle(triangleCount(scene));
    const group = new THREE.Group();
    const faceMat = dataMaterial('context-face', { style });
    // Double-sided, a closed shell puts a back face and a front face over every pixel, so the contract's fill
    // (box 3.5 %, surface ~10 %) is the two layers combined: each layer gets 1 − √(1 − fill).
    faceMat.opacity = shellLayerOpacity(faceMat.opacity);
    const edgeMat = style === 'box' ? dataMaterial('context-edge') : null;
    const loose = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry;
      if (!o.matrixWorld.equals(IDENTITY)) g.applyMatrix4(o.matrixWorld);
      loose.push(o.material);
      const faces = new THREE.Mesh(g, faceMat);
      faces.renderOrder = 1;
      group.add(faces);
      if (edgeMat) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), edgeMat);
        edges.renderOrder = 1;
        group.add(edges);
      }
    });
    for (const m of loose) if (m && m.dispose) m.dispose();
    const box = new THREE.Box3().setFromObject(group);
    const bbox = normBbox(labels && labels.bbox_um) || (box.isEmpty() ? [0, 0, 0, 100, 100, 100] : [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]);

    // layer planes: dashed outline @22 % (+ a 3 % fill, as in the handoff), labels in the HTML overlay
    const planes = new THREE.Group();
    const labelEls = [];
    const lineMat = dataMaterial('layer', { dash: 6, gap: 6 });
    const fillMat = new THREE.MeshBasicMaterial({ color: COLORS.ink, transparent: true, opacity: 0.03, depthWrite: false, side: THREE.DoubleSide });
    for (const p of (labels && Array.isArray(labels.planes) ? labels.planes : [])) {
      const pg = planeGeometry(p, bbox);
      if (!pg) continue;
      const pts = pg.corners.map((c) => new THREE.Vector3(...c));
      const loopGeo = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]);
      const line = new THREE.Line(loopGeo, lineMat);
      line.computeLineDistances();
      line.renderOrder = 1;
      const fillGeo = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[0], pts[2], pts[3]]);
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.renderOrder = 1;
      planes.add(line, fill);
      labelEls.push(this._makeLabel(String(p.label || ''), pg.anchor, 'is-plane'));
    }
    for (const pt of (labels && Array.isArray(labels.points) ? labels.points : [])) {
      if (!Array.isArray(pt.pos_um) || pt.pos_um.length !== 3) continue;
      labelEls.push(this._makeLabel(String(pt.label || ''), pt.pos_um.map(Number), 'is-point'));
    }
    disposeObject(scene);
    return { group, planes, labelEls, bbox, style, lineMat, offset: [0, 0, 0], labelsVisible: false, needsMeasure: true, layoutKey: null };
  }

  _makeLabel(text, pos, cls) {
    const el = document.createElement('span');
    el.className = `mv-label ${cls}`;
    el.textContent = text;
    el.hidden = true;
    this._labelsEl.appendChild(el);
    return {
      el, text, kind: cls === 'is-plane' ? 'plane' : 'point', pos: new THREE.Vector3(...pos),
      x: NaN, y: NaN, out: false, w: 0, h: 0, side: null, applied: null,
    };
  }

  _disposeContext(c) {
    if (!c) return;
    disposeObject(c.group);
    disposeObject(c.planes);
    for (const l of c.labelEls || []) l.el.remove();
  }

  _render() {
    if (!this.renderer || this._lost) return;
    const tStart = performance.now();
    const { w, h } = this._size;
    const aspect = this._aspect();
    const halfH = this._halfH();
    const cam = this.camera;
    cam.top = halfH; cam.bottom = -halfH;
    cam.left = -halfH * aspect; cam.right = halfH * aspect;
    cam.zoom = this._view.zoom;
    cam.position.set(-this._view.panX, -this._view.panY, 1e4);
    cam.updateProjectionMatrix();
    this._rootGroup.rotation.set(this._view.tilt, this._view.yaw, 0, 'XYZ');
    this._content.position.copy(this._frame.centre).negate();
    this.scene.updateMatrixWorld();
    const pxPerUm = pxPerUmOf(h, halfH, this._view.zoom);
    if (this._ctx && pxPerUm > 0 && this._ctx.lineMat) {
      const d = DASH_PX / pxPerUm;
      if (Math.abs(this._ctx.lineMat.dashSize - d) > d * 0.01) { this._ctx.lineMat.dashSize = d; this._ctx.lineMat.gapSize = d; }
    }
    const cm = this._cellMats;
    if (cm) {
      // context only (Cell mode and the type stage keep the plain surface); eased with the framing tween
      const t = this._tween && this._tween.frame ? this._tween.e : 1;
      const mix = this._ctxActive ? t : 1 - t;
      const umPerPx = pxPerUm > 0 ? mix / pxPerUm : 0;
      cm.cell.userData.inflate.value = (CELL_MIN_PX / 2) * umPerPx;
      cm.halo.userData.inflate.value = (CELL_MIN_PX / 2 + HALO_PX) * umPerPx;
      // behind every fragment of the (inflated) cell: its bbox diagonal + both inflations + 1 µm
      const nb = this._neuronBbox;
      const diag = nb ? Math.hypot(nb[3] - nb[0], nb[4] - nb[1], nb[5] - nb[2]) : 1000;
      cm.halo.userData.push.value = diag + 2 * (cm.halo.userData.inflate.value + cm.cell.userData.inflate.value) + 1;
      cm.halo.visible = mix > 0;
    }
    this.renderer.render(this.scene, cam);
    this._placeLabels(w, h);
    this._frameStat(performance.now() - tStart);
    if (this._emitDirty) {
      this._emitDirty = false;
      const ev = { pxPerUm, zoom: this._view.zoom, yaw: this._view.yaw, tilt: this._view.tilt, panX: this._view.panX, panY: this._view.panY };
      const last = this._lastEmit;
      const same = last && Math.abs(last.pxPerUm - ev.pxPerUm) < 1e-6 && last.zoom === ev.zoom && last.tilt === ev.tilt
        && last.panX === ev.panX && last.panY === ev.panY && Math.abs(last.yaw - ev.yaw) < 1e-9;
      if (!same || this._forceEmit) {
        this._lastEmit = ev;
        for (const cb of [...this._changeCbs]) { try { cb(ev); } catch (err) { console.error(err); } }
      }
      this._forceEmit = false;
    }
  }

  /**
   * Project the labels, then (only when one moved, the soma marker moved or the viewport changed) run the
   * collision pass and write the DOM for labels whose placement changed. Sizes are measured once per label
   * (one batched layout read), again after web fonts load.
   */
  _placeLabels(w, h) {
    const soma = this._placeSoma(w, h);
    const c = this._ctx;
    if (!c || !c.labelsVisible || !c.labelEls.length) return;
    if (c.needsMeasure) {
      c.needsMeasure = false;
      for (const l of c.labelEls) {
        l.w = l.el.offsetWidth || 0;
        l.h = l.el.offsetHeight || 14;
        if (!(l.w > 0)) { l.w = 6 + 5.4 * l.text.length; c.needsMeasure = true; }   // not laid out yet: estimate, retry
      }
      c.layoutKey = null;
    }
    const v = new THREE.Vector3();
    const m = this._content.matrixWorld;
    let key = `${w}x${h}|${soma ? `${soma.x},${soma.y},${soma.marker ? 1 : 0}` : '-'}`;
    for (const l of c.labelEls) {
      v.copy(l.pos).applyMatrix4(m).project(this.camera);
      l.x = Math.round((v.x + 1) / 2 * w);
      l.y = Math.round((1 - v.y) / 2 * h);
      l.out = l.x < -40 || l.x > w + 8 || l.y < -20 || l.y > h + 20;
      key += `|${l.x},${l.y}`;
    }
    if (key === c.layoutKey) return;
    c.layoutKey = key;
    const live = c.labelEls.filter((l) => !l.out);
    const cell = soma || { x: w / 2, y: h / 2 };
    const items = live.map((l) => {
      // +1 px: offsetWidth rounds, so the drawn box can be up to 0.5 px wider than measured
      const it = { kind: l.kind, text: l.kind === 'point' ? l.text : '', x: l.x, y: l.y, w: l.w + 1, h: l.h, prev: l.side };
      it.priority = labelPriority(it, cell);
      return it;
    });
    const obstacles = soma && soma.marker ? [[soma.x - 6, soma.y - 6, soma.x + 6, soma.y + 6]] : [];
    const soft = soma ? [soma.rect] : [];
    const sides = layoutLabels(items, { obstacles, soft, width: w });
    for (const l of c.labelEls) if (l.out) l.side = null;
    live.forEach((l, i) => { l.side = sides[i]; });
    for (const l of c.labelEls) {
      const side = l.side;
      const tx = side === 'left' ? l.x - l.w - 2 * POINT_DX : l.x;
      const state = side ? `${side}|${tx}|${l.y}` : 'hidden';
      if (state === l.applied) continue;
      l.applied = state;
      if (!side) { l.el.style.visibility = 'hidden'; continue; }
      l.el.style.visibility = '';
      l.el.classList.toggle('is-left', side === 'left');
      l.el.style.transform = `translate3d(${tx}px, ${l.y}px, 0)`;
    }
  }

  /**
   * In context the cell can shrink to a few pixels (a 40 µm neuron in a 1 mm brain) and its siblings crowd
   * round it: a data-black soma marker (the handoff's soma dot, keylined) keeps "this cell" findable until the
   * soma itself is large on screen (≥ SOMA_MARKER_MAX_PX_PER_UM). Returns the soma's screen point (for label
   * priority) or null outside context.
   */
  _placeSoma(w, h) {
    const show = this._ctxActive && !!this._neuronBbox && this._neuronGroup.children.length > 0;
    let res = null;
    if (show) {
      const v = new THREE.Vector3().setFromMatrixPosition(this._neuronGroup.matrixWorld).project(this.camera);
      const x = Math.round((v.x + 1) / 2 * w);
      const y = Math.round((1 - v.y) / 2 * h);
      const onScreen = x > -8 && x < w + 8 && y > -8 && y < h + 8;
      const marker = onScreen && pxPerUmOf(h, this._halfH(), this._view.zoom) < SOMA_MARKER_MAX_PX_PER_UM;
      // the cell's screen footprint (its projected bbox): labels prefer the side that covers less of it
      const b = this._neuronBbox;
      const mw = this._neuronGroup.matrixWorld;
      const rect = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 8; k++) {
        v.set(b[k & 1 ? 3 : 0], b[k & 2 ? 4 : 1], b[k & 4 ? 5 : 2]).applyMatrix4(mw).project(this.camera);
        const px = (v.x + 1) / 2 * w;
        const py = (1 - v.y) / 2 * h;
        rect[0] = Math.min(rect[0], px); rect[1] = Math.min(rect[1], py);
        rect[2] = Math.max(rect[2], px); rect[3] = Math.max(rect[3], py);
      }
      res = { x, y, marker, rect };
      if (marker) {
        if (!this._somaEl) {
          this._somaEl = document.createElement('span');
          this._somaEl.className = 'mv-soma';
          this._labelsEl.appendChild(this._somaEl);
        }
        const t = `translate3d(${x}px, ${y}px, 0)`;
        if (this._somaEl.style.transform !== t) this._somaEl.style.transform = t;
      }
    }
    if (this._somaEl) this._somaEl.hidden = !(res && res.marker);
    return res;
  }

  _frameStat(cpuMs = 0) {
    const s = this._stats;
    const t = performance.now();
    s.cpu = (s.cpu || 0) + cpuMs;
    if (s.last && this._loop && this._loop.continuous) {
      const dt = t - s.last;
      if (dt < 1000) { s.sum += dt; s.max = Math.max(s.max, dt); } else { s.frames = 0; s.sum = 0; }
    }
    s.last = t;
    s.frames++;
  }

  // ---- input: pointer (drag / pinch / tap), wheel, keyboard ----

  _bindInput() {
    const el = this._root;
    const local = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const touch = () => { this._touched = true; this.stopAutoRotate(); this._tween = null; };

    this._on(el, 'pointerdown', (e) => {
      if (e.button !== undefined && e.button > 0 && e.pointerType === 'mouse') return;
      touch();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
      const p = local(e);
      this._pointers.set(e.pointerId, p);
      if (this._pointers.size === 1) {
        this._gesture = { kind: 'drag', start: p, last: p, moved: 0, tapOk: true };
      } else if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        this._gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, tapOk: false };
      } else if (this._gesture) {
        this._gesture.tapOk = false;
      }
    });
    this._on(el, 'pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      const p = local(e);
      this._pointers.set(e.pointerId, p);
      const g = this._gesture;
      if (!g) return;
      if (g.kind === 'drag' && this._pointers.size === 1) {
        const dx = p.x - g.last.x, dy = p.y - g.last.y;
        g.last = p;
        if (!isTap(p.x - g.start.x, p.y - g.start.y)) g.tapOk = false;
        if (this._dragMode === 'pan') {
          const k = this._pxPerUm() || 1;
          this._view = { ...this._view, panX: this._view.panX + dx / k, panY: this._view.panY - dy / k };
        } else {
          this._view = { ...this._view, yaw: this._view.yaw + dx * YAW_PER_PX, tilt: clamp(this._view.tilt + dy * TILT_PER_PX, -TILT_MAX, TILT_MAX) };
        }
        this._changed();
      } else if (g.kind === 'pinch' && this._pointers.size >= 2) {
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const k = this._pxPerUm();
        if (g.dist > 0 && dist > 0) {
          const { w, h } = this._size;
          this._view = { ...this._view, ...zoomAbout(this._view, dist / g.dist, mid.x - w / 2, h / 2 - mid.y, k) };
        }
        const k2 = this._pxPerUm() || 1;
        this._view.panX += (mid.x - g.mid.x) / k2;
        this._view.panY -= (mid.y - g.mid.y) / k2;
        g.dist = dist; g.mid = mid;
        this._changed();
      }
    });
    const end = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      const p = local(e);
      this._pointers.delete(e.pointerId);
      const g = this._gesture;
      if (g && g.kind === 'drag' && e.type === 'pointerup' && g.tapOk && isTap(p.x - g.start.x, p.y - g.start.y)) {
        for (const cb of [...this._tapCbs]) { try { cb({ x: p.x, y: p.y }); } catch (err) { console.error(err); } }
      }
      if (this._pointers.size === 1) {
        const [q] = [...this._pointers.values()];
        this._gesture = { kind: 'drag', start: q, last: q, moved: 0, tapOk: false };
      } else if (!this._pointers.size) {
        this._gesture = null;
      }
    };
    this._on(el, 'pointerup', end);
    this._on(el, 'pointercancel', end);
    this._on(el, 'lostpointercapture', end);
    this._on(el, 'wheel', (e) => {
      e.preventDefault();
      touch();
      const p = local(e);
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
      const f = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 4 : 1));
      const { w, h } = this._size;
      this._view = { ...this._view, ...zoomAbout(this._view, f, p.x - w / 2, h / 2 - p.y, this._pxPerUm()) };
      this._changed();
    }, { passive: false });
    this._on(el, 'keydown', (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const step = e.shiftKey ? 0.4 : 0.1;
      let handled = true;
      switch (e.key) {
        case 'ArrowLeft': touch(); this._view = { ...this._view, yaw: this._view.yaw - step }; break;
        case 'ArrowRight': touch(); this._view = { ...this._view, yaw: this._view.yaw + step }; break;
        case 'ArrowUp': touch(); this._view = { ...this._view, tilt: clamp(this._view.tilt - step, -TILT_MAX, TILT_MAX) }; break;
        case 'ArrowDown': touch(); this._view = { ...this._view, tilt: clamp(this._view.tilt + step, -TILT_MAX, TILT_MAX) }; break;
        case '+': case '=': this.zoomBy(1.25); break;
        case '-': case '_': this.zoomBy(0.8); break;
        case '0': touch(); this.resetView(); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); this._changed(); }
    });
  }
}

export default MeshViewer;
