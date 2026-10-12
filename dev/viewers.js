// Dev page: every viewer mode on REAL fixture assets from the dev stack (scripts/dev-up.sh), through the app's
// own api.js. For the screen tracks (round, reveal, library/review) to see the viewers' API in use.
//  - Mesh: today's rounds (/v1/day/<today>, public mesh assets).
//  - Context, siblings, EM, graph, full view "done": the previous (closed) day. Its reveal and clue/EM assets are
//    public because the day is closed, but the EM/graph asset PATHS only reach a device through its round state;
//    "Prepare" plays that round on a separate dev-only device (localStorage 'ng-dev-viewers-device', never the
//    app's own device) with X-NG-Debug-Now set inside that day (≤ 2 POST/s), then reads its progress.
// Nothing here ships to players.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, render, cx } from '../js/ui/html.js';
import { store, useStore, hydrateSession } from '../js/store.js';
import { Segmented, Chip, Button, GhostButton, ScaleBar } from '../js/ui/components.js';
import * as api from '../js/api.js';
import { config } from '../config.js';
import { addDays } from '../js/time.js';
import { MeshViewer } from '../js/viewer/mesh-viewer.js';
import { EmViewer } from '../js/viewer/em-viewer.js';
import { GraphView } from '../js/viewer/graph-view.js';
import FullView, { openFullView, closeFullView, zReadout } from '../js/screens/fullview.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- dev-only device for the closed-day round state ----
const DEV_KEY = 'ng-dev-viewers-device';
function devDevice() {
  let id = null;
  try { id = localStorage.getItem(DEV_KEY); } catch (_) { /* private mode */ }
  if (!id) { id = crypto.randomUUID(); try { localStorage.setItem(DEV_KEY, id); } catch (_) { /* */ } }
  return id;
}
async function devFetch(path, { method = 'GET', body, now } = {}) {
  const headers = { 'X-NG-Device': devDevice() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (now) headers['X-NG-Debug-Now'] = now;
  const res = await fetch(config.apiBase + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error((json && json.error && json.error.message) || `HTTP ${res.status}`); e.status = res.status; e.body = json; throw e; }
  return json;
}
/** Play one round of `date` to done on the dev device: guesses a…f until the type stage ends, then skip the method. */
async function playToDone(round, date, log) {
  // A debug clock inside `date` that advances in real time (the Worker's rate-limit windows follow the request
  // clock: a frozen instant would put every POST in one window → 429), offset per run so runs never share one.
  const base = Date.parse(`${date}T01:00:00.000Z`) + (Date.now() % (20 * 3600e3));
  const t0 = Date.now();
  const clock = () => new Date(base + (Date.now() - t0)).toISOString();
  let state = null;
  for (const option of ['a', 'b', 'c', 'd', 'e', 'f']) {
    try {
      const r = await devFetch(`/v1/round/${round.round_id}/guess`, { method: 'POST', body: { option }, now: clock() });
      state = r.state;
      log(`guess ${option} → ${r.correct ? 'correct' : 'wrong'}`);
    } catch (e) {
      if (e.body && e.body.state) state = e.body.state;
      log(`guess ${option} → ${e.status} ${e.body && e.body.error ? e.body.error.code : ''}`);
    }
    await sleep(600);
    if (state && state.stage !== 'type') break;
  }
  if (state && state.stage === 'method') {
    await devFetch(`/v1/round/${round.round_id}/method`, { method: 'POST', body: { method: null }, now: clock() });
    log('method → skipped');
    await sleep(600);
  }
}

// ---- data ----
function useData() {
  const [d, setD] = useState({ status: 'loading' });
  const reload = async () => {
    try {
      const t = await api.getToday();
      const past = addDays(t.date, -1);
      const [today, yday, prog] = await Promise.all([api.getDay(t.date), api.getDay(past), devFetch(`/v1/day/${past}/progress`)]);
      const reveals = await Promise.all(yday.rounds.map((r) => api.getReveal(r.round_id).catch(() => null)));
      setD({ status: 'ready', today, past: yday, pastProgress: prog.rounds, reveals });
    } catch (err) {
      console.error(err);
      setD({ status: 'error', error: String(err && err.message || err) });
    }
  };
  useEffect(() => { reload(); }, []);
  return [d, reload];
}

// ---- small UI helpers ----
function RoundChips({ n, value, onChange, labelOf }) {
  return html`<div class="dv-chips">${Array.from({ length: n }, (_, i) => html`<${Chip} key=${i} active=${value === i + 1}
    onClick=${() => onChange(i + 1)}>${labelOf ? labelOf(i + 1) : `Round ${i + 1}`}</${Chip}>`)}</div>`;
}
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

// ---- A. inline mesh viewer (round screen replica) ----
function MeshDemo({ day }) {
  const [idx, setIdx] = useState(2);
  const [info, setInfo] = useState({});
  const [view, setView] = useState(null);
  const [drag, setDrag] = useState('rotate');
  const hostRef = useRef(null);
  const vRef = useRef(null);
  const round = day.rounds[idx - 1];
  useEffect(() => {
    const v = new MeshViewer(hostRef.current, { autoRotate: true });
    vRef.current = v;
    const off = v.onChange(setView);
    const offTap = v.onTap(({ x, y }) => setInfo((i) => ({ ...i, tap: `${Math.round(x)}, ${Math.round(y)}` })));
    let alive = true;
    const t0 = performance.now();
    api.assetArrayBuffer(round.mesh.asset).then(async (buf) => {
      const t1 = performance.now();
      await v.loadNeuron(buf, { bboxUm: round.mesh.bbox_um });
      if (!alive) return;
      setInfo({ fetch: t1 - t0, parse: performance.now() - t1, tris: v.stats().triangles });
      v.resetStats();
      await sleep(3000);
      if (alive) setInfo((i) => ({ ...i, frame: v.stats() }));
    }).catch((e) => setInfo({ error: String(e) }));
    return () => { alive = false; off(); offTap(); v.dispose(); vRef.current = null; };
  }, [round && round.round_id]);
  const v = () => vRef.current;
  return html`<div class="dv-row">
    <div class="dv-frame">
      <div class="viewer-canvas" ref=${hostRef}></div>
      <div class="viewer-top"><span class="viewer-label">#${day.day_number} · ${idx}/5</span><span class="viewer-points">1,000 <small>pts</small></span></div>
      <div class="legend viewer-legend"><span><span class="key-line"></span>neuron</span></div>
      <div class="viewer-expand"><${GhostButton} label="Full view" onClick=${() => {
        store.update('today', { status: 'ready', date: day.date, dayNumber: day.day_number, rounds: day.rounds, progress: [null, null, null, null, null] });
        openFullView({ roundIndex: idx, mode: '3d', view: v() ? v().getView() : undefined });
      }}>⤢</${GhostButton}></div>
      <div class="dv-scale">${view ? html`<${ScaleBar} pxPerUm=${view.pxPerUm} align="right" steps=${[1, 2, 5, 10, 20, 50, 100, 200, 500]} />` : null}</div>
    </div>
    <div class="dv-side">
      <${RoundChips} n=${5} value=${idx} onChange=${setIdx} labelOf=${(i) => `${i} · ${(day.rounds[i - 1].mesh.n_triangles / 1000).toFixed(0)}k`} />
      <div class="dv-chips">
        <${Button} variant="outline" size="sm" onClick=${() => v().zoomBy(1.25)}>Zoom +</${Button}>
        <${Button} variant="outline" size="sm" onClick=${() => v().zoomBy(0.8)}>Zoom −</${Button}>
        <${Button} variant="outline" size="sm" onClick=${() => { const m = drag === 'rotate' ? 'pan' : 'rotate'; setDrag(m); v().setDragMode(m); }}>${drag === 'rotate' ? '⟲ rotate' : '✥ pan'}</${Button}>
        <${Button} variant="outline" size="sm" onClick=${() => v().resetView()}>Reset</${Button}>
        <${Button} variant="outline" size="sm" onClick=${() => v().stopAutoRotate()}>Stop rotation</${Button}>
      </div>
      <div class="dv-kv">
        <span>triangles</span><span>${info.tris ?? '…'} (bake: ${round.mesh.n_triangles})</span>
        <span>fetch / parse+normals</span><span>${fmt(info.fetch, 0)} ms / ${fmt(info.parse, 0)} ms</span>
        <span>frame (3 s rotating)</span><span>${info.frame ? `${fmt(info.frame.avgMs, 1)} ms avg · ${fmt(info.frame.maxMs, 1)} max · ${info.frame.frames} frames` : '…'}</span>
        <span>view</span><span>${view ? `yaw ${fmt(view.yaw)} · tilt ${fmt(view.tilt)} · ${fmt(view.zoom, 1)}× · pan ${fmt(view.panX, 1)},${fmt(view.panY, 1)} µm` : '—'}</span>
        <span>pxPerUm</span><span>${view ? fmt(view.pxPerUm, 3) : '—'}</span>
        <span>last tap</span><span>${info.tap || '—'}</span>
        ${info.error ? html`<span>error</span><span class="t-error">${info.error}</span>` : null}
      </div>
      <p class="dv-note">new MeshViewer(el, { autoRotate: true }) · loadNeuron(await api.assetArrayBuffer(round.mesh.asset), { bboxUm: round.mesh.bbox_um }) · onChange → ScaleBar · ⤢ → openFullView({ roundIndex, mode: '3d', view: viewer.getView() }).</p>
    </div>
  </div>`;
}

// ---- B. context clue / reveal in context ----
function ContextDemo({ past, reveals }) {
  const [idx, setIdx] = useState(3);
  const [ctx, setCtx] = useState(true);
  const [layers, setLayers] = useState({ volume: true, siblings: true, labels: true });
  const [sib, setSib] = useState(true);
  const [view, setView] = useState(null);
  const [labelsInfo, setLabelsInfo] = useState(null);
  const hostRef = useRef(null);
  const vRef = useRef(null);
  const round = past.rounds[idx - 1];
  const rv = reveals[idx - 1];
  useEffect(() => {
    const v = new MeshViewer(hostRef.current, { autoRotate: true });
    vRef.current = v;
    const off = v.onChange(setView);
    api.assetArrayBuffer(round.mesh.asset).then((b) => v.loadNeuron(b, { bboxUm: round.mesh.bbox_um })).catch(console.error);
    return () => { off(); v.dispose(); vRef.current = null; };
  }, [round.round_id]);
  useEffect(() => {
    const v = vRef.current;
    if (!v || !rv) return undefined;
    let alive = true;
    if (!ctx) { v.setContext(null); return undefined; }
    Promise.all([api.assetArrayBuffer(rv.context.volume), api.assetJSON(rv.context.labels)]).then(([volume, labels]) => {
      if (!alive) return null;
      setLabelsInfo(labels);
      return v.setContext({ volume, labels, offsetUm: rv.context.neuron_offset_um });
    }).catch(console.error);
    return () => { alive = false; };
  }, [round.round_id, ctx, rv]);
  useEffect(() => {
    const v = vRef.current;
    if (!v || !rv) return;
    if (sib && rv.context.siblings) api.assetArrayBuffer(rv.context.siblings).then((b) => v.setSiblings(b)).catch(console.error);
    else v.setSiblings(null);
  }, [round.round_id, sib, rv]);
  useEffect(() => { if (vRef.current) vRef.current.setLayers(layers); }, [layers, round.round_id]);
  const tog = (k, label) => html`<button type="button" aria-pressed=${layers[k] ? 'true' : 'false'}
    onClick=${() => setLayers((l) => ({ ...l, [k]: !l[k] }))}>${layers[k] ? '✓ ' : ''}${label}</button>`;
  return html`<div class="dv-row">
    <div class="dv-frame">
      <div class="viewer-canvas" ref=${hostRef}></div>
      <div class="viewer-top"><span class="viewer-label t-accent">✓ Met · 800 pts</span>
        <div class="text-switch">${[['cell', 'Cell'], ['ctx', 'In context']].map(([id, l]) => html`<button key=${id} type="button"
          class=${(id === 'ctx') === ctx ? 'is-active' : ''} onClick=${() => setCtx(id === 'ctx')}>${l}</button>`)}</div></div>
      <div class="legend viewer-legend">
        <span><span class="key-line"></span>this cell</span>
        ${ctx && layers.siblings && sib ? html`<span><span class="key-line is-sky"></span>${rv ? rv.type.name : 'same type'}, same volume</span>` : null}
        ${ctx && layers.volume ? html`<span><span class="key-box"></span>volume</span>` : null}
      </div>
      <div class="dv-scale" style=${{ bottom: '58px' }}>${view ? html`<${ScaleBar} pxPerUm=${view.pxPerUm} align="right" />` : null}</div>
      ${ctx ? html`<div class="dv-bottom toggle-row">${tog('volume', 'Volume')}${rv && rv.context.siblings ? tog('siblings', `${rv.type.name} · ${rv.context.siblings_count}`) : null}${tog('labels', labelsInfo && labelsInfo.planes.length ? 'Layers' : 'Regions')}</div>` : null}
    </div>
    <div class="dv-side">
      <${RoundChips} n=${5} value=${idx} onChange=${setIdx} labelOf=${(i) => `${i} · ${reveals[i - 1] ? reveals[i - 1].type.species_common : '?'}`} />
      <div class="dv-chips"><${Chip} active=${sib} onClick=${() => setSib((s) => !s)}>setSiblings(${sib ? 'buf' : 'null'})</${Chip}>
        <${Button} variant="outline" size="sm" onClick=${() => vRef.current.resetView()}>Reset</${Button}></div>
      <div class="dv-kv">
        <span>type</span><span>${rv ? rv.type.name : '—'}</span>
        <span>volume_style</span><span>${labelsInfo ? labelsInfo.volume_style : '…'}</span>
        <span>bbox_um</span><span>${labelsInfo ? labelsInfo.bbox_um.join(', ') : '…'}</span>
        <span>planes / points</span><span>${labelsInfo ? `${labelsInfo.planes.length} / ${labelsInfo.points.length}` : '…'}</span>
        <span>offset_um</span><span>${rv ? rv.context.neuron_offset_um.join(', ') : '—'}</span>
        <span>siblings</span><span>${rv ? rv.context.siblings_count || 0 : '—'}</span>
        <span>pxPerUm</span><span>${view ? fmt(view.pxPerUm, 4) : '—'}</span>
      </div>
      <p class="dv-note">setContext({ volume, labels, offsetUm }) frames the context bbox (animated zoom-out; 3/4 view while untouched) · setContext(null) zooms back onto the cell · setSiblings(buf|null) · setLayers({ volume, siblings, labels }).</p>
    </div>
  </div>`;
}

// ---- C. EM viewer ----
function EmDemo({ em, voxelNm }) {
  const [plane, setPlane] = useState('xy');
  const [mask, setMask] = useState(true);
  const [sampling, setSampling] = useState('auto');
  const [ev, setEv] = useState(null);
  const hostRef = useRef(null);
  const vRef = useRef(null);
  useEffect(() => {
    if (!em) return undefined;
    const v = new EmViewer(hostRef.current, { showMask: true });
    vRef.current = v;
    const off = v.onChange(setEv);
    Promise.all([api.assetBlob(em.atlas), api.assetBlob(em.mask), api.assetBlob(em.xz)])
      .then(([atlas, m, xz]) => v.load({ atlas, mask: m, xz, fieldUm: em.field_um, nSlices: em.n_slices })).catch(console.error);
    return () => { off(); v.dispose(); vRef.current = null; };
  }, [em && em.atlas]);
  useEffect(() => { if (vRef.current) vRef.current.setPlane(plane); }, [plane]);
  useEffect(() => { if (vRef.current) vRef.current.setMaskVisible(mask); }, [mask]);
  useEffect(() => { if (vRef.current) vRef.current.setSampling(sampling); }, [sampling]);
  if (!em) return html`<p class="dv-note">Prepare a closed-day round above to get its EM.</p>`;
  const zr = ev ? zReadout(ev.slice, ev.nSlices) : null;
  const zrDone = ev ? zReadout(ev.slice, ev.nSlices, voxelNm) : null;
  return html`<div class="dv-row">
    <div class="dv-frame">
      <div class="viewer-canvas" ref=${hostRef}></div>
      <div class="viewer-top"><span class="viewer-label">#32 · method</span><span class="viewer-points">800 + 200?</span></div>
      <div class="dv-scale">${ev ? html`<${ScaleBar} pxPerUm=${ev.pxPerUm} align="right" steps=${[0.5, 1, 2, 5]} />` : null}</div>
      ${plane === 'xy' ? html`<div class="legend viewer-legend"><span><span class="key-mask"></span>this cell</span><span class="t-num">${zr ? zr.z : ''}</span></div>` : null}
    </div>
    <div class="dv-side">
      <${Segmented} options=${[{ id: 'xy', label: 'XY' }, { id: 'xz', label: 'XZ' }]} value=${plane} onChange=${setPlane} label="Plane" />
      <div class="dv-chips">
        <${Button} variant="outline" size="sm" onClick=${() => vRef.current.step(-1)}>▲ slice</${Button}>
        <${Button} variant="outline" size="sm" onClick=${() => vRef.current.step(1)}>▼ slice</${Button}>
        <${Button} variant="outline" size="sm" onClick=${() => vRef.current.step(-10)}>▲ 10</${Button}>
        <${Button} variant="outline" size="sm" onClick=${() => vRef.current.step(10)}>▼ 10</${Button}>
        <${Chip} active=${mask} onClick=${() => setMask((m) => !m)}>■ this cell</${Chip}>
        <${Button} variant="outline" size="sm" onClick=${() => vRef.current.resetView()}>Reset</${Button}>
      </div>
      <${Segmented} options=${['auto', 'nearest', 'linear'].map((id) => ({ id, label: id }))} value=${sampling} onChange=${setSampling} label="Sampling" />
      <div class="dv-kv">
        <span>plane / slice</span><span>${ev ? `${ev.plane} · ${zr.z}` : '…'}</span>
        <span>zoom / pxPerUm</span><span>${ev ? `${fmt(ev.zoom, 1)}× · ${fmt(ev.pxPerUm, 1)}` : '…'}</span>
        <span>before done</span><span>${zr ? zr.z : '…'} (no depth)</span>
        <span>after done</span><span>${zrDone ? `${zrDone.z} · ${zrDone.depth || '—'}` : '…'}</span>
      </div>
      <p class="dv-note">new EmViewer(el, { showMask }) · load({ atlas, mask, xz: Blobs from api.assetBlob(state.em.*) }) · setPlane · setSlice/step · setMaskVisible · setSampling('auto'|'nearest'|'linear'). Drag pans, wheel/pinch zooms, ↑/↓ keys step slices.</p>
    </div>
  </div>`;
}

// ---- D. graph view ----
const SYNTH = [
  ['Long labels + tiny share', { version: 1, n_syn_in: 5120, n_syn_out: 820, inputs: [{ label: 'Mushroom body output neuron MBON-γ1pedc>α/β', n_syn: 2400, share: 0.469 }, { label: 'untyped', n_syn: 30, share: 0.0041 }, { label: 'Kenyon cell', n_syn: 812, share: 0.159 }], outputs: [{ label: 'L5 ET', n_syn: 420, share: 0.512 }] }],
  ['No inputs listed', { version: 1, n_syn_in: 0, n_syn_out: 300, inputs: [], outputs: [{ label: 'L2/3 IT', n_syn: 120, share: 0.4 }, { label: 'L4 IT', n_syn: 90, share: 0.3 }, { label: 'L6 CT', n_syn: 60, share: 0.2 }] }],
  ['Note (no partner data)', { version: 1, n_syn_in: 0, n_syn_out: 0, inputs: [], outputs: [], note: 'Partner data are not available for this dataset.' }],
  ['graph = null', null],
];
function GraphDemo({ graph }) {
  return html`<div class="dv-grid">
    <div class="dv-sec"><span class="overline">Real fixture graph clue</span>
      <div class="dv-frame is-graph">${graph ? html`<${GraphView} graph=${graph} width=${343} height=${244} />` : html`<span class="dv-note">Prepare a round above.</span>`}</div></div>
    ${SYNTH.map(([t, g]) => html`<div class="dv-sec" key=${t}><span class="overline">${t}</span><div class="dv-frame is-graph"><${GraphView} graph=${g} width=${343} height=${244} /></div></div>`)}
    <div class="dv-sec"><span class="overline">Responsive (no width/height)</span><div class="dv-frame" style=${{ height: '244px' }}><${GraphView} graph=${SYNTH[0][1]} /></div></div>
  </div>`;
}

// ---- E. full view in a phone frame ----
function PhoneHost() {
  const fv = useStore((s) => s.ui.fullView);
  return html`<div class="dv-phone app-root" style=${{ margin: 0 }}>
    ${fv ? html`<${FullView} ...${fv} onClose=${closeFullView} />` : html`<div class="dv-phone-empty"><span class="dv-note">Open a full view with ⤢ or the buttons.</span></div>`}
  </div>`;
}

function App() {
  const [d, reload] = useData();
  const [prepIdx, setPrepIdx] = useState(1);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  if (d.status === 'loading') return html`<div class="dv"><span class="overline">Loading the dev stack…</span></div>`;
  if (d.status === 'error') return html`<div class="dv"><span class="overline is-error">✕ ${d.error}</span><span class="dv-note">Is the dev stack up? neuroguesser-content/scripts/dev-up.sh</span></div>`;
  const { today, past, pastProgress, reveals } = d;
  const prepState = pastProgress[prepIdx - 1];
  const em = prepState && prepState.em ? prepState.em : null;
  const graphPath = prepState && prepState.clues && prepState.clues.graph ? prepState.clues.graph.asset : null;
  const prepare = async () => {
    setBusy(true);
    const add = (s) => setLog((l) => [...l.slice(-8), s]);
    try { await playToDone(past.rounds[prepIdx - 1], past.date, add); add('done'); } catch (e) { add(`✕ ${e.message}`); }
    setBusy(false);
    reload();
  };
  const openPast = (mode, extra = {}) => {
    store.update('today', { status: 'ready', date: past.date, dayNumber: past.day_number, rounds: past.rounds, progress: pastProgress });
    const rv = reveals[prepIdx - 1];
    if (rv) store.update('reveals', { [rv.round_id]: rv });
    openFullView({ roundIndex: prepIdx, mode, ...extra });
  };
  const openToday = (i) => {
    store.update('today', { status: 'ready', date: today.date, dayNumber: today.day_number, rounds: today.rounds, progress: [null, null, null, null, null] });
    openFullView({ roundIndex: i, mode: '3d' });
  };
  return html`<div class="dv">
    <div class="dev-head dv-head">
      <span class="overline">NeuroGuesser · dev · viewers</span>
      <span class="t-title">MeshViewer · EmViewer · GraphView · full view</span>
      <span class="dv-note">API ${config.apiBase} · today ${today.date} (#${today.day_number}) · closed day ${past.date} (#${past.day_number}). Real fixture assets via js/api.js.</span>
    </div>

    <section class="dv-sec"><span class="overline">A · Round mesh · inline 375 × 400 (today, type stage)</span><${MeshDemo} day=${today} /></section>
    <section class="dv-sec"><span class="overline">B · Context clue / reveal in context (closed day: box + surface volumes, layers, neuropils, siblings)</span><${ContextDemo} past=${past} reveals=${reveals} /></section>

    <section class="dv-sec"><span class="overline">Prepare the closed day's EM + graph (dev device, debug clock)</span>
      <div class="dv-row"><div class="dv-side">
        <${RoundChips} n=${5} value=${prepIdx} onChange=${setPrepIdx} labelOf=${(i) => `${i} · ${pastProgress[i - 1] ? pastProgress[i - 1].stage : 'not played'}`} />
        <${Button} disabled=${busy || (prepState && prepState.stage === 'done')} onClick=${prepare}>${busy ? 'Playing…' : prepState && prepState.stage === 'done' ? '✓ Round prepared' : `Play round ${prepIdx} of ${past.date} to done`}</${Button}>
        <div class="dv-kv">${log.map((l, i) => html`<span key=${`k${i}`}>·</span><span key=${`v${i}`}>${l}</span>`)}</div>
      </div></div>
    </section>

    <section class="dv-sec"><span class="overline">C · EM · XY + mask / XZ (closed day round ${prepIdx})</span><${EmDemo} em=${em} voxelNm=${reveals[prepIdx - 1] ? reveals[prepIdx - 1].method.voxel_nm : null} /></section>
    <section class="dv-sec"><span class="overline">D · Graph clue</span><${GraphLoader} path=${graphPath} /></section>

    <section class="dv-sec"><span class="overline">E · Full view (375 × 780 frame)</span>
      <div class="dv-row">
        <${PhoneHost} />
        <div class="dv-side">
          <span class="card-title-sm">Today · type stage (3D only, no Neuroglancer)</span>
          <${RoundChips} n=${5} value=${0} onChange=${openToday} />
          <span class="card-title-sm">Closed day · round ${prepIdx} · ${prepState ? prepState.stage : 'not played'}</span>
          <div class="dv-chips">
            <${Button} variant="outline" size="sm" onClick=${() => openPast('3d')}>3D</${Button}>
            <${Button} variant="outline" size="sm" onClick=${() => openPast('3d', { context: true })}>3D · in context</${Button}>
            <${Button} variant="outline" size="sm" disabled=${!em} onClick=${() => openPast('em')}>EM · XY</${Button}>
            <${Button} variant="outline" size="sm" disabled=${!em} onClick=${() => openPast('em', { plane: 'xz' })}>EM · XZ</${Button}>
            <${Button} variant="outline" size="sm" disabled=${!em} onClick=${() => openPast('em', { reveal: null, state: { ...prepState, stage: 'method' } })}>EM · method stage (no depth)</${Button}>
          </div>
          <p class="dv-note">openFullView({ roundIndex, mode: '3d' | 'em', context?, plane?, slice?, view? }). Tap the specimen to hide the chrome; Escape or ✕ closes.</p>
        </div>
      </div>
    </section>
  </div>`;
}

function GraphLoader({ path }) {
  const [g, setG] = useState(null);
  useEffect(() => { if (path) api.assetJSON(path).then(setG).catch(console.error); else setG(null); }, [path]);
  return html`<${GraphDemo} graph=${g} />`;
}

// ?perf: one 375 × 400 viewer auto-rotating today's largest mesh; frame stats land in window.__perf after 6 s
// (for headless frame-time checks, e.g. with CPU throttling).
function PerfDemo() {
  const hostRef = useRef(null);
  const [out, setOut] = useState(null);
  useEffect(() => {
    let v = null;
    let alive = true;
    (async () => {
      const t = await api.getToday();
      const day = await api.getDay(t.date);
      const round = [...day.rounds].sort((a, b) => b.mesh.n_triangles - a.mesh.n_triangles)[0];
      v = new MeshViewer(hostRef.current, { autoRotate: true });
      window.__viewer = v;
      await v.loadNeuron(await api.assetArrayBuffer(round.mesh.asset), { bboxUm: round.mesh.bbox_um });
      const gl = v.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      await sleep(1000);
      v.resetStats();
      await sleep(5000);
      if (!alive) return;
      const r = { ...v.stats(), dpr: v.renderer.getPixelRatio(), gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a' };
      window.__perf = r;
      setOut(r);
    })().catch((e) => { window.__perf = { error: String(e) }; setOut({ error: String(e) }); });
    return () => { alive = false; if (v) v.dispose(); };
  }, []);
  return html`<div class="dv"><span class="overline">Perf · 375 × 400 · auto-rotate</span>
    <div class="dv-frame"><div class="viewer-canvas" ref=${hostRef}></div></div>
    <pre class="dv-kv">${out ? JSON.stringify(out, null, 1) : 'measuring…'}</pre></div>`;
}

const perf = new URLSearchParams(location.search).has('perf');
hydrateSession().catch(() => {}).finally(() => render(html`<${perf ? PerfDemo : App} />`, document.getElementById('dev')));
