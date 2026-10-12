// QA perf (real season: ≈ 18 MB of assets a day, 2.6 MB EM atlases decoding to 32 MB RGBA): the bounded asset memo
// and low-priority prefetch (api.js), the early first-mesh fetch (game.js), the service worker streaming assets
// while it stores them and capping its asset cache by bytes (sw.js), and the EM viewer's packed slices
// (em-viewer.js) that let the decoded 4096 × 2048 bitmaps be closed.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { roundPublic, roundState } from './fixtures.js';

const api = await import('../js/api.js');
const game = await import('../js/game.js');
const em = await import('../js/viewer/em-viewer.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const asset = (c, ext = 'glb') => `/v1/asset/${c.repeat(64)}.${ext}`;

// ------------------------------------------------------------------------------------------------ api.js memo

const calls = [];
let respond = () => new Response(new Uint8Array(10), { status: 200 });
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return respond(String(url), init); };

test('asset memo: LRU bounded by bytes; recently used, pending and just-settled entries stay', async () => {
  const prev = api.setAssetMemoBudget(250);
  try {
    respond = () => new Response(new Uint8Array(100), { status: 200 });
    const [a, b, c] = [asset('1'), asset('2'), asset('3')];
    const bufA = await api.assetArrayBuffer(a);
    await api.assetArrayBuffer(b);
    assert.equal(api.assetMemoStats().bytes, 200);
    assert.equal(await api.assetArrayBuffer(a), bufA, 'a hit returns the same object (and touches it)');
    await api.assetArrayBuffer(c);                     // 300 > 250: the least recently used (b) goes
    const s = api.assetMemoStats();
    assert.equal(s.bytes, 200);
    assert.equal(s.byKind.buffer.n, 2);
    const n = calls.length;
    assert.equal(await api.assetArrayBuffer(a), bufA, 'a was used recently: kept');
    assert.equal(calls.length, n);
    await api.assetArrayBuffer(b);
    assert.equal(calls.length, n + 1, 'b was dropped: fetched again (the HTTP/SW cache answers in the app)');

    // a smaller budget trims at once
    api.setAssetMemoBudget(50);
    assert.equal(api.assetMemoStats().bytes, 0, 'every settled entry over the budget dropped');
    // a pending load is never dropped
    let release;
    respond = () => new Promise((r) => { release = () => r(new Response(new Uint8Array(100), { status: 200 })); });
    const pending = api.assetArrayBuffer(asset('4'));
    await tick();
    respond = () => new Response(new Uint8Array(100), { status: 200 });
    await api.assetArrayBuffer(asset('5'));
    assert.equal(api.assetMemoStats().pending, 1);
    release();
    assert.equal((await pending).byteLength, 100);
  } finally {
    api.setAssetMemoBudget(prev);
  }
});

test('asset memo: Blob and JSON sizes are counted; object URLs are pinned (never revoked, outside the budget)', async () => {
  respond = (url) => (url.endsWith('.json')
    ? new Response(JSON.stringify({ k: 'v' }), { status: 200 })
    : new Response(new Uint8Array(40), { status: 200 }));
  const before = api.assetMemoStats();
  await api.assetBlob(asset('6', 'webp'));
  await api.assetJSON(asset('7', 'json'));
  const after = api.assetMemoStats();
  assert.equal(after.bytes - before.bytes, 40 + JSON.stringify({ k: 'v' }).length * 2);
  if (typeof URL.createObjectURL === 'function') {
    const revoked = [];
    const orig = URL.revokeObjectURL;
    URL.revokeObjectURL = (u) => { revoked.push(u); };
    const prev = api.setAssetMemoBudget(0);
    try {
      const url = await api.assetObjectURL(asset('8', 'webp'));
      assert.match(url, /^blob:/);
      api.setAssetMemoBudget(0);
      assert.equal(await api.assetObjectURL(asset('8', 'webp')), url, 'same URL for the session');
      assert.equal(api.assetMemoStats().pinnedBytes, 40);
      assert.deepEqual(revoked, []);
    } finally {
      URL.revokeObjectURL = orig;
      api.setAssetMemoBudget(prev);
    }
  }
});

