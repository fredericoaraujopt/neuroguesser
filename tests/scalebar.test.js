import test from 'node:test';
import assert from 'node:assert/strict';
import { niceScale, orthoPxPerUm, DEFAULT_STEPS } from '../js/viewer/scalebar.js';

test('niceScale picks the largest 1/2/5 step that fits maxPx', () => {
  assert.deepEqual(niceScale(1, 120), { um: 100, px: 100 });
  assert.deepEqual(niceScale(2.4, 120), { um: 50, px: 120 });          // exactly maxPx fits
  assert.deepEqual(niceScale(0.3, 120), { um: 200, px: 60 });
  assert.deepEqual(niceScale(25, 120), { um: 2, px: 50 });
  assert.deepEqual(niceScale(0.05, 120), { um: 1000, px: 50 });
});

test('niceScale falls back to the smallest step when nothing fits', () => {
  assert.deepEqual(niceScale(500, 120), { um: 1, px: 500 });
});

test('niceScale with custom steps (handoff EM bar 1/2/5/10/20)', () => {
  const steps = [1, 2, 5, 10, 20];
  assert.deepEqual(niceScale(27.86, 130, steps), { um: 2, px: 55.72 });
  assert.deepEqual(niceScale(5, 130, steps), { um: 20, px: 100 });
  assert.deepEqual(niceScale(4, 120, [20, 5, 10]), { um: 20, px: 80 }); // order-independent
});

test('niceScale rejects bad input', () => {
  assert.deepEqual(niceScale(0), { um: 1, px: 0 });
  assert.deepEqual(niceScale(-3), { um: 1, px: 0 });
  assert.deepEqual(niceScale(NaN), { um: 1, px: 0 });
  assert.deepEqual(niceScale(Infinity), { um: 1, px: 0 });
  assert.equal(DEFAULT_STEPS.at(-1), 1000);
});

test('orthoPxPerUm', () => {
  assert.equal(orthoPxPerUm({ top: 50, bottom: -50, zoom: 1 }, 400), 4);
  assert.equal(orthoPxPerUm({ top: 50, bottom: -50, zoom: 2 }, 400), 8);
  assert.equal(orthoPxPerUm(null, 400), 0);
});
