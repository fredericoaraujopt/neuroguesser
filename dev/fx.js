// Dev page: every celebration effect and haptic from js/fx/*, wired the way the screens should use them.
// Open http://localhost:5173/dev/fx.html (on a phone for haptics). Settings toggles here are the app's real
// settings (same origin, same IndexedDB).
import { useRef, useState } from 'preact/hooks';
import { html, render, cx } from '../js/ui/html.js';
import { store, useStore, hydrateSession, setSettings, showToast, closeSheet } from '../js/store.js';
import { Button, Chip, Toggle, Meter, Toast } from '../js/ui/components.js';
import { haptic, hapticsSupport, KINDS, PATTERNS, TICKS } from '../js/fx/haptics.js';
import {
  burst, checkDraw, shake, strike, pulse, flash, stamp, floatUp, flip, countUp, useCountUp, motionAllowed,
  celebrateCorrect, rays, STREAK_MILESTONES,
} from '../js/fx/celebrate.js';
import { StreakCounter } from '../js/fx/streak.js';
import { openMilestone, MilestoneSheet } from '../js/fx/milestone.js';
import { formatOvertake, diffOvertakes } from '../js/fx/overtake.js';
import { fmtPts } from '../js/format.js';
import { VERSION } from '../version.js';

const OPTIONS = [
  { id: 'a', label: 'Kenyon cell', sub: 'Drosophila · mushroom body · memory' },
  { id: 'b', label: 'L2/3 IT pyramidal', sub: 'Mouse · V1 · intratelencephalic' },
  { id: 'c', label: 'Olfactory PN', sub: 'Drosophila · antennal lobe · relay' },
  { id: 'd', label: 'Lateral horn neuron', sub: 'Drosophila · lateral horn · innate odour' },
];

function Section({ title, note, children }) {
  return html`<section class="card">
    <div class="row-between"><span class="card-title">${title}</span>${note ? html`<span class="t-micro t-muted">${note}</span>` : null}</div>
    ${children}
  </section>`;
}

