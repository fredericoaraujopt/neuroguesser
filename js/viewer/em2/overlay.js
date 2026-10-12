// EM format 2: the vector overlay (em-v2-spec.md §8.3), one Canvas2D over the WebGL canvas, clipped per 2D panel.
//  - Cell outline (layer "Outline"): data-orange @ 85 %, 1.5 CSS px. XY: stack[k] inside the stack rect, levels 0…2
//    inside R_0…R_2 minus the next finer rect; XZ/YZ: the native outline inside the native ortho, minus its lost rows
//    (lostRowBands: the hatch shows there, not the ring edges the blanked mask leaves). Path2D per group,
//    built once in plane nm and drawn through setTransform. outline_source "mesh" → dashed 4/3.
//  - Mesh cut (same layer): beyond R_2 (XY) and beyond the native ortho (XZ/YZ), dashed 4/3 data-orange @ 85 %.
//  - Lost section: surface-sunken + 45° hatching (ink 12 %, 6 px pitch) over the stack; lost ortho rows likewise.
//  - Stack frame: a 1 px accent hairline (XY). Axis lines ('a'): in XY the XZ row (data-green) and the YZ column
//    (data-purple) over the native ortho extent; in XZ/YZ the other plane's cut, dashed. The current section line
//    (accent, 1 px) is always drawn in XZ/YZ: it is the handle a finger scrubs.
//  - Voxel lens (XZ/YZ, a native px ≥ 6 CSS px): a 1 px accent rectangle around the voxel under the panel centre
//    (the aspect only; its label is a DOM label, after done).
// EM pixels are never tinted: everything here is a line, except the sunken fill of a lost section or row.
import { outlineMap, orthoBand, orthoRects, planeCentre, sectionZ } from './model.js';

const OUTLINE_ALPHA = 0.85;
const OUTLINE_CSS_PX = 1.5;
const DASH = [4, 3];
const HATCH_PITCH = 6;
const HATCH_ALPHA = 0.12;
export const LENS_MIN_CSS_PX = 6;

/**
 * Path2D of rings (flat [x0, y0, x1, y1, …] lists in 1/q px) mapped to plane nm by m (model.outlineMap). A ring of a
 * cell that leaves its image closes along the image border; those border runs (both ends on the same edge of the
 * W × H image, in ring units) are not cell boundaries and are left out (pen up).
 */
export function ringsPath(rings, m, W = Infinity, H = Infinity, Path = globalThis.Path2D) {
  const p = new Path();
  const tol = 1;
  const edge = (x, y) => (x <= tol ? 1 : 0) | (x >= W - tol ? 2 : 0) | (y <= tol ? 4 : 0) | (y >= H - tol ? 8 : 0);
  const pt = (ring, i) => {
    const a = m.ax + m.bx * ring[i];
    const b = m.ay + m.by * ring[i + 1];
    return m.swap ? [b, a] : [a, b];
  };
  for (const ring of rings || []) {
    if (!ring || ring.length < 6) continue;
    const n = ring.length / 2;
    let open = 0;   // index of a vertex whose incoming segment is a border run (start there), else 0
    for (let k = 0; k < n; k++) {
      const j = ((k + n - 1) % n) * 2;
      if (edge(ring[j], ring[j + 1]) & edge(ring[k * 2], ring[k * 2 + 1])) { open = k; break; }
    }
    for (let s = 0; s <= n; s++) {
      const k = (open + s) % n;
      const i = k * 2;
      const [h, v] = pt(ring, i);
      const j = ((k + n - 1) % n) * 2;
      const border = edge(ring[j], ring[j + 1]) & edge(ring[i], ring[i + 1]);
      if (s === n && border) break;
      // the first vertex, or the end of a border run: pen up, move there
      if (s === 0 || border) p.moveTo(h, v);
      else p.lineTo(h, v);
    }
  }
  return p;
}

/** Path2D of mesh-cut polylines ({ pts: [h0, v0, …], closed }). */
export function cutPath(lines, Path = globalThis.Path2D) {
  const p = new Path();
  for (const l of lines || []) {
    const q = l.pts;
    if (q.length < 4) continue;
    p.moveTo(q[0], q[1]);
    for (let i = 2; i < q.length; i += 2) p.lineTo(q[i], q[i + 1]);
    if (l.closed) p.closePath();
  }
  return p;
}

/** Contiguous runs of missing rows → [[r0, r1]] (inclusive). */
export function rowRuns(rows) {
  const s = [...new Set(rows)].sort((a, b) => a - b);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r === last[1] + 1) last[1] = r; else out.push([r, r]);
  }
  return out;
}

/**
 * z bands of the lost ortho rows, each grown by pad nm and merged: [[z0, z1]] (plane nm, z0 < z1). The bake blanks
 * the cell mask in a section that was not imaged, so the XZ/YZ rings run along both edges of each lost row; outlines
 * are clipped out of these bands (as out of a lost stack section): the hatch shows, not a cut-off cell.
 */
