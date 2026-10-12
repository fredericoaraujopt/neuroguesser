// Worker API client (contracts/api.md v1.1; ARCHITECTURE.md §4.2).
// Every function returns parsed JSON and throws ApiError on non-2xx. Network failures and timeouts throw
// ApiError with status 0 (code 'network' | 'timeout'). 409 bodies from round actions carry `state`.
import { config } from '../config.js';
import * as idb from './idb.js';

export class ApiError extends Error {
  constructor(status, code, message, state = null, body = null) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;   // HTTP status, or 0 for network/timeout/offline
    this.code = code;       // contract error code ('day_closed', 'already_guessed', …) or 'network' | 'timeout' | 'offline' | 'http'
    this.state = state;     // round_state from a 409 body, else null
    this.body = body;
  }
  /** True for transport failures only (not the client-side 'busy' / 'bad_asset' errors). */
  get isNetwork() { return this.status === 0 && (this.code === 'network' || this.code === 'timeout' || this.code === 'offline'); }
}

/** Marks a /v1/day response that the service worker served from its cache (X-From-Cache: 1). */
export const FROM_CACHE = Symbol('fromCache');

const TIMEOUT_MS = 15000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_RE = /^\/v1\/asset\/[a-f0-9]{64}\.(glb|webp|png|json|bin)$/;

let deviceIdPromise = null;
const listeners = new Set();

function uuid4() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The device credential: created once (uuid v4) and kept in IndexedDB. Never displayed or logged. */
export function getDeviceId() {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      const stored = await idb.get('deviceId');
      if (typeof stored === 'string' && UUID_V4.test(stored)) return stored;
      const id = uuid4();
      await idb.set('deviceId', id);
      return id;
    })();
  }
  return deviceIdPromise;
}

// Dev clock (?now=, localhost only; config.js): it starts at the given instant when the page loads and then
// advances in real time, so countdowns, rollover and grace play out. The Worker's rate-limit windows follow
// the request clock, so a frozen value would put every POST in one 1-second window (429 after the second).
const DEBUG_EPOCH = Date.now();
/** X-NG-Debug-Now value for a request sent at `nowMs` (null when no ?now= override is active). */
export function debugNowHeader(debugNow = config.debugNow, nowMs = Date.now()) {
  const base = debugNow ? Date.parse(debugNow) : NaN;
  return Number.isNaN(base) ? null : new Date(base + (nowMs - DEBUG_EPOCH)).toISOString();
}

/** Subscribe to request outcomes: fn({ ok: boolean, network: boolean }). Used for the online indicator. */
export function onRequestOutcome(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function emit(ok, network) { for (const fn of listeners) { try { fn({ ok, network }); } catch (_) { /* ignore */ } } }

async function request(method, path, { body, query, device = true, raw = false, priority } = {}) {
  let url = config.apiBase + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers = {};
  if (device) headers['X-NG-Device'] = await getDeviceId();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (config.isLocal && config.debugNow) headers['X-NG-Debug-Now'] = debugNowHeader();

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  let res;
  const init = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: ctrl ? ctrl.signal : undefined,
    credentials: 'omit',
    mode: 'cors',
  };
  if (priority) init.priority = priority;   // Priority Hints ('low' for prefetches); unknown members are ignored
  try {
    res = await fetch(url, init);
  } catch (err) {
    emit(false, true);
    const aborted = err && err.name === 'AbortError';
    throw new ApiError(0, aborted ? 'timeout' : 'network', aborted ? 'The server took too long to answer.' : 'Could not reach the NeuroGuesser server.');
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Only a live API answer proves we are online: a /v1/day the service worker served from its cache (network
  // failed) does not, nor does an asset (raw), which the service worker serves cache-first.
  if (!raw && res.headers.get('X-From-Cache') !== '1') emit(true, false);

  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.json(); } catch (_) { /* non-JSON error */ }
    const e = parsed && parsed.error ? parsed.error : {};
    throw new ApiError(res.status, e.code || 'http', e.message || `HTTP ${res.status}`, parsed && parsed.state ? parsed.state : null, parsed);
  }
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {
    throw new ApiError(res.status, 'bad_response', 'The server sent an unreadable response.');
  }
  if (json && typeof json === 'object' && res.headers.get('X-From-Cache') === '1') {
    Object.defineProperty(json, FROM_CACHE, { value: true, enumerable: false });
  }
  return json;
}

