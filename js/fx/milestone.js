// Streak milestone sheet ("12-day streak" with radiating accent rays; ARCHITECTURE.md §3.1).
//   openMilestone({ streak })  — call it when progress.streak reaches a STREAK_MILESTONES value.
import { useEffect, useRef } from 'preact/hooks';
import { html } from '../ui/html.js';
import { Sheet } from '../ui/sheet.js';
import { Button } from '../ui/components.js';
import { openSheet } from '../store.js';
import { rays, pulse, nextMilestone } from './celebrate.js';
import { haptic } from './haptics.js';

export function openMilestone({ streak }) {
  haptic('celebrate');
  openSheet('milestone', { streak });
}

export function MilestoneSheet({ streak = 0, onClose }) {
  const burstRef = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => { rays(burstRef.current); pulse(burstRef.current, { rings: 1, radius: '50%' }); }, 240); // after the 220 ms slide-up: pulse() measures the element once
    return () => clearTimeout(t);
  }, []);
  const next = nextMilestone(streak);
  const copy = next === null
    ? 'A full year of daily neurons. Every milestone reached.'
    : `${streak} days in a row with all five rounds finished. Next milestone: ${next} days.`;
  return html`<${Sheet} label=${`${streak}-day streak`} onClose=${onClose}>
    <div class="milestone">
      <div class="milestone-burst" ref=${burstRef}><span class="milestone-num">${streak}</span></div>
      <span class="overline is-accent">Streak milestone</span>
      <span class="sheet-title">${streak}-day streak</span>
      <span class="t-body t-soft">${copy}</span>
    </div>
    <${Button} block onClick=${onClose}>Keep going</${Button}>
  </${Sheet}>`;
}

export default MilestoneSheet;
