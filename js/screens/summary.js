// Day summary after round 5 (ARCHITECTURE.md §3 "Day summary", §3.1 "Day complete", "Streak +1 / milestone",
// "Overtake on a leaderboard", §3.3 item 3 "Day progress bar").
//
//   overline "NEUROGUESSER #33 · TODAY", mono score "4,200 / 6,000" (+ "↑ Personal best" chip),
//   the day progress bar (5 segments; no running total here, the score above is the total),
//   one row per round (index, type name, compact strip, points) linking to its reveal,
//   the streak (numeral + accent ring to the next milestone),
//   XP and level (§3.4 item 2, js/ui/xp-bar.js): level badge, "+N XP today", the bar to the next level,
//   "Share result" (accent) → share sheet, "Next neurons in HH:MM:SS".
//
// Delight, only the first time the summary appears right after the 5th reveal (reveal.js calls
// markDayComplete(date) when "Today's results" leads here): the total counts up 0 → total, the rows stagger
// in (60 ms each), the streak rolls n−1 → n (haptic 'celebrate'), "Personal best" stamps in when the day beats the best_day_total
// GET /v1/me reported before the day was finished (haptic 'success' on the tap, reveal.js); at a STREAK_MILESTONES value the
// milestone sheet opens. Overtakes are checked on every visit (throttled) and announced as a toast.
// XP: GET /v1/me is reloaded (me.xp_total must include the day's last round); then, once the milestone sheet (if any)
// is closed, the day's points count up into the XP bar, and crossing a level plays the level-up moment (haptic
// 'celebrate'). A later visit shows "↑ Level up" without motion when the day crossed a level.
// Reduced motion / Celebrations off: same words, no motion (fx/* handle it).
//
// Personal best baseline: me.best_day_total includes today's partial total once a round is done, so the
// lowest value seen for the date (in memory and IndexedDB 'summary:pbBase:<date>') is the best of the other
// days. No best_day_total (older Worker) or no earlier scoring day → no chip. The decision is kept in
// 'summary:pb:<date>' so later visits still show the chip, without animation.
//
// Exports: default Summary, SummaryView (pure; the dev page renders it), markDayComplete(date).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { useStore, store } from '../store.js';
import * as idb from '../idb.js';
import { Button, Countdown, OfflineChip } from '../ui/components.js';
import { loadReveal, loadMe, isDone } from '../game.js';
import { fmtPts } from '../format.js';
import { navigate } from '../router.js';
import { haptic } from '../fx/haptics.js';
import { useCountUp, stamp, isMilestone, motionAllowed } from '../fx/celebrate.js';
import { StreakCounter } from '../fx/streak.js';
import { openMilestone } from '../fx/milestone.js';
import { checkOvertakes, announceOvertakes } from '../fx/overtake.js';
import { openShare, StripView } from './share.js';
import { DayProgress } from '../ui/day-progress.js';
import { XpCard } from '../ui/xp-bar.js';

loadCss('css/reveal.css');

const MAX_DAY = 6000;
const PB_BASE_KEY = (date) => `summary:pbBase:${date}`;
const PB_KEY = (date) => `summary:pb:${date}`;
const OVERTAKE_THROTTLE_MS = 60000;

// ---- "day just completed" flag (set by reveal.js, consumed by the first Summary mount) ----
const freshDays = new Set();
/** Mark that the player just finished the day's last reveal: the next summary of `date` celebrates. */
export function markDayComplete(date) { if (date) freshDays.add(date); }
function consumeFresh(date) {
  if (!date || !freshDays.has(date)) return false;
  freshDays.delete(date);
  return true;
}

// ---- personal-best baseline: lowest me.best_day_total seen while `date` is the active day ----
const pbBase = new Map();   // date → number
const pbDecided = new Map(); // date → boolean
function observeBest(s) {
  try {
    const me = s.session && s.session.me;
    const t = s.today;
    if (!me || typeof me.best_day_total !== 'number' || !t || !t.date || t.graceActive) return;
    const prev = pbBase.get(t.date);
    if (prev === undefined || me.best_day_total < prev) {
      pbBase.set(t.date, me.best_day_total);
      idb.set(PB_BASE_KEY(t.date), me.best_day_total);
    }
  } catch (_) { /* never break the store */ }
}
store.subscribe(observeBest);
observeBest(store.get());

/** Lowest best_day_total recorded for date (memory or IndexedDB), or null. */
async function baselineFor(date) {
  const mem = pbBase.get(date);
  const stored = await idb.get(PB_BASE_KEY(date));
  const vals = [mem, stored].filter((v) => typeof v === 'number');
  return vals.length ? Math.min(...vals) : null;
}

