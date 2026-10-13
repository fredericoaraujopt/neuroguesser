// Day progress bar (ARCHITECTURE.md §3.3 item 3): one segment per round of the active day + the running total.
//
//   [✓][✓][✕][ 4 ][ 5 ]                 1,800 pts
//
// Segment states, always colour + glyph: named (accent fill, ✓), met (accent at 55 %, ✓), missed (state-error, ✕),
// current (accent outline + its number), upcoming (slate-700 + its number); during grace, a round of yesterday that
// can no longer be played is "closed" (slate-700 outline, –). The active day is store.today (yesterday's rounds while
// grace is active), so the bar is right after a reload, a resume and during grace.
//
// When a round finishes, its segment fills (≤ 600 ms; reduced motion / Celebrations off: instant, css/app.css) and the
// total counts up. The fill plays once per round per session, on the first bar that shows the round as done within
// FILL_WINDOW_MS of it finishing: the reveal on phones (the round screen keeps showing its own round as "current",
// `playing`, through the short hold after the method pick), the persistent desktop header bar at once; bars mounted
// later (next round, summary) show it filled. A reload never animates (there is nothing to compare with). The round
// screen already fires the success/error haptic.
//
// Exports: daySegments, progressLabel, trackFills (pure / module memory, unit-tested), DayProgress (pure component),
// TodayProgress (store-connected; round screen, and the desktop header with variant="header").
import { useEffect, useRef } from 'preact/hooks';
import { html, cx, loadCss } from './html.js';
import { useStore } from '../store.js';
import { isDone, outcomeOf } from '../game.js';
import { fmtPts } from '../format.js';
import { useCountUp, motionAllowed } from '../fx/celebrate.js';

loadCss('css/day-progress.css');

const DONE = new Set(['named', 'met', 'missed']);
let barSeq = 0;
export const FILL_WINDOW_MS = 3500; // > the round screen's hold after the method pick (3 s cap)

const GLYPHS = { named: '✓', met: '✓', missed: '✕', closed: '–' };
const WORDS = { named: 'named', met: 'met', missed: 'missed', current: 'playing now', upcoming: 'to play', closed: 'closed, not played' };

/**
 * Segments of the active day (pure): [{ index, state, score }], one per round.
 * state: 'named' | 'met' | 'missed' (done, by outcome) | 'current' | 'upcoming' | 'closed'.
 *   current  = `playing` when given (the round screen's own round, even during the hold after it finished), else the
 *              first playable round that is not done;
 *   closed   = while grace is active, a round of yesterday that is not done and not in grace.round_indexes.
 * score is the round score of a done round (0 otherwise).
 */
export function daySegments(today, { playing = null } = {}) {
  const rounds = (today && today.rounds) || [];
  const progress = (today && today.progress) || [];
  const grace = !!(today && today.graceActive && today.grace && Array.isArray(today.grace.round_indexes));
  const playable = grace ? new Set(today.grace.round_indexes) : null;
  const segs = rounds.map((r, i) => {
    const index = (r && r.round_index) || i + 1;
    const st = progress[index - 1] || null;
    if (isDone(st)) return { index, state: outcomeOf(st) || 'met', score: st.score || 0 };
    return { index, state: playable && !playable.has(index) ? 'closed' : 'upcoming', score: 0 };
  });
  const pinned = Number.isInteger(playing) ? segs.find((s) => s.index === playing) : null;
  if (pinned) {
    pinned.state = 'current';
    pinned.score = 0;
  } else {
    const first = segs.find((s) => s.state === 'upcoming');
    if (first) first.state = 'current';
  }
  return segs;
}

/** Σ scores of the done segments (the running total the bar shows). */
export const segmentsTotal = (segs) => (segs || []).reduce((sum, s) => sum + (DONE.has(s.state) ? s.score : 0), 0);

/**
 * Screen-reader text: "Today: round 1 named, round 2 met, round 3 playing now, round 4 to play, round 5 to play ·
 * 1,800 points" ("Yesterday: …" while grace keeps yesterday's rounds on screen).
 */
export function progressLabel(segs, total = null, { grace = false } = {}) {
  const parts = (segs || []).map((s) => `round ${s.index} ${WORDS[s.state] || s.state}`);
  return `${grace ? 'Yesterday' : 'Today'}: ${parts.join(', ')}${total == null ? '' : ` · ${fmtPts(total)} points`}`;
}

// On desktop (≥ 1024 px) the header bar is the visible one and the inline copies are hidden (css/day-progress.css),
// so only the header bar may claim a fill there; elsewhere only inline bars may (a header hidden on phones never does).
let headerBars = 0;
const wide = () => { try { return typeof matchMedia === 'function' && matchMedia('(min-width: 1024px)').matches; } catch (_) { return false; } };
function mayClaim(variant) {
  const inHeader = headerBars > 0 && wide();
  return variant === 'header' ? inHeader : !inHeader;
}

