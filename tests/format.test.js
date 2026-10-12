import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fmtPts, fmtSigned, fmtRank, initials, countdown, METHOD_NAMES, METHOD_BLURBS, strip, shareText, doneTotal, fmtUm,
} from '../js/format.js';
import { roundState, SCORING_EXAMPLE, SCORING_EXAMPLE_PROGRESS } from './fixtures.js';

test('fmtPts groups thousands with commas, locale-independent', () => {
  assert.equal(fmtPts(0), '0');
  assert.equal(fmtPts(200), '200');
  assert.equal(fmtPts(1200), '1,200');
  assert.equal(fmtPts(6000), '6,000');
  assert.equal(fmtPts(48210), '48,210');
  assert.equal(fmtPts(1234567), '1,234,567');
  assert.equal(fmtPts(-100), '−100');
});

test('fmtSigned uses a true minus and a plus', () => {
  assert.equal(fmtSigned(-100), '−100');
  assert.equal(fmtSigned(200), '+200');
  assert.equal(fmtSigned(0), '0');
  assert.equal(fmtRank(1284), '#1,284');
});

test('initials follow the Worker rule (first letters of the first two words)', () => {
  assert.equal(initials('Ana Ribeiro'), 'AR');
  assert.equal(initials('greg jefferis lab'), 'GJ');
  assert.equal(initials('Player-AB12'), 'P');
  assert.equal(initials('  '), '');
});

test('countdown formats HH:MM:SS and clamps at zero', () => {
  assert.equal(countdown(0), '00:00:00');
  assert.equal(countdown(-5000), '00:00:00');
  assert.equal(countdown(((7 * 60) + 12) * 60000 + 44000), '07:12:44');
  assert.equal(countdown(999), '00:00:00');
  assert.equal(countdown(86399000), '23:59:59');
});

test('METHOD_NAMES are identical to pool.yaml methods.*.name and blurbs carry no numbers', () => {
  assert.deepEqual(METHOD_NAMES, {
    sstem: 'Serial-section TEM', fib_sem: 'FIB-SEM', sssem: 'Serial-section SEM',
    atum_msem: 'ATUM-multiSEM', ibeam_msem: 'IBEAM-mSEM', sbem: 'Serial block-face SEM',
  });
  assert.deepEqual(Object.keys(METHOD_BLURBS).sort(), Object.keys(METHOD_NAMES).sort());
  for (const [id, blurb] of Object.entries(METHOD_BLURBS)) {
    assert.ok(!/\d/.test(blurb), `${id} blurb has a number`);
    assert.ok(/^[A-Z].*\.$/.test(blurb), `${id} blurb is one sentence`);
  }
  // cross-check with the private contracts when they sit next to this repo (skipped otherwise)
  const pool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../neuroguesser-content/contracts/pool.yaml');
  if (existsSync(pool)) {
    const text = readFileSync(pool, 'utf8');
    for (const [id, name] of Object.entries(METHOD_NAMES)) {
      assert.match(text, new RegExp(`\\n  ${id}:\\s+\\{name: "${name.replace(/[-.]/g, '\\$&')}"`), `pool.yaml ${id}`);
    }
  }
});

test('fmtUm', () => {
  assert.equal(fmtUm(10), '10 µm');
  assert.equal(fmtUm(1000), '1 mm');
});

test('strip renders clue boxes, guesses and the method glyph', () => {
  assert.equal(strip(null), '');
  assert.equal(strip(roundState({ stage: 'type' })), '□□');
  assert.equal(strip(roundState({ stage: 'type', wrong: ['b'], clues_opened: ['graph'] })), '■□ ✕');
  assert.equal(strip(roundState({ stage: 'method', wrong: ['b'], clues_opened: ['context'], type_result: 'correct' })), '■□ ✕✓');
  assert.equal(strip(roundState({ stage: 'done', type_result: 'correct', method_correct: true })), '□□ ✓ M');
  assert.equal(strip(roundState({ stage: 'done', wrong: ['a', 'b', 'c'], clues_opened: ['context', 'graph'], type_result: 'exhausted', method_correct: true })), '■■ ✕✕✕ M');
  assert.equal(strip(roundState({ stage: 'done', type_result: 'correct', method_correct: false, method_pick: null })), '□□ ✓ ·');
});

test('shareText reproduces the scoring.md example exactly', () => {
  assert.equal(doneTotal(SCORING_EXAMPLE_PROGRESS), 4200);
  assert.equal(shareText(214, SCORING_EXAMPLE_PROGRESS, 12), SCORING_EXAMPLE);
});

test('shareText matches the code block in contracts/scoring.md when the contracts are present', () => {
  const md = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../neuroguesser-content/contracts/scoring.md');
  if (!existsSync(md)) return;
  const text = readFileSync(md, 'utf8');
  const block = /## Share text[\s\S]*?```\n([\s\S]*?)\n```/.exec(text);
  assert.ok(block, 'share text block found in scoring.md');
  assert.equal(shareText(214, SCORING_EXAMPLE_PROGRESS, 12), block[1]);
});

test('shareText skips unfinished rounds and a zero streak', () => {
  const progress = [SCORING_EXAMPLE_PROGRESS[0], null, roundState({ round_index: 3, stage: 'type' }), null, null];
  assert.equal(shareText(5, progress, 0), 'NeuroGuesser #5 · 1,200\n1 □□ ✓ M');
  assert.equal(shareText(5, progress, 1), 'NeuroGuesser #5 · 1,200\n1 □□ ✓ M\n1-day streak');
});
