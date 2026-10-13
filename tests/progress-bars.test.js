// XP / level and atlas collection bars (ARCHITECTURE.md §3.4 items 2-3): js/ui/xp-bar.js (summary + profile card, the
// desktop header's level chip) and js/ui/atlas-bar.js (the reveal's species bar and its +1), on the minimal DOM.
// Node has no document, so motionAllowed() is false here: every animation lands on its end state at once, as with
// reduced motion — the words and numbers are what these tests check.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundState, roundPublic } from './fixtures.js';
import { createContainer, flush } from './_dom.js';

const { h, render } = await import('preact');
const { store, initialState } = await import('../js/store.js');
const xb = await import('../js/ui/xp-bar.js');
const ab = await import('../js/ui/atlas-bar.js');
const { HeaderBar } = await import('../js/ui/top-header.js');
const { SummaryView } = await import('../js/screens/summary.js');

const findAll = (node, pred, out = []) => {
  if (node.nodeType === 1 && pred(node)) out.push(node);
  for (const c of node.childNodes || []) findAll(c, pred, out);
  return out;
};
const byClass = (root, cls) => findAll(root, (n) => (n.getAttribute('class') || '').split(' ').includes(cls));
const ATLAS = [
  { species_common: 'Fly', seen: 23, total: 56 },
  { species_common: 'Mouse', seen: 4, total: 11 },
];
const ME = { user_id: 'u1', display_name: 'Player-AB12', initials: 'P', streak: 2, best_streak: 2, due_count: 0, groups: [], xp_total: 8230, atlas: ATLAS };
const withAtlas = (sp, seen) => ({ ...ME, atlas: ATLAS.map((a) => (a.species_common === sp ? { ...a, seen } : a)) });

// ------------------------------------------------------------------------------------------------------------ XP

test('xpDay: XP before today\'s points, now, gained, levels reached', () => {
  assert.deepEqual(xb.xpDay(8230, 4200), { start: 4030, end: 8230, gained: 4200, crossed: [4] });
  assert.deepEqual(xb.xpDay(8230, 0), { start: 8230, end: 8230, gained: 0, crossed: [] });
  assert.deepEqual(xb.xpDay(100, 4200), { start: 0, end: 100, gained: 100, crossed: [] }, 'never below 0 XP');
  assert.deepEqual(xb.xpDay(null, null), { start: 0, end: 0, gained: 0, crossed: [] });
  assert.equal(xb.levelChipLabel(8230), 'Level 4, 2,220 XP to level 5');
  assert.equal(xb.levelChipLabel(0), 'Level 1, 1,500 XP to level 2');
});

test('XpCard (summary): level badge, "+N XP today", XP to the next level, the bar; "↑ Level up" when today crossed one', async () => {
  const root = createContainer();
  render(h(xb.XpCard, { xp: 8230, dayTotal: 4200 }), root);
  await flush();
  assert.equal(byClass(root, 'xp-badge')[0].textContent, '4');
  assert.equal(byClass(root, 'xp-gain')[0].textContent, '+4,200 XP today');
  assert.match(root.textContent, /Level 4↑ Level up/);
  assert.match(root.textContent, /2,220 XP to level 5/);
  const fill = byClass(root, 'xp-meter')[0].firstChild;
  assert.equal(fill.style.transform, `scaleX(${(1250 / 3470).toFixed(4)})`);
  const card = byClass(root, 'xp-card')[0];
  assert.equal(card.getAttribute('aria-label'), 'Level 4, level up today. 4,200 XP today, 8,230 XP in total. Level 4, 2,220 XP to level 5.');
  // no level crossed today: no "Level up" word
  render(h(xb.XpCard, { xp: 8230, dayTotal: 1000 }), root);
  await flush();
  assert.ok(!root.textContent.includes('Level up'));
  render(null, root);
});

test('XpCard (fresh, reduced motion as under node): the end state from the first frame; the level-up haptic waits for /v1/me and a sheet, then fires once', async () => {
  // with motion the card first shows the day before its points, then counts them in (e2e/progress-bars.spec.js);
  // without motion there is no "+0 XP" beat: the words and the bar are final at once, only the haptic keeps its moment
  const seen = [];
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Android Chrome', vibrate: (p) => { seen.push(p); return true; } }, configurable: true });
  try {
    store.set(initialState());
    const root = createContainer();
    const props = { xp: 8230, dayTotal: 4200, fresh: true, delay: 0 };
    render(h(xb.XpCard, { ...props, ready: false }), root);
    await flush();
    assert.equal(byClass(root, 'xp-gain')[0].textContent, '+4,200 XP today', 'no "+0 XP today" beat without motion');
    assert.equal(byClass(root, 'xp-badge')[0].textContent, '4');
    assert.ok(root.textContent.includes('↑ Level up'));
    assert.equal(byClass(root, 'xp-meter')[0].firstChild.style.transform, `scaleX(${(1250 / 3470).toFixed(4)})`);
    assert.deepEqual(seen, [], 'no haptic while /v1/me loads');
    render(h(xb.XpCard, { ...props, ready: true, paused: true }), root);
    await flush(1000);
    assert.deepEqual(seen, [], 'a sheet covers the summary: still waiting');
    render(h(xb.XpCard, { ...props, ready: true, paused: false }), root);
    await flush(300);
    assert.deepEqual(seen, [], 'the haptic keeps the moment the run would end (delay + 900 ms)');
    await flush(800);
    assert.deepEqual(seen, [[10, 40, 10, 40, 30]], 'haptic celebrate once (haptics do not depend on motion)');
    render(h(xb.XpCard, { ...props, ready: true, paused: true }), root);
    render(h(xb.XpCard, { ...props, ready: true, paused: false }), root);
    await flush(1100);
    assert.equal(seen.length, 1, 'once per mount');
    // no level crossed today: no haptic
    render(null, root);
    render(h(xb.XpCard, { ...props, dayTotal: 1000, ready: true }), root);
    await flush(1100);
    assert.equal(seen.length, 1);
    render(null, root);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  }
});

