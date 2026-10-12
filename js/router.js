// Hash router (ARCHITECTURE.md §4.5). Routes map to screen modules, loaded lazily so one broken screen
// cannot take the whole app down. Each screen module default-exports ({ params }) => vnode.
import { useEffect, useState } from 'preact/hooks';

export const routes = [
  { name: 'today',        pattern: '/today',              tab: 'today',   screen: 'today',   load: () => import('./screens/today.js') },
  { name: 'today-round',  pattern: '/today/round/:n',     tab: 'today',   screen: 'today',   load: () => import('./screens/today.js') },
  { name: 'today-reveal', pattern: '/today/reveal/:n',    tab: 'today',   screen: 'today',   load: () => import('./screens/today.js') },
  { name: 'library',      pattern: '/library',            tab: 'library', load: () => import('./screens/library.js') },
  { name: 'library-cell', pattern: '/library/cell/:date/:n', tab: 'library', load: () => import('./screens/profile.js') },
  { name: 'review',       pattern: '/review',             tab: null,      load: () => import('./screens/review.js'), fullScreen: true },
  { name: 'ranks',        pattern: '/ranks',              tab: 'ranks',   load: () => import('./screens/ranks.js') },
  { name: 'settings',     pattern: '/settings',           tab: 'ranks',   load: () => import('./screens/settings.js') },
];

export const DEFAULT_PATH = '/today';

function compile(pattern) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { re, keys };
}
const compiled = routes.map((r) => ({ ...r, ...compile(r.pattern) }));

/** '#/today/round/2?x=1' → { path: '/today/round/2', name: 'today-round', params: { n: '2' }, route } */
export function parseHash(hash) {
  let path = String(hash || '').replace(/^#/, '');
  path = path.split('?')[0] || '';
  if (!path.startsWith('/')) path = '/' + path;
  for (const r of compiled) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { path, name: r.name, params, route: r };
    }
  }
  return { path, name: null, params: {}, route: null };
}

function currentHash() { return typeof location !== 'undefined' ? location.hash : ''; }

/** navigate('/library') or navigate('#/library'); { replace: true } swaps the history entry. */
export function navigate(path, { replace = false } = {}) {
  const target = '#' + String(path).replace(/^#/, '');
  if (target === currentHash()) return;
  if (replace) {
    history.replaceState(history.state, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

let current = parseHash(currentHash());
const subs = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const next = parseHash(currentHash());
    if (!next.route) { navigate(DEFAULT_PATH, { replace: true }); return; }
    current = next;
    subs.forEach((fn) => fn(current));
  });
}

export function getRoute() { return current; }

/** Normalise an unknown/empty hash to #/today (main.js calls this once at boot). */
export function initRouter() {
  current = parseHash(currentHash());
  if (!current.route) {
    history.replaceState(history.state, '', '#' + DEFAULT_PATH);
    current = parseHash('#' + DEFAULT_PATH);
  }
  return current;
}

/** Preact hook → { path, name, params, route }; re-renders on hash change. */
export function useRoute() {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const fn = (r) => setRoute(r);
    subs.add(fn);
    if (current !== route) setRoute(current);
    return () => { subs.delete(fn); };
  }, []);
  return route;
}
