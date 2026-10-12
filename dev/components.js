// Dev page: the shared Charcoal classes (css/app.css) and components (js/ui/*) assembled into the handoff's
// round screen, plus a gallery. Reference for the screen tracks; nothing here is shipped to players.
import { useState } from 'preact/hooks';
import { html, render, cx } from '../js/ui/html.js';
import { hydrateSession, showToast, store } from '../js/store.js';
import {
  Button, GhostButton, Chip, Segmented, Overline, Card, Meter, ScaleBar, Legend, Toggle, OfflineChip, Banner, TabBar, Toast,
} from '../js/ui/components.js';
import { Sheet } from '../js/ui/sheet.js';
import { METHOD_NAMES, METHOD_BLURBS } from '../js/format.js';

const OPTS = [
  ['A', 'L2/3 IT pyramidal', 'Mouse · V1 · intratelencephalic', 'idle'],
  ['B', 'Chandelier cell', 'Mouse · cortex · axo-axonic interneuron', 'picked'],
  ['C', 'L5 ET pyramidal', 'Mouse · V1 · subcortical projection', 'wrong'],
  ['D', 'Kenyon cell', 'Drosophila · mushroom body · memory', 'out'],
  ['E', 'L3 pyramidal', 'Human · temporal cortex · intracortical', 'idle'],
  ['F', 'Purkinje cell', 'Mouse · cerebellum · sole cortical output', 'idle'],
];
const MARK = { picked: '● picked', wrong: '✕ wrong', out: '✕ out', answer: '✓ answer', idle: '' };

function RoundReplica() {
  const [tab, setTab] = useState('mesh');
  const clues = [
    { id: 'mesh', label: 'Mesh', word: tab === 'mesh' ? 'Viewing' : 'Free', cls: tab === 'mesh' ? 'is-accent' : '' },
    { id: 'context', label: 'Context', word: tab === 'context' ? 'Viewing' : 'Opened', cls: tab === 'context' ? 'is-accent' : '' },
    { id: 'graph', label: 'Graph', word: '−100', cls: 'is-warn' },
  ];
  return html`<div class="app-root" style=${{ height: '780px', margin: 0, border: '1px solid var(--hairline)' }}>
    <main class="app-main">
      <div class="screen" style=${{ display: 'flex', flexDirection: 'column' }}>
        <div class="viewer">
          <div class="placeholder-surface">MeshViewer</div>
          <div class="viewer-top"><span class="viewer-label">#33 · 2/5</span><span class="viewer-points">800 <small>pts</small></span></div>
          <${Legend} class="viewer-legend" items=${[{ label: 'neuron', kind: 'line' }]} />
          <div class="viewer-expand"><${GhostButton} label="Full view">⤢</${GhostButton}></div>
          <div class="clue-bar">${clues.map((c) => html`<button key=${c.id} type="button" class=${cx('clue-tab', tab === c.id && 'is-active')}
            onClick=${() => setTab(c.id)}><b>${c.label}</b><span class=${c.cls}>${c.word}</span></button>`)}</div>
        </div>
        <div class="question">
          <div class="row-between"><span class="t-title">Which cell?</span><span class="t-num-11 t-muted">3 left</span></div>
          <div class="options">${OPTS.map(([l, label, sub, st]) => html`<button key=${l} type="button" class=${cx('option', `is-${st}`)}>
            <span class="option-head"><span>${l}</span><span class="option-mark">${MARK[st]}</span></span>
            <span class=${cx('option-label', 'fx-strike', (st === 'out' || st === 'wrong') && 'is-struck')}>${label}</span>
            <span class="option-sub">${sub}</span></button>`)}</div>
          <span class="status-line">✕ Not L5 ET pyramidal · −100 · 2 guesses left</span>
        </div>
      </div>
      <div class="lock-bar"><${Button} block>Guess · 800 pts</${Button}></div>
    </main>
    <${TabBar} active="today" dueCount=${3} />
  </div>`;
}

