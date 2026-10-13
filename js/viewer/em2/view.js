// EM format 2: the viewer chrome around an EmStage (em-v2-spec.md §8.4, §8.5, §8.6, §8.8, §8.9, §9), as Preact
// components shared by the round screen (inline, method stage) and the full view.
//   <Em2View mode="inline" | "full" roundId em meshAsset done voxelNm quad preset initial chrome onFail onTap />
//  - phone / narrow: one panel, tabs XY Sections · XZ Side · YZ Side · 3D; desktop (quad): Neuroglancer's 4panel,
//    each panel labelled (6 px swatch of its normal-axis colour) with ⤢ maximize; Space toggles quad ⇄ single.
//  - chips "— Outline" / "◇ Mesh" (3D: "◇ Mesh" + XY · XZ · YZ planes), the px readout ("8 nm px · finest"), the z rail
//    (▲, a track with lost sections as hollow ticks, ▼, "17/32"), the scale bar, "Whole cell" ⇄ "Native".
//  - before done: no thickness, z-step or depth anywhere (model.js readoutLines); after done they join the readout.
// The stage owns the canvas, the vectors and the data-area labels; this module owns everything else.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx } from '../../ui/html.js';
import * as api from '../../api.js';
import * as idb from '../../idb.js';
import { haptic } from '../../fx/haptics.js';
import { EmStage } from './stage.js';
import * as M from './model.js';
import { saveDataNow } from './factory.js';

export { prefetchEm, saveDataNow } from './factory.js';

export const TABS = Object.freeze([
  { id: 'xy', label: 'XY', word: '', aria: 'XY sections' },
  { id: 'xz', label: 'XZ', word: 'Side', aria: 'XZ side view' },
  { id: 'yz', label: 'YZ', word: 'Side', aria: 'YZ side view' },
  { id: '3d', label: '3D', word: '', aria: 'EM planes in the 3D mesh' },
]);
const PANEL_NAMES = { xy: 'XY', xz: 'XZ', yz: 'YZ', '3d': '3D' };
const NORMAL = { xy: 'z', xz: 'y', yz: 'x' };
const HINT_KEY = 'em2:hint';
const HINT_MS = 6000;
const REPEAT_WAIT_MS = 500;
const REPEAT_MS = 300;

/** ≥ 1024 px: the desktop layout (css/desktop.css's breakpoint). */
export function useWide(min = 1024) {
  const q = `(min-width: ${min}px)`;
  const get = () => typeof matchMedia === 'function' && matchMedia(q).matches;
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(q);
    const fn = () => setWide(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', fn); else mq.addListener(fn);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', fn); else mq.removeListener(fn); };
  }, [q]);
  return wide;
}

// ---------------------------------------------------------------------------------------------------------

