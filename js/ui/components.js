// Shared Charcoal components (ARCHITECTURE.md §1.1 ui/components.js). Class names live in css/app.css.
import { useEffect, useState } from 'preact/hooks';
import { html, cx } from './html.js';
import { useStore, store } from '../store.js';
import { haptic } from '../fx/haptics.js';
import { niceScale } from '../viewer/scalebar.js';
import { fmtUm, countdown as fmtCountdown } from '../format.js';
import { now as serverNow, msUntil } from '../time.js';

/**
 * <Button variant="primary|outline|link-outline|text" block size="sm" haptic="selection">Label</Button>
 * Calls haptic(kind) synchronously inside the tap (iOS only allows haptics within a user gesture).
 * With href it renders an <a> (e.g. Neuroglancer ↗, target=_blank rel=noopener).
 */
export function Button({ variant = 'primary', block = false, size, haptic: hapticKind, onClick, class: klass, className, href, children, ...rest }) {
  const cls = cx(
    variant === 'text' ? 'btn-text' : 'btn',
    variant === 'primary' && 'btn-primary',
    variant === 'outline' && 'btn-outline',
    variant === 'link-outline' && 'btn-link-outline',
    block && 'btn-block',
    size === 'sm' && 'btn-sm',
    klass, className,
  );
  const click = (e) => {
    if (rest.disabled) return;
    if (hapticKind) haptic(hapticKind);
    if (onClick) onClick(e);
  };
  if (href) {
    return html`<a class=${cls} href=${href} target="_blank" rel="noopener noreferrer" onClick=${click} ...${rest}>${children}</a>`;
  }
  return html`<button type="button" class=${cls} onClick=${click} ...${rest}>${children}</button>`;
}

/** 44 × 44 glyph button with no fill (⤢ ✕ + − ⟲ ✥ ▲ ▼ ↗). Always give it an aria-label. */
export function GhostButton({ label, size, children, onClick, haptic: hapticKind, class: klass, ...rest }) {
  const click = (e) => { if (hapticKind) haptic(hapticKind); if (onClick) onClick(e); };
  return html`<button type="button" class=${cx('btn-ghost', size === 'lg' && 'is-lg', size === 'sm' && 'is-sm', klass)}
    aria-label=${label} title=${label} onClick=${click} ...${rest}>${children}</button>`;
}

/** Filter/scope chip (radius 4, 36 px). variant="lg" → 44 px method chip (radius 8). */
export function Chip({ active = false, variant, onClick, children, class: klass, ...rest }) {
  const click = (e) => { haptic('selection'); if (onClick) onClick(e); };
  return html`<button type="button" class=${cx(variant === 'lg' ? 'chip-lg' : 'chip', active && 'is-active', klass)}
    aria-pressed=${active ? 'true' : 'false'} onClick=${click} ...${rest}>${children}</button>`;
}

/** Segmented control: options [{ id, label }], value, onChange(id). */
export function Segmented({ options, value, onChange, tall = false, label, class: klass }) {
  return html`<div class=${cx('segmented', tall && 'is-tall', klass)} role="tablist" aria-label=${label}>
    ${options.map((o) => html`<button type="button" role="tab" key=${o.id} aria-selected=${o.id === value ? 'true' : 'false'}
      class=${o.id === value ? 'is-active' : ''}
      onClick=${() => { if (o.id !== value) { haptic('selection'); onChange && onChange(o.id); } }}>${o.label}</button>`)}
  </div>`;
}

/** Mono uppercase overline. tone: 'muted' (default) | 'accent' | 'error' | 'warn' */
export function Overline({ tone, children, class: klass, ...rest }) {
  return html`<span class=${cx('overline', tone && tone !== 'muted' && `is-${tone}`, klass)} ...${rest}>${children}</span>`;
}

/** Panel card (radius 8, hairline). variant: 'sunken' | 'accent' | 'flat' */
export function Card({ variant, title, children, class: klass, ...rest }) {
  return html`<div class=${cx('card', variant && `is-${variant}`, klass)} ...${rest}>
    ${title ? html`<span class="card-title">${title}</span>` : null}
    ${children}
  </div>`;
}

/** 4 px accent meter; animates its fill (transform) from `from` (default: no animation on mount). */
export function Meter({ value = 0, max = 1, from, label }) {
  const target = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const [shown, setShown] = useState(from !== undefined && max > 0 ? Math.max(0, Math.min(1, from / max)) : target);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(target)));
    return () => cancelAnimationFrame(id);
  }, [target]);
  return html`<div class="meter" role="meter" aria-valuemin="0" aria-valuemax=${max} aria-valuenow=${value} aria-label=${label}>
    <span style=${{ transform: `scaleX(${shown})` }}></span>
  </div>`;
}

