// Round screen: type stage + method stage (ARCHITECTURE.md §3 "Round screen", §3.1 fx owned by "play").
// Exports: default Round({ params: { n } }), openClueConfirm({ roundIndex, kind }), ClueConfirmSheet(props).
//
// Everything renders from round_public (store.today.rounds[n-1]) + round_state (store.today.progress[n-1]);
// game.js actions write the new state into the store and resolve to { ok, resp, err }, which only drives fx.
// Local UI state on top of that:
//   pick / mpick   the option card / method chip the player has selected (not sent until Guess / Lock in);
//   holdType       keeps the type-stage question area on screen for a short beat after the type stage ends
//                  (correct guess or 3rd wrong), so the answer card can celebrate before the method stage;
//   ui.holdRound   (store) keeps this screen up ~1 s (3 s cap) after the method pick, so "+200" can fly into the
//                  points readout before today.js hands off to the reveal (cleared on every path + unmount).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { store, useStore, openSheet, showToast } from '../store.js';
import { Button, GhostButton, Legend, ScaleBar, OfflineChip, Tick } from '../ui/components.js';
import { MESH_STEPS } from '../viewer/scalebar.js';
import { Sheet } from '../ui/sheet.js';
import { TodayProgress } from '../ui/day-progress.js';
import {
  guess, chooseMethod, openClue, optionStates, guessesLeft, pointsOf, outcomeOf, loadToday,
} from '../game.js';
import * as api from '../api.js';
import { METHOD_NAMES, METHOD_BLURBS, fmtPts, fmtSigned, methodName } from '../format.js';
import { haptic } from '../fx/haptics.js';
import { celebrateCorrect, checkDraw, shake, stamp, floatUp, countUp, useCountUp, motionAllowed } from '../fx/celebrate.js';
import { emKind, prefetchEm, parseEm, UpdateEm } from '../viewer/em2/factory.js';

loadCss('css/round.css');

const CLUE_NAMES = { context: 'Context', graph: 'Graph' };
// v1.2 (player feedback): a clue is extra information only; it never rules an option out.
export const CLUE_COPY = {
  context: 'Shows the cell in place inside its tissue volume, with layers or regions labelled. Extra information only: every option stays available.',
  graph: 'Shows the cell’s top input and output partner types by synapse count. Extra information only: every option stays available.',
};
const METHOD_TABS = [
  { id: 'xy', label: 'XY', word: 'Slices', aria: 'XY slices' },
  { id: 'xz', label: 'XZ', word: 'Reslice', aria: 'XZ reslice' },
  { id: 'mesh', label: 'Mesh', word: '3D', aria: '3D mesh' },
];
// 'out' = ruled out by a clue: only rounds played before v1.2 carry it (state.eliminated); they still render it.
const MARKS = { picked: '● picked', wrong: '✕ wrong', out: '✕ out', answer: '✓ answer', idle: '' };
const STATE_WORDS = { picked: 'picked', wrong: 'guessed wrong', out: 'ruled out by a clue', answer: 'the answer', idle: '' };

// Per-round UI memory for this session (tab switches unmount the screen; a reload starts fresh).
const memo = new Map(); // round_id → { pick, mpick, typeTab, methodTab, view, touched, slice, plane }
function memoFor(id) {
  if (!memo.has(id)) memo.set(id, { pick: null, mpick: null, typeTab: 'mesh', methodTab: 'xy', view: null, touched: false, slice: null });
  return memo.get(id);
}

// Confirm sheet → round screen: the sheet lives in app.js's overlay host, outside this component.
const clueBus = new Set();
const emitClue = (e) => clueBus.forEach((fn) => { try { fn(e); } catch (err) { console.error(err); } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));
const setHold = (n) => store.update('ui', { holdRound: n });
const clearHold = (n) => { if (store.get().ui.holdRound === n) store.update('ui', { holdRound: null }); };
/** Keyboard / screen-reader focus: the focused Guess button turns disabled (or is replaced by the method stage) and
 *  focus falls to <body>; put it back on the next thing to answer, without scrolling. */
const focusIfLost = (el) => {
  if (typeof document === 'undefined' || !el) return;
  const a = document.activeElement;
  if (!a || a === document.body || a.disabled || !document.contains(a)) {
    try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
  }
};

/** After a wrong guess the "✕ Not … · 2 guesses left" line (under the title) may be scrolled out of view, e.g. after
 *  picking a card low in the grid. Scroll it back in, but only when the card just marked "✕ wrong" stays in view
 *  too (the visible area ends at the lock bar, which overlays the scroll area). */
function revealStatusLine(scroller, card) {
  if (!scroller || typeof scroller.getBoundingClientRect !== 'function') return;
  const status = scroller.querySelector('.status-line');
  if (!status) return;
  const box = scroller.getBoundingClientRect();
  const top = status.getBoundingClientRect().top;
  if (top >= box.top) return;
  const lock = scroller.parentNode && scroller.parentNode.querySelector('.lock-bar');
  const visibleBottom = lock ? Math.min(box.bottom, lock.getBoundingClientRect().top) : box.bottom;
  if (card && card.getBoundingClientRect().bottom > visibleBottom - (box.top - top) - 8) return;
  try {
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop - (box.top - top) - 8), behavior: motionAllowed() ? 'smooth' : 'auto' });
  } catch (_) { scroller.scrollTop = Math.max(0, scroller.scrollTop - (box.top - top) - 8); }
}

/**
 * Status line after a wrong guess (pure): "✕ Not Olfactory PN · −100 · 2 guesses left"; after the 3rd wrong guess
 * "✕ Not … · no guesses left"; null when there is no wrong guess, or while `shakeId` (the guess just sent) still
 * shakes as "● picked".
 */
