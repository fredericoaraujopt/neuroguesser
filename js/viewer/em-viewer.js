// EmViewer (ARCHITECTURE.md §4.4, contracts/assets.md "EM for the method round"): Canvas2D.
//  - XY: tile k of the atlas (512 px tiles, 8 columns, row-major; 32 slices; 16 nm/px → 8.192 µm field);
//    the soma centre sits at the centre of tile 16, so the viewer opens on slice 16.
//  - Mask: the same tile of the mask PNG (255 = this cell) drawn as data-orange (#df9a00) at 32 %. Only mask
//    pixels are coloured; EM pixels are never tinted, filtered or re-mapped (imageSmoothing is the only
//    resampling, and it is a choice: 'auto' = linear when shrinking / nearest once an image pixel covers
//    ≥ 2 device px, so the data stay honest when magnified; both keep true greyscale).
//  - XZ: the single 512 × 512 reslice (x horizontal, z down), no mask (the contract ships none).
//  - Never shows a voxel size, section thickness or z-step: callers get slice indices only (the full view adds
//    depth from reveal.method.voxel_nm once the round is done). No slice marker is drawn on the XZ image
//    (its band height would give the section thickness away).
// View units: zoom 1 = the tile fitted ('cover' fills the viewer, 'contain' shows the whole field); panX/panY =
// shift of the image in µm (+x right, +y up).
//
// Memory (QA perf): a decoded 4096 × 2048 atlas and mask are 32 MB of RGBA each (68 MB with the XZ, plus a GPU copy
// once drawn). Each is unpacked into a TileStack — the EM at 1 byte per pixel (true greyscale: R = B, and G within
// the WebP decoder's ±1 rounding; a non-grey atlas keeps drawing from the decoded image), the mask at 1 bit per pixel
// (≥ 128 = this cell, as before) — the current slice at once, the rest in the background, after which the decoded
// bitmap is closed. A slice is expanded back into a 512² canvas when drawn (small LRU), with the same grey values.
import { loadCss } from '../ui/html.js';

loadCss('css/viewer.css');

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/viewer-em.test.js)

export const MASK_RGB = Object.freeze([0xdf, 0x9a, 0x00]);   // data-orange
export const MASK_ALPHA = 0.32;
export const EM_ZOOM_MIN = 0.5;
export const EM_ZOOM_MAX = 8;
export const MAX_DPR = 2;
export const SAMPLING = Object.freeze(['auto', 'nearest', 'linear']);
const MASK_CACHE = 4;        // expanded slices kept as 512² canvases (LRU), mask and EM each
const EM_TILE_CACHE = 4;
export const GREY_TOLERANCE = 2;   // max |R − G|, |R − B| still treated as true greyscale (libwebp rounds G by ±1)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Source rect of slice k in the atlas: column k % cols, row ⌊k / cols⌋. */
export function tileRect(k, tile = 512, cols = 8) {
  const kk = Math.max(0, Math.floor(k));
  return { sx: (kk % cols) * tile, sy: Math.floor(kk / cols) * tile, sw: tile, sh: tile };
}

/** Clamp a slice index into 0 … nSlices − 1 (non-numbers → middle). */
export function clampSlice(k, nSlices = 32) {
  const n = Math.max(1, Math.floor(nSlices) || 1);
  if (!Number.isFinite(k)) return Math.floor(n / 2);
  return clamp(Math.round(k), 0, n - 1);
}

/**
 * Colourise a mask tile: RGBA source (R = mask value) → RGBA out, data-orange at `alpha` where value ≥
 * threshold, fully transparent elsewhere. Returns the number of mask pixels.
 */
export function colouriseMask(src, out = new Uint8ClampedArray(src.length), rgb = MASK_RGB, alpha = MASK_ALPHA, threshold = 128) {
  const a = Math.round(clamp(alpha, 0, 1) * 255);
  const [r, g, b] = rgb;
  let n = 0;
  for (let i = 0; i < src.length; i += 4) {
    if (src[i] >= threshold) {
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a; n++;
    } else {
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
    }
  }
  return n;
}