const enc = encodeURIComponent;
const post = (path, body) => request('POST', path, { body: body === undefined ? undefined : body });
const get = (path, query) => request('GET', path, { query });

// ---- health and clock ----
export const getHealth = () => request('GET', '/v1/health', { device: false });
export const getToday = () => get('/v1/today');

// ---- content ----
export const getDay = (date) => get(`/v1/day/${enc(date)}`);
export const getProgress = (date) => get(`/v1/day/${enc(date)}/progress`);

// ---- round actions ----
export const openClue = (roundId, kind) => post(`/v1/round/${enc(roundId)}/clue`, { kind });
export const guess = (roundId, option) => post(`/v1/round/${enc(roundId)}/guess`, { option });
/** method: a method_id from round_public.method_options, or null to skip ({"method": null} ≠ {}). */
export const chooseMethod = (roundId, method) => post(`/v1/round/${enc(roundId)}/method`, { method: method ?? null });
export const getReveal = (roundId) => get(`/v1/round/${enc(roundId)}/reveal`);
/** body: { round_id, reason_code: 'wrong_label'|'bad_mesh'|'em_problem'|'fact_wrong'|'other', note? } */
export const report = (body) => post('/v1/report', body);

// ---- identity and groups ----
export const getMe = () => get('/v1/me');
/** body: { display_name?, affiliation? (null clears) } */
export const updateMe = (body) => post('/v1/me', body);
export const createTransferCode = () => post('/v1/me/transfer-code');
export const claimTransferCode = (code, { discard = false } = {}) =>
  post('/v1/me/claim', discard ? { code, discard: true } : { code });
/** body: { name, kind: 'lab' | 'friends' } */
export const createGroup = (body) => post('/v1/groups', body);
export const joinGroup = (code) => post('/v1/groups/join', { join_code: code });
export const leaveGroup = (groupId) => post(`/v1/groups/${enc(groupId)}/leave`);

// ---- library and review ----
export const getLibrary = ({ before, limit } = {}) => get('/v1/library', { before, limit });
export const getReviewQueue = () => get('/v1/review/queue');
export const submitReview = ({ round_id, option }) => post('/v1/review', { round_id, option });

// ---- ranks and stats ----
/** params: { scope: 'friends'|'lab'|'global', group_id?, period: 'day'|'week'|'all', date? } */
export const getRanks = (params = {}) => get('/v1/ranks', params);
/** params: { scope, group_id? } */
export const getDayStats = (date, params = {}) => get(`/v1/stats/day/${enc(date)}`, params);

// ---- product feedback (prototype loop; api.md "Product feedback"; js/feedback.js) ----
/** body: { text, category: 'ui'|'ux'|'data'|'bug'|'idea'|'other', screen, context, screenshot? (data URL) } */
export const sendFeedback = (body) => post('/v1/feedback', body);
export const getMyFeedback = () => get('/v1/feedback/mine');

// ---- assets (content-addressed, gated: always sent with the device header; memoised by path) ----
// The memo dedupes concurrent loads and keeps one object per path, so viewers share it (the EM viewer shares one
// decode per Blob). It is an LRU bounded by bytes: once the settled ArrayBuffers, Blobs and JSON exceed
// ASSET_MEMO_BUDGET, the least recently used are dropped (a later call fetches again, which the service worker or the
// HTTP cache answer: assets are immutable). A day's assets are ≈ 18 MB, so without the bound a session kept every
// day it saw. Pending loads are never dropped, nor is the entry that just settled. Object URLs are never revoked:
// callers keep them (Library thumbnails); they are counted apart and stay outside the budget.
export const ASSET_MEMO_BUDGET = 12 * 1024 * 1024;
let memoBudget = ASSET_MEMO_BUDGET;
const memo = new Map();   // `${kind}:${path}` → { kind, path, promise, settled, bytes }  (Map order = least recent first)
let memoBytes = 0;        // settled, evictable entries (buffer | blob | json)
let pinnedBytes = 0;      // object URLs (Blobs held by the URL registry)

