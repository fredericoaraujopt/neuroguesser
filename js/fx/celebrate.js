// Feedback and delight (ARCHITECTURE.md §3.1, §4.7), inside Charcoal:
//  - accent + ink only (never data-* colours in chrome), no emoji, no gradients, no extra shadows;
//  - transform/opacity animations only (WAAPI or CSS), each <= 900 ms, never blocking input
//    (#fx-layer has pointer-events: none; nothing here awaits user input);
//  - prefers-reduced-motion or Settings → Celebrations off: no particles or motion, the end state is applied
//    instantly (screens keep showing the same words/glyphs).
// Every function is null-safe and never throws; the returned Promise resolves when the effect is over.
// Haptics are separate: js/fx/haptics.js.
import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../store.js';

export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];
export const isMilestone = (n) => STREAK_MILESTONES.includes(n);
/** Next milestone strictly above n (null past 365). */
export const nextMilestone = (n) => STREAK_MILESTONES.find((m) => m > n) ?? null;
/** Last milestone <= n (0 before the first). */
export const prevMilestone = (n) => [...STREAK_MILESTONES].reverse().find((m) => m <= n) ?? 0;
/** 0..1 progress from the previous milestone to the next one (1 past the last). */
export function milestoneProgress(n) {
  const next = nextMilestone(n);
  if (next === null) return 1;
  const prev = prevMilestone(n);
  return Math.max(0, Math.min(1, (n - prev) / (next - prev)));
}

const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
const done = () => Promise.resolve();

