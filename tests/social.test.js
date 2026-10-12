// W2 "social" pure logic: Ranks helpers (js/screens/ranks.js), Settings validation and per-player cache keys
// (js/screens/settings.js), and the static data credits (js/credits.js) against the dataset files.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appRoot } from './_importmap.js';

const rk = await import('../js/screens/ranks.js');
const st = await import('../js/screens/settings.js');
const { CREDITS, SOFTWARE_CREDITS } = await import('../js/credits.js');

const row = (user_id, rank, total, extra = {}) => ({
  rank, user_id, display_name: user_id.toUpperCase(), initials: 'XX', affiliation: null, total, streak: 0, strip: null, is_me: false, ...extra,
});
const snapOf = (rows, me = null) => ({
  rows: rows.map(({ user_id, rank, display_name, total, is_me }) => ({ user_id, rank, display_name, total, is_me })), me, at: 1,
});

test('parseStrip: scoring.md glyphs → per-round clues, wrong guesses, outcome, method', () => {
  const lines = rk.parseStrip('1 □□ ✓ M\n2 ■□ ✕✓ ·\n4 ■■ ✕✕✕ M\n');
  assert.deepEqual(lines.map((l) => [l.round, l.used, l.wrong, l.correct, l.method, l.outcome]), [
    [1, 0, 0, true, true, 'named'],
    [2, 1, 1, true, false, 'met'],
    [4, 2, 3, false, true, 'missed'],
  ]);
  assert.deepEqual(rk.parseStrip(null), []);
  assert.deepEqual(rk.parseStrip(''), []);
});

test("bucketBars: widths relative to the largest bucket, rounded percentages, the player's bucket", () => {
  const bars = rk.bucketBars({ 0: 6, 1: 3, 2: 0, 3: 0, 4: 0, missed: 3 }, '1');
  assert.deepEqual(bars.map((b) => b.key), ['0', '1', '2', '3', '4', 'missed']);
  assert.deepEqual(bars.map((b) => b.pct), [50, 25, 0, 0, 0, 25]);
  assert.deepEqual(bars.map((b) => b.width), [1, 0.5, 0, 0, 0, 0.5]);
  assert.deepEqual(bars.filter((b) => b.you).map((b) => b.key), ['1']);
  assert.equal(rk.bucketBars(null, null), null, 'locked round (buckets null)');
  assert.ok(rk.bucketBars({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, missed: 0 }, null).every((b) => b.width === 0 && b.pct === 0));
});

test('boardOf: Global pins the own row only when it is outside the listed rows', () => {
  const me = row('me', 9, 100, { is_me: true });
  const top = [row('a', 1, 900), row('b', 2, 800)];
  assert.deepEqual(rk.boardOf({ rows: top, me }).pinned, me);
  assert.equal(rk.boardOf({ rows: [...top, me], me }).pinned, null);
  assert.equal(rk.boardOf({ rows: top, me: null }).pinned, null);
});

test('beforeBoard + overtakeOf: last-seen order, current details, passed players and new arrivals', () => {
  const meNow = row('me', 1, 900, { is_me: true });
  const now = { scope: 'lab', rows: [meNow, row('a', 2, 800), row('b', 3, 700)], me: meNow };
  const seen = snapOf([row('a', 1, 800), row('b', 2, 700), row('me', 3, 300, { is_me: true })],
    { user_id: 'me', rank: 3, display_name: 'ME', total: 300 });
  const before = rk.beforeBoard(seen, now, 'me');
  assert.deepEqual(before.rows.map((r) => [r.user_id, r.rank, r.total]), [['a', 1, 800], ['b', 2, 700], ['me', 3, 300]]);
  const after = rk.boardOf(now);
  assert.notEqual(rk.boardSignature(before), rk.boardSignature(after));
  const ev = rk.overtakeOf(before, after, 'me');
  assert.deepEqual(ev, { oldRank: 3, newRank: 1, passed: ['A', 'B'] });
  assert.equal(rk.overtakeNote(ev), '↑ Passed A and B');
  assert.equal(rk.overtakeNote({ oldRank: 40, newRank: 12, passed: [] }), '↑ Up 28 places');
  assert.equal(rk.overtakeNote({ passed: ['A', 'B', 'C'] }), '↑ Passed A and 2 others');
  assert.equal(rk.overtakeOf(after, after, 'me'), null, 'nothing changed');

  // not on the board when last seen: starts at the bottom (Global: the pinned slot) unranked, then glides up
  const fresh = rk.beforeBoard(snapOf([row('a', 1, 800), row('b', 2, 700)]), now, 'me');
  assert.deepEqual(fresh.rows.map((r) => [r.user_id, r.rank, r.total]), [['a', 1, 800], ['b', 2, 700], ['me', null, 0]]);
  assert.deepEqual(rk.overtakeOf(fresh, after, 'me').passed, ['A', 'B']);
  const gNow = { scope: 'global', rows: [row('a', 1, 800)], me: row('me', 7, 50, { is_me: true }) };
  const g = rk.beforeBoard(snapOf([row('a', 1, 800)]), gNow, 'me');
  assert.equal(g.pinned.user_id, 'me');
  assert.equal(rk.overtakeOf(g, rk.boardOf(gNow), 'me'), null, 'a newcomer who passed nobody is not celebrated');
  assert.equal(rk.beforeBoard(null, now, 'me'), null);
});

