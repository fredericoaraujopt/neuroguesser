// EM format 2 viewer: the pure model (no DOM, no WebGL; unit-tested in tests/em2-model.test.js).
// Spec: neuroguesser-content/docs/em-v2-spec.md §3 (data), §8 (viewer), §9 (3D); contracts common.schema.json em_v2.
//
// Frames. Every coordinate in `em` (format 2) is EM-local physical nm: origin = the soma that centred the public mesh,
// +x = image column, +y = image row (down), +z = increasing section index. A 2D panel shows one plane of it:
//   XY: (h, v) = (x, y)     XZ: (h, v) = (x, z)     YZ: (h, v) = (z, y)        (h right, v down, as in Neuroglancer)
// The view is shared by every 2D panel (Neuroglancer's global position and cross-section scale):
//   { cx, cy, zv, u }  — the centre (x, y, z) in nm and u = nm per CSS px.
// The section index (0…31, soma = 16) is separate from zv: the XY plane stays at the soma section's levels, the stack
// tile changes with the index, and the XZ/YZ planes stay at c.
import { fmtUm } from '../../format.js';

export const N_SECTIONS = 32;
export const SOMA_INDEX = 16;
export const PANELS = Object.freeze(['xy', 'xz', 'yz', '3d']);
/** Neuroglancer 4panel: top row XY | XZ, bottom row 3D | YZ (src/data_panel_layout.ts). */
export const QUAD_ORDER = Object.freeze(['xy', 'xz', '3d', 'yz']);
/** Normal axis of each plane and Neuroglancer's red/green/blue mapped to Charcoal data colours (x purple, y green,
 *  z blue: vermillion is too close to the outline orange). */
export const PLANE_NORMAL = Object.freeze({ xy: 'z', xz: 'y', yz: 'x' });
export const AXIS_TOKEN = Object.freeze({ x: '--data-purple', y: '--data-green', z: '--data-blue' });

export const LOD_DISCARD = 0.5;      // device px per texel below which a non-coarsest quad is discarded (≤ 2× minified)
export const NEAREST_FROM = 2;       // device px per texel from which voxels are drawn as honest squares (nearest)
export const MAX_ZOOM_DEV_PX = 24;   // most zoomed in: 1 native px = 24 device px
export const NATIVE_FILL = 0.92;     // "Native" = the stack rect fitted at 92 % of the short side
export const CELL_FILL = 0.85;       // "Whole cell" = B fitted at 85 %
export const ZOOM_OUT = 0.8;         // most zoomed out = Whole cell × 0.8
export const STACK_DRAG_MIN_PX = 96; // one-finger z drag only on a stack frame at least this wide (CSS px)
export const PX_PER_SECTION = 24;    // one-finger z drag: 1 section per 24 CSS px, down = next
export const LINE_GRAB_PX = 16;      // XZ/YZ: a drag starting this close to the section line scrubs it
export const LONG_PRESS_MS = 500;
export const TAP_SLOP_PX = 4;
export const WHEEL_PX_PER_SECTION = 50;
export const WHEEL_IDLE_MS = 200;
export const SECTION_JUMP = 10;
export const DIVE_MS = 1100;
export const DIVE_WAIT_MS = 1200;
export const RECENTRE_MS = 200;
export const FOOTPRINT_FADE_UM = Object.freeze([12, 36]);
export const FOOTPRINT_MAX_ALPHA = 0.7;
export const SCRIM = 0.25;           // luminance-only scrim on XY levels outside the stack when the section ≠ theirs
export const SCRIM_OFF_COVER = 0.9;  // …off when the stack covers ≥ 90 % of the view
export const QUAD_MIN_PANEL = Object.freeze([185, 380]); // full view on a phone: ⊞ only when each panel is this big
/** Scale-bar steps (nm): 10 nm … 1 mm. */
export const SCALE_STEPS_NM = Object.freeze([10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6]);

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isArr = (v, n) => Array.isArray(v) && (n === undefined || v.length === n);

// ---------------------------------------------------------------------------------------------------------- formats

function isV1(em) {
  return !!em && typeof em === 'object' && typeof em.atlas === 'string' && em.format === undefined;
}

/** Structural check of a format 2 object (the Worker import and the bake validate the rest). */
export function isV2(em) {
  if (!em || typeof em !== 'object' || em.format !== 2) return false;
  if (!isArr(em.px_nm, 2) || !em.px_nm.every((p) => isNum(p) && p > 0) || !(em.section_nm > 0)) return false;
  if (!isArr(em.em_to_mesh, 3) || !em.em_to_mesh.every((r) => isArr(r, 3) && r.every(isNum))) return false;
  if (!isArr(em.centre_nm, 2) || !isArr(em.bbox_nm, 6)) return false;
  const z = em.z;
  if (!z || z.n !== N_SECTIONS || z.soma_index !== SOMA_INDEX || !isNum(z.z0_nm) || !Array.isArray(z.missing)) return false;
  const s = em.stack;
  if (!s || !isArr(s.rect_nm, 4) || !(s.size_px > 0) || !isArr(s.chunks, 2)) return false;
  if (!s.chunks.every((c) => c && typeof c.asset === 'string' && isArr(c.sections, 16))) return false;
  if (!Array.isArray(em.levels) || em.levels.length < 1) return false;
  if (!em.levels.every((l) => l && typeof l.asset === 'string' && isArr(l.px_nm, 2) && isArr(l.size_px, 2) && isArr(l.rect_nm, 4))) return false;
  const o = em.ortho;
  if (!o || typeof o.asset !== 'string' || !(o.rows > 0) || !o.xz || !o.yz) return false;
  const c = em.ortho_ctx;
  if (!c || typeof c.asset !== 'string' || !Array.isArray(c.levels)) return false;
  return !!(em.outlines && typeof em.outlines.asset === 'string');
}

