// First-launch how-to-play sheet (W2 "social"; ARCHITECTURE.md §3 "Onboarding").
// Three panels: mesh → cell-type guess with paid clues; EM → imaging method; scoring (1,000 / −100 / +200,
// 3-guess cap) with an optional display name. Finishing, skipping, Escape or a scrim tap all call
// markOnboarded() (store.session.onboarded + IndexedDB 'onboarded'), so main.js never opens it again.
// Settings → "How to play" reopens it with { replay: true } (no name field).
// Exports: openOnboarding(props), default OnboardingSheet({ onClose, replay }).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { store, useStore, openSheet, markOnboarded, showToast } from '../store.js';
import { Sheet } from '../ui/sheet.js';
import { Button } from '../ui/components.js';
import * as api from '../api.js';
import * as idb from '../idb.js';
import { METHOD_NAMES } from '../format.js';
import { haptic } from '../fx/haptics.js';
import { burst } from '../fx/celebrate.js';

loadCss('css/social.css');

export function openOnboarding(props = {}) { openSheet('onboarding', props); }

const STEPS = 3;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// the demo shows the methods a real round offers (round_public.method_options, same for every round of a bundle);
// before today has loaded, the classes of the datasets in the current pool
const DEMO_METHODS = ['sstem', 'fib_sem', 'atum_msem'];

// A schematic neuron (soma, dendrites, axon) for panel 1: data-black strokes inside a data area.
const NEURON_PATHS = [
  'M100 74 L92 52 L80 34', 'M92 52 L98 30', 'M80 34 L70 22', 'M80 34 L84 18',
  'M100 74 L120 56 L134 40', 'M120 56 L132 60 L150 52', 'M134 40 L130 22', 'M134 40 L150 30',
  'M100 74 L74 70 L54 76', 'M74 70 L62 58', 'M54 76 L40 70',
  'M100 74 L104 100 L100 128 L110 150 L108 170', 'M100 128 L84 146', 'M110 150 L126 162',
];

function MeshFigure() {
  const day = useStore((s) => s.today.dayNumber);
  return html`<div class="ob-fig" aria-hidden="true">
    <span class="ob-fig-tl">#${day || 1} · 1/5</span><span class="ob-fig-tr">1,000 pts</span>
    <svg class="ob-neuron" viewBox="0 0 200 180" width="200" height="150">
      ${NEURON_PATHS.map((d, i) => html`<path key=${i} d=${d} pathLength="1" style=${{ animationDelay: `${(i % 5) * 60}ms` }} />`)}
      <circle cx="100" cy="74" r="6" />
    </svg>
    <div class="ob-cluebar">
      <span class="is-active"><b>Mesh</b><span class="t-accent">Viewing</span></span>
      <span><b>Context</b><span class="t-warn">−100</span></span>
      <span><b>Graph</b><span class="t-warn">−100</span></span>
    </div>
  </div>`;
}

function MethodFigure() {
  const live = useStore((s) => (s.today.rounds[0] && s.today.rounds[0].method_options) || null);
  const ids = (Array.isArray(live) && live.length ? live : DEMO_METHODS).filter((id) => METHOD_NAMES[id]);
  const picked = ids[Math.min(1, ids.length - 1)];
  return html`<div class="ob-methods" aria-hidden="true">
    <span class="overline is-accent">✓ Named · bonus +200</span>
    ${ids.map((id) => html`<span key=${id} class=${cx('chip-lg', id === picked && 'is-active')}>
      ${METHOD_NAMES[id]}${id === picked ? html`<span class="ob-picked">● picked</span>` : null}</span>`)}
  </div>`;
}

function ScoreFigure() {
  return html`<div class="ob-score">
    <div class="kv">
      <span class="k">Each round starts at</span><span class="v">1,000</span>
      <span class="k">Paid clue or wrong guess</span><span class="v t-warn">−100</span>
      <span class="k">Third wrong guess</span><span class="v t-error">✕ type 0</span>
      <span class="k">Right imaging method</span><span class="v t-accent">+200</span>
      <span class="k">Best round · best day</span><span class="v">1,200 · 6,000</span>
    </div>
    <div class="ob-strip" aria-label="Example result strip: round 2, one clue used, one wrong guess, then right, method right">
      <span class="t-num-13">2 ■□ <span class="t-error">✕</span><span class="t-accent">✓</span> M</span>
      <span class="t-micro t-muted">Your share strip: clues used, wrong guesses, ✓, M for the method. No spoilers.</span>
    </div>
  </div>`;
}

