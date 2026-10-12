// v1.2 note 4 (ARCHITECTURE.md §3.3 item 4): the web layout in css/desktop.css (600–1023 px centred 640 px column;
// ≥ 1024 px top header, two panes) with the v1.3 Charcoal type roles (§3.4 item 6; the full scan of every size, line
// height and weight is tests/charcoal-type.test.js). Static checks on the stylesheets plus the header component.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { appRoot } from './_importmap.js';
import { createContainer, flush } from './_dom.js';

const read = (p) => readFileSync(path.join(appRoot, p), 'utf8');
const tokens = read('css/tokens.css');
const desktop = read('css/desktop.css');

/** Body of the first `@media (...)` block whose query contains `query`. */
function mediaBlock(css, query) {
  const at = css.indexOf(`@media (${query})`);
  assert.ok(at >= 0, `@media (${query}) missing`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && (depth -= 1) === 0) return css.slice(css.indexOf('{', at) + 1, i);
  }
  throw new Error('unbalanced braces');
}

test('tokens: the v1.3 phone steps (micro 11, label 12, body 13, card 13, reading 13, title 18, name 23), no multiplier', () => {
  const steps = { micro: 11, label: 12, body: 13, card: 13, read: 13, title: 18, name: 23 };
  assert.doesNotMatch(tokens, /--type-k/);
  for (const [name, px] of Object.entries(steps)) assert.match(tokens, new RegExp(`--fs-${name}: ${px}px;`), name);
  assert.match(tokens, /\.t-body\s*\{ font: 400 var\(--fs-body\)\/var\(--lh-body\) /, 'body 13/1.3');
  assert.match(tokens, /\.t-title\s*\{ font: 700 var\(--fs-title\)\//);
  assert.match(tokens, /\.t-num-11\s*\{ font: 400 var\(--fs-label\)\/var\(--lh-label\) var\(--font-mono\)/, 'numerals at the same steps');
});

test('every font size in the app CSS is a type token', () => {
  const allowed = [];
  const offenders = [];
  for (const f of readdirSync(path.join(appRoot, 'css')).filter((n) => n.endsWith('.css') && n !== 'tokens.css')) {
    read(`css/${f}`).split('\n').forEach((line, i) => {
      if (/font(-size)?:[^;]*\d+px/.test(line) && !allowed.some((re) => re.test(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('desktop.css: a 640 px column from 600 px (phone type); laptop type steps, header and no tab bar from 1024 px', () => {
  assert.match(desktop, /^\.topbar \{ display: none; \}/m, 'the header is hidden below 1024 px');
  const mid = mediaBlock(desktop, 'min-width: 600px');
  assert.doesNotMatch(mid, /--fs-|--type-k/, 'phone type steps up to 1023 px');
  assert.match(mid, /--column-max: 640px;/);
  const wide = mediaBlock(desktop, 'min-width: 1024px');
  assert.match(wide, /html:root \{[^}]*--fs-micro: 12px; --lh-micro: 1\.5; --fs-read: 18px; --fs-title: 23px;/, 'micro 12/1.5, reading 18, title 23');
  assert.match(wide, /--header-h: 56px;/);
  assert.match(wide, /--pane-w: clamp\(440px, [^,]+, 520px\);/, 'content column 440–520 px');
  assert.match(wide, /\.app-root > \.tabbar \{ display: none; \}/);
  assert.match(wide, /\.app-root > \.topbar \{[^}]*display: grid;/);
  assert.match(wide, /\.round \{[^}]*grid-template-columns: minmax\(560px, 1fr\) var\(--pane-w\);/, 'round: viewer ≥ 560 px + column');
  assert.match(wide, /\.screen\.reveal \{[^}]*grid-template-columns: minmax\(560px, 1fr\) var\(--pane-w\);/, 'reveal: two panes');
  assert.match(wide, /\.sheet:not\(\.is-full\) \{[^}]*width: min\(560px, 100%\);[^}]*border-radius: var\(--radius-lg\);/, 'sheets → dialogs');
  assert.match(wide, /\.screen\.rk > \.screen-pad,[\s\S]*?max-width: 720px;/, 'Ranks/Settings 720 px');
  assert.match(wide, /\.lib-grid \{ grid-template-columns: repeat\(3, /);
  assert.match(mediaBlock(desktop, 'min-width: 1280px'), /\.lib-grid \{ grid-template-columns: repeat\(4, /);
  assert.doesNotMatch(desktop, /full-overlay|\.fv[-\s{]/, 'the full view is untouched (stays full-window)');
  assert.doesNotMatch(desktop, /#[0-9a-f]{3,8}\b/i, 'tokens only');
});

test('index.html loads desktop.css right after app.css; the service worker precaches it and the header module', () => {
  const html = read('index.html');
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(links, ['css/tokens.css', 'css/app.css', 'css/desktop.css']);
  const sw = read('sw.js');
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(sw)[1];
  assert.match(shell, /'css\/desktop\.css'/);
  assert.match(shell, /'js\/ui\/top-header\.js'/);
});

test('HeaderBar: wordmark, day progress slot, nav Today · Library · Ranks · Profile with the active one marked', async () => {
  const { h, render } = await import('preact');
  const { HeaderBar } = await import('../js/ui/top-header.js');
  const root = createContainer();
  render(h(HeaderBar, { active: 'profile', dueCount: 3 }), root);
  await flush();
  const header = root.firstChild;
  assert.equal(header.localName, 'header');
  assert.equal(header.getAttribute('class'), 'topbar');
  const [mark, progress, nav] = header.childNodes;
  assert.equal(mark.textContent, 'NeuroGuesser');
  assert.equal(mark.getAttribute('href'), '#/today');
  assert.equal(progress.getAttribute('class'), 'topbar-progress');
  assert.equal(nav.getAttribute('aria-label'), 'Main');
  const links = nav.childNodes;
  assert.deepEqual(links.map((a) => a.getAttribute('href')), ['#/today', '#/library', '#/ranks', '#/settings']);
  assert.deepEqual(links.map((a) => a.textContent), ['Today', 'Library · 3', 'Ranks', 'Profile']);
  assert.equal(links[1].getAttribute('aria-label'), 'Library, 3 due for review');
  // label + badge share one inline span: as a direct flex item the badge lost its leading space ("Library· 3")
  assert.equal(links[1].childNodes.length, 1);
  assert.equal(links[1].firstChild.textContent, 'Library · 3');
  assert.deepEqual(links.map((a) => a.getAttribute('class')), ['topbar-link', 'topbar-link', 'topbar-link', 'topbar-link is-active']);
  assert.deepEqual(links.map((a) => a.getAttribute('aria-current')), [null, null, null, 'page']);
  render(h(HeaderBar, { active: 'library', dueCount: 0 }), root);
  await flush();
  assert.equal(root.firstChild.childNodes[2].childNodes[1].textContent, 'Library');
  assert.equal(root.firstChild.childNodes[2].childNodes[1].getAttribute('aria-current'), 'page');
  render(null, root);
});

test('TopHeader mounts only at >= 1024 px (no hidden copy of the nav or the day total on phones) and follows resizes', async () => {
  const { h, render } = await import('preact');
  const { TopHeader, WIDE_QUERY } = await import('../js/ui/top-header.js');
  assert.equal(WIDE_QUERY, '(min-width: 1024px)');
  const root = createContainer();
  render(h(TopHeader, { active: 'today' }), root); // no matchMedia (node): treated as narrow
  await flush();
  assert.equal(root.childNodes.length, 0);
  render(null, root);

  const listeners = new Set();
  const mql = { matches: false, addEventListener: (t, fn) => listeners.add(fn), removeEventListener: (t, fn) => listeners.delete(fn) };
  const queries = [];
  globalThis.matchMedia = (q) => { queries.push(q); return mql; };
  try {
    render(h(TopHeader, { active: 'today' }), root);
    await flush();
    assert.equal(root.childNodes.length, 0, 'narrow: nothing rendered');
    assert.ok(queries.includes(WIDE_QUERY));
    mql.matches = true;
    for (const fn of listeners) fn();
    await flush();
    assert.equal(root.firstChild && root.firstChild.getAttribute('class'), 'topbar', 'wide: the header mounts');
    mql.matches = false;
    for (const fn of listeners) fn();
    await flush();
    assert.equal(root.childNodes.length, 0, 'back to narrow: unmounted');
    render(null, root);
    await flush();
    assert.equal(listeners.size, 0, 'listener removed on unmount');
  } finally {
    delete globalThis.matchMedia;
  }
});
