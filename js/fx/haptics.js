// haptic(kind) (ARCHITECTURE.md §3.1). Best effort, never throws, no-op when unsupported or when
// Settings → Haptics is off.
//
//  - Android / Chrome: navigator.vibrate patterns.
//  - iOS Safari 18+ (no Vibration API): toggling an <input type="checkbox" switch> gives one system haptic tick.
//    Each tick builds a fresh <label><input switch></label> (display:none, in <head>), clicks the label and removes
//    it, as the widely used ios-haptics approach does; a pattern becomes 1–3 ticks ~80 ms apart. (v0.7.2: the earlier
//    single off-screen switch in <body> gave no tick on an installed iOS 27 app; dev/haptics.html compares both.)
//  - iOS 26.5+ treats those script clicks as untrusted and gives no tick at all; only a real finger tap that toggles a
//    switch does. So tappable controls carry <Tick /> (ui/components.js): an invisible native switch laid over the
//    control. The real tap toggles it (one tick), onTapTick stops that click and re-sends it to the control, whose
//    own haptic() then skips its first, duplicate tick. On 26.5+ result haptics after a response and multi-tick
//    patterns give nothing; on older iOS they still tick as before.
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

let legacySwitch = null;
let realTickAt = -Infinity;
/** A tap on a <Tick /> switch within this many ms counts as the first tick of the control's own haptic(). */
export const REAL_TICK_MS = 300;

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

/** One iOS tick: a fresh hidden switch inside its label, clicked and removed (the default). */
function freshTick() {
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.append(input);
  const host = document.head || document.body;
  host.appendChild(label);
  try { label.click(); } finally { if (label.parentNode) label.parentNode.removeChild(label); }
}

/** The pre-0.7.2 method (one persistent off-screen switch), kept for dev/haptics.html comparisons. */
function legacyTick() {
  if (!legacySwitch) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.id = 'ng-haptic-switch';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.setAttribute('aria-hidden', 'true');
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    box.append(input, label);
    document.body.appendChild(box);
    legacySwitch = { label };
  }
  legacySwitch.label.click();
}

/** One iOS haptic tick; method 'fresh' (default) or 'legacy'. Keeps keyboard focus where it was. */
export function iosTick(method = 'fresh') {
  const active = document.activeElement;
  if (method === 'legacy') legacyTick(); else freshTick();
  if (active && active !== document.activeElement && typeof active.focus === 'function') active.focus({ preventScroll: true });
}

/**
 * Click handler of the <Tick /> overlay switch: the real tap already toggled it (iOS gives the tick), so stop that
 * click and re-send it to the control underneath, which then runs its usual handlers (an <a> follows its href).
 */
export function onTapTick(e) {
  e.stopPropagation();
  realTickAt = Date.now();
  const el = e.currentTarget;
  const host = el && el.parentElement;
  if (!host) return;
  // focus goes where a tap on the control itself would put it (sheets hand focus back to their opener)
  if (typeof document !== 'undefined' && document.activeElement === el && typeof host.focus === 'function') host.focus({ preventScroll: true });
  if (typeof host.click === 'function') host.click();
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
      if (Date.now() - realTickAt > REAL_TICK_MS) iosTick();
      realTickAt = -Infinity;
      for (let i = 1; i < n; i++) setTimeout(() => { try { iosTick(); } catch (_) { /* ignore */ } }, i * TICK_GAP_MS);
      return true;
    }
  } catch (_) { /* best effort */ }
  return false;
}

export default haptic;