export function Em2View({
  mode = 'inline', roundId, em, meshAsset = null, meshGlb = null, done = false, voxelNm = null, quad: quadProp = 'auto',
  preset = null, initial = null, chrome = true, onFail, onTap, onStage,
}) {
  const wide = useWide();
  const quad = quadProp === 'auto' ? wide : !!quadProp;
  const hostRef = useRef(null);
  const stageRef = useRef(null);
  const [st, setSt] = useState(null);
  const [help, setHelp] = useState(false);
  const [hint, setHint] = useState(false);
  const failRef = useRef(onFail); failRef.current = onFail;
  const tapRef = useRef(onTap); tapRef.current = onTap;
  const quadRef = useRef(quad); quadRef.current = quad;
  const full = mode === 'full';

  // acquire + attach (one stage per round: the full view re-attaches the inline viewer's canvas)
  useEffect(() => {
    let stage;
    try {
      stage = EmStage.acquire(roundId, {
        em, done, voxelNm, saveData: saveDataNow(),
        meshGlb: meshGlb || (meshAsset ? api.assetArrayBuffer(meshAsset) : null),
      });
    } catch (err) {
      console.warn('[em2]', err);
      if (failRef.current) failRef.current(err);
      return undefined;
    }
    stageRef.current = stage;
    // an error while the stage was built (no WebGL 2) was emitted before anyone listened
    if (stage._error && failRef.current) setTimeout(() => { if (failRef.current) failRef.current(new Error(stage._error)); }, 0);
    const startPanel = (initial && M.PANELS.includes(initial.panel)) ? initial.panel : (stage.panel || 'xy');
    const rec = stage.attach(hostRef.current, { layout: quad ? 'quad' : 'single', panel: startPanel });
    if (preset) stage.applyPreset(preset);
    else if (initial) {
      if (Number.isInteger(initial.section)) stage.setSection(initial.section);
      if (initial.view) stage.setView(initial.view);
    }
    const offC = stage.onChange((s) => setSt(s));
    const offT = stage.onTap((t) => { if (tapRef.current) tapRef.current(t); });
    const offE = stage.onEvent((ev) => {
      if (ev.type === 'error' && failRef.current) failRef.current(new Error(ev.message));
      if (ev.type === 'shortcuts') setHelp((h) => !h);
      if (ev.type === 'layout-key') {
        const s = stage.state();
        if (s.layout === 'quad') stage.setLayout('single');
        else if (quadRef.current || (full && s.canQuad)) stage.setLayout('quad');
      }
    });
    if (onStage) onStage(stage);
    // the full view: keyboard shortcuts work at once (after the overlay's own focus move)
    const focusT = full ? setTimeout(() => { try { stage.root.focus({ preventScroll: true }); } catch (_) { /* */ } }, 60) : 0;
    return () => {
      clearTimeout(focusT);
      offC(); offT(); offE();
      stage.detach(rec);
      stage.release();
      if (stageRef.current === stage) stageRef.current = null;
    };
  }, [roundId]);

  useEffect(() => { const s = stageRef.current; if (s) s.setDone(done, voxelNm); }, [done, voxelNm && voxelNm.join(',')]);
  useEffect(() => { const s = stageRef.current; if (s) s.setLayout(quad ? 'quad' : 'single'); }, [quad]);

  // first-use hint, once per device
  useEffect(() => {
    let alive = true;
    let timer = 0;
    Promise.resolve().then(() => idb.get(HINT_KEY)).catch(() => true).then((seen) => {
      if (!alive || seen) return;
      setHint(true);
      timer = setTimeout(() => { if (alive) setHint(false); }, HINT_MS);
      try { idb.set(HINT_KEY, true); } catch (_) { /* */ }
    });
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const stage = stageRef.current;
  const s = st;
  const layout = s ? s.layout : (quad ? 'quad' : 'single');
  const panel = s ? s.panel : 'xy';
  const mainId = layout === 'quad' ? 'xy' : panel;
  const box = s && s.panels ? (s.panels.find((p) => p.id === mainId) || s.panels[0]) : null;
  const is3d = mainId === '3d';
  const allowQuad = quad || (full && s && s.canQuad);
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  const act = (fn) => (e) => { if (e) e.stopPropagation(); if (stageRef.current) fn(stageRef.current); };
  const chips = !s ? null : is3d
    ? [
      { id: 'mesh', glyph: '◇', label: 'Mesh', on: s.layers.mesh, cls: 'is-mesh3d', fn: (x) => x.setLayers({ mesh: !s.layers.mesh }) },
      ...['xy', 'xz', 'yz'].map((p) => ({
        id: `s-${p}`, glyph: s.layers.slices3d[p] ? '■' : '□', label: PANEL_NAMES[p], on: !!s.layers.slices3d[p], cls: `is-${NORMAL[p]}`,
        aria: `${PANEL_NAMES[p]} plane in 3D`, glyphState: true,   // ■ shown / □ hidden: the glyph is the state word
        fn: (x) => x.setLayers({ slices3d: { [p]: !s.layers.slices3d[p] } }),
      })),
    ]
    : [
      { id: 'outline', glyph: '—', label: s.outlinesFailed ? 'Outline unavailable' : 'Outline', on: s.layers.outline && !s.outlinesFailed, cls: 'is-outline', disabled: s.outlinesFailed, fn: (x) => x.setLayers({ outline: !s.layers.outline }) },
      { id: 'mesh', glyph: '◇', label: 'Mesh', on: s.layers.mesh, cls: 'is-mesh', fn: (x) => x.setLayers({ mesh: !s.layers.mesh }) },
    ];

  const lines = s ? M.readoutLines({ panel: mainId, px: s.px, isFinest: s.isFinest, done: s.done, sectionNm: s.sectionNm, section: s.section }) : [];
  const scale = s ? (is3d ? s.scale3d : s.scaleBar) : null;

  const helpBtn = !touch && s && layout === 'quad'
    ? html`<button type="button" class="em2-text-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick=${(e) => { e.stopPropagation(); setHelp((h) => !h); }}>?</button>` : null;

  return html`<div class=${cx('em2-view', full ? 'is-full' : 'is-inline', `is-${layout}`, !chrome && 'is-bare')}
      onPointerDownCapture=${() => { if (hint) setHint(false); }}>
    <div class="em2-host" ref=${hostRef}></div>
    <div class="em2-layer">
      ${s && chrome && layout === 'quad' ? html`<${PanelLabels} panels=${s.panels} focus=${s.focusPanel} onMax=${(id) => { haptic('selection'); if (stageRef.current) { stageRef.current.setPanel(id); stageRef.current.setLayout('single'); } }} />` : null}
      ${s && chrome && box ? html`<div class=${cx('em2-chrome', is3d && 'is-3d')} style=${{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }}>
        ${s.loading.busy && s.loading.total > 0 ? html`<div class="em2-progress" aria-hidden="true"><i style=${{ transform: `scaleX(${Math.min(1, s.loading.loaded / s.loading.total).toFixed(3)})` }}></i></div>` : null}
        <div class="em2-chrome-in">
          <div class="em2-chips" role="group" aria-label=${is3d ? 'Layers and planes' : 'Layers'}>
            ${chips.map((c) => html`<button key=${c.id} type="button" class=${cx('em2-chip', c.cls, !c.on && 'is-off')} aria-pressed=${c.on ? 'true' : 'false'}
              aria-label=${c.aria || c.label} disabled=${!!c.disabled} onClick=${act((x) => { haptic('selection'); c.fn(x); })}>
              <span class="em2-chip-glyph" aria-hidden="true">${c.glyph}</span>${c.label}${c.on || c.disabled || c.glyphState ? '' : html`<span class="em2-chip-off"> · off</span>`}
            </button>`)}
          </div>
          ${lines.length || s.loading.stackBusy ? html`<div class="em2-read">
            ${lines.map((l, i) => html`<span key=${i}>${l}</span>`)}
            ${s.loading.stackBusy ? html`<span class="em2-read-load">loading sections ${s.loading.stack}/2</span>` : null}
          </div>` : null}
          <${Rail} s=${s} stage=${stage} show3dNumbers=${!is3d || s.done} />
          <div class="em2-bottom">
            ${scale && s.layers.scaleBar && scale.px > 0 ? html`<span class="em2-scale" aria-label=${`Scale bar ${scale.label}`}><i style=${{ width: `${scale.px.toFixed(1)}px` }}></i><span>${scale.label}</span></span>` : html`<span></span>`}
            <span class="em2-bottom-right">
              ${helpBtn}
              ${allowQuad && layout === 'single' ? html`<button type="button" class="em2-text-btn" aria-label="Four panels" title="Four panels" onClick=${act((x) => { haptic('selection'); x.setLayout('quad'); })}>⊞</button>` : null}
              ${is3d
                ? html`<button type="button" class="em2-text-btn" onClick=${act((x) => { haptic('selection'); x.frame('cell'); })}>Reset</button>`
                : html`<button type="button" class="em2-text-btn em2-frame" onClick=${act((x) => { haptic('selection'); x.frame(s.framing === 'native' ? 'cell' : 'native'); })}>${s.framing === 'native' ? 'Whole cell' : 'Native'}</button>`}
            </span>
          </div>
          ${s.loading.finer ? html`<span class="em2-note">loading finer level · ${M.fmtMB(s.loading.finer.bytes)}</span>` : null}
          ${hint ? html`<span class="em2-hint" role="note">${touch
            ? 'Drag on the framed sections to scroll them · two fingers to move and zoom'
            : 'Scroll = sections · Ctrl/⌘ + scroll = zoom · drag = move'}</span>` : null}
        </div>
      </div>` : null}
    </div>
    ${s && chrome && layout === 'single' ? html`<${Tabs} panel=${panel} s=${s} onPanel=${(id) => { if (stageRef.current && id !== panel) { haptic('selection'); stageRef.current.setPanel(id); } }} />` : null}
    ${help ? html`<${Shortcuts} onClose=${() => { setHelp(false); if (stageRef.current) stageRef.current.root.focus({ preventScroll: true }); }} />` : null}
  </div>`;
}

function PanelLabels({ panels, focus, onMax }) {
  return html`${panels.map((p) => html`<div key=${p.id} class=${cx('em2-plabel', focus === p.id && 'is-focus', p.y === 0 && 'is-top')} style=${{ left: `${p.x}px`, top: `${p.y}px` }}>
    <span class="em2-plabel-name"><i class=${cx('em2-sw', `is-${NORMAL[p.id] || 'mesh'}`)} aria-hidden="true"></i>${PANEL_NAMES[p.id]}</span>
    <button type="button" class="em2-max" aria-label=${`Maximize ${PANEL_NAMES[p.id]}`} title=${`Maximize ${PANEL_NAMES[p.id]}`} onClick=${(e) => { e.stopPropagation(); onMax(p.id); }}>⤢</button>
  </div>`)}`;
}

function Tabs({ panel, s, onPanel }) {
  return html`<div class="clue-bar em2-tabs" role="tablist" aria-label="EM views">
    ${TABS.map((t) => {
      const active = panel === t.id;
      const unavailable = (t.id === 'xz' || t.id === 'yz') && s.orthoFailed;
      const word = unavailable ? 'unavailable' : t.word;   // v0.6.1: no "Viewing" (the underline says it)
      return html`<button key=${t.id} type="button" role="tab" class=${cx('clue-tab', active && 'is-active')} aria-selected=${active ? 'true' : 'false'}
        aria-label=${`${t.aria}${active ? ', viewing' : ''}${unavailable ? ', unavailable' : ''}`} onClick=${() => onPanel(t.id)}>
        <b>${t.label}</b><span class=${active ? 'is-accent' : ''}>${word}</span>
      </button>`;
    })}
  </div>`;
}

/** ▲ · track (lost sections as hollow ticks) · ▼ · "17/32". Long-press ▲▼ repeats ×10. */
function Rail({ s, stage, show3dNumbers }) {
  const trackRef = useRef(null);
  const drag = useRef(false);
  const rep = useRef({ timer: 0, fired: false });
  const n = s.n;
  const k = s.section;
  const frac = n > 1 ? k / (n - 1) : 0;
  const stop = () => { clearTimeout(rep.current.timer); clearInterval(rep.current.timer); rep.current.timer = 0; };
  useEffect(() => stop, []);
  const press = (d) => (e) => {
    e.stopPropagation();
    if (!stage) return;
    rep.current.fired = true;
    stage.step(d);
    stop();
    // a button that turns disabled at an end gets no pointerup: listen on the window too
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    rep.current.timer = setTimeout(() => {
      rep.current.timer = setInterval(() => {
        if (!stage) { stop(); return; }
        const before = stage.getSection();
        stage.step(d * M.SECTION_JUMP);
        if (stage.getSection() === before) stop();
      }, REPEAT_MS);
    }, REPEAT_WAIT_MS);
  };
  const click = (d) => (e) => {
    e.stopPropagation();
    if (rep.current.fired) { rep.current.fired = false; return; }
    if (stage) stage.step(d);   // keyboard activation (no pointerdown)
  };
  const at = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    const f = (e.clientY - r.top - 8) / Math.max(1, r.height - 16);
    return Math.round(Math.max(0, Math.min(1, f)) * (n - 1));
  };
  const key = (e) => {
    const map = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1, PageUp: -M.SECTION_JUMP, PageDown: M.SECTION_JUMP };
    if (!stage) return;
    if (e.key in map) { e.preventDefault(); e.stopPropagation(); stage.step(map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); stage.setSection(0, { user: true }); }
    else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); stage.setSection(n - 1, { user: true }); }
  };
  const valueText = M.ariaSection(k, n, s.isMissing);
  return html`<div class="em2-rail" role="group" aria-label="Sections">
    <button type="button" class="btn-ghost em2-rail-btn" aria-label="Previous section (hold for 10)" disabled=${k <= 0}
      onPointerDown=${press(-1)} onPointerUp=${stop} onPointerLeave=${stop} onPointerCancel=${stop} onClick=${click(-1)}>▲</button>
    <div class="em2-track" ref=${trackRef} role="slider" tabindex="0" aria-label="Section" aria-orientation="vertical"
      aria-valuemin="1" aria-valuemax=${n} aria-valuenow=${k + 1} aria-valuetext=${valueText} onKeyDown=${key}
      onPointerDown=${(e) => { e.stopPropagation(); drag.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* */ } const i = at(e); if (stage && i !== k) stage.step(i - stage.getSection()); }}
      onPointerMove=${(e) => { if (!drag.current || !stage) return; const i = at(e); if (i !== stage.getSection()) stage.step(i - stage.getSection()); }}
      onPointerUp=${() => { drag.current = false; }} onPointerCancel=${() => { drag.current = false; }}>
      <span class="em2-track-line"></span>
      ${s.missing.map((i) => html`<span key=${i} class="em2-tick" style=${{ top: `calc(8px + (100% - 16px) * ${(i / (n - 1)).toFixed(4)})` }}></span>`)}
      <span class=${cx('em2-thumb', s.isMissing && 'is-lost')} style=${{ top: `calc(8px + (100% - 16px) * ${frac.toFixed(4)})` }}></span>
    </div>
    <button type="button" class="btn-ghost em2-rail-btn" aria-label="Next section (hold for 10)" disabled=${k >= n - 1}
      onPointerDown=${press(1)} onPointerUp=${stop} onPointerLeave=${stop} onPointerCancel=${stop} onClick=${click(1)}>▼</button>
    ${show3dNumbers ? html`<span class="em2-z">${k + 1}/${n}</span>` : null}
  </div>`;
}

