// Full specimen view (handoff screen 2; ARCHITECTURE.md §3 "Full view"): an immersive overlay over the whole
// column (store.ui.fullView, rendered by app.js; the tab bar is hidden meanwhile).
//  - Ghost chrome only; a tap on the specimen (< 4 px) toggles all chrome, with "tap to show controls" while
//    hidden. ✕ or Escape closes; focus moves into the dialog, is trapped there and returns to the opener.
//  - 3D | EM switch (EM only once round_state.em exists). 3D: drag rotates (⟲) or pans (✥), ± zoom, Reset,
//    legend, live scale bar (µm), "1.0× · rotate". "Cell | In context" when the context is available (the paid
//    clue opened during the type stage, or the reveal's context — with siblings — once done).
//  - EM: XY | XZ, z-slider (1 px track, 12 × 24 ink thumb, ▲/▼ ±10 slices, readout "z 17/32"), "■ this cell"
//    mask toggle, ± zoom, scale bar. NO µm depth or thickness before the round is done; once done the readout
//    adds the depth from reveal.method.voxel_nm, and Neuroglancer ↗ appears (3D and EM).
//  - Safe-area insets on every edge.
//
// Openers: openFullView({ roundIndex, mode: '3d' | 'em' }) — additive optional fields: context (bool: open "In
// context"), plane ('xy' | 'xz'), slice (0-based), view (a MeshViewer getView() to continue from), emView, and
// round / state / reveal to show a round that is not in store.today (e.g. Library, Review).
// EM format 2 (em-v2-spec.md §8.4): the round's EmStage re-attached (same canvas, same section and view: no re-upload),
// its own chrome (js/viewer/em2/view.js); opener fields panel ('xy' | 'xz' | 'yz' | '3d') and preset (a reveal "Look
// again" item). Format 1 rounds (and a dual round whose stage failed) keep the EmViewer below.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { store, useStore } from '../store.js';
import { GhostButton, OfflineChip } from '../ui/components.js';
import { haptic } from '../fx/haptics.js';
import { motionAllowed } from '../fx/celebrate.js';
import * as api from '../api.js';
import { loadReveal } from '../game.js';
import { niceScale } from '../viewer/scalebar.js';
import { fmtUm } from '../format.js';
import { MeshViewer, setExclusiveHost } from '../viewer/mesh-viewer.js';
import { EmViewer } from '../viewer/em-viewer.js';
import { parseEm, UpdateEm } from '../viewer/em2/factory.js';

loadCss('css/viewer.css');

export function openFullView({ roundIndex, mode = '3d', ...rest } = {}) {
  store.update('ui', { fullView: { roundIndex, mode, ...rest } });
}
export function closeFullView() { store.update('ui', { fullView: null }); }

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/viewer-fullview.test.js)

/** Scale-bar steps: the handoff's 10/20/50/100/200/500 µm (3D) and 1/2/5/10/20 µm (EM), extended at both
 *  ends so the bar never overflows at 8× zoom or on a whole-brain context. */
export const SCALE_3D = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
export const SCALE_EM = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
export const SLICE_JUMP = 10;

