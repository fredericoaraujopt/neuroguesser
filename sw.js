/* NeuroGuesser service worker (classic script).
 *
 * ARCHITECTURE.md §3 "Offline":
 *  - versioned caches; the shell is precached with cache:'no-cache' (GitHub Pages serves max-age=600, so a
 *    plain fetch could hand a new worker stale files; a revalidated request never does, and the files the page
 *    has just loaded come back as 304s instead of being downloaded a second time: with cache:'reload' the first
 *    install re-downloaded ≈ 1.3 MB on top of the first session, delaying its first EM by ≈ 3 s on Fast 3G);
 *    skipWaiting + clients.claim;
 *  - navigations: network-first, cached shell (index.html) as the offline fallback;
 *  - same-origin shell files: cache-first (files added later by other tracks are cached on first use);
 *  - API /v1/day/{date} (exact path): network-first; when served from cache the response carries
 *    "X-From-Cache: 1" so the UI can show a cached badge;
 *  - API /v1/asset/*: cache-first, stored only when response.ok (gated assets 404 until earned); the response
 *    streams to the page while it is stored in the background (awaiting the store held a 2.6 MB EM atlas back
 *    until it had fully arrived, past the page's 15 s request timeout on a slow link); the cache keeps at most
 *    MAX_ASSETS entries and MAX_ASSET_BYTES, oldest first (em-v2-spec.md §8.6: EM format 2 is 9–15 assets and ≈ 6 MB
 *    per round, ≈ 32 MB a day, so 1000 entries / 160 MB keep about 5 days);
 *  - NEVER cached: /v1/today, /progress, /me, /library, /ranks, /stats, /review, and any non-GET.
 *
 * VERSION must equal version.js (tests/shell.test.js checks it; tests/sw.test.js tests the behaviour).
 */
const VERSION = '0.7.0';
const SHELL_CACHE = `ng-shell-${VERSION}`;
const DAY_CACHE = 'ng-day-v1';
const ASSET_CACHE = 'ng-asset-v1';
const MAX_DAYS = 21;
const MAX_ASSETS = 1000;
const MAX_ASSET_BYTES = 160 * 1024 * 1024;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'version.js',
  'config.js',
  'css/tokens.css',
  'css/app.css',
  'css/round.css',
  'css/library.css',
  'css/social.css',
  'css/reveal.css',
  'css/viewer.css',
  'css/feedback.css',
  'css/day-progress.css',
  'css/progress-bars.css',
  'css/desktop.css',
  'css/em2.css',
  'fonts/Figtree-Var.woff2',
  'fonts/Figtree-Italic.woff2',
  'fonts/GeistMono-Var.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'vendor/preact/preact.module.js',
  'vendor/preact/hooks.module.js',
  'vendor/htm/htm.module.js',
  'vendor/three/three.module.min.js',
  'vendor/three/addons/loaders/GLTFLoader.js',
  'vendor/three/addons/utils/BufferGeometryUtils.js',
  'vendor/three/addons/utils/SkeletonUtils.js',
  'vendor/three/addons/lines/Line2.js',
  'vendor/three/addons/lines/LineGeometry.js',
  'vendor/three/addons/lines/LineMaterial.js',
  'vendor/three/addons/lines/LineSegments2.js',
  'vendor/three/addons/lines/LineSegmentsGeometry.js',
  'vendor/three/addons/libs/meshopt_decoder.module.js',
  'js/main.js',
  'js/app.js',
  'js/router.js',
  'js/store.js',
  'js/idb.js',
  'js/api.js',
  'js/game.js',
  'js/time.js',
  'js/format.js',
  'js/levels.js',
  'js/credits.js',
  'js/feedback.js',
  'js/fx/haptics.js',
  'js/fx/celebrate.js',
  'js/fx/overtake.js',
  'js/fx/streak.js',
  'js/fx/milestone.js',
  'js/ui/html.js',
  'js/ui/components.js',
  'js/ui/sheet.js',
  'js/ui/day-progress.js',
  'js/ui/top-header.js',
  'js/ui/xp-bar.js',
  'js/ui/atlas-bar.js',
  'js/viewer/three-common.js',
  'js/viewer/scalebar.js',
  'js/viewer/mesh-viewer.js',
  'js/viewer/em-viewer.js',
  'js/viewer/graph-view.js',
  'js/viewer/em2/model.js',
  'js/viewer/em2/shaders.js',
  'js/viewer/em2/loader.js',
  'js/viewer/em2/mesh-cut.js',
  'js/viewer/em2/footprint.js',
  'js/viewer/em2/overlay.js',
  'js/viewer/em2/stage.js',
  'js/viewer/em2/view.js',
  'js/viewer/em2/factory.js',
  'js/screens/today.js',
  'js/screens/round.js',
  'js/screens/reveal.js',
  'js/screens/summary.js',
  'js/screens/share.js',
  'js/screens/report.js',
  'js/screens/library.js',
  'js/screens/profile.js',
  'js/screens/review.js',
  'js/screens/ranks.js',
  'js/screens/settings.js',
  'js/screens/onboarding.js',
  'js/screens/fullview.js',
];