// ---- fills: which segments became done since a bar last showed them (module memory, this session only) ----
const seen = new Map(); // dayKey → { states: [], fillAt: [], claim: [] }

/**
 * Record the data states of a day's segments and return, per segment, whether this bar plays the fill now: the round
 * became done (from a state a bar showed earlier) less than FILL_WINDOW_MS ago, and no other bar has played it. The
 * first bar that SHOWS the done state claims the fill (shown[i] false: the round screen still pins its round as
 * "current" during the hold); a bar mounted later (the next round, the summary) shows it filled at once. The first
 * sight of a day never animates (reload / resume).
 *   claimer: a per-bar token (each DayProgress instance has its own); shown: per segment, whether this bar shows it.
 */
export function trackFills(key, states, now = Date.now(), claimer = null, shown = null) {
  const rec = seen.get(key);
  if (!rec) {
    seen.set(key, { states: [...states], fillAt: states.map(() => 0), claim: states.map(() => null) });
    return states.map(() => false);
  }
  return states.map((s, i) => {
    const was = rec.states[i];
    rec.states[i] = s;
    if (!DONE.has(s)) { rec.claim[i] = null; return false; }
    if (was !== undefined && !DONE.has(was)) { rec.fillAt[i] = now; rec.claim[i] = null; }
    if (!(now - (rec.fillAt[i] || 0) < FILL_WINDOW_MS)) return false;
    if (rec.claim[i] == null && (!shown || shown[i])) rec.claim[i] = claimer || 'anon';
    return rec.claim[i] === (claimer || 'anon');
  });
}
/** Tests only. */
export function _resetFills() { seen.clear(); }

/**
 * <DayProgress today playing showTotal variant> (pure). today: { date, rounds, progress, graceActive?, grace? } (the
 * store's today slice, or a hand-written one on the dev pages). The fill memory tracks the data states; `playing` only
 * changes what is shown. showTotal false hides the running total (the summary shows its own large total).
 * variant: 'inline' (round / reveal / summary) | 'header' (desktop top header).
 */
export function DayProgress({ today, playing = null, round = null, showTotal = true, variant = 'inline', class: klass }) {
  const token = useRef(null);
  if (!token.current) token.current = { bar: (barSeq += 1) };
  const data = daySegments(today);
  const segs = daySegments(today, { playing });
  const key = `${(today && today.date) || 'day'}:${data.length}`;
  const claim = mayClaim(variant);
  const filling = trackFills(key, data.map((s) => s.state), Date.now(), token.current, segs.map((s) => claim && DONE.has(s.state)));
  useEffect(() => {
    if (variant !== 'header') return undefined;
    headerBars += 1;
    return () => { headerBars -= 1; };
  }, [variant]);
  const total = segmentsTotal(segs);
  const fillScore = segs.reduce((sum, s, i) => sum + (filling[i] && DONE.has(s.state) ? s.score : 0), 0);
  // a segment that is filling counts its points up too (a reload, reduced motion or Celebrations off: the total at once,
  // never a frame of the old total)
  const shown = useCountUp(total, { from: fillScore > 0 && motionAllowed() ? total - fillScore : undefined, duration: 600 });
  if (!segs.length) return null;
  // App Design Guide (12 Oct 2026) round strip: "Round 2 of 5" over the segments, the day's score once, in ink
  const r = variant === 'inline' ? (Number.isInteger(round) ? round : Number.isInteger(playing) ? playing : null) : null;
  const totalEl = showTotal ? html`<span class="dp-total" aria-hidden="true">${fmtPts(shown)} <small>pts</small></span>` : null;
  return html`<div class=${cx('day-progress', `is-${variant}`, r && 'has-head', klass)} role="img"
    aria-label=${progressLabel(segs, showTotal ? total : null, { grace: !!(today && today.graceActive) })}>
    ${r ? html`<div class="dp-head" aria-hidden="true"><span class="dp-round">Round ${r} of ${segs.length}</span>${totalEl}</div>` : null}
    <div class="dp-segs" aria-hidden="true">
      ${segs.map((s, i) => html`<span key=${s.index} class=${cx('dp-seg', `is-${s.state}`, filling[i] && DONE.has(s.state) && 'is-filling')}
        title=${`Round ${s.index} · ${WORDS[s.state]}${DONE.has(s.state) ? ` · ${fmtPts(s.score)} pts` : ''}`}>
        <i class="dp-fill"></i><span class="dp-glyph">${GLYPHS[s.state] || s.index}</span>
      </span>`)}
    </div>
    ${r ? null : totalEl}
  </div>`;
}

/** Store-connected bar for the active day (store.today). playing: the round screen's own round index. */
export function TodayProgress({ playing = null, showTotal = true, variant = 'inline', class: klass }) {
  const today = useStore((s) => s.today);
  if (!today || !Array.isArray(today.rounds) || !today.rounds.length) return null;
  return html`<${DayProgress} today=${today} playing=${playing} showTotal=${showTotal} variant=${variant} class=${klass} />`;
}