/** What the overlay can show for a round: { done, mesh, em, context, siblingsLabel, neuroglancerUrl, voxelNm }. */
export function fullViewModel({ round = null, state = null, reveal = null } = {}) {
  const stage = state && state.stage ? state.stage : 'type';
  const done = stage === 'done';
  const parsed = parseEm(state && state.em);
  const em = parsed.v1 || null;                       // format 1 (a dual round's fallback too)
  const em2 = parsed.kind === 'v2' ? state.em : null; // format 2 or dual
  let context = null;
  const rc = done && reveal && reveal.context ? reveal.context : null;
  const sc = state && state.clues && state.clues.context ? state.clues.context : null;
  if (rc && rc.volume) {
    context = { volume: rc.volume, labels: rc.labels || null, offsetUm: rc.neuron_offset_um, siblings: rc.siblings || null, siblingsCount: rc.siblings_count || 0 };
  } else if (sc && sc.volume) {
    context = { volume: sc.volume, labels: sc.labels || null, offsetUm: sc.neuron_offset_um, siblings: null, siblingsCount: 0 };
  }
  const typeName = reveal && reveal.type ? reveal.type.name || reveal.type.dataset_label || null : null;
  return {
    stage,
    done,
    mesh: round && round.mesh && round.mesh.asset ? { asset: round.mesh.asset, bboxUm: round.mesh.bbox_um || null } : null,
    em,
    em2,
    emUnknown: parsed.kind === 'unknown',
    context,
    siblingsLabel: context && context.siblings && typeName ? `${typeName} · ${context.siblingsCount}` : null,
    neuroglancerUrl: done && reveal && reveal.neuron && reveal.neuron.neuroglancer_url ? reveal.neuron.neuroglancer_url : null,
    voxelNm: done && reveal && reveal.method && Array.isArray(reveal.method.voxel_nm) ? reveal.method.voxel_nm : null,
  };
}

/** '3d' | 'em' from an opener's mode (EM only when the model has it). */
export function normaliseMode(mode, model) {
  const m = String(mode || '3d').toLowerCase();
  if ((m === 'em' || m === 'xy' || m === 'xz' || m === 'yz') && model && (model.em || model.em2 || model.emUnknown)) return 'em';
  return '3d';
}

/** Modes for the 3D | EM switch. */
export function modesFor(model) {
  return [{ id: '3d', label: '3D' }, ...(model && (model.em || model.em2 || model.emUnknown) ? [{ id: 'em', label: 'EM' }] : [])];
}

/** "z 17/32" (1-based) and, only with a voxel size (after done), the depth "0.64 µm deep". */
export function zReadout(slice, nSlices, voxelNm = null) {
  const n = Math.max(1, Math.floor(nSlices) || 1);
  const k = Math.max(0, Math.min(n - 1, Math.round(slice) || 0));
  const zNm = Array.isArray(voxelNm) ? Number(voxelNm[2]) : NaN;
  return { z: `z ${k + 1}/${n}`, depth: zNm > 0 ? `${((k * zNm) / 1000).toFixed(2)} µm deep` : null };
}

/** Slice index for a pointer at `frac` (0 = top … 1 = bottom) of the slider track. */
export const sliceAt = (frac, nSlices) => Math.max(0, Math.min(nSlices - 1, Math.round(Math.max(0, Math.min(1, frac)) * (nSlices - 1))));

export const zoomText = (z) => `${(Number(z) || 1).toFixed(1)}×`;

// ---------------------------------------------------------------------------------------------------------

function InlineScale({ pxPerUm, steps, maxPx }) {
  if (!(pxPerUm > 0)) return null;
  const { um, px } = niceScale(pxPerUm, maxPx, steps);
  return html`<span class="fv-scale" aria-label=${`Scale bar ${fmtUm(um)}`}><i style=${{ width: `${px.toFixed(1)}px` }}></i><span>${fmtUm(um)}</span></span>`;
}