const DAY_PATH = /^\/v1\/day\/\d{4}-\d{2}-\d{2}$/;
const ASSET_PATH = /^\/v1\/asset\/[a-f0-9]{64}\.(glb|webp|png|json|bin)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One request per file (not addAll) so a single missing file cannot block the install.
    await Promise.all(SHELL.map(async (path) => {
      try {
        const res = await fetch(new Request(path, { cache: 'no-cache' }));
        if (res.ok) await cache.put(path, res);
      } catch (_) { /* offline during install: cached on first use instead */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DAY_CACHE, ASSET_CACHE]);
    for (const key of await caches.keys()) {
      if (key.startsWith('ng-') && !keep.has(key)) await caches.delete(key);
    }
    await trim(DAY_CACHE, MAX_DAYS);
    await trimAssets();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                     // POSTs are never touched
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(navigation(req));
    return;
  }
  if (DAY_PATH.test(url.pathname)) {
    event.respondWith(networkFirstDay(req));
    return;
  }
  if (ASSET_PATH.test(url.pathname)) {
    event.respondWith(cacheFirstAsset(req, event));
    return;
  }
  if (url.pathname.startsWith('/v1/')) return;          // /today, /progress, /me, /library, /ranks, /stats, /review…: network only
  if (url.origin === self.location.origin) {
    event.respondWith(shell(req));
  }
});

async function navigation(req) {
  try {
    const res = await fetch(req);
    return res;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function shell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') cache.put(req, res.clone());
  return res;
}

async function networkFirstDay(req) {
  const cache = await caches.open(DAY_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req.url, res.clone());
      trim(DAY_CACHE, MAX_DAYS);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req.url, { ignoreVary: true });
    if (!hit) throw err;
    const headers = new Headers(hit.headers);
    headers.set('X-From-Cache', '1');
    // The API is cross-origin: per the Fetch spec the page only sees CORS-safelisted headers plus the
    // exposed ones on this synthesised response (WebKit enforces it), so expose X-From-Cache explicitly.
    const exposed = headers.get('Access-Control-Expose-Headers');
    if (!exposed || !/(^|,)\s*(x-from-cache|\*)\s*(,|$)/i.test(exposed)) {
      headers.set('Access-Control-Expose-Headers', exposed ? `${exposed}, X-From-Cache` : 'X-From-Cache');
    }
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
  }
}

async function cacheFirstAsset(req, event) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    // stream to the page now and store in the background (the worker stays alive until the store is done)
    const bytes = Number(res.headers.get('Content-Length')) || 0;
    const stored = cache.put(req.url, res.clone())
      .then(() => { if (assetBytes) assetBytes.set(req.url, bytes); return trimAssets(); })
      .catch(() => { /* quota or an aborted body: served, just not stored */ });
    if (event && typeof event.waitUntil === 'function') event.waitUntil(stored);
  }
  return res;
}

// url → bytes of the cached assets, rebuilt from the cache when the worker (re)starts.
let assetBytes = null;
async function sizeOf(cache, key) {
  try {
    const r = await cache.match(key);
    if (!r) return 0;
    const n = Number(r.headers.get('Content-Length'));
    return Number.isFinite(n) && n > 0 ? n : (await r.blob()).size;
  } catch (_) { return 0; }
}

/** Drop the oldest assets until both caps hold (MAX_ASSETS entries, MAX_ASSET_BYTES). Best effort. */
async function trimAssets() {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const keys = await cache.keys();          // insertion order: oldest first
    if (!assetBytes) assetBytes = new Map();
    let total = 0;
    for (const k of keys) {
      if (!assetBytes.has(k.url) || !assetBytes.get(k.url)) assetBytes.set(k.url, await sizeOf(cache, k));
      total += assetBytes.get(k.url);
    }
    let count = keys.length;
    for (const k of keys) {
      if (count <= MAX_ASSETS && total <= MAX_ASSET_BYTES) break;
      if (count === 1) break;                 // never the asset just stored
      await cache.delete(k);
      total -= assetBytes.get(k.url) || 0;
      assetBytes.delete(k.url);
      count--;
    }
  } catch (_) { /* best effort */ }
}

async function trim(name, max) {
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();          // insertion order: oldest first
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
  } catch (_) { /* best effort */ }
}
