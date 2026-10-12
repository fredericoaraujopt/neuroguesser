// game.js actions and loading against a fake Worker (fetch mock): state written from responses and from
// 409 bodies, never rejecting, the per-round busy guard, stale /progress reads racing newer actions,
// grace, offline fallback and revealAck persistence.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundState, roundPublic } from './fixtures.js';

const game = await import('../js/game.js');
const { store, initialState } = await import('../js/store.js');
const idb = await import('../js/idb.js');
const { PRODUCTION_API } = await import('../config.js');

const TODAY = '2026-10-03';
const YDAY = '2026-10-02';
const rounds = (date, dayNumber) => [1, 2, 3, 4, 5].map((i) => roundPublic(i, { date, day_number: dayNumber, round_id: `${date === TODAY ? 'T' : 'Y'}${'x'.repeat(14)}${i}` }));

let routes = {};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const key = `${init.method || 'GET'} ${u.pathname}`;
  calls.push(key);
  const h = routes[key] || routes[`* ${u.pathname}`];
  if (!h) return new Response(JSON.stringify({ error: { code: 'not_found', message: key } }), { status: 404 });
  const out = await h(init.body ? JSON.parse(init.body) : undefined);
  if (out instanceof Response) return out;
  return new Response(JSON.stringify(out.body ?? out), { status: out.status || 200, headers: { 'Content-Type': 'application/json' } });
};
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function todayResp(over = {}) {
  return { date: TODAY, day_number: 33, now: `${TODAY}T12:00:00Z`, next_rollover_at: '2026-10-04T00:00:00Z', has_rounds: true, grace: null, ...over };
}
function progressResp(date, list, streak = 4) {
  const done = list.filter((s) => s && s.stage === 'done');
  return { date, day_number: date === TODAY ? 33 : 32, rounds: list, total: done.reduce((a, s) => a + s.score, 0), rounds_done: done.length, streak };
}
const ME = { user_id: 'u1', display_name: 'Player-AB12', initials: 'P', affiliation: null, created_at: '2026-09-01T00:00:00Z', streak: 4, best_streak: 4, due_count: 0, groups: [] };

function baseRoutes(progressList = [null, null, null, null, null]) {
  const R = rounds(TODAY, 33);
  return {
    'GET /v1/today': () => todayResp(),
    [`GET /v1/day/${TODAY}`]: () => ({ date: TODAY, day_number: 33, rounds: R }),
    [`GET /v1/day/${TODAY}/progress`]: () => progressResp(TODAY, progressList),
    'GET /v1/me': () => ME,
  };
}
async function reset(r = baseRoutes()) {
  store.set(initialState());
  routes = r;
  calls.length = 0;
  for (const k of await idb.keys('')) if (k !== 'deviceId') await idb.del(k);
}

test('loadToday: today + day + progress → ready; revealAck first sight; cached for offline', async () => {
  await reset(baseRoutes([roundState({ round_index: 1, stage: 'done', type_result: 'correct', method_correct: true }), null, null, null, null]));
  const r = await game.loadToday({ force: true });
  assert.equal(r.ok, true);
  const t = store.get().today;
  assert.equal(t.status, 'ready');
  assert.equal(t.date, TODAY);
  assert.equal(t.dayNumber, 33);
  assert.equal(t.rounds.length, 5);
  assert.equal(t.progress[0].stage, 'done');
  assert.equal(t.total, 1200);
  assert.equal(t.streak, 4);
  assert.deepEqual(t.revealAck, [true, false, false, false, false], 'a round already done at first sight counts as seen');
  assert.deepEqual(await idb.get(`revealAck:${TODAY}`), [true, false, false, false, false]);
  assert.ok(await idb.get(`cache:day:${TODAY}`));
  assert.equal((await idb.get(`cache:progress:${TODAY}`)).rounds[0].stage, 'done');
  assert.deepEqual(game.currentView(t), { kind: 'round', index: 2 });
});

