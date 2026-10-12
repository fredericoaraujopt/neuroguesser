import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { diffOvertakes, snapshotOf, formatOvertake, pickOvertake, ranksKey } = await import('../js/fx/overtake.js');

const row = (user_id, rank, display_name = user_id, extra = {}) => ({ user_id, rank, display_name, initials: 'XX', affiliation: null, total: 0, streak: 0, strip: null, is_me: false, ...extra });
const snap = (rows, meId) => snapshotOf({ rows, me: rows.find((r) => r.user_id === meId) ? { ...rows.find((r) => r.user_id === meId), is_me: true } : null });

test('passed = users above me before and below me now (matched by user_id)', () => {
  const prev = snap([row('g', 1, 'Greg'), row('a', 2, 'Ana Ribeiro'), row('me', 3, 'You'), row('l', 4, 'Leo')], 'me');
  const next = snap([row('g', 1, 'Greg'), row('me', 2, 'You'), row('a', 3, 'Ana Ribeiro'), row('l', 4, 'Leo')], 'me');
  assert.deepEqual(diffOvertakes(prev, next, 'me'), { oldRank: 3, newRank: 2, passed: ['Ana Ribeiro'] });
});

test('several passed, ordered by their new rank; renamed users keep matching by id', () => {
  const prev = snap([row('a', 1, 'Ana'), row('b', 2, 'Bo'), row('me', 3)], 'me');
  const next = snap([row('me', 1), row('b', 2, 'Bo Renamed'), row('a', 3, 'Ana')], 'me');
  assert.deepEqual(diffOvertakes(prev, next, 'me'), { oldRank: 3, newRank: 1, passed: ['Bo Renamed', 'Ana'] });
});

test('no event without a previous snapshot, without a rank, or when nothing improved', () => {
  const s = snap([row('a', 1), row('me', 2)], 'me');
  assert.equal(diffOvertakes(null, s, 'me'), null);
  assert.equal(diffOvertakes(snap([row('a', 1)], 'me'), s, 'me'), null);  // I had no rank before
  assert.equal(diffOvertakes(s, s, 'me'), null);
  const worse = snap([row('a', 1), row('b', 2), row('me', 3)], 'me');
  assert.equal(diffOvertakes(s, worse, 'me'), null);
});

test('ties: someone level with me before is not "above me"', () => {
  const prev = snap([row('a', 1), row('b', 2), row('me', 2)], 'me');
  const next = snap([row('a', 1), row('me', 2), row('b', 3)], 'me');
  assert.equal(diffOvertakes(prev, next, 'me'), null);
});

test('Global top 5: a better rank outside the shown rows is an event with nobody named', () => {
  const top = [1, 2, 3, 4, 5].map((i) => row(`t${i}`, i));
  const prev = snapshotOf({ rows: top, me: row('me', 1284, 'You', { is_me: true }) });
  const next = snapshotOf({ rows: top, me: row('me', 1250, 'You', { is_me: true }) });
  assert.deepEqual(diffOvertakes(prev, next, 'me'), { oldRank: 1284, newRank: 1250, passed: [] });
  // entering the top 5 names the people passed who are still listed
  const next2 = snapshotOf({ rows: [row('t1', 1), row('t2', 2), row('me', 3, 'You', { is_me: true }), row('t3', 4), row('t4', 5)], me: row('me', 3, 'You', { is_me: true }) });
  assert.deepEqual(diffOvertakes(prev, next2, 'me'), { oldRank: 1284, newRank: 3, passed: ['t3', 't4'] });
});

test('formatOvertake / pickOvertake / ranksKey', () => {
  assert.equal(formatOvertake({ scope: 'lab', groupName: 'MRC LMB', oldRank: 3, newRank: 2, passed: ['Ana Ribeiro'] }),
    '↑ You passed Ana Ribeiro · now #2 in MRC LMB');
  assert.equal(formatOvertake({ scope: 'friends', groupName: 'Pals', oldRank: 4, newRank: 1, passed: ['A', 'B', 'C'] }),
    '↑ You passed A and 2 others · now #1 in Pals');
  assert.equal(formatOvertake({ scope: 'global', groupName: 'Global', oldRank: 1284, newRank: 1250, passed: [] }), '↑ Now #1,250 globally');
  const evs = [
    { scope: 'global', oldRank: 1284, newRank: 1000, passed: [] },
    { scope: 'lab', groupName: 'MRC LMB', oldRank: 3, newRank: 2, passed: ['Ana'] },
  ];
  assert.equal(pickOvertake(evs).scope, 'lab');
  assert.equal(pickOvertake([]), null);
  assert.equal(ranksKey({ scope: 'lab', groupId: 'g1', date: '2026-10-03' }), 'lab:g1:2026-10-03');
  assert.equal(ranksKey({ scope: 'global', date: '2026-10-03' }), 'global:-:2026-10-03');
});