test('XpCard (profile): level and total over the bar, no badge', async () => {
  const root = createContainer();
  render(h(xb.XpCard, { xp: 8230, variant: 'profile' }), root);
  await flush();
  assert.equal(byClass(root, 'xp-badge').length, 0);
  assert.equal(root.textContent, 'Level 48,230 XP2,220 XP to level 5');
  assert.equal(byClass(root, 'xp-card')[0].getAttribute('aria-label'), 'Level 4, 2,220 XP to level 5, 8,230 XP in total');
  render(null, root);
});

test('HeaderBar: the Profile link carries the level chip (and says the level) once /v1/me has xp_total', async () => {
  const root = createContainer();
  render(h(HeaderBar, { active: 'today', dueCount: 0, xp: 8230 }), root);
  await flush();
  const profile = findAll(root, (n) => n.getAttribute('href') === '#/settings')[0];
  assert.equal(profile.textContent, 'ProfileLv 4');
  assert.equal(profile.getAttribute('aria-label'), 'Profile, Level 4, 2,220 XP to level 5');
  const chip = byClass(profile, 'lvl-chip')[0];
  assert.equal(chip.getAttribute('aria-hidden'), 'true');
  assert.equal(byClass(chip, 'lvl-chip-meter')[0].firstChild.style.transform, `scaleX(${(1250 / 3470).toFixed(3)})`);
  render(h(HeaderBar, { active: 'today', dueCount: 0, xp: null }), root);
  await flush();
  const plain = findAll(root, (n) => n.getAttribute('href') === '#/settings')[0];
  assert.equal(plain.textContent, 'Profile');
  assert.equal(plain.getAttribute('aria-label'), 'Profile');
  render(null, root);
});

test('SummaryView: the XP card sits after the streak, only with xp_total', async () => {
  const progress = [1, 2, 3, 4, 5].map((i) => roundState({ round_index: i, stage: 'done', type_result: 'correct', method_correct: i % 2 === 1 }));
  const rounds = progress.map((st, i) => ({ round_id: st.round_id, round_index: i + 1 }));
  const total = progress.reduce((s, st) => s + st.score, 0);
  const root = createContainer();
  const props = { dayNumber: 33, date: '2026-10-03', total, progress, rounds, streak: 3, nextRolloverAt: null, onShare() {}, onOpenRound() {} };
  render(h(SummaryView, { ...props, xp: 20000 }), root);
  await flush();
  const text = root.textContent;
  assert.ok(text.indexOf('3-day streak') < text.indexOf(`+${total.toLocaleString('en-US')} XP today`), 'streak, then XP');
  assert.ok(text.indexOf('XP today') < text.indexOf('Share result'));
  assert.equal(byClass(root, 'summary-xp').length, 1);
  render(h(SummaryView, { ...props, xp: null }), root);
  await flush();
  assert.equal(byClass(root, 'summary-xp').length, 0, 'an older Worker (no xp_total): no card');
  render(null, root);
});

// --------------------------------------------------------------------------------------------------------- atlas

test('atlasRow / atlasSnapshot: the species row of me.atlas, clamped; nothing without data', () => {
  assert.deepEqual(ab.atlasRow(ME, 'Fly'), { seen: 23, total: 56 });
  assert.deepEqual(ab.atlasRow({ atlas: [{ species_common: 'Fly', seen: 99, total: 56 }] }, 'Fly'), { seen: 56, total: 56 });
  assert.equal(ab.atlasRow(ME, 'Human'), null);
  assert.equal(ab.atlasRow({ atlas: [{ species_common: 'Fly', seen: 0, total: 0 }] }, 'Fly'), null);
  assert.equal(ab.atlasRow({ display_name: 'old Worker' }, 'Fly'), null);
  assert.deepEqual(ab.atlasSnapshot(ME), { Fly: 23, Mouse: 4 });
  assert.equal(ab.atlasSnapshot(null), null);
  assert.equal(ab.atlasLabel('Fly', { seen: 24, total: 56 }, 1), 'Fly atlas: 24 of 56 cell types collected, 1 new from this round');
});