const SHORTCUTS = [
  ['Scroll · , .  · ↑ ↓', 'sections ±1'],
  ['Shift + scroll · PgUp PgDn', 'sections ±10'],
  ['Home · End', 'first · last section'],
  ['Ctrl/⌘ + scroll · pinch · + −', 'zoom'],
  ['Drag · ← → · Shift + arrows', 'move'],
  ['Right-click', 'centre here'],
  ['Double-click the cell · O · 2', 'outline'],
  ['M · 3', 'mesh'],
  ['A · B · S', 'axis lines · scale bar · planes in 3D'],
  ['0 · C', 'native · whole cell'],
  ['Space · ⤢', 'one ⇄ four panels'],
  ['3D: drag · Shift-drag · scroll', 'rotate · move · zoom'],
];

function Shortcuts({ onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.focus({ preventScroll: true });
    const key = (e) => { if (e.key === 'Escape' || e.key === '?' || e.key === 'h') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    el.addEventListener('keydown', key);
    return () => el.removeEventListener('keydown', key);
  }, []);
  return html`<div class="em2-help" role="dialog" aria-label="Keyboard shortcuts" tabindex="-1" ref=${ref}>
    <div class="em2-help-head"><span class="overline">Shortcuts</span>
      <button type="button" class="btn-ghost" aria-label="Close shortcuts" onClick=${onClose}>✕</button></div>
    <dl class="em2-help-list">${SHORTCUTS.map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
  </div>`;
}