test('actions write resp.state, resolve { ok, resp, err }, and never reject', async () => {
  await reset();
  await game.loadToday({ force: true });
  const id = store.get().today.rounds[0].round_id;
  const s1 = roundState({ round_index: 1, wrong: ['a'], score: 900 });
  routes[`POST /v1/round/${id}/guess`] = (body) => ({ correct: false, score: 900, wrong_count: 1, state: { ...s1, wrong: [body.option] } });
  const r = await game.guess(1, 'a');
  assert.equal(r.ok, true);
  assert.equal(r.resp.correct, false);
  assert.deepEqual(store.get().today.progress[0].wrong, ['a']);

  // 409 with state: the state is applied and the result says why
  const s2 = roundState({ round_index: 1, wrong: ['a', 'b'], score: 800 });
  routes[`POST /v1/round/${id}/guess`] = () => ({ status: 409, body: { error: { code: 'already_guessed', message: 'x' }, state: s2 } });
  const r2 = await game.guess(1, 'a');
  assert.equal(r2.ok, false);
  assert.equal(r2.err.code, 'already_guessed');
  assert.deepEqual(store.get().today.progress[0].wrong, ['a', 'b']);

  // network failure: resolves with err, state untouched
  routes[`POST /v1/round/${id}/guess`] = () => { throw new TypeError('Failed to fetch'); };
  const r3 = await game.guess(1, 'c');
  assert.equal(r3.ok, false);
  assert.equal(r3.err.isNetwork, true);
  assert.deepEqual(store.get().today.progress[0].wrong, ['a', 'b']);

  // unknown round
  const r4 = await game.guess(9, 'a');
  assert.equal(r4.ok, false);
  assert.equal(r4.err.code, 'not_found');
});

test('one action per round at a time: a second tap while busy is refused without a request', async () => {
  await reset();
  await game.loadToday({ force: true });
  const id = store.get().today.rounds[1].round_id;
  const gate = deferred();
  let n = 0;
  routes[`POST /v1/round/${id}/clue`] = async () => { n++; await gate.p; return { kind: 'context', assets: { volume: `/v1/asset/${'f'.repeat(64)}.glb`, neuron_offset_um: [0, 0, 0] }, eliminated_option: null, score: 900, state: roundState({ round_index: 2, eliminated: [], clues_opened: ['context'], score: 900 }) }; };
  const p1 = game.openClue(2, 'context');
  assert.equal(game.isBusy(2), true);
  const p2 = await game.openClue(2, 'context');
  assert.equal(p2.ok, false);
  assert.equal(p2.err.code, 'busy');
  assert.equal(p2.err.isNetwork, false, 'busy is not an offline signal');
  gate.resolve();
  assert.equal((await p1).ok, true);
  assert.equal(n, 1);
  assert.equal(game.isBusy(2), false);
  // v1.2: the clue costs 100 and rules nothing out — all six options are still pickable
  const t = store.get().today;
  assert.deepEqual(t.progress[1].eliminated, []);
  assert.deepEqual(Object.values(game.optionStates(t.rounds[1], t.progress[1])), ['idle', 'idle', 'idle', 'idle', 'idle', 'idle']);
  assert.equal(game.optionsLeft(t.rounds[1], t.progress[1]), 6);
});

test('chooseMethod(null) skips with {"method": null}; finishing a round refreshes progress, /me and warms the reveal', async () => {
  await reset();
  await game.loadToday({ force: true });
  const id = store.get().today.rounds[0].round_id;
  const done = roundState({ round_index: 1, stage: 'done', type_result: 'correct', method_correct: false, method_pick: null });
  let body = null;
  routes[`POST /v1/round/${id}/method`] = (b) => { body = b; return { correct: false, method_answer: 'sstem', score: 1000, state: done }; };
  routes[`GET /v1/day/${TODAY}/progress`] = () => progressResp(TODAY, [done, null, null, null, null], 5);
  routes[`GET /v1/round/${id}/reveal`] = () => ({ round_id: id, type: { name: 'Kenyon cell' } });
  const r = await game.chooseMethod(1, null);
  assert.equal(r.ok, true);
  assert.deepEqual(body, { method: null });
  await tick(20);
  assert.equal(store.get().today.streak, 5, 'streak re-read from /progress');
  assert.equal(store.get().reveals[id].type.name, 'Kenyon cell');
  assert.ok(calls.includes('GET /v1/me'));
  assert.deepEqual(game.currentView(store.get().today), { kind: 'reveal', index: 1 });
});

