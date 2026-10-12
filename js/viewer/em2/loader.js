// EM format 2: asset fetching and decoding (em-v2-spec.md §8.6).
//  - Gated assets, fetched like api.js does (device header, dev clock), but read through a stream: progress for the
//    loading chips, and a 20 s no-progress watchdog (api.js's 15 s timer only covers the time to headers), so a
//    stalled body is retried once and then reported. Kept here rather than in the shared api.js (track ownership).
//  - A small memo (path → Blob, ≈ 24 MB LRU of settled entries): the prefetch on /guess and the stage share it; the
//    stage keeps its own Blobs for context-loss re-uploads.
//  - Decoding is serialised across the app: one ImageBitmap at a time (a 2560² chunk is 26 MB of RGBA), closed after
//    upload (withDecoded). A failed decode retries at half resolution (the caller then doubles that image's px).
import { config } from '../../../config.js';
import { ApiError, getDeviceId, debugNowHeader } from '../../api.js';

export const HEADER_TIMEOUT_MS = 15000;
export const STALL_MS = 20000;
export const STREAM_FROM_BYTES = 256 * 1024;
export const MEMO_BUDGET_BYTES = 24 * 1024 * 1024;
const T = { header: HEADER_TIMEOUT_MS, stall: STALL_MS, streamFrom: STREAM_FROM_BYTES };
/** Tests: shorter timers ({ header, stall, streamFrom }); returns the previous ones. */
export function setLoaderTimings(t = {}) { const prev = { ...T }; Object.assign(T, t); return prev; }

const memo = new Map();   // path → { promise, settled, bytes, loaded, total, listeners: Set }
let memoBytes = 0;
let customSource = null;  // (path, { onProgress, priority }) → Promise<Blob>   (dev page, tests)

/** Serve EM assets from elsewhere (the dev page's local bundle, tests). null restores the Worker. Clears the memo. */
export function setEmAssetSource(fn) {
  customSource = typeof fn === 'function' ? fn : null;
  memo.clear();
  memoBytes = 0;
}

function trim(keep) {
  if (memoBytes <= MEMO_BUDGET_BYTES) return;
  for (const [k, e] of memo) {
    if (memoBytes <= MEMO_BUDGET_BYTES) break;
    if (!e.settled || k === keep) continue;
    memo.delete(k);
    memoBytes -= e.bytes;
  }
}

/**
 * The asset as a Blob (memoised). onProgress(loaded, total) while it streams (also for a load already in flight).
 * expectBytes: `bytes` from the em object (Content-Length may be absent: compressed JSON).
 */
export function emBlob(path, { priority, onProgress, expectBytes = 0 } = {}) {
  let e = memo.get(path);
  if (e) {
    memo.delete(path); memo.set(path, e);  // LRU touch
    if (onProgress) {
      if (e.settled) onProgress(e.bytes, e.bytes);
      else { e.listeners.add(onProgress); if (e.loaded) onProgress(e.loaded, e.total); }
    }
    return e.promise;
  }
  e = { promise: null, settled: false, bytes: 0, loaded: 0, total: expectBytes, listeners: new Set(onProgress ? [onProgress] : []) };
  const progress = (loaded, total) => {
    e.loaded = loaded; e.total = total || e.total;
    for (const fn of e.listeners) { try { fn(loaded, e.total); } catch (_) { /* ignore */ } }
  };
  e.promise = (customSource ? customSource(path, { onProgress: progress, priority }) : fetchBlob(path, { priority, onProgress: progress, expectBytes }))
    .then((blob) => {
      if (memo.get(path) === e) {
        e.settled = true;
        e.bytes = blob.size;
        memoBytes += blob.size;
        trim(path);
      }
      progress(blob.size, blob.size);
      e.listeners.clear();
      return blob;
    }, (err) => { if (memo.get(path) === e) memo.delete(path); e.listeners.clear(); throw err; });
  memo.set(path, e);
  return e.promise;
}

/** Parsed JSON (outlines). */
export async function emJSON(path, opts) {
  const blob = await emBlob(path, opts);
  return JSON.parse(await blob.text());
}

/** Warm the memo (never rejects): the round screen calls it on the /guess response that carries `em`. */
export function prefetchEmAssets(paths, priority = 'auto') {
  return Promise.all(paths.map((p) => emBlob(p, { priority }).then(() => true, () => false)));
}

/** Memo stats (dev page, tests). */
export function emMemoStats() {
  let pending = 0;
  for (const e of memo.values()) if (!e.settled) pending++;
  return { entries: memo.size, bytes: memoBytes, pending };
}