// ---------------------------------------------------------------- round moments
function RoundDemo() {
  const [points, setPoints] = useState(1000);
  const [states, setStates] = useState({});
  const [picked, setPicked] = useState(null);
  const [status, setStatus] = useState(null);
  const [overline, setOverline] = useState(null);
  const shown = useCountUp(points, { duration: 500 });
  const cards = useRef({});
  const marks = useRef({});
  const readout = useRef(null);
  const overRef = useRef(null);

  const reset = () => { setPoints(1000); setStates({}); setPicked(null); setStatus(null); setOverline(null); };
  const warnFlash = () => readout.current && readout.current.animate && motionAllowed()
    && readout.current.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 360 });

  const clue = () => {
    haptic('light');
    const target = OPTIONS.find((o) => !states[o.id] && o.id !== 'a' && o.id !== picked);
    if (!target) return;
    // declarative strike: class fx-strike + is-struck draws the line (250 ms), .is-out fades the card to 45%
    setStates((s) => ({ ...s, [target.id]: 'out' }));
    setPoints((p) => p - 100);
    warnFlash();
  };
  const wrong = () => {
    const target = picked && picked !== 'a' ? picked : OPTIONS.find((o) => !states[o.id] && o.id !== 'a').id;
    haptic('error');
    shake(cards.current[target]);
    setTimeout(() => {
      setStates((s) => ({ ...s, [target]: 'wrong' }));
      setStatus(`✕ Not ${OPTIONS.find((o) => o.id === target).label} · −100 · ${2 - Object.values(states).filter((v) => v === 'wrong').length} guesses left`);
    }, 280);
    setPoints((p) => p - 100);
    setPicked(null);
  };
  const correct = (named) => {
    haptic(named ? 'celebrate' : 'success');
    setStates((s) => ({ ...s, a: 'answer' }));
    setPicked(null);
    setOverline(named ? 'NAMED ✓ · 1,000 PTS' : `✓ KENYON CELL · ${fmtPts(points)} PTS`);
    requestAnimationFrame(() => {
      checkDraw(marks.current.a);
      celebrateCorrect(cards.current.a, { named, overlineEl: overRef.current });
    });
    if (named) setPoints(1000);
  };

  return html`<${Section} title="Round: clue, wrong, correct, named" note="play">
    <div class="row-between">
      <span class="t-title">Which cell?</span>
      <span class="viewer-points" ref=${readout}>${fmtPts(shown)} <small>pts</small></span>
    </div>
    ${overline ? html`<span key=${overline} ref=${overRef} class=${cx('overline', 'is-accent')}>${overline}</span>` : null}
    <div class="options">
      ${OPTIONS.map((o) => {
        const st = states[o.id] || (picked === o.id ? 'picked' : 'idle');
        const mark = st === 'wrong' ? '✕ wrong' : st === 'out' ? '✕ out' : st === 'picked' ? '● picked' : '';
        return html`<button key=${o.id} type="button" ref=${(el) => { cards.current[o.id] = el; }}
          class=${cx('option', `is-${st}`)} disabled=${st === 'wrong' || st === 'out' || st === 'answer'}
          onClick=${() => { haptic('selection'); setPicked(o.id); }}>
          <span class="option-head"><span>${o.id.toUpperCase()}</span>
            <span class="option-mark">${st === 'answer' ? html`<span ref=${(el) => { marks.current[o.id] = el; }}></span> answer` : mark}</span></span>
          <span class=${cx('option-label', 'fx-strike', (st === 'out' || st === 'wrong') && 'is-struck')}>${o.label}</span>
          <span class="option-sub">${o.sub}</span>
        </button>`;
      })}
    </div>
    ${status ? html`<span class="status-line">${status}</span>` : null}
    <div class="chips">
      <${Chip} onClick=${clue}>Open clue · −100</${Chip}>
      <${Chip} onClick=${wrong}>Wrong guess</${Chip}>
      <${Chip} onClick=${() => correct(false)}>Correct</${Chip}>
      <${Chip} onClick=${() => correct(true)}>Named</${Chip}>
      <${Chip} onClick=${reset}>Reset</${Chip}>
    </div>
  </${Section}>`;
}

// ---------------------------------------------------------------- method +200 & perfect round
function MethodDemo() {
  const [score, setScore] = useState(1000);
  const shown = useCountUp(score, { duration: 600 });
  const lockRef = useRef(null);
  const readRef = useRef(null);
  const verdictRef = useRef(null);
  const stampRef = useRef(null);
  const [perfect, setPerfect] = useState(false);
  const lock = () => {
    haptic('success');
    floatUp('+200', lockRef.current, readRef.current).then(() => setScore((s) => s + 200));
  };
  const perfectRound = () => {
    haptic('celebrate');
    setPerfect(true);
    requestAnimationFrame(() => { pulse(verdictRef.current); stamp(stampRef.current); });
  };
  return html`<${Section} title="Method +200 · perfect round" note="play / reveal">
    <div class="row-between">
      <span ref=${verdictRef} class="t-label t-accent t-strong" style=${{ padding: '4px 6px', borderRadius: '8px' }}>✓ Named · <span class="t-num">${fmtPts(shown)}</span> pts</span>
      <span class="viewer-points" ref=${readRef}>${fmtPts(shown)}</span>
    </div>
    ${perfect ? html`<span key="p" ref=${stampRef} class="overline is-accent">Perfect round</span>` : null}
    <div class="grid-1-2">
      <${Button} variant="outline" onClick=${() => { setScore(1000); setPerfect(false); }}>Reset</${Button}>
      <${Button} onClick=${lock}><span ref=${lockRef}>Lock in · +200</span></${Button}>
    </div>
    <${Button} variant="outline" block onClick=${perfectRound}>Perfect round (1,200)</${Button}>
  </${Section}>`;
}