test('prefetchAsset: low fetch priority, memoised for the later real call, never rejects', async () => {
  respond = () => new Response(new Uint8Array(3), { status: 200 });
  const P = asset('9');
  assert.equal(await api.prefetchAsset(P, 'buffer'), true);
  const c = calls[calls.length - 1];
  assert.equal(c.init.priority, 'low');
  assert.ok(c.init.headers['X-NG-Device'], 'gated: device header');
  const n = calls.length;
  assert.equal((await api.assetArrayBuffer(P)).byteLength, 3);
  assert.equal(calls.length, n, 'the viewer call reuses the prefetch');
  respond = () => new Response('{"error":{"code":"not_found"}}', { status: 404 });
  assert.equal(await api.prefetchAsset(asset('a'), 'buffer'), false, 'a locked asset resolves false');
  assert.equal(await api.prefetchAsset('/v1/today', 'buffer'), false, 'not an asset path → false');
  assert.equal(await api.prefetchAsset(asset('b'), 'nope'), false);
  respond = () => new Response(new Uint8Array(1), { status: 200 });
  await api.assetArrayBuffer(asset('c'));
  assert.equal(calls[calls.length - 1].init.priority, undefined, 'foreground loads keep the default priority');
});

// ------------------------------------------------------------------------------------------------ game.js

test('firstMeshAsset: the mesh Today draws first (current round, or the round whose reveal is due)', () => {
  const rounds = [1, 2, 3, 4, 5].map((i) => roundPublic(i));
  const done = (i) => roundState({ round_index: i, stage: 'done', score: 1000 });
  const base = { rounds, progress: [null, null, null, null, null], revealAck: [false, false, false, false, false] };
  assert.equal(game.firstMeshAsset(base), rounds[0].mesh.asset);
  assert.equal(game.firstMeshAsset({ ...base, progress: [done(1), null, null, null, null], revealAck: [true, false, false, false, false] }), rounds[1].mesh.asset);
  assert.equal(game.firstMeshAsset({ ...base, progress: [done(1), done(2), null, null, null], revealAck: [true, false, false, false, false] }), rounds[1].mesh.asset, 'reveal 2 shows round 2\'s cell');
  assert.equal(game.firstMeshAsset({ ...base, progress: rounds.map((r, i) => done(i + 1)), revealAck: [true, true, true, true, true] }), null, 'summary');
  assert.equal(game.firstMeshAsset({ rounds: [], progress: [], revealAck: [] }), null, 'no rounds');
});

test('warmViewer and prefetchRound are browser-only no-ops under node', async () => {
  assert.equal(await game.warmViewer(), false);
  assert.equal(await game.prefetchRound(2), false);
});

// ------------------------------------------------------------------------------------------------ sw.js

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_SRC = readFileSync(path.join(root, 'sw.js'), 'utf8');
const SCOPE = 'https://app.example/neuroguesser/';
const API = 'https://api.example';

function loadSW(net, { slowPut = false } = {}) {
  const listeners = {};
  const stores = new Map();
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    const key = (r) => (typeof r === 'string' ? new URL(r, SCOPE).href : r.url);
    return {
      async put(r, res) { if (slowPut) await res.arrayBuffer(); m.delete(key(r)); m.set(key(r), res); },
      async match(r) { const h = m.get(key(r)); return h ? h.clone() : undefined; },
      async keys() { return [...m.keys()].map((url) => ({ url })); },
      async delete(r) { return m.delete(key(r)); },
    };
  };
  const caches = { open: async (n) => open(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) };
  const self = { location: new URL(`${SCOPE}sw.js`), addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  vm.runInNewContext(SW_SRC, { self, caches, fetch: async (req) => net(req.url || String(req)), Request, Response, Headers, URL, console, setTimeout, Promise });
  return {
    stores,
    async fetch(url) {
      let responded = null;
      const waits = [];
      listeners.fetch({ request: { url, method: 'GET', mode: 'cors' }, respondWith(p) { responded = Promise.resolve(p); }, waitUntil(p) { waits.push(p); } });
      return { res: await responded, settled: Promise.all(waits) };
    },
  };
}

