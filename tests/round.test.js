// Round screen (js/screens/round.js) pure parts: the wrong-guess status line, the full view opener args and the
// paid-clue copy (v1.2: clues are extra information only).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const round = await import('../js/screens/round.js');

const ROUND = {
  round_id: 'r1',
  options: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, label: `Type ${id.toUpperCase()}`, sub: 'sub' })),
};
const typeState = (wrong) => ({ stage: 'type', wrong, eliminated: [], clues_opened: [], score: 1000 - 100 * wrong.length });

test('wrongStatus: none before a wrong guess, the last wrong one with guesses left, singular at 1', () => {
  assert.equal(round.wrongStatus(ROUND, null), null);
  assert.equal(round.wrongStatus(ROUND, typeState([])), null);
  assert.equal(round.wrongStatus(ROUND, typeState(['b'])), '✕ Not Type B · −100 · 2 guesses left');
  assert.equal(round.wrongStatus(ROUND, typeState(['b', 'd'])), '✕ Not Type D · −100 · 1 guess left');
});

test('wrongStatus: hidden while the guess just sent still shakes as "● picked"', () => {
  assert.equal(round.wrongStatus(ROUND, typeState(['b']), 'b'), null);
  assert.equal(round.wrongStatus(ROUND, typeState(['b', 'd']), 'c'), '✕ Not Type D · −100 · 1 guess left');
});

test('wrongStatus: after the 3rd wrong guess "no guesses left"; nothing after a correct guess', () => {
  const exhausted = { stage: 'method', wrong: ['a', 'b', 'c'], type_result: 'exhausted', correct_option: 'e' };
  assert.equal(round.wrongStatus(ROUND, exhausted), '✕ Not Type C · no guesses left');
  const met = { stage: 'method', wrong: ['a'], type_result: 'correct', correct_option: 'e' };
  assert.equal(round.wrongStatus(ROUND, met), null);
});

test('fullViewArgs: the Context clue tab opens "In context" and keeps the 3D orientation', () => {
  const view = { yaw: 1.2, tilt: 0.3, zoom: 1, panX: 0, panY: 0 };
  assert.deepEqual(round.fullViewArgs({ roundIndex: 2, mode: '3d', typeTab: 'context', view }),
    { roundIndex: 2, mode: '3d', context: true, view });
  assert.deepEqual(round.fullViewArgs({ roundIndex: 2, mode: '3d', typeTab: 'mesh' }), { roundIndex: 2, mode: '3d' });
  // graph has no full view, and EM args never leak into 3D
  assert.deepEqual(round.fullViewArgs({ roundIndex: 1, mode: '3d', typeTab: 'mesh', methodTab: 'xz', slice: 4 }), { roundIndex: 1, mode: '3d' });
});

test('fullViewArgs: EM keeps the plane (XY | XZ) and a valid 0-based slice', () => {
  assert.deepEqual(round.fullViewArgs({ roundIndex: 3, mode: 'em', methodTab: 'xz', slice: 18 }),
    { roundIndex: 3, mode: 'em', plane: 'xz', slice: 18 });
  assert.deepEqual(round.fullViewArgs({ roundIndex: 3, mode: 'em', methodTab: 'xy', slice: 0 }),
    { roundIndex: 3, mode: 'em', plane: 'xy', slice: 0 });
  assert.deepEqual(round.fullViewArgs({ roundIndex: 3, mode: 'em', methodTab: 'xy', slice: null, view: { yaw: 1 } }),
    { roundIndex: 3, mode: 'em', plane: 'xy' });
  assert.deepEqual(round.fullViewArgs({ roundIndex: 3, mode: 'em', slice: -1 }), { roundIndex: 3, mode: 'em', plane: 'xy' });
});

test('v1.2 clue copy: extra information only, every option stays available; nothing says a clue rules an option out', () => {
  for (const kind of ['context', 'graph']) {
    const copy = round.CLUE_COPY[kind];
    assert.match(copy, /Extra information only: every option stays available\./, kind);
    assert.doesNotMatch(copy, /rules? out|ruled out|eliminat/i, kind);
  }
  const onboarding = readFileSync(new URL('../js/screens/onboarding.js', import.meta.url), 'utf8');
  assert.match(onboarding, /−100 each for extra information, and every option stays available/);
  assert.doesNotMatch(onboarding, /rules out one wrong answer/);
  const src = readFileSync(new URL('../js/screens/round.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /rules out one wrong answer/);
  assert.doesNotMatch(src, /resp\.eliminated_option/, 'opening a clue no longer scrolls to / strikes a ruled-out card');
});
