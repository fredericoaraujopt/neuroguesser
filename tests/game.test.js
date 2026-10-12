import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundState, roundPublic, todaySlice, SCORING_EXAMPLE_PROGRESS } from './fixtures.js';

const game = await import('../js/game.js');
const { optionStates, optionsLeft, guessesLeft, currentView, resolveTodayView, dayTotal, roundsDone, strip, outcomeOf, isPerfect, pointsOf, initialRevealAck } = game;

const rp = roundPublic(1);

test('optionStates: unstarted round → all idle', () => {
  assert.deepEqual(optionStates(rp, null), { a: 'idle', b: 'idle', c: 'idle', d: 'idle', e: 'idle', f: 'idle' });
});

test('optionStates (v1.2): clues rule nothing out — after both clues every option not guessed wrong stays idle', () => {
  const st = roundState({ stage: 'type', wrong: ['c'], eliminated: [], clues_opened: ['context', 'graph'], score: 700 });
  assert.deepEqual(optionStates(rp, st), { a: 'idle', b: 'idle', c: 'wrong', d: 'idle', e: 'idle', f: 'idle' });
  assert.equal(optionsLeft(rp, st), 5);
  assert.equal(optionsLeft(rp, roundState({ clues_opened: ['context', 'graph'], score: 800 })), 6);
});

test('optionStates (rounds played before v1.2): type stage distinguishes wrong (guessed) from out (eliminated by a clue)', () => {
  const st = roundState({ stage: 'type', wrong: ['c'], eliminated: ['f', 'b'], clues_opened: ['context', 'graph'], score: 700 });
  assert.deepEqual(optionStates(rp, st), { a: 'idle', b: 'out', c: 'wrong', d: 'idle', e: 'idle', f: 'out' });
  // the answer is never revealed during the type stage, even if a (malformed) state carried it
  assert.equal(optionStates(rp, { ...st, correct_option: 'd' }).d, 'idle');
});

test('optionStates: method stage shows the answer, keeps wrong and (pre-v1.2) out', () => {
  const st = roundState({ stage: 'method', type_result: 'correct', wrong: ['c'], eliminated: ['f'], clues_opened: ['context'], correct_option: 'd' });
  assert.deepEqual(optionStates(rp, st), { a: 'idle', b: 'idle', c: 'wrong', d: 'answer', e: 'idle', f: 'out' });
});

test('optionStates: exhausted (3 wrong) and done stages', () => {
  const ex = roundState({ stage: 'method', type_result: 'exhausted', wrong: ['a', 'c', 'e'], eliminated: ['b', 'f'], clues_opened: ['context', 'graph'], correct_option: 'd' });
  assert.deepEqual(optionStates(rp, ex), { a: 'wrong', b: 'out', c: 'wrong', d: 'answer', e: 'wrong', f: 'out' });
  const done = roundState({ stage: 'done', type_result: 'correct', correct_option: 'a', method_correct: true });
  assert.deepEqual(optionStates(rp, done), { a: 'answer', b: 'idle', c: 'idle', d: 'idle', e: 'idle', f: 'idle' });
});

test('optionsLeft counts pickable options in the type stage only', () => {
  assert.equal(optionsLeft(rp, null), 6);
  assert.equal(optionsLeft(rp, roundState({ wrong: ['c'], eliminated: ['f', 'b'], clues_opened: ['context', 'graph'] })), 3);
  assert.equal(optionsLeft(rp, roundState({ stage: 'method', type_result: 'correct' })), 0);
});

test('guessesLeft = 3 − wrong', () => {
  assert.equal(guessesLeft(null), 3);
  assert.equal(guessesLeft(roundState({})), 3);
  assert.equal(guessesLeft(roundState({ wrong: ['a'] })), 2);
  assert.equal(guessesLeft(roundState({ wrong: ['a', 'b'] })), 1);
  assert.equal(guessesLeft(roundState({ stage: 'method', type_result: 'exhausted', wrong: ['a', 'b', 'c'] })), 0);
});

test('dayTotal / roundsDone / strip / outcomeOf / isPerfect / pointsOf', () => {
  assert.equal(dayTotal(SCORING_EXAMPLE_PROGRESS), 4200);
  assert.equal(dayTotal([null, roundState({ stage: 'method', type_result: 'correct' })]), 0);
  assert.equal(roundsDone(SCORING_EXAMPLE_PROGRESS), 5);
  assert.equal(strip(SCORING_EXAMPLE_PROGRESS[1]), '■□ ✕✓ M');
  assert.equal(outcomeOf(null), null);
  assert.equal(outcomeOf(roundState({})), null);
  assert.equal(outcomeOf(SCORING_EXAMPLE_PROGRESS[0]), 'named');
  assert.equal(outcomeOf(SCORING_EXAMPLE_PROGRESS[1]), 'met');
  assert.equal(outcomeOf(SCORING_EXAMPLE_PROGRESS[3]), 'missed');
  const noField = { ...SCORING_EXAMPLE_PROGRESS[3] }; delete noField.outcome;
  assert.equal(outcomeOf(noField), 'missed');
  assert.equal(isPerfect(SCORING_EXAMPLE_PROGRESS[0]), true);
  assert.equal(isPerfect(SCORING_EXAMPLE_PROGRESS[1]), false);
  assert.equal(pointsOf(null), 1000);
  assert.equal(pointsOf(roundState({ score: 800 })), 800);
});

const done = (i, extra = {}) => roundState({ round_index: i, stage: 'done', type_result: 'correct', method_correct: true, ...extra });