export function wrongStatus(round, state, shakeId = null) {
  const wrong = (state && state.wrong) || [];
  const last = wrong.length ? wrong[wrong.length - 1] : null;
  const opt = last && last !== shakeId ? ((round && round.options) || []).find((o) => o.id === last) : null;
  if (!opt) return null;
  if (state.stage === 'type') {
    const left = guessesLeft(state);
    return `✕ Not ${opt.label} · −100 · ${left} ${left === 1 ? 'guess' : 'guesses'} left`;
  }
  return state.type_result === 'exhausted' ? `✕ Not ${opt.label} · no guesses left` : null;
}

/**
 * Full view opener args (pure) that continue what the round viewer shows: the opened Context clue when it is the
 * active tab, the EM plane (XY | XZ) and slice, and the 3D orientation (MeshViewer getView()).
 */
export function fullViewArgs({ roundIndex, mode, typeTab = 'mesh', methodTab = 'xy', slice = null, view = null, panel = null }) {
  const args = { roundIndex, mode };
  if (mode === '3d' && typeTab === 'context') args.context = true;
  if (mode === 'em') {
    args.plane = methodTab === 'xz' ? 'xz' : 'xy';
    if (Number.isInteger(slice) && slice >= 0) args.slice = slice;
    if (panel) args.panel = panel;   // EM format 2: the stage's panel (xy | xz | yz | 3d)
  }
  if (mode === '3d' && view && typeof view === 'object') args.view = view;
  return args;
}

/** Toast for a failed round action. 409s already carry the fresh state (game.js applied it). */
function errorToast(err) {
  if (!err || err.code === 'busy') return;
  if (err.isNetwork) { showToast('Couldn’t reach the server. Check your connection and try again.', { kind: 'error' }); return; }
  const msg = {
    rate_limited: ['Too fast. Wait a moment and try again.', 'warn'],
    day_closed: ['This day has closed.', 'warn'],
    already_guessed: ['You already guessed that option.', 'warn'],
    already_eliminated: ['A clue already ruled that option out.', 'warn'],
    stage_over: ['The cell-type guess is already over for this round.', 'warn'],
    method_done: ['The method was already chosen for this round.', 'warn'],
    not_now: ['That isn’t available at this stage of the round.', 'warn'],
    conflict: ['This round changed on another device. It’s up to date now.', 'warn'],
  }[err.code];
  if (msg) showToast(msg[0], { kind: msg[1], glyph: err.status === 409 ? '↻' : null });
  else showToast(err.message || 'Something went wrong. Try again.', { kind: 'error' });
  if (err.code === 'day_closed') loadToday({ force: true });
}

/** Run a paid clue (from the confirm sheet). Resolves to game.js's { ok, resp, err }. */
async function runClue(roundIndex, kind) {
  emitClue({ phase: 'start', roundIndex, kind });
  const r = await openClue(roundIndex, kind);
  emitClue({ phase: 'end', roundIndex, kind, r });
  if (!r.ok) {
    if (r.err && r.err.code !== 'busy' && !r.err.state) haptic('error');
    errorToast(r.err);
  }
  return r;
}

// =====================================================================================================
// Screen
// =====================================================================================================

export default function Round({ params = {} }) {
  const n = Number(params.n) || 1;
  const round = useStore((s) => s.today.rounds[n - 1] || null);
  if (!round) return null;
  return html`<${RoundScreen} key=${round.round_id} n=${n} round=${round} />`;
}