async function fetchBlob(path, { priority, onProgress, expectBytes }) {
  const url = config.apiBase + path;
  const headers = { 'X-NG-Device': await getDeviceId() };
  if (config.isLocal && config.debugNow) headers['X-NG-Debug-Now'] = debugNowHeader();
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t0 = ctrl ? setTimeout(() => ctrl.abort(), T.header) : null;
    let res;
    try {
      const init = { headers, mode: 'cors', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined };
      if (priority) init.priority = priority;
      res = await fetch(url, init);
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      lastErr = new ApiError(0, aborted ? 'timeout' : 'network', aborted ? 'The server took too long to answer.' : 'Could not reach the NeuroGuesser server.');
      if (aborted && attempt === 0) continue;
      throw lastErr;
    } finally {
      if (t0) clearTimeout(t0);
    }
    if (!res.ok) throw new ApiError(res.status, 'http', `HTTP ${res.status}`);
    const total = Number(res.headers.get('Content-Length')) || expectBytes || 0;
    if (!res.body || typeof res.body.getReader !== 'function' || !ctrl || total < T.streamFrom) {
      const blob = await res.blob();
      if (onProgress) onProgress(blob.size, blob.size);
      return blob;
    }
    const blob = await readWithWatchdog(res, ctrl, total, onProgress);
    if (blob) return blob;
    lastErr = new ApiError(0, 'timeout', 'The EM download stalled.');   // stalled: retry once
  }
  throw lastErr || new ApiError(0, 'timeout', 'The EM download stalled.');
}

/** Read a body; abort when no byte arrives for STALL_MS → null (stalled). */
async function readWithWatchdog(res, ctrl, total, onProgress) {
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  let stalled = false;
  let dog = null;
  const arm = () => {
    if (dog) clearTimeout(dog);
    dog = setTimeout(() => { stalled = true; try { ctrl.abort(); } catch (_) { /* */ } try { reader.cancel(); } catch (_) { /* */ } }, T.stall);
  };
  arm();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.byteLength;
      arm();
      if (onProgress) onProgress(got, Math.max(total, got));
    }
  } catch (err) {
    if (stalled) return null;
    throw new ApiError(0, 'network', 'The EM download was interrupted.');
  } finally {
    if (dog) clearTimeout(dog);
  }
  if (stalled) return null;
  return new Blob(parts, { type: res.headers.get('Content-Type') || '' });
}

// ------------------------------------------------------------------------------------------------------- decoding

let chain = Promise.resolve();

/**
 * Decode `blob` (serialised: one bitmap alive at a time across the app), hand it to fn(bitmap, { scale }) (the
 * upload), then close it. A failed decode (out of memory, reject) retries at half resolution (scale 0.5).
 * size: [w, h] of the image (from the em object) for the half-resolution retry.
 */
export function withDecoded(blob, size, fn) {
  const run = async () => {
    let bmp = null;
    let scale = 1;
    try {
      bmp = await decode(blob, null);
    } catch (err) {
      if (!size) throw err;
      scale = 0.5;
      bmp = await decode(blob, [Math.max(1, Math.ceil(size[0] / 2)), Math.max(1, Math.ceil(size[1] / 2))]);
    }
    try {
      return await fn(bmp, { scale });
    } finally {
      try { if (bmp && typeof bmp.close === 'function') bmp.close(); } catch (_) { /* */ }
    }
  };
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

async function decode(blob, half) {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap is unavailable');
  const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  if (half) Object.assign(opts, { resizeWidth: half[0], resizeHeight: half[1], resizeQuality: 'medium' });
  try {
    return await createImageBitmap(blob, opts);
  } catch (err) {
    if (half) throw err;
    if (err && err.name === 'TypeError') return createImageBitmap(blob);   // an engine without the options bag
    throw err;
  }
}

/**
 * Path B (the R8 upload feature test failed): the bitmap's red channel through a 2D canvas → { data: Uint8Array,
 * width, height } for an R8 DataTexture. The canvas is released at once.
 */
export function bitmapToGrey(bmp) {
  const w = bmp.width;
  const h = bmp.height;
  let canvas = null;
  let ctx = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    try { canvas = new OffscreenCanvas(w, h); ctx = canvas.getContext('2d', { willReadFrequently: true }); } catch (_) { ctx = null; }
  }
  if (!ctx && typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) throw new Error('No 2D canvas for the grey fallback.');
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = rgba[i];
  canvas.width = 0; canvas.height = 0;
  return { data: out, width: w, height: h };
}

/** A 4 × 4 lossless greyscale WebP (values 0, 17, 34 … 255 row by row) for the R8 upload feature test. */
export const TEST_WEBP_B64 = 'UklGRiQAAABXRUJQVlA4TBgAAAAvA8AAAM1lRP8DBNk2U6jT/bHOEBERdgE=';
export const TEST_GREYS = Object.freeze(Array.from({ length: 16 }, (_, i) => i * 17));
export function testWebpBlob() {
  const bin = typeof atob === 'function' ? atob(TEST_WEBP_B64) : Buffer.from(TEST_WEBP_B64, 'base64').toString('binary');
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: 'image/webp' });
}