function Gallery() {
  const [seg, setSeg] = useState('day');
  const [chip, setChip] = useState('Lab');
  const [method, setMethod] = useState(null);
  const [sheet, setSheet] = useState(false);
  const [on, setOn] = useState(true);
  return html`<div class="stack-12" style=${{ padding: '16px 0' }}>
    <${Overline}>Buttons</${Overline}>
    <div class="grid-1-2"><${Button} variant="outline">Skip</${Button}><${Button} disabled=${!method}>Lock in · +200</${Button}></div>
    <div class="grid-2"><${Button} variant="link-outline">Neuroglancer ↗</${Button}><${Button} variant="outline">Close</${Button}></div>
    <${Button} block disabled>Pick one answer</${Button}>
    <div class="row"><${GhostButton} label="Zoom in" size="lg">+</${GhostButton}><${GhostButton} label="Zoom out" size="lg">−</${GhostButton}><${GhostButton} label="Close">✕</${GhostButton}><${Button} variant="text">Report a problem</${Button}></div>
    <${Overline}>Segmented · chips · method chips</${Overline}>
    <${Segmented} label="Period" value=${seg} onChange=${setSeg} options=${[{ id: 'day', label: 'Today' }, { id: 'week', label: 'Week' }, { id: 'all', label: 'All-time' }]} />
    <div class="chips">${['Friends', 'Lab', 'Global'].map((c) => html`<${Chip} key=${c} active=${chip === c} onClick=${() => setChip(c)}>${c}</${Chip}>`)}</div>
    <div class="chips">${['sstem', 'fib_sem', 'atum_msem', 'sbem'].map((m) => html`<${Chip} key=${m} variant="lg" active=${method === m} onClick=${() => setMethod(m)}>${METHOD_NAMES[m]}</${Chip}>`)}</div>
    ${method ? html`<span class="t-micro t-muted">${METHOD_BLURBS[method]}</span>` : null}
    <${Overline} tone="accent">✓ Kenyon cell · 800 pts · bonus +200</${Overline}>
    <${Overline} tone="error">✕ It was Kenyon cell · 0 pts</${Overline}>
    <${Card} title="What to notice"><div class="numbered"><span class="n">01</span><span>Every sibling's soma sits in L5, yet all their tufts reach L1.</span><span class="n">02</span><span>Axons head down and leave the volume.</span></div></${Card}>
    <div style=${{ display: 'grid', gridTemplateColumns: '72px minmax(0,1fr) 52px', alignItems: 'center', gap: '10px' }}>
      <span class="t-label">Mouse</span><${Meter} value=${68} max=${120} from=${0} label="Mouse" /><span class="t-num-11 t-right t-soft">68/120</span></div>
    <div class="row-between"><${ScaleBar} pxPerUm=${1.3} /><${Legend} items=${[{ label: "today's cell", kind: 'line' }, { label: 'same type', kind: 'line', color: 'var(--data-sky)' }, { label: 'volume', kind: 'box' }]} /></div>
    <${Banner} action=${html`<button class="btn-text" type="button">Today →</button>`}><span class="t-num">#32</span> · Finish by 00:30 UTC</${Banner}>
    <div class="row"><${OfflineChip} force=${true} /><span class="chip-mono">Personal best</span></div>
    <div class="field"><label for="dn">Display name</label><input id="dn" class="input" placeholder="Player-AB12" /></div>
    <div class="card"><${Toggle} label="Haptics" checked=${on} onChange=${setOn} /></div>
    <div class="grid-2"><${Button} variant="outline" onClick=${() => setSheet(true)}>Open a sheet</${Button}>
      <${Button} variant="outline" onClick=${() => showToast('↑ You passed Ana Ribeiro · now #2 in MRC LMB', { kind: 'accent' })}>Toast</${Button}></div>
    ${sheet ? html`<${Sheet} label="Open Context?" onClose=${() => setSheet(false)}>
      <span class="overline is-warn">Paid clue · −100</span><span class="sheet-title">Open Context?</span>
      <span class="t-body t-soft">Shows the cell inside its tissue volume, with layers or neuropils. Rules out one wrong answer.</span>
      <div class="grid-1-2"><${Button} variant="outline" onClick=${() => setSheet(false)}>Cancel</${Button}><${Button} onClick=${() => setSheet(false)}>Open · −100</${Button}></div>
    </${Sheet}>` : null}
  </div>`;
}

function Page() {
  return html`<div class="screen" style=${{ bottom: 0 }}><div style=${{ padding: '16px' }}>
    <span class="t-title">Components</span>
    <p class="t-body t-soft">css/app.css classes and js/ui components assembled into the handoff's round screen, then a gallery.</p>
    <${RoundReplica} />
    <${Gallery} />
  </div></div><${Toast} low=${true} />`;
}

await hydrateSession();
render(html`<${Page} />`, document.getElementById('app'));
window.__componentsReady = true;
void store;