const PANELS = [
  {
    over: 'Step 1 · the cell',
    title: 'Name the cell',
    body: 'Five neurons a day, each from a real connectome. Turn the 3D mesh and pick its cell type from six options.',
    more: 'Stuck? Context and Graph are paid clues: −100 each for extra information, and every option stays available. You get three guesses.',
    Figure: MeshFigure,
  },
  {
    over: 'Step 2 · the microscope',
    title: 'How was it imaged?',
    body: 'Once the type is settled, the same cell appears in its electron microscopy. Pick the imaging method for a bonus.',
    more: 'One try. The side view (XZ) shows how thick the sections were, which is the best hint.',
    Figure: MethodFigure,
  },
  {
    over: 'Step 3 · the score',
    title: 'Scoring',
    body: 'Fewer clues and fewer wrong guesses score more. Ranks compare you with friends, your lab and everyone.',
    more: null,
    Figure: ScoreFigure,
  },
];

export default function OnboardingSheet({ onClose, replay = false }) {
  const me = useStore((s) => s.session.me);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [name, setName] = useState('');
  const startRef = useRef(null);
  const swipe = useRef(null);
  const closing = useRef(false);

  const trimmed = name.trim();
  const nameError = trimmed && (Array.from(trimmed).length > 24 || CONTROL.test(trimmed)) ? 'Use 1–24 plain characters.' : null;
  const last = step === STEPS - 1;

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    markOnboarded();
    onClose && onClose();
  };

  const finish = () => {
    if (nameError) return;
    haptic('success');
    burst(startRef.current, { count: 14 });
    if (!replay && trimmed && (!me || trimmed !== me.display_name)) {
      api.updateMe({ display_name: trimmed }).then((resp) => {
        store.update('session', { me: resp });
        idb.set('cache:me', resp);
      }).catch(() => {
        showToast('Your name was not saved. Set it in Ranks → Profile.', { kind: 'warn' });
      });
    }
    close();
  };

  const stepRef = useRef(step);
  const go = (delta) => {
    const next = Math.max(0, Math.min(STEPS - 1, stepRef.current + delta));
    if (next === stepRef.current) return;
    stepRef.current = next;
    haptic('selection');
    setDir(delta);
    setStep(next);
  };

  // ← / → step through the panels (the dialog container holds focus, so listen on the document)
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); goRef.current(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goRef.current(-1); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  const onPointerDown = (e) => { swipe.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const p = PANELS[step];
  const Figure = p.Figure;
  return html`<${Sheet} label="How to play NeuroGuesser" onClose=${close} strongScrim class="ob">
    <div class="ob-top">
      <span class="overline">How to play · <span class="t-num">${step + 1}/${STEPS}</span></span>
      ${last ? null : html`<${Button} variant="text" class="is-muted" onClick=${close}>${replay ? 'Close' : 'Skip'}</${Button}>`}
    </div>
    <div class="ob-progress" role="progressbar" aria-valuemin="1" aria-valuemax=${STEPS} aria-valuenow=${step + 1} aria-label="Step">
      ${PANELS.map((_, i) => html`<span key=${i} class=${cx(i <= step && 'is-on')}></span>`)}
    </div>
    <div class="ob-body" onPointerDown=${onPointerDown} onPointerUp=${onPointerUp}>
      <div key=${step} class=${cx('ob-panel', dir < 0 && 'is-back')} aria-live="polite">
        <${Figure} />
        <span class="overline">${p.over}</span>
        <span class="sheet-title">${p.title}</span>
        <span class="t-body t-soft">${p.body}</span>
        ${p.more ? html`<span class="t-label t-muted">${p.more}</span>` : null}
        ${last && !replay ? html`<div class="field ob-name">
          <label for="ob-name">Name on the leaderboard <span class="t-muted">(optional)</span></label>
          <input id="ob-name" class="input" type="text" maxlength="24" autocomplete="nickname" spellcheck="false"
            placeholder=${me ? me.display_name : 'Player-XXXX'} value=${name} onInput=${(e) => setName(e.currentTarget.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(); } }}
            aria-invalid=${nameError ? 'true' : 'false'} aria-describedby="ob-name-hint" />
          <span id="ob-name-hint" class=${cx('t-micro', nameError ? 't-error' : 't-muted')}>${nameError ? `✕ ${nameError}` : 'Change it any time in Ranks → Profile.'}</span>
        </div>` : null}
      </div>
    </div>
    ${step === 0
    ? html`<${Button} block onClick=${() => go(1)}>Next</${Button}>`
    : html`<div class="grid-1-2">
        <${Button} variant="outline" onClick=${() => go(-1)}>Back</${Button}>
        ${last
    ? html`<span ref=${startRef} class="ob-start"><${Button} block disabled=${!!nameError} onClick=${finish}>${replay ? 'Done' : 'Start playing'}</${Button}></span>`
    : html`<${Button} onClick=${() => go(1)}>Next</${Button}>`}
      </div>`}
  </${Sheet}>`;
}