/**
 * parseEm(em) → { kind, v1, v2, dual }:
 *   'v2'      format 2, or the dual shape (format 1 keys + v2: v1 is the fallback, dual = true);
 *   'v1'      format 1 (16 nm atlas);
 *   'unknown' anything else ("Update the app to see this EM");
 *   'none'    no em (the type stage).
 */
export function parseEm(em) {
  if (em === null || em === undefined) return { kind: 'none', v1: null, v2: null, dual: false };
  if (isV2(em)) return { kind: 'v2', v1: null, v2: em, dual: false };
  if (isV1(em) && em.v2 !== undefined) {
    return isV2(em.v2) ? { kind: 'v2', v1: v1Of(em), v2: em.v2, dual: true } : { kind: 'v1', v1: v1Of(em), v2: null, dual: true };
  }
  if (isV1(em)) return { kind: 'v1', v1: em, v2: null, dual: false };
  return { kind: 'unknown', v1: null, v2: null, dual: false };
}
const v1Of = (em) => ({ atlas: em.atlas, xz: em.xz, mask: em.mask, field_um: em.field_um, n_slices: em.n_slices });

/** Every asset path of a format 2 object (the Worker gates each as `em`). */
export function v2Assets(v2) {
  const out = [];
  for (const c of v2.stack.chunks) out.push(c.asset);
  for (const l of v2.levels) out.push(l.asset);
  out.push(v2.ortho.asset, v2.ortho_ctx.asset, v2.outlines.asset);
  return out;
}

// --------------------------------------------------------------------------------------------------------- numbers

/** "8", "5.55", "3.8", "11.1" (at most two decimals, no trailing zeros). */
export function fmtNm(n) {
  if (!isNum(n)) return '';
  return String(Number(n.toFixed(2)));
}

/** "8 nm px", "5.55 × 4 nm px" (+ " · finest" for the finest served level, never after a half-resolution decode). */
export function pxLabel(px, finest = false) {
  if (!isArr(px, 2)) return '';
  const [a, b] = px;
  const core = Math.abs(a - b) < 1e-6 ? `${fmtNm(a)} nm px` : `${fmtNm(a)} × ${fmtNm(b)} nm px`;
  return finest ? `${core} · finest` : core;
}

/** "z 17/32"; after done "z 17/32 · +0.12 µm" (the section's depth from the soma section, from section_nm). */
export function zLabel(i, n = N_SECTIONS, { done = false, sectionNm = null } = {}) {
  const k = clampSection(i, n);
  const base = `z ${k + 1}/${n}`;
  if (!done || !(sectionNm > 0)) return base;
  const um = ((k - SOMA_INDEX) * sectionNm) / 1000;
  const sign = um < 0 ? '−' : '+';
  return `${base} · ${sign}${Math.abs(um).toFixed(2)} µm`;
}

/** After done only: "40 nm sections". Before done: '' (api.md invariant 3: no thickness, z-step or depth). */
export function sectionsNote(done, sectionNm) {
  return done && sectionNm > 0 ? `${fmtNm(sectionNm)} nm sections` : '';
}

/** Voxel lens label (XZ/YZ): after done "8 × 40 nm"; before done '' (the lens shows the aspect only). */
export function lensLabel(done, panel, v2) {
  if (!done || !v2 || (panel !== 'xz' && panel !== 'yz')) return '';
  const p = panel === 'xz' ? v2.px_nm[0] : v2.px_nm[1];
  return `${fmtNm(p)} × ${fmtNm(v2.section_nm)} nm`;
}

/**
 * The readout under the points (2D panels): ["8 nm px · finest"] before done; after done the sections' thickness and
 * the section's depth join it: ["8 nm px · finest · 40 nm sections", "z 17/32 · +0.12 µm"]. 3D: [] before done
 * (scale bar only), ["z 17/32 · +0.12 µm"] after.
 */
export function readoutLines({ panel = 'xy', px = null, isFinest = false, done = false, sectionNm = null, section = SOMA_INDEX } = {}) {
  const lines = [];
  if (panel !== '3d' && px) lines.push(done && sectionNm > 0 ? `${pxLabel(px, isFinest)} · ${sectionsNote(true, sectionNm)}` : pxLabel(px, isFinest));
  if (done && sectionNm > 0) lines.push(zLabel(section, N_SECTIONS, { done: true, sectionNm }));
  return lines;
}

/** aria-live text: "section 17 of 32" / "section 5 of 32, not imaged". */
export function ariaSection(i, n = N_SECTIONS, missing = false) {
  const k = clampSection(i, n);
  return `section ${k + 1} of ${n}${missing ? ', not imaged' : ''}`;
}

export function clampSection(i, n = N_SECTIONS) {
  if (!isNum(i)) return SOMA_INDEX;
  return clamp(Math.round(i), 0, n - 1);
}

