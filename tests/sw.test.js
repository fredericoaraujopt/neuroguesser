// sw.js behaviour (not just its source text): the worker runs in a vm with fake caches/fetch, and each
// test dispatches install / activate / fetch events. ARCHITECTURE.md §3 "Offline" and §1.1 sw.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(root, 'sw.js'), 'utf8');
const ORIGIN = 'https://app.example';
const SCOPE = `${ORIGIN}/neuroguesser/`;
const API = 'https://api.example';
const SHA = 'a'.repeat(64);

function fakeCaches() {
  const stores = new Map();
  const keyOf = (req) => (typeof req === 'string' ? new URL(req, SCOPE).href : req.url);
  const cacheFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async put(req, res) { m.set(keyOf(req), res); },
      async match(req, opts = {}) {
        let k = keyOf(req);
        let hit = m.get(k);
        if (!hit && opts.ignoreSearch) {
          k = k.split('?')[0];
          for (const [key, v] of m) if (key.split('?')[0] === k) { hit = v; break; }
        }
        return hit ? hit.clone() : undefined;
      },
      async keys() { return [...m.keys()].map((url) => ({ url })); },
      async delete(req) { return m.delete(keyOf(req)); },
    };
  };
  return {
    stores,
    api: {
      async open(name) { return cacheFor(name); },
      async keys() { return [...stores.keys()]; },
      async delete(name) { return stores.delete(name); },
    },
  };
}

function loadSW({ net } = {}) {
  const listeners = {};
  const caches = fakeCaches();
  const fetched = [];
  const self = {
    location: new URL(`${SCOPE}sw.js`),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => { self.skipped = true; },
    clients: { claim: async () => { self.claimed = true; } },
  };
  const fetchImpl = async (req) => {
    const url = typeof req === 'string' ? new URL(req, SCOPE).href : req.url;
    fetched.push({ url, cache: req.cache, method: req.method || 'GET' });
    return net(url, req);
  };
  // a worker resolves relative Request URLs against its own location
  class WorkerRequest extends Request {
    constructor(input, init) { super(typeof input === 'string' ? new URL(input, SCOPE).href : input, init); }
  }
  vm.runInNewContext(SRC, { self, caches: caches.api, fetch: fetchImpl, Request: WorkerRequest, Response, Headers, URL, console, setTimeout, Promise });
  async function dispatchFetch(request) {
    let responded = null;
    listeners.fetch({ request, respondWith(p) { responded = Promise.resolve(p); } });
    return responded; // null: not handled → the browser goes to the network itself
  }
  async function dispatch(type) {
    let wait = Promise.resolve();
    listeners[type]({ waitUntil(p) { wait = p; } });
    await wait;
  }
  return { self, listeners, caches, fetched, dispatchFetch, dispatch };
}

const get = (url, extra = {}) => ({ url, method: 'GET', mode: 'cors', headers: new Headers({ 'X-NG-Device': '00000000-0000-4000-8000-000000000000' }), ...extra });
const ok = (body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN, ...headers } });
const offline = () => { throw new TypeError('Failed to fetch'); };

test('per-device endpoints and every POST are never handled or cached', async () => {
  const sw = loadSW({ net: () => ok({}) });
  const never = [
    '/v1/today', '/v1/day/2026-10-03/progress', '/v1/me', '/v1/library?before=2026-10-01:2&limit=60', '/v1/ranks?scope=global&period=day',
    '/v1/stats/day/2026-10-03?scope=global', '/v1/review/queue', '/v1/round/r7Qm2xK9pLs4Tz8A/reveal', '/v1/health',
    '/v1/day/2026-10-03/', '/v1/day/latest', `/v1/asset/${SHA}.exe`,
  ];
  for (const p of never) assert.equal(await sw.dispatchFetch(get(API + p)), null, p);
  for (const p of ['/v1/round/r7Qm2xK9pLs4Tz8A/guess', '/v1/me', `/v1/asset/${SHA}.glb`, '/v1/day/2026-10-03']) {
    assert.equal(await sw.dispatchFetch(get(API + p, { method: 'POST' })), null, `POST ${p}`);
  }
  assert.equal(sw.fetched.length, 0);
  assert.equal(sw.caches.stores.size, 0);
});

test('/v1/day/{date}: network first and cached when ok; offline → cached copy marked X-From-Cache and exposed', async () => {
  let mode = 'online';
  const sw = loadSW({ net: () => (mode === 'online' ? ok({ date: '2026-10-03', day_number: 33, rounds: [] }) : offline()) });
  const url = `${API}/v1/day/2026-10-03`;
  const r1 = await sw.dispatchFetch(get(url));
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('X-From-Cache'), null);
  assert.equal(sw.fetched.length, 1);
  mode = 'offline';
  const r2 = await sw.dispatchFetch(get(url));
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('X-From-Cache'), '1');
  // cross-origin API: the page can only read X-From-Cache if it is exposed (Fetch spec, enforced by WebKit)
  assert.match(r2.headers.get('Access-Control-Expose-Headers') || '', /(^|,\s*)X-From-Cache(\s*,|$)/i);
  assert.equal(r2.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await r2.json(), { date: '2026-10-03', day_number: 33, rounds: [] });
  // an uncached date offline is a network error, not a fabricated response
  await assert.rejects(sw.dispatchFetch(get(`${API}/v1/day/2026-10-02`)));
});