// ---------------------------------------------------------------- day complete
function DayDemo() {
  const [run, setRun] = useState(0);
  return html`<${Section} title="Day complete" note="reveal">
    ${run ? html`<${DaySummary} key=${run} />` : html`<span class="t-micro t-muted">Count-up total, staggered rows, personal best.</span>`}
    <${Button} variant="outline" block onClick=${() => { haptic('success'); setRun((r) => r + 1); }}>${run ? 'Replay' : 'Finish the day'}</${Button}>
  </${Section}>`;
}

function DaySummary() {
  const total = useCountUp(4200, { from: 0, duration: 900 });
  const rows = [['1', '□□ ✓ M', 1200], ['2', '■□ ✕✓ M', 1000], ['3', '□□ ✕✕✓ ·', 800], ['4', '■■ ✕✕✕ M', 200], ['5', '□□ ✓ ·', 1000]];
  return html`<div class="stack">
    <div class="row-between"><span class="overline">NeuroGuesser #214 · Today</span><span class="chip-mono">Personal best</span></div>
    <span class="t-num-18"><span class="t-accent">${fmtPts(total)}</span> / 6,000</span>
    <div class="stack-4 fx-stagger">
      ${rows.map(([i, s, p]) => html`<div key=${i} class="row-between hairline-top" style=${{ paddingTop: '6px' }}>
        <span class="t-num-11 t-muted">${i}</span><span class="t-num-11" style=${{ flex: 1 }}>${s}</span><span class="t-num-11">${fmtPts(p)}</span></div>`)}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- streak
function StreakDemo() {
  const [streak, setStreak] = useState(12);
  const [from, setFrom] = useState(undefined);
  const plus = () => {
    const next = streak + 1;
    setFrom(streak);
    setStreak(next);
    if (STREAK_MILESTONES.includes(next)) openMilestone({ streak: next });
    else haptic('celebrate');
  };
  return html`<${Section} title="Streak +1 · milestones" note=${`milestones ${STREAK_MILESTONES.join(' ')}`}>
    <${StreakCounter} streak=${streak} from=${from} />
    <div class="chips">
      <${Chip} onClick=${plus}>+1 day</${Chip}>
      <${Chip} onClick=${() => { setFrom(undefined); setStreak(6); }}>Set 6</${Chip}>
      <${Chip} onClick=${() => openMilestone({ streak: 30 })}>Milestone sheet</${Chip}>
    </div>
  </${Section}>`;
}

// ---------------------------------------------------------------- overtake + FLIP
const BOARD = [
  { user_id: 'u1', display_name: 'Greg Jefferis', total: 2800, affiliation: 'MRC LMB' },
  { user_id: 'u2', display_name: 'Ana Ribeiro', total: 2650, affiliation: 'UCL' },
  { user_id: 'u3', display_name: 'Priya Nair', total: 2400, affiliation: 'MRC LMB' },
  { user_id: 'me', display_name: 'You', total: 2300, affiliation: 'MRC LMB', is_me: true },
  { user_id: 'u5', display_name: 'Leo Marsh', total: 1200, affiliation: 'MRC LMB' },
];
const ranked = (rows) => [...rows].sort((a, b) => b.total - a.total).map((r, i) => ({ ...r, rank: i + 1 }));

function OvertakeDemo() {
  const [rows, setRows] = useState(ranked(BOARD));
  const listRef = useRef(null);
  const go = () => {
    const prev = { rows, me: rows.find((r) => r.is_me) };
    const nextRows = ranked(rows.map((r) => (r.is_me ? { ...r, total: r.total + 400 } : r)));
    const play = flip(listRef.current);
    setRows(nextRows);
    requestAnimationFrame(() => play({ glowKey: 'me' }));
    const ev = diffOvertakes(prev, { rows: nextRows, me: nextRows.find((r) => r.is_me) }, 'me');
    if (ev) {
      showToast(formatOvertake({ ...ev, scope: 'lab', groupName: 'MRC LMB' }), { kind: 'accent', duration: 3600 });
      haptic('celebrate');
    }
  };
  return html`<${Section} title="Overtake · FLIP reorder" note="reveal toast / ranks">
    <div ref=${listRef} class="stack-4">
      ${rows.map((r) => html`<div key=${r.user_id} data-key=${r.user_id} class="row-between"
        style=${{ minHeight: '44px', padding: '4px 8px', alignItems: 'center', position: 'relative', borderLeft: `2px solid ${r.is_me ? 'var(--accent)' : 'transparent'}`, background: r.is_me ? 'var(--surface-panel)' : 'transparent', borderRadius: '0' }}>
        <span class="t-num-11 t-muted" style=${{ width: '20px', textAlign: 'right' }}>${r.rank}</span>
        <span class="t-card" style=${{ flex: 1 }}>${r.display_name}</span>
        <span class="t-num-13">${fmtPts(r.total)}</span>
      </div>`)}
    </div>
    <div class="chips">
      <${Chip} onClick=${go}>You score +400</${Chip}>
      <${Chip} onClick=${() => setRows(ranked(BOARD))}>Reset</${Chip}>
    </div>
  </${Section}>`;
}

// ---------------------------------------------------------------- review + atlas
function ReviewDemo() {
  const [answered, setAnswered] = useState(null);
  const [named, setNamed] = useState(1);
  const shownNamed = useCountUp(named, { duration: 500 });
  const [seen, setSeen] = useState(41);
  const rowRefs = useRef({});
  const markRef = useRef(null);
  const pick = (id) => {
    if (answered) return;
    setAnswered(id);
    if (id === 'b') { haptic('success'); requestAnimationFrame(() => checkDraw(markRef.current)); setNamed((n) => n + 1); }
    else { haptic('error'); shake(rowRefs.current[id]); }
  };
  const opts = [{ id: 'a', label: 'Mushroom body output neuron' }, { id: 'b', label: 'Kenyon cell' }];
  return html`<${Section} title="Review · atlas coverage" note="library">
    ${opts.map((o) => {
      const isAns = answered && o.id === 'b';
      const isWrong = answered === o.id && o.id !== 'b';
      return html`<button key=${o.id} type="button" ref=${(el) => { rowRefs.current[o.id] = el; }}
        class=${cx('option-row', isAns && 'is-answer', isWrong && 'is-wrong')} onClick=${() => pick(o.id)}>
        <span>${o.label}</span>
        <span class="option-mark">${isAns ? html`<span ref=${markRef}></span> answer` : isWrong ? '✕ your pick' : ''}</span>
      </button>`;
    })}
    <div class="row-between"><span class="t-label">${shownNamed} of 3 named</span>
      <${Button} variant="text" onClick=${() => setAnswered(null)}>Next</${Button}></div>
    <div style=${{ display: 'grid', gridTemplateColumns: '72px minmax(0,1fr) 52px', alignItems: 'center', gap: '10px' }}>
      <span class="t-label">Fly</span><${Meter} value=${seen} max=${90} label="Fly coverage" /><span class="t-num-11 t-right t-soft">${seen}/90</span>
    </div>
    <${Chip} onClick=${() => setSeen((s) => Math.min(90, s + 9))}>Coverage grows</${Chip}>
  </${Section}>`;
}

// ---------------------------------------------------------------- raw primitives
function PrimitivesDemo() {
  const target = useRef(null);
  const text = useRef(null);
  const mark = useRef(null);
  const num = useRef(null);
  const ray = useRef(null);
  const [n, setN] = useState(0);
  const resetStrike = () => { const el = text.current; el.classList.remove('is-struck'); el.style.opacity = ''; };
  const items = [
    ['burst', () => burst(target.current)],
    ['burst big', () => burst(target.current, { count: 28, big: true })],
    ['checkDraw', () => checkDraw(mark.current)],
    ['shake', () => shake(target.current)],
    ['strike', () => { resetStrike(); strike(text.current); }],
    ['pulse', () => pulse(target.current)],
    ['flash', () => flash(target.current)],
    ['stamp', () => stamp(text.current)],
    ['floatUp', () => floatUp('+200', target.current, num.current)],
    ['countUp', () => countUp(0, 1200, setN, { duration: 600 })],
    ['rays', () => rays(ray.current)],
    ['reset', () => { resetStrike(); setN(0); }],
  ];
  return html`<${Section} title="Primitives" note="js/fx/celebrate.js">
    <div class="row" style=${{ gap: '16px' }}>
      <div ref=${target} class="option" style=${{ flex: 1 }}>
        <span class="option-head"><span>A</span><span class="option-mark t-accent"><span ref=${mark}></span></span></span>
        <span ref=${text} class="option-label">Kenyon cell</span>
        <span class="option-sub">Drosophila \u00B7 mushroom body</span>
      </div>
      <div ref=${ray} style=${{ width: '64px', height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span ref=${num} class="t-num-18 t-accent">${fmtPts(n)}</span>
      </div>
    </div>
    <div class="chips">${items.map(([label, fn]) => html`<${Chip} key=${label} onClick=${fn}>${label}</${Chip}>`)}</div>
  </${Section}>`;
}

// ---------------------------------------------------------------- haptics
function HapticsDemo() {
  const [last, setLast] = useState(null);
  const support = hapticsSupport();
  return html`<${Section} title="Haptics" note=${`support: ${support}`}>
    <span class="t-micro t-muted">Android: navigator.vibrate patterns. iOS 18+: hidden switch ticks (1–3, ~80 ms apart). Tap on a phone to feel them.</span>
    <div class="chips">
      ${KINDS.map((k) => html`<${Chip} key=${k} onClick=${() => setLast({ k, fired: haptic(k) })}>${k}</${Chip}>`)}
    </div>
    <span class="t-num-11 t-muted">${last ? `${last.k}: ${JSON.stringify(PATTERNS[last.k])} · ${TICKS[last.k]} tick(s) · ${last.fired ? 'fired' : 'not fired (unsupported or off)'}` : '—'}</span>
  </${Section}>`;
}

function Settings() {
  const settings = useStore((s) => s.session.settings);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return html`<${Section} title="Settings" note=${reduced ? 'prefers-reduced-motion: reduce' : 'motion allowed by the OS'}>
    <${Toggle} label="Haptics" checked=${settings.haptics} onChange=${(v) => setSettings({ haptics: v })} />
    <${Toggle} label="Celebrations" hint="Off = reduced motion: instant end states" checked=${settings.celebrations}
      onChange=${(v) => { setSettings({ celebrations: v }); document.documentElement.classList.toggle('no-motion', !v); }} />
  </${Section}>`;
}

function Page() {
  const sheet = useStore((s) => s.ui.sheet);
  return html`
    <div class="screen" style=${{ bottom: 0 }}>
      <div class="screen-pad">
        <div class="screen-head"><span class="t-title">fx demo</span><span class="t-num-11 t-muted">v${VERSION}</span></div>
        <span class="t-body t-soft">Every celebration and haptic in js/fx, as the screens should use them. Accent + ink only, transform/opacity, ≤ 900 ms, never blocking.</span>
        <${Settings} />
        <${RoundDemo} />
        <${MethodDemo} />
        <${DayDemo} />
        <${StreakDemo} />
        <${OvertakeDemo} />
        <${ReviewDemo} />
        <${PrimitivesDemo} />
        <${HapticsDemo} />
      </div>
    </div>
    ${sheet && sheet.id === 'milestone' ? html`<${MilestoneSheet} ...${sheet.props} onClose=${closeSheet} />` : null}
    <${Toast} low=${true} />`;
}

await hydrateSession();
document.documentElement.classList.toggle('no-motion', store.get().session.settings.celebrations === false);
render(html`<${Page} />`, document.getElementById('app'));
window.__fxReady = true;