/** Scale bar: the largest step ≤ maxPx long → { nm, px, label } ("50 nm", "2 µm", "1 mm"). */
export function scaleBar(nmPerCssPx, maxPx = 120, steps = SCALE_STEPS_NM) {
  if (!(nmPerCssPx > 0) || !Number.isFinite(nmPerCssPx)) return { nm: steps[0], px: 0, label: scaleLabel(steps[0]) };
  let nm = steps[0];
  for (const s of steps) if (s / nmPerCssPx <= maxPx) nm = s;
  return { nm, px: nm / nmPerCssPx, label: scaleLabel(nm) };
}
/** Below 1 µm in nm (the steps of the spec); from 1 µm via fmtUm. */
export function scaleLabel(nm) {
  return nm < 1000 ? `${fmtNm(nm)} nm` : fmtUm(nm / 1000);
}

/** Footprint contour opacity: 0 below a 12 µm view width, 0.7 above 36 µm, linear in between. */
export function footprintAlpha(viewWidthUm) {
  const [a, b] = FOOTPRINT_FADE_UM;
  if (!(viewWidthUm > a)) return 0;
  if (viewWidthUm >= b) return FOOTPRINT_MAX_ALPHA;
  return (FOOTPRINT_MAX_ALPHA * (viewWidthUm - a)) / (b - a);
}

// ------------------------------------------------------------------------------------------------------- rect maths

export const rectW = (r) => r[2] - r[0];
export const rectH = (r) => r[3] - r[1];
export const rectCentre = (r) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
/** outer ⊇ inner within tol (nm). */
export function rectContains(outer, inner, tol = 0) {
  return inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;
}
export const pointInRect = (r, x, y) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
export const rectsIntersect = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** XY rect of the coverage box B. */
export const bboxXY = (v2) => [v2.bbox_nm[0], v2.bbox_nm[1], v2.bbox_nm[3], v2.bbox_nm[4]];
export const bboxZ = (v2) => [v2.bbox_nm[2], v2.bbox_nm[5]];
export const coarsestRect = (v2) => v2.levels[v2.levels.length - 1].rect_nm;

// ---------------------------------------------------------------------------------------------- sections and rows

/** EM-local z of stack section i's centre: z0_nm + (i − 16)·section_nm. */
export function sectionZ(v2, i) {
  return v2.z.z0_nm + (i - SOMA_INDEX) * v2.section_nm;
}
/** Stack index (float, unclamped) whose centre is at z. */
export function sectionAtZ(v2, z) {
  return (z - v2.z.z0_nm) / v2.section_nm + SOMA_INDEX;
}
export const isMissing = (v2, i) => v2.z.missing.includes(i);

/** Native ortho band: rows r ∈ [0, N) ↔ section offset r − N/2; z of the band's top edge (row 0) and bottom edge. */
export function orthoBand(v2) {
  const n = v2.ortho.rows;
  const s = v2.section_nm;
  const top = v2.z.z0_nm - (n / 2 + 0.5) * s;
  return { rows: n, s, top, bottom: top + n * s };
}
/** z of row r's centre. */
export function rowCentreZ(v2, r) {
  const b = orthoBand(v2);
  return b.top + (r + 0.5) * b.s;
}
/** Row containing z (integer, may fall outside 0…N−1). */
export function rowAtZ(v2, z) {
  const b = orthoBand(v2);
  return Math.floor((z - b.top) / b.s);
}
/** Stack index of ortho row r (r − N/2 + 16), or null outside the stack's 32 sections. */
export function stackIndexOfRow(v2, r) {
  const i = r - v2.ortho.rows / 2 + SOMA_INDEX;
  return i >= 0 && i < N_SECTIONS ? i : null;
}

/** Where stack section i lives: { chunk: 0 | 1, t, col, row } (tile t of the chunk at column t % cols, row ⌊t/cols⌋). */
export function stackTile(v2, i) {
  const cols = v2.stack.cols || 4;
  for (let c = 0; c < v2.stack.chunks.length; c++) {
    const t = v2.stack.chunks[c].sections.indexOf(i);
    if (t >= 0) return { chunk: c, t, col: t % cols, row: Math.floor(t / cols) };
  }
  return null;
}

/** Native ortho rects in plane nm: XZ [x0, zTop, x1, zBottom]; YZ in (y, z) image order [y0, zTop, y1, zBottom]. */
export function orthoRects(v2) {
  const b = orthoBand(v2);
  return {
    xz: [v2.ortho.xz.x0_nm, b.top, v2.ortho.xz.x1_nm, b.bottom],
    yz: [v2.ortho.yz.y0_nm, b.top, v2.ortho.yz.y1_nm, b.bottom],
  };
}

// -------------------------------------------------------------------------------------------------------- em_to_mesh

export function mat3Det(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
/** Inverse of a 3 × 3 (rows); null when singular. det < 0 (a reflection, FlyWire) is fine. */
export function mat3Inverse(m) {
  const d = mat3Det(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-30) return null;
  const k = 1 / d;
  return [
    [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) * k, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * k, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * k],
    [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) * k, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * k, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * k],
    [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) * k, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * k, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * k],
  ];
}
export const mat3MulVec = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
/** EM-local nm → mesh µm. */
export const emToMesh = (v2, v) => mat3MulVec(v2.em_to_mesh, v);
/** mesh µm → EM-local nm (null when em_to_mesh is singular). */
export function meshToEm(v2, v, inv = mat3Inverse(v2.em_to_mesh)) {
  return inv ? mat3MulVec(inv, v) : null;
}

// ------------------------------------------------------------------------------------------------- levels and LOD