test('a stale /progress read never overwrites a newer action state (refresh racing a guess)', async () => {
  await reset();
  await game.loadToday({ force: true });
  const id2 = store.get().today.rounds[1].round_id;
  const gate = deferred();
  routes[`GET /v1/day/${TODAY}/progress`] = async () => { await gate.p; return progressResp(TODAY, [null, null, null, null, null], 9); };
  const refreshing = game.refreshProgress();        // request answered from before the guess below
  const after = roundState({ round_index: 2, wrong: ['c'], score: 900 });
  routes[`POST /v1/round/${id2}/guess`] = () => ({ correct: false, score: 900, wrong_count: 1, state: after });
  await game.guess(2, 'c');
  gate.resolve();
  await refreshing;
  const t = store.get().today;
  assert.deepEqual(t.progress[1].wrong, ['c'], 'the guess survives the older read');
  assert.equal(t.streak, 9, 'fields the action did not write still come from the read');
  assert.deepEqual((await idb.get(`cache:progress:${TODAY}`)).rounds[1].wrong, ['c'], 'offline cache keeps the newer state too');
});

test('a resume reload racing an action keeps the action state', async () => {
  await reset();
  await game.loadToday({ force: true });
  const id3 = store.get().today.rounds[2].round_id;
  const gate = deferred();
  routes[`GET /v1/day/${TODAY}/progress`] = async () => { await gate.p; return progressResp(TODAY, [null, null, null, null, null]); };
  const loading = game.loadToday({ force: true });
  await tick(5);
  routes[`POST /v1/round/${id3}/clue`] = () => ({ kind: 'graph', assets: { asset: `/v1/asset/${'e'.repeat(64)}.json` }, eliminated_option: null, score: 900, state: roundState({ round_index: 3, eliminated: [], clues_opened: ['graph'], score: 900 }) });
  await game.openClue(3, 'graph');
  gate.resolve();
  await loading;
  assert.deepEqual(store.get().today.progress[2].clues_opened, ['graph']);
});

test('grace: yesterday\'s unfinished rounds first; finishing them (graceOver) moves on to today for good', async () => {
  const Y = rounds(YDAY, 32);
  const yState = roundState({ round_index: 3, round_id: Y[2].round_id, wrong: ['a'], score: 900 });
  const grace = { date: YDAY, day_number: 32, until: `${TODAY}T00:30:00Z`, round_indexes: [3] };
  await reset({
    ...baseRoutes(),
    'GET /v1/today': () => todayResp({ grace, now: `${TODAY}T00:10:00Z` }),
    [`GET /v1/day/${YDAY}`]: () => ({ date: YDAY, day_number: 32, rounds: Y }),
    [`GET /v1/day/${YDAY}/progress`]: () => progressResp(YDAY, [null, null, yState, null, null]),
  });
  await game.loadToday({ force: true });
  let t = store.get().today;
  assert.equal(t.graceActive, true);
  assert.equal(t.date, YDAY);
  assert.equal(t.todayDate, TODAY);
  assert.deepEqual(game.currentView(t), { kind: 'round', index: 3 });

  const done = roundState({ round_index: 3, round_id: Y[2].round_id, stage: 'done', type_result: 'correct', wrong: ['a'], method_correct: true });
  routes[`POST /v1/round/${Y[2].round_id}/method`] = () => ({ correct: true, method_answer: 'sstem', score: 1100, state: done });
  routes[`GET /v1/day/${YDAY}/progress`] = () => progressResp(YDAY, [null, null, done, null, null]);
  routes[`GET /v1/round/${Y[2].round_id}/reveal`] = () => ({ round_id: Y[2].round_id });
  await game.chooseMethod(3, 'sstem');
  // even if the server still (wrongly) listed the finished round, acknowledging leaves grace
  await game.ackReveal(3, { advance: false });
  await tick(30);
  t = store.get().today;
  assert.equal(t.date, TODAY);
  assert.equal(t.graceActive, false);
  assert.equal(await idb.get(`graceSkip:${YDAY}`), true);
  assert.deepEqual(await idb.get(`revealAck:${YDAY}`), [false, false, true, false, false]);
});

