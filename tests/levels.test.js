// XP levels (ARCHITECTURE.md §3.4 item 2): js/levels.js, the gentle curve "level n + 1 at 1,500 · n^1.4 cumulative XP".
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const L = await import('../js/levels.js');

test('xpForLevel: level 1 at 0 XP, level n + 1 at 1,500 · n^1.4 rounded to 10', () => {
  assert.equal(L.xpForLevel(1), 0);
  assert.deepEqual([2, 3, 4, 5, 6, 10, 20, 100].map(L.xpForLevel), [1500, 3960, 6980, 10450, 14280, 32510, 92540, 933210]);
  for (let n = 2; n <= 200; n++) assert.equal(L.xpForLevel(n), Math.round((1500 * (n - 1) ** 1.4) / 10) * 10);
  assert.equal(L.xpForLevel(0), 0, 'clamped to level 1');
  assert.equal(L.xpForLevel(5000), L.xpForLevel(L.MAX_LEVEL), 'clamped to the ceiling');
});

test('the curve only gets longer: each level needs at least as much XP as the one before', () => {
  let gap = 0;
  for (let n = 1; n < L.MAX_LEVEL; n++) {
    const next = L.xpForLevel(n + 1) - L.xpForLevel(n);
    assert.ok(next >= gap, `level ${n + 1}: ${next} < ${gap}`);
    gap = next;
  }
});

test('levelOf: exact at the thresholds; invalid input counts as 0 XP', () => {
  assert.deepEqual([0, 1, 1499, 1500, 3959, 3960, 6979, 6980].map(L.levelOf), [1, 1, 1, 2, 2, 3, 3, 4]);
  for (const bad of [-5, NaN, null, undefined, 'x', {}]) assert.equal(L.levelOf(bad), 1);
  assert.equal(L.levelOf(1e12), L.MAX_LEVEL);
  for (let x = 0; x < 300000; x += 37) {
    const n = L.levelOf(x);
    assert.ok(L.xpForLevel(n) <= x && x < L.xpForLevel(n + 1), `${x} XP → level ${n}`);
  }
});

test('levelInfo: floor, next, progress through the level and XP still needed', () => {
  assert.deepEqual(L.levelInfo(8230), { xp: 8230, level: 4, floor: 6980, next: 10450, into: 1250, span: 3470, frac: 1250 / 3470, toNext: 2220 });
  assert.deepEqual(L.levelInfo(0), { xp: 0, level: 1, floor: 0, next: 1500, into: 0, span: 1500, frac: 0, toNext: 1500 });
  const top = L.levelInfo(1e12);
  assert.equal(top.level, L.MAX_LEVEL);
  assert.equal(top.next, null);
  assert.equal(top.frac, 1);
  assert.equal(top.toNext, 0);
});

test('levelsCrossed: the levels reached between two XP totals', () => {
  assert.deepEqual(L.levelsCrossed(0, 4200), [2, 3]);
  assert.deepEqual(L.levelsCrossed(4030, 8230), [4]);
  assert.deepEqual(L.levelsCrossed(4000, 4100), []);
  assert.deepEqual(L.levelsCrossed(10449, 10450), [5]);
  assert.deepEqual(L.levelsCrossed(8230, 4030), [], 'never backwards');
});

test('gentle: at 4,000 points a day, level 3 after day 1, 7 after day 5, 23 after a month, 55 after 100 days', () => {
  assert.deepEqual([1, 5, 30, 100].map((d) => L.levelOf(d * 4000)), [3, 7, 23, 55]);
});