test('currentView: empty, first round, mid-round', () => {
  assert.deepEqual(currentView(todaySlice({ rounds: [] })), { kind: 'empty', index: null });
  assert.deepEqual(currentView(todaySlice()), { kind: 'round', index: 1 });
  const p = [done(1), roundState({ round_index: 2, wrong: ['a'] }), null, null, null];
  assert.deepEqual(currentView(todaySlice({ progress: p, revealAck: [true, false, false, false, false] })), { kind: 'round', index: 2 });
  const m = [done(1), roundState({ round_index: 2, stage: 'method', type_result: 'correct' }), null, null, null];
  assert.deepEqual(currentView(todaySlice({ progress: m, revealAck: [true, false, false, false, false] })), { kind: 'round', index: 2 });
});

test('currentView: a done round shows its reveal until revealAck, then the next round', () => {
  const p = [done(1), null, null, null, null];
  assert.deepEqual(currentView(todaySlice({ progress: p })), { kind: 'reveal', index: 1 });
  assert.deepEqual(currentView(todaySlice({ progress: p, revealAck: [true, false, false, false, false] })), { kind: 'round', index: 2 });
});

test('currentView: summary only when all five are done AND acknowledged', () => {
  const all = [1, 2, 3, 4, 5].map((i) => done(i));
  assert.deepEqual(currentView(todaySlice({ progress: all, revealAck: [true, true, true, true, false] })), { kind: 'reveal', index: 5 });
  assert.deepEqual(currentView(todaySlice({ progress: all, revealAck: [true, true, true, true, true] })), { kind: 'summary', index: null });
  // an earlier unacknowledged reveal comes first
  assert.deepEqual(currentView(todaySlice({ progress: all, revealAck: [true, false, true, true, true] })), { kind: 'reveal', index: 2 });
});

test('currentView: grace keeps only yesterday\'s unfinished rounds, then signals graceOver', () => {
  const grace = { date: '2026-10-02', day_number: 32, until: '2026-10-03T00:30:00Z', round_indexes: [3, 4] };
  const base = { date: '2026-10-02', dayNumber: 32, grace, graceActive: true };
  const p = [done(1), done(2), roundState({ round_index: 3, wrong: ['b'] }), roundState({ round_index: 4 }), null];
  const ack = [true, true, false, false, false];
  assert.deepEqual(currentView(todaySlice({ ...base, progress: p, revealAck: ack })), { kind: 'round', index: 3 });
  const p2 = [done(1), done(2), done(3), roundState({ round_index: 4 }), null];
  assert.deepEqual(currentView(todaySlice({ ...base, progress: p2, revealAck: ack })), { kind: 'reveal', index: 3 });
  assert.deepEqual(currentView(todaySlice({ ...base, progress: p2, revealAck: [true, true, true, false, false] })), { kind: 'round', index: 4 });
  const p3 = [done(1), done(2), done(3), done(4), null];
  // round 5 was never started: it is not part of grace, so grace is over once 3 and 4 are acknowledged
  assert.deepEqual(currentView(todaySlice({ ...base, progress: p3, revealAck: [true, true, true, true, false] })), { kind: 'empty', index: null, graceOver: true });
  // grace present but not active (player left it / today loaded) → normal rules
  assert.deepEqual(currentView(todaySlice({ grace, graceActive: false })), { kind: 'round', index: 1 });
});

test('resolveTodayView maps routes to views and canonical paths', () => {
  const p = [done(1), roundState({ round_index: 2 }), null, null, null];
  const t = todaySlice({ progress: p, revealAck: [false, false, false, false, false] });
  assert.deepEqual(resolveTodayView(t, 'today', {}), { kind: 'reveal', index: 1, path: '/today/reveal/1' });
  assert.deepEqual(resolveTodayView(t, 'today-round', { n: '1' }), { kind: 'reveal', index: 1, path: '/today/reveal/1' });
  assert.deepEqual(resolveTodayView(t, 'today-round', { n: '2' }), { kind: 'round', index: 2, path: '/today/round/2' });
  assert.deepEqual(resolveTodayView(t, 'today-reveal', { n: '2' }), { kind: 'reveal', index: 1, path: '/today/reveal/1' });
  assert.deepEqual(resolveTodayView(t, 'today-round', { n: '9' }), { kind: 'reveal', index: 1, path: '/today/reveal/1' });
  const acked = todaySlice({ progress: p, revealAck: [true, false, false, false, false] });
  assert.deepEqual(resolveTodayView(acked, 'today-round', { n: '1' }), { kind: 'round', index: 2, path: '/today/round/2' });
  // summary rows link to acknowledged reveals
  assert.deepEqual(resolveTodayView(acked, 'today-reveal', { n: '1' }), { kind: 'reveal', index: 1, path: '/today/reveal/1' });
  const all = todaySlice({ progress: [1, 2, 3, 4, 5].map((i) => done(i)), revealAck: [true, true, true, true, true] });
  assert.deepEqual(resolveTodayView(all, 'today', {}), { kind: 'summary', index: null, path: '/today' });
  assert.deepEqual(resolveTodayView(todaySlice({ rounds: [] }), 'today', {}), { kind: 'empty', index: null, path: '/today' });
});

test('initialRevealAck: rounds already done at first sight count as acknowledged', () => {
  assert.deepEqual(initialRevealAck([done(1), null, roundState({ round_index: 3 }), done(4), null]), [true, false, false, true, false]);
  assert.deepEqual(initialRevealAck(undefined), [false, false, false, false, false]);
});