/** Pure: today's total beats the best of the other days (a first-ever scoring day is not a "best"). */
export function isPersonalBest(total, baseline) {
  return typeof baseline === 'number' && baseline > 0 && total > baseline;
}

/** "2 named · 2 met · 1 missed" */
export function outcomeCounts(progress) {
  const c = { named: 0, met: 0, missed: 0 };
  for (const st of progress || []) if (st && st.stage === 'done' && c[st.outcome] !== undefined) c[st.outcome]++;
  return ['named', 'met', 'missed'].filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`).join(' · ');
}

let lastOvertakeCheck = { date: null, at: 0 };

/**
 * <SummaryView dayNumber date total progress rounds names streak nextRolloverAt personalBest fresh xp xpReady xpPaused
 *   onShare onOpenRound>
 * names: round_id → { name, sub } (from the cached reveals); fresh: play the day-complete moment; xp: me.xp_total
 * (null: no XP card); xpReady: /v1/me is current; xpPaused: a sheet covers the summary (the XP count-up waits).
 */
export function SummaryView({ dayNumber, date = null, total, progress, rounds, names = {}, streak = 0, nextRolloverAt, personalBest = false, fresh = false, xp = null, xpReady = true, xpPaused = false, onShare, onOpenRound }) {
  // reduced motion / Celebrations off: the total is shown at once (never a frame of 0)
  const shown = useCountUp(total, { from: fresh && motionAllowed() ? 0 : undefined, duration: 900 });
  const chipRef = useRef(null);
  const [chipVisible, setChipVisible] = useState(!fresh);

  // (the day-complete haptic fires in reveal.js, synchronously inside the "Today's results" tap: iOS only
  // allows haptics within a user gesture)
  useEffect(() => {
    if (!fresh) return undefined;
    const id = setTimeout(() => setChipVisible(true), 900);
    return () => clearTimeout(id);
  }, [fresh]);
  useEffect(() => { if (fresh && chipVisible && personalBest && chipRef.current) stamp(chipRef.current); }, [chipVisible, personalBest]);

  const counts = outcomeCounts(progress);
  return html`<div class="screen summary-screen"><div class="screen-pad summary">
    <div class="stack-4">
      <div class="row-between"><span class="overline">Day ${dayNumber} · Today</span><${OfflineChip} /></div>
      <div class="summary-score-row">
        <span class="summary-score" aria-label=${`${fmtPts(total)} of ${fmtPts(MAX_DAY)} points`}>
          <span>${fmtPts(shown)}</span><span class="t-muted"> / ${fmtPts(MAX_DAY)}</span>
        </span>
        ${personalBest && chipVisible ? html`<span class="chip-mono summary-pb" ref=${chipRef}>↑ Personal best</span>` : null}
      </div>
      ${counts ? html`<span class="t-label t-muted">${counts}</span>` : null}
    </div>
    ${(rounds || []).length ? html`<${DayProgress} today=${{ date, rounds, progress }} showTotal=${false} class="in-summary" />` : null}

    <div class=${cx('summary-rows', fresh && 'fx-stagger')}>
      ${(rounds || []).map((r, i) => {
        const n = r.round_index || i + 1;
        const st = (progress || [])[n - 1];
        const info = names[r.round_id];
        const done = isDone(st);
        return html`<button key=${r.round_id} type="button" class="summary-row" disabled=${!done}
          aria-label=${`Round ${n}: ${info ? info.name : 'cell'}, ${fmtPts(st ? st.score : 0)} points. Open the reveal`}
          onClick=${() => { haptic('selection'); if (onOpenRound) onOpenRound(n); }}>
          <span class="summary-n">${n}</span>
          <span class="summary-name">
            <span class=${cx('t-card', !info && 't-muted')}>${info ? info.name : `Round ${n}`}</span>
            ${info && info.sub ? html`<span class="t-micro t-muted">${info.sub}</span>` : null}
          </span>
          <${StripView} state=${st} size="sm" />
          <span class="summary-pts">${done ? fmtPts(st.score) : '—'}</span>
          <span class="summary-chev" aria-hidden="true">›</span>
        </button>`;
      })}
    </div>

    <div class="card summary-streak">
      <${StreakCounter} streak=${streak} from=${fresh && streak > 0 ? streak - 1 : undefined} />
    </div>
    ${typeof xp === 'number' && Number.isFinite(xp) ? html`<div class="card summary-xp">
      <${XpCard} xp=${xp} dayTotal=${total} fresh=${fresh} ready=${xpReady} paused=${xpPaused} />
    </div>` : null}

    <${Button} block haptic="selection" onClick=${onShare}>Share result</${Button}>
    <div class="summary-next">
      <span class="t-label t-muted">Next neurons in</span>
      ${nextRolloverAt ? html`<${Countdown} to=${nextRolloverAt} class="countdown" />` : html`<span class="countdown">—</span>`}
    </div>
  </div></div>`;
}

export default function Summary() {
  const t = useStore((s) => s.today);
  const reveals = useStore((s) => s.reveals);
  const [fresh] = useState(() => consumeFresh(t.date));
  const [pb, setPb] = useState(() => !!pbDecided.get(t.date));
  const milestoneDone = useRef(false);
  const xp = useStore((s) => (s.session.me && typeof s.session.me.xp_total === 'number' ? s.session.me.xp_total : null));
  const sheetOpen = useStore((s) => !!s.ui.sheet);
  const [xpReady, setXpReady] = useState(!fresh);

  // XP (fresh): me.xp_total must include the day's last round before its points count into the bar — reload /v1/me
  // (normally already current: a finished round reloads it); go ahead anyway after 2.5 s or offline
  useEffect(() => {
    if (!fresh) return undefined;
    let alive = true;
    const ok = () => { if (alive) setXpReady(true); };
    loadMe().then(ok, ok);
    const id = setTimeout(ok, 2500);
    return () => { alive = false; clearTimeout(id); };
  }, []);

  // names for the rows (reveals are cached in IndexedDB, so this is free after the first time)
  useEffect(() => { (t.rounds || []).forEach((r, i) => loadReveal(r.round_index || i + 1)); }, [t.date]);

  // personal best
  useEffect(() => {
    let alive = true;
    const date = t.date;
    (async () => {
      if (fresh) {
        const base = await baselineFor(date);
        const best = isPersonalBest(t.total, base);
        pbDecided.set(date, best);
        idb.set(PB_KEY(date), best);
        if (alive) setPb(best);
      } else if (!pbDecided.has(date)) {
        const best = !!(await idb.get(PB_KEY(date)));
        pbDecided.set(date, best);
        if (alive) setPb(best);
      }
    })();
    return () => { alive = false; };
  }, [t.date]);

  // streak +1 (§3.1, haptic 'celebrate'): the numeral rolls n−1 → n on the fresh summary, after the day-complete
  // 'success' of the tap; a milestone's sheet fires its own 'celebrate' instead
  useEffect(() => {
    if (!fresh || !(t.streak > 0) || isMilestone(t.streak)) return undefined;
    const id = setTimeout(() => haptic('celebrate'), 450);
    return () => clearTimeout(id);
  }, []);

  // streak milestone sheet (once, right after the day completes)
  useEffect(() => {
    if (!fresh || milestoneDone.current || !isMilestone(t.streak)) return undefined;
    milestoneDone.current = true;
    const streak = t.streak;
    const id = setTimeout(() => { if (!store.get().ui.sheet) openMilestone({ streak }); }, 1100);
    return () => clearTimeout(id);
  }, [t.streak]);

  // overtakes (toast), at most once a minute per date. Not cancelled on unmount: checkOvertakes() stores the new
  // ranks snapshot, so a check dropped because the player left the summary early would lose the overtake for good.
  useEffect(() => {
    const date = t.date;
    const now = Date.now();
    if (!date || (lastOvertakeCheck.date === date && now - lastOvertakeCheck.at < OVERTAKE_THROTTLE_MS)) return;
    lastOvertakeCheck = { date, at: now };
    setTimeout(() => { checkOvertakes({ date }).then(announceOvertakes).catch(() => {}); }, fresh ? 1500 : 400);
  }, [t.date]);

  const names = {};
  for (const r of t.rounds || []) {
    const rv = reveals[r.round_id];
    if (rv) names[r.round_id] = { name: rv.type.name, sub: [rv.type.species_common, rv.type.region].filter(Boolean).join(' · ') };
  }

  return html`<${SummaryView} dayNumber=${t.dayNumber} date=${t.date} total=${t.total} progress=${t.progress} rounds=${t.rounds}
    names=${names} streak=${t.streak || 0} nextRolloverAt=${t.nextRolloverAt} personalBest=${pb} fresh=${fresh}
    xp=${xp} xpReady=${xpReady} xpPaused=${sheetOpen}
    onShare=${() => openShare({})} onOpenRound=${(n) => navigate(`/today/reveal/${n}`)} />`;
}
