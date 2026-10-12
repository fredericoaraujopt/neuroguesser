// htm bound to Preact's h: html`<div class="card">${x}</div>` (no JSX, no build step).
import { h, render, Fragment } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment };

const loadedCss = new Map();
// the app root (this file is js/ui/html.js): 'css/x.css' resolves the same from index.html and from dev/*.html
const APP_ROOT = new URL('../../', import.meta.url);

/**
 * Add a stylesheet once, e.g. loadCss('css/round.css') at the top of a screen module.
 * Paths are relative to the app root (where index.html is). Resolves when the sheet has loaded (or failed).
 */
export function loadCss(href) {
  if (typeof document === 'undefined') return Promise.resolve();
  if (loadedCss.has(href)) return loadedCss.get(href);
  const url = new URL(href, APP_ROOT).href;
  const p = new Promise((resolve) => {
    const existing = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href === url);
    if (existing) { resolve(); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.onload = () => resolve();
    link.onerror = () => { console.warn(`[loadCss] could not load ${href}`); resolve(); };
    document.head.appendChild(link);
  });
  loadedCss.set(href, p);
  return p;
}

/**
 * Upper-case for a mono overline that carries a scientific name: Latin letters only, so Greek letters and µ keep
 * their case ("γ Kenyon cell" → "γ KENYON CELL"; CSS text-transform would give "Γ KENYON CELL", a different word).
 * Render the result inside .keep-case (text-transform: none) with the original text for screen readers.
 */
export function upperLatin(s) {
  return String(s == null ? '' : s).replace(/[^µͰ-Ͽἀ-῿]+/g, (m) => m.toUpperCase());
}

/** cx('a', cond && 'b', { c: true }) → 'a b c' */
export function cx(...args) {
  const out = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string') out.push(a);
    else if (typeof a === 'object') for (const [k, v] of Object.entries(a)) if (v) out.push(k);
  }
  return out.join(' ');
}