/**
 * RGBA tile → 1 byte per pixel (the R channel) at out[offset …]. Returns the largest |R − G| / |R − B| seen, so a
 * caller can tell a true-greyscale EM (≤ GREY_TOLERANCE) from anything else.
 */
export function packGrey(rgba, out, offset = 0) {
  let dev = 0;
  for (let i = 0, j = offset; i < rgba.length; i += 4, j++) {
    const r = rgba[i];
    out[j] = r;
    const dg = r > rgba[i + 1] ? r - rgba[i + 1] : rgba[i + 1] - r;
    const db = r > rgba[i + 2] ? r - rgba[i + 2] : rgba[i + 2] - r;
    if (dg > dev) dev = dg;
    if (db > dev) dev = db;
  }
  return dev;
}

/** Packed grey (count pixels from offset) → opaque RGBA (g, g, g, 255). */
export function expandGrey(grey, offset, count, out) {
  for (let i = 0, j = offset, o = 0; i < count; i++, j++, o += 4) {
    const g = grey[j];
    out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
  }
  return out;
}

/** RGBA mask tile → 1 bit per pixel (R ≥ threshold) from bit `bitOffset` (a multiple of 8). Returns the set count. */
export function packMaskBits(rgba, bits, bitOffset = 0, threshold = 128) {
  let n = 0;
  const pixels = rgba.length >> 2;
  let byte = bitOffset >> 3;
  for (let p = 0; p < pixels; p += 8, byte++) {
    let v = 0;
    for (let b = 0; b < 8 && p + b < pixels; b++) {
      if (rgba[(p + b) << 2] >= threshold) { v |= 1 << b; n++; }
    }
    bits[byte] = v;
  }
  return n;
}

/** Packed mask bits → RGBA: data-orange at `alpha` where set, transparent elsewhere (as colouriseMask). */
export function expandMaskBits(bits, bitOffset, count, out, rgb = MASK_RGB, alpha = MASK_ALPHA) {
  const a = Math.round(clamp(alpha, 0, 1) * 255);
  const [r, g, b] = rgb;
  let n = 0;
  for (let p = 0, o = 0; p < count; p++, o += 4) {
    const bit = bitOffset + p;
    if (bits[bit >> 3] & (1 << (bit & 7))) {
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a; n++;
    } else {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
    }
  }
  return n;
}

/** CSS px per image px at zoom 1 for a square image of `size` px in a w × h viewer. */
export function baseScale(w, h, size, fit = 'cover') {
  if (!(w > 0) || !(h > 0) || !(size > 0)) return 1;
  return (fit === 'contain' ? Math.min(w, h) : Math.max(w, h)) / size;
}

/** Destination rect (CSS px) of the image, centred, zoomed, panned (pan in µm, +y up). */
export function emLayout({ w, h, size = 512, fieldUm = 8.192, zoom = 1, panX = 0, panY = 0, fit = 'cover' }) {
  const s = baseScale(w, h, size, fit) * zoom;
  const pxPerUm = (s * size) / fieldUm;
  const dw = size * s;
  return { scale: s, pxPerUm, dx: w / 2 - dw / 2 + panX * pxPerUm, dy: h / 2 - dw / 2 - panY * pxPerUm, dw, dh: dw };
}

/** Linear when shrinking or near 1:1; nearest once one image pixel spans ≥ 2 device px. */
export function smoothingFor(sampling, scale, dpr = 1) {
  if (sampling === 'nearest') return false;
  if (sampling === 'linear') return true;
  return scale * dpr < 2;
}

