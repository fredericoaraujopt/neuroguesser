// Dev page: the EM format 2 viewer (js/viewer/em2/*) on a local fixture, without the Worker or a round.
//   dev/em2.html?bundle=<URL of a directory with em_v2.json, mesh.glb, assets/>            (a synthetic fixture)
//   dev/em2.html?bundle=<URL of a bake bundle>&round=<round_id>   (rounds/<id>.answer.json + .public.json, assets/)
//   or pick such a folder with "Open folder…" (no server needed).
// Options: frame=fill|phone|desktop|full (fill: the frame is the window, quad from 1024 px), done=1, saver=1,
// panel=xy|xz|yz|3d, bare=1 (no dev bar; for screenshots). window.__em2 exposes the stage for measurements.
// The bundle must be served with CORS when it is on another origin (e.g. `npx http-server --cors <dir>`).
// Nothing here ships to players.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, render } from '../js/ui/html.js';
import { store } from '../js/store.js';
import { setEmAssetSource } from '../js/viewer/em2/loader.js';
import { Em2View } from '../js/viewer/em2/view.js';
import { EmStage } from '../js/viewer/em2/stage.js';
import { parseEm } from '../js/viewer/em2/model.js';

const P = new URLSearchParams(location.search);
if (P.get('bare') === '1') document.body.classList.add('is-bare');
if (P.get('saver') === '1') store.update('session', { settings: { ...store.get().session.settings, dataSaver: true } });

const LOOK_AGAIN = [
  { label: 'Sections in XZ', panel: 'xz', frame: 'section', value: 12 },
  { label: 'XZ like XY', panel: 'xz', frame: 'native', value: 6 },
  { label: 'Native pixels', panel: 'xy', frame: 'native', value: 10 },
  { label: 'Beam tiles', panel: 'xy', frame: 'field', value: 120 },
  { label: 'Whole cell', panel: 'xy', frame: 'cell' },
];

async function readStream(res, onProgress) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !res.body.getReader || !onProgress) return res.blob();
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.byteLength;
    onProgress(got, Math.max(total, got));
  }
  return new Blob(parts);
}

/** ?bundle= (+ &round=) → { em, mesh (Promise<ArrayBuffer>), label } */
async function fromUrl() {
  const base = (P.get('bundle') || '').replace(/\/+$/, '');
  if (!base) return null;
  const round = P.get('round');
  let em;
  let meshUrl;
  if (round) {
    const ans = await (await fetch(`${base}/rounds/${round}.answer.json`)).json();
    const pub = await (await fetch(`${base}/rounds/${round}.public.json`)).json();
    em = ans.em;
    meshUrl = `${base}/assets/${pub.mesh.asset.split('/').pop()}`;
  } else {
    em = await (await fetch(`${base}/em_v2.json`)).json();
    meshUrl = `${base}/mesh.glb`;
  }
  setEmAssetSource((path, { onProgress }) => fetch(`${base}/assets/${path.split('/').pop()}`).then((r) => readStream(r, onProgress)));
  return { em, mesh: fetch(meshUrl).then((r) => r.arrayBuffer()), label: round ? `${base} · ${round}` : base };
}

/** A picked folder (em_v2.json, mesh.glb, assets/…) → the same. */
async function fromFiles(list) {
  const files = new Map([...list].map((f) => [f.name, f]));
  const emFile = files.get('em_v2.json') || files.get('em.json');
  if (!emFile) throw new Error('no em_v2.json in that folder');
  const em = JSON.parse(await emFile.text());
  setEmAssetSource(async (path) => {
    const f = files.get(path.split('/').pop());
    if (!f) throw new Error(`missing ${path}`);
    return f;
  });
  const mesh = files.get('mesh.glb');
  return { em, mesh: mesh ? mesh.arrayBuffer() : null, label: emFile.webkitRelativePath || emFile.name };
}

function fmtStats(s) {
  if (!s) return '';
  const mem = performance.memory ? ` · heap ${(performance.memory.usedJSHeapSize / 1e6).toFixed(0)} MB` : '';
  return `gpu ${(s.gpuBytes / 1e6).toFixed(1)} MB · uploads ${s.uploads} · r8 ${s.r8} · cpu/frame ${s.frame.avg.toFixed(2)} (p95 ${s.frame.p95.toFixed(2)}) ms · interval p95 ${s.interval.p95.toFixed(1)} ms${mem}`;
}

