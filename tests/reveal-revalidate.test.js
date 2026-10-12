// game.loadReveal (v1.3): reveals keep being refreshed in place on the Worker (reveal_updated: structured trivia, EM
// reveal text), so a reveal served from the device is compared with the Worker's once per session in the background.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundState, roundPublic } from './fixtures.js';

const game = await import('../js/game.js');
const { store, initialState } = await import('../js/store.js');
const idb = await import('../js/idb.js');

const TODAY = '2026-10-03';
const R = [1, 2, 3, 4, 5].map((i) => roundPublic(i, { round_id: `V${'q'.repeat(14)}${i}` }));
const done = roundState({ round_index: 1, round_id: R[0].round_id, stage: 'done', type_result: 'correct', method_correct: true });
let routes = {};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const key = `${init.method || 'GET'} ${u.pathname}`;
  calls.push(key);
  const hnd = routes[key];
  if (!hnd) return new Response(JSON.stringify({ error: { code: 'not_found', message: key } }), { status: 404 });
  const out = await hnd();
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('a reveal from the device shows at once, then the Worker\'s refreshed copy replaces it (once per session)', async () => {
  store.set(initialState());
  for (const k of await idb.keys('')) if (k !== 'deviceId') await idb.del(k);
  routes = {
    'GET /v1/today': () => ({ date: TODAY, day_number: 33, now: `${TODAY}T12:00:00Z`, next_rollover_at: '2026-10-04T00:00:00Z', has_rounds: true, grace: null }),
    [`GET /v1/day/${TODAY}`]: () => ({ date: TODAY, day_number: 33, rounds: R }),
    [`GET /v1/day/${TODAY}/progress`]: () => ({ date: TODAY, day_number: 33, rounds: [done, null, null, null, null], total: done.score, rounds_done: 1, streak: 1 }),
  };
  await game.loadToday({ force: true });
  const id = R[0].round_id;
  const cached = { round_id: id, trivia: { facts: [{ text: 'v1.2 fact', doi: '10.1/x', citation: 'A et al. 2020, J' }] } };
  const fresh = { round_id: id, trivia: { facts: [{ text: 'v1.3 fact', doi: '10.1/x', citation: 'A et al. 2020, J', category: 'function' }] } };
  await idb.set(`reveal:v1.2:${id}`, cached);
  let answer = () => { throw new TypeError('Failed to fetch'); }; // offline first
  routes[`GET /v1/round/${id}/reveal`] = () => answer();

  // offline: the device copy, and nothing replaces it
  let r = await game.loadReveal(1);
  assert.deepEqual(r.resp, cached);
  await tick(20);
  assert.deepEqual(store.get().reveals[id], cached);

  // online, next load: the device copy at once, the refreshed reveal a moment later (screen and device)
  store.set({ ...store.get(), reveals: {} });
  answer = () => fresh;
  calls.length = 0;
  r = await game.loadReveal(1);
  assert.deepEqual(r.resp, cached, 'no wait for the network');
  await tick(20);
  assert.ok(calls.includes(`GET /v1/round/${id}/reveal`));
  assert.deepEqual(store.get().reveals[id], fresh);
  assert.deepEqual(await idb.get(`reveal:v1.2:${id}`), fresh);

  // the same session again: no second request
  store.set({ ...store.get(), reveals: {} });
  calls.length = 0;
  r = await game.loadReveal(1);
  assert.deepEqual(r.resp, fresh);
  await tick(20);
  assert.ok(!calls.includes(`GET /v1/round/${id}/reveal`));
  store.set(initialState());
});
