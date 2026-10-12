// XP and levels in the UI (ARCHITECTURE.md §3.4 item 2; the curve is js/levels.js; me.xp_total from GET /v1/me).
//
//   XpCard (summary)   [ 4 ]  Level 4                            +4,200 XP today
//                             ===============------------------  2,220 XP to level 5
//   XpCard (profile)   Level 4 · 8,230 XP, the bar, "2,220 XP to level 5" (no badge, no motion)
//   LevelChip (desktop header, inside the Profile link)   [LV 4 ==-]
//
// Summary, the first time it appears after the day's last reveal (fresh): once /v1/me is current (`ready`) and no
// sheet covers the summary (`paused`, e.g. the streak milestone), after the total's own count-up (`delay`), the day's
// points count up into the bar (≤ 900 ms): the "+N XP" figure, the bar and the level numeral follow the running value,
// and the bar starts again from empty at each level it passes. Crossing a level ends with the level-up moment: an
// accent burst and ring pulse around the level badge, "↑ Level up" stamping in, haptic('celebrate') (fired even
// without motion; haptics have their own setting). Reduced motion / Celebrations off: the end state from the first
// frame, same words (no "+0 XP" beat before it), and the level-up haptic at the moment the run would have ended. A
// later visit shows the end state, with "↑ Level up" when today's points crossed a level.
//
// Exports: XpCard, LevelChip, levelChipLabel, xpDay (pure, unit-tested in tests/progress-bars.test.js).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from './html.js';
import { levelInfo, levelOf, levelsCrossed } from '../levels.js';
import { fmtPts } from '../format.js';
import { haptic } from '../fx/haptics.js';
import { countUp, burst, pulse, stamp, motionAllowed } from '../fx/celebrate.js';

loadCss('css/progress-bars.css');

const RUN_MS = 900; // the count-up into the bar (Charcoal: each animation ≤ 900 ms)
const cleanXp = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/**
 * The day in XP (pure): { start, end, gained, crossed } — the XP before today's points (xp − dayTotal, never below 0),
 * the XP now, what today added, and the levels reached on the way ([] when none).
 */
export function xpDay(xp, dayTotal = 0) {
  const end = cleanXp(xp);
  const gained = Math.min(end, cleanXp(dayTotal));
  const start = end - gained;
  return { start, end, gained, crossed: levelsCrossed(start, end) };
}

/** "Level 4, 2,220 XP to level 5" (header chip and profile, for screen readers). */
export function levelChipLabel(xp) {
  const li = levelInfo(xp);
  return li.next == null ? `Level ${li.level}` : `Level ${li.level}, ${fmtPts(li.toNext)} XP to level ${li.level + 1}`;
}

/** The level and a mini bar to the next one (desktop header, inside the Profile link; the link carries the label). */
export function LevelChip({ xp, class: klass }) {
  const li = levelInfo(xp);
  return html`<span class=${cx('lvl-chip', klass)} aria-hidden="true">
    <span class="lvl-chip-n">Lv ${li.level}</span>
    <span class="lvl-chip-meter"><i style=${{ transform: `scaleX(${li.frac.toFixed(3)})` }}></i></span>
  </span>`;
}

/**
 * <XpCard xp dayTotal fresh ready paused delay variant class>
 *   xp: me.xp_total (after today's rounds); dayTotal: today's points (summary); fresh: play the count-up and the
 *   level-up moment; ready: /v1/me is current (the run waits for it); paused: a sheet covers the summary (the run
 *   waits); variant: 'summary' (badge, "+N XP today") | 'profile' (total XP, no motion).
 */