function assertAsset(path) {
  if (typeof path !== 'string' || !ASSET_RE.test(path)) throw new ApiError(400, 'bad_asset', `Not an asset path: ${path}`);
}

function trimMemo(keepKey = null) {
  if (memoBytes <= memoBudget) return;
  for (const [key, e] of memo) {
    if (memoBytes <= memoBudget) break;
    if (!e.settled || e.kind === 'url' || key === keepKey) continue;
    memo.delete(key);
    memoBytes -= e.bytes;
  }
}

/** make() → Promise<{ value, bytes }>. A failure is not memoised (a 404 before the gate opens is retried later). */
function memoise(kind, path, make) {
  // async contract: a bad path rejects (never a synchronous throw that would skip the caller's .catch)
  try { assertAsset(path); } catch (err) { return Promise.reject(err); }
  const key = `${kind}:${path}`;
  const hit = memo.get(key);
  if (hit) { memo.delete(key); memo.set(key, hit); return hit.promise; }   // most recently used → end
  const e = { kind, path, promise: null, settled: false, bytes: 0 };
  e.promise = make().then(({ value, bytes }) => {
    if (memo.get(key) === e) {
      e.settled = true;
      e.bytes = bytes || 0;
      if (kind === 'url') pinnedBytes += e.bytes;
      else { memoBytes += e.bytes; trimMemo(key); }
    }
    return value;
  }, (err) => { if (memo.get(key) === e) memo.delete(key); throw err; });
  memo.set(key, e);
  return e.promise;
}

/** Asset GET. priority 'low' (fetch Priority Hints, ignored where unsupported) for prefetches. */
const fetchAsset = (path, priority) => request('GET', path, { raw: true, priority });

const loadBuffer = (path, priority) => fetchAsset(path, priority).then((r) => r.arrayBuffer()).then((b) => ({ value: b, bytes: b.byteLength }));
const loadBlob = (path, priority) => fetchAsset(path, priority).then((r) => r.blob()).then((b) => ({ value: b, bytes: b.size }));
const loadJSON = (path, priority) => fetchAsset(path, priority).then((r) => r.text()).then((t) => ({ value: JSON.parse(t), bytes: t.length * 2 }));

export const assetArrayBuffer = (path) => memoise('buffer', path, () => loadBuffer(path));
export const assetBlob = (path) => memoise('blob', path, () => loadBlob(path));
export const assetJSON = (path) => memoise('json', path, () => loadJSON(path));
/** Object URL for <img src>; lives for the session (memoised, never revoked: callers keep them). */
export const assetObjectURL = (path) => memoise('url', path, () => assetBlob(path).then((b) => ({ value: URL.createObjectURL(b), bytes: b.size })));

const PREFETCH = { buffer: loadBuffer, blob: loadBlob, json: loadJSON };
/**
 * Warm the memo for a later assetArrayBuffer / assetBlob / assetJSON(path) at low network priority, so it never
 * competes with what is on screen. Never rejects (a locked or offline asset is simply fetched again when needed).
 */
export function prefetchAsset(path, kind = 'buffer') {
  const load = PREFETCH[kind];
  if (!load) return Promise.resolve(false);
  return memoise(kind, path, () => load(path, 'low')).then(() => true, () => false);
}

/** Memo size for dev pages and tests: { entries, bytes, budget, pinnedBytes, pending, byKind }. */
export function assetMemoStats() {
  const byKind = {};
  let pending = 0;
  for (const e of memo.values()) {
    const k = byKind[e.kind] || (byKind[e.kind] = { n: 0, bytes: 0 });
    k.n++; k.bytes += e.bytes;
    if (!e.settled) pending++;
  }
  return { entries: memo.size, bytes: memoBytes, budget: memoBudget, pinnedBytes, pending, byKind };
}

/** Change the memo budget (bytes; tests and low-memory experiments); trims at once. Returns the previous one. */
export function setAssetMemoBudget(bytes) {
  const prev = memoBudget;
  memoBudget = Number.isFinite(bytes) && bytes >= 0 ? bytes : ASSET_MEMO_BUDGET;
  trimMemo();
  return prev;
}