function Frame({ frame, children }) {
  if (frame === 'phone') return html`<div class="dv2-frame" style=${{ width: '375px', height: '400px', left: '16px', top: '16px' }}>${children}</div>`;
  if (frame === 'desktop') return html`<div class="dv2-frame" style=${{ width: '992px', height: '767px', left: '0', top: '0' }}>${children}</div>`;
  return html`<div class="dv2-frame" style=${{ inset: '0', width: '100%', height: '100%' }}>${children}</div>`;
}

function App() {
  const [fx, setFx] = useState(null);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(P.get('done') === '1');
  const [frame, setFrame] = useState(P.get('frame') || 'fill');
  const [stage, setStage] = useState(null);
  const [stats, setStats] = useState('');
  const [preset, setPreset] = useState(null);
  const [gen, setGen] = useState(0);
  const pick = useRef(null);

  useEffect(() => { fromUrl().then((f) => { if (f) setFx(f); }, (e) => setErr(String(e))); }, []);
  useEffect(() => {
    const t = setInterval(() => { if (stage) setStats(fmtStats(stage.stats())); }, 500);
    return () => clearInterval(t);
  }, [stage]);
  useEffect(() => {
    window.__em2 = { stage: () => stage, registry: EmStage.registry(), parseEm };
  }, [stage]);

  const restart = (f) => { for (const e of EmStage.registry().values()) e.stage.dispose(); EmStage.registry().clear(); setStage(null); setGen((g) => g + 1); if (f) setFx(f); };
  const kind = fx ? parseEm(fx.em).kind : null;
  const quad = frame === 'desktop' ? true : frame === 'phone' ? false : 'auto';
  const view = fx && kind === 'v2' ? html`<${Em2View} key=${`${gen}:${frame}`} mode=${frame === 'full' ? 'full' : 'inline'} roundId=${`dev-${gen}-${frame}`}
    em=${fx.em} meshGlb=${fx.mesh} done=${done} voxelNm=${done ? [4, 4, fx.em.section_nm || 40] : null} quad=${quad}
    preset=${preset} initial=${{ panel: P.get('panel') || 'xy' }} onStage=${setStage} />` : null;
  const inline = frame !== 'full';

  return html`<div class="dv2">
    <div class="dv2-bar">
      <span>EM v2 · ${fx ? fx.label : 'no fixture'}${kind && kind !== 'v2' ? ` · ${kind}` : ''}</span>
      <label>frame <select value=${frame} onChange=${(e) => { setFrame(e.currentTarget.value); restart(); }}>
        ${['fill', 'phone', 'desktop', 'full'].map((f) => html`<option value=${f}>${f}</option>`)}</select></label>
      <label><input type="checkbox" checked=${done} onChange=${(e) => setDone(e.currentTarget.checked)} /> done</label>
      ${LOOK_AGAIN.map((l) => html`<button type="button" onClick=${() => { setPreset({ ...l }); if (stage) stage.applyPreset(l); }}>${l.label}</button>`)}
      <button type="button" onClick=${() => restart()}>restart</button>
      <button type="button" onClick=${() => pick.current && pick.current.click()}>Open folder…</button>
      <input type="file" ref=${pick} webkitdirectory multiple hidden onChange=${(e) => fromFiles(e.currentTarget.files).then((f) => restart(f), (x) => setErr(String(x)))} />
      <span class="dv2-stats">${stats}</span>
    </div>
    <div class="dv2-stage">
      ${err ? html`<p class="dv2-note">✕ ${err}</p>` : null}
      ${!fx && !err ? html`<p class="dv2-note">Add ?bundle=&lt;URL of a fixture directory&gt; (em_v2.json, mesh.glb, assets/), or open such a folder.</p>` : null}
      ${view ? html`<${Frame} frame=${frame}>${inline ? html`<section class="viewer round-viewer is-em is-em2" aria-label="Specimen">
          <div class="viewer-canvas">${view}</div>
          <div class="viewer-top"><span class="round-tag"><span class="viewer-label">#34 · 1/5</span></span><span class="viewer-points">800 + 200?</span></div>
          <div class="viewer-expand"><button type="button" class="btn-ghost" aria-label="Full view">⤢</button></div>
        </section>` : html`<div class="full-overlay fv" style=${{ position: 'absolute', inset: 0 }}>${view}</div>`}</${Frame}>` : null}
    </div>
  </div>`;
}

render(html`<${App} />`, document.getElementById('dev'));