test('sw: an asset streams to the page while it is stored (no wait for the whole body), then it is cached', async () => {
  let push;
  const body = new ReadableStream({ start(c) { push = c; } });
  const sw = loadSW(() => new Response(body, { status: 200, headers: { 'Content-Length': '6' } }), { slowPut: true });
  const url = `${API}${asset('d', 'webp')}`;
  const { res, settled } = await Promise.race([sw.fetch(url), tick(500).then(() => ({ res: null }))]);
  assert.ok(res, 'the response reached the page before its body finished');
  assert.equal(res.status, 200);
  push.enqueue(new Uint8Array([1, 2, 3])); push.enqueue(new Uint8Array([4, 5, 6])); push.close();
  assert.equal((await res.arrayBuffer()).byteLength, 6);
  await settled;
  assert.equal(sw.stores.get('ng-asset-v1').size, 1, 'stored once the body arrived (event.waitUntil)');
});

test('sw: the asset cache is capped by bytes (160 MB: ≈ 5 days of EM format 2), oldest first, never the asset just stored', async () => {
  const MB = 1024 * 1024;
  const sizes = { 1: 75, 2: 75, 3: 75, 4: 170 };
  const sw = loadSW((url) => {
    const n = Number(url.match(/\/(\d)\d{63}\./)[1]);
    return new Response(new Uint8Array(4), { status: 200, headers: { 'Content-Length': String(sizes[n] * MB) } });
  });
  const u = (n) => `${API}/v1/asset/${String(n).repeat(64)}.webp`;
  for (const n of [1, 2]) await (await sw.fetch(u(n))).settled;
  assert.equal(sw.stores.get('ng-asset-v1').size, 2, '150 MB: under the cap');
  await (await sw.fetch(u(3))).settled;
  assert.deepEqual([...sw.stores.get('ng-asset-v1').keys()].map((k) => k.slice(-6)), [u(2), u(3)].map((k) => k.slice(-6)), '225 MB → oldest dropped');
  await (await sw.fetch(u(4))).settled;
  assert.deepEqual([...sw.stores.get('ng-asset-v1').keys()].map((k) => k.slice(-6)), [u(4).slice(-6)], 'a 170 MB asset alone is kept');
});

// ------------------------------------------------------------------------------------------------ em-viewer.js

const rgbaOf = (values, g = (v) => v, b = (v) => v) => {
  const out = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => { out[i * 4] = v; out[i * 4 + 1] = g(v); out[i * 4 + 2] = b(v); out[i * 4 + 3] = 255; });
  return out;
};

test('packGrey/expandGrey: true-greyscale EM round-trips exactly; the deviation tells grey from colour', () => {
  const vals = [0, 1, 17, 128, 254, 255, 99, 3];
  const grey = new Uint8Array(16);
  assert.equal(em.packGrey(rgbaOf(vals), grey, 8), 0);
  assert.deepEqual([...grey.slice(8)], vals);
  assert.deepEqual([...em.expandGrey(grey, 8, vals.length, new Uint8ClampedArray(32))], [...rgbaOf(vals)]);
  // libwebp's grey: R = B, G off by one on some pixels → still grey (R kept)
  assert.equal(em.packGrey(rgbaOf(vals, (v) => Math.max(0, v - 1)), grey, 0), 1);
  assert.ok(em.packGrey(rgbaOf(vals, (v) => v, () => 0), grey, 0) > em.GREY_TOLERANCE, 'colour');
});