function RoundScreen({ n, round }) {
  const state = useStore((s) => s.today.progress[n - 1] || null);
  const online = useStore((s) => s.ui.online);
  const m = memoFor(round.round_id);

  const stage = state ? state.stage : 'type';
  const [pick, setPickRaw] = useState(m.pick);
  const [mpick, setMpickRaw] = useState(m.mpick);
  const [typeTab, setTypeTabRaw] = useState(m.typeTab);
  const [methodTab, setMethodTabRaw] = useState(m.methodTab);
  const [busy, setBusy] = useState(false);
  const [holdType, setHoldType] = useState(false);
  const [shakeId, setShakeId] = useState(null);
  const [beat, setBeat] = useState(null);           // { kind: 'correct'|'missed', option, named, typeScore }
  const [entry, setEntry] = useState(null);         // the beat that led into the method stage (count-up + stamp)
  const [overPts, setOverPts] = useState(null);     // method-stage overline points (counts up after a correct guess)
  const [methodResult, setMethodResult] = useState(null); // { pick, correct, answer } while the screen is held
  const [landed, setLanded] = useState(false);      // "+200" reached the readout
  const [maskOn, setMaskOn] = useState(true);

  const setPick = (v) => { m.pick = v; setPickRaw(v); };
  const setMpick = (v) => { m.mpick = v; setMpickRaw(v); };
  const setTypeTab = (v) => { m.typeTab = v; setTypeTabRaw(v); };
  const setMethodTab = (v) => { m.methodTab = v; setMethodTabRaw(v); };

  const alive = useRef(true);
  const timers = useRef([]);
  const cardRefs = useRef({});
  const markRefs = useRef({});
  const chipRefs = useRef({});
  const stampRef = useRef(null);
  const readoutRef = useRef(null);
  const lockRef = useRef(null);
  const scrollRef = useRef(null);
  const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.current.push(id); return id; };

  useEffect(() => () => {
    alive.current = false;
    timers.current.forEach(clearTimeout);
    clearHold(n);
  }, []);

  const showType = stage === 'type' || holdType;
  const states = optionStates(round, state);
  const opened = (state && state.clues_opened) || [];
  const busyAny = busy || !!beat || !!methodResult;

  // A pick that is no longer pickable (409 state from another device) is dropped.
  useEffect(() => {
    if (pick && states[pick] !== 'idle' && pick !== shakeId) setPick(null);
  }, [state, pick, shakeId]);

  // A clue tab that is not opened (stale memory, other device) falls back to Mesh.
  const activeTypeTab = typeTab === 'mesh' || opened.includes(typeTab) ? typeTab : 'mesh';

  // Clue opened from the confirm sheet: busy while in flight, then show the new clue.
  useEffect(() => {
    const fn = (e) => {
      if (e.roundIndex !== n || !alive.current) return;
      if (e.phase === 'start') setBusy(true);
      else {
        setBusy(false);
        if (!e.r || !e.r.ok) return;
        // v1.2: a clue rules nothing out (no strike, no scroll); every option and the current pick stay as they were.
        setTypeTab(e.kind);
      }
    };
    clueBus.add(fn);
    return () => { clueBus.delete(fn); };
  }, [n]);

  // Warm the EM as soon as the type stage is over. The next round's mesh is not fetched here: it competed with the
  // EM (≈ 2 s later EM on Fast 3G); today.js warms it at low priority on this round's reveal (prefetchRound).
  const em = state && state.em;
  const emK = emKind(em);
  useEffect(() => {
    if (!em) return;
    if (emK === 'v2') { prefetchEm(em); return; }   // EM format 2 (and dual): levels 0 and L, ortho, outlines, stack A
    const quiet = () => {};
    api.assetBlob(em.atlas).catch(quiet);
    api.assetBlob(em.mask).catch(quiet);
    api.assetBlob(em.xz).catch(quiet);
  }, [em && em.atlas]);

  // ------------------------------------------------------------------------------- type stage actions
  const onPick = (id) => {
    if (states[id] !== 'idle' || busyAny || stage !== 'type' || pick === id) return;
    haptic('selection');
    setPick(id);
  };

  const startBeat = (b) => {
    const ms = motionAllowed() ? (b.kind === 'correct' ? 1150 : 1500) : 900;
    setBeat(b);
    later(() => {
      if (!alive.current) return;
      if (b.kind === 'correct' && motionAllowed()) setOverPts(0);
      setEntry(b);
      setHoldType(false);
      setBeat(null);
      setMethodTab('xy');
    }, ms);
  };

  const onGuess = async () => {
    if (!pick || busyAny || !online || stage !== 'type') return;
    haptic('selection');
    const id = pick;
    setBusy(true);
    setHoldType(true);
    setShakeId(id);
    const r = await guess(n, id);
    if (!alive.current) return;
    const st = (r.resp && r.resp.state) || (r.err && r.err.state) || store.get().today.progress[n - 1];
    if (r.ok && r.resp.correct) {
      setBusy(false);
      setShakeId(null);
      setPick(null);
      const named = outcomeOf(st) === 'named';
      haptic(named ? 'celebrate' : 'success');
      startBeat({ kind: 'correct', option: id, named, typeScore: st ? st.type_score || 0 : 0 });
      return;
    }
    if (r.ok) {
      setPick(null);
      haptic('error');
      await shake(cardRefs.current[id]); // still busy: no new pick until "✕ wrong" is shown
      if (!alive.current) return;
      setBusy(false);
      setShakeId(null);
      if (st && st.stage !== 'type') startBeat({ kind: 'missed', option: id, named: false, typeScore: 0 });
      else {
        setHoldType(false);
        later(() => focusIfLost(scrollRef.current && scrollRef.current.querySelector('.option:not(:disabled)')), 0);
        later(() => revealStatusLine(scrollRef.current, cardRefs.current[id]), 40);
      }
      return;
    }
    setBusy(false);
    setShakeId(null);
    setHoldType(false);
    errorToast(r.err);
  };

  // Correct / missed beat: the answer card (scrolled into view) flashes, draws its ✓ and bursts.
  useEffect(() => {
    if (!beat) return undefined;
    let raf2 = 0;
    const raf = requestAnimationFrame(() => {
      const answer = state && state.correct_option;
      const card = answer && cardRefs.current[answer];
      if (!card) return;
      try { card.scrollIntoView({ block: 'nearest', behavior: beat.kind === 'missed' && motionAllowed() ? 'smooth' : 'auto' }); } catch (_) { /* old engines */ }
      raf2 = requestAnimationFrame(() => {
        checkDraw(markRefs.current[answer]);
        if (beat.kind === 'correct') celebrateCorrect(card, { named: beat.named });
      });
    });
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); };
  }, [beat]);

  // Entering the method stage: back to the top; after a live correct guess the overline points count up
  // 0 → type score and a named round stamps "Named ✓".
  // Scroll reset and stamp start before paint: otherwise the first method-stage frame shows the old scroll offset
  // (blank padding) and the "Named ✓" chip at rest before it stamps in.
  useLayoutEffect(() => {
    if (showType) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (entry && entry.kind === 'correct' && entry.named) stamp(stampRef.current);
    if (entry) focusIfLost(scrollRef.current && scrollRef.current.querySelector('.method-chip'));
  }, [showType, entry]);
  useEffect(() => {
    if (showType) return undefined;
    if (!entry || entry.kind !== 'correct') return undefined;
    let counter = null;
    const raf = requestAnimationFrame(() => {
      counter = countUp(0, entry.typeScore, (v) => { if (alive.current) setOverPts(v); }, { duration: 600 });
    });
    return () => { cancelAnimationFrame(raf); if (counter) counter.cancel(); };
  }, [showType, entry]);

  // ------------------------------------------------------------------------------- method stage actions
  const onMethodPick = (id) => {
    if (busyAny || stage !== 'method' || holdType) return;
    haptic('selection');
    if (mpick !== id) setMpick(id);
  };

  const onLockMethod = async (skip) => {
    if (busyAny || !online || stage !== 'method' || holdType) return;
    const choice = skip ? null : mpick;
    if (!skip && !choice) return;
    haptic('selection');
    setBusy(true);
    setHold(n);
    const r = await chooseMethod(n, choice);
    if (!alive.current) { clearHold(n); return; }
    setBusy(false);
    if (!r.ok) { clearHold(n); errorToast(r.err); return; }
    if (skip) { clearHold(n); return; }
    const safety = later(() => clearHold(n), 3000);
    const motion = motionAllowed();
    setMethodResult({ pick: choice, correct: !!r.resp.correct, answer: r.resp.method_answer });
    await nextFrame();
    if (r.resp.correct) {
      haptic('success');
      await floatUp('+200', lockRef.current, readoutRef.current);
      if (!alive.current) return;
      setLanded(true);
      await sleep(motion ? 450 : 900);
    } else {
      haptic('error');
      // the "✓ answer" chip is often below the fold (3+ chips with blurbs under a 400 px viewer): bring it in
      const ans = chipRefs.current[r.resp.method_answer];
      try { if (ans) ans.scrollIntoView({ block: 'nearest', behavior: motion ? 'smooth' : 'auto' }); } catch (_) { /* old engines */ }
      await shake(chipRefs.current[choice]);
      await sleep(motion ? 800 : 1000);
    }
    clearTimeout(safety);
    clearHold(n);
  };

  // ------------------------------------------------------------------------------- render
  const answerOpt = state && state.correct_option ? round.options.find((o) => o.id === state.correct_option) : null;
  const typeScore = state && typeof state.type_score === 'number' ? state.type_score : 0;
  const shownOverPts = overPts === null ? typeScore : overPts;
  const outcome = outcomeOf(state);
  const exhausted = state && state.type_result === 'exhausted';

  const verdict = (stage !== 'type' && answerOpt) ? html`<${Verdict} key="verdict"
    exhausted=${exhausted} label=${answerOpt.label} pts=${shownOverPts} named=${outcome === 'named'} stampRef=${stampRef} />` : null;

  let question;
  if (showType) {
    const status = wrongStatus(round, state, shakeId);
    // the status line sits under the title, not under the 6 cards: below them it is off screen at 375 × 780
    question = html`<div class="question" key="type">
      <div class="row-between">
        <h1 class="t-title round-h">Which cell?</h1>
      </div>
      ${status ? html`<span class="status-line" role="status">${status}</span>` : null}
      <${OptionGrid} round=${round} states=${states} pick=${pick} shakeId=${shakeId} beat=${beat}
        disabled=${busyAny || stage !== 'type'} onPick=${onPick} cardRefs=${cardRefs} markRefs=${markRefs} />
    </div>`;
  } else {
    question = html`<div class="question" key="method">
      ${verdict}
      <div class="round-method round-enter">
        <h1 class="t-title round-h">How was this cell imaged?</h1>
        <${MethodChips} options=${round.method_options} mpick=${mpick} result=${methodResult}
          disabled=${busyAny || stage !== 'method'} onPick=${onMethodPick} chipRefs=${chipRefs} />
      </div>
    </div>`;
  }

  // lock bar
  let lockBar;
  if (showType) {
    const label = !online ? 'Offline'
      : beat ? (beat.kind === 'correct' ? '✓ Correct' : '✕ No guesses left')
        : pick ? `Guess · ${fmtPts(pointsOf(state))} pts` : 'Pick one answer';
    lockBar = html`<div class=${cx('lock-bar', beat && `is-${beat.kind}`)}>
      <${Button} block disabled=${!pick || !online || busyAny || stage !== 'type'} aria-busy=${busy ? 'true' : null}
        onClick=${onGuess}>${label}</${Button}>
    </div>`;
  } else {
    const done = stage !== 'method';
    lockBar = html`<div class="lock-bar"><div class="grid-1-2">
      <${Button} variant="outline" disabled=${!online || busyAny || done} onClick=${() => onLockMethod(true)}>Skip</${Button}>
      <${Button} disabled=${!mpick || !online || busyAny || done} aria-busy=${busy ? 'true' : null}
        onClick=${() => onLockMethod(false)}><span ref=${lockRef}>${online ? 'Lock in · +200' : 'Offline'}</span></${Button}>
    </div></div>`;
  }

  // points readout (top-right)
  let readout;
  if (showType) readout = html`<${Points} value=${stage === 'type' ? pointsOf(state) : typeScore} refEl=${readoutRef} />`;
  else if (methodResult) readout = html`<${Points} value=${landed ? typeScore + 200 : typeScore} refEl=${readoutRef} />`;
  else readout = html`<span class="viewer-points" ref=${readoutRef} aria-label=${`${fmtPts(typeScore)} points, plus 200 for the right method`}>${fmtPts(typeScore)} + 200?</span>`;

  return html`<div class="round">
    <${Viewer} n=${n} round=${round} state=${state} memoState=${m} online=${online}
      mode=${showType ? 'type' : 'method'} typeTab=${activeTypeTab} methodTab=${methodTab}
      busy=${busyAny} maskOn=${maskOn} setMaskOn=${setMaskOn} readout=${readout}
      onTypeTab=${(id) => { if (id !== activeTypeTab) { haptic('selection'); setTypeTab(id); } }}
      onMethodTab=${(id) => { if (id !== methodTab) { haptic('selection'); setMethodTab(id); } }} />
    <div class="round-scroll" ref=${scrollRef}><${TodayProgress} playing=${n} showTotal=${false} class="in-round" />${question}</div>
    ${lockBar}
  </div>`;
}

