// Leaderboard overtakes (ARCHITECTURE.md §3.1, §4.7).
// checkOvertakes() fetches today's ranks for Global and each of the user's groups, compares them with the
// last snapshot in IndexedDB (key lastRanks:<scope>:<group|->:<date>) and returns
//   [{ scope, groupId, groupName, oldRank, newRank, passed: [display_name…] }]
// passed = users ranked above me before and below me now (matched by user_id). The new snapshot is then
// stored; the Ranks screen reads the same snapshots for its FLIP reorder (lastRanksSnapshot / saveRanksSnapshot).
import * as api from '../api.js';
import * as idb from '../idb.js';
import { store, showToast } from '../store.js';
import { haptic } from './haptics.js';
import { fmtPts } from '../format.js';

export const ranksKey = ({ scope, groupId = null, date, period = 'day' }) =>
  `${scope}:${groupId || '-'}:${date}${period && period !== 'day' ? `:${period}` : ''}`;

/** Compact snapshot of a GET /v1/ranks response. */
export function snapshotOf(ranks) {
  const rows = (ranks && ranks.rows ? ranks.rows : []).map((r) => ({
    user_id: r.user_id, rank: r.rank, display_name: r.display_name, total: r.total, is_me: !!r.is_me,
  }));
  const me = ranks && ranks.me ? { user_id: ranks.me.user_id, rank: ranks.me.rank, display_name: ranks.me.display_name, total: ranks.me.total } : null;
  return { rows, me, at: Date.now() };
}

function myRank(snap, meId) {
  if (!snap) return null;
  if (snap.me && (!meId || snap.me.user_id === meId)) return snap.me.rank;
  const row = snap.rows.find((r) => (meId ? r.user_id === meId : r.is_me));
  return row ? row.rank : null;
}

/**
 * Pure diff of two snapshots ({ rows: [{ user_id, rank, display_name }], me }).
 * Returns { oldRank, newRank, passed } or null when there is nothing to celebrate:
 *  - no previous snapshot, or I had no rank before / have none now → null;
 *  - passed = users strictly above me before and strictly below me now, present in both snapshots
 *    (ordered by their new rank); a better rank with nobody named (e.g. outside the Global top 5) still
 *    returns an event with passed = [].
 */
export function diffOvertakes(prev, next, meId = null) {
  if (!prev || !next) return null;
  const oldRank = myRank(prev, meId);
  const newRank = myRank(next, meId);
  if (oldRank == null || newRank == null) return null;
  const me = meId || (next.me && next.me.user_id) || ((next.rows.find((r) => r.is_me) || {}).user_id);
  const before = new Map(prev.rows.map((r) => [r.user_id, r]));
  const passed = next.rows
    .filter((r) => r.user_id !== me && before.has(r.user_id))
    .filter((r) => before.get(r.user_id).rank < oldRank && r.rank > newRank)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.display_name);
  if (!passed.length && !(newRank < oldRank)) return null;
  return { oldRank, newRank, passed };
}

export function lastRanksSnapshot(key) { return idb.get(`lastRanks:${key}`); }
export function saveRanksSnapshot(key, ranksOrSnapshot) {
  const snap = ranksOrSnapshot && ranksOrSnapshot.at ? ranksOrSnapshot : snapshotOf(ranksOrSnapshot);
  return idb.set(`lastRanks:${key}`, snap);
}

/** Fetch, diff and store; resolves to the list of overtake events (empty when offline or nothing changed). */
export async function checkOvertakes({ date } = {}) {
  const s = store.get();
  const me = s.session.me;
  // the active date: scores are keyed by the round's date, so a grace round finished after midnight moves
  // yesterday's board (today.date), not today's (today.todayDate)
  const day = date || s.today.date || s.today.todayDate;
  if (!day) return [];
  const scopes = [{ scope: 'global', groupId: null, groupName: 'Global' }];
  for (const g of (me && me.groups) || []) scopes.push({ scope: g.kind, groupId: g.group_id, groupName: g.name });

  const results = await Promise.allSettled(scopes.map((sc) =>
    api.getRanks({ scope: sc.scope, group_id: sc.groupId || undefined, period: 'day', date: day })));

  const events = [];
  for (let i = 0; i < scopes.length; i++) {
    const res = results[i];
    if (res.status !== 'fulfilled') continue;
    const sc = scopes[i];
    const key = ranksKey({ scope: sc.scope, groupId: sc.groupId, date: day });
    const prev = await lastRanksSnapshot(key);
    const next = snapshotOf(res.value);
    const meId = (me && me.user_id) || (next.me && next.me.user_id) || null;
    const diff = diffOvertakes(prev, next, meId);
    await saveRanksSnapshot(key, next);
    if (diff) events.push({ scope: sc.scope, groupId: sc.groupId, groupName: (res.value.group && res.value.group.name) || sc.groupName, ...diff });
  }
  return events;
}

/** "↑ You passed Ana Ribeiro · now #2 in MRC LMB" / "↑ Now #1,250 globally". */
export function formatOvertake(ev) {
  const where = ev.scope === 'global' ? 'globally' : `in ${ev.groupName}`;
  const rank = `#${fmtPts(ev.newRank)}`;
  if (!ev.passed.length) return `↑ Now ${rank} ${where}`;
  const who = ev.passed.length === 1 ? ev.passed[0]
    : ev.passed.length === 2 ? `${ev.passed[0]} and ${ev.passed[1]}`
      : `${ev.passed[0]} and ${ev.passed.length - 1} others`;
  return `↑ You passed ${who} · now ${rank} ${where}`;
}

/** Pick the most interesting event: named passes in a group first, then the largest jump. */
export function pickOvertake(events) {
  if (!events || !events.length) return null;
  return [...events].sort((a, b) =>
    (b.passed.length > 0) - (a.passed.length > 0)
    || (a.scope === 'global') - (b.scope === 'global')
    || (b.oldRank - b.newRank) - (a.oldRank - a.newRank))[0];
}

/** Toast + celebrate haptic for the best event (call after a round finishes and on the summary). */
export function announceOvertakes(events) {
  const ev = pickOvertake(events);
  if (!ev) return null;
  showToast(formatOvertake(ev), { kind: 'accent', duration: 3600 });
  haptic('celebrate');
  return ev;
}