test('packMaskBits/expandMaskBits: 1 bit per pixel, drawn exactly as colouriseMask', () => {
  const vals = [255, 0, 127, 128, 255, 255, 0, 0, 200, 1, 255];   // 11 pixels: crosses a byte
  const src = rgbaOf(vals);
  const bits = new Uint8Array(4);
  assert.equal(em.packMaskBits(src, bits, 8), 6);
  const a = new Uint8ClampedArray(src.length);
  assert.equal(em.expandMaskBits(bits, 8, vals.length, a), 6);
  const b = new Uint8ClampedArray(src.length);
  em.colouriseMask(src, b);
  assert.deepEqual([...a], [...b]);
});

function fakeStackImage(tile, n, pixel) {
  // readTile(img, k) → a tile whose pixels are pixel(k, i) (RGBA)
  let closed = 0;
  const img = { closed: () => closed, close() { closed++; } };
  const reads = [];
  const readTile = (_img, k) => {
    reads.push(k);
    const out = new Uint8ClampedArray(tile * tile * 4);
    for (let i = 0; i < tile * tile; i++) { const [r, g, b] = pixel(k, i); out.set([r, g, b, 255], i * 4); }
    return out;
  };
  return { img, readTile, reads };
}

test('TileStack (EM): the slice on screen unpacks at once, the rest in the background, then the image is released', async () => {
  const f = fakeStackImage(4, 6, (k, i) => [k * 10 + i, k * 10 + i, k * 10 + i]);
  let released = 0;
  const st = new em.TileStack(f.img, { kind: 'em', tile: 4, cols: 3, n: 6, readTile: f.readTile, onRelease: () => { released++; } });
  assert.equal(st.data.length, 6 * 16, '1 byte per pixel');
  assert.equal(st.ensure(3), true);
  assert.deepEqual([...st.data.slice(3 * 16, 3 * 16 + 4)], [30, 31, 32, 33]);
  assert.equal(st.ensure(3), true);
  assert.deepEqual(f.reads, [3], 'read once');
  st.unpackAll(3);
  for (let i = 0; i < 50 && st.img; i++) await tick(20);
  assert.equal(st.img, null);
  assert.equal(released, 1);
  assert.deepEqual(f.reads.slice(1, 4), [2, 4, 1], 'nearest slices first');
  assert.equal(st.ensure(5), true, 'packed tiles stay drawable without the image');
  assert.equal(st.ensure(6), false, 'out of range');
});

test('TileStack (EM): a non-grey atlas is never packed and keeps its image until dispose', async () => {
  const f = fakeStackImage(2, 4, () => [200, 10, 10]);
  let released = 0;
  const st = new em.TileStack(f.img, { kind: 'em', tile: 2, cols: 2, n: 4, readTile: f.readTile, onRelease: () => { released++; } });
  assert.equal(st.ensure(1), false);
  assert.equal(st.exact, false);
  st.unpackAll(1);
  await tick(80);
  assert.ok(st.img, 'image kept: the viewer draws from it');
  assert.equal(released, 0);
  st.dispose();
  assert.equal(released, 1);
  assert.equal(st.ensure(1), false);
});

test('TileStack (mask) + acquireStack/releaseStack: shared per Blob, 1 bit per pixel, released by the last viewer', async () => {
  let decodes = 0;
  let closed = 0;
  const decoder = async () => { decodes++; return { width: 8, close() { closed++; } }; };
  const blob = { size: 1 };
  const layout = { tile: 4, cols: 2, n: 4 };
  const a = await em.acquireStack(blob, 'mask', layout, decoder);
  const b = await em.acquireStack(blob, 'mask', layout, decoder);
  assert.equal(a, b);
  assert.equal(decodes, 1);
  assert.equal(a.data.length, 4 * 16 / 8, '1 bit per pixel');
  em.releaseStack(blob);
  await tick();
  assert.equal(closed, 0, 'still used');
  em.releaseStack(blob);
  await tick();
  assert.equal(closed, 1, 'the last release closes the decoded image');
  assert.equal(a.data, null);
  assert.equal(await em.acquireStack(null, 'em'), null);
});
