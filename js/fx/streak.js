// <StreakCounter>: the streak numeral rolls n−1 → n, with an accent ring showing progress to the next
// milestone (ARCHITECTURE.md §3.1 "Streak +1"). Reduced motion / celebrations off: the new value at once.
//   html`<${StreakCounter} streak=${12} from=${11} />`   // from = the value before today's 5th round
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../ui/html.js';
import { milestoneProgress, nextMilestone, motionAllowed } from './celebrate.js';

const R = 18;
const C = 2 * Math.PI * R;

export function StreakCounter({ streak = 0, from, caption }) {
  const start = from !== undefined ? from : streak;
  const [n, setN] = useState(start);
  const [prevN, setPrevN] = useState(null);
  const [prog, setProg] = useState(milestoneProgress(start));
  const oldRef = useRef(null);
  const newRef = useRef(null);

  useEffect(() => {
    if (streak === n) { setProg(milestoneProgress(streak)); return undefined; }
    setPrevN(n);
    setN(streak);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setProg(milestoneProgress(streak))));
    return () => cancelAnimationFrame(id);
  }, [streak]);

  useEffect(() => {
    if (prevN === null) return undefined;
    if (!motionAllowed() || !newRef.current || !newRef.current.animate) { setPrevN(null); return undefined; }
    const opts = { duration: 420, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'both' };
    if (oldRef.current) oldRef.current.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-110%)', opacity: 0 }], opts);
    const a = newRef.current.animate([{ transform: 'translateY(110%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], opts);
    let alive = true;
    a.finished.then(() => { if (alive) setPrevN(null); }, () => {});
    return () => { alive = false; };
  }, [prevN]);

  const next = nextMilestone(n);
  const sub = caption !== undefined ? caption
    : next === null ? 'every milestone reached' : `${next - n} to the ${next}-day milestone`;
  return html`<div class="streak" role="group" aria-label=${`${n}-day streak`}>
    <div class="streak-ring" aria-hidden="true">
      <svg viewBox="0 0 40 40"><circle class="track" cx="20" cy="20" r=${R}></circle>
        <circle class="fill" cx="20" cy="20" r=${R} stroke-dasharray=${C.toFixed(2)} stroke-dashoffset=${(C * (1 - prog)).toFixed(2)}></circle></svg>
      <div class="streak-num">
        ${prevN !== null ? html`<span key=${`o${prevN}`} ref=${oldRef}>${prevN}</span>` : null}
        <span key=${`n${n}`} ref=${newRef}>${n}</span>
      </div>
    </div>
    <div class="streak-copy"><span class="t-card">${n}-day streak</span><span class="t-micro t-muted">${sub}</span></div>
  </div>`;
}

export default StreakCounter;