/** Keep at least a quarter of the (zoomed) image inside the viewer. */
export function clampPan(view, layout, w, h) {
  const k = layout.pxPerUm || 1;
  const limX = (w / 2 + layout.dw / 4) / k;
  const limY = (h / 2 + layout.dh / 4) / k;
  return { ...view, panX: clamp(view.panX, -limX, limX), panY: clamp(view.panY, -limY, limY) };
}

/** Zoom by `factor` about (sx, sy) px from the viewer centre (+y up). */
export function emZoomAbout(view, factor, sx, sy, pxPerUm) {
  const zoom = clamp(view.zoom * (Number.isFinite(factor) && factor > 0 ? factor : 1), EM_ZOOM_MIN, EM_ZOOM_MAX);
  if (!(pxPerUm > 0)) return { ...view, zoom };
  const k2 = pxPerUm * (zoom / view.zoom);
  // image point under (sx, sy): u = (s − pan·k) / k  (µm from the image centre) must stay put
  const ux = (sx - view.panX * pxPerUm) / pxPerUm;
  const uy = (sy - view.panY * pxPerUm) / pxPerUm;
  return { zoom, panX: (sx - ux * k2) / k2, panY: (sy - uy * k2) / k2 };
}

async function decode(blob, opts) {
  if (!blob) return null;
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none', ...opts });
    } catch (_) {
      try { return await createImageBitmap(blob); } catch (_e) { /* fall through to <img> */ }
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// Decoded images shared between viewers of the same Blob (api.assetBlob memoises Blobs by path): the full view
// opened over the method round's inline EM reuses its 4096 × 2048 atlas and mask instead of decoding a second
// copy (≈ 64 MB of pixels on a phone). Reference-counted; the last release closes the bitmap.
const DECODED = new WeakMap();
export function acquireImage(blob, decoder = decode) {
  if (!blob) return Promise.resolve(null);
  let e = DECODED.get(blob);
  if (!e) {
    e = { refs: 0, promise: null };
    e.promise = decoder(blob).catch((err) => { if (DECODED.get(blob) === e) DECODED.delete(blob); throw err; });
    DECODED.set(blob, e);
  }
  e.refs++;
  return e.promise;
}
export function releaseImage(blob) {
  const e = blob ? DECODED.get(blob) : null;
  if (!e) return;
  e.refs--;
  if (e.refs > 0) return;
  DECODED.delete(blob);
  e.promise.then((img) => { if (img && typeof img.close === 'function') img.close(); }, () => {});
}

/** A size × size 2D canvas (OffscreenCanvas when it supports 2D, else a DOM canvas); read: we read it back. */
function scratchCanvas(size, { read = true } = {}) {
  const opts = read ? { willReadFrequently: true } : undefined;
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const c = new OffscreenCanvas(size, size);
      const ctx = c.getContext('2d', opts);
      if (ctx) return { canvas: c, ctx };
    } catch (_) { /* Safari < 16.4: no 2D on OffscreenCanvas */ }
  }
  if (typeof document === 'undefined') return { canvas: null, ctx: null };
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return { canvas: c, ctx: c.getContext('2d', opts) };
}

let reader = null;
/** Tile k of a decoded atlas/mask as RGBA (one shared read-back canvas). */
function readTileRGBA(img, k, tile, cols) {
  if (!reader || reader.size !== tile) {
    const s = scratchCanvas(tile);
    reader = s.ctx ? { ...s, size: tile } : null;
  }
  if (!reader) return null;
  const { sx, sy } = tileRect(k, tile, cols);
  reader.ctx.clearRect(0, 0, tile, tile);
  reader.ctx.drawImage(img, sx, sy, tile, tile, 0, 0, tile, tile);
  return reader.ctx.getImageData(0, 0, tile, tile).data;
}

/**
 * One atlas ('em') or mask ('mask'), unpacked tile by tile out of its decoded image into 1 byte (EM) or 1 bit (mask)
 * per pixel. ensure(k) unpacks tile k now; unpackAll(from) does the rest in the background (4 tiles per tick,
 * nearest to `from` first); once every tile is unpacked the decoded image is released (onRelease). An EM tile that
 * is not true greyscale stops the unpacking for good (exact = false) and the image stays until dispose().
 */