export function XpCard({ xp, dayTotal = 0, fresh = false, ready = true, paused = false, delay = 1100, variant = 'summary', class: klass }) {
  const day = xpDay(xp, variant === 'summary' ? dayTotal : 0);
  const [still] = useState(() => !motionAllowed()); // reduced motion / Celebrations off: no run, the end state at once
  const willRun = fresh && variant === 'summary' && day.gained > 0 && !still;
  const [phase, setPhase] = useState(willRun ? 'wait' : 'done'); // wait → run → done
  const [value, setValue] = useState(willRun ? day.start : day.end);
  const [levelled, setLevelled] = useState(false); // the run just crossed a level: play the moment once
  const latest = useRef(day);
  latest.current = day;
  const alive = useRef(true);
  const runRef = useRef(null);
  const badgeRef = useRef(null);
  const upRef = useRef(null);

  // not animating: follow the data (a later /v1/me answer); waiting: the start moves while /v1/me catches up
  useEffect(() => { if (phase === 'done') setValue(day.end); }, [day.end, phase]);
  useEffect(() => { if (phase === 'wait') setValue(day.start); }, [day.start, phase]);
  useEffect(() => () => { alive.current = false; if (runRef.current) runRef.current.cancel(); }, []);

  // the run starts once /v1/me is current, nothing covers the summary and the total has counted up; only unmounting
  // stops it (a sheet opening mid-run lets it finish)
  useEffect(() => {
    if (phase !== 'wait' || !ready || paused) return undefined;
    const id = setTimeout(() => {
      const { start, end, crossed } = latest.current;
      setPhase('run');
      const run = countUp(start, end, (v) => { if (alive.current) setValue(v); }, { duration: RUN_MS });
      runRef.current = run;
      run.then(() => {
        if (!alive.current) return;
        setPhase('done');
        if (crossed.length) setLevelled(true);
      });
    }, delay);
    return () => clearTimeout(id);
  }, [phase, ready, paused]);

  // level-up moment (after the render that shows "↑ Level up"): haptic even without motion, fx only with it
  useEffect(() => {
    if (!levelled) return;
    haptic('celebrate');
    burst(badgeRef.current, { count: 20, big: true });
    pulse(badgeRef.current, { rings: 2 });
    stamp(upRef.current);
  }, [levelled]);

  // reduced motion: the card shows the end state ("↑ Level up" included) from the start; the level-up haptic keeps the
  // moment it has with motion (after the total and the count-up), once /v1/me is current and nothing covers the summary
  const buzzed = useRef(false);
  useEffect(() => {
    if (!still || !fresh || variant !== 'summary' || buzzed.current || !ready || paused) return undefined;
    const id = setTimeout(() => {
      buzzed.current = true;
      if (alive.current && latest.current.crossed.length) haptic('celebrate');
    }, delay + RUN_MS);
    return () => clearTimeout(id);
  }, [ready, paused]);

  const li = levelInfo(value);
  const showUp = variant === 'summary' && day.crossed.length > 0 && phase === 'done';
  const nextText = li.next == null ? 'Top level' : `${fmtPts(li.toNext)} XP to level ${li.level + 1}`;
  if (variant === 'profile') {
    return html`<div class=${cx('xp-card is-profile', klass)} role="group" aria-label=${`${levelChipLabel(day.end)}, ${fmtPts(day.end)} XP in total`}>
      <div class="xp-head" aria-hidden="true">
        <span class="t-card">Level ${li.level}</span>
        <span class="xp-total">${fmtPts(value)} XP</span>
      </div>
      <div class="xp-meter" aria-hidden="true"><i style=${{ transform: `scaleX(${li.frac.toFixed(4)})` }}></i></div>
      <span class="t-micro t-muted" aria-hidden="true">${nextText}</span>
    </div>`;
  }
  const levelNow = levelOf(day.end);
  const aria = `Level ${levelNow}${day.crossed.length ? ', level up today' : ''}. ${fmtPts(day.gained)} XP today, ${fmtPts(day.end)} XP in total. ${levelChipLabel(day.end)}.`;
  return html`<div class=${cx('xp-card', klass)} role="group" aria-label=${aria}>
    <span class="xp-badge" ref=${badgeRef} aria-hidden="true"><span>${li.level}</span></span>
    <div class="xp-copy" aria-hidden="true">
      <div class="xp-head">
        <span class="xp-title"><span class="t-card">Level ${li.level}</span>
          ${showUp ? html`<span class="chip-mono xp-up" ref=${upRef}>↑ Level up</span>` : null}</span>
        <span class="xp-gain">+${fmtPts(Math.max(0, value - day.start))} XP${day.gained > 0 ? html`<small> today</small>` : null}</span>
      </div>
      <span class="t-micro t-muted">${nextText}</span>
    </div>
    <div class=${cx('xp-meter', phase === 'run' && 'is-live')} aria-hidden="true"><i style=${{ transform: `scaleX(${li.frac.toFixed(4)})` }}></i></div>
  </div>`;
}

export default XpCard;