/** In-plane px of level ℓ (doubled after a half-resolution decode: scale = 0.5). */
export function levelPx(v2, l, scale = 1) {
  const p = v2.levels[l].px_nm;
  const k = scale > 0 ? 1 / scale : 1;
  return [p[0] * k, p[1] * k];
}
/** Device px per texel along the most minified axis. */
export const texelDev = (px, nmPerDevPx) => Math.min(px[0], px[1]) / nmPerDevPx;

/**
 * Which XY levels are drawn at nmPerDevPx: every loaded level whose texels are ≥ 0.5 device px, plus the coarsest
 * loaded one (it never discards) → { drawn: [ℓ…] (coarse → fine), coarsest }.
 * loaded: (ℓ) → false | { scale } (1, or 0.5 after a half-resolution decode).
 */
export function chooseLevels(v2, nmPerDevPx, loaded = () => ({ scale: 1 })) {
  const L = v2.levels.length;
  let coarsest = -1;
  for (let l = L - 1; l >= 0; l--) if (loaded(l)) { coarsest = l; break; }
  const drawn = [];
  for (let l = L - 1; l >= 0; l--) {
    const st = loaded(l);
    if (!st) continue;
    if (l === coarsest || texelDev(levelPx(v2, l, st.scale), nmPerDevPx) >= LOD_DISCARD) drawn.push(l);
  }
  return { drawn, coarsest };
}

/**
 * What is drawn at the centre of a panel → { kind: 'stack'|'level'|'ortho'|'ctx', index, px: [x, y] nm, finest } or
 * null (3D, nothing loaded). Drives the "8 nm px · finest" / "64 nm px" readout.
 * st: { section, stack: (i) → false | { scale } (tile of section i drawable), level: (ℓ) → false | { scale },
 *       ortho: false | { scale }, ctx: (k) → false | { scale } }
 */
export function centreSource(v2, panel, view, nmPerDevPx, st) {
  if (panel === '3d') return null;
  const p0 = v2.px_nm;
  if (panel === 'xy') {
    const i = st.section;
    const tile = st.stack && !isMissing(v2, i) ? st.stack(i) : false;
    if (tile && pointInRect(v2.stack.rect_nm, view.cx, view.cy)) {
      const px = [p0[0] / tile.scale, p0[1] / tile.scale];
      if (texelDev(px, nmPerDevPx) >= LOD_DISCARD) return { kind: 'stack', index: i, px, finest: tile.scale === 1 };
    }
    const { drawn } = chooseLevels(v2, nmPerDevPx, st.level);
    for (let k = drawn.length - 1; k >= 0; k--) {
      const l = drawn[k];
      if (!pointInRect(v2.levels[l].rect_nm, view.cx, view.cy)) continue;
      const s = st.level(l);
      return { kind: 'level', index: l, px: levelPx(v2, l, s.scale), finest: l === 0 && s.scale === 1 };
    }
    const c = drawn.length ? drawn[0] : -1;
    if (c < 0) return null;
    return { kind: 'level', index: c, px: levelPx(v2, c, st.level(c).scale), finest: c === 0 && st.level(c).scale === 1 };
  }
  // XZ / YZ: native ortho, then the context levels finest first
  const h = panel === 'xz' ? view.cx : view.zv;
  const v = panel === 'xz' ? view.zv : view.cy;
  const rects = orthoRects(v2);
  const inOrtho = panel === 'xz' ? pointInRect(rects.xz, h, v) : pointInRect(rects.yz, v, h);
  const inPlane = panel === 'xz' ? p0[0] : p0[1];
  if (st.ortho && inOrtho) {
    const px = inPlane / st.ortho.scale;
    if (Math.min(px, v2.section_nm / st.ortho.scale) / nmPerDevPx >= LOD_DISCARD || !anyCtx(v2, st)) {
      return { kind: 'ortho', index: 0, px: [px, px], finest: st.ortho.scale === 1 };
    }
  }
  const lv = v2.ortho_ctx.levels;
  for (let k = 0; k < lv.length; k++) {
    const s = st.ctx ? st.ctx(k) : false;
    if (!s) continue;
    const pl = panel === 'xz' ? lv[k].xz : lv[k].yz;
    const inside = panel === 'xz' ? pointInRect(pl.rect_nm, h, v) : pointInRect(pl.rect_nm, v, h);
    const px = (panel === 'xz' ? lv[k].px_nm[0] : lv[k].px_nm[1]) / s.scale;
    const last = k === lv.length - 1;
    if (inside && (last || Math.min(px, lv[k].vz_nm / s.scale) / nmPerDevPx >= LOD_DISCARD)) return { kind: 'ctx', index: k, px: [px, px], finest: false };
  }
  if (st.ortho) return { kind: 'ortho', index: 0, px: [inPlane / st.ortho.scale, inPlane / st.ortho.scale], finest: st.ortho.scale === 1 };
  return null;
}
const anyCtx = (v2, st) => v2.ortho_ctx.levels.some((_, k) => st.ctx && st.ctx(k));

// --------------------------------------------------------------------------------------------- panels and views

/**
 * Panel rects (CSS px) inside a W × H stage. single: the one panel. quad: Neuroglancer's 4panel with 1 px gutters —
 * top row XY | XZ, bottom row 3D | YZ.
 */