export class TileStack {
  constructor(img, { kind = 'em', tile = 512, cols = 8, n = 32, readTile = readTileRGBA, onRelease = null } = {}) {
    this.kind = kind === 'mask' ? 'mask' : 'em';
    this.tile = tile; this.cols = cols; this.n = Math.max(1, n);
    this.per = tile * tile;
    this.img = img;
    this.data = this.kind === 'mask' ? new Uint8Array(Math.ceil((this.per * this.n) / 8)) : new Uint8Array(this.per * this.n);
    this.done = new Uint8Array(this.n);
    this.left = this.n;
    this.exact = true;
    this._readTile = readTile;
    this._onRelease = onRelease;
    this._timer = 0;
  }

  /** Tile k available packed (unpacking it now if needed)? */
  ensure(k) {
    if (!(k >= 0 && k < this.n) || !this.data) return false;
    if (this.done[k]) return true;
    if (!this.img || !this.exact) return false;
    const rgba = this._readTile(this.img, k, this.tile, this.cols);
    if (!rgba) return false;
    if (this.kind === 'mask') packMaskBits(rgba, this.data, k * this.per);
    else if (packGrey(rgba, this.data, k * this.per) > GREY_TOLERANCE) { this.exact = false; this._stop(); return false; }
    this.done[k] = 1;
    if (--this.left === 0) this._releaseImage();
    return true;
  }

  unpackAll(from = this.n >> 1) {
    if (this._timer || !this.img || !this.exact || !this.left) return;
    const order = [...Array(this.n).keys()].sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || a - b);
    const step = () => {
      this._timer = 0;
      let budget = 4;
      for (const k of order) {
        if (!this.img || !this.exact) return;
        if (this.done[k]) continue;
        this.ensure(k);
        if (--budget === 0) break;
      }
      if (this.left && this.img && this.exact) this._timer = setTimeout(step, 16);
    };
    this._timer = setTimeout(step, 32);
  }

  dispose() {
    this._stop();
    if (this.img) this._releaseImage();
    this.data = null;
  }

  _stop() { if (this._timer) clearTimeout(this._timer); this._timer = 0; }

  _releaseImage() {
    this._stop();
    const f = this._onRelease;
    this.img = null;
    this._onRelease = null;
    if (f) f();
  }
}

// Stacks shared between viewers of the same Blob (inline EM + full view), reference-counted like the decodes.
const STACKS = new WeakMap();
export function acquireStack(blob, kind, layout = {}, decoder = decode) {
  if (!blob) return Promise.resolve(null);
  let e = STACKS.get(blob);
  if (!e) {
    e = { refs: 0, promise: null };
    e.promise = acquireImage(blob, decoder).then((img) => {
      if (!img) return null;
      return new TileStack(img, { ...layout, kind, onRelease: () => releaseImage(blob) });
    });
    e.promise.catch(() => { if (STACKS.get(blob) === e) STACKS.delete(blob); });
    STACKS.set(blob, e);
  }
  e.refs++;
  return e.promise;
}
export function releaseStack(blob) {
  const e = blob ? STACKS.get(blob) : null;
  if (!e) return;
  e.refs--;
  if (e.refs > 0) return;
  STACKS.delete(blob);
  e.promise.then((st) => { if (st) st.dispose(); }, () => {});
}

const TAP_SLOP_PX = 4;