test('observeAtlas: rounds done at first sight are a baseline; a round finishing later records me.atlas from just before', () => {
  ab._resetAtlasMemory();
  store.set(initialState());
  store.update('session', { me: ME });
  const R = [1, 2, 3, 4, 5].map((i) => roundPublic(i));
  const done = (i) => roundState({ round_index: i, stage: 'done', type_result: 'correct', method_correct: true });
  // a resume: round 1 already done → never celebrated
  store.update('today', { date: '2026-10-03', rounds: R, progress: [done(1), null, null, null, null] });
  store.update('session', { me: withAtlas('Fly', 24) });
  assert.equal(ab.atlasGrowth(R[0].round_id, 'Fly', store.get().session.me).grew, false);
  // round 2 finishes now; /v1/me then reports one more fly type
  store.update('session', { me: withAtlas('Fly', 24) });
  store.update('today', { progress: [done(1), done(2), null, null, null] });
  assert.equal(ab.atlasGrowth(R[1].round_id, 'Fly', store.get().session.me).grew, false, 'before /v1/me answers: no +1 yet');
  store.update('session', { me: withAtlas('Fly', 25) });
  assert.deepEqual(ab.atlasGrowth(R[1].round_id, 'Fly', store.get().session.me), { row: { seen: 25, total: 56 }, from: 24, grew: true });
  // round 3: a fly type seen before → no +1 (and round 2's +1 never leaks into it)
  store.update('today', { progress: [done(1), done(2), done(3), null, null] });
  store.update('session', { me: withAtlas('Fly', 25) });
  assert.equal(ab.atlasGrowth(R[2].round_id, 'Fly', store.get().session.me).grew, false);
  // a new day: its first sight is a baseline again
  store.update('today', { date: '2026-10-04', rounds: R.map((r) => ({ ...r, round_id: `${r.round_id.slice(0, 15)}Z` })), progress: [done(1), null, null, null, null] });
  assert.equal(ab.atlasGrowth(`${R[0].round_id.slice(0, 15)}Z`, 'Fly', withAtlas('Fly', 30)).grew, false);
  store.set(initialState());
});

test('AtlasBar: "Fly atlas 25 / 56" with "New type" on the fresh reveal of a new type; the plain count otherwise', async () => {
  ab._resetAtlasMemory();
  store.set(initialState());
  store.update('session', { me: withAtlas('Fly', 24) });
  ab.noteRoundFinished('roundNEW', store.get().session.me);
  store.update('session', { me: withAtlas('Fly', 25) });
  const root = createContainer();
  render(h(ab.AtlasBar, { species: 'Fly', roundId: 'roundNEW', fresh: true }), root);
  await flush();
  const bar = byClass(root, 'atlas-bar')[0];
  assert.equal(bar.getAttribute('role'), 'img');
  assert.equal(bar.getAttribute('aria-label'), 'Fly atlas: 25 of 56 cell types collected, 1 new from this round');
  assert.equal(byClass(root, 'atlas-sp')[0].textContent, 'Fly atlas');
  assert.equal(byClass(root, 'atlas-new')[0].textContent, 'New type');
  assert.equal(byClass(root, 'atlas-num')[0].textContent, '25 / 56');
  assert.equal(byClass(root, 'atlas-num')[0].getAttribute('class'), 'atlas-num is-up');
  assert.equal(byClass(root, 'meter')[0].firstChild.style.transform, `scaleX(${25 / 56})`);
  // revisit (acknowledged reveal): the count, no "new"
  render(h(ab.AtlasBar, { species: 'Fly', roundId: 'roundNEW', fresh: false }), root);
  await flush();
  assert.equal(byClass(root, 'atlas-new').length, 0);
  assert.equal(byClass(root, 'atlas-num')[0].textContent, '25 / 56');
  // a type seen before (no record of growth): the count, no "new"
  render(h(ab.AtlasBar, { species: 'Mouse', roundId: 'roundOLD', fresh: true }), root);
  await flush();
  assert.equal(byClass(root, 'atlas-new').length, 0);
  assert.equal(root.textContent, 'Mouse atlas4 / 11');
  // no atlas data (older Worker, /v1/me not loaded): nothing
  store.update('session', { me: { ...ME, atlas: undefined } });
  render(h(ab.AtlasBar, { species: 'Fly', roundId: 'roundNEW', fresh: true }), root);
  await flush();
  assert.equal(root.childNodes.length, 0);
  render(null, root);
  store.set(initialState());
});

test('AtlasBar: when /v1/me answers after the reveal has mounted, the bar grows to the new count there', async () => {
  ab._resetAtlasMemory();
  store.set(initialState());
  store.update('session', { me: withAtlas('Mouse', 4) });
  ab.noteRoundFinished('roundLATE', store.get().session.me);
  const root = createContainer();
  render(h(ab.AtlasBar, { species: 'Mouse', roundId: 'roundLATE', fresh: true }), root);
  await flush();
  assert.equal(root.textContent, 'Mouse atlas4 / 11');
  store.update('session', { me: withAtlas('Mouse', 5) });
  await flush();
  assert.equal(root.textContent, 'Mouse atlasNew type5 / 11');
  render(null, root);
  store.set(initialState());
});
