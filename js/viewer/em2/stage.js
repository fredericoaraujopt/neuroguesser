// EmStage: the EM format 2 viewer (em-v2-spec.md §8, §9). One WebGL2 stage per round (three r186, vendored),
// refcounted in a registry: the round's inline viewer and the full view attach the SAME canvas (textures are uploaded
// once; never a second WebGL context per round).
//
//  - Panels are viewports of one canvas (setViewport + setScissor): single (phone: XY | XZ | YZ | 3D by tabs) or
//    Neuroglancer's 4panel (XY | XZ over 3D | YZ). A Canvas2D overlay draws the vectors (overlay.js).
//  - 2D panels: per-level quads in painter's order (coarse → fine, depth test off), LOD in the fragment shader (a
//    non-coarsest quad discards where it is minified > 2×), nearest from 2× magnification. One shared view
//    (centre x, y, zv and nm per CSS px), as Neuroglancer's global position and cross-section scale.
//  - 3D panel: the public mesh (in the outline's data-orange) with opaque, depth-tested EM planes (XY at the current
//    section, XZ at y = ortho.xz.y_nm, YZ at x = ortho.yz.x_nm), each framed in its normal-axis colour; the default camera
//    sits on the side of the XY plane that holds most of the mesh.
//  - Loading: the §8.6 plan (concurrency 2, one decode at a time), data saver gates, half-resolution decode retry,
//    R8 upload feature test (path B: getImageData → R8 DataTexture), context-loss re-upload from the kept Blobs.
//  - Input: Neuroglancer bindings for mouse, wheel and keyboard; the touch table of model.js classifyTouch.
// Nothing here prints a section thickness, z-step or depth before done (api.md invariant 3); the screens' chrome
// (view.js) does the readouts through model.js.
import * as THREE from 'three';
import { parseGLB } from '../three-common.js';
import * as M from './model.js';
import { QUAD_VERT, QUAD_FRAG, CONTOUR_FRAG, MESH_VERT, MESH_FRAG, LINE_VERT, LINE_FRAG } from './shaders.js';
import { emBlob, withDecoded, bitmapToGrey, testWebpBlob, TEST_GREYS } from './loader.js';
import { cutMesh, meshToLocal, boundsOf } from './mesh-cut.js';
import { renderFootprint } from './footprint.js';
import { Overlay } from './overlay.js';
import { haptic } from '../../fx/haptics.js';
import { motionAllowed } from '../../fx/celebrate.js';
import { loadCss } from '../../ui/html.js';

loadCss('css/em2.css');

const REGISTRY = new Map();      // roundId → { stage, refs, timer }
const DIVED = new Set();         // rounds whose dive has played this session (first open per round)
const MAX_DPR = 2;
const FETCHES = 2;               // fetch concurrency (decodes are serialised in loader.js)
const IDLE_STACK_A_MS = 4000;    // data saver: stack A after 4 s idle
const HAPTIC_MS = 80;
const ARIA_MS = 600;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;
const TWO_TAP_MS = 250;
const ROTATE_PER_PX = 0.01;
const FRAME_MS = 450;            // "0" / "c" framings (the dive is 1.1 s)
const RELEASE_DELAY_MS = 1500;   // a stage outlives its last holder briefly (a remount re-acquires it)
const SLICES_KEY = 'ng-em2-slices';
const TILT_MAX = 1.45;
const FIT3D_FILL = 0.9;          // 3D: the mesh ∪ planes fill 90 % of the panel (Reset / double-tap keep this frame)
const MESH_MIN_HALF_DEV_PX = 1;  // 3D: the mesh is grown by 1 device px along its normals, so neurites stay ≥ 2 px wide

let R8_OK = null;                // the R8-from-ImageBitmap feature test, once per session

const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function parseColor(str, fallback = [0.5, 0.5, 0.5]) {
  const s = String(str || '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return fallback;
}
const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function readSlices() {
  try {
    const v = JSON.parse(localStorage.getItem(SLICES_KEY) || 'null');
    if (v && typeof v === 'object') return { xy: v.xy !== false, xz: !!v.xz, yz: !!v.yz };
  } catch (_) { /* private mode, blocked storage */ }
  return { xy: true, xz: false, yz: false };
}
function writeSlices(s) { try { localStorage.setItem(SLICES_KEY, JSON.stringify(s)); } catch (_) { /* */ } }

const UNIT_QUAD = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
})();

export class EmStage {
  /**
   * The round's stage (created on first use). opts: { em (format 2 object or the dual / v2 inside), meshGlb (ArrayBuffer
   * | Promise of round_public.mesh.asset), mesh (a THREE.BufferGeometry in mesh µm: dev page), done, voxelNm,
   * saveData }.
   */
  static acquire(roundId, opts = {}) {
    let e = REGISTRY.get(roundId);
    if (e && e.stage._disposed) { REGISTRY.delete(roundId); e = null; }
    if (!e) {
      e = { stage: new EmStage(roundId, opts), refs: 0, timer: 0 };
      REGISTRY.set(roundId, e);
    }
    clearTimeout(e.timer);
    e.refs++;
    if (opts.done !== undefined) e.stage.setDone(!!opts.done, opts.voxelNm || null);
    if ((opts.meshGlb || opts.mesh) && !e.stage._meshSource) e.stage._setMeshSource(opts);
    return e.stage;
  }
  /** Live stages (dev page, tests). */
  static registry() { return REGISTRY; }

  constructor(roundId, { em, meshGlb = null, mesh = null, done = false, voxelNm = null, saveData = false } = {}) {
    const parsed = M.parseEm(em);
    if (parsed.kind !== 'v2') throw new Error('EmStage needs an em format 2 object');
    this.roundId = roundId;
    this.v2 = parsed.v2;
    this.done = !!done;
    this.voxelNm = voxelNm;
    this.saveData = !!saveData;
    this._disposed = false;
    this._hosts = [];
    this._changeCbs = new Set();
    this._tapCbs = new Set();
    this._eventCbs = new Set();
    this._listeners = [];
    this.layout = 'single';
    this.panel = 'xy';
    this.focusPanel = 'xy';
    this.section = M.SOMA_INDEX;
    this.layers = { outline: true, mesh: true, axes: null, scaleBar: true, slices3d: readSlices() };
    this._size = { w: 0, h: 0, dpr: 1 };
    this.view = null;            // set on the first measure (Native, or the dive's Whole cell)
    this._limits = null;
    this._meshSide = 0;          // side of the XY plane holding most of the mesh (M.meshSide), once the mesh is in
    this._meshBounds = null;
    this._cam3 = this._defaultCam3();
    this._cam3Auto = true;       // the 3D camera is still the default (no rotate / move / zoom yet)
    this._items = new Map();     // plan id → { item, state, blob, tex, w, h, scale, loaded, total }
    this._outlines = null;
    this._meshLocal = null;      // { positions (EM-local nm), index }
    this._footprints = {};
    this._stats = { gpuBytes: 0, uploads: 0, decodes: 0, renders: 0, frameMs: [], intervals: [], lastFrame: 0 };
    this._anim = null;
    this._raf = 0;
    this._lost = false;
    this._emitKey = '';
    this._wheelAcc = { px: 0, lines: 0, t: 0 };
    this._pointers = new Map();
    this._gesture = null;
    this._lastTap = null;
    this._hapticT = 0;
    this._ariaT = 0;
    this._zTouched = false;
    this._idleTimer = 0;
    this._fetching = 0;
    this._queue = [];
    this._error = null;

    this._plan = M.loadPlan(this.v2, { saveData: this.saveData });
    for (const it of this._plan) this._items.set(it.id, { item: it, state: 'idle', blob: null, tex: null, w: 0, h: 0, scale: 1, loaded: 0, total: it.bytes });
    this._buildDom();
    if (!this._initGl()) return;
    this._buildScenes();
    this._startLoading();
    if (meshGlb || mesh) this._setMeshSource({ meshGlb, mesh });
  }

  // ======================================================================================================= DOM / GL

  _buildDom() {
    const root = document.createElement('div');
    root.className = 'em2-root';
    root.tabIndex = 0;
    root.setAttribute('role', 'img');
    root.setAttribute('aria-roledescription', 'EM viewer');
    root.setAttribute('aria-label', 'Electron micrograph of the cell at its finest resolution. Scroll, the comma and period keys or the arrows up and down change the section; Control or Command with scroll, plus and minus zoom; drag moves; Space switches between one and four panels; 0 frames the native sections, C the whole cell; O outline, M mesh, A axes, B scale bar, S planes in 3D; question mark lists the shortcuts.');
    const canvas = document.createElement('canvas');
    canvas.className = 'em2-gl';
    canvas.setAttribute('aria-hidden', 'true');
    const over = document.createElement('canvas');
    over.className = 'em2-over';
    over.setAttribute('aria-hidden', 'true');
    const labels = document.createElement('div');
    labels.className = 'em2-labels';
    labels.setAttribute('aria-hidden', 'true');
    const mk = (cls, text) => { const el = document.createElement('span'); el.className = `em2-tag ${cls}`; el.textContent = text; el.hidden = true; labels.appendChild(el); return el; };
    this._tags = {
      stack: mk('is-stack', 'z-stack'),
      lost: mk('is-lost', 'Section not imaged'),
      loading: mk('is-loading', 'Loading section…'),
      lens: mk('is-lens', ''),
    };
    const live = document.createElement('div');
    live.className = 'sr-only';
    live.setAttribute('aria-live', 'polite');
    const status = document.createElement('div');
    status.className = 'em2-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    root.append(canvas, over, labels);   // live + status sit beside the root (role="img" children are presentational)
    this.root = root;
    this.canvas = canvas;
    this.overCanvas = over;
    this._live = live;
    this._statusEl = status;
    this.overlay = new Overlay(over);
    this._bindInput();
  }