export class EmViewer {
  constructor(container, { interactive = true, showMask = true, fit = 'cover', sampling = 'auto' } = {}) {
    this.container = container;
    this.options = { interactive, fit: fit === 'contain' ? 'contain' : 'cover' };
    this._disposed = false;
    this._plane = 'xy';
    this._slice = 16;
    this._nSlices = 32;
    this._tile = 512;
    this._cols = 8;
    this._fieldUm = 8.192;
    this._maskVisible = !!showMask;
    this._sampling = SAMPLING.includes(sampling) ? sampling : 'auto';
    this._view = { zoom: 1, panX: 0, panY: 0 };
    this._atlas = null;            // TileStack (EM)
    this._mask = null;             // TileStack (mask)
    this._xz = null;               // decoded XZ image (512², 1 MB)
    this._held = null;             // { atlas, mask, xz } Blobs acquired (shared stacks/decodes)
    this._maskTiles = new Map();   // slice → expanded 512² canvas entry (LRU)
    this._emTiles = new Map();
    this._px = null;               // one ImageData reused to expand slices
    this._changeCbs = new Set();
    this._tapCbs = new Set();
    this._pointers = new Map();
    this._gesture = null;
    this._raf = 0;
    this._listeners = [];
    this._loadToken = 0;
    this._size = { w: 1, h: 1, dpr: 1 };
    this._lastEmit = null;

    const root = document.createElement('div');
    root.className = 'em-root';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-roledescription', 'EM viewer');
    root.setAttribute('aria-label', interactive
      ? 'Electron micrograph of the cell. Drag to pan, pinch or scroll to zoom; up and down arrows change the slice.'
      : 'Electron micrograph of the cell.');
    if (interactive) root.tabIndex = 0;
    this._root = root;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d', { alpha: false });
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'mv-status';
    this._statusEl.setAttribute('role', 'status');
    this._statusEl.hidden = true;
    root.append(canvas, this._statusEl);
    container.appendChild(root);
    // the chrome around the data = surface-sunken (read from the tokens, never typed here)
    try { this._bg = getComputedStyle(root).getPropertyValue('--surface-sunken').trim() || null; } catch (_) { this._bg = null; }

    this._measure();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._measure(); this._invalidate(); });
      this._ro.observe(root);
    } else {
      this._on(window, 'resize', () => { this._measure(); this._invalidate(); });
    }
    if (interactive) this._bindInput();
    this._invalidate();
  }

  /** Blobs from api.assetBlob(state.em.atlas / .mask / .xz). Resolves once the atlas is decoded. */
  async load({ atlas, mask = null, xz = null, fieldUm = 8.192, nSlices = 32, tile = 512, cols = 8 } = {}) {
    if (this._disposed) return;
    const token = ++this._loadToken;
    this._fieldUm = fieldUm > 0 ? fieldUm : 8.192;
    this._nSlices = Math.max(1, Math.floor(nSlices) || 32);
    this._tile = tile > 0 ? tile : 512;
    this._cols = cols > 0 ? cols : 8;
    this._slice = clampSlice(Math.floor(this._nSlices / 2), this._nSlices);
    this._setStatus('Loading EM…', 'is-loading');
    const held = { atlas: atlas || null, mask: mask || null, xz: xz || null };
    const layout = { tile: this._tile, cols: this._cols, n: this._nSlices };
    const release = () => { releaseStack(held.atlas); releaseStack(held.mask); releaseImage(held.xz); };
    let decoded;
    try {
      decoded = await Promise.all([acquireStack(held.atlas, 'em', layout), acquireStack(held.mask, 'mask', layout), acquireImage(held.xz)]);
    } catch (err) {
      release();
      if (token === this._loadToken && !this._disposed) this._setStatus('Could not draw this EM.');
      throw err;
    }
    if (this._disposed || token !== this._loadToken) { release(); return; }
    this._releaseImages();
    this._held = held;
    [this._atlas, this._mask, this._xz] = decoded;
    // the slice on screen is unpacked when first drawn; the rest now, so the decoded bitmaps can be closed
    for (const st of [this._atlas, this._mask]) if (st) st.unpackAll(this._slice);
    if (!this._atlas) this._setStatus('No EM for this cell.'); else this._setStatus(null);
    this._emitDirty = true;
    this._invalidate();
  }

  setPlane(plane) {
    const p = plane === 'xz' ? 'xz' : 'xy';
    if (p === this._plane) return;
    this._plane = p;
    this._changed();
  }
  getPlane() { return this._plane; }

  setSlice(k) {
    const s = clampSlice(k, this._nSlices);
    if (s === this._slice) return;
    this._slice = s;
    this._changed();
  }
  getSlice() { return this._slice; }
  step(delta) { this.setSlice(this._slice + (Math.round(delta) || 0)); }

  setMaskVisible(visible) {
    this._maskVisible = !!visible;
    this._invalidate();
  }
  getMaskVisible() { return this._maskVisible; }
  hasMask() { return !!this._mask; }
  hasXz() { return !!this._xz; }

  /** 'auto' | 'nearest' | 'linear' (see the header). */
  setSampling(mode) {
    this._sampling = SAMPLING.includes(mode) ? mode : 'auto';
    this._invalidate();
  }

  zoomBy(f) {
    const L = this._layout();
    this._view = this._clampView(emZoomAbout(this._view, f, 0, 0, L.pxPerUm));
    this._changed();
  }

  setView(v = {}) {
    this._view = this._clampView({
      zoom: clamp(Number.isFinite(v.zoom) ? v.zoom : this._view.zoom, EM_ZOOM_MIN, EM_ZOOM_MAX),
      panX: Number.isFinite(v.panX) ? v.panX : this._view.panX,
      panY: Number.isFinite(v.panY) ? v.panY : this._view.panY,
    });
    this._changed();
  }
  getView() { return { ...this._view }; }

  resetView() {
    this._view = { zoom: 1, panX: 0, panY: 0 };
    this._changed();
  }

  /** cb({ plane, slice, nSlices, pxPerUm, zoom }); returns unsubscribe. Fires once with the current state. */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this._changeCbs.add(cb);
    this._emitDirty = true;
    this._forceEmit = true;
    this._invalidate();
    return () => { this._changeCbs.delete(cb); };
  }

  /** cb({ x, y }) on pointer up with < 4 px movement; returns unsubscribe. */
  onTap(cb) {
    if (typeof cb !== 'function') return () => {};
    this._tapCbs.add(cb);
    return () => { this._tapCbs.delete(cb); };
  }

  resize() { this._measure(); this._emitDirty = true; this._invalidate(); }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._loadToken++;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this._ro) this._ro.disconnect();
    for (const [el, type, fn, opts] of this._listeners) el.removeEventListener(type, fn, opts);
    this._listeners = [];
    this._changeCbs.clear();
    this._tapCbs.clear();
    this._releaseImages();
    if (this._canvas) { this._canvas.width = 0; this._canvas.height = 0; }
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
  }

  // ---- internals ----

  _on(el, type, fn, opts) { el.addEventListener(type, fn, opts); this._listeners.push([el, type, fn, opts]); }

  _setStatus(text, cls = '') {
    this._statusEl.textContent = text || '';
    this._statusEl.className = `mv-status ${cls}`.trim();
    this._statusEl.hidden = !text;
  }

  _releaseImages() {
    const h = this._held;   // shared stacks/decodes: freed by the last viewer using them
    if (h) { releaseStack(h.atlas); releaseStack(h.mask); releaseImage(h.xz); }
    this._held = null;
    this._atlas = null; this._mask = null; this._xz = null;
    this._maskTiles.clear();
    this._emTiles.clear();
    this._px = null;
  }

  _measure() {
    if (!this._root) return;
    // layout size, not getBoundingClientRect(): that one is transformed, and the full view opens with a
    // scale(0.985) entrance, which left the canvas 1.5 % small (blurred, scale bar off) until the next resize
    const r = this._root.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, this._root.clientWidth || r.width), h = Math.max(1, this._root.clientHeight || r.height);
    this._size = { w, h, dpr };
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this._canvas.width !== cw || this._canvas.height !== ch) { this._canvas.width = cw; this._canvas.height = ch; }
    this._emitDirty = true;
  }

  _imageSize() {
    if (this._plane === 'xz' && this._xz) return this._xz.width || this._tile;
    return this._tile;
  }

  _layout() {
    const { w, h } = this._size;
    return emLayout({ w, h, size: this._imageSize(), fieldUm: this._fieldUm, ...this._view, fit: this.options.fit });
  }

  _clampView(v) {
    const { w, h } = this._size;
    const L = emLayout({ w, h, size: this._imageSize(), fieldUm: this._fieldUm, ...v, fit: this.options.fit });
    return clampPan(v, L, w, h);
  }

  _changed() { this._emitDirty = true; this._invalidate(); }

  _invalidate() {
    if (this._disposed || this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  /** Expanded slice k as a 512² canvas from `cache` (LRU of `max`, canvases recycled); fill(px) writes the RGBA. */
  _cachedTile(cache, k, max, fill) {
    if (cache.has(k)) {
      const c = cache.get(k);
      cache.delete(k); cache.set(k, c);   // LRU touch
      return c.canvas;
    }
    const t = this._tile;
    let entry = null;
    if (cache.size >= max) {
      const [oldK, old] = cache.entries().next().value;
      cache.delete(oldK);
      entry = old;
    } else {
      const s = scratchCanvas(t, { read: false });
      if (!s.ctx) return null;
      entry = s;
    }
    if (!this._px || this._px.width !== t) this._px = entry.ctx.createImageData(t, t);
    fill(this._px.data);
    entry.ctx.putImageData(this._px, 0, 0);
    cache.set(k, entry);
    return entry.canvas;
  }

  /** What to draw for EM slice k: { image, sx, sy } (an expanded tile, or the decoded atlas while not unpacked). */
  _emSource(k) {
    const st = this._atlas;
    if (!st) return null;
    if (st.ensure(k)) {
      const c = this._cachedTile(this._emTiles, k, EM_TILE_CACHE, (px) => expandGrey(st.data, k * st.per, st.per, px));
      if (c) return { image: c, sx: 0, sy: 0 };
    }
    if (st.img) { const r = tileRect(k, this._tile, this._cols); return { image: st.img, sx: r.sx, sy: r.sy }; }
    return null;
  }

  _maskTile(k) {
    const st = this._mask;
    if (!st || !st.ensure(k)) return null;
    return this._cachedTile(this._maskTiles, k, MASK_CACHE, (px) => expandMaskBits(st.data, k * st.per, st.per, px));
  }

  _draw() {
    if (this._disposed) return;
    const ctx = this._ctx;
    const { w, h, dpr } = this._size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this._bg || 'rgb(23, 30, 41)';   // surface-sunken
    ctx.fillRect(0, 0, w, h);
    const L = this._layout();
    const smooth = smoothingFor(this._sampling, L.scale, dpr);
    ctx.imageSmoothingEnabled = smooth;
    if (smooth) ctx.imageSmoothingQuality = 'high';
    if (this._plane === 'xz' && this._xz) {
      const s = this._imageSize();
      ctx.drawImage(this._xz, 0, 0, s, s, L.dx, L.dy, L.dw, L.dh);
    } else if (this._plane === 'xy' && this._atlas) {
      const t = this._tile;
      const src = this._emSource(this._slice);
      if (src) ctx.drawImage(src.image, src.sx, src.sy, t, t, L.dx, L.dy, L.dw, L.dh);
      if (this._maskVisible && this._mask) {
        const m = this._maskTile(this._slice);
        if (m) ctx.drawImage(m, 0, 0, this._tile, this._tile, L.dx, L.dy, L.dw, L.dh);
      }
    }
    if (this._emitDirty) {
      this._emitDirty = false;
      const ev = { plane: this._plane, slice: this._slice, nSlices: this._nSlices, pxPerUm: L.pxPerUm, zoom: this._view.zoom };
      const last = this._lastEmit;
      const same = last && last.plane === ev.plane && last.slice === ev.slice && last.nSlices === ev.nSlices
        && Math.abs(last.pxPerUm - ev.pxPerUm) < 1e-6 && last.zoom === ev.zoom;
      if (!same || this._forceEmit) {
        this._lastEmit = ev;
        for (const cb of [...this._changeCbs]) { try { cb(ev); } catch (err) { console.error(err); } }
      }
      this._forceEmit = false;
    }
  }

  _bindInput() {
    const el = this._root;
    const local = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    this._on(el, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button > 0) return;
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
      const p = local(e);
      this._pointers.set(e.pointerId, p);
      if (this._pointers.size === 1) this._gesture = { kind: 'drag', start: p, last: p, tapOk: true };
      else if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        this._gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      }
    });
    this._on(el, 'pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      const p = local(e);
      this._pointers.set(e.pointerId, p);
      const g = this._gesture;
      if (!g) return;
      const k = this._layout().pxPerUm || 1;
      if (g.kind === 'drag' && this._pointers.size === 1) {
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) >= TAP_SLOP_PX) g.tapOk = false;
        this._view = this._clampView({ ...this._view, panX: this._view.panX + (p.x - g.last.x) / k, panY: this._view.panY - (p.y - g.last.y) / k });
        g.last = p;
        this._changed();
      } else if (g.kind === 'pinch' && this._pointers.size >= 2) {
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const { w, h } = this._size;
        let v = this._view;
        if (g.dist > 0 && dist > 0) v = emZoomAbout(v, dist / g.dist, mid.x - w / 2, h / 2 - mid.y, k);
        const k2 = emLayout({ w, h, size: this._imageSize(), fieldUm: this._fieldUm, ...v, fit: this.options.fit }).pxPerUm || 1;
        v = { ...v, panX: v.panX + (mid.x - g.mid.x) / k2, panY: v.panY - (mid.y - g.mid.y) / k2 };
        this._view = this._clampView(v);
        g.dist = dist; g.mid = mid;
        this._changed();
      }
    });
    const end = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      const p = local(e);
      this._pointers.delete(e.pointerId);
      const g = this._gesture;
      if (g && g.kind === 'drag' && e.type === 'pointerup' && g.tapOk && Math.hypot(p.x - g.start.x, p.y - g.start.y) < TAP_SLOP_PX) {
        for (const cb of [...this._tapCbs]) { try { cb({ x: p.x, y: p.y }); } catch (err) { console.error(err); } }
      }
      if (this._pointers.size === 1) { const [q] = [...this._pointers.values()]; this._gesture = { kind: 'drag', start: q, last: q, tapOk: false }; }
      else if (!this._pointers.size) this._gesture = null;
    };
    this._on(el, 'pointerup', end);
    this._on(el, 'pointercancel', end);
    this._on(el, 'lostpointercapture', end);
    this._on(el, 'wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
      const f = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 4 : 1));
      const { w, h } = this._size;
      this._view = this._clampView(emZoomAbout(this._view, f, p.x - w / 2, h / 2 - p.y, this._layout().pxPerUm));
      this._changed();
    }, { passive: false });
    this._on(el, 'keydown', (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      let handled = true;
      switch (e.key) {
        case 'ArrowUp': this.step(e.shiftKey ? -10 : -1); break;
        case 'ArrowDown': this.step(e.shiftKey ? 10 : 1); break;
        case 'PageUp': this.step(-10); break;
        case 'PageDown': this.step(10); break;
        case '+': case '=': this.zoomBy(1.25); break;
        case '-': case '_': this.zoomBy(0.8); break;
        case '0': this.resetView(); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });
  }
}

export default EmViewer;