/** False under prefers-reduced-motion, with Settings → Celebrations off, or without a DOM. */
export function motionAllowed() {
  try {
    if (typeof document === 'undefined') return false;
    const s = store.get().session.settings;
    if (s && s.celebrations === false) return false;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function layer() {
  let el = document.getElementById('fx-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fx-layer';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

function centre(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
}

function run(node, keyframes, options) {
  if (!node || typeof node.animate !== 'function') return done();
  try {
    const a = node.animate(keyframes, options);
    return a.finished.then(() => a, () => a);
  } catch (_) {
    return done();
  }
}

function safe(fn) {
  return (...args) => {
    try { return fn(...args) || done(); } catch (err) { console.warn('[fx]', err); return done(); }
  };
}

function ensurePositioned(el) {
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
}

/**
 * Particle burst from el's centre on #fx-layer: small accent and ink squares, dots and dashes.
 * { count = 16, big = false } — big: farther, longer (named / milestone).
 */
export const burst = safe((el, { count = 16, big = false } = {}) => {
  if (!el || !motionAllowed()) return done();
  const { x, y } = centre(el);
  const host = layer();
  const dur = big ? 820 : 620;
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    const shape = i % 3 === 0 ? ' is-dash' : i % 3 === 1 ? ' is-dot' : '';
    p.className = `fx-particle${shape}`;
    p.style.background = i % 5 === 1 || i % 5 === 3 ? 'var(--ink)' : 'var(--accent)';
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
    const dist = (big ? 70 : 42) + Math.random() * (big ? 76 : 40);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const rot = (Math.random() - 0.5) * 420;
    host.appendChild(p);
    jobs.push(run(p, [
      { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.78}px, ${dy * 0.78 - 8}px) rotate(${rot * 0.7}deg) scale(1)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy + 12}px) rotate(${rot}deg) scale(0.35)`, opacity: 0 },
    ], { duration: dur * (0.82 + Math.random() * 0.18), easing: EASE, fill: 'forwards' }).then(() => p.remove()));
  }
  return Promise.all(jobs).then(() => {});
});

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Draw a ✓ inside el (300 ms stroke animation, stroke = currentColor). Appends an inline <svg class="fx-check">
 * sized 1em the first time (re-animates it on later calls). Give it an empty dedicated element, e.g.
 * html`<span class="option-mark" ref=${markRef}></span>`; under reduced motion the ✓ appears fully drawn.
 */
export const checkDraw = safe((el) => {
  if (!el) return done();
  let svg = el.querySelector('svg.fx-check');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'fx-check');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M3 8.6 L6.6 12.2 L13.2 4.4');
    svg.appendChild(path);
    el.appendChild(svg);
  }
  const path = svg.querySelector('path');
  if (!motionAllowed()) { path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''; return done(); }
  const len = typeof path.getTotalLength === 'function' ? path.getTotalLength() || 15.3 : 15.3;
  path.style.strokeDasharray = `${len}`;
  return run(path, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 300, easing: 'ease-out', fill: 'forwards' });
});

/** Wrong-guess shake: ±6 px, 3 cycles, 280 ms (transform only). */
export const shake = safe((el) => {
  if (!el || !motionAllowed()) return done();
  const k = [0, -6, 6, -6, 6, -6, 6, 0].map((x) => ({ transform: `translateX(${x}px)` }));
  return run(el, k, { duration: 280, easing: 'ease-in-out' });
});

/**
 * Strikethrough that draws across el left → right (250 ms), then fades { fadeEl = el } to 45%.
 * Imperative variant of the CSS pattern; inside Preact prefer rendering class="fx-strike is-struck" when the
 * option is out (the ::after line then animates by itself), because Preact may rewrite className.
 */
export const strike = safe((el, { fade = true, fadeEl = null } = {}) => {
  if (!el) return done();
  const target = fadeEl || el;
  el.classList.add('fx-strike');
  if (!motionAllowed()) {
    el.classList.add('is-struck');
    if (fade) target.style.opacity = '0.45';
    return done();
  }
  el.classList.remove('is-struck');
  void el.offsetWidth; // restart the transition
  el.classList.add('is-struck');
  return new Promise((resolve) => setTimeout(resolve, 250)).then(() => {
    if (!fade) return undefined;
    return run(target, [{ opacity: getComputedStyle(target).opacity }, { opacity: 0.45 }], { duration: 200, easing: 'linear', fill: 'forwards' })
      .then(() => { target.style.opacity = '0.45'; });
  });
});

function ringAt(el, { radius } = {}) {
  const r = el.getBoundingClientRect();
  const ring = document.createElement('span');
  ring.className = 'fx-ring';
  ring.style.left = `${r.left}px`;
  ring.style.top = `${r.top}px`;
  ring.style.width = `${r.width}px`;
  ring.style.height = `${r.height}px`;
  ring.style.borderRadius = radius || getComputedStyle(el).borderRadius || '8px';
  layer().appendChild(ring);
  return ring;
}

/** Accent ring pulse around el (2 rings, 700 ms) — perfect round verdict, milestone. { radius } overrides
 *  el's border-radius (e.g. '50%' on a square element for a circular ring). */
export const pulse = safe((el, { rings = 2, radius } = {}) => {
  if (!el || !motionAllowed()) return done();
  const jobs = [];
  for (let i = 0; i < rings; i++) {
    const ring = ringAt(el, { radius });
    ring.style.opacity = '0';
    jobs.push(run(ring, [
      { transform: 'scale(1)', opacity: 0.9 },
      { transform: 'scale(1.14)', opacity: 0 },
    ], { duration: 700, delay: i * 180, easing: EASE, fill: 'forwards' }).then(() => ring.remove()));
  }
  return Promise.all(jobs).then(() => {});
});

/** Correct guess: the card's border flashes accent (450 ms, opacity only). */
export const flash = safe((el) => {
  if (!el || !motionAllowed()) return done();
  const ring = ringAt(el);
  ring.style.opacity = '0';
  return run(ring, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 450, easing: 'ease-out', fill: 'forwards' })
    .then(() => ring.remove());
});

/** Soft accent glow inside el (used by flip() for the "you" row; 1.2 s, opacity only). */
export const glow = safe((el, { duration = 1200 } = {}) => {
  if (!el || !motionAllowed()) return done();
  ensurePositioned(el);
  const g = document.createElement('span');
  g.className = 'fx-glow';
  g.setAttribute('aria-hidden', 'true');
  el.appendChild(g);
  return run(g, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: Math.min(duration, 1200), easing: 'ease-out', fill: 'forwards' })
    .then(() => g.remove());
});

/** Overline stamp ("NAMED ✓", "PERFECT ROUND"): scales in from 1.6× with a small overshoot (300 ms). */
export const stamp = safe((el) => {
  if (!el || !motionAllowed()) return done();
  return run(el, [
    { opacity: 0, transform: 'scale(1.6)' },
    { opacity: 1, transform: 'scale(0.94)', offset: 0.6 },
    { opacity: 1, transform: 'scale(1)' },
  ], { duration: 300, easing: EASE });
});

/** "+200" flies from fromEl to toEl (or floats up 48 px when toEl is null) in mono accent, 750 ms. */
export const floatUp = safe((text, fromEl, toEl = null) => {
  if (!fromEl || !motionAllowed()) return done();
  const a = centre(fromEl);
  const b = toEl ? centre(toEl) : { x: a.x, y: a.y - 48 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const node = document.createElement('span');
  node.className = 'fx-float';
  node.textContent = text;
  node.style.left = `${a.x}px`;
  node.style.top = `${a.y}px`;
  layer().appendChild(node);
  const base = 'translate(-50%, -50%)';
  return run(node, [
    { transform: `${base} translate(0, 0) scale(0.9)`, opacity: 0 },
    { transform: `${base} translate(${dx * 0.12}px, ${dy * 0.12 - 18}px) scale(1.12)`, opacity: 1, offset: 0.25 },
    { transform: `${base} translate(${dx * 0.92}px, ${dy * 0.92}px) scale(0.9)`, opacity: 1, offset: 0.85 },
    { transform: `${base} translate(${dx}px, ${dy}px) scale(0.8)`, opacity: 0 },
  ], { duration: 750, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }).then(() => node.remove());
});

/** Radiating accent rays around el's centre (milestone sheet), 900 ms in total, placed inside el. */
export const rays = safe((el, { count = 12, inner = 26, outer = 58 } = {}) => {
  if (!el || !motionAllowed()) return done();
  ensurePositioned(el);
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const ray = document.createElement('span');
    ray.className = 'fx-ray';
    ray.setAttribute('aria-hidden', 'true');
    ray.style.opacity = '0';
    const deg = (360 / count) * i;
    el.appendChild(ray);
    jobs.push(run(ray, [
      { transform: `rotate(${deg}deg) translateY(${inner}px) scaleY(0.2)`, opacity: 0 },
      { transform: `rotate(${deg}deg) translateY(${(inner + outer) / 2}px) scaleY(1)`, opacity: 1, offset: 0.4 },
      { transform: `rotate(${deg}deg) translateY(${outer}px) scaleY(0.4)`, opacity: 0 },
    ], { duration: 840, delay: (i % 2) * 60, easing: EASE, fill: 'forwards' }).then(() => ray.remove())); // <= 900 ms incl. the stagger
  }
  return Promise.all(jobs).then(() => {});
});

const easeOutCubic = (k) => 1 - (1 - k) ** 3;

/**
 * Count from → to, calling onFrame(rounded value) every animation frame (default 600 ms, ease-out).
 * Returns a Promise (resolves with `to`) that also has .cancel(). Reduced motion: onFrame(to) at once.
 */
export function countUp(from, to, onFrame, { duration = 600, easing = easeOutCubic } = {}) {
  let cancelled = false;
  let finished = false;
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const finish = () => {
    if (finished) return;
    finished = true;
    if (!cancelled) { try { onFrame(to); } catch (_) { /* ignore */ } }
    resolveFn(to);
  };
  promise.cancel = () => { cancelled = true; finish(); };
  if (!motionAllowed() || from === to || !(duration > 0) || typeof requestAnimationFrame !== 'function') {
    finish();
    return promise;
  }
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const step = (t) => {
    if (finished) return;
    const k = Math.min(1, Math.max(0, (t - start) / duration));
    try { onFrame(Math.round(from + (to - from) * easing(k))); } catch (_) { /* ignore */ }
    if (k < 1) requestAnimationFrame(step); else finish();
  };
  requestAnimationFrame(step);
  setTimeout(finish, duration + 150); // a hidden tab gets no frames: land on the end value anyway
  return promise;
}

/**
 * Preact hook: the displayed number animates to `value` whenever it changes.
 * { from } animates on mount too (e.g. summary total 0 → total); default: mount shows `value` at once.
 */
export function useCountUp(value, { duration = 600, from } = {}) {
  const initial = from !== undefined ? from : value;
  const [shown, setShown] = useState(initial);
  const shownRef = useRef(initial);
  useEffect(() => {
    const p = countUp(shownRef.current, value, (v) => { shownRef.current = v; setShown(v); }, { duration });
    return () => p.cancel();
  }, [value]);
  return shown;
}

/**
 * FLIP reorder. const play = flip(listEl) captures the rects of every [data-key] child now; after the DOM
 * update call play({ glowKey }) to glide moved rows from their old place (transform), fade in new rows and
 * glow the row whose key = glowKey (the "you" row). Returns a Promise.
 */
export function flip(containerEl, keyAttr = 'data-key') {
  const first = new Map();
  try {
    if (containerEl) for (const node of containerEl.querySelectorAll(`[${keyAttr}]`)) first.set(node.getAttribute(keyAttr), node.getBoundingClientRect());
  } catch (_) { /* ignore */ }
  return function play({ duration = 420, glowKey = null } = {}) {
    try {
      if (!containerEl) return done();
      const motion = motionAllowed();
      const jobs = [];
      for (const node of containerEl.querySelectorAll(`[${keyAttr}]`)) {
        const key = node.getAttribute(keyAttr);
        const last = node.getBoundingClientRect();
        const f = first.get(key);
        if (motion) {
          if (f) {
            const dx = f.left - last.left;
            const dy = f.top - last.top;
            if (dx || dy) jobs.push(run(node, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: Math.min(duration, 900), easing: EASE }));
          } else {
            jobs.push(run(node, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'ease-out' }));
          }
        }
        if (glowKey !== null && glowKey !== undefined && key === String(glowKey)) jobs.push(glow(node));
      }
      return Promise.all(jobs).then(() => {});
    } catch (err) {
      console.warn('[fx]', err);
      return done();
    }
  };
}

/** Convenience for a correct guess: border flash + burst (bigger when named) + optional overline stamp. */
export function celebrateCorrect(cardEl, { named = false, overlineEl = null } = {}) {
  return Promise.all([
    flash(cardEl),
    burst(cardEl, { count: named ? 28 : 16, big: named }),
    named && overlineEl ? stamp(overlineEl) : done(),
  ]).then(() => {});
}