  _initGl() {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    } catch (err) {
      this._fail('EM needs WebGL, which this browser has turned off.', err);
      return false;
    }
    const r = this.renderer;
    if (!r.capabilities.isWebGL2) { this._fail('EM needs WebGL 2.', null); return false; }
    r.outputColorSpace = THREE.LinearSRGBColorSpace;   // ShaderMaterials write raw values: exact grey levels
    r.toneMapping = THREE.NoToneMapping;
    r.autoClear = false;
    r.setPixelRatio(1);
    this._maxTex = r.capabilities.maxTextureSize;
    this._colors = this._readColors();
    r.setClearColor(new THREE.Color().setRGB(...this._colors.sunkenRGB, THREE.LinearSRGBColorSpace), 1);
    this._on(this.canvas, 'webglcontextlost', (e) => { e.preventDefault(); this._lost = true; });
    this._on(this.canvas, 'webglcontextrestored', () => { this._restore(); });
    return true;
  }

  _readColors() {
    let cs = null;
    try { cs = getComputedStyle(this.root.isConnected ? this.root : document.documentElement); } catch (_) { cs = null; }
    const get = (n) => (cs ? cs.getPropertyValue(n).trim() : '') || 'grey';
    const c = {
      orange: get('--data-orange'), accent: get('--accent'), green: get('--data-green'), purple: get('--data-purple'),
      blue: get('--data-blue'), sunken: get('--surface-sunken'), ink: get('--ink'), black: get('--data-black'),
      hairline: get('--hairline'),
    };
    c.sunkenRGB = parseColor(c.sunken, [0.09, 0.12, 0.16]);
    if (this.overlay) this.overlay.setColors(c);
    return c;
  }

  _fail(text, err) {
    if (err) console.warn('[em2]', err);
    this._error = text;
    this._statusEl.textContent = `✕ ${text}`;
    this._statusEl.hidden = false;
    this._emit(true);
    for (const fn of [...this._eventCbs]) { try { fn({ type: 'error', message: text }); } catch (_) { /* */ } }
  }

  _on(el, type, fn, opts) { el.addEventListener(type, fn, opts); this._listeners.push([el, type, fn, opts]); }

  // ====================================================================================================== scenes

  _quadMat({ three = false, rank = 0, transpose = false } = {}) {
    const m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      uniforms: {
        uTex: { value: null }, uTexSize: { value: new THREE.Vector2(1, 1) }, uTile: { value: new THREE.Vector4(0, 0, 1, 1) },
        uTranspose: { value: transpose ? 1 : 0 }, uCoarsest: { value: 0 }, uSolid: { value: new THREE.Vector4(0, 0, 0, 0) },
        uScrimRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uScrim: { value: 0 }, uScrimGrey: { value: luminance(this._colors.sunkenRGB) },
      },
      side: THREE.DoubleSide,
      depthTest: three,
      depthWrite: three,
      transparent: false,
    });
    if (three) {
      m.depthFunc = THREE.LessEqualDepth;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -0.5 * rank;
      m.polygonOffsetUnits = -4 * rank;
    }
    return m;
  }

  _quad(mat, matrix, renderOrder) {
    const q = new THREE.Mesh(UNIT_QUAD, mat);
    q.matrixAutoUpdate = false;
    q.matrix.copy(matrix);
    q.frustumCulled = false;
    q.renderOrder = renderOrder;
    q.visible = false;
    return q;
  }

  /** 2D placement: unit (u, v) → world (h0 + u·w, −(v0 + v·h)) for rect [h0, v0, h1, v1] in panel coordinates. */
  static m2d(r) { return new THREE.Matrix4().set(r[2] - r[0], 0, 0, r[0], 0, -(r[3] - r[1]), 0, -r[1], 0, 0, 1, 0, 0, 0, 0, 1); }

  _buildScenes() {
    const v2 = this.v2;
    const L = v2.levels.length;
    this.scenes = { xy: new THREE.Scene(), xz: new THREE.Scene(), yz: new THREE.Scene(), '3d': new THREE.Scene() };
    this.cam2 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.cam2.position.set(0, 0, 10);
    this.cam3 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.q2 = { levels: [], stack: null, ortho: { xz: null, yz: null }, ctx: { xz: [], yz: [] }, contour: {} };
    this.q3 = { levels: [], stack: null, ortho: { xz: null, yz: null }, ctx: { xz: [], yz: [] } };

    // ---- XY ----
    for (let l = 0; l < L; l++) {
      const r = v2.levels[l].rect_nm;
      const q = this._quad(this._quadMat(), EmStage.m2d(r), 100 - l);
      this.q2.levels.push(q);
      this.scenes.xy.add(q);
    }
    this.q2.stack = this._quad(this._quadMat(), EmStage.m2d(v2.stack.rect_nm), 200);
    this.scenes.xy.add(this.q2.stack);

    // ---- XZ / YZ ----
    const rects = M.orthoRects(v2);
    const ctxL = v2.ortho_ctx.levels;
    for (let k = ctxL.length - 1; k >= 0; k--) {
      const xz = ctxL[k].xz.rect_nm;          // (x, z)
      const yz = ctxL[k].yz.rect_nm;          // (y, z) in image order → panel (z, y)
      const qxz = this._quad(this._quadMat(), EmStage.m2d(xz), 100 - k);
      const qyz = this._quad(this._quadMat({ transpose: true }), EmStage.m2d([yz[1], yz[0], yz[3], yz[2]]), 100 - k);
      this.q2.ctx.xz[k] = qxz; this.q2.ctx.yz[k] = qyz;
      this.scenes.xz.add(qxz); this.scenes.yz.add(qyz);
    }
    this.q2.ortho.xz = this._quad(this._quadMat(), EmStage.m2d(rects.xz), 200);
    this.q2.ortho.yz = this._quad(this._quadMat({ transpose: true }), EmStage.m2d([rects.yz[1], rects.yz[0], rects.yz[3], rects.yz[2]]), 200);
    this.scenes.xz.add(this.q2.ortho.xz);
    this.scenes.yz.add(this.q2.ortho.yz);

    // ---- 3D: the EM planes inside a group whose matrix is em_to_mesh (EM-local nm → mesh µm) ----
    const s3 = this.scenes['3d'];
    const world = new THREE.Group();
    s3.add(world);
    const em = new THREE.Group();
    em.matrixAutoUpdate = false;
    const e = v2.em_to_mesh;
    em.matrix.set(e[0][0], e[0][1], e[0][2], 0, e[1][0], e[1][1], e[1][2], 0, e[2][0], e[2][1], e[2][2], 0, 0, 0, 0, 1);
    world.add(em);
    this.g3 = { world, em, xy: new THREE.Group(), xz: new THREE.Group(), yz: new THREE.Group(), mesh: null };
    em.add(this.g3.xy, this.g3.xz, this.g3.yz);
    const xyM = (r) => new THREE.Matrix4().set(r[2] - r[0], 0, 0, r[0], 0, r[3] - r[1], 0, r[1], 0, 0, 1, 0, 0, 0, 0, 1);
    for (let l = 0; l < L; l++) {
      const q = this._quad(this._quadMat({ three: true, rank: L - 1 - l }), xyM(v2.levels[l].rect_nm), 10 + (L - 1 - l));
      this.q3.levels.push(q);
      this.g3.xy.add(q);
    }
    this.q3.stack = this._quad(this._quadMat({ three: true, rank: L + 1 }), xyM(v2.stack.rect_nm), 10 + L + 1);
    this.g3.xy.add(this.q3.stack);
    const y = v2.ortho.xz.y_nm;
    const x = v2.ortho.yz.x_nm;
    const xzM = (r) => new THREE.Matrix4().set(r[2] - r[0], 0, 0, r[0], 0, 0, 1, y, 0, r[3] - r[1], 0, r[1], 0, 0, 0, 1);
    const yzM = (r) => new THREE.Matrix4().set(0, 0, 1, x, r[2] - r[0], 0, 0, r[0], 0, r[3] - r[1], 0, r[1], 0, 0, 0, 1);
    for (let k = ctxL.length - 1; k >= 0; k--) {
      const rank = ctxL.length - 1 - k;
      const a = this._quad(this._quadMat({ three: true, rank }), xzM(ctxL[k].xz.rect_nm), 10 + rank);
      const b = this._quad(this._quadMat({ three: true, rank }), yzM(ctxL[k].yz.rect_nm), 10 + rank);
      this.q3.ctx.xz[k] = a; this.q3.ctx.yz[k] = b;
      this.g3.xz.add(a); this.g3.yz.add(b);
    }
    this.q3.ortho.xz = this._quad(this._quadMat({ three: true, rank: ctxL.length + 1 }), xzM(rects.xz), 20);
    this.q3.ortho.yz = this._quad(this._quadMat({ three: true, rank: ctxL.length + 1 }), yzM(rects.yz), 20);
    this.g3.xz.add(this.q3.ortho.xz);
    this.g3.yz.add(this.q3.ortho.yz);
    // frames: XY blue (the coarsest level), XZ green, YZ purple (the coarsest context rects), the stack in accent
    const C = this._colors;
    const frame = (pts, color, order = 50) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
        uniforms: { uColor: { value: new THREE.Vector3(...parseColor(color)) }, uAlpha: { value: 1 } },
        depthTest: false, depthWrite: false, transparent: true,
      });
      const l = new THREE.LineLoop(g, m);
      l.frustumCulled = false;
      l.renderOrder = order;
      return l;
    };
    const rc = M.coarsestRect(v2);
    this.g3.xy.add(frame([rc[0], rc[1], 0, rc[2], rc[1], 0, rc[2], rc[3], 0, rc[0], rc[3], 0], C.blue));
    const st = v2.stack.rect_nm;
    this.g3.xy.add(frame([st[0], st[1], 0, st[2], st[1], 0, st[2], st[3], 0, st[0], st[3], 0], C.accent, 51));
    const cx = ctxL[ctxL.length - 1];
    const rx = cx.xz.rect_nm;
    this.g3.xz.add(frame([rx[0], y, rx[1], rx[2], y, rx[1], rx[2], y, rx[3], rx[0], y, rx[3]], C.green));
    const ry = cx.yz.rect_nm;
    this.g3.yz.add(frame([x, ry[0], ry[1], x, ry[2], ry[1], x, ry[2], ry[3], x, ry[0], ry[3]], C.purple));
  }

  _contourQuad(plane, fp) {
    const m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: QUAD_VERT, fragmentShader: CONTOUR_FRAG,
      uniforms: {
        uFoot: { value: fp.target.texture }, uFootSize: { value: new THREE.Vector2(fp.size[0], fp.size[1]) },
        uColor: { value: new THREE.Vector3(...parseColor(this._colors.black)) }, uAlpha: { value: 0 },
      },
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const q = this._quad(m, EmStage.m2d(fp.rect), 1000);
    this.scenes[plane].add(q);
    this.q2.contour[plane] = q;
  }

  // ============================================================================================ hosts and layout

  /** Move the canvas into `host` (the most recent attach wins; detach returns it to the previous host). */
  attach(host, { layout = 'single', panel = 'xy' } = {}) {
    const rec = { host, layout: layout === 'quad' ? 'quad' : 'single', panel: M.PANELS.includes(panel) ? panel : 'xy' };
    this._hosts.push(rec);
    this._applyHost(rec);
    return rec;
  }
  detach(rec) {
    const i = this._hosts.indexOf(rec);
    if (i < 0) return;
    const top = i === this._hosts.length - 1;
    this._hosts.splice(i, 1);
    if (!top) return;
    const prev = this._hosts[this._hosts.length - 1];
    if (prev) this._applyHost(prev);
    else for (const el of [this.root, this._live, this._statusEl]) if (el.parentNode) el.parentNode.removeChild(el);
  }
  _applyHost(rec) {
    if (this.root.parentNode !== rec.host) rec.host.append(this.root, this._live, this._statusEl);
    this.layout = rec.layout;
    this.panel = rec.panel;
    this.focusPanel = rec.layout === 'quad' ? 'xy' : rec.panel;
    if (!this._ro && typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._measure(); this.invalidate(); });
      this._ro.observe(this.root);
    }
    this._measure();
    this._readColors();
    this.invalidate(true);
  }
  get host() { const t = this._hosts[this._hosts.length - 1]; return t ? t.host : null; }

  setLayout(l) {
    const layout = l === 'quad' ? 'quad' : 'single';
    if (layout === this.layout) return;
    this.layout = layout;
    const t = this._hosts[this._hosts.length - 1];
    if (t) t.layout = layout;
    if (layout === 'single') this.panel = this.focusPanel || this.panel;
    this._afterResize();
    haptic('selection');
    this.invalidate(true);
  }
  setPanel(p) {
    if (!M.PANELS.includes(p)) return;
    this.panel = p;
    this.focusPanel = p;
    const t = this._hosts[this._hosts.length - 1];
    if (t) t.panel = p;
    if (p !== 'xy' && p !== '3d') this._promoteCtxIfNeeded();
    if (p === '3d' && (this.layers.slices3d.xz || this.layers.slices3d.yz)) this._promote('ctx');
    this._afterResize();
    this.invalidate(true);
  }
  setDone(done, voxelNm = null) {
    this.done = !!done;
    if (voxelNm) this.voxelNm = voxelNm;
    this.invalidate(true);
  }

  /** Layers: { outline, mesh, axes, scaleBar, slices3d: { xy, xz, yz } } (partial). */
  setLayers(l = {}) {
    const next = { ...this.layers };
    for (const k of ['outline', 'mesh', 'axes', 'scaleBar']) if (l[k] !== undefined) next[k] = l[k] === null ? null : !!l[k];
    if (l.slices3d) {
      next.slices3d = { ...next.slices3d, ...l.slices3d };
      writeSlices(next.slices3d);
      if (next.slices3d.xz || next.slices3d.yz) this._promote('ctx');
    }
    this.layers = next;
    this.invalidate(true);
  }
  axesOn() { return this.layers.axes === null ? this.layout === 'quad' : this.layers.axes; }

  // ================================================================================================== sections

  setSection(i, { user = false } = {}) {
    const k = M.clampSection(i);
    if (k === this.section) return;
    this.section = k;
    if (user) this._noteZ();
    if (this.saveData && M.wantsStackB(k)) this._release('deep');
    this._scheduleAria();
    this.invalidate(true);
  }
  getSection() { return this.section; }
  /** ±d sections (haptic: selection per step, throttled 80 ms; light at an end). */
  step(d) {
    const before = this.section;
    this.setSection(before + Math.round(d || 0), { user: true });
    if (this.section === before && d) { haptic('light'); return; }
    const t = now();
    if (this.section === 0 || this.section === M.N_SECTIONS - 1) haptic('light');
    else if (t - this._hapticT >= HAPTIC_MS) { this._hapticT = t; haptic('selection'); }
  }
  _noteZ() {
    if (!this._zTouched) { this._zTouched = true; this._release('z-or-idle'); }
  }
  _scheduleAria() {
    clearTimeout(this._ariaT);
    this._ariaT = setTimeout(() => {
      if (this._disposed) return;
      this._live.textContent = M.ariaSection(this.section, M.N_SECTIONS, M.isMissing(this.v2, this.section));
    }, ARIA_MS);
  }

  // ===================================================================================================== views

  _panelSize(id = null) {
    const { w, h } = this._size;
    const rects = M.panelRects(this.layout, this.panel, w, h);
    const want = id || (this.layout === 'quad' ? 'xy' : this.panel);
    return rects.find((r) => r.id === want) || rects[0];
  }
  _cellPlanes() {
    if (this.layout === 'quad') return ['xy', 'xz', 'yz'];
    return [this.panel === '3d' ? 'xy' : this.panel];
  }
  _framing(kind) {
    const p = this._panelSize(this.layout === 'quad' ? 'xy' : (this.panel === '3d' ? null : this.panel));
    if (kind === 'cell') return M.frameCell(this.v2, p.w, p.h, this._cellPlanes());
    return M.frameNative(this.v2, p.w, p.h, this._size.dpr);
  }
  _afterResize() {
    if (!(this._size.w > 0 && this._size.h > 0)) return;
    const cell = this._framing('cell');
    this._limits = M.zoomLimits(this.v2, cell.u, this._size.dpr);
    if (!this.view) this._firstView();
    else this.view = M.clampView(this.view, this.v2, this._limits);
    this._onViewChanged();
  }
  _firstView() {
    const native = this._framing('native');
    const dive = !DIVED.has(this.roundId) && motionAllowed();
    DIVED.add(this.roundId);
    if (!dive) { this.view = M.clampView(native, this.v2, this._limits); this._onViewChanged(); return; }
    this.view = M.clampView(this._framing('cell'), this.v2, this._limits);
    this._diveArmed = { at: now() };
    this._maybeDive();
  }
  _maybeDive() {
    const d = this._diveArmed;
    if (!d || this._anim) return;
    const ready = this._ready('level0') && this._ready('stackA');
    if (ready || now() - d.at >= M.DIVE_WAIT_MS) {
      this._diveArmed = null;
      this.dive();
    } else if (!d.timer) {
      d.timer = setTimeout(() => { if (this._diveArmed === d) { d.timer = 0; this._maybeDive(); } }, M.DIVE_WAIT_MS);
    }
  }
  /** Whole cell → Native over 1.1 s (log zoom, ease-in-out cubic); any input cancels it. */
  dive() {
    const to = M.clampView(this._framing('native'), this.v2, this._limits);
    if (!motionAllowed()) { this.view = to; this._onViewChanged(); this.invalidate(true); return; }
    this._animate(this.view, to, M.DIVE_MS, 'dive');
  }
  /** 'native' | 'cell' (the "Native" / "Whole cell" button, keys 0 and c). In 3D: reset the camera. */
  frame(kind, { animate = true } = {}) {
    if (!this.view) return;
    if (this.layout === 'single' && this.panel === '3d') { this._reset3d(); return; }
    const to = M.clampView({ ...this._framing(kind === 'cell' ? 'cell' : 'native') }, this.v2, this._limits);
    if (animate && motionAllowed()) this._animate(this.view, to, FRAME_MS, 'frame');
    else { this._cancelAnim(); this.view = to; this._onViewChanged(); this.invalidate(true); }
  }
  /** Which framing the view is nearer to (log scale): 'native' | 'cell'. */
  nearFraming() {
    if (!this.view || !this._size.w) return 'native';
    const a = Math.abs(Math.log(this.view.u / this._framing('native').u));
    const b = Math.abs(Math.log(this.view.u / this._framing('cell').u));
    return a <= b ? 'native' : 'cell';
  }
  /** Look again (reveal): round_reveal.method.look_again item → panel, section and view. */
  applyPreset(item) {
    DIVED.add(this.roundId);
    this._diveArmed = null;
    const p = this._panelSize(this.layout === 'quad' ? 'xy' : (item && item.panel !== '3d' ? item.panel : 'xy'));
    const r = M.lookAgainView(item, this.v2, { w: p.w || 375, h: p.h || 300, dpr: this._size.dpr });
    if (this.layout === 'single') this.setPanel(r.panel);
    this.focusPanel = r.panel;
    this.section = r.section;
    this._cancelAnim();
    if (this._limits) this.view = M.clampView(r.view, this.v2, this._limits);
    else { this.view = r.view; this._afterResize(); }
    if (r.panel !== 'xy' && r.panel !== '3d') this._promote('ctx');
    if (r.panel === '3d') this._reset3d();
    this._onViewChanged();
    this.invalidate(true);
  }
  setView({ cx, cy, zv, nmPerPx } = {}) {
    if (!this.view) return;
    this._cancelAnim();
    const v = { ...this.view };
    if (Number.isFinite(cx)) v.cx = cx;
    if (Number.isFinite(cy)) v.cy = cy;
    if (Number.isFinite(zv)) v.zv = zv;
    if (nmPerPx > 0) v.u = nmPerPx;
    this.view = M.clampView(v, this.v2, this._limits);
    this._onViewChanged();
    this.invalidate(true);
  }
  getView() { return this.view ? { cx: this.view.cx, cy: this.view.cy, zv: this.view.zv, nmPerPx: this.view.u } : null; }
  /** Zoom about the focus panel's centre (buttons, keys). */
  zoomBy(f) {
    this._cancelAnim();
    if (this._focusIs3d()) { this._zoom3d(f); return; }
    if (!this.view) return;
    const p = this._panelSize(this._focus2d());
    this.view = M.clampView(M.zoomViewAbout(this._focus2d(), this.view, f, p.w / 2, p.h / 2, p.w, p.h, this._limits), this.v2, this._limits);
    this._onViewChanged();
    this.invalidate(true);
  }
  _focus2d() { const f = this.layout === 'quad' ? this.focusPanel : this.panel; return f === '3d' ? 'xy' : f; }
  _focusIs3d() { return (this.layout === 'quad' ? this.focusPanel : this.panel) === '3d'; }

  _animate(from, to, ms, kind) {
    this._anim = { from: { ...from }, to: { ...to }, t0: now(), ms, kind };
    this.invalidate();
  }
  _cancelAnim() {
    if (this._diveArmed) { clearTimeout(this._diveArmed.timer); this._diveArmed = null; }
    if (this._anim) { this._anim = null; this.invalidate(true); }
  }
  _tickAnim() {
    const a = this._anim;
    if (!a) return false;
    const t = (now() - a.t0) / a.ms;
    this.view = M.diveView(Math.min(1, t), a.from, a.to);
    if (t >= 1) { this.view = { ...a.to }; this._anim = null; this._onViewChanged(); return false; }
    return true;
  }
  _onViewChanged() { this._lodWants(); this._promoteCtxIfNeeded(); }

  // ========================================================================================================= 3D

  _reset3d() {
    this._cam3 = this._defaultCam3();
    this._cam3Auto = true;
    this.invalidate(true);
  }
  /** On the side of the opaque XY plane that holds most of the mesh (so the plane never hides the neuron), framed on
   *  the mesh ∪ the planes as seen from there (M.fitView3d), not on a sphere about the soma. */
  _defaultCam3() {
    const ang = M.defaultCamera3d(this.v2, { side: this._meshSide });
    const fit = M.fitView3d(this._fitPoints3d(), ang);
    return { ...ang, zoom: 1, target: new THREE.Vector3(...fit.target), fit };
  }
  /** Corners (mesh µm) of the planes (the coarsest XY level × B_z; the XZ / YZ context spans B) and of the mesh. */
  _fitPoints3d() {
    const v2 = this.v2;
    const rc = M.coarsestRect(v2);
    const b = v2.bbox_nm;
    const pts = [];
    for (const x of [rc[0], rc[2]]) for (const y of [rc[1], rc[3]]) for (const z of [b[2], b[5]]) pts.push(M.emToMesh(v2, [x, y, z]));
    const m = this._meshBounds;
    if (m) for (const x of [m[0], m[3]]) for (const y of [m[1], m[4]]) for (const z of [m[2], m[5]]) pts.push([x, y, z]);
    return pts;
  }
  _zoom3d(f) { this._cam3Auto = false; this._cam3.zoom = M.clamp(this._cam3.zoom * f, 0.25, 64); this.invalidate(true); }
  _fit3d() {
    if (this._fitR) return this._fitR;
    const pts = [];
    const b = this.v2.bbox_nm;
    for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) pts.push(M.emToMesh(this.v2, [x, y, z]));
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p[0], p[1], p[2]));
    if (this._meshBounds) { const m = this._meshBounds; for (const x of [m[0], m[3]]) for (const y of [m[1], m[4]]) for (const z of [m[2], m[5]]) r = Math.max(r, Math.hypot(x, y, z)); }
    this._fitR = r > 0 ? r : 100;
    return this._fitR;
  }
  _setCam3(p) {
    const R = this._fit3d();
    const c = this._cam3;
    const aspect = p.w / Math.max(1, p.h);
    let hh;
    if (c.fit) hh = Math.max(c.fit.hh, c.fit.hw / aspect) / FIT3D_FILL;
    else { const half = R / 0.92; hh = aspect >= 1 ? half : half / aspect; }
    const cam = this.cam3;
    cam.left = -hh * aspect; cam.right = hh * aspect; cam.top = hh; cam.bottom = -hh;
    cam.near = 0.01 * R; cam.far = 40 * R;
    cam.zoom = c.zoom;
    const d = new THREE.Vector3(Math.sin(c.yaw) * Math.cos(c.tilt), Math.sin(c.tilt), Math.cos(c.yaw) * Math.cos(c.tilt));
    cam.position.copy(c.target).addScaledVector(d, 20 * R);
    cam.up.set(0, 1, 0);
    cam.lookAt(c.target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return (p.h * c.zoom) / (2 * hh);   // CSS px per µm
  }
  _pan3d(dx, dy, p) {
    this._cam3Auto = false;
    const pxPerUm = this._setCam3(p);
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam3.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.cam3.matrixWorld, 1);
    this._cam3.target.addScaledVector(right, -dx / pxPerUm).addScaledVector(up, dy / pxPerUm);
    this.invalidate(true);
  }

  // ================================================================================================= mesh

  _setMeshSource({ meshGlb = null, mesh = null }) {
    this._meshSource = meshGlb || mesh;
    Promise.resolve(meshGlb).then(async (buf) => {
      let geom;
      if (mesh && mesh.isBufferGeometry) geom = mesh;
      else if (buf) {
        const scene = await parseGLB(buf instanceof ArrayBuffer ? buf.slice(0) : buf);
        scene.updateMatrixWorld(true);
        scene.traverse((o) => {
          if (geom || !o.isMesh || !o.geometry) return;
          geom = o.geometry.clone();
          geom.applyMatrix4(o.matrixWorld);
        });
      }
      if (!geom || this._disposed) return;
      if (!geom.getAttribute('normal')) geom.computeVertexNormals();
      this._addMesh(geom);
    }).catch((err) => { console.warn('[em2] mesh', err); this._meshFailed = true; this._emit(true); });
  }

  _addMesh(geom) {
    const pos = geom.getAttribute('position').array;
    const idx = geom.getIndex() ? geom.getIndex().array : null;
    this._meshBounds = boundsOf(pos);
    this._fitR = 0;
    const inv = M.mat3Inverse(this.v2.em_to_mesh);
    if (inv) {
      const local = meshToLocal(pos, inv);
      this._meshLocal = { positions: local, index: idx };
      this._meshSide = M.meshSide(this.v2, local, M.SOMA_INDEX);
      if (this._cam3Auto) this._reset3d();
      this._buildFootprints();
    }
    // data-orange, the colour of "this cell" in the 2D panels (Neuroglancer draws segment meshes in their segment
    // colour): data-black, the type stage's colour on a dark background, is a light grey that disappears into the
    // greyscale EM planes it crosses.
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: MESH_VERT, fragmentShader: MESH_FRAG,
      uniforms: { uColor: { value: new THREE.Vector3(...parseColor(this._colors.orange)) }, uInflate: { value: 0 } },
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geom, mat);
    m.frustumCulled = false;
    m.renderOrder = 5;
    this.g3.mesh = m;
    this.g3.world.add(m);
    this.overlay.cuts.clear();
    this.invalidate(true);
  }

  _buildFootprints() {
    if (!this._meshLocal || !this.renderer || this._lost) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this._meshLocal.positions, 3));
    if (this._meshLocal.index) g.setIndex(new THREE.BufferAttribute(this._meshLocal.index, 1));
    this._footGeom = g;
    const v2 = this.v2;
    const ctxL = v2.ortho_ctx.levels[v2.ortho_ctx.levels.length - 1];
    const yz = ctxL.yz.rect_nm;
    const planes = { xy: M.coarsestRect(v2), xz: ctxL.xz.rect_nm, yz: [yz[1], yz[0], yz[3], yz[2]] };
    for (const [plane, rect] of Object.entries(planes)) {
      try {
        const fp = renderFootprint(this.renderer, g, plane, rect);
        this._footprints[plane] = fp;
        this._stats.gpuBytes += fp.size[0] * fp.size[1];
        this._contourQuad(plane, fp);
      } catch (err) { console.warn('[em2] footprint', err); }
    }
  }

  _cut(key) {
    const ml = this._meshLocal;
    if (!ml) return null;
    return this.overlay.cut(key, () => {
      if (key === 'xz') return cutMesh(ml.positions, ml.index, 'y', this.v2.ortho.xz.y_nm);
      if (key === 'yz') return cutMesh(ml.positions, ml.index, 'x', this.v2.ortho.yz.x_nm);
      const i = Number(key.slice(3));
      return cutMesh(ml.positions, ml.index, 'z', M.sectionZ(this.v2, i));
    });
  }

  // =============================================================================================== loading

  _startLoading() {
    for (const it of this._plan) if (it.gate === 'now') this._queue.push(it.id);
    if (this.saveData) {
      this._idleTimer = setTimeout(() => this._release('z-or-idle'), IDLE_STACK_A_MS);
    }
    this._pump();
  }
  _release(gate) {
    for (const it of this._plan) {
      if (it.gate !== gate) continue;
      const e = this._items.get(it.id);
      if (e.state === 'idle' && !this._queue.includes(it.id)) this._queue.push(it.id);
    }
    this._pump();
  }
  /** Start an item now (ahead of the queue). */
  _promote(id) {
    const e = this._items.get(id);
    if (!e || e.state !== 'idle') return;
    this._queue = this._queue.filter((x) => x !== id);
    this._queue.unshift(id);
    this._pump(true);
  }
  _promoteCtxIfNeeded() {
    if (!this.view) return;
    const e = this._items.get('ctx');
    if (!e || e.state !== 'idle') return;
    const panels = M.panelRects(this.layout, this.panel, this._size.w, this._size.h).filter((p) => p.id === 'xz' || p.id === 'yz');
    if (!panels.length) return;
    const rects = M.orthoRects(this.v2);
    for (const p of panels) {
      const [a0, b0] = M.screenToPlane(p.id, this.view, p.w, p.h, 0, 0);
      const [a1, b1] = M.screenToPlane(p.id, this.view, p.w, p.h, p.w, p.h);
      const nr = p.id === 'xz' ? rects.xz : [rects.yz[1], rects.yz[0], rects.yz[3], rects.yz[2]];
      if (!M.rectContains(nr, [a0, b0, a1, b1])) { this._promote('ctx'); return; }
    }
  }
  /**
   * Data saver: levels 1…L−1 only when the LOD rule wants them on screen — from the finest level that is not minified
   * > 2× (f) up to the first level whose rect holds the whole XY view (g): with every level loaded, exactly f…g would
   * show. Normal mode: the levels still queued are reordered, nearest to the current zoom first.
   */
  _lodWants() {
    if (!this.view || !this._size.w) return;
    const v2 = this.v2;
    const nmPerDev = this.view.u / this._size.dpr;
    const L = v2.levels.length - 1;
    if (this.saveData) {
      const p = this._panelSize('xy');
      const [a0, b0] = M.screenToPlane('xy', this.view, p.w, p.h, 0, 0);
      const [a1, b1] = M.screenToPlane('xy', this.view, p.w, p.h, p.w, p.h);
      const viewRect = [a0, b0, a1, b1];
      let f = 0;
      while (f < L && M.texelDev(v2.levels[f].px_nm, nmPerDev) < M.LOD_DISCARD) f++;
      let g = f;
      while (g < L && !M.rectContains(v2.levels[g].rect_nm, viewRect)) g++;
      for (let l = Math.max(1, f); l <= Math.min(L - 1, g); l++) {
        if (M.rectsIntersect(v2.levels[l].rect_nm, viewRect)) this._promote(`level${l}`);
      }
      return;
    }
    const lv = (id) => (id.startsWith('level') ? Number(id.slice(5)) : -1);
    const dist = (id) => Math.abs(Math.log2(Math.min(...v2.levels[lv(id)].px_nm) / Math.max(1e-9, nmPerDev)));
    const levels = this._queue.filter((id) => lv(id) > 0 && lv(id) < L).sort((x, y) => dist(x) - dist(y));
    if (levels.length > 1) {
      const rest = this._queue.filter((id) => !levels.includes(id));
      const firstLow = rest.findIndex((id) => this._items.get(id).item.group > 4);
      const at = firstLow < 0 ? rest.length : firstLow;
      this._queue = [...rest.slice(0, at), ...levels, ...rest.slice(at)];
    }
  }
  _ready(id) { const e = this._items.get(id); return !!(e && e.state === 'ready'); }
  _pump(urgent = false) {
    while (this._queue.length && (this._fetching < FETCHES || urgent)) {
      urgent = false;
      const id = this._queue.shift();
      const e = this._items.get(id);
      if (!e || e.state !== 'idle') continue;
      this._load(e);
    }
  }
  async _load(e) {
    const it = e.item;
    e.state = 'loading';
    this._fetching++;
    let blob;
    try {
      blob = await emBlob(it.asset, {
        priority: it.priority,
        expectBytes: it.bytes,
        onProgress: (loaded, total) => { e.loaded = loaded; e.total = total || e.total; this._emit(); },
      });
    } catch (err) {
      this._fetching--;
      e.state = 'failed';
      e.error = err;
      console.warn('[em2] load', it.id, err);
      this._afterItem(e);
      this._pump();   // the rest of the plan still loads
      return;
    }
    this._fetching--;
    this._pump();
    if (this._disposed) return;
    e.blob = blob;
    try {
      if (it.kind === 'outlines') {
        this._outlines = JSON.parse(await blob.text());
        this.overlay.setOutlines(this._outlines, this.v2);
      } else {
        await this._decodeInto(e);
      }
      e.state = this._disposed ? 'idle' : 'ready';
    } catch (err) {
      e.state = 'failed';
      e.error = err;
      console.warn('[em2] decode', it.id, err);
    }
    this._afterItem(e);
  }
  _afterItem(e) {
    if (this._disposed) return;
    this._emit(true);
    this._maybeDive();
    // no XY level at all: the stage failed to load (a dual round falls back to format 1)
    if (e.item.kind === 'level' && e.state === 'failed' && this._allFailed()) this._fail('Could not load this EM.', e.error);
    this.invalidate(true);
    for (const fn of [...this._eventCbs]) { try { fn({ type: 'item', id: e.item.id, state: e.state }); } catch (_) { /* */ } }
  }
  _allFailed() {
    for (const e of this._items.values()) if (e.item.kind === 'level' && e.state !== 'failed') return false;
    return true;
  }
  _imageSize(it) {
    const v2 = this.v2;
    if (it.kind === 'level') return v2.levels[it.index].size_px;
    if (it.kind === 'stack') return [v2.stack.size_px * (v2.stack.cols || 4), v2.stack.size_px * 4];
    if (it.kind === 'ortho') return [v2.ortho.width_px || 1024, v2.ortho.rows * 2];
    if (it.kind === 'ctx') return v2.ortho_ctx.size_px;
    return null;
  }
  async _decodeInto(e) {
    if (this._lost) throw new Error('context lost');
    const size = this._imageSize(e.item);
    if (size && Math.max(size[0], size[1]) > this._maxTex) throw new Error(`texture ${size} exceeds the GPU limit ${this._maxTex}`);
    await withDecoded(e.blob, size, async (bmp, { scale }) => {
      if (this._disposed) return;
      if (R8_OK === null) R8_OK = await this._featureTest();
      this._stats.decodes++;
      const tex = this._makeTexture(bmp);
      e.tex = tex; e.w = bmp.width; e.h = bmp.height; e.scale = scale;
      this._stats.gpuBytes += bmp.width * bmp.height;
      this._stats.uploads++;
      this._bindTexture(e);
    });
  }
  _makeTexture(bmp) {
    let tex;
    if (R8_OK) {
      tex = new THREE.Texture(bmp);
      tex.format = THREE.RedFormat;
      tex.type = THREE.UnsignedByteType;
    } else {
      const g = bitmapToGrey(bmp);
      tex = new THREE.DataTexture(g.data, g.width, g.height, THREE.RedFormat, THREE.UnsignedByteType);
      tex.unpackAlignment = 1;
    }
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = false;
    tex.premultiplyAlpha = false;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.renderer.initTexture(tex);
    // the bitmap is closed after this upload: keep only its size (a context restore re-decodes from the Blob)
    if (R8_OK) tex.image = { width: bmp.width, height: bmp.height };
    else tex.image = { width: bmp.width, height: bmp.height, data: null };
    return tex;
  }

  /** Point every quad that shows item e at its texture (tiles in the texture's own pixels: half-res aware). */
  _bindTexture(e) {
    const v2 = this.v2;
    const it = e.item;
    const s = e.scale;
    const set = (q, tile, coarsestOk = false) => {
      if (!q) return;
      const u = q.material.uniforms;
      u.uTex.value = e.tex;
      u.uTexSize.value.set(e.w, e.h);
      u.uTile.value.set(tile[0] * s, tile[1] * s, tile[2] * s, tile[3] * s);
      if (coarsestOk) u.uCoarsest.value = 1;
    };
    if (it.kind === 'level') {
      const sz = v2.levels[it.index].size_px;
      set(this.q2.levels[it.index], [0, 0, sz[0], sz[1]]);
      set(this.q3.levels[it.index], [0, 0, sz[0], sz[1]]);
    } else if (it.kind === 'ortho') {
      const n = v2.ortho.rows;
      const w = v2.ortho.width_px || 1024;
      set(this.q2.ortho.xz, [0, 0, w, n]); set(this.q3.ortho.xz, [0, 0, w, n]);
      set(this.q2.ortho.yz, [0, n, w, n]); set(this.q3.ortho.yz, [0, n, w, n]);
    } else if (it.kind === 'ctx') {
      v2.ortho_ctx.levels.forEach((l, k) => {
        set(this.q2.ctx.xz[k], l.xz.atlas_px); set(this.q3.ctx.xz[k], l.xz.atlas_px);
        set(this.q2.ctx.yz[k], l.yz.atlas_px); set(this.q3.ctx.yz[k], l.yz.atlas_px);
      });
    }
    // stack chunks are bound per frame (the tile follows the section)
  }

  async _featureTest() {
    try {
      const blob = testWebpBlob();
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const tex = new THREE.Texture(bmp);
      tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType; tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = false; tex.generateMipmaps = false; tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      const target = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      const mat = this._quadMat();
      mat.uniforms.uTex.value = tex;
      mat.uniforms.uTexSize.value.set(4, 4);
      mat.uniforms.uTile.value.set(0, 0, 4, 4);
      mat.uniforms.uCoarsest.value = 1;
      const scene = new THREE.Scene();
      const q = this._quad(mat, new THREE.Matrix4(), 0);
      q.visible = true;
      scene.add(q);
      const cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);   // unit quad, row 0 (v = 0) at the bottom row
      const prev = this.renderer.getRenderTarget();
      const sc = this.renderer.getScissorTest();
      this.renderer.setScissorTest(false);
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, true, false);
      this.renderer.render(scene, cam);
      const px = new Uint8Array(4 * 16);
      this.renderer.readRenderTargetPixels(target, 0, 0, 4, 4, px);
      this.renderer.setRenderTarget(prev);
      this.renderer.setScissorTest(sc);
      bmp.close();
      tex.dispose(); target.dispose(); mat.dispose();
      for (let i = 0; i < 16; i++) if (Math.abs(px[i * 4] - TEST_GREYS[i]) > 2) { console.warn('[em2] R8 upload feature test failed: path B'); return false; }
      return true;
    } catch (err) {
      console.warn('[em2] R8 feature test error: path B', err);
      return false;
    }
  }

  async _restore() {
    // WebGL context restored: three re-initialises its state; textures and footprints are rebuilt from the Blobs.
    // three's new state has forgotten the clear colour (no-data areas would turn black instead of surface-sunken), and
    // no material may keep a texture of the lost context: a lost or loading stack quad still binds its last tile while
    // it draws a flat colour, and three would try to re-upload it from a closed bitmap (a console error every frame).
    this.renderer.setClearColor(new THREE.Color().setRGB(...this._colors.sunkenRGB, THREE.LinearSRGBColorSpace), 1);
    for (const sc of Object.values(this.scenes)) {
      sc.traverse((o) => { const u = o.material && o.material.uniforms; if (u && u.uTex) u.uTex.value = null; });
    }
    this._stats.gpuBytes = 0;
    const ready = [...this._items.values()].filter((e) => e.state === 'ready' && e.item.kind !== 'outlines');
    for (const e of ready) { e.state = 'loading'; e.tex = null; }
    for (const q of Object.values(this.q2.contour)) { this.scenes.xy.remove(q); this.scenes.xz.remove(q); this.scenes.yz.remove(q); }
    this.q2.contour = {};
    this._footprints = {};
    this._lost = false;
    if (this._meshLocal) this._buildFootprints();
    for (const e of ready) {
      try { await this._decodeInto(e); e.state = 'ready'; } catch (err) { e.state = 'failed'; console.warn('[em2] restore', err); }
    }
    this.invalidate(true);
  }

  // ================================================================================================ rendering

  _measure() {
    const r = this.root;
    if (!r || !r.isConnected) return;
    const w = Math.max(0, r.clientWidth);
    const h = Math.max(0, r.clientHeight);
    const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
    const changed = w !== this._size.w || h !== this._size.h || dpr !== this._size.dpr;
    this._size = { w, h, dpr };
    if (!changed || !w || !h || !this.renderer) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.overCanvas.width = Math.round(w * dpr);
    this.overCanvas.height = Math.round(h * dpr);
    this._afterResize();
  }

  invalidate(emit = false) {
    if (emit) this._emitDirty = true;
    if (this._disposed || this._raf) return;
    if (typeof requestAnimationFrame !== 'function') return;
    this._raf = requestAnimationFrame((t) => { this._raf = 0; this._frame(t); });
  }

  _frame(t) {
    if (this._disposed) return;
    const s = this._stats;
    if (s.lastFrame) { s.intervals.push(t - s.lastFrame); if (s.intervals.length > 240) s.intervals.shift(); }
    const animating = this._tickAnim();
    if (!this._lost && this.renderer && this.view && this._size.w > 0 && this._size.h > 0) {
      const t0 = now();
      this._render();
      s.frameMs.push(now() - t0);
      if (s.frameMs.length > 240) s.frameMs.shift();
      s.renders++;
    }
    this._emit(this._emitDirty);
    this._emitDirty = false;
    if (animating || this._gesture) { s.lastFrame = t; if (animating) this.invalidate(); } else s.lastFrame = 0;
  }

  _render() {
    const r = this.renderer;
    const { w: W, h: H, dpr } = this._size;
    const panels = M.panelRects(this.layout, this.panel, W, H);
    const C = this._colors;
    r.setScissorTest(true);
    this.overlay.clear();
    this.overlay.lensRect = null;
    const tagState = {};
    for (const p of panels) {
      if (p.w <= 0 || p.h <= 0) continue;
      const y = H - p.y - p.h;
      r.setViewport(p.x, y, p.w, p.h);
      r.setScissor(p.x, y, p.w, p.h);
      r.clear(true, true, false);
      if (p.id === '3d') this._render3d(p);
      else this._render2d(p, dpr, tagState);
    }
    r.setScissorTest(false);
    // gutters (1 px hairline between the quad panels)
    if (this.layout === 'quad') {
      const ctx = this.overlay.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = C.hairline;
      ctx.globalAlpha = 1;
      const xy = panels[0];
      ctx.fillRect(xy.w * dpr, 0, Math.max(1, dpr), H * dpr);
      ctx.fillRect(0, xy.h * dpr, W * dpr, Math.max(1, dpr));
    }
    this._placeTags(tagState);
  }

  /** The stack chunk texture + tile for section i, or null (chunk not loaded). */
  _stackTile(i) {
    const t = M.stackTile(this.v2, i);
    if (!t) return null;
    const e = this._items.get(t.chunk === 0 ? 'stackA' : 'stackB');
    if (!e || e.state !== 'ready' || !e.tex) return null;
    const S = this.v2.stack.size_px;
    return { e, tile: [t.col * S, t.row * S, S, S] };
  }

  _render2d(p, dpr, tags) {
    const v2 = this.v2;
    const view = this.view;
    const u = view.u;
    const cam = this.cam2;
    const [ch, cv] = M.planeCentre(p.id, view);
    cam.left = (-p.w / 2) * u; cam.right = (p.w / 2) * u;
    cam.top = (p.h / 2) * u; cam.bottom = (-p.h / 2) * u;
    cam.position.set(ch, -cv, 10);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const nmPerDev = u / dpr;
    const [a0, b0] = M.screenToPlane(p.id, view, p.w, p.h, 0, 0);
    const [a1, b1] = M.screenToPlane(p.id, view, p.w, p.h, p.w, p.h);
    const viewRect = [a0, b0, a1, b1];
    let stackShown = false;
    let stackCovered = false;   // the stack quad owns the stack rect (its tile, a lost section or a loading one)
    let missing = false;
    let orthoShown = false;
    if (p.id === 'xy') {
      const st = (l) => { const e = this._items.get(`level${l}`); return e && e.state === 'ready' && e.tex ? { scale: e.scale } : false; };
      const { drawn, coarsest } = M.chooseLevels(v2, nmPerDev, st);
      const covers = M.stackCovers(v2, view, p.w, p.h);
      const sr = v2.stack.rect_nm;
      for (let l = 0; l < v2.levels.length; l++) {
        const q = this.q2.levels[l];
        const r = v2.levels[l].rect_nm;
        q.visible = drawn.includes(l) && M.rectsIntersect(r, viewRect);
        if (!q.visible) continue;
        const U = q.material.uniforms;
        U.uCoarsest.value = l === coarsest ? 1 : 0;
        const lvSection = M.SOMA_INDEX + (v2.levels[l].section || 0);
        const scrim = this.section !== lvSection && !covers;
        U.uScrim.value = scrim ? M.SCRIM : 0;
        if (scrim) {
          const w = r[2] - r[0]; const h = r[3] - r[1];
          U.uScrimRect.value.set((sr[0] - r[0]) / w, (sr[1] - r[1]) / h, (sr[2] - r[0]) / w, (sr[3] - r[1]) / h);
        }
      }
      // the stack tile of the current section (or a lost section: sunken, hatched by the overlay)
      const q = this.q2.stack;
      const U = q.material.uniforms;
      missing = M.isMissing(v2, this.section);
      const inView = M.rectsIntersect(sr, viewRect);
      const tile = missing ? null : this._stackTile(this.section);
      const lv0Section = M.SOMA_INDEX + (v2.levels[0].section || 0);
      if (missing) {
        q.visible = inView;
        U.uSolid.value.set(...this._colors.sunkenRGB, 1);
      } else if (tile) {
        const s = tile.e.scale;
        const px = [v2.px_nm[0] / s, v2.px_nm[1] / s];
        q.visible = inView && M.texelDev(px, nmPerDev) >= M.LOD_DISCARD;
        U.uSolid.value.set(0, 0, 0, 0);
        U.uTex.value = tile.e.tex;
        U.uTexSize.value.set(tile.e.w, tile.e.h);
        U.uTile.value.set(tile.tile[0] * s, tile.tile[1] * s, tile.tile[2] * s, tile.tile[3] * s);
        U.uCoarsest.value = 0;
        stackShown = q.visible;
      } else if (this.section !== lv0Section) {
        // the section's chunk is still loading: never show the soma section's pixels under another index
        q.visible = inView;
        U.uSolid.value.set(...this._colors.sunkenRGB, 1);
        tags.loading = true;
      } else {
        q.visible = false;   // level 0 is this very section at the native resolution
      }
      stackCovered = q.visible;
      tags.missing = missing && inView;
      tags.stackFrame = M.stackFrameOnScreen(v2, view, p.w, p.h);
      tags.xyPanel = p;
    } else {
      const xz = p.id === 'xz';
      const ctxQ = xz ? this.q2.ctx.xz : this.q2.ctx.yz;
      const ce = this._items.get('ctx');
      const ctxReady = ce && ce.state === 'ready' && ce.tex;
      const lv = v2.ortho_ctx.levels;
      const oe = this._items.get('ortho');
      const orthoReady = oe && oe.state === 'ready' && oe.tex;
      const coarsestK = ctxReady ? lv.length - 1 : -1;
      for (let k = 0; k < lv.length; k++) {
        const q = ctxQ[k];
        if (!q) continue;
        if (!ctxReady) { q.visible = false; continue; }
        const pl = xz ? lv[k].xz : lv[k].yz;
        const r = xz ? pl.rect_nm : [pl.rect_nm[1], pl.rect_nm[0], pl.rect_nm[3], pl.rect_nm[2]];
        const px = [(xz ? lv[k].px_nm[0] : lv[k].px_nm[1]) / ce.scale, lv[k].vz_nm / ce.scale];   // YZ: the y px (H01)
        q.visible = M.rectsIntersect(r, viewRect) && (k === coarsestK || M.texelDev(px, nmPerDev) >= M.LOD_DISCARD);
        q.material.uniforms.uCoarsest.value = k === coarsestK ? 1 : 0;
      }
      const qo = xz ? this.q2.ortho.xz : this.q2.ortho.yz;
      if (orthoReady) {
        const rects = M.orthoRects(v2);
        const r = xz ? rects.xz : [rects.yz[1], rects.yz[0], rects.yz[3], rects.yz[2]];
        const px = [(xz ? v2.px_nm[0] : v2.px_nm[1]) / oe.scale, v2.section_nm / oe.scale];
        qo.visible = M.rectsIntersect(r, viewRect) && (!ctxReady || M.texelDev(px, nmPerDev) >= M.LOD_DISCARD);
        qo.material.uniforms.uCoarsest.value = ctxReady ? 0 : 1;
        orthoShown = qo.visible;
      } else qo.visible = false;
    }
    const cq = this.q2.contour[p.id];
    if (cq) {
      const a = this.layers.mesh ? M.footprintAlpha((p.w * u) / 1000) : 0;
      cq.material.uniforms.uAlpha.value = a;
      cq.visible = a > 0;
    }
    this.renderer.render(this.scenes[p.id], cam);
    // vectors
    const axes = this.axesOn();
    this.overlay.drawPanel({
      panel: p, dpr, view, v2, section: this.section,
      layers: { outline: this.layers.outline, axes },
      stackShown, stackCovered, missingStack: missing, orthoShown,
      cutXY: () => this._cut(`xy:${this.section}`), cutXZ: () => this._cut('xz'), cutYZ: () => this._cut('yz'),
      lens: p.id !== 'xy',
    });
    if (p.id !== 'xy' && this.overlay.lensRect && !tags.lens) tags.lens = { panel: p, rect: this.overlay.lensRect, id: p.id };
  }

  _render3d(p) {
    const v2 = this.v2;
    this._px3 = this._setCam3(p);
    const sl = this.layers.slices3d;
    this.g3.xy.visible = !!sl.xy;
    this.g3.xz.visible = !!sl.xz;
    this.g3.yz.visible = !!sl.yz;
    if (this.g3.mesh) {
      this.g3.mesh.visible = !!this.layers.mesh;
      // µm per device px × 1: at whole-cell scale thin neurites (≈ 0.5 px) would vanish into the EM texture
      this.g3.mesh.material.uniforms.uInflate.value = this._px3 > 0 ? MESH_MIN_HALF_DEV_PX / (this._px3 * (this._size.dpr || 1)) : 0;
    }
    this.g3.xy.position.z = M.sectionZ(v2, this.section);
    this.g3.xy.updateMatrix();
    // levels: every loaded level; the coarsest never discards (LOD per fragment: fwidth)
    let coarsest = -1;
    for (let l = v2.levels.length - 1; l >= 0; l--) if (this._ready(`level${l}`)) { coarsest = l; break; }
    for (let l = 0; l < v2.levels.length; l++) {
      const q = this.q3.levels[l];
      q.visible = this._ready(`level${l}`);
      q.material.uniforms.uCoarsest.value = l === coarsest ? 1 : 0;
    }
    const q = this.q3.stack;
    const U = q.material.uniforms;
    if (M.isMissing(v2, this.section)) { q.visible = true; U.uSolid.value.set(...this._colors.sunkenRGB, 1); }
    else {
      const tile = this._stackTile(this.section);
      q.visible = !!tile;
      if (tile) {
        const s = tile.e.scale;
        U.uSolid.value.set(0, 0, 0, 0);
        U.uTex.value = tile.e.tex;
        U.uTexSize.value.set(tile.e.w, tile.e.h);
        U.uTile.value.set(tile.tile[0] * s, tile.tile[1] * s, tile.tile[2] * s, tile.tile[3] * s);
      }
    }
    const ctxReady = this._ready('ctx');
    const orthoReady = this._ready('ortho');
    v2.ortho_ctx.levels.forEach((_, k) => {
      for (const qq of [this.q3.ctx.xz[k], this.q3.ctx.yz[k]]) {
        qq.visible = ctxReady;
        qq.material.uniforms.uCoarsest.value = k === v2.ortho_ctx.levels.length - 1 ? 1 : 0;
      }
    });
    for (const qq of [this.q3.ortho.xz, this.q3.ortho.yz]) {
      qq.visible = orthoReady;
      qq.material.uniforms.uCoarsest.value = ctxReady ? 0 : 1;
    }
    this.renderer.render(this.scenes['3d'], this.cam3);
  }

  _placeTags(s) {
    const T = this._tags;
    const show = (el, on) => { if (el.hidden === on) el.hidden = !on; };
    const xy = s.xyPanel;
    const f = s.stackFrame;
    if (xy && f) {
      const cx = xy.x + (f.x0 + f.x1) / 2;
      const cy = xy.y + (f.y0 + f.y1) / 2;
      const inside = (x, y) => x >= xy.x && x <= xy.x + xy.w && y >= xy.y && y <= xy.y + xy.h;
      // "z-stack" while the stack is < 50 % of the view width, above its frame
      const small = (f.x1 - f.x0) < 0.5 * xy.w;
      const lx = xy.x + f.x0;
      const ly = xy.y + f.y0;
      const stackOn = small && inside(lx + 1, ly - 1) && inside(xy.x + f.x1, ly - 1);
      show(T.stack, stackOn);
      if (stackOn) T.stack.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px) translateY(-100%)`;
      const centreOk = inside(cx, cy);
      const mid = `translate(${Math.round(cx)}px, ${Math.round(cy)}px) translate(-50%, -50%)`;
      show(T.lost, !!s.missing && centreOk);
      if (s.missing && centreOk) T.lost.style.transform = mid;
      show(T.loading, !!s.loading && !s.missing && centreOk);
      if (s.loading && centreOk) T.loading.style.transform = mid;
    } else { show(T.stack, false); show(T.lost, false); show(T.loading, false); }
    const lens = s.lens;
    const label = lens ? M.lensLabel(this.done, lens.id, this.v2) : '';
    show(T.lens, !!label);
    if (label) {
      if (T.lens.textContent !== label) T.lens.textContent = label;
      // overlay.lensRect is already in root CSS px (the panel offset is inside it): no second panel offset, or the
      // label of a quad's XZ / YZ panel lands outside the stage
      T.lens.style.transform = `translate(${Math.round(lens.rect.x1 + 6)}px, ${Math.round(lens.rect.y0)}px)`;
    }
  }

  // ================================================================================================== events

  /** cb(state) whenever what the chrome shows changes; fires once now. Returns unsubscribe. */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this._changeCbs.add(cb);
    try { cb(this.state()); } catch (err) { console.error(err); }
    return () => { this._changeCbs.delete(cb); };
  }
  /** cb({ x, y, panel }) on a single tap / click (< 4 px), after the 300 ms double-tap window (a double tap is a zoom). */
  onTap(cb) { this._tapCbs.add(cb); return () => { this._tapCbs.delete(cb); }; }
  /** cb({ type: 'error' | 'item' | 'shortcuts' | 'layout' }) */
  onEvent(cb) { this._eventCbs.add(cb); return () => { this._eventCbs.delete(cb); }; }

  /** What the chrome needs (view.js): plain data, no text. */
  state() {
    const { w, h, dpr } = this._size;
    const panels = M.panelRects(this.layout, this.panel, w, h);
    const readPanel = this.layout === 'quad' ? 'xy' : this.panel;
    let src = null;
    let scale = null;
    if (this.view && w > 0) {
      const nmPerDev = this.view.u / dpr;
      const it = (id) => { const e = this._items.get(id); return e && e.state === 'ready' && e.tex ? { scale: e.scale } : false; };
      src = M.centreSource(this.v2, readPanel, this.view, nmPerDev, {
        section: this.section,
        stack: (i) => { const t = this._stackTile(i); return t ? { scale: t.e.scale } : false; },
        level: (l) => it(`level${l}`),
        ortho: it('ortho'),
        ctx: () => it('ctx'),
      });
      scale = M.scaleBar(this.view.u, 120);
    }
    const stack = ['stackA', 'stackB'].map((id) => this._items.get(id));
    let loaded = 0; let total = 0; let busy = false;
    for (const e of this._items.values()) {
      if (e.state === 'loading') busy = true;
      if (e.state === 'loading' || e.state === 'ready') { loaded += e.state === 'ready' ? (e.total || e.loaded) : e.loaded; total += e.total || 0; }
    }
    const pendingLevel = this._pendingFiner();
    return {
      roundId: this.roundId,
      ready: !!this.view && !this._error,
      error: this._error,
      layout: this.layout,
      panel: this.panel,
      focusPanel: this.focusPanel,
      panels,
      size: { w, h, dpr },
      section: this.section,
      n: M.N_SECTIONS,
      isMissing: M.isMissing(this.v2, this.section),
      missing: [...this.v2.z.missing],
      px: src ? src.px : null,
      isFinest: !!(src && src.finest),
      scaleBar: scale,
      scale3d: this._px3 > 0 ? M.scaleBar(1000 / this._px3, 120) : null,
      viewWidthNm: this.view ? this._panelSize(readPanel === '3d' ? 'xy' : readPanel).w * this.view.u : 0,
      layers: { ...this.layers, axes: this.axesOn(), slices3d: { ...this.layers.slices3d } },
      done: this.done,
      sectionNm: this.v2.section_nm,
      framing: this.nearFraming(),
      canQuad: M.canQuad(w, h),
      loading: {
        busy, loaded, total,
        stack: stack.filter((e) => e && e.state === 'ready').length,
        stackBusy: stack.some((e) => e && e.state === 'loading'),
        finer: pendingLevel,
      },
      orthoFailed: this._items.get('ortho').state === 'failed',
      outlinesFailed: this._items.get('outlines').state === 'failed',
      meshFailed: !!this._meshFailed,
      animating: !!this._anim,
    };
  }

  /** Data saver: the finer level the LOD rule wants but that is not loaded yet → { bytes } (chip), else null. */
  _pendingFiner() {
    if (!this.view || !this._size.w) return null;
    const nmPerDev = this.view.u / this._size.dpr;
    const v2 = this.v2;
    for (let l = 0; l < v2.levels.length; l++) {
      if (M.texelDev(v2.levels[l].px_nm, nmPerDev) < M.LOD_DISCARD) continue;
      const e = this._items.get(`level${l}`);
      if (!e) continue;
      if (e.state === 'ready') return null;
      if (!M.pointInRect(v2.levels[l].rect_nm, this.view.cx, this.view.cy)) continue;
      return e.state === 'failed' ? null : { level: l, bytes: e.item.bytes };
    }
    return null;
  }

  _emit(force = false) {
    if (this._disposed || !this._changeCbs.size) return;
    const st = this.state();
    const key = JSON.stringify([st.layout, st.panel, st.focusPanel, st.section, st.px, st.isFinest, st.scaleBar && st.scaleBar.label,
      st.scaleBar && Math.round(st.scaleBar.px), st.scale3d && st.scale3d.label, st.scale3d && Math.round(st.scale3d.px), st.layers, st.done, st.framing, st.canQuad, st.loading.busy, st.loading.stack,
      st.loading.stackBusy, st.loading.finer, Math.round(st.loading.loaded / 65536), st.error, st.ready, st.size.w, st.size.h,
      st.orthoFailed, st.outlinesFailed, st.animating]);
    if (!force && key === this._emitKey) return;
    this._emitKey = key;
    for (const cb of [...this._changeCbs]) { try { cb(st); } catch (err) { console.error(err); } }
  }

  /** { gpuBytes, uploads, decodes, renders, frame: { avg, p95, max } ms CPU, interval: { avg, p95 } ms } */
  stats() {
    const q = (a, f) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const s = this._stats;
    return {
      gpuBytes: s.gpuBytes, uploads: s.uploads, decodes: s.decodes, renders: s.renders,
      frame: { avg: avg(s.frameMs), p95: q(s.frameMs, 0.95), max: s.frameMs.length ? Math.max(...s.frameMs) : 0 },
      interval: { avg: avg(s.intervals), p95: q(s.intervals, 0.95) },
      r8: R8_OK,
      items: Object.fromEntries([...this._items].map(([k, e]) => [k, { state: e.state, scale: e.scale, bytes: e.blob ? e.blob.size : 0 }])),
    };
  }
  resetStats() { const s = this._stats; s.frameMs = []; s.intervals = []; s.lastFrame = 0; }

  // =================================================================================================== input

  _local(e) { const r = this.root.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  _panelAt(pt) {
    const rects = M.panelRects(this.layout, this.panel, this._size.w, this._size.h);
    return rects.find((p) => pt.x >= p.x && pt.x < p.x + p.w && pt.y >= p.y && pt.y < p.y + p.h) || rects[0];
  }
  _activity() {
    if (this.saveData && !this._zTouched && this._items.get('stackA').state === 'idle') {
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => this._release('z-or-idle'), IDLE_STACK_A_MS);
    }
  }

  _bindInput() {
    const el = this.root;
    this._on(el, 'pointerdown', (e) => this._down(e));
    this._on(el, 'pointermove', (e) => this._move(e));
    this._on(el, 'pointerup', (e) => this._up(e));
    this._on(el, 'pointercancel', (e) => this._up(e, true));
    this._on(el, 'lostpointercapture', (e) => this._up(e, true));
    this._on(el, 'wheel', (e) => this._wheel(e), { passive: false });
    this._on(el, 'contextmenu', (e) => this._context(e));
    this._on(el, 'dblclick', (e) => this._dbl(e));
    this._on(el, 'keydown', (e) => this._key(e));
  }

  _down(e) {
    if (!this.view) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    this._cancelAnim();
    this._activity();
    const pt = this._local(e);
    const panel = this._panelAt(pt);
    try { this.root.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
    this._pointers.set(e.pointerId, { ...pt, t: now() });
    if (this.layout === 'quad' && panel.id !== this.focusPanel) { this.focusPanel = panel.id; this._emit(true); }
    const lx = pt.x - panel.x;
    const ly = pt.y - panel.y;
    if (this._pointers.size === 1) {
      let kind;
      if (!isTouch(e)) {
        if (panel.id === '3d') kind = e.button === 2 || e.shiftKey ? 'pan3d' : 'rotate';
        else kind = e.button === 2 ? 'right' : 'pan';
      } else {
        kind = M.classifyTouch({
          panel: panel.id, count: 1, x: lx, y: ly,
          stackFrame: panel.id === 'xy' ? M.stackFrameOnScreen(this.v2, this.view, panel.w, panel.h) : null,
          sectionLine: M.sectionLineOnScreen(panel.id, this.v2, this.view, panel.w, panel.h, this.section),
        });
      }
      const g = { kind, panel, start: pt, last: pt, t0: now(), moved: false, acc: 0, touch: isTouch(e), longTimer: 0 };
      if (g.touch && panel.id !== '3d') {
        g.longTimer = setTimeout(() => this._longPress(g), M.LONG_PRESS_MS);
      }
      if (kind === 'section' || kind === 'scrub') this._noteZ();
      this._gesture = g;
    } else if (this._pointers.size === 2 && this._gesture) {
      const g0 = this._gesture;
      clearTimeout(g0.longTimer);
      const [a, b] = [...this._pointers.values()];
      this._gesture = {
        kind: g0.panel.id === '3d' ? 'pinch3d' : 'pinch', panel: g0.panel, dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, t0: now(), moved: false, touch: true, two: true,
      };
    }
    this.invalidate();
  }

  _move(e) {
    const pt = this._local(e);
    if (!this._pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && this.layout === 'quad' && this._size.w) {
        const p = this._panelAt(pt);
        if (p.id !== this.focusPanel) { this.focusPanel = p.id; this._emit(true); }
      }
      return;
    }
    this._pointers.set(e.pointerId, { ...pt, t: this._pointers.get(e.pointerId).t });
    const g = this._gesture;
    if (!g || !this.view) return;
    const p = g.panel;
    if (g.kind === 'pinch' || g.kind === 'pinch3d') {
      if (this._pointers.size < 2) return;
      const [a, b] = [...this._pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.abs(dist - g.dist) > M.TAP_SLOP_PX || Math.hypot(mid.x - g.mid.x, mid.y - g.mid.y) > M.TAP_SLOP_PX) g.moved = true;
      const f = g.dist > 0 && dist > 0 ? dist / g.dist : 1;
      if (g.kind === 'pinch3d') {
        this._zoom3d(f);
        this._pan3d(mid.x - g.mid.x, mid.y - g.mid.y, p);
      } else {
        let v = M.zoomViewAbout(p.id, this.view, f, mid.x - p.x, mid.y - p.y, p.w, p.h, this._limits);
        v = M.panView(p.id, v, mid.x - g.mid.x, mid.y - g.mid.y);
        this.view = M.clampView(v, this.v2, this._limits);
        this._onViewChanged();
      }
      g.dist = dist; g.mid = mid;
      this.invalidate(true);
      return;
    }
    const dx = pt.x - g.last.x;
    const dy = pt.y - g.last.y;
    if (!g.moved && Math.hypot(pt.x - g.start.x, pt.y - g.start.y) >= M.TAP_SLOP_PX) { g.moved = true; clearTimeout(g.longTimer); }
    // the finger left over from a two-finger touch: moving it ends the two-finger-tap candidate
    if (g.twoTap && Math.hypot(pt.x - g.twoTap.at.x, pt.y - g.twoTap.at.y) >= M.TAP_SLOP_PX) g.twoTap = null;
    g.last = pt;
    if (!g.moved) return;
    switch (g.kind) {
      case 'pan':
        this.view = M.clampView(M.panView(p.id, this.view, dx, dy), this.v2, this._limits);
        this._onViewChanged();
        break;
      case 'section': {
        g.acc += dy;
        const n = M.sectionsForDrag(g.acc);
        if (n) { g.acc -= n * M.PX_PER_SECTION; this.step(n); }
        break;
      }
      case 'scrub': {
        const i = M.sectionAtScreen(p.id, this.v2, this.view, p.w, p.h, pt.x - p.x, pt.y - p.y);
        if (i !== this.section) this.step(i - this.section);
        break;
      }
      case 'rotate':
        this._cam3Auto = false;
        this._cam3.yaw -= dx * ROTATE_PER_PX;
        this._cam3.tilt = M.clamp(this._cam3.tilt + dy * ROTATE_PER_PX, -TILT_MAX, TILT_MAX);
        break;
      case 'pan3d':
        this._pan3d(dx, dy, p);
        break;
      default:
    }
    this.invalidate(true);
  }

  _up(e, cancelled = false) {
    if (!this._pointers.has(e.pointerId)) return;
    const pt = this._local(e);
    const down = this._pointers.get(e.pointerId);
    this._pointers.delete(e.pointerId);
    const g = this._gesture;
    if (g) clearTimeout(g.longTimer);
    if (g && g.two) {
      // two-finger tap (§8.5: zoom out ×0.5 about the midpoint). Fingers lift one at a time, so the decision waits for
      // the last one: the finger left over carries the candidate (and pans if it moves on, which cancels it).
      const tapOk = !cancelled && !g.moved && now() - g.t0 < TWO_TAP_MS + 150;
      if (this._pointers.size === 1) {
        const [q] = [...this._pointers.values()];
        this._gesture = {
          kind: g.panel.id === '3d' ? 'rotate' : 'pan', panel: g.panel, start: q, last: q, t0: now(), moved: true, acc: 0, touch: true,
          twoTap: tapOk ? { t0: g.t0, mid: g.mid, panel: g.panel, kind: g.kind, at: { x: q.x, y: q.y } } : null,
        };
      } else if (!this._pointers.size) {
        this._gesture = null;
        if (tapOk) this._twoFingerTap(g);
      }
      this.invalidate(true);
      return;
    }
    this._gesture = null;
    if (g && g.twoTap) {
      if (!cancelled && now() - g.twoTap.t0 < TWO_TAP_MS + 150) this._twoFingerTap(g.twoTap);
      this.invalidate(true);
      return;
    }
    if (g && !cancelled && !g.moved && g.kind !== 'right' && down && (!g.touch || now() - g.t0 < 400)) {
      // A tap reaches onTap (the full view toggles its chrome with it) only once the double-tap window has passed
      // without a second tap: a double tap zooms ×2 (touch; a mouse double-click is the dblclick handler's) and must
      // not also hide the chrome.
      const ev = { x: pt.x, y: pt.y, panel: g.panel.id };
      const last = this._lastTap;
      if (last && now() - last.t < DOUBLE_TAP_MS && Math.hypot(pt.x - last.x, pt.y - last.y) < DOUBLE_TAP_PX && last.panel === ev.panel) {
        clearTimeout(last.timer);
        this._lastTap = null;
        if (g.touch) {
          if (g.panel.id === '3d') { this._cam3.target.set(0, 0, 0); this.invalidate(true); }
          else this._zoomAt(g.panel, 2, pt);
        }
      } else {
        if (last) { clearTimeout(last.timer); this._lastTap = null; this._fireTap(last.ev); }
        const rec = { t: now(), x: pt.x, y: pt.y, panel: ev.panel, ev, timer: 0 };
        rec.timer = setTimeout(() => {
          if (this._lastTap === rec) this._lastTap = null;
          if (!this._disposed) this._fireTap(ev);
        }, DOUBLE_TAP_MS);
        this._lastTap = rec;
      }
    }
    this.invalidate(true);
  }

  _fireTap(ev) {
    for (const fn of [...this._tapCbs]) { try { fn(ev); } catch (err) { console.error(err); } }
  }

  _twoFingerTap(t) {
    if (t.kind === 'pinch3d') this._zoom3d(0.5);
    else this._zoomAt(t.panel, 0.5, t.mid);
  }

  _zoomAt(panel, f, pt) {
    this._cancelAnim();
    if (panel.id === '3d') { this._zoom3d(f); return; }
    const target = M.clampView(M.zoomViewAbout(panel.id, this.view, f, pt.x - panel.x, pt.y - panel.y, panel.w, panel.h, this._limits), this.v2, this._limits);
    if (motionAllowed()) this._animate(this.view, target, M.RECENTRE_MS, 'zoom');
    else { this.view = target; }
    this._onViewChanged();
    this.invalidate(true);
  }

  _longPress(g) {
    if (this._gesture !== g || g.moved || this._pointers.size !== 1) return;
    g.moved = true;   // consumed: no tap, no drag
    g.kind = 'none';
    const p = g.panel;
    const lx = g.start.x - p.x;
    const ly = g.start.y - p.y;
    haptic('selection');
    if (p.id === 'xy') this._recentre(p, lx, ly);
    else {
      const i = M.sectionAtScreen(p.id, this.v2, this.view, p.w, p.h, lx, ly);
      this.setSection(i, { user: true });
    }
  }

  _recentre(p, lx, ly) {
    const [ph, pv] = M.screenToPlane(p.id, this.view, p.w, p.h, lx, ly);
    const to = M.clampView(M.withPlaneCentre(p.id, this.view, ph, pv), this.v2, this._limits);
    if (motionAllowed()) this._animate(this.view, to, M.RECENTRE_MS, 'recentre');
    else { this.view = to; this.invalidate(true); }
  }

  _context(e) {
    e.preventDefault();
    if (!this.view) return;
    const pt = this._local(e);
    const p = this._panelAt(pt);
    if (p.id === '3d') return;
    if (this._gesture && this._gesture.moved) return;
    this._cancelAnim();
    this._recentre(p, pt.x - p.x, pt.y - p.y);
  }

  _dbl(e) {
    if (!this.view || e.pointerType === 'touch') return;
    const pt = this._local(e);
    const p = this._panelAt(pt);
    if (p.id === '3d') { this._cam3.target.set(0, 0, 0); this.invalidate(true); return; }
    // double-click on the cell toggles Outline (Neuroglancer's select)
    const onCell = this._onCell(p, pt.x - p.x, pt.y - p.y);
    if (onCell !== false) { this.setLayers({ outline: !this.layers.outline }); haptic('selection'); }
  }
  _onCell(p, lx, ly) {
    const P = this.overlay.paths;
    if (!P || p.id !== 'xy') return null;
    const [h, v] = M.screenToPlane('xy', this.view, p.w, p.h, lx, ly);
    const ctx = this.overlay.ctx;
    if (M.pointInRect(this.v2.stack.rect_nm, h, v) && P.stack[this.section]) return ctx.isPointInPath(P.stack[this.section], h, v, 'evenodd');
    for (let l = 0; l < P.levels.length; l++) if (P.levels[l] && M.pointInRect(this.v2.levels[l].rect_nm, h, v)) return ctx.isPointInPath(P.levels[l], h, v, 'evenodd');
    return null;
  }

  _wheel(e) {
    e.preventDefault();
    if (!this.view) return;
    this._cancelAnim();
    this._activity();
    const pt = this._local(e);
    const p = this._panelAt(pt);
    if (this.layout === 'quad' && p.id !== this.focusPanel) { this.focusPanel = p.id; this._emit(true); }
    if (p.id === '3d') {
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this._zoom3d(M.clamp(Math.exp(-0.002 * dy * (e.ctrlKey || e.metaKey ? 4 : 1)), 0.5, 2));
      return;
    }
    const r = M.wheelStep(e, this._wheelAcc, now(), this._size.h);
    if (r.kind === 'zoom') {
      this.view = M.clampView(M.zoomViewAbout(p.id, this.view, r.factor, pt.x - p.x, pt.y - p.y, p.w, p.h, this._limits), this.v2, this._limits);
      this._onViewChanged();
      this.invalidate(true);
    } else if (r.delta) this.step(r.delta);
  }

  _key(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.altKey || (ctrl && !['=', '+', '-', '_'].includes(e.key))) return;
    if (!this.view) return;
    const p = this._panelSize(this._focus2d());
    const pan = (fx, fy) => {
      if (this._focusIs3d()) { this._pan3d(-fx * p.w * 0.1, -fy * p.h * 0.1, this._panelSize('3d')); return; }
      this.view = M.clampView(M.panView(this._focus2d(), this.view, -fx * p.w * 0.1, -fy * p.h * 0.1), this.v2, this._limits);
      this._onViewChanged();
      this.invalidate(true);
    };
    let handled = true;
    this._cancelAnim();
    this._activity();
    switch (e.key) {
      case ',': this.step(-1); break;
      case '.': this.step(1); break;
      case 'ArrowUp': if (e.shiftKey) pan(0, -1); else this.step(-1); break;
      case 'ArrowDown': if (e.shiftKey) pan(0, 1); else this.step(1); break;
      case 'ArrowLeft': pan(-1, 0); break;
      case 'ArrowRight': pan(1, 0); break;
      case 'PageUp': this.step(-M.SECTION_JUMP); break;
      case 'PageDown': this.step(M.SECTION_JUMP); break;
      case 'Home': this.setSection(0, { user: true }); haptic('light'); break;
      case 'End': this.setSection(M.N_SECTIONS - 1, { user: true }); haptic('light'); break;
      case '+': case '=': this.zoomBy(1.25); break;
      case '-': case '_': this.zoomBy(0.8); break;
      case ' ': case 'Spacebar':
        this._event({ type: 'layout-key' });
        break;
      default:
        if (ctrl) { handled = false; break; }
        switch (e.key.toLowerCase()) {
          case 'a': this.setLayers({ axes: !this.axesOn() }); break;
          case 'b': this.setLayers({ scaleBar: !this.layers.scaleBar }); break;
          case 's': {
            const sl = this.layers.slices3d;
            const on = !(sl.xy && sl.xz && sl.yz);
            this.setLayers({ slices3d: { xy: on, xz: on, yz: on } });
            break;
          }
          case 'o': case '2': this.setLayers({ outline: !this.layers.outline }); break;
          case 'm': case '3': this.setLayers({ mesh: !this.layers.mesh }); break;
          case '0': this.frame('native'); break;
          case 'c': this.frame('cell'); break;
          case '?': case 'h': this._event({ type: 'shortcuts' }); break;
          default: handled = false;
        }
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  _event(ev) { for (const fn of [...this._eventCbs]) { try { fn(ev); } catch (err) { console.error(err); } } }

  // ================================================================================================ lifetime

  resize() { this._measure(); this.invalidate(true); }

  /** Drop one holder; the last one disposes the stage (after a short grace, so a remount can re-acquire it). */
  release() {
    const e = REGISTRY.get(this.roundId);
    if (!e || e.stage !== this) { this.dispose(); return; }
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs > 0) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      if (e.refs > 0) return;
      if (REGISTRY.get(this.roundId) === e) REGISTRY.delete(this.roundId);
      this.dispose();
    }, RELEASE_DELAY_MS);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._idleTimer);
    clearTimeout(this._ariaT);
    if (this._lastTap) clearTimeout(this._lastTap.timer);
    if (this._diveArmed) clearTimeout(this._diveArmed.timer);
    if (this._ro) this._ro.disconnect();
    for (const [el, type, fn, opts] of this._listeners) el.removeEventListener(type, fn, opts);
    this._listeners = [];
    this._changeCbs.clear(); this._tapCbs.clear(); this._eventCbs.clear();
    for (const e of this._items.values()) { if (e.tex) e.tex.dispose(); e.tex = null; e.blob = null; }
    for (const fp of Object.values(this._footprints)) fp.target.dispose();
    if (this.scenes) {
      for (const sc of Object.values(this.scenes)) {
        sc.traverse((o) => {
          if (o.material) o.material.dispose();
          if (o.geometry && o.geometry !== UNIT_QUAD) o.geometry.dispose();
        });
      }
    }
    if (this._footGeom) this._footGeom.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      try { this.renderer.forceContextLoss(); } catch (_) { /* */ }
    }
    for (const el of [this.root, this._live, this._statusEl]) if (el && el.parentNode) el.parentNode.removeChild(el);
    this._hosts = [];
  }
}

export default EmStage;