export function lostRowBands(v2, pad = 0) {
  const rows = v2 && v2.ortho && v2.ortho.missing_rows;
  if (!rows || !rows.length) return [];
  const band = orthoBand(v2);
  const out = [];
  for (const [r0, r1] of rowRuns(rows)) {
    const z0 = band.top + r0 * band.s - pad;
    const z1 = band.top + (r1 + 1) * band.s + pad;
    const last = out[out.length - 1];
    if (last && z0 <= last[1]) last[1] = Math.max(last[1], z1); else out.push([z0, z1]);
  }
  return out;
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = { orange: '#000', accent: '#000', green: '#000', purple: '#000', blue: '#000', sunken: '#000', ink: '#000' };
    this.paths = null;          // { stack: Path2D[32], levels: Path2D[3], xz, yz, q }
    this.dashed = false;        // outline_source 'mesh'
    this.cuts = new Map();      // key → Path2D
  }

  setColors(c) { this.colors = { ...this.colors, ...c }; }

  /** Parsed outlines JSON (em_outlines.schema.json) → Path2D groups in plane nm. */
  setOutlines(json, v2) {
    if (!json || !v2) { this.paths = null; return; }
    const q = json.q || 2;
    this.dashed = v2.outline_source === 'mesh';
    const S = v2.stack.size_px * q;
    const ow = (v2.ortho.width_px || 1024) * q;
    const oh = v2.ortho.rows * q;
    this.paths = {
      stack: (json.stack || []).map((rings) => ringsPath(rings, outlineMap(v2, 'stack', 0, q), S, S)),
      levels: (json.levels || []).map((rings, l) => (v2.levels[l]
        ? ringsPath(rings, outlineMap(v2, 'level', l, q), v2.levels[l].size_px[0] * q, v2.levels[l].size_px[1] * q) : null)),
      xz: ringsPath(json.xz, outlineMap(v2, 'xz', 0, q), ow, oh),
      yz: ringsPath(json.yz, outlineMap(v2, 'yz', 0, q), ow, oh),
    };
    this.ringsOk = true;
  }

  /** Mesh cut paths, cached by key ('xy:17', 'xz', 'yz'); make() → polylines. */
  cut(key, make) {
    if (!this.cuts.has(key)) {
      const lines = make();
      this.cuts.set(key, lines ? cutPath(lines) : null);
    }
    return this.cuts.get(key);
  }

  clear() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * Draw one 2D panel. s: { panel: { id, x, y, w, h } (CSS px), dpr, view, v2, section, layers: { outline, axes },
   *   stackShown (the tile of the section is on screen), stackCovered (the stack quad fills the stack rect: its tile,
   *   a lost section or a loading one), orthoShown, missingStack (bool), cutXY (() → lines),
   *   cutXZ, cutYZ, lens: bool }
   */
  drawPanel(s) {
    const { ctx } = this;
    const { panel: p, dpr, view, v2 } = s;
    if (!v2 || p.id === '3d' || p.w <= 0 || p.h <= 0) return;
    const k = dpr / view.u;                    // device px per nm
    const [ch, cv] = planeCentre(p.id, view);
    const ox = (p.x + p.w / 2) * dpr - ch * k;
    const oy = (p.y + p.h / 2) * dpr - cv * k;
    const toDev = (h, v) => [h * k + ox, v * k + oy];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(p.x * dpr, p.y * dpr, p.w * dpr, p.h * dpr);
    ctx.clip();
    const C = this.colors;
    const line = (w) => { ctx.lineWidth = w * view.u; };   // CSS px → plane nm (under the plane transform)

    if (p.id === 'xy') {
      const r = v2.stack.rect_nm;
      if (s.missingStack) this._hatch(toDev(r[0], r[1]), toDev(r[2], r[3]), dpr);
      if (s.layers.outline) {
        ctx.setTransform(k, 0, 0, k, ox, oy);
        this._strokeOutlines(s, line);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      // the stack frame (1 px accent hairline)
      const [a0, b0] = toDev(r[0], r[1]);
      const [a1, b1] = toDev(r[2], r[3]);
      ctx.strokeStyle = C.accent;
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.setLineDash([]);
      ctx.strokeRect(Math.round(a0) + 0.5 * (ctx.lineWidth % 2), Math.round(b0) + 0.5 * (ctx.lineWidth % 2), Math.round(a1 - a0), Math.round(b1 - b0));
      if (s.layers.axes) {
        const o = v2.ortho;
        this._seg(toDev(o.xz.x0_nm, o.xz.y_nm), toDev(o.xz.x1_nm, o.xz.y_nm), C.green, dpr, false);
        this._seg(toDev(o.yz.x_nm, o.yz.y0_nm), toDev(o.yz.x_nm, o.yz.y1_nm), C.purple, dpr, false);
      }
    } else {
      const xz = p.id === 'xz';
      const rects = orthoRects(v2);
      const band = orthoBand(v2);
      // lost rows: sunken + hatch over the native ortho's extent
      if (s.orthoShown && v2.ortho.missing_rows && v2.ortho.missing_rows.length) {
        for (const [r0, r1] of rowRuns(v2.ortho.missing_rows)) {
          const z0 = band.top + r0 * band.s;
          const z1 = band.top + (r1 + 1) * band.s;
          if (xz) this._hatch(toDev(rects.xz[0], z0), toDev(rects.xz[2], z1), dpr);
          else this._hatch(toDev(z0, rects.yz[0]), toDev(z1, rects.yz[2]), dpr);
        }
      }
      if (s.layers.outline) {
        ctx.setTransform(k, 0, 0, k, ox, oy);
        this._strokeOrthoOutlines(s, line, xz);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      const z = sectionZ(v2, s.section);
      const W = p.x * dpr;
      const Wr = (p.x + p.w) * dpr;
      const Ht = p.y * dpr;
      const Hb = (p.y + p.h) * dpr;
      if (s.layers.axes) {
        if (xz) { const [x] = toDev(v2.ortho.yz.x_nm, 0); this._seg([x, Ht], [x, Hb], C.purple, dpr, true); }
        else { const [, y] = toDev(0, v2.ortho.xz.y_nm); this._seg([W, y], [Wr, y], C.green, dpr, true); }
      }
      // the current section (always: it is the scrub handle)
      if (xz) { const [, y] = toDev(0, z); this._seg([W, y], [Wr, y], C.accent, dpr, false); }
      else { const [x] = toDev(z, 0); this._seg([x, Ht], [x, Hb], C.accent, dpr, false); }
      if (s.lens && s.orthoShown) this._lens(s, toDev, xz, rects, band);
    }
    ctx.restore();
  }

  _strokeOutlines(s, line) {
    const { ctx } = this;
    const { v2 } = s;
    const P = this.paths;
    ctx.globalAlpha = OUTLINE_ALPHA;
    ctx.strokeStyle = this.colors.orange;
    ctx.lineJoin = 'round';
    line(OUTLINE_CSS_PX);
    const dash = this.dashed ? DASH.map((d) => d * s.view.u) : [];
    ctx.setLineDash(dash);
    const st = v2.stack.rect_nm;
    if (P) {
      // stack[k] inside the stack rect (only while that section's tile is on screen)
      if (s.stackShown && !s.missingStack && P.stack[s.section]) {
        ctx.save();
        ctx.beginPath(); ctx.rect(st[0], st[1], st[2] - st[0], st[3] - st[1]); ctx.clip();
        ctx.stroke(P.stack[s.section]);
        ctx.restore();
      }
      // levels 0…2 in R_ℓ minus the next finer rect (level 0: minus the stack whenever the stack quad owns that area —
      // its tile, a lost section or one still loading: the soma section's outline never runs over another section)
      for (let l = 0; l < Math.min(3, P.levels.length); l++) {
        const path = P.levels[l];
        if (!path || !v2.levels[l]) continue;
        const outer = v2.levels[l].rect_nm;
        const inner = l === 0 ? (s.stackShown || s.stackCovered ? st : null) : v2.levels[l - 1].rect_nm;
        ctx.save();
        const clip = new Path2D();
        clip.rect(outer[0], outer[1], outer[2] - outer[0], outer[3] - outer[1]);
        if (inner) clip.rect(inner[0], inner[1], inner[2] - inner[0], inner[3] - inner[1]);
        ctx.clip(clip, 'evenodd');
        ctx.stroke(path);
        ctx.restore();
      }
    }
    // mesh cut beyond R_2, dashed
    const cut = s.cutXY ? s.cutXY() : null;
    if (cut) {
      const r2 = (v2.levels[Math.min(2, v2.levels.length - 1)] || v2.levels[0]).rect_nm;
      ctx.save();
      const clip = new Path2D();
      clip.rect(-1e9, -1e9, 2e9, 2e9);
      clip.rect(r2[0], r2[1], r2[2] - r2[0], r2[3] - r2[1]);
      ctx.clip(clip, 'evenodd');
      ctx.setLineDash(DASH.map((d) => d * s.view.u));
      ctx.stroke(cut);
      ctx.restore();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  _strokeOrthoOutlines(s, line, xz) {
    const { ctx } = this;
    const { v2 } = s;
    const P = this.paths;
    ctx.globalAlpha = OUTLINE_ALPHA;
    ctx.strokeStyle = this.colors.orange;
    ctx.lineJoin = 'round';
    line(OUTLINE_CSS_PX);
    const rects = orthoRects(v2);
    // native rect in panel (h, v): XZ (x, z); YZ (z, y)
    const nr = xz ? rects.xz : [rects.yz[1], rects.yz[0], rects.yz[3], rects.yz[2]];
    if (P && s.orthoShown) {
      ctx.save();
      // the native rect minus the lost rows (± the stroke width): no outline over a section that was not imaged
      const clip = new Path2D();
      clip.rect(nr[0], nr[1], nr[2] - nr[0], nr[3] - nr[1]);
      for (const [z0, z1] of lostRowBands(v2, OUTLINE_CSS_PX * s.view.u)) {
        if (xz) clip.rect(nr[0], z0, nr[2] - nr[0], z1 - z0);
        else clip.rect(z0, nr[1], z1 - z0, nr[3] - nr[1]);
      }
      ctx.clip(clip, 'evenodd');
      ctx.setLineDash(this.dashed ? DASH.map((d) => d * s.view.u) : []);
      ctx.stroke(xz ? P.xz : P.yz);
      ctx.restore();
    }
    const cut = xz ? (s.cutXZ && s.cutXZ()) : (s.cutYZ && s.cutYZ());
    if (cut) {
      ctx.save();
      const clip = new Path2D();
      clip.rect(-1e9, -1e9, 2e9, 2e9);
      if (s.orthoShown) clip.rect(nr[0], nr[1], nr[2] - nr[0], nr[3] - nr[1]);
      ctx.clip(clip, 'evenodd');
      ctx.setLineDash(DASH.map((d) => d * s.view.u));
      ctx.stroke(cut);
      ctx.restore();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /** Sunken fill + 45° hatching (ink 12 %, 6 CSS px pitch) over a device-space rect given by two corners. */
  _hatch([a0, b0], [a1, b1], dpr) {
    const { ctx } = this;
    const x0 = Math.min(a0, a1); const x1 = Math.max(a0, a1);
    const y0 = Math.min(b0, b1); const y1 = Math.max(b0, b1);
    if (x1 - x0 < 0.5 || y1 - y0 < 0.25) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.colors.sunken;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = this.colors.ink;
    ctx.globalAlpha = HATCH_ALPHA;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.setLineDash([]);
    const pitch = HATCH_PITCH * dpr;
    const span = (x1 - x0) + (y1 - y0);
    // lines x − y = c, anchored to the device grid so the hatch does not crawl while panning
    const start = Math.floor((x0 - y1) / pitch) * pitch;
    ctx.beginPath();
    for (let c = start; c <= x1 - y0 + pitch && c - start <= span + 2 * pitch; c += pitch) {
      ctx.moveTo(c + y0, y0);
      ctx.lineTo(c + y1, y1);
    }
    ctx.stroke();
    ctx.restore();
  }

  _seg([x0, y0], [x1, y1], color, dpr, dashed) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.setLineDash(dashed ? DASH.map((d) => d * dpr) : []);
    const off = (ctx.lineWidth % 2) / 2;
    ctx.beginPath();
    if (Math.abs(x0 - x1) < 0.01) { const x = Math.round(x0) + off; ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    else if (Math.abs(y0 - y1) < 0.01) { const y = Math.round(y0) + off; ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    else { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
    ctx.stroke();
    ctx.restore();
  }

  _lens(s, toDev, xz, rects, band) {
    const { v2, view } = s;
    const p = xz ? v2.px_nm[0] : v2.px_nm[1];
    if (p / view.u < LENS_MIN_CSS_PX) return;
    // the voxel under the panel centre (inside the native ortho only)
    const a = xz ? view.cx : view.cy;             // in-plane coordinate (x or y)
    const r0 = xz ? rects.xz[0] : rects.yz[0];
    const r1 = xz ? rects.xz[2] : rects.yz[2];
    if (a < r0 || a >= r1 || view.zv < band.top || view.zv >= band.bottom) return;
    const i = Math.floor((a - r0) / p);
    const row = Math.floor((view.zv - band.top) / band.s);
    const v0 = r0 + i * p; const v1 = v0 + p;
    const z0 = band.top + row * band.s; const z1 = z0 + band.s;
    const [a0, b0] = xz ? toDev(v0, z0) : toDev(z0, v0);
    const [a1, b1] = xz ? toDev(v1, z1) : toDev(z1, v1);
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = Math.max(1, s.dpr);
    ctx.setLineDash([]);
    ctx.strokeRect(Math.min(a0, a1), Math.min(b0, b1), Math.abs(a1 - a0), Math.abs(b1 - b0));
    ctx.restore();
    this.lensRect = { x0: Math.min(a0, a1) / s.dpr, y0: Math.min(b0, b1) / s.dpr, x1: Math.max(a0, a1) / s.dpr, y1: Math.max(b0, b1) / s.dpr, row };
  }
}

