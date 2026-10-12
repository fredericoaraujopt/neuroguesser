// haptic(kind) (ARCHITECTURE.md §3.1). Best effort, never throws, no-op when unsupported or when
// Settings → Haptics is off.
//
//  - Android / Chrome: navigator.vibrate patterns.
//  - iOS Safari 18+ (no Vibration API): toggling a hidden <input type="checkbox" switch> gives one system
//    haptic tick; label.click() toggles it, so a pattern becomes 1–3 ticks ~80 ms apart.
//  iOS only fires inside a user gesture: call haptic('selection') synchronously in the tap handler and the
//  result haptic as soon as the response arrives.
import { store } from '../store.js';

export const KINDS = ['selection', 'light', 'success', 'error', 'celebrate'];

export const PATTERNS = Object.freeze({
  selection: 8,
  light: 12,
  success: [12, 60, 18],
  error: [30, 50, 30],
  celebrate: [10, 40, 10, 40, 30],
});

/** iOS switch ticks per kind (1–3, ~80 ms apart). */
export const TICKS = Object.freeze({ selection: 1, light: 1, success: 2, error: 3, celebrate: 3 });
export const TICK_GAP_MS = 80;

let iosSwitch = null;

function canVibrate() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** 'vibrate' | 'ios-switch' | 'none' */
export function hapticsSupport() {
  if (canVibrate()) return 'vibrate';
  if (isIOS() && typeof document !== 'undefined') return 'ios-switch';
  return 'none';
}

function ensureSwitch() {
  if (iosSwitch) return iosSwitch;
  const id = 'ng-haptic-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.id = id;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  const label = document.createElement('label');
  label.htmlFor = id;
  label.setAttribute('aria-hidden', 'true');
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
  box.append(input, label);
  document.body.appendChild(box);
  iosSwitch = { input, label };
  return iosSwitch;
}

function tick() {
  const { label } = ensureSwitch();
  const active = document.activeElement;
  label.click();
  if (active && active !== document.activeElement && typeof active.focus === 'function') active.focus({ preventScroll: true });
}

function enabled() {
  const s = store.get().session.settings;
  return !s || s.haptics !== false;
}

/** haptic('selection' | 'light' | 'success' | 'error' | 'celebrate'). Returns true when something fired. */
export function haptic(kind = 'selection') {
  try {
    if (!enabled() || !(kind in PATTERNS)) return false;
    const mode = hapticsSupport();
    if (mode === 'vibrate') return navigator.vibrate(PATTERNS[kind]) !== false;
    if (mode === 'ios-switch') {
      const n = TICKS[kind] || 1;
      tick();
      for (let i = 1; i < n; i++) setTimeout(() => { try { tick(); } catch (_) { /* ignore */ } }, i * TICK_GAP_MS);
      return true;
    }
  } catch (_) { /* best effort */ }
  return false;
}

export default haptic;
