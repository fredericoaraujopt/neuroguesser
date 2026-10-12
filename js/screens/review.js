// Spaced-repetition review (ARCHITECTURE.md §3 "Review", §3.1 "Review answer"; contracts/api.md "Library and
// review"; handoff screen 6). Full screen, no tab bar (router: fullScreen).
//
//   ✕ quits · one progress segment per queue item · overline "REVIEW i / n · #33·2 · MISSED"
//   the type's mesh (MeshViewer, review_item.mesh, public gate) · 4 options a–d (review-local letters)
//   tap → POST /v1/review → "✓ answer" on the answer (✓ draws when you got it) / "✕ your pick" (shake)
//   → verdict + fact card → Next · completion "N of M named" (counts up) + schedule copy (correct → 7 then
//   21 days, wrong → 2 days). Each answer refreshes me.due_count (Library badge) and is remembered for the
//   Library's "✓ Review done…" note (IndexedDB 'library:reviewDone').
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { store, useStore, showToast } from '../store.js';
import * as api from '../api.js';
import * as idb from '../idb.js';
import { navigate } from '../router.js';
import { Button, GhostButton, ScaleBar } from '../ui/components.js';
import { MeshViewer } from '../viewer/mesh-viewer.js';
import { haptic } from '../fx/haptics.js';
import { checkDraw, shake, burst, useCountUp, motionAllowed } from '../fx/celebrate.js';
import { loadMe } from '../game.js';
import { loadReviewQueue, freshQueue, loadLibrary, todayDate, roundTag, REVIEW_DONE_KEY, INTERVALS } from './library.js';

loadCss('css/library.css');

const NUM_WORDS = ['no', 'one', 'two', 'three', 'four', 'five'];
const word = (n) => NUM_WORDS[n] || String(n);
const allOf = (n) => (n === 2 ? 'Both' : `All ${word(n)}`); // "Both", never "All two"
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const daysFor = (step) => INTERVALS[step] ?? INTERVALS[0];

/** Days list → "7", "7 or 21". */
function joinDays(days) {
  if (days.length <= 1) return String(days[0]);
  return `${days.slice(0, -1).join(', ')} or ${days[days.length - 1]}`;
}

/**
 * Schedule copy for the completion screen and the Library note, from POST /review results
 * ({ correct, step }): correct → step 1 (7 days) or 2 (21 days); wrong → step 0 (2 days).
 */
export function scheduleCopy(results) {
  const n = results.length;
  if (!n) return 'Nothing left to review: these cells were already reviewed.';
  const named = results.filter((r) => r.correct);
  const missed = n - named.length;
  const days = [...new Set(named.map((r) => daysFor(r.step)))].sort((a, b) => a - b);
  if (named.length === n) {
    const all = n === 1 ? 'It comes back' : `${allOf(n)} come back`;
    return days.length === 1 && days[0] === INTERVALS[1] ? `${all} in ${INTERVALS[1]} days, then ${INTERVALS[2]}.` : `${all} in ${joinDays(days)} days.`;
  }
  const parts = [];
  if (named.length) parts.push(`${named.length === 1 ? 'The cell you named comes' : 'Cells you named come'} back in ${joinDays(days)} days.`);
  parts.push(missed === n && n > 1
    ? `${allOf(n)} return in ${INTERVALS[0]} days.`
    : `${cap(word(missed))} missed ${missed === 1 ? 'cell returns' : 'cells return'} in ${INTERVALS[0]} days.`);
  return parts.join(' ');
}

const ERR_COPY = {
  not_due: 'Already reviewed · this cell is not due any more.',
  not_found: 'This cell changed since the review started · skipped.',
};

