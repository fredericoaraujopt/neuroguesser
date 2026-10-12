// Library + review pure helpers (js/screens/library.js, js/screens/review.js; ARCHITECTURE.md §3 "Library",
// "Review"; contracts/api.md "Schedule": intervals [2, 7, 21], correct → step + 1 (max 2), wrong → step 0).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const lib = await import('../js/screens/library.js');
const { scheduleCopy } = await import('../js/screens/review.js');

const ok = (step) => ({ correct: true, step });
const no = () => ({ correct: false, step: 0 });

test('scheduleCopy: all named', () => {
  assert.equal(scheduleCopy([ok(1), ok(1), ok(1)]), 'All three come back in 7 days, then 21.');
  assert.equal(scheduleCopy([ok(1)]), 'It comes back in 7 days, then 21.');
  assert.equal(scheduleCopy([ok(2)]), 'It comes back in 21 days.');
  assert.equal(scheduleCopy([ok(1), ok(2), ok(1), ok(2), ok(1)]), 'All five come back in 7 or 21 days.');
});

test('scheduleCopy: mixed and all missed', () => {
  assert.equal(scheduleCopy([ok(1), no(), no()]), 'The cell you named comes back in 7 days. Two missed cells return in 2 days.');
  assert.equal(scheduleCopy([ok(1), ok(1), no()]), 'Cells you named come back in 7 days. One missed cell returns in 2 days.');
  assert.equal(scheduleCopy([ok(2), ok(1), no()]), 'Cells you named come back in 7 or 21 days. One missed cell returns in 2 days.');
  assert.equal(scheduleCopy([no(), no(), no()]), 'All three return in 2 days.');
  assert.equal(scheduleCopy([no()]), 'One missed cell returns in 2 days.');
  assert.equal(scheduleCopy([no(), no()]), 'Both return in 2 days.');
  assert.equal(scheduleCopy([ok(1), ok(1)]), 'Both come back in 7 days, then 21.');
  assert.match(scheduleCopy([]), /already reviewed/);
});

test('reviewCellCount: queue length, else min(due, 5); a stale empty queue never hides due cells', () => {
  assert.equal(lib.reviewCellCount([{}, {}, {}], 44), 3);
  assert.equal(lib.reviewCellCount(null, 44), 5);
  assert.equal(lib.reviewCellCount(undefined, 2), 2);
  assert.equal(lib.reviewCellCount([], 39), 5);
  assert.equal(lib.reviewCellCount([], 0), 0);
  assert.equal(lib.reviewMinutes(1), 1);
  assert.equal(lib.reviewMinutes(2), 1);
  assert.equal(lib.reviewMinutes(3), 2);
  assert.equal(lib.reviewMinutes(5), 2);
});

test('entryStatus: due → ↻ review (warn); else the outcome word, colour + glyph', () => {
  const e = (outcome, due) => ({ outcome, review: { step: 0, next_review_at: '2026-10-05', due } });
  assert.deepEqual(lib.entryStatus(e('missed', true)), { word: '↻ review', tone: 'warn' });
  assert.equal(lib.entryStatus(e('named', false)).word, '✓ named');
  assert.equal(lib.entryStatus(e('named', false)).tone, 'accent');
  assert.equal(lib.entryStatus(e('met', false)).word, '✓ met');
  assert.equal(lib.entryStatus(e('missed', false)).word, '✕ missed');
  assert.equal(lib.entryStatus(e('missed', false)).tone, 'error');
  assert.equal(lib.roundTag(33, 2), '#33·2');
});
