// Today tab controller (foundation; ARCHITECTURE.md §3 "Today tab").
// Loads /v1/today + /v1/day/{date} + /progress (game.loadToday) and shows, via game.resolveTodayView:
//   the round screen (#/today/round/n) for the first round that is not done; the reveal (#/today/reveal/n)
//   of a done round not yet acknowledged; the day summary when all 5 are done and acknowledged.
// Own states: loading, empty ("No neurons today" + countdown), error (Retry), offline without a cache, and
// the grace banner ("Finish by 00:30 UTC") while yesterday's unfinished rounds are on screen.
import { useEffect, useRef } from 'preact/hooks';
import { html, cx } from '../ui/html.js';
import { useStore, store } from '../store.js';
import { useRoute, navigate } from '../router.js';
import { loadToday, resolveTodayView, leaveGrace, prefetchRound, isDone } from '../game.js';
import { Button, Countdown, Banner, OfflineChip } from '../ui/components.js';
import { haptic } from '../fx/haptics.js';
import Round from './round.js';
import Reveal from './reveal.js';
import Summary from './summary.js';

const hasRounds = (t) => t.rounds && t.rounds.length > 0;

export default function Today({ params = {} }) {
  const route = useRoute();
  const today = useStore((s) => s.today);

  useEffect(() => {
    if (store.get().today.status === 'idle') loadToday();
  }, []);

  const showDay = (today.status === 'ready' || today.status === 'offline') && hasRounds(today);
  const view = showDay ? resolveTodayView(today, route.name, params) : null;
  const viewPath = view ? view.path : null;
  const graceOver = !!(view && view.graceOver);
  // play (round.js) may hold a just-finished round on screen for ~1 s, 3 s at most (ui.holdRound = n) so its result fx
  // ("+200" into the points readout) finish before the hand-off to the reveal; it always clears the hold.
  const holdRound = useStore((s) => s.ui.holdRound || null);
  const held = !!(view && view.kind === 'reveal' && holdRound === view.index);

  // The active day changed (rollover, or leaving yesterday's grace rounds): drop the stale round URL.
  const lastDate = useRef(today.date);
  useEffect(() => {
    const prev = lastDate.current;
    lastDate.current = today.date;
    if (prev && today.date && prev !== today.date && route.path !== '/today') navigate('/today', { replace: true });
  }, [today.date]);

  useEffect(() => {
    if (!view) return;
    if (graceOver) { leaveGrace(); return; }
    if (held) return;
    if (route.name && route.name.startsWith('today') && viewPath !== route.path) navigate(viewPath, { replace: true });
  }, [viewPath, graceOver, route.path, held]);

  // On the reveal of round n, warm round n + 1's mesh (low priority, once the reveal's own context and siblings had
  // a head start), so "Next round →" opens on a drawn cell — also after a resume straight onto a reveal.
  const warmNext = view && view.kind === 'reveal' && !held && view.index < today.rounds.length
    && !isDone(today.progress[view.index]) ? view.index + 1 : null;
  useEffect(() => {
    if (!warmNext) return undefined;
    const timer = setTimeout(() => { prefetchRound(warmNext); }, 1500);
    return () => clearTimeout(timer);
  }, [warmNext, today.date]);

  if (!showDay) {
    if (today.status === 'empty') return html`<${EmptyState} today=${today} />`;
    if (today.status === 'error') return html`<${ErrorState} error=${today.error} />`;
    if (today.status === 'offline') return html`<${OfflineState} />`;
    return html`<${LoadingState} />`;
  }
  if (graceOver) return html`<${LoadingState} />`;

  const grace = today.graceActive && today.grace;
  let body = null;
  if (view.kind === 'round' || held) body = html`<${Round} params=${{ n: view.index }} />`;
  else if (view.kind === 'reveal') body = html`<${Reveal} params=${{ n: view.index }} />`;
  else if (view.kind === 'summary') body = html`<${Summary} params=${{}} />`;
  else body = html`<${LoadingState} />`;

  return html`<div class="today">
    ${grace ? html`<div class="today-banner"><${GraceBanner} today=${today} /></div>` : null}
    <div class=${cx('today-body', grace && 'has-banner')}>${body}</div>
  </div>`;
}

function GraceBanner({ today }) {
  const until = today.grace && today.grace.until ? new Date(today.grace.until).toISOString().slice(11, 16) : '00:30';
  const action = html`<button type="button" class="btn-text" onClick=${() => { haptic('selection'); leaveGrace(); }}>Today →</button>`;
  return html`<${Banner} tone="warn" action=${action}>
    <span class="t-num">#${today.dayNumber}</span> · Finish by ${until} UTC
  </${Banner}>`;
}

/** Skeleton in the shape of the round screen (viewer + question area), so nothing jumps on load. */
function LoadingState() {
  return html`<div class="screen today-loading" aria-busy="true">
    <div class="viewer">
      <div class="viewer-top" aria-hidden="true"><span class="viewer-label">NeuroGuesser</span><span class="viewer-points">— <small>pts</small></span></div>
      <span class="t-micro t-muted" role="status">Loading today's neurons…</span>
    </div>
    <div class="question" aria-hidden="true">
      <div class="row-between"><span class="t-title">Which cell?</span><span class="t-num-11 t-muted">— left</span></div>
      <div class="options">${[0, 1, 2, 3, 4, 5].map((i) => html`<div key=${i} class="skeleton skel-card"></div>`)}</div>
    </div>
  </div>`;
}

function EmptyState({ today }) {
  return html`<div class="screen"><div class="today-state">
    <div class="row-between"><span class="overline">NeuroGuesser · ${today.todayDate || today.date || ''}</span><${OfflineChip} /></div>
    <span class="t-title">No neurons today</span>
    <span class="t-body t-soft">Today's five neurons are not out yet. Rounds roll over at 00:00 UTC.</span>
    <div class="stack-4" style=${{ paddingTop: '8px' }}>
      <span class="t-label t-muted">Next neurons in</span>
      ${today.nextRolloverAt ? html`<${Countdown} to=${today.nextRolloverAt} class="countdown" />` : html`<span class="countdown">—</span>`}
    </div>
    <div class="actions">
      <${Button} variant="outline" block onClick=${() => navigate('/library')}>Open your library</${Button}>
    </div>
  </div></div>`;
}

function ErrorState({ error }) {
  const network = error && error.status === 0;
  const message = network
    ? 'The NeuroGuesser server could not be reached. Check your connection and try again.'
    : (error && error.message) || 'Something went wrong while loading today’s neurons.';
  const code = error ? `${error.code || 'error'}${error.status ? ` · ${error.status}` : ''}` : 'error';
  return html`<div class="screen"><div class="today-state" role="alert">
    <span class="overline is-error">✕ Couldn't load today</span>
    <span class="t-title">Today's neurons didn't load</span>
    <span class="t-body t-soft">${message}</span>
    <span class="code">${code}</span>
    <div class="actions">
      <${Button} block haptic="selection" onClick=${() => loadToday({ force: true })}>Retry</${Button}>
      <${Button} variant="outline" block onClick=${() => navigate('/library')}>Open your library</${Button}>
    </div>
  </div></div>`;
}

function OfflineState() {
  return html`<div class="screen"><div class="today-state" role="status">
    <span class="overline is-warn">! Offline</span>
    <span class="t-title">You're offline</span>
    <span class="t-body t-soft">Today's neurons need a connection the first time you open them. Once loaded, they stay readable offline.</span>
    <div class="actions">
      <${Button} block haptic="selection" onClick=${() => loadToday({ force: true })}>Retry</${Button}>
    </div>
  </div></div>`;
}