export function panelRects(layout, panel, W, H) {
  if (layout !== 'quad') return [{ id: PANELS.includes(panel) ? panel : 'xy', x: 0, y: 0, w: W, h: H }];
  const lw = Math.floor((W - 1) / 2);
  const rw = Math.max(0, W - 1 - lw);
  const th = Math.floor((H - 1) / 2);
  const bh = Math.max(0, H - 1 - th);
  return [
    { id: 'xy', x: 0, y: 0, w: lw, h: th },
    { id: 'xz', x: lw + 1, y: 0, w: rw, h: th },
    { id: '3d', x: 0, y: th + 1, w: lw, h: bh },
    { id: 'yz', x: lw + 1, y: th + 1, w: rw, h: bh },
  ];
}
/** The ⊞ quad toggle on a phone's full view: only when every panel is ≥ 185 × 380 CSS px. */
export function canQuad(W, H) {
  return (W - 1) / 2 >= QUAD_MIN_PANEL[0] && (H - 1) / 2 >= QUAD_MIN_PANEL[1];
}

/** The plane centre (h, v) a 2D panel shows for a view. */
export function planeCentre(panel, view) {
  if (panel === 'xz') return [view.cx, view.zv];
  if (panel === 'yz') return [view.zv, view.cy];
  return [view.cx, view.cy];
}
/** Screen (sx, sy) inside a w × h panel → plane (h, v) nm. */
export function screenToPlane(panel, view, w, h, sx, sy) {
  const [ch, cv] = planeCentre(panel, view);
  return [ch + (sx - w / 2) * view.u, cv + (sy - h / 2) * view.u];
}
/** Plane (h, v) nm → screen (sx, sy) inside a w × h panel. */
export function planeToScreen(panel, view, w, h, ph, pv) {
  const [ch, cv] = planeCentre(panel, view);
  return [(ph - ch) / view.u + w / 2, (pv - cv) / view.u + h / 2];
}
/** A view whose panel centre is the plane point (ph, pv) (the other coordinate is kept). */
export function withPlaneCentre(panel, view, ph, pv) {
  if (panel === 'xz') return { ...view, cx: ph, zv: pv };
  if (panel === 'yz') return { ...view, zv: ph, cy: pv };
  return { ...view, cx: ph, cy: pv };
}
/** Drag by (dx, dy) CSS px: the content follows the finger. */
export function panView(panel, view, dx, dy) {
  const [ch, cv] = planeCentre(panel, view);
  return withPlaneCentre(panel, view, ch - dx * view.u, cv - dy * view.u);
}
/** Zoom by `factor` (> 1 = in) about (sx, sy) in a w × h panel; the plane point under it stays put. */
export function zoomViewAbout(panel, view, factor, sx, sy, w, h, limits = null) {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  let u = view.u / f;
  if (limits) u = clamp(u, limits.uMin, limits.uMax);
  const [ph, pv] = screenToPlane(panel, view, w, h, sx, sy);
  return withPlaneCentre(panel, { ...view, u }, ph - (sx - w / 2) * u, pv - (sy - h / 2) * u);
}

/** Zoom limits for a panel w × h: from 1 native px = 24 device px to Whole cell × 0.8. */
export function zoomLimits(v2, cellU, dpr = 1) {
  const p = Math.min(v2.px_nm[0], v2.px_nm[1]);
  const uMin = (p * Math.max(1, dpr)) / MAX_ZOOM_DEV_PX;
  const uMax = Math.max(uMin * 2, cellU / ZOOM_OUT);
  return { uMin, uMax };
}
/** The view centre stays inside the coarsest level (x, y) and B (z); u inside the limits. */
export function clampView(view, v2, limits = null) {
  const r = coarsestRect(v2);
  const [z0, z1] = bboxZ(v2);
  const u = limits ? clamp(view.u, limits.uMin, limits.uMax) : view.u;
  return { cx: clamp(view.cx, r[0], r[2]), cy: clamp(view.cy, r[1], r[3]), zv: clamp(view.zv, Math.min(z0, z1), Math.max(z0, z1)), u };
}

/**
 * "Native": the stack rect fitted at 92 % of the panel's short side, on the soma section. Given the device pixel ratio
 * (the stage passes it), never so far out that the native pixels are minified past the LOD limit: on a small dpr-1
 * panel (a 1366 × 768 laptop's 4panel) the fit alone minifies 8 nm px ≈ 2.1× and the LOD rule then discards the stack,
 * level 0 and the native XZ/YZ, so "Native" showed "16 nm px" and the context side views. The stack then fills a
 * little more than 92 % of the short side.
 */
export const NATIVE_MIN_TEXEL_DEV = 0.55;
export function frameNative(v2, w, h, dpr = 0) {
  const r = v2.stack.rect_nm;
  const side = Math.max(1, Math.min(w, h)) * NATIVE_FILL;
  const [cx, cy] = rectCentre(r);
  let u = Math.max(rectW(r), rectH(r)) / side;
  if (dpr > 0) u = Math.min(u, (Math.min(v2.px_nm[0], v2.px_nm[1]) * dpr) / NATIVE_MIN_TEXEL_DEV);
  return { cx, cy, zv: v2.z.z0_nm, u };
}
/** "Whole cell": B fitted at 85 % in every plane listed (one shared scale, as in Neuroglancer). */
export function frameCell(v2, w, h, planes = ['xy']) {
  const b = v2.bbox_nm;
  const span = { x: b[3] - b[0], y: b[4] - b[1], z: b[5] - b[2] };
  const axes = { xy: ['x', 'y'], xz: ['x', 'z'], yz: ['z', 'y'] };
  let u = 0;
  for (const p of planes) {
    const a = axes[p];
    if (!a) continue;
    u = Math.max(u, span[a[0]] / (Math.max(1, w) * CELL_FILL), span[a[1]] / (Math.max(1, h) * CELL_FILL));
  }
  if (!(u > 0)) u = span.x / (Math.max(1, w) * CELL_FILL);
  return { cx: (b[0] + b[3]) / 2, cy: (b[1] + b[4]) / 2, zv: (b[2] + b[5]) / 2, u };
}