/** Scale bar in µm (largest of 1/2/5/10/20/50… that fits maxPx). */
export function ScaleBar({ pxPerUm, maxPx = 120, steps, align = 'left' }) {
  if (!(pxPerUm > 0)) return null;
  const { um, px } = niceScale(pxPerUm, maxPx, steps);
  return html`<div class=${cx('scalebar', align === 'right' && 'is-right')} aria-label=${`Scale bar ${fmtUm(um)}`}>
    <i style=${{ width: `${px.toFixed(1)}px` }}></i><span>${fmtUm(um)}</span>
  </div>`;
}

/** Legend keys: items [{ label, kind: 'line'|'box', color }] (colour is a data-* token value). */
export function Legend({ items, class: klass }) {
  return html`<div class=${cx('legend', klass)}>
    ${items.map((it) => html`<span key=${it.label}>
      <span class=${it.kind === 'box' ? 'key-box' : 'key-line'} style=${it.color ? (it.kind === 'box' ? { borderColor: it.color } : { background: it.color }) : null}></span>${it.label}
    </span>`)}
  </div>`;
}

/** Settings-style switch: colour + word ("On"/"Off"). */
export function Toggle({ checked, onChange, label, hint }) {
  return html`<button type="button" class="switch" role="switch" aria-checked=${checked ? 'true' : 'false'}
    onClick=${() => { haptic('selection'); onChange && onChange(!checked); }}>
    <span class="stack-4"><span>${label}</span>${hint ? html`<span class="t-micro t-muted">${hint}</span>` : null}</span>
    <span class="switch-state">${checked ? 'On' : 'Off'}<span class="switch-track"></span></span>
  </button>`;
}

/** Mono warn chip "OFFLINE" for viewer overlays (shown when store.ui.online is false). */
export function OfflineChip({ force = false }) {
  const online = useStore((s) => s.ui.online);
  if (online && !force) return null;
  return html`<span class="chip-offline" role="status">Offline</span>`;
}

/** Micro banner (e.g. grace "Finish by 00:30 UTC"). */
export function Banner({ tone = 'warn', children, action }) {
  return html`<div class=${cx('banner', `is-${tone}`)} role="status"><span>${children}</span>${action || null}</div>`;
}

/** Server-corrected now (ms), re-rendering every intervalMs. */
export function useNow(intervalMs = 1000) {
  const [t, setT] = useState(serverNow());
  useEffect(() => {
    const id = setInterval(() => setT(serverNow()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

/** ms left until an ISO timestamp, ticking every second. */
export function useCountdown(toIso) {
  const t = useNow(1000);
  return toIso ? msUntil(toIso, t) : 0;
}

/** "HH:MM:SS" until an ISO timestamp, in mono. */
export function Countdown({ to, class: klass }) {
  const ms = useCountdown(to);
  return html`<span class=${cx('t-num', klass)} role="timer" aria-live="off">${fmtCountdown(ms)}</span>`;
}

/** Bottom tab bar: Today · Library · Ranks. Library shows "· N" when reviews are due. */
export function TabBar({ active, dueCount = 0 }) {
  const tabs = [
    { id: 'today', label: 'Today', href: '#/today' },
    { id: 'library', label: 'Library', href: '#/library', badge: dueCount > 0 ? ` · ${dueCount}` : '' },
    { id: 'ranks', label: 'Ranks', href: '#/ranks' },
  ];
  return html`<nav class="tabbar" aria-label="Main">
    ${tabs.map((t) => html`<a key=${t.id} href=${t.href} class=${cx('tab', active === t.id && 'is-active')}
      aria-current=${active === t.id ? 'page' : null}
      aria-label=${t.badge ? `${t.label}, ${dueCount} due for review` : t.label}
      onClick=${() => haptic('selection')}><span>${t.label}${t.badge ? html`<span class="tab-badge">${t.badge}</span>` : null}</span></a>`)}
  </nav>`;
}

/** Toast host: renders store.ui.toast ({ text, kind, glyph }). Use showToast() from store.js. */
export function Toast({ low = false }) {
  const toast = useStore((s) => s.ui.toast);
  if (!toast) return html`<div class=${cx('toast-host', low && 'is-low')} aria-live="polite"></div>`;
  const glyph = toast.glyph || (toast.kind === 'error' ? '✕' : toast.kind === 'warn' ? '!' : null);
  return html`<div class=${cx('toast-host', low && 'is-low')} aria-live="polite">
    <div key=${toast.id} class=${cx('toast', toast.kind && `is-${toast.kind}`)} role="status"
      onClick=${() => store.update('ui', { toast: null })}>
      ${glyph ? html`<span class="toast-glyph" aria-hidden="true">${glyph}</span>` : null}<span>${toast.text}</span>
    </div>
  </div>`;
}

/** Labelled placeholder used by stubs (and by viewers before data arrives). */
export function Placeholder({ title, note, children }) {
  return html`<div class="stub" role="note">
    <span class="overline">${title}</span>
    ${note ? html`<span class="t-micro t-muted">${note}</span>` : null}
    ${children}
  </div>`;
}