test('seenKey / isoMonday: day boards by date, week boards by ISO week, all-time once', () => {
  assert.equal(rk.isoMonday('2026-10-03'), '2026-09-28'); // Saturday
  assert.equal(rk.isoMonday('2026-09-28'), '2026-09-28'); // Monday
  assert.equal(rk.isoMonday('2026-10-04'), '2026-09-28'); // Sunday
  assert.equal(rk.seenKey({ period: 'day', scope: 'lab', groupId: 'g1', date: '2026-10-03' }), 'seen:lab:g1:2026-10-03');
  assert.equal(rk.seenKey({ period: 'week', scope: 'global', groupId: null, date: '2026-10-01' }), 'seen:global:-:2026-09-28:week');
  assert.equal(rk.seenKey({ period: 'all', scope: 'friends', groupId: 'f', date: '2026-10-01' }), 'seen:friends:f:all:all');
});

test('scopeModel / defaultScope: Lab chip named after a single lab; default friends → lab → global', () => {
  const lab = { group_id: 'l1', kind: 'lab', name: 'MRC LMB' };
  const lab2 = { group_id: 'l2', kind: 'lab', name: 'Other lab' };
  const fr = { group_id: 'f1', kind: 'friends', name: 'Journal club' };
  assert.deepEqual(rk.scopeModel([lab]).chips.map((c) => c.label), ['Friends', 'MRC LMB', 'Global']);
  assert.deepEqual(rk.scopeModel([lab, lab2]).chips.map((c) => c.label), ['Friends', 'Lab', 'Global']);
  assert.equal(rk.defaultScope([lab, fr]), 'friends');
  assert.equal(rk.defaultScope([lab]), 'lab');
  assert.equal(rk.defaultScope([]), 'global');
});

test('Settings validation: names 1–24 chars without control characters; codes normalised', () => {
  assert.deepEqual(st.validName('  Ana  '), { ok: true, value: 'Ana', error: null });
  assert.equal(st.validName('   ').ok, false);
  assert.equal(st.validName('x'.repeat(25)).ok, false);
  assert.equal(st.validName('a\u0007b').ok, false);
  assert.equal(st.normaliseCode('k7p 2qx'), 'K7P2QX');
  assert.equal(st.normaliseCode('abcd-2345'), 'ABCD2345');
  assert.ok(st.isJoinCode('K7P2QX'));
  assert.ok(!st.isJoinCode('K7P2Q0'), 'no 0/O/1/I');
  assert.ok(st.isTransferCode('ABCD2345'));
  assert.ok(!st.isTransferCode('ABCD234'));
});

test('a device transfer clears every per-player key, never the device id or settings', () => {
  const cleared = (k) => st.USER_KEY_PREFIXES.some((p) => k.startsWith(p));
  for (const k of ['cache:me', 'cache:today', 'cache:library', 'lastRanks:seen:lab:g:2026-10-03', 'graceSkip:2026-10-02',
    'summary:pbBase:2026-10-03', 'summary:pb:2026-10-03', 'report:abc', 'library:atlasSeen', 'library:reviewDone']) assert.ok(cleared(k), k);
  for (const k of ['deviceId', 'settings', 'onboarded', 'ranks:view', 'library:thumb:/v1/asset/x.webp']) assert.ok(!cleared(k), k);
});

test('credits: one entry per credited dataset with attribution, licence and a DOI link', () => {
  assert.ok(CREDITS.length > 0);
  for (const c of CREDITS) {
    for (const k of ['dataset_id', 'name', 'release', 'species', 'attribution', 'licence', 'citation', 'url']) assert.ok(c[k], `${c.dataset_id}.${k}`);
    assert.match(c.url, /^https:\/\/doi\.org\/10\./);
    assert.ok(c.attribution.length <= 300);
  }
  assert.equal(new Set(CREDITS.map((c) => c.dataset_id)).size, CREDITS.length);
  for (const s of SOFTWARE_CREDITS) assert.match(s.url, /^https:\/\//);
});

/** Top-level scalar from a dataset YAML file: plain, or single/double-quoted (possibly folded over lines). */
function yamlScalar(text, key) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return null;
  let v = lines[i].slice(key.length + 1).trim();
  const q = v[0];
  if (q !== "'" && q !== '"') return v.replace(/\s+#.*$/, '');
  const closed = (s) => (q === "'" ? /(^|[^'])('')*'$/.test(s) && s.length > 1 : /(^|[^\\])"$/.test(s) && s.length > 1);
  for (let j = i + 1; !closed(v) && j < lines.length; j++) v += ` ${lines[j].trim()}`;
  v = v.slice(1, -1).split(/\s+/).join(' ');
  return q === "'" ? v.replace(/''/g, "'") : JSON.parse(`"${v}"`);
}

// The dataset files live in the private content repo; when it is checked out next to the app, js/credits.js
// must match them (it is generated from them). Regenerate js/credits.js whenever a dataset file changes.
const DATASETS = path.join(appRoot, '..', 'neuroguesser-content', 'content', 'datasets');
test('credits match neuroguesser-content/content/datasets/*.yaml',
  { skip: existsSync(DATASETS) ? false : 'content repo not checked out next to the app' }, () => {
    const byId = new Map(CREDITS.map((c) => [c.dataset_id, c]));
    for (const f of readdirSync(DATASETS).filter((n) => n.endsWith('.yaml'))) {
      const text = readFileSync(path.join(DATASETS, f), 'utf8');
      const id = yamlScalar(text, 'dataset_id');
      const blocked = yamlScalar(text, 'blocked');
      const c = byId.get(id);
      if (blocked && !['false', 'null', '~'].includes(blocked)) { assert.ok(!c, `${id} is blocked but credited`); continue; }
      if (!c) continue; // not enabled in pool.yaml
      for (const [field, key] of [['name', 'name'], ['release', 'release'], ['licence', 'licence'], ['species', 'species_binomial'], ['attribution', 'attribution']]) {
        const v = yamlScalar(text, key);
        if (v !== null && !/^[>|]/.test(v)) assert.equal(c[field], v, `${id}.${field} is stale: regenerate js/credits.js`);
      }
    }
  });
