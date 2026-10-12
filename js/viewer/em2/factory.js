// createEmView (em-v2-spec.md §8.1; ARCHITECTURE.md §4.4): the one entry point that picks the EM viewer for an `em`.
//   format 2  → EmStage
//   dual      → EmStage(em.v2); the format 1 EmViewer when the stage fails to initialise or load
//   format 1  → EmViewer (unchanged)
//   otherwise → "Update the app to see this EM" with a Reload button
// The screens use the Preact side (emKind + Em2View / the v1 EmPane + UpdateEm); createEmView is the imperative form
// (dev page, tests, any screen that is not a Preact tree). Kept in em2/ (this track's files); ARCHITECTURE §4.4 names
// it js/viewer/em-factory.js.
import { html } from '../../ui/html.js';
import { store } from '../../store.js';
import { parseEm, loadPlan, saveDataFrom } from './model.js';
import { prefetchEmAssets } from './loader.js';

export { parseEm } from './model.js';

export const UPDATE_TEXT = 'Update the app to see this EM';

/** 'v2' (format 2 or dual) | 'v1' | 'update' (an unknown format) | 'none' (no em yet). */
export function emKind(em) {
  const k = parseEm(em).kind;
  return k === 'unknown' ? 'update' : k;
}

/** Data saver: navigator.connection or Settings (session.settings.dataSaver). */
export function saveDataNow() {
  let setting = false;
  try { setting = !!store.get().session.settings.dataSaver; } catch (_) { /* */ }
  return saveDataFrom(typeof navigator !== 'undefined' ? navigator.connection : null, setting);
}

/**
 * Warm a round's first EM groups (levels 0 and L, ortho, outlines, stack A) as soon as `em` arrives (the /guess
 * response, during the celebration). Format 1 / unknown: nothing. Never rejects.
 */
export function prefetchEm(em) {
  const p = parseEm(em);
  if (p.kind !== 'v2') return Promise.resolve([]);
  const plan = loadPlan(p.v2, { saveData: saveDataNow() }).filter((it) => it.group <= 3 && it.gate === 'now');
  return prefetchEmAssets(plan.map((it) => it.asset), 'auto');
}

/** The "update the app" state (Preact): the message and a Reload button. */
export function UpdateEm({ onReload }) {
  const reload = onReload || (() => { try { location.reload(); } catch (_) { /* */ } });
  return html`<div class="em2-update" role="status">
    <span>${UPDATE_TEXT}</span>
    <button type="button" class="btn-text" onClick=${reload}>Reload</button>
  </div>`;
}

/**
 * Imperative factory → { kind: 'v2' | 'v1' | 'update' | 'none', stage, viewer, ready: Promise, dispose() }.
 * opts: { roundId, meshGlb (ArrayBuffer | Promise), mesh (dev geometry), done, voxelNm, layout, panel, saveData,
 *         blob: (path) → Promise<Blob> (format 1 assets; default api.assetBlob),
 *         impl: { v2(container, v2, opts), v1(container, v1, opts) } (tests: replaces the real viewers) }
 */
export async function createEmView(container, em, opts = {}) {
  const parsed = parseEm(em);
  const impl = { v2: makeV2, v1: makeV1, ...(opts.impl || {}) };
  const fallbackV1 = async (why) => {
    if (why) console.warn('[em] format 2 viewer failed, using format 1', why);
    return impl.v1(container, parsed.v1, opts);
  };
  if (parsed.kind === 'v2') {
    let view;
    try {
      view = await impl.v2(container, parsed.v2, opts);
    } catch (err) {
      if (parsed.dual && parsed.v1) return fallbackV1(err);
      const ready = Promise.reject(err);
      ready.catch(() => {});
      return { kind: 'v2', stage: null, viewer: null, ready, dispose() {} };
    }
    if (!(parsed.dual && parsed.v1)) return view;
    // a dual round whose stage fails to load (no level at all) falls back to format 1
    const ready = view.ready.then((v) => v, async (err) => {
      try { view.dispose(); } catch (_) { /* */ }
      const v1 = await fallbackV1(err);
      Object.assign(view, v1);
      return v1.ready;
    });
    ready.catch(() => {});
    return Object.assign(view, { ready });
  }
  if (parsed.kind === 'v1') return impl.v1(container, parsed.v1, opts);
  if (parsed.kind === 'none') return { kind: 'none', stage: null, viewer: null, ready: Promise.resolve(null), dispose() {} };
  // unknown format: a message, never a broken viewer
  const doc = container.ownerDocument || document;
  const box = doc.createElement('div');
  box.className = 'em2-update';
  box.setAttribute('role', 'status');
  const t = doc.createElement('span');
  t.textContent = UPDATE_TEXT;
  const b = doc.createElement('button');
  b.setAttribute('type', 'button');
  b.className = 'btn-text';
  b.textContent = 'Reload';
  b.addEventListener('click', () => { try { location.reload(); } catch (_) { /* */ } });
  box.appendChild(t);
  box.appendChild(b);
  container.appendChild(box);
  return { kind: 'update', stage: null, viewer: null, ready: Promise.resolve(null), dispose() { box.remove(); } };
}

/** The format 2 stage in `container`; ready resolves once level 0 is drawn, rejects on a stage error. */
async function makeV2(container, v2, opts) {
  const { EmStage } = await import('./stage.js');
  const stage = EmStage.acquire(opts.roundId || `em2-${Math.random().toString(36).slice(2)}`, {
    em: v2, meshGlb: opts.meshGlb || null, mesh: opts.mesh || null, done: !!opts.done, voxelNm: opts.voxelNm || null, saveData: !!opts.saveData,
  });
  if (stage._error) { stage.release(); throw new Error(stage._error); }
  const rec = stage.attach(container, { layout: opts.layout || 'single', panel: opts.panel || 'xy' });
  const ready = new Promise((resolve, reject) => {
    const off = stage.onEvent((ev) => {
      if (ev.type === 'item' && ev.id === 'level0' && ev.state === 'ready') { off(); resolve(stage); }
      if (ev.type === 'error') { off(); reject(new Error(ev.message)); }
    });
  });
  ready.catch(() => {});
  return { kind: 'v2', stage, viewer: null, ready, dispose() { stage.detach(rec); stage.release(); } };
}

async function makeV1(container, v1, opts) {
  const [{ EmViewer }, api] = await Promise.all([import('../em-viewer.js'), import('../../api.js')]);
  const get = opts.blob || api.assetBlob;
  const viewer = new EmViewer(container, { interactive: true, showMask: true });
  const opt = (p) => (p ? get(p).catch(() => null) : Promise.resolve(null));
  const ready = Promise.all([get(v1.atlas), opt(v1.mask), opt(v1.xz)])
    .then(([atlas, mask, xz]) => viewer.load({ atlas, mask, xz, fieldUm: v1.field_um || 8.192, nSlices: v1.n_slices || 32 }))
    .then(() => viewer);
  ready.catch(() => {});
  return { kind: 'v1', stage: null, viewer, ready, dispose() { viewer.dispose(); } };
}