// ------------------------------------------------------------------------------- question parts

function Verdict({ exhausted, label, pts, named, stampRef }) {
  return html`<div class="round-verdict" role="status">
    ${exhausted
      ? html`<span class="round-verdict-text is-error">✕ It was ${label} · 0 pts</span>`
      : html`<span class="round-verdict-text is-accent">✓ ${label} · <span class="t-num">${fmtPts(pts)}</span> pts</span>`}
    ${named ? html`<span class="chip-mono round-stamp" ref=${stampRef}>Named ✓</span>` : null}
  </div>`;
}

function OptionGrid({ round, states, pick, shakeId, beat, disabled, onPick, cardRefs, markRefs }) {
  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[e.key];
    if (!step) return;
    const cards = [...e.currentTarget.querySelectorAll('.option')];
    let i = cards.indexOf(document.activeElement);
    if (i < 0) return;
    for (i += step; i >= 0 && i < cards.length; i += step) {
      if (!cards[i].disabled) { e.preventDefault(); cards[i].focus(); return; }
    }
  };
  return html`<div class="options" role="group" aria-label="Cell type options" onKeyDown=${onKeyDown}>
    ${round.options.map((o) => {
      let st = states[o.id] || 'idle';
      if (o.id === shakeId) st = 'picked';
      else if (st === 'idle' && pick === o.id) st = 'picked';
      const live = beat && st === 'answer'; // the ✓ is drawn by checkDraw() into an empty mark
      const letter = o.id.toUpperCase();
      return html`<button key=${o.id} type="button" ref=${(el) => { cardRefs.current[o.id] = el; }}
        class=${cx('option', st !== 'idle' && `is-${st}`)}
        disabled=${st === 'wrong' || st === 'out' || st === 'answer' || (disabled && st !== 'picked')}
        aria-pressed=${st === 'picked' ? 'true' : 'false'}
        aria-label=${`${letter}: ${o.label}, ${o.sub}${STATE_WORDS[st] ? `, ${STATE_WORDS[st]}` : ''}`}
        onClick=${() => onPick(o.id)}>
        <span class="option-head" aria-hidden="true"><span>${letter}</span>
          <span class="option-mark">${live
            ? html`<span ref=${(el) => { markRefs.current[o.id] = el; }}></span> answer`
            : MARKS[st]}</span></span>
        <span class="option-label" aria-hidden="true"><span class=${cx('round-strike', (st === 'out' || st === 'wrong') && 'is-struck')}>${o.label}</span></span>
        <span class="option-sub" aria-hidden="true">${o.sub}</span><${Tick} />
      </button>`;
    })}
  </div>`;
}

