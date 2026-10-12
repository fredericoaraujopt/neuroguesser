// Day progress bar (js/ui/day-progress.js; ARCHITECTURE.md §3.3 item 3): segment states (colour + glyph), the running
// total, grace, the round screen's own round, and the fill that plays once when a round finishes (never after a reload).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer, flush } from './_dom.js';
import { roundState } from './fixtures.js';

const { h, render } = await import('preact');
const dp = await import('../js/ui/day-progress.js');

const rounds = [1, 2, 3, 4, 5].map((i) => ({ round_id: `r${i}`, round_index: i }));
const named = roundState({ stage: 'done', type_result: 'correct', method_correct: true }); // 1,200
const met = roundState({ stage: 'done', type_result: 'correct', wrong: ['a'], method_correct: false, method_score: 0, score: 900 });
const missed = roundState({ stage: 'done', type_result: 'exhausted', wrong: ['a', 'b', 'c'], method_pick: null });
const typing = roundState({ stage: 'type', score: 900, clues_opened: ['graph'] });
const methodStage = roundState({ stage: 'method', type_result: 'correct', score: 1000 });
const day = (progress, extra = {}) => ({ date: '2026-10-05', rounds, progress, ...extra });
const states = (segs) => segs.map((s) => s.state);

test('daySegments: a fresh day is current + 4 upcoming; done rounds by outcome; the first not-done round is current', () => {
  assert.deepEqual(states(dp.daySegments(day([null, null, null, null, null]))), ['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  const segs = dp.daySegments(day([named, met, missed, methodStage, null]));
  assert.deepEqual(states(segs), ['named', 'met', 'missed', 'current', 'upcoming']);
  assert.deepEqual(segs.map((s) => s.score), [named.score, met.score, missed.score, 0, 0]);
  assert.equal(dp.segmentsTotal(segs), named.score + met.score + missed.score);
  // a round in the type stage (clue opened) is not done: no points counted yet
  assert.deepEqual(states(dp.daySegments(day([named, typing, null, null, null]))), ['named', 'current', 'upcoming', 'upcoming', 'upcoming']);
  assert.deepEqual(states(dp.daySegments(day([named, met, missed, met, named]))), ['named', 'met', 'missed', 'met', 'named']);
  assert.deepEqual(dp.daySegments({ rounds: [], progress: [] }), []);
  assert.deepEqual(dp.daySegments(null), []);
});

test('daySegments: the round screen pins its own round as current, also during the hold after it finished', () => {
  const segs = dp.daySegments(day([named, met, null, null, null]), { playing: 2 });
  assert.deepEqual(states(segs), ['named', 'current', 'upcoming', 'upcoming', 'upcoming']);
  assert.equal(dp.segmentsTotal(segs), named.score, 'the pinned round is not counted until the reveal');
  // a round opened out of order (#/today/round/3 while 2 is open): only that one is current
  assert.deepEqual(states(dp.daySegments(day([named, null, null, null, null]), { playing: 3 })), ['named', 'upcoming', 'current', 'upcoming', 'upcoming']);
});

test('daySegments during grace: yesterday\'s open rounds play on, the others are closed (not "to play")', () => {
  const g = day([named, null, typing, null, missed], { graceActive: true, grace: { date: '2026-10-04', round_indexes: [3] } });
  assert.deepEqual(states(dp.daySegments(g)), ['named', 'closed', 'current', 'closed', 'missed']);
  // grace skipped (graceActive false): every open round is playable again
  assert.deepEqual(states(dp.daySegments({ ...g, graceActive: false })), ['named', 'current', 'upcoming', 'upcoming', 'missed']);
});

test('progressLabel: every state in words, with the total', () => {
  const segs = dp.daySegments(day([named, met, missed, null, null]));
  assert.equal(dp.progressLabel(segs, 2100), 'Today: round 1 named, round 2 met, round 3 missed, round 4 playing now, round 5 to play · 2,100 points');
  assert.equal(dp.progressLabel(segs, null).endsWith('round 5 to play'), true);
});

test('trackFills: the first sight of a day never animates; a round that turns done fills once, within the window', () => {
  dp._resetFills();
  const t0 = 1_000_000;
  assert.deepEqual(dp.trackFills('d1', ['named', 'current', 'upcoming'], t0), [false, false, false], 'reload / resume: no fill');
  assert.deepEqual(dp.trackFills('d1', ['named', 'current', 'upcoming'], t0 + 10), [false, false, false]);
  assert.deepEqual(dp.trackFills('d1', ['named', 'met', 'current'], t0 + 20), [false, true, false], 'round 2 just finished');
  assert.deepEqual(dp.trackFills('d1', ['named', 'met', 'current'], t0 + 1500), [false, true, false], 'the reveal mounting during the hold still fills');
  assert.deepEqual(dp.trackFills('d1', ['named', 'met', 'current'], t0 + 20 + dp.FILL_WINDOW_MS), [false, false, false], 'later bars show it filled');
  assert.deepEqual(dp.trackFills('d2', ['named', 'met', 'current'], t0 + 30), [false, false, false], 'another day (rollover, grace → today)');
});

test('trackFills: the first bar that shows the done state plays the fill; bars mounted later (next round, summary) do not', () => {
  dp._resetFills();
  const t0 = 2_000_000;
  const round = { bar: 1 }; const reveal = { bar: 2 }; const next = { bar: 3 };
  dp.trackFills('d', ['named', 'current', 'upcoming'], t0, round, [true, true, true]);
  // round 2 finishes; the round screen pins it as current during the hold: it does not claim the fill
  assert.deepEqual(dp.trackFills('d', ['named', 'met', 'current'], t0 + 10, round, [true, false, false]), [false, false, false]);
  // the reveal mounts and shows it done: it plays the fill, also on its own re-renders
  assert.deepEqual(dp.trackFills('d', ['named', 'met', 'current'], t0 + 900, reveal, [true, true, false]), [false, true, false]);
  assert.deepEqual(dp.trackFills('d', ['named', 'met', 'current'], t0 + 1100, reveal, [true, true, false]), [false, true, false]);
  // "Next round →" within the window: the next round screen shows round 2 filled at once
  assert.deepEqual(dp.trackFills('d', ['named', 'met', 'current'], t0 + 1500, next, [true, true, false]), [false, false, false]);
});

test('DayProgress renders colour + glyph per segment and the running total; no fill after a reload', async () => {
  dp._resetFills();
  const root = createContainer();
  render(h(dp.DayProgress, { today: day([named, met, missed, null, null]) }), root);
  await flush();
  const bar = root.firstChild;
  assert.match(bar.getAttribute('class'), /day-progress is-inline/);
  assert.equal(bar.getAttribute('role'), 'img');
  assert.match(bar.getAttribute('aria-label'), /round 1 named, round 2 met, round 3 missed, round 4 playing now, round 5 to play · 2,100 points$/);
  const segs = bar.firstChild.childNodes;
  assert.equal(segs.length, 5);
  assert.deepEqual(segs.map((s) => s.getAttribute('class')), ['dp-seg is-named', 'dp-seg is-met', 'dp-seg is-missed', 'dp-seg is-current', 'dp-seg is-upcoming']);
  assert.deepEqual(segs.map((s) => s.textContent), ['✓', '✓', '✕', '4', '5']);
  assert.equal(segs[1].getAttribute('title'), 'Round 2 · met · 900 pts');
  assert.match(bar.textContent, /2,100 pts$/);
  render(null, root);
});

test('DayProgress: a round that finishes while a bar is up fills (is-filling); showTotal false hides the total', async () => {
  dp._resetFills();
  const root = createContainer();
  const before = day([named, null, null, null, null]);
  render(h(dp.DayProgress, { today: before }), root);
  await flush();
  render(h(dp.DayProgress, { today: day([named, met, null, null, null]) }), root);
  await flush();
  const segs = root.firstChild.firstChild.childNodes;
  assert.equal(segs[1].getAttribute('class'), 'dp-seg is-met is-filling');
  assert.equal(segs[0].getAttribute('class'), 'dp-seg is-named');
  assert.match(root.firstChild.textContent, /2,100 pts$/, 'reduced motion in tests: the count-up lands at once');
  render(h(dp.DayProgress, { today: day([named, met, null, null, null]), showTotal: false, variant: 'header' }), root);
  await flush();
  assert.match(root.firstChild.getAttribute('class'), /is-header/);
  assert.equal(root.firstChild.childNodes.length, 1, 'segments only');
  render(null, root);
});

test('DayProgress with playing: the round screen shows its round as current while the data says done (no fill there)', async () => {
  dp._resetFills();
  const root = createContainer();
  render(h(dp.DayProgress, { today: day([named, null, null, null, null]), playing: 2 }), root);
  await flush();
  render(h(dp.DayProgress, { today: day([named, met, null, null, null]), playing: 2 }), root);
  await flush();
  let segs = root.firstChild.firstChild.childNodes;
  assert.equal(segs[1].getAttribute('class'), 'dp-seg is-current');
  assert.match(root.firstChild.textContent, /1,200 pts$/);
  // the reveal then mounts its own bar: round 2 fills there
  render(h(dp.DayProgress, { today: day([named, met, null, null, null]), class: 'in-reveal', key: 'reveal' }), root);
  await flush();
  segs = root.firstChild.firstChild.childNodes;
  assert.equal(segs[1].getAttribute('class'), 'dp-seg is-met is-filling');
  // "Next round →": round 3's screen shows round 2 filled, without replaying the fill
  render(h(dp.DayProgress, { today: day([named, met, null, null, null]), playing: 3, key: 'round3' }), root);
  await flush();
  segs = root.firstChild.firstChild.childNodes;
  assert.deepEqual(segs.map((x) => x.getAttribute('class')), ['dp-seg is-named', 'dp-seg is-met', 'dp-seg is-current', 'dp-seg is-upcoming', 'dp-seg is-upcoming']);
  render(null, root);
});

test('DayProgress: a header bar claims fills only on desktop widths (hidden on phones); grace reads "Yesterday"', async () => {
  dp._resetFills();
  const root = createContainer();
  // no matchMedia in node = not ≥ 1024 px: the header bar shows the round filled without animating, the inline bar plays it
  render(h('div', null, h(dp.DayProgress, { today: day([named, null, null, null, null]), variant: 'header' })), root);
  await flush();
  render(h('div', null, h(dp.DayProgress, { today: day([named, met, null, null, null]), variant: 'header' })), root);
  await flush();
  assert.equal(root.firstChild.firstChild.firstChild.childNodes[1].getAttribute('class'), 'dp-seg is-met');
  render(h('div', null, h(dp.DayProgress, { today: day([named, met, null, null, null]), variant: 'header' }),
    h(dp.DayProgress, { today: day([named, met, null, null, null]), class: 'in-reveal' })), root);
  await flush();
  assert.equal(root.firstChild.childNodes[1].firstChild.childNodes[1].getAttribute('class'), 'dp-seg is-met is-filling');
  const g = day([named, null, typing, null, null], { graceActive: true, grace: { date: '2026-10-04', round_indexes: [3] } });
  render(h(dp.DayProgress, { today: g }), root);
  await flush();
  assert.match(root.firstChild.getAttribute('aria-label'), /^Yesterday: round 1 named, round 2 closed, not played, round 3 playing now/);
  render(null, root);
});