test('/v1/day/{date}: an existing Access-Control-Expose-Headers value is kept', async () => {
  let up = true;
  const sw = loadSW({ net: () => (up ? ok({ rounds: [] }, { 'Access-Control-Expose-Headers': 'ETag' }) : offline()) });
  await sw.dispatchFetch(get(`${API}/v1/day/2026-10-01`));
  up = false;
  const r = await sw.dispatchFetch(get(`${API}/v1/day/2026-10-01`));
  assert.equal(r.headers.get('Access-Control-Expose-Headers'), 'ETag, X-From-Cache');
});

test('/v1/day/{date}: error responses (404 future/withdrawn day) are passed through and never cached', async () => {
  let status = 404;
  const sw = loadSW({ net: () => (status ? new Response('{"error":{"code":"not_found","message":"x"}}', { status }) : offline()) });
  const r = await sw.dispatchFetch(get(`${API}/v1/day/2026-10-09`));
  assert.equal(r.status, 404);
  assert.equal((await (await sw.caches.api.open('ng-day-v1')).keys()).length, 0);
  status = 0;
  await assert.rejects(sw.dispatchFetch(get(`${API}/v1/day/2026-10-09`)));
});

test('/v1/asset/*: cache first, stored only when response.ok (a locked asset 404s until earned)', async () => {
  let locked = true;
  const sw = loadSW({ net: () => (locked ? new Response('{"error":{"code":"not_found","message":"locked"}}', { status: 404 }) : new Response(new Uint8Array([1, 2, 3]), { status: 200 })) });
  const url = `${API}/v1/asset/${SHA}.glb`;
  assert.equal((await sw.dispatchFetch(get(url))).status, 404);
  assert.equal((await sw.caches.api.open('ng-asset-v1').then((c) => c.keys())).length, 0, '404 not cached');
  locked = false;
  assert.equal((await sw.dispatchFetch(get(url))).status, 200);
  const n = sw.fetched.length;
  locked = true; // the network would now say 404, but the earned asset is immutable and comes from the cache
  const r = await sw.dispatchFetch(get(url));
  assert.equal(r.status, 200);
  assert.equal(new Uint8Array(await r.arrayBuffer()).length, 3);
  assert.equal(sw.fetched.length, n, 'served without a network request');
});

test('install precaches the shell with cache: reload, tolerates a missing file, then skipWaiting', async () => {
  const sw = loadSW({ net: (url) => (url.endsWith('/js/credits.js') ? new Response('nope', { status: 404 }) : new Response('x', { status: 200 })) });
  await sw.dispatch('install');
  const shellName = [...sw.caches.stores.keys()].find((k) => k.startsWith('ng-shell-'));
  assert.ok(shellName);
  const cached = await (await sw.caches.api.open(shellName)).keys();
  assert.ok(cached.some((r) => r.url === `${SCOPE}index.html`));
  assert.ok(cached.some((r) => r.url === `${SCOPE}js/main.js`));
  assert.ok(!cached.some((r) => r.url.endsWith('/js/credits.js')), 'a failed file is skipped, not fatal');
  assert.ok(sw.fetched.every((f) => f.cache === 'no-cache'), 'precache revalidates with the server (never a stale HTTP-cache copy)');
  assert.ok(sw.self.skipped);
});

test('activate deletes old ng-* caches only, and claims clients', async () => {
  const sw = loadSW({ net: () => ok({}) });
  for (const name of ['ng-shell-0.0.9', 'ng-day-v1', 'other-app']) await sw.caches.api.open(name);
  await sw.dispatch('activate');
  const names = [...sw.caches.stores.keys()];
  assert.ok(!names.includes('ng-shell-0.0.9'));
  assert.ok(names.includes('ng-day-v1'));
  assert.ok(names.includes('other-app'));
  assert.ok(sw.self.claimed);
});

test('navigations are network first with the cached index.html offline; shell files are cache first', async () => {
  let up = true;
  const sw = loadSW({ net: () => (up ? new Response('fresh', { status: 200 }) : offline()) });
  await sw.dispatch('install');
  const nav = { url: `${SCOPE}?sw=1`, method: 'GET', mode: 'navigate' };
  assert.equal(await (await sw.dispatchFetch(nav)).text(), 'fresh');
  up = false;
  const r = await sw.dispatchFetch(nav);
  assert.equal(r.status, 200, 'offline launch still gets the app shell');
  const n = sw.fetched.length;
  const js = await sw.dispatchFetch({ url: `${SCOPE}js/game.js?v=2`, method: 'GET', mode: 'cors' });
  assert.equal(js.status, 200);
  assert.equal(sw.fetched.length, n, 'precached module served from the cache (query ignored)');
});