/**
 * The dive (and any framing animation) at t ∈ [0, 1]: log-zoom with ease-in-out cubic; the target centre moves
 * towards the screen centre at a steady screen rate (so it never swings out of view while zooming in).
 */
export function diveView(t, from, to) {
  const s = easeInOutCubic(clamp(t, 0, 1));
  const u = Math.exp(lerp(Math.log(from.u), Math.log(to.u), s));
  const at = (a, b) => b - ((b - a) / from.u) * (1 - s) * u;
  return { cx: at(from.cx, to.cx), cy: at(from.cy, to.cy), zv: at(from.zv, to.zv), u };
}

/**
 * "Look again" preset (round_reveal.method.look_again item) → { panel, view, section }:
 *   native: value = CSS px per native px; section: value = CSS px per section (XZ/YZ); field: value = view width in
 *   µm; cell: Whole cell. Centred on the stack (native, section, field) on the soma section.
 */
export function lookAgainView(preset, v2, { w = 375, h = 300, dpr = 0 } = {}) {
  const panel = preset && PANELS.includes(preset.panel) ? preset.panel : 'xy';
  const frame = preset ? preset.frame : 'native';
  const value = preset && Number(preset.value) > 0 ? Number(preset.value) : null;
  const [cx, cy] = rectCentre(v2.stack.rect_nm);
  const base = { cx, cy, zv: v2.z.z0_nm, u: frameNative(v2, w, h, dpr).u };
  let view;
  if (frame === 'cell') view = frameCell(v2, w, h, [panel === '3d' ? 'xy' : panel]);
  else if (frame === 'native') view = { ...base, u: value ? Math.min(v2.px_nm[0], v2.px_nm[1]) / value : base.u };
  else if (frame === 'section') view = { ...base, u: value ? v2.section_nm / value : base.u };
  else if (frame === 'field') view = { ...base, u: value ? (value * 1000) / Math.max(1, w) : base.u };
  else view = base;
  return { panel, view, section: SOMA_INDEX };
}

// -------------------------------------------------------------------------------------------------------- 3D camera

/**
 * Default 3D camera (yaw, tilt in radians): mesh front, yaw 30°, tilt 20°; when the XY plane would be seen within
 * 30° of edge-on (|n·d| < 0.5), the view is tilted towards the plane normal until it meets the plane at 60°.
 * Camera direction d (target → camera) = (sin yaw cos tilt, sin tilt, cos yaw cos tilt).
 * `side` (meshSide: +1 / −1, 0 = not known yet): the side of the opaque XY plane (along its normal n = em_to_mesh · [0, 0, 1])
 * that holds most of the mesh. The camera goes to that side, so the plane never hides most of the neuron: the tilt
 * above leans that way, and a default view on the other side is mirrored through the plane (same angle to it).
 */
export function defaultCamera3d(v2, { yaw = Math.PI / 6, tilt = Math.PI / 9, side = 0 } = {}) {
  const dir = (y, t) => [Math.sin(y) * Math.cos(t), Math.sin(t), Math.cos(y) * Math.cos(t)];
  const maxTilt = (80 * Math.PI) / 180;
  const angles = (v) => ({ yaw: Math.atan2(v[0], v[2]), tilt: clamp(Math.asin(clamp(v[1], -1, 1)), -maxTilt, maxTilt) });
  let d = dir(yaw, tilt);
  const raw = mat3MulVec(v2.em_to_mesh, [0, 0, 1]);
  const len = Math.hypot(raw[0], raw[1], raw[2]);
  if (!(len > 0)) return { yaw, tilt };
  const n = raw.map((x) => x / len);
  const a = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
  const want = side > 0 ? 1 : side < 0 ? -1 : 0;
  if (Math.abs(a) >= 0.5) {
    if (!want || Math.sign(a) === want) return { yaw, tilt };
    return angles([d[0] - 2 * a * n[0], d[1] - 2 * a * n[1], d[2] - 2 * a * n[2]]);   // mirrored through the plane
  }
  const sgn = want || (a >= 0 ? 1 : -1);
  let t = [d[0] - a * n[0], d[1] - a * n[1], d[2] - a * n[2]];
  const tl = Math.hypot(t[0], t[1], t[2]) || 1;
  t = t.map((x) => x / tl);
  const s60 = Math.sin(Math.PI / 3);
  d = [sgn * s60 * n[0] + 0.5 * t[0], sgn * s60 * n[1] + 0.5 * t[1], sgn * s60 * n[2] + 0.5 * t[2]];
  return angles(d);
}

/**
 * Which side of the XY plane at section i (EM-local z) holds most of the mesh: +1 (towards +z), −1, or 0 when there
 * is no vertex off the plane. localPositions = EM-local nm, xyz interleaved (the stage's mesh in the EM frame).
 */
