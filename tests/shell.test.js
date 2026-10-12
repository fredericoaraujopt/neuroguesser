// The app shell: import map targets exist, sw.js precache entries exist, versions agree.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { importMap, appRoot } from './_importmap.js';

const sw = readFileSync(path.join(appRoot, 'sw.js'), 'utf8');

test('import map targets exist (and every vendor dir keeps a licence file)', () => {
  for (const [spec, target] of Object.entries(importMap)) {
    assert.ok(existsSync(path.join(appRoot, target)), `${spec} → ${target}`);
  }
  for (const dir of ['preact', 'htm', 'three']) {
    assert.ok(existsSync(path.join(appRoot, 'vendor', dir, 'LICENSE')), `vendor/${dir}/LICENSE`);
  }
  assert.ok(existsSync(path.join(appRoot, 'fonts/OFL.txt')));
});

test('sw.js VERSION equals version.js VERSION', async () => {
  const { VERSION } = await import('../version.js');
  const m = /const VERSION = '([^']+)'/.exec(sw);
  assert.ok(m);
  assert.equal(m[1], VERSION);
});

test('every precached shell file exists, and every foundation module is precached', () => {
  const list = /const SHELL = \[([\s\S]*?)\];/.exec(sw)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  for (const p of list) {
    if (p === './') continue;
    assert.ok(existsSync(path.join(appRoot, p)), `precache entry missing on disk: ${p}`);
  }
  const walk = (dir) => readdirSync(path.join(appRoot, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(path.join(appRoot, rel)).isDirectory() ? walk(rel) : [rel];
  });
  for (const f of [...walk('js'), 'css/tokens.css', 'css/app.css', 'index.html', 'config.js', 'version.js', 'manifest.webmanifest']) {
    if (/\.(js|css|html|webmanifest)$/.test(f)) assert.ok(list.includes(f), `not precached: ${f}`);
  }
});

test('sw.js never caches the per-device endpoints or POSTs', () => {
  assert.match(sw, /if \(req\.method !== 'GET'\) return;/);
  assert.match(sw, /url\.pathname\.startsWith\('\/v1\/'\)\) return;/);
  assert.match(sw, /DAY_PATH = \/\^\\\/v1\\\/day\\\/\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(sw, /cache: 'no-cache'/); // precache revalidates (never stale; 304 for what the page already loaded)
  assert.match(sw, /skipWaiting\(\)/);
  assert.match(sw, /clients\.claim\(\)/);
  assert.match(sw, /X-From-Cache/);
  // assets are stored only when ok (in the background since QA perf: the page gets the stream at once)
  assert.match(sw, /if \(res\.ok\) \{\n(?:\s*\/\/[^\n]*\n)?\s+const bytes = [^\n]*\n\s+const stored = cache\.put\(req\.url, res\.clone\(\)\)/);
});

test('manifest: standalone, portrait, Charcoal colours, 192/512/maskable icons on disk', () => {
  const man = JSON.parse(readFileSync(path.join(appRoot, 'manifest.webmanifest'), 'utf8'));
  assert.equal(man.display, 'standalone');
  assert.equal(man.orientation, 'portrait');
  assert.equal(man.theme_color, '#1c222b');
  assert.equal(man.background_color, '#1c222b');
  const purposes = man.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.deepEqual(purposes.sort(), ['192x192:any', '512x512:any', '512x512:maskable']);
  for (const i of man.icons) assert.ok(existsSync(path.join(appRoot, i.src)), i.src);
});

test('config: dev overrides only on localhost / 127.0.0.1', async () => {
  const { resolveConfig, PRODUCTION_API, DEV_API } = await import('../config.js');
  const loc = (hostname, search = '') => ({ hostname, search });
  assert.equal(resolveConfig(loc('localhost')).apiBase, DEV_API);
  assert.equal(resolveConfig(loc('127.0.0.1', '?api=http://127.0.0.1:9999/')).apiBase, 'http://127.0.0.1:9999');
  const dev = resolveConfig(loc('localhost', '?now=2026-10-03T23:59:30Z'));
  assert.equal(dev.debugNow, '2026-10-03T23:59:30.000Z');
  assert.equal(dev.registerSW, false);
  assert.equal(resolveConfig(loc('localhost', '?sw=1')).registerSW, true);
  const prod = resolveConfig(loc('user.github.io', '?api=https://evil.example&now=2026-10-03T00:00:00Z'));
  assert.equal(prod.apiBase, PRODUCTION_API);
  assert.equal(prod.debugNow, null);
  assert.equal(prod.registerSW, true);
  assert.equal(resolveConfig(loc('localhost', '?now=garbage')).debugNow, null);
});
