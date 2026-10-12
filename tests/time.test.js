import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOffset, setOffset, getOffset, now, utcDate, nextUtcMidnight, addDays, msUntil, nextDeadline, isRolloverDue, isStale,
} from '../js/time.js';

test('computeOffset uses the request midpoint', () => {
  const sent = Date.parse('2026-10-03T11:59:59.000Z');
  const recv = sent + 400;
  assert.equal(computeOffset('2026-10-03T12:00:00Z', sent, recv), 800);
  assert.equal(computeOffset('not a date', sent, recv), 0);
});

test('now() applies the offset', () => {
  setOffset(60000);
  assert.equal(getOffset(), 60000);
  const d = now() - Date.now();
  assert.ok(d >= 59990 && d <= 60010);
  setOffset(NaN);
  assert.equal(getOffset(), 0);
});

test('UTC date helpers', () => {
  assert.equal(utcDate(Date.parse('2026-10-03T23:59:59Z')), '2026-10-03');
  assert.equal(utcDate(Date.parse('2026-10-04T00:00:00Z')), '2026-10-04');
  assert.equal(nextUtcMidnight(Date.parse('2026-10-03T12:00:00Z')), Date.parse('2026-10-04T00:00:00Z'));
  assert.equal(nextUtcMidnight(Date.parse('2026-10-04T00:00:00Z')), Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(addDays('2026-10-03', -1), '2026-10-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(msUntil('2026-10-04T00:00:00Z', Date.parse('2026-10-03T23:59:00Z')), 60000);
  assert.equal(msUntil('2026-10-04T00:00:00Z', Date.parse('2026-10-04T01:00:00Z')), 0);
});

test('rollover deadline: next_rollover_at, or grace.until while the grace day is on screen', () => {
  const t = { nextRolloverAt: '2026-10-04T00:00:00Z', grace: null, graceActive: false };
  assert.equal(nextDeadline(t), Date.parse('2026-10-04T00:00:00Z'));
  assert.equal(nextDeadline({}), null);
  assert.equal(isRolloverDue(t, Date.parse('2026-10-03T23:59:59Z')), false);
  assert.equal(isRolloverDue(t, Date.parse('2026-10-04T00:00:00Z')), true);
  const g = { nextRolloverAt: '2026-10-04T00:00:00Z', grace: { until: '2026-10-03T00:30:00Z' }, graceActive: true };
  assert.equal(nextDeadline(g), Date.parse('2026-10-03T00:30:00Z'));
  assert.equal(isRolloverDue(g, Date.parse('2026-10-03T00:29:59Z')), false);
  assert.equal(isRolloverDue(g, Date.parse('2026-10-03T00:30:00Z')), true);
  // grace on the response but not shown (the player left it): only the midnight rollover counts
  assert.equal(nextDeadline({ ...g, graceActive: false }), Date.parse('2026-10-04T00:00:00Z'));
});

test('isStale (5 minutes by default)', () => {
  assert.equal(isStale(0, 1000), true);
  assert.equal(isStale(1000, 1000 + 5 * 60000), false);
  assert.equal(isStale(1000, 1000 + 5 * 60000 + 1), true);
});