function MethodChips({ options, mpick, result, disabled, onPick, chipRefs }) {
  const onKeyDown = (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const chips = [...e.currentTarget.querySelectorAll('.method-chip')];
    const i = chips.indexOf(document.activeElement);
    const j = i + step;
    if (i < 0 || j < 0 || j >= chips.length) return;
    e.preventDefault();
    chips[j].focus();
  };
  return html`<div class="method-chips" role="group" aria-label="Imaging method" onKeyDown=${onKeyDown}>
    ${options.map((id) => {
      let st = mpick === id ? 'picked' : 'idle';
      if (result) {
        if (id === result.pick) st = result.correct ? 'right' : 'wrong';
        else if (id === result.answer) st = 'answer';
        else st = 'idle';
      }
      const mark = { picked: '● picked', right: '✓ +200', wrong: '✕ your pick', answer: '✓ answer', idle: '' }[st];
      const name = METHOD_NAMES[id] || methodName(id);
      return html`<button key=${id} type="button" ref=${(el) => { chipRefs.current[id] = el; }}
        class=${cx('chip-lg', 'method-chip', st !== 'idle' && `is-${st}`)}
        aria-pressed=${st === 'picked' || st === 'right' ? 'true' : 'false'}
        aria-disabled=${disabled ? 'true' : null}
        aria-label=${`${name}${mark ? `, ${mark.replace(/^[●✓✕] /, '')}` : ''}. ${METHOD_BLURBS[id] || ''}`}
        onClick=${() => onPick(id)}>
        <span class="method-chip-head" aria-hidden="true"><span class="method-chip-name">${name}</span><span class="option-mark">${mark}</span></span>
        ${METHOD_BLURBS[id] ? html`<span class="method-chip-blurb" aria-hidden="true">${METHOD_BLURBS[id]}</span>` : null}<${Tick} />
      </button>`;
    })}
  </div>`;
}

/** Mono accent points readout: ticks to the new value; a drop flashes warn and shows the delta. */
function Points({ value, refEl }) {
  const shown = useCountUp(value, { duration: 500 });
  const prev = useRef(value);
  const [delta, setDelta] = useState(null);
  const [warn, setWarn] = useState(false);
  useEffect(() => {
    const d = value - prev.current;
    prev.current = value;
    if (d >= 0) return undefined;
    setDelta({ id: Date.now(), text: fmtSigned(d) });
    const el = refEl && refEl.current;
    if (motionAllowed()) {
      setWarn(true);
      if (el && el.animate) el.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 360, easing: 'ease-out' });
    }
    const t1 = setTimeout(() => setWarn(false), 700);
    const t2 = setTimeout(() => setDelta(null), 1000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [value]);
  return html`<span class=${cx('viewer-points', 'round-points', warn && 'is-warn')} ref=${refEl}
    aria-label=${`${fmtPts(value)} points`}>${fmtPts(shown)} <small>pts</small>${delta
      ? html`<span key=${delta.id} class="round-delta" aria-hidden="true">${delta.text}</span>` : null}</span>`;
}

// =====================================================================================================
// Specimen viewer: overlays, clue switcher and the active pane (mesh / context, graph, EM)
// =====================================================================================================