test('offline: the last day renders read-only from IndexedDB (status offline), nothing cached → error or offline', async () => {
  await reset();
  await game.loadToday({ force: true });
  // a fresh start (new page load) with the network gone
  store.set(initialState());
  routes = {
    'GET /v1/today': () => { throw new TypeError('Failed to fetch'); },
  };
  const r = await game.loadToday({ force: true });
  assert.equal(r.ok, false);
  const t = store.get().today;
  assert.equal(t.status, 'offline');
  assert.equal(t.fromCache, true);
  assert.equal(t.rounds.length, 5);

  await reset({ 'GET /v1/today': () => { throw new TypeError('Failed to fetch'); } });
  await game.loadToday({ force: true });
  assert.equal(store.get().today.status, 'error', 'device online but the Worker unreachable → error + Retry');
});

test('a non-network failure (e.g. 404 withdrawn day) is an error, not offline', async () => {
  await reset({ ...baseRoutes(), [`GET /v1/day/${TODAY}`]: () => ({ status: 404, body: { error: { code: 'not_found', message: 'gone' } } }) });
  await game.loadToday({ force: true });
  assert.equal(store.get().today.status, 'error');
  assert.equal(store.get().today.error.code, 'not_found');
});

test('no day loaded today → empty state with the rollover time', async () => {
  await reset({ 'GET /v1/today': () => todayResp({ day_number: null, has_rounds: false }) });
  await game.loadToday({ force: true });
  const t = store.get().today;
  assert.equal(t.status, 'empty');
  assert.equal(t.nextRolloverAt, '2026-10-04T00:00:00Z');
  assert.deepEqual(game.currentView(t), { kind: 'empty', index: null });
});

test('loadReveal: a reveal cached before v1.2 (no literature facts) is fetched again once; offline it still serves', async () => {
  const done = roundState({ round_index: 1, stage: 'done', type_result: 'correct', method_correct: true });
  await reset(baseRoutes([done, null, null, null, null]));
  await game.loadToday({ force: true });
  const id = store.get().today.rounds[0].round_id;
  const oldCopy = { round_id: id, trivia: { facts: [] } };
  const fresh = { round_id: id, trivia: { facts: [{ text: 'A fact', doi: '10.1/x', citation: 'A et al. 2020, J' }] } };
  await idb.set(`reveal:${id}`, oldCopy);
  routes[`GET /v1/round/${id}/reveal`] = () => fresh;
  const r = await game.loadReveal(1);
  assert.equal(r.ok, true);
  assert.equal(r.resp.trivia.facts.length, 1, 'the pre-v1.2 copy is not kept forever');
  assert.ok(calls.includes(`GET /v1/round/${id}/reveal`));
  await tick(10);
  assert.deepEqual(await idb.get(`reveal:v1.2:${id}`), fresh);
  assert.equal(await idb.get(`reveal:${id}`), undefined, 'the old copy is dropped once replaced');

  // second load in a new session: served from the device, no request
  store.set({ ...store.get(), reveals: {} });
  calls.length = 0;
  assert.equal((await game.loadReveal(1)).resp.trivia.facts.length, 1);
  assert.ok(!calls.includes(`GET /v1/round/${id}/reveal`));

  // offline with only a pre-v1.2 copy: that copy is shown rather than an error
  await idb.del(`reveal:v1.2:${id}`);
  await idb.set(`reveal:${id}`, oldCopy);
  store.set({ ...store.get(), reveals: {} });
  routes[`GET /v1/round/${id}/reveal`] = () => { throw new TypeError('Failed to fetch'); };
  const off = await game.loadReveal(1);
  assert.equal(off.ok, true);
  assert.deepEqual(off.resp, oldCopy);
});