export function meshSide(v2, localPositions, i = SOMA_INDEX) {
  if (!localPositions || localPositions.length < 3) return 0;
  const z = sectionZ(v2, i);
  let above = 0;
  let below = 0;
  for (let k = 2; k < localPositions.length; k += 3) {
    const dz = localPositions[k] - z;
    if (dz > 0) above++;
    else if (dz < 0) below++;
  }
  return above === below ? 0 : above > below ? 1 : -1;
}

/**
 * 3D whole-cell fit (§9 "Fit = mesh bbox ∪ planes"): the orthographic frame that holds every point (mesh µm) seen
 * from (yaw, tilt) with up = mesh +Y, as the stage's camera builds it (three.js lookAt: x = up × d, y = d × x).
 * → { target: [x, y, z], the middle of the points' projection (the camera looks at it and turns about it);
 *     hw, hh: half the projection's width and height (µm) }. The stage shows max(hh, hw / aspect) / fill, so the cell
 * and its planes fill the panel (a sphere about the soma left a cell whose soma sits at one end at a third of it).
 */
export function fitView3d(points, { yaw, tilt }) {
  const d = [Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), Math.cos(yaw) * Math.cos(tilt)];
  const xl = Math.hypot(d[2], d[0]) || 1;
  const x = [d[2] / xl, 0, -d[0] / xl];
  const y = [d[1] * x[2] - d[2] * x[1], d[2] * x[0] - d[0] * x[2], d[0] * x[1] - d[1] * x[0]];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points || []) {
    const q = [x, y, d].map((e) => p[0] * e[0] + p[1] * e[1] + p[2] * e[2]);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
  }
  if (!(hi[0] >= lo[0])) return { target: [0, 0, 0], hw: 100, hh: 100 };
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  return {
    target: [0, 1, 2].map((k) => x[k] * c[0] + y[k] * c[1] + d[k] * c[2]),
    hw: Math.max((hi[0] - lo[0]) / 2, 1e-3),
    hh: Math.max((hi[1] - lo[1]) / 2, 1e-3),
  };
}

// ---------------------------------------------------------------------------------------------------- load plan

/**
 * Load order (§8.6): concurrency 2, decode one at a time, each asset drawn when decoded.
 *   1 levels 0 and L (high) · 2 ortho and outlines (high) · 3 stack A (auto) · 4 levels 1…L−1, nearest to the current
 *   zoom first (low) · 5 stack B (low) · 6 ortho_ctx (low; promoted on demand).
 * Data saver: groups 1–2 now; stack A on the first z interaction or after 4 s idle ('z-or-idle'); stack B on
 * reaching index ≤ 8 or ≥ 24 ('deep'); levels 1…L−1 when the LOD rule wants them ('lod'); ortho_ctx on demand.
 * → [{ id, kind, index, asset, bytes, group, priority, gate }]   gate: 'now' | 'z-or-idle' | 'deep' | 'lod' | 'demand'
 */