function Viewer({ n, round, state, memoState, online, mode, typeTab, methodTab, busy, maskOn, setMaskOn, readout, onTypeTab, onMethodTab }) {
  const stage = state ? state.stage : 'type';
  const opened = (state && state.clues_opened) || [];
  const clues = (state && state.clues) || {};
  // EM format 2 (dual too, unless its stage failed: then the format 1 keys); an unknown format asks for an update
  const [v1Fallback, setV1Fallback] = useState(!!memoState.v1Fallback);
  const emParsed = mode === 'method' && state && state.em ? parseEm(state.em) : null;
  const em2 = !!(emParsed && emParsed.kind === 'v2' && !v1Fallback);
  const emV1 = emParsed ? (emParsed.kind === 'v1' || (emParsed.dual && v1Fallback) ? emParsed.v1 : null) : null;

  let pane = null;
  let legend = null;
  let expandMode = null;
  let tabs;
  if (mode === 'type') {
    const ctx = typeTab === 'context' ? clues.context || null : null;
    if (typeTab === 'graph' && clues.graph) {
      pane = html`<${GraphPane} key="graph" asset=${clues.graph.asset} />`;
    } else {
      pane = html`<${MeshPane} key="mesh" round=${round} context=${ctx} memoState=${memoState} />`;
      legend = ctx ? [{ label: 'neuron', kind: 'line' }, { label: 'volume', kind: 'box' }] : null;   // a lone mesh needs no key (v0.6.1)
      expandMode = '3d';
    }
    tabs = [{ id: 'mesh', label: 'Mesh', word: '', tone: typeTab === 'mesh' ? 'accent' : null, active: typeTab === 'mesh' }];
    for (const c of round.paid_clues) {
      const isOpen = opened.includes(c.kind);
      const active = isOpen && typeTab === c.kind;
      const canOpen = !isOpen && stage === 'type';
      const word = isOpen ? '' : !canOpen ? 'Locked' : !online ? 'Offline' : `−${c.cost}`;
      const disabled = !isOpen && (!canOpen || !online || busy);
      tabs.push({
        id: c.kind, label: CLUE_NAMES[c.kind] || c.kind, word, active, disabled,
        tone: active ? 'accent' : word.startsWith('−') ? 'warn' : null,
        aria: isOpen ? `${CLUE_NAMES[c.kind]} clue, ${active ? 'viewing' : 'opened'}` : `Open the ${CLUE_NAMES[c.kind]} clue, costs ${c.cost} points`,
        onClick: () => {
          if (isOpen) onTypeTab(c.kind);
          else if (canOpen && online && !busy) { haptic('selection'); openClueConfirm({ roundIndex: n, kind: c.kind }); }
        },
      });
    }
    tabs[0].onClick = () => onTypeTab('mesh');
    tabs[0].aria = typeTab === 'mesh' ? 'Mesh, viewing' : 'Mesh, free';
  } else if (em2) {
    const onFail = emParsed.dual ? () => { memoState.v1Fallback = true; setV1Fallback(true); } : null;
    pane = html`<${Em2Pane} key="em2" round=${round} state=${state} memoState=${memoState} onFail=${onFail} />`;
    expandMode = 'em';
    tabs = null;   // XY · XZ · YZ · 3D live in the pane (hidden in the desktop 4panel)
  } else if (emParsed && emParsed.kind === 'unknown') {
    pane = html`<${UpdateEm} key="em-update" />`;
    tabs = null;
  } else {
    if (methodTab === 'mesh') {
      pane = html`<${MeshPane} key="mesh" round=${round} context=${null} memoState=${memoState} />`;
      legend = null;
      expandMode = '3d';
    } else if (emV1) {
      pane = html`<${EmPane} key="em" em=${emV1} plane=${methodTab} maskOn=${maskOn} setMaskOn=${setMaskOn} memoState=${memoState} />`;
      expandMode = 'em';
    }
    tabs = METHOD_TABS.map((t) => ({
      ...t, active: methodTab === t.id, word: t.word, tone: methodTab === t.id ? 'accent' : null,
      aria: `${t.aria}${methodTab === t.id ? ', viewing' : ''}`,
      onClick: () => onMethodTab(t.id),
    }));
  }

  const expand = () => {
    haptic('selection');
    const live = (fn, fallbackValue) => { try { return fn(); } catch (_) { return fallbackValue; } };
    const args = fullViewArgs({
      roundIndex: n, mode: expandMode,
      typeTab: mode === 'type' ? typeTab : 'mesh', methodTab,
      slice: memoState.liveEm ? live(() => memoState.liveEm.getSlice(), memoState.slice) : memoState.slice,
      view: memoState.liveMesh ? live(() => memoState.liveMesh.getView(), memoState.view) : memoState.view,
      panel: em2 && memoState.liveEm2 ? memoState.liveEm2.panel : null,
    });
    const fallback = () => store.update('ui', { fullView: args });
    import('./fullview.js').then((mod) => {
      if (typeof mod.openFullView === 'function') mod.openFullView(args);
      else fallback();
    }, fallback);
  };

  const em = mode === 'method' && (em2 || methodTab !== 'mesh');
  return html`<section class=${cx('viewer', 'round-viewer', em && 'is-em', em2 && 'is-em2')} aria-label="Specimen">
    <div class="viewer-canvas">${pane}</div>
    <div class="viewer-top">
      <span class="round-tag"><span class="viewer-label">Day ${round.day_number}<span class="round-tag-n"> · Round ${n} of 5</span></span><${OfflineChip} /></span>
      ${readout}
    </div>
    ${legend ? html`<${Legend} class="viewer-legend" items=${legend} />` : null}
    ${expandMode ? html`<div class="viewer-expand"><${GhostButton} label="Full view" onClick=${expand}>⤢</${GhostButton}></div>` : null}
    ${tabs ? html`<div class="clue-bar" role="group" aria-label=${mode === 'type' ? 'Clues' : 'EM views'}>
      ${tabs.map((t) => html`<button key=${t.id} type="button" class=${cx('clue-tab', t.active && 'is-active')}
        aria-pressed=${t.active ? 'true' : 'false'} aria-label=${t.aria} disabled=${!!t.disabled} onClick=${t.onClick}>
        <b>${t.label}</b><span class=${t.tone ? `is-${t.tone}` : ''}>${t.word}</span>
      </button>`)}
    </div>` : null}
  </section>`;
}

function ViewerMessage({ status, what, onRetry }) {
  if (status === 'ready' || !status) return null;
  if (status === 'error') {
    return html`<div class="round-msg is-error" role="alert"><span>✕ ${what} didn’t load</span>
      ${onRetry ? html`<button type="button" class="btn-text" onClick=${onRetry}>Try again</button>` : null}</div>`;
  }
  return html`<div class="round-msg" role="status"><span>Loading ${what}…</span></div>`;
}

