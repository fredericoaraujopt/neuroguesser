// App store (ARCHITECTURE.md §4.1): one plain object, shallow top-level merges, subscribers, and a Preact
// hook that re-renders only when the selected slice changes (shallow compare).
import { useEffect, useReducer, useRef } from 'preact/hooks';
import * as idb from './idb.js';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  const api = {
    get: () => state,
    /** set(partial | (state) => partial): shallow merge at the top level (replace whole slices). */
    set(partial) {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      if (!patch) return state;
      state = { ...state, ...patch };
      for (const fn of [...subs]) {
        try { fn(state); } catch (err) { console.error(err); }
      }
      return state;
    },
    /** update(slice, partial | (sliceState) => partial): shallow merge inside one slice. */
    update(slice, partial) {
      return api.set((s) => {
        const cur = s[slice];
        const patch = typeof partial === 'function' ? partial(cur) : partial;
        return { [slice]: Array.isArray(cur) ? patch : { ...cur, ...patch } };
      });
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
  return api;
}

export const initialState = () => ({
  session: { deviceId: null, me: null, onboarded: false, settings: { haptics: true, celebrations: true } },
  today: {
    status: 'idle', date: null, dayNumber: null, now: null, nextRolloverAt: null, grace: null,
    rounds: [], progress: [], total: 0, roundsDone: 0, streak: 0, revealAck: [false, false, false, false, false], error: null,
    // additive (foundation): graceActive = the slice currently holds yesterday's grace day (date/dayNumber/
    // rounds/progress are then yesterday's); todayDate = the server's real today; fromCache = rendered from
    // the offline cache; loadedAt = ms of the last successful load.
    graceActive: false, todayDate: null, fromCache: false, loadedAt: 0,
  },
  reveals: {},
  library: { status: 'idle', data: null },
  ui: { toast: null, sheet: null, fullView: null, online: true },
});

export const store = createStore(initialState());

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
  return true;
}

const identity = (s) => s;

/** useStore(selector): Preact hook; re-renders when the selected value changes (shallow compare). */
export function useStore(selector = identity) {
  const selRef = useRef(selector);
  selRef.current = selector;
  const [, force] = useReducer((n) => n + 1, 0);
  const value = selector(store.get());
  const valRef = useRef(value);
  valRef.current = value;
  useEffect(() => {
    const check = (s) => {
      const next = selRef.current(s);
      if (!shallowEqual(next, valRef.current)) { valRef.current = next; force(); }
    };
    const unsub = store.subscribe(check);
    check(store.get()); // catch updates between render and subscription
    return unsub;
  }, []);
  return value;
}

// ---- persisted session helpers ----

/** Merge into session.settings and persist to IndexedDB ('settings'). */
export async function setSettings(partial) {
  const settings = { ...store.get().session.settings, ...partial };
  store.update('session', { settings });
  await idb.set('settings', settings);
  return settings;
}

/** Mark onboarding as finished (or skipped) on this device. */
export async function markOnboarded() {
  store.update('session', { onboarded: true });
  await idb.set('onboarded', true);
}

/** Load persisted session fields into the store (main.js calls this at boot). */
export async function hydrateSession() {
  const [settings, onboarded, me] = await Promise.all([idb.get('settings'), idb.get('onboarded'), idb.get('cache:me')]);
  const cur = store.get().session;
  store.update('session', {
    settings: { ...cur.settings, ...(settings || {}) },
    onboarded: !!onboarded,
    me: cur.me || me || null,
  });
}

// ---- ui helpers ----
let toastSeq = 0;
let toastTimer = null;

/** showToast(text, { kind: 'info'|'accent'|'warn'|'error', glyph, duration }) */
export function showToast(text, { kind = 'info', glyph = null, duration = 2600 } = {}) {
  const id = ++toastSeq;
  store.update('ui', { toast: { id, text, kind, glyph } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (store.get().ui.toast && store.get().ui.toast.id === id) store.update('ui', { toast: null });
  }, duration);
  return id;
}
export function hideToast() { clearTimeout(toastTimer); store.update('ui', { toast: null }); }

/** openSheet(id, props): id ∈ share | report | clueConfirm | libraryDetail | onboarding | milestone */
export function openSheet(id, props = {}) { store.update('ui', { sheet: { id, props } }); }
export function closeSheet() { store.update('ui', { sheet: null }); }