export function loadPlan(v2, { saveData = false } = {}) {
  const L = v2.levels.length - 1;
  const items = [];
  const add = (id, kind, index, file, group, priority, gate) => items.push({ id, kind, index, asset: file.asset, bytes: file.bytes || 0, group, priority, gate });
  add('level0', 'level', 0, v2.levels[0], 1, 'high', 'now');
  if (L > 0) add(`level${L}`, 'level', L, v2.levels[L], 1, 'high', 'now');
  add('ortho', 'ortho', 0, v2.ortho, 2, 'high', 'now');
  add('outlines', 'outlines', 0, v2.outlines, 2, 'high', 'now');
  add('stackA', 'stack', 0, v2.stack.chunks[0], 3, 'auto', saveData ? 'z-or-idle' : 'now');
  for (let l = 1; l < L; l++) add(`level${l}`, 'level', l, v2.levels[l], 4, 'low', saveData ? 'lod' : 'now');
  add('stackB', 'stack', 1, v2.stack.chunks[1], 5, 'low', saveData ? 'deep' : 'now');
  add('ctx', 'ctx', 0, v2.ortho_ctx, 6, 'low', saveData ? 'demand' : 'now');
  return items;
}
/** Data saver: stack B is fetched on reaching index ≤ 8 or ≥ 24 (§8.6). */
export const wantsStackB = (i) => i <= 8 || i >= 24;
/** Data saver on? navigator.connection.saveData, a slow effectiveType, or the app setting. */
export function saveDataFrom(connection, setting = false) {
  if (setting === true) return true;
  if (!connection) return false;
  if (connection.saveData === true) return true;
  return ['slow-2g', '2g', '3g'].includes(connection.effectiveType);
}
/** "0.4 MB" for a byte count (loading chips). */
export function fmtMB(bytes) {
  const mb = (bytes || 0) / 1e6;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

// --------------------------------------------------------------------------------------------- gestures and wheel

/**
 * The touch gesture table (§8.5; swappable if players dislike it). A gesture starting with `count` fingers at (x, y)
 * CSS px in `panel` → 'section' (one-finger drag on the stack frame: z, Neuroglancer's touchtranslate1),
 * 'scrub' (XZ/YZ: drag the section line), 'pan', 'rotate' (3D), 'pinch' (two fingers: move + zoom), 'pinch3d'.
 * stackFrame: { x0, y0, x1, y1 } on screen (XY); sectionLine: { axis: 'x' | 'y', pos } on screen (XZ: y, YZ: x).
 */
export function classifyTouch({ panel, count = 1, x, y, stackFrame = null, sectionLine = null }) {
  if (count >= 2) return panel === '3d' ? 'pinch3d' : 'pinch';
  if (panel === '3d') return 'rotate';
  if (panel === 'xy') {
    const f = stackFrame;
    if (f && f.x1 - f.x0 >= STACK_DRAG_MIN_PX && x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1) return 'section';
    return 'pan';
  }
  if (sectionLine && Math.abs((sectionLine.axis === 'x' ? x : y) - sectionLine.pos) <= LINE_GRAB_PX) return 'scrub';
  return 'pan';
}
/** One-finger z drag: whole sections for a vertical travel (down = next). */
export const sectionsForDrag = (dyCss) => Math.trunc(dyCss / PX_PER_SECTION);

/**
 * Wheel over a 2D panel (§8.5): Ctrl/⌘ + wheel and trackpad pinch (ctrlKey) zoom by exp(−0.01·Δy) about the pointer
 * (one event at most ×2 either way); otherwise sections: 1 per line, 1 per 50 px of accumulated pixel delta (reset after
 * 200 ms idle), 10 per page; Shift ×10. acc ({ px, lines, t }) carries the remainder between events.
 * → { kind: 'zoom', factor } | { kind: 'section', delta } (delta may be 0).
 */
export function wheelStep(e, acc = { px: 0, lines: 0, t: 0 }, now = Date.now(), pagePx = 800) {
  if (e.ctrlKey || e.metaKey) {
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * pagePx : e.deltaY;
    return { kind: 'zoom', factor: clamp(Math.exp(-0.01 * dy), 0.5, 2) };
  }
  // Shift turns a vertical wheel into a horizontal one on some platforms: take whichever axis moved
  const dy = e.deltaY || (e.shiftKey ? e.deltaX : 0) || 0;
  const mult = e.shiftKey ? SECTION_JUMP : 1;
  if (now - (acc.t || 0) > WHEEL_IDLE_MS) { acc.px = 0; acc.lines = 0; }
  acc.t = now;
  let n = 0;
  if (e.deltaMode === 2) n = Math.sign(dy) * SECTION_JUMP;
  else if (e.deltaMode === 1) {
    acc.lines = (acc.lines || 0) + dy;
    n = Math.trunc(acc.lines);
    acc.lines -= n;
  } else {
    acc.px = (acc.px || 0) + dy;
    n = Math.trunc(acc.px / WHEEL_PX_PER_SECTION);
    acc.px -= n * WHEEL_PX_PER_SECTION;
  }
  return { kind: 'section', delta: n * mult };
}

// ------------------------------------------------------------------------------------------- screen-space helpers

/** The stack rect on screen in an XY panel (CSS px, panel-local). */
export function stackFrameOnScreen(v2, view, w, h) {
  const r = v2.stack.rect_nm;
  const [x0, y0] = planeToScreen('xy', view, w, h, r[0], r[1]);
  const [x1, y1] = planeToScreen('xy', view, w, h, r[2], r[3]);
  return { x0, y0, x1, y1 };
}
/** The current section line on screen in XZ (horizontal: axis 'y') or YZ (vertical: axis 'x'); null elsewhere. */
export function sectionLineOnScreen(panel, v2, view, w, h, i) {
  const z = sectionZ(v2, i);
  if (panel === 'xz') return { axis: 'y', pos: planeToScreen('xz', view, w, h, view.cx, z)[1] };
  if (panel === 'yz') return { axis: 'x', pos: planeToScreen('yz', view, w, h, z, view.cy)[0] };
  return null;
}
/** Stack index under a screen point of XZ / YZ (the row's section), clamped 0…31. */
export function sectionAtScreen(panel, v2, view, w, h, sx, sy) {
  const [ph, pv] = screenToPlane(panel, view, w, h, sx, sy);
  const z = panel === 'xz' ? pv : ph;
  return clampSection(Math.round(sectionAtZ(v2, z)));
}
/** Is the stack covering ≥ 90 % of an XY view (the scrim is then off)? */
export function stackCovers(v2, view, w, h) {
  const f = stackFrameOnScreen(v2, view, w, h);
  const iw = Math.max(0, Math.min(w, f.x1) - Math.max(0, f.x0));
  const ih = Math.max(0, Math.min(h, f.y1) - Math.max(0, f.y0));
  return (iw * ih) / Math.max(1, w * h) >= SCRIM_OFF_COVER;
}

/**
 * Outline ring coordinates (integers in 1/q px of their image) → plane nm, as { ax, bx, ay, by, swap }:
 * plane = (ax + bx·X, ay + by·Y), and for YZ (displayed z right, y down) the plane point is (Y', X') — swap.
 * Ring coordinates are edge-based (0 … size·q), like rect_nm.
 */
export function outlineMap(v2, group, index = 0, q = 2) {
  const p = v2.px_nm;
  if (group === 'stack') return { ax: v2.stack.rect_nm[0], bx: p[0] / q, ay: v2.stack.rect_nm[1], by: p[1] / q, swap: false };
  if (group === 'level') {
    const l = v2.levels[index];
    return { ax: l.rect_nm[0], bx: l.px_nm[0] / q, ay: l.rect_nm[1], by: l.px_nm[1] / q, swap: false };
  }
  const b = orthoBand(v2);
  if (group === 'xz') return { ax: v2.ortho.xz.x0_nm, bx: p[0] / q, ay: b.top, by: b.s / q, swap: false };
  // yz: ring (y px, row) → plane (h = z, v = y)
  return { ax: v2.ortho.yz.y0_nm, bx: p[1] / q, ay: b.top, by: b.s / q, swap: true };
}