/** MeshViewer (neuron; + context volume when `context` is the opened context clue), with its µm scale bar (v0.6.0). */
function MeshPane({ round, context, memoState }) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const [status, setStatus] = useState('loading');
  const [pxPerUm, setPxPerUm] = useState(0);
  const [ctxStatus, setCtxStatus] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [ctxAttempt, setCtxAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let viewer = null;
    let offScale = null;
    const host = hostRef.current;
    const touched = () => { memoState.touched = true; };
    host.addEventListener('pointerdown', touched);
    setStatus('loading');
    (async () => {
      try {
        const [{ MeshViewer }, buf] = await Promise.all([import('../viewer/mesh-viewer.js'), api.assetArrayBuffer(round.mesh.asset)]);
        if (!alive) return;
        viewer = new MeshViewer(host, { autoRotate: !memoState.touched, interactive: true, initialView: memoState.view || undefined });
        viewerRef.current = viewer;
        memoState.liveMesh = viewer; // full view continues from this orientation
        // scale bar: zoom and the context framing change px per µm (auto-rotation alone emits nothing)
        offScale = viewer.onChange((info) => {
          const p = info && info.pxPerUm;
          if (alive && p > 0) setPxPerUm((old) => (Math.abs(old - p) / p > 0.004 ? p : old));
        });
        setStatus('drawing'); // the viewer shows its own "Loading 3D…" line from here
        await viewer.loadNeuron(buf.slice(0), { bboxUm: round.mesh.bbox_um });
        if (alive) setStatus('ready');
      } catch (err) {
        console.warn('[round] mesh', err);
        if (!alive) return;
        // one message, with a retry: drop a half-built viewer and its own status line
        if (viewer) { try { viewer.dispose(); } catch (_) { /* ignore */ } viewer = null; viewerRef.current = null; }
        if (memoState.liveMesh) memoState.liveMesh = null;
        setStatus('error');
      }
    })();
    return () => {
      alive = false;
      host.removeEventListener('pointerdown', touched);
      if (offScale) offScale();
      if (viewer) {
        try { memoState.view = viewer.getView(); } catch (_) { /* ignore */ }
        try { viewer.dispose(); } catch (err) { console.warn(err); }
      }
      if (memoState.liveMesh === viewer) memoState.liveMesh = null;
      viewerRef.current = null;
    };
  }, [round.mesh.asset, attempt]);

  const ctxKey = context ? context.volume : null;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (status !== 'ready' || !viewer) return undefined;
    let alive = true;
    if (!context) {
      setCtxStatus(null);
      Promise.resolve(viewer.setContext(null)).catch((err) => console.warn(err));
      return undefined;
    }
    setCtxStatus('loading');
    Promise.all([
      api.assetArrayBuffer(context.volume),
      context.labels ? api.assetJSON(context.labels) : Promise.resolve(null),
    ]).then(([volume, labels]) => {
      if (!alive) return null;
      return viewer.setContext({ volume: volume.slice(0), labels, offsetUm: context.neuron_offset_um });
    }).then(() => { if (alive) setCtxStatus('ready'); }, (err) => {
      console.warn('[round] context', err);
      if (alive) setCtxStatus('error');
    });
    return () => { alive = false; };
  }, [status, ctxKey, ctxAttempt]);

  const retry = () => setAttempt((a) => a + 1);
  return html`<div class="round-pane">
    <div class="round-canvas" ref=${hostRef}></div>
    <${ViewerMessage} status=${status === 'drawing' ? 'ready' : status} what="mesh" onRetry=${retry} />
    ${status === 'ready' ? html`<${ViewerMessage} status=${ctxStatus} what="context" onRetry=${() => setCtxAttempt((a) => a + 1)} />` : null}
    ${status === 'ready' && pxPerUm > 0 ? html`<div class="round-scale is-mesh"><${ScaleBar} pxPerUm=${pxPerUm} maxPx=${120} steps=${MESH_STEPS} /></div>` : null}
  </div>`;
}

/** Graph clue (GraphView, SVG) sized to the space between the top overlays and the clue bar. */
function GraphPane({ asset }) {
  const hostRef = useRef(null);
  const [size, setSize] = useState(null);
  const [graph, setGraph] = useState(null);
  const [View, setView] = useState(null);
  const [status, setStatus] = useState('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = hostRef.current;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    Promise.all([import('../viewer/graph-view.js'), api.assetJSON(asset)]).then(([mod, json]) => {
      if (!alive) return;
      setView(() => mod.GraphView);
      setGraph(json);
      setStatus('ready');
    }, (err) => {
      console.warn('[round] graph', err);
      if (alive) setStatus('error');
    });
    return () => { alive = false; };
  }, [asset, attempt]);

  return html`<div class="round-pane">
    <div class="round-graph" ref=${hostRef}>
      ${status === 'ready' && View && size && size.w > 0 ? html`<${View} graph=${graph} width=${size.w} height=${size.h} />` : null}
    </div>
    <${ViewerMessage} status=${status} what="graph" onRetry=${() => setAttempt((a) => a + 1)} />
  </div>`;
}

/** EM format 2 (js/viewer/em2/view.js, loaded with the method stage): one EmStage per round, its own chrome and tabs. */
function Em2Pane({ round, state, memoState, onFail }) {
  const [mod, setMod] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import('../viewer/em2/view.js').then((m) => { if (alive) setMod(m); }, (err) => {
      console.warn('[round] em2', err);
      if (!alive) return;
      if (onFail) onFail(err); else setFailed(true);
    });
    return () => { alive = false; if (memoState.liveEm2) memoState.liveEm2 = null; };
  }, []);
  if (failed) return html`<${ViewerMessage} status="error" what="EM" />`;
  if (!mod) return html`<${ViewerMessage} status="loading" what="EM" />`;
  return html`<${mod.Em2View} mode="inline" roundId=${round.round_id} em=${state.em} meshAsset=${round.mesh && round.mesh.asset}
    done=${state.stage === 'done'} onFail=${onFail} onStage=${(st) => { memoState.liveEm2 = st; }} />`;
}