function ZSlider({ slice, nSlices, onSlice, onStep }) {
  const trackRef = useRef(null);
  const drag = useRef(false);
  const lastTick = useRef(0);
  const set = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    const k = sliceAt((e.clientY - r.top - 12) / Math.max(1, r.height - 24), nSlices);
    if (k !== slice) {
      const t = performance.now();
      if (t - lastTick.current > 40) { haptic('selection'); lastTick.current = t; }
      onSlice(k);
    }
  };
  const key = (e) => {
    const map = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1, PageUp: -SLICE_JUMP, PageDown: SLICE_JUMP };
    if (e.key in map) { e.preventDefault(); onStep(map[e.key]); } else if (e.key === 'Home') { e.preventDefault(); onSlice(0); } else if (e.key === 'End') { e.preventDefault(); onSlice(nSlices - 1); }
  };
  const frac = nSlices > 1 ? slice / (nSlices - 1) : 0;
  const { z } = zReadout(slice, nSlices);
  return html`<div class="fv-z">
    <${GhostButton} label="Previous slices" size="sm" onClick=${() => { haptic('selection'); onStep(-SLICE_JUMP); }}>▲</${GhostButton}>
    <div class="fv-z-track" ref=${trackRef} role="slider" tabindex="0" aria-label="Slice" aria-orientation="vertical"
      aria-valuemin="1" aria-valuemax=${nSlices} aria-valuenow=${slice + 1} aria-valuetext=${`slice ${slice + 1} of ${nSlices}`}
      onKeyDown=${key}
      onPointerDown=${(e) => { drag.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* */ } set(e); }}
      onPointerMove=${(e) => { if (drag.current) set(e); }}
      onPointerUp=${() => { drag.current = false; }} onPointerCancel=${() => { drag.current = false; }}>
      <span class="fv-z-line"></span>
      <span class="fv-z-thumb" style=${{ top: `calc((100% - 24px) * ${frac.toFixed(4)})` }}></span>
    </div>
    <${GhostButton} label="Next slices" size="sm" onClick=${() => { haptic('selection'); onStep(SLICE_JUMP); }}>▼</${GhostButton}>
    <span class="fv-z-read">${z}</span>
  </div>`;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function FullView(props) {
  const { roundIndex, onClose = closeFullView } = props;
  const fromStore = useStore((s) => {
    const i = (Number(roundIndex) || 0) - 1;
    const r = i >= 0 ? s.today.rounds[i] || null : null;
    return { round: r, state: i >= 0 ? s.today.progress[i] || null : null, reveal: r ? s.reveals[r.round_id] || null : null };
  });
  const round = props.round || fromStore.round;
  const state = props.state || fromStore.state;
  const reveal = props.reveal || fromStore.reveal;
  const model = useMemo(() => fullViewModel({ round, state, reveal }), [round, state, reveal]);

  const [mode, setModeState] = useState(() => normaliseMode(props.mode, model));
  const [ctxOn, setCtxOn] = useState(() => !!(props.context || String(props.mode) === 'context'));
  const [plane, setPlane] = useState(props.plane === 'xz' || props.mode === 'xz' ? 'xz' : 'xy');
  const [chrome, setChrome] = useState(true);
  const [dragMode, setDragMode] = useState('rotate');
  const [layers, setLayers] = useState({ volume: true, siblings: true, labels: true });
  const [mask, setMask] = useState(true);
  const [mv, setMv] = useState(null);
  const [ev, setEv] = useState(null);
  const [ctxInfo, setCtxInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [emMissing, setEmMissing] = useState({ mask: false, xz: false });   // optional EM parts that failed to load
  const [still] = useState(() => !motionAllowed());
  const [em2Mod, setEm2Mod] = useState(null);       // js/viewer/em2/view.js (format 2), loaded on demand
  const [em2Failed, setEm2Failed] = useState(false); // a dual round whose stage failed → format 1

  const rootRef = useRef(null);
  const hostRef = useRef(null);
  const meshRef = useRef(null);
  const emRef = useRef(null);
  const savedMesh = useRef(props.view || null);
  const savedEm = useRef({ slice: Number.isFinite(props.slice) ? props.slice : null, view: props.emView || null });
  const dragRef = useRef(dragMode); dragRef.current = dragMode;
  const planeRef = useRef(plane); planeRef.current = plane;
  const maskRef = useRef(mask); maskRef.current = mask;

  const v2 = !!model.em2 && !em2Failed;
  const effMode = mode === 'em' && !model.em && !model.em2 && !model.emUnknown ? '3d' : mode;
  const contextShown = effMode === '3d' && ctxOn && !!model.context;
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);
  const setMode = (m) => { if (m !== effMode) { haptic('selection'); setModeState(m); } };

  // a new opener call while open (same overlay instance) switches mode / context / plane
  const firstProps = useRef(true);
  useEffect(() => {
    if (firstProps.current) { firstProps.current = false; return; }
    setModeState(normaliseMode(props.mode, model));
    if (props.context !== undefined || String(props.mode) === 'context') setCtxOn(!!(props.context || String(props.mode) === 'context'));
    if (props.plane) setPlane(props.plane === 'xz' ? 'xz' : 'xy');
  }, [props.mode, props.context, props.plane, roundIndex]);

  // reveal (Neuroglancer link, voxel size, siblings) once done
  useEffect(() => {
    if (!props.reveal && model.done && !fromStore.reveal && roundIndex) loadReveal(roundIndex).catch(() => {});
  }, [model.done, roundIndex]);

  // the overlay is opaque: viewers under it (the round's auto-rotating mesh) stop rendering until it closes
  useEffect(() => {
    setExclusiveHost(rootRef.current);
    return () => setExclusiveHost(null);
  }, []);

  // focus: into the dialog on open, trapped while open, back to the opener on close; Escape closes
  useEffect(() => {
    const prev = typeof document !== 'undefined' ? document.activeElement : null;
    const t = setTimeout(() => { if (rootRef.current) rootRef.current.focus({ preventScroll: true }); }, 0);
    const onKey = (e) => {
      const root = rootRef.current;
      if (!root) return;
      // a sheet opened over the full view (app.js draws sheets above it) owns the keyboard: its Escape must not
      // close the view underneath, and its own Tab trap must not be pulled back into this one
      if ([...document.querySelectorAll('[aria-modal="true"]')].some((d) => d !== root && !root.contains(d))) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      setChrome(true);
      const list = [...rootRef.current.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[inert]') && el.getClientRects().length);
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0], last = list[list.length - 1];
      const inside = rootRef.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);

  // ---- 3D viewer ----
  const meshAsset = model.mesh ? model.mesh.asset : null;
  useEffect(() => {
    if (effMode !== '3d' || !meshAsset || !hostRef.current) return undefined;
    setStatus(null);
    const v = new MeshViewer(hostRef.current, { autoRotate: false, interactive: true, initialView: savedMesh.current || undefined });
    meshRef.current = v;
    v.setDragMode(dragRef.current);
    const offC = v.onChange((e) => setMv(e));
    const offT = v.onTap(toggleChrome);
    let alive = true;
    api.assetArrayBuffer(meshAsset)
      .then((buf) => (alive ? v.loadNeuron(buf, { bboxUm: model.mesh.bboxUm }) : null))
      .catch((err) => { if (alive) { console.warn('[fullview] mesh', err); setStatus(err && err.isNetwork ? 'Offline · the mesh is not cached yet' : 'Could not load the mesh'); } });
    return () => {
      alive = false;
      savedMesh.current = v.getView();
      offC(); offT();
      v.dispose();
      if (meshRef.current === v) meshRef.current = null;
    };
  }, [effMode, meshAsset]);

  const c = model.context;
  const ctxKey = c ? `${c.volume}|${c.labels}|${c.siblings}` : '';
  useEffect(() => {
    const v = meshRef.current;
    if (effMode !== '3d' || !v) return undefined;
    if (!contextShown) { v.setContext(null); return undefined; }
    let alive = true;
    Promise.all([api.assetArrayBuffer(c.volume), c.labels ? api.assetJSON(c.labels) : Promise.resolve(null)])
      .then(([volume, labels]) => {
        if (!alive) return null;
        setCtxInfo({ planes: !!(labels && labels.planes && labels.planes.length), points: !!(labels && labels.points && labels.points.length) });
        return v.setContext({ volume, labels, offsetUm: c.offsetUm });
      })
      .catch((err) => { if (alive) { console.warn('[fullview] context', err); setStatus('Could not load the context'); } });
    if (c.siblings) {
      api.assetArrayBuffer(c.siblings).then((buf) => (alive ? v.setSiblings(buf) : null)).catch((err) => console.warn('[fullview] siblings', err));
    }
    return () => { alive = false; };
  }, [effMode, contextShown, ctxKey, meshAsset]);

  useEffect(() => { if (meshRef.current) meshRef.current.setLayers(layers); }, [layers, effMode]);
  useEffect(() => { if (meshRef.current) meshRef.current.setDragMode(dragMode); }, [dragMode, effMode]);

  // ---- EM format 2: the round's stage (view.js) ----
  useEffect(() => {
    if (effMode !== 'em' || !v2 || em2Mod) return undefined;
    let alive = true;
    import('../viewer/em2/view.js').then((m) => { if (alive) setEm2Mod(m); }, (err) => {
      console.warn('[fullview] em2', err);
      if (alive) { if (model.em) setEm2Failed(true); else setStatus('Could not load the EM'); }
    });
    return () => { alive = false; };
  }, [effMode, v2]);

  // ---- EM viewer (format 1) ----
  const em = v2 || model.emUnknown ? null : model.em;
  const emKey = em ? em.atlas : null;
  useEffect(() => {
    if (effMode !== 'em' || !em || !hostRef.current) return undefined;
    setStatus(null);
    const v = new EmViewer(hostRef.current, { interactive: true, showMask: maskRef.current, fit: 'cover' });
    emRef.current = v;
    v.setPlane(planeRef.current);
    const offC = v.onChange((e) => setEv(e));
    const offT = v.onTap(toggleChrome);
    let alive = true;
    // the mask and the XZ reslice are optional extras: a failed one hides its control, never the EM itself
    const opt = (p) => (p ? api.assetBlob(p).catch((err) => { console.warn('[fullview] em part', err); return null; }) : null);
    Promise.all([api.assetBlob(em.atlas), opt(em.mask), opt(em.xz)])
      .then(([atlas, maskBlob, xz]) => (alive ? v.load({ atlas, mask: maskBlob, xz, fieldUm: em.field_um || 8.192, nSlices: em.n_slices || 32 }) : null))
      .then(() => {
        if (!alive) return;
        const missing = { mask: !!em.mask && !v.hasMask(), xz: !!em.xz && !v.hasXz() };
        setEmMissing(missing);
        if (missing.xz && planeRef.current === 'xz') setPlane('xy');
        const s = savedEm.current;
        if (Number.isFinite(s.slice)) v.setSlice(s.slice);
        if (s.view) v.setView(s.view);
      })
      .catch((err) => { if (alive) { console.warn('[fullview] em', err); setStatus(err && err.isNetwork ? 'Offline · the EM is not cached yet' : 'Could not load the EM'); } });
    return () => {
      alive = false;
      savedEm.current = { slice: v.getSlice(), view: v.getView() };
      offC(); offT();
      v.dispose();
      if (emRef.current === v) emRef.current = null;
    };
  }, [effMode, emKey]);
  useEffect(() => { if (emRef.current) emRef.current.setPlane(plane); }, [plane, effMode]);
  useEffect(() => { if (emRef.current) emRef.current.setMaskVisible(mask); }, [mask, effMode]);

  // ---- chrome ----
  const zoomIn = () => { haptic('selection'); const v = effMode === 'em' ? emRef.current : meshRef.current; if (v) v.zoomBy(1.25); };
  const zoomOut = () => { haptic('selection'); const v = effMode === 'em' ? emRef.current : meshRef.current; if (v) v.zoomBy(0.8); };
  const reset = () => { haptic('selection'); const v = effMode === 'em' ? emRef.current : meshRef.current; if (v) v.resetView(); };
  const flipDrag = () => { haptic('selection'); setDragMode((m) => (m === 'rotate' ? 'pan' : 'rotate')); };
  const toggleLayer = (k) => { haptic('selection'); setLayers((l) => ({ ...l, [k]: !l[k] })); };
  const ng = model.neuroglancerUrl;
  const ngLink = ng ? html`<a class="btn-ghost fv-ng" href=${ng} target="_blank" rel="noopener noreferrer" aria-label="Open in Neuroglancer" title="Open in Neuroglancer">↗</a>` : null;
  const slice = ev ? ev.slice : 16;
  const nSlices = ev ? ev.nSlices : (em && em.n_slices) || 32;
  const zr = zReadout(slice, nSlices, model.voxelNm);
  const hasMask = !!(em && em.mask) && !emMissing.mask;

  const sub = effMode === '3d'
    ? (model.context ? [{ id: 'cell', label: 'Cell', on: !ctxOn }, { id: 'ctx', label: 'In context', on: ctxOn }] : null)
    : [{ id: 'xy', label: 'XY', on: plane === 'xy' }, ...(em && em.xz && !emMissing.xz ? [{ id: 'xz', label: 'XZ', on: plane === 'xz' }] : [])];
  const onSub = (id) => {
    haptic('selection');
    if (id === 'cell') setCtxOn(false);
    else if (id === 'ctx') setCtxOn(true);
    else setPlane(id);
  };

  const legend3d = [
    html`<span key="n"><span class="key-line"></span>neuron</span>`,
    contextShown && layers.volume ? html`<span key="v"><span class="key-box"></span>volume</span>` : null,
    contextShown && layers.siblings && model.siblingsLabel ? html`<span key="s"><span class="key-line is-sky"></span>same type</span>` : null,
  ];
  const regionsWord = ctxInfo && !ctxInfo.planes && ctxInfo.points ? 'Regions' : 'Layers';

  return html`<div class=${cx('full-overlay', 'fv', still ? 'is-still' : 'fv-enter', `fv-mode-${effMode}`)} ref=${rootRef}
      role="dialog" aria-modal="true" aria-label="Full specimen view" tabindex="-1">
    <div class="fv-stage" ref=${hostRef}></div>
    ${effMode === 'em' && v2 && em2Mod ? html`<${em2Mod.Em2View} mode="full" roundId=${round ? round.round_id : `round-${roundIndex}`} em=${state.em}
      meshAsset=${round && round.mesh ? round.mesh.asset : null} done=${model.done} voxelNm=${model.voxelNm} preset=${props.preset || null}
      initial=${{ panel: props.panel || (props.plane === 'xz' ? 'xz' : null), section: Number.isInteger(props.slice) ? props.slice : null }}
      chrome=${chrome} onTap=${toggleChrome} onFail=${model.em ? () => setEm2Failed(true) : null} />` : null}
    ${effMode === 'em' && model.emUnknown ? html`<${UpdateEm} />` : null}
    ${status ? html`<div class="fv-status" role="status">${status}</div>` : null}

    <div class=${cx('fv-chrome', !chrome && 'is-hidden')} inert=${!chrome}>
      <div class="fv-top">
        <div class="fv-top-left">
          <${GhostButton} label="Close full view" onClick=${() => { haptic('selection'); onClose(); }}>✕</${GhostButton}>
          <${OfflineChip} />
          ${effMode === 'em' && (v2 || model.emUnknown) ? ngLink : null}
        </div>
        <div class="text-switch" role="tablist" aria-label="View">
          ${modesFor(model).map((m) => html`<button key=${m.id} type="button" role="tab" aria-selected=${effMode === m.id ? 'true' : 'false'}
            class=${effMode === m.id ? 'is-active' : ''} onClick=${() => setMode(m.id)}>${m.label}</button>`)}
        </div>
      </div>
      ${sub && sub.length > 1 && !(effMode === 'em' && (v2 || model.emUnknown)) ? html`<div class="fv-sub text-switch" role="tablist" aria-label=${effMode === 'em' ? 'Plane' : 'Context'}>
        ${sub.map((s) => html`<button key=${s.id} type="button" role="tab" aria-selected=${s.on ? 'true' : 'false'}
          class=${s.on ? 'is-active' : ''} onClick=${() => { if (!s.on) onSub(s.id); }}>${s.label}</button>`)}
      </div>` : null}

      ${effMode === '3d' ? html`
        <div class="fv-col">
          <${GhostButton} label="Zoom in" size="lg" onClick=${zoomIn}>+</${GhostButton}>
          <${GhostButton} label="Zoom out" size="lg" onClick=${zoomOut}>−</${GhostButton}>
          <${GhostButton} label=${dragMode === 'rotate' ? 'Drag rotates · switch to pan' : 'Drag pans · switch to rotate'} onClick=${flipDrag}
            aria-pressed=${dragMode === 'pan' ? 'true' : 'false'}>${dragMode === 'rotate' ? '⟲' : '✥'}</${GhostButton}>
          <${GhostButton} label="Reset view" size="sm" onClick=${reset}>Reset</${GhostButton}>
          ${ngLink}
        </div>
        <div class=${cx('fv-info', contextShown && 'has-toggles')}>
          <div class="legend">${legend3d}</div>
          <${InlineScale} pxPerUm=${mv && mv.pxPerUm} steps=${SCALE_3D} maxPx=${120} />
          <span class="fv-read">${zoomText(mv && mv.zoom)} · ${dragMode}</span>
        </div>
        ${contextShown ? html`<div class="fv-toggles toggle-row">
          <button type="button" aria-pressed=${layers.volume ? 'true' : 'false'} onClick=${() => toggleLayer('volume')}>${layers.volume ? '✓ ' : ''}Volume</button>
          ${model.siblingsLabel ? html`<button type="button" aria-pressed=${layers.siblings ? 'true' : 'false'} onClick=${() => toggleLayer('siblings')}><span class="fv-ellipsis">${layers.siblings ? '✓ ' : ''}${model.siblingsLabel}</span></button>` : null}
          ${ctxInfo && (ctxInfo.planes || ctxInfo.points) ? html`<button type="button" aria-pressed=${layers.labels ? 'true' : 'false'} onClick=${() => toggleLayer('labels')}>${layers.labels ? '✓ ' : ''}${regionsWord}</button>` : null}
        </div>` : null}
      ` : v2 || model.emUnknown ? null : html`
        ${plane === 'xy' ? html`<${ZSlider} slice=${slice} nSlices=${nSlices}
          onSlice=${(k) => emRef.current && emRef.current.setSlice(k)} onStep=${(d) => emRef.current && emRef.current.step(d)} />` : null}
        <div class="fv-col">
          <${GhostButton} label="Zoom in" size="lg" onClick=${zoomIn}>+</${GhostButton}>
          <${GhostButton} label="Zoom out" size="lg" onClick=${zoomOut}>−</${GhostButton}>
          <${GhostButton} label="Reset view" size="sm" onClick=${reset}>Reset</${GhostButton}>
          ${ngLink}
        </div>
        <div class="fv-info">
          ${plane === 'xy' && hasMask ? html`<button type="button" class="fv-key-btn" aria-pressed=${mask ? 'true' : 'false'}
            aria-label="Highlight this cell" onClick=${() => { haptic('selection'); setMask((m) => !m); }}>
            <span class=${cx('key-mask', !mask && 'is-off')}></span>${mask ? 'this cell' : 'this cell · hidden'}</button>` : null}
          <${InlineScale} pxPerUm=${ev && ev.pxPerUm} steps=${SCALE_EM} maxPx=${130} />
          <span class="fv-read">${zoomText(ev && ev.zoom)} · ${plane === 'xz' ? 'XZ reslice' : zr.depth || 'XY'}</span>
        </div>
      `}
    </div>
    ${chrome ? null : html`<div class="fv-hint" aria-hidden="true"><span>tap to show controls</span></div>`}
  </div>`;
}