export default function Review() {
  const online = useStore((s) => s.ui.online);
  const [phase, setPhase] = useState('loading'); // loading | playing | done | empty | offline | error
  const [items, setItems] = useState([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({}); // round_id → { pick, sending, result?, stale? }
  const [error, setError] = useState(null);
  const bodyRef = useRef(null);
  const resultsRef = useRef([]);
  const sendingRef = useRef(false);

  const start = (list) => {
    if (!list || !list.length) { setPhase('empty'); return; }
    setItems(list);
    setIdx(0);
    setAnswers({});
    resultsRef.current = [];
    setPhase('playing');
  };

  const fetchQueue = () => {
    setPhase('loading');
    loadReviewQueue().then(start, (err) => {
      setError(err);
      setPhase(err instanceof api.ApiError && err.isNetwork ? 'offline' : 'error');
    });
  };

  useEffect(() => {
    const q = freshQueue();
    if (q) start(q);
    else fetchQueue();
  }, []);

  const item = items[idx] || null;
  const a = item ? answers[item.round_id] || null : null;
  const answered = !!(a && (a.result || a.stale));
  const n = items.length;

  // warm the next cell's mesh while this one is answered
  useEffect(() => {
    const next = items[idx + 1];
    if (next && next.mesh) api.assetArrayBuffer(next.mesh.asset).catch(() => {});
  }, [items, idx]);

  // leave by replacing #/review, so Back from the Library does not reopen a finished (or quit) review
  const leave = () => navigate('/library', { replace: true });
  const quit = () => {
    if (resultsRef.current.length) loadLibrary(); // the Library's due card and statuses changed
    leave();
  };

  const pick = (opt) => {
    if (!item || answered || (a && a.sending) || sendingRef.current) return;
    haptic('selection');
    sendingRef.current = true;
    const rid = item.round_id;
    setAnswers((s) => ({ ...s, [rid]: { pick: opt, sending: true } }));
    api.submitReview({ round_id: rid, option: opt }).finally(() => { sendingRef.current = false; }).then((result) => {
      setAnswers((s) => ({ ...s, [rid]: { pick: opt, sending: false, result } }));
      haptic(result.correct ? 'success' : 'error');
      resultsRef.current = [...resultsRef.current, result];
      afterAnswer(item, result, resultsRef.current);
    }, (err) => {
      const code = err instanceof api.ApiError ? err.code : null;
      if (code === 'not_due' || code === 'not_found') {
        setAnswers((s) => ({ ...s, [rid]: { pick: opt, sending: false, stale: code } }));
        dropFromQueue(item.type_id);
        loadMe();
        return;
      }
      setAnswers((s) => { const next = { ...s }; delete next[rid]; return next; });
      haptic('error');
      const msg = err instanceof api.ApiError && err.isNetwork ? 'Couldn’t reach the server · your answer was not saved, try again'
        : code === 'rate_limited' ? 'Too fast · wait a moment and try again'
          : 'Couldn’t save your answer · try again';
      showToast(msg, { kind: 'error' });
    });
  };

  const next = () => {
    const finishing = idx >= n - 1;
    const results = resultsRef.current;
    // inside the tap (iOS haptics need a user gesture): a clean sweep finishes with 'success'
    haptic(finishing && results.length && results.every((r) => r.correct) ? 'success' : 'selection');
    if (!finishing) {
      setIdx(idx + 1);
      if (bodyRef.current) bodyRef.current.scrollTo({ top: 0, behavior: motionAllowed() ? 'smooth' : 'auto' });
    } else {
      setPhase('done');
      loadLibrary();
    }
  };

  // keyboard: a–d answer; Enter / → next (Next is also focused after an answer)
  useEffect(() => {
    if (phase !== 'playing') return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); quit(); return; }
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (!answered && item && ['a', 'b', 'c', 'd'].includes(k) && item.options.some((o) => o.id === k)) { e.preventDefault(); pick(k); return; }
      const onControl = e.target && e.target.closest && e.target.closest('button, a, [role="slider"]');
      if (answered && (k === 'enter' || k === 'arrowright') && !onControl) { e.preventDefault(); next(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  let body;
  if (phase === 'playing' && item) {
    body = html`<${ReviewStep} key="step" item=${item} index=${idx} total=${n} answer=${a} answered=${answered}
      onPick=${pick} onNext=${next} bodyRef=${bodyRef} />`;
  } else if (phase === 'done') {
    body = html`<${Complete} results=${resultsRef.current} onFinish=${() => { haptic('selection'); leave(); }} />`;
  } else if (phase === 'loading') {
    body = html`<div class="rv-state" aria-busy="true"><span class="overline">Review</span><span class="t-body t-soft" role="status">Loading your review…</span></div>`;
  } else {
    body = html`<${StateCard} phase=${phase} online=${online} error=${error} onRetry=${fetchQueue} onBack=${quit} />`;
  }

  return html`<div class="rv" aria-label="Review">
    <div class="rv-top">
      <${GhostButton} label="Quit review" onClick=${() => { haptic('selection'); quit(); }}>✕</${GhostButton}>
      ${phase === 'playing' || phase === 'done' ? html`<${Progress} total=${n} index=${idx} answered=${answered} done=${phase === 'done'} />` : html`<span></span>`}
      <span></span>
    </div>
    ${body}
  </div>`;
}

/** After a saved answer: badge (optimistic −1, then /me), queue cache, and the Library note. */
function afterAnswer(item, result, results) {
  dropFromQueue(item.type_id);
  store.set((s) => (s.session.me && s.session.me.due_count > 0
    ? { session: { ...s.session, me: { ...s.session.me, due_count: s.session.me.due_count - 1 } } }
    : null));
  loadMe();
  const named = results.filter((r) => r.correct).length;
  idb.set(REVIEW_DONE_KEY, {
    date: todayDate(), named, total: results.length,
    note: `✓ Review done · ${named} of ${results.length} named. ${scheduleCopy(results)}`,
  });
}

function dropFromQueue(typeId) {
  store.update('library', (l) => (l.queue && l.queue.items
    ? { queue: { ...l.queue, items: l.queue.items.filter((q) => q.type_id !== typeId) } }
    : {}));
}

function Progress({ total, index, answered, done }) {
  return html`<div class="rv-progress" role="progressbar" aria-label="Review progress" aria-valuemin="0" aria-valuemax=${total}
    aria-valuenow=${done ? total : index + (answered ? 1 : 0)}>
    ${Array.from({ length: total }, (_, i) => {
      const isDone = done || i < index || (i === index && answered);
      return html`<span key=${i} class=${cx('rv-seg', isDone && 'is-done', !done && i === index && 'is-current')}></span>`;
    })}
  </div>`;
}

function ReviewStep({ item, index, total, answer, answered, onPick, onNext, bodyRef }) {
  const nextRef = useRef(null);
  const verdictRef = useRef(null);
  const optRefs = useRef({});
  const checkRef = useRef(null);
  const result = answer && answer.result;
  const stale = answer && answer.stale;

  // a new cell replaces the focused Next button: keep focus inside the step (not on <body>), so Tab continues
  // from the top of this cell and screen readers stay in the review
  useEffect(() => {
    const el = bodyRef && bodyRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [item.round_id]);

  // fx: ✓ draws on the answer when you got it; the wrong pick shakes. Then bring the verdict + Next into view.
  useEffect(() => {
    if (!answered) return;
    if (result && result.correct) checkDraw(checkRef.current);
    if (result && !result.correct) shake(optRefs.current[answer.pick]);
    const t = setTimeout(() => {
      const btn = nextRef.current;
      if (!btn) return;
      btn.scrollIntoView({ block: 'nearest', behavior: motionAllowed() ? 'smooth' : 'auto' });
      btn.focus({ preventScroll: true });
    }, result && !result.correct && motionAllowed() ? 300 : 0); // after the shake
    return () => clearTimeout(t);
  }, [answered, item.round_id]);

  const answerId = result ? result.answer : null;
  const outcome = String(item.outcome || '').toUpperCase();
  const title = item.outcome === 'missed' ? 'Name it this time' : 'Name it again';
  const last = index === total - 1;

  return html`<div class="rv-body" ref=${bodyRef} tabIndex="-1">
    <span class="overline" aria-live="polite">REVIEW ${index + 1} / ${total} · ${roundTag(item.day_number, item.round_index)} · ${outcome}</span>
    <${ReviewViewer} mesh=${item.mesh} />
    <h1 class="t-title rv-title">${title}</h1>
    <div class="rv-options" role="group" aria-label="Which cell is this?">
      ${item.options.map((o) => {
        const isAnswer = !!result && o.id === answerId;
        const isWrongPick = !!result && !result.correct && answer.pick === o.id;
        const isPicked = !!answer && answer.pick === o.id && !result;
        let mark = null;
        if (isAnswer && result.correct) mark = html`<span class="option-mark rv-mark"><span class="rv-check" ref=${checkRef} aria-hidden="true"></span> answer</span>`;
        else if (isAnswer) mark = html`<span class="option-mark rv-mark">✓ answer</span>`;
        else if (isWrongPick) mark = html`<span class="option-mark rv-mark">✕ your pick</span>`;
        else if (isPicked) mark = html`<span class="option-mark rv-mark">${answer.sending ? '● checking' : '● picked'}</span>`;
        else if (stale && answer.pick === o.id) mark = html`<span class="option-mark rv-mark">● picked</span>`;
        return html`<button key=${o.id} type="button" ref=${(el) => { optRefs.current[o.id] = el; }}
          class=${cx('option-row', 'rv-option', isAnswer && 'is-answer', isWrongPick && 'is-wrong', isPicked && 'is-picked')}
          disabled=${answered || (answer && answer.sending)} aria-pressed=${answer && answer.pick === o.id ? 'true' : 'false'}
          aria-label=${`${o.id}: ${o.label}, ${o.sub}${isAnswer ? ', correct answer' : ''}${isWrongPick ? ', your pick, wrong' : ''}`}
          onClick=${() => onPick(o.id)}>
          <span class="rv-letter" aria-hidden="true">${o.id}</span>
          <span class="rv-option-main"><span class="rv-option-label">${o.label}</span><span class="rv-option-sub">${o.sub}</span></span>
          ${mark}
        </button>`;
      })}
    </div>
    ${answered ? html`<div class="card rv-verdict" ref=${verdictRef} role="status">
      ${result ? html`<span class=${cx('card-title', result.correct ? 't-accent' : 't-error')}>${result.correct
        ? `✓ Got it · back in ${daysFor(result.step)} days`
        : `✕ Still tricky · back in ${daysFor(result.step)} days`}</span>` : html`<span class="card-title t-muted">${ERR_COPY[stale] || ERR_COPY.not_due}</span>`}
      ${item.fact ? html`<p class="lib-fact">${item.fact}</p>` : html`<p class="lib-fact">${item.name}</p>`}
    </div>
    <button type="button" class="btn btn-primary btn-block" ref=${nextRef} onClick=${onNext}>${last ? 'Finish review' : 'Next cell'}</button>` : null}
  </div>`;
}

/** The type's mesh: one MeshViewer for the whole review, loading each step's GLB (public gate). */
function ReviewViewer({ mesh }) {
  const boxRef = useRef(null);
  const viewerRef = useRef(null);
  const [state, setState] = useState('loading');
  const [pxPerUm, setPxPerUm] = useState(0);

  useEffect(() => {
    const v = new MeshViewer(boxRef.current, { autoRotate: true, interactive: true });
    viewerRef.current = v;
    const off = v.onChange((e) => { if (e && e.pxPerUm > 0) setPxPerUm(e.pxPerUm); });
    return () => {
      if (typeof off === 'function') off();
      try { v.dispose(); } catch (_) { /* ignore */ }
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setState('loading');
    api.assetArrayBuffer(mesh.asset)
      .then(async (buf) => {
        const v = viewerRef.current;
        if (!alive || !v) return;
        if (typeof v.resetView === 'function') v.resetView();
        await v.loadNeuron(buf.slice(0), { bboxUm: mesh.bbox_um });
        if (alive) setState('ready');
      })
      .catch((err) => { console.warn('[review] mesh', err); if (alive) setState('error'); });
    return () => { alive = false; };
  }, [mesh.asset]);

  return html`<div class="rv-viewer" role="group" aria-label="This cell's 3D mesh. Drag to rotate.">
    <div class="viewer-canvas" ref=${boxRef}></div>
    ${state === 'loading' ? html`<span class="rv-viewer-note" role="status">Loading the mesh…</span>` : null}
    ${state === 'error' ? html`<span class="rv-viewer-note is-error" role="alert">✕ The mesh didn't load</span>` : null}
    <div class="rv-scale">${state === 'ready' ? html`<${ScaleBar} pxPerUm=${pxPerUm} maxPx=${90} />` : null}</div>
  </div>`;
}

function Complete({ results, onFinish }) {
  const named = results.filter((r) => r.correct).length;
  const m = results.length;
  const shown = useCountUp(named, { from: 0, duration: 700 });
  const numRef = useRef(null);
  const btnRef = useRef(null);
  useEffect(() => {
    if (btnRef.current) btnRef.current.focus({ preventScroll: true });
    if (!m || named !== m) return undefined;
    const t = setTimeout(() => burst(numRef.current, { count: 16 }), 650); // a clean sweep: burst as the count lands
    return () => clearTimeout(t);
  }, []);
  return html`<div class="rv-done" role="status">
    <span class="overline">Review complete</span>
    ${m ? html`<span class="t-title"><span class="t-num rv-done-num" ref=${numRef}>${shown}</span> of <span class="t-num">${m}</span> named</span>`
      : html`<span class="t-title">Already reviewed</span>`}
    <span class="t-body t-soft">${scheduleCopy(results)}</span>
    <button type="button" class="btn btn-primary btn-block rv-done-btn" ref=${btnRef} onClick=${onFinish}>Back to library</button>
  </div>`;
}

function StateCard({ phase, online, error, onRetry, onBack }) {
  if (phase === 'empty') {
    return html`<div class="rv-state">
      <span class="overline">Review</span>
      <span class="t-title">Nothing due right now</span>
      <span class="t-body t-soft">Cells come back for review ${INTERVALS[0]}, ${INTERVALS[1]} or ${INTERVALS[2]} days after you meet them. Play today's neurons to add more.</span>
      <${Button} block onClick=${onBack}>Back to library</${Button}>
    </div>`;
  }
  const offline = phase === 'offline' || !online;
  return html`<div class="rv-state" role="alert">
    <span class=${cx('overline', offline ? 'is-warn' : 'is-error')}>${offline ? '! Offline' : '✕ Couldn’t load'}</span>
    <span class="t-title">${offline ? 'Review needs a connection' : 'Your review didn’t load'}</span>
    <span class="t-body t-soft">${offline ? 'Answers are checked and scheduled on the server. Reconnect and try again.' : (error && error.message) || 'Something went wrong.'}</span>
    <${Button} block haptic="selection" onClick=${onRetry}>Retry</${Button}>
    <${Button} variant="outline" block onClick=${onBack}>Back to library</${Button}>
  </div>`;
}