/** EmViewer: XY z-stack (mask toggle, z stepper) or the XZ reslice; µm scale bar; never a voxel size. */
function EmPane({ em, plane, maskOn, setMaskOn, memoState }) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const [status, setStatus] = useState('loading');
  const [info, setInfo] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let viewer = null;
    let unsub = null;
    setStatus('loading');
    (async () => {
      try {
        const opt = (p) => api.assetBlob(p).catch((err) => { console.warn('[round] em part', err); return null; });
        const [{ EmViewer }, atlas, mask, xz] = await Promise.all([
          import('../viewer/em-viewer.js'), api.assetBlob(em.atlas), opt(em.mask), opt(em.xz),
        ]);
        if (!alive) return;
        viewer = new EmViewer(hostRef.current, { interactive: true, showMask: maskOn });
        viewerRef.current = viewer;
        memoState.liveEm = viewer; // full view continues from this slice
        setStatus('drawing'); // the viewer shows its own "Loading EM…" line while it decodes: one line, not two
        const off = viewer.onChange((i) => { if (alive) setInfo({ ...i }); });
        unsub = typeof off === 'function' ? off : null;
        await viewer.load({ atlas, mask, xz, fieldUm: em.field_um, nSlices: em.n_slices, tile: 512, cols: 8 });
        if (!alive) return;
        viewer.setPlane(plane);
        viewer.setMaskVisible(maskOn);
        if (Number.isInteger(memoState.slice)) viewer.setSlice(memoState.slice);
        setInfo((i) => ({ plane, nSlices: em.n_slices, ...(i || {}), slice: viewer.getSlice() }));
        setStatus('ready');
      } catch (err) {
        console.warn('[round] em', err);
        if (!alive) return;
        // one message, with a retry: drop a half-built viewer and its own status line
        if (viewer) {
          try { viewer.dispose(); } catch (_) { /* ignore */ }
          if (memoState.liveEm === viewer) memoState.liveEm = null;
          viewer = null; viewerRef.current = null;
        }
        setStatus('error');
      }
    })();
    return () => {
      alive = false;
      if (unsub) unsub();
      if (viewer) {
        try { memoState.slice = viewer.getSlice(); } catch (_) { /* ignore */ }
        try { viewer.dispose(); } catch (err) { console.warn(err); }
      }
      if (memoState.liveEm === viewer) memoState.liveEm = null;
      viewerRef.current = null;
    };
  }, [em.atlas, attempt]);

  useEffect(() => {
    const v = viewerRef.current;
    if (status === 'ready' && v) { v.setPlane(plane); setInfo((i) => (i ? { ...i, plane } : i)); }
  }, [plane, status]);
  useEffect(() => {
    const v = viewerRef.current;
    if (status === 'ready' && v) v.setMaskVisible(maskOn);
  }, [maskOn, status]);

  const step = (d) => {
    const v = viewerRef.current;
    if (!v || status !== 'ready') return;
    haptic('selection');
    v.step(d);
    const slice = v.getSlice();
    memoState.slice = slice;
    setInfo((i) => ({ ...(i || {}), slice }));
  };
  const nSlices = (info && info.nSlices) || em.n_slices;
  const slice = info && Number.isInteger(info.slice) ? info.slice : null;
  const xy = plane === 'xy';

  return html`<div class="round-pane">
    <div class="round-canvas" ref=${hostRef}></div>
    <${ViewerMessage} status=${status === 'drawing' ? 'ready' : status} what="EM" onRetry=${() => setAttempt((a) => a + 1)} />
    ${status === 'ready' && xy ? html`<button type="button" class="round-mask" aria-pressed=${maskOn ? 'true' : 'false'}
      aria-label="Highlight this cell"
      onClick=${() => { haptic('selection'); setMaskOn(!maskOn); }}>
      <span class="round-mask-key" aria-hidden="true"></span>this cell</button>` : null}
    ${status === 'ready' && xy && slice !== null ? html`<div class="round-zstep">
      <${GhostButton} label="Previous slice" onClick=${() => step(-1)} disabled=${slice <= 0}>▲</${GhostButton}>
      <span class="round-z" aria-label=${`Slice ${slice + 1} of ${nSlices}`}>${slice + 1}/${nSlices}</span>
      <${GhostButton} label="Next slice" onClick=${() => step(1)} disabled=${slice >= nSlices - 1}>▼</${GhostButton}>
    </div>` : null}
    ${status === 'ready' && info && info.pxPerUm > 0 ? html`<div class="round-scale"><${ScaleBar} pxPerUm=${info.pxPerUm} maxPx=${120} steps=${[1, 2, 5, 10, 20]} /></div>` : null}
  </div>`;
}

// =====================================================================================================
// Paid clue confirm sheet (app.js overlay id "clueConfirm")
// =====================================================================================================

export function openClueConfirm({ roundIndex, kind }) { openSheet('clueConfirm', { roundIndex, kind }); }

export function ClueConfirmSheet({ roundIndex, kind, onClose }) {
  const online = useStore((s) => s.ui.online);
  const round = useStore((s) => s.today.rounds[roundIndex - 1] || null);
  const state = useStore((s) => s.today.progress[roundIndex - 1] || null);
  const stale = !round || !CLUE_NAMES[kind] || !!(state && (state.stage !== 'type' || state.clues_opened.includes(kind)));
  useEffect(() => { if (stale) onClose(); }, [stale]);
  if (stale) return null;
  const cost = (round.paid_clues.find((c) => c.kind === kind) || { cost: 100 }).cost;
  const name = CLUE_NAMES[kind];
  const confirm = () => {
    if (!online) return;
    onClose();
    runClue(roundIndex, kind);
  };
  return html`<${Sheet} label=${`Open ${name}?`} onClose=${onClose}>
    <span class="overline is-warn">Paid clue · −${cost}</span>
    <span class="sheet-title">Open ${name}?</span>
    <span class="t-body t-soft">${CLUE_COPY[kind]}</span>
    <div class="grid-1-2">
      <${Button} variant="outline" onClick=${onClose}>Cancel</${Button}>
      <${Button} haptic="light" disabled=${!online} onClick=${confirm}>${online ? `Open · −${cost}` : 'Offline'}</${Button}>
    </div>
  </${Sheet}>`;
}
