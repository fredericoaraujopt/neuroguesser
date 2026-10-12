// api.js against contracts/api.md v1.1: every endpoint's method, path, query, body and headers; ApiError
// (status, code, state from 409 bodies); network failures; X-From-Cache; asset helpers (gating header, memo).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../js/api.js');
const { PRODUCTION_API } = await import('../config.js');
const BASE = PRODUCTION_API; // not localhost under node → production base, no debug header

const calls = [];
let responder = () => json(200, { ok: true });
function json(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), method: init.method, headers: { ...(init.headers || {}) }, body: init.body === undefined ? undefined : JSON.parse(init.body), init };
  calls.push(call);
  return responder(call);
};
const last = () => calls[calls.length - 1];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('device id: uuid v4, created once and reused', async () => {
  const a = await api.getDeviceId();
  const b = await api.getDeviceId();
  assert.match(a, UUID_V4);
  assert.equal(a, b);
});

test('every endpoint in api.md: method, path, query and body', async () => {
  const R = 'r7Qm2xK9pLs4Tz8A';
  const cases = [
    [() => api.getHealth(), 'GET', '/v1/health', undefined],
    [() => api.getToday(), 'GET', '/v1/today', undefined],
    [() => api.getDay('2026-10-03'), 'GET', '/v1/day/2026-10-03', undefined],
    [() => api.getProgress('2026-10-03'), 'GET', '/v1/day/2026-10-03/progress', undefined],
    [() => api.openClue(R, 'context'), 'POST', `/v1/round/${R}/clue`, { kind: 'context' }],
    [() => api.guess(R, 'c'), 'POST', `/v1/round/${R}/guess`, { option: 'c' }],
    [() => api.chooseMethod(R, 'fib_sem'), 'POST', `/v1/round/${R}/method`, { method: 'fib_sem' }],
    // skip must send {"method": null} — {} is a 400 (api.md body validation)
    [() => api.chooseMethod(R, null), 'POST', `/v1/round/${R}/method`, { method: null }],
    [() => api.chooseMethod(R), 'POST', `/v1/round/${R}/method`, { method: null }],
    [() => api.getReveal(R), 'GET', `/v1/round/${R}/reveal`, undefined],
    [() => api.report({ round_id: R, reason_code: 'bad_mesh', note: 'x' }), 'POST', '/v1/report', { round_id: R, reason_code: 'bad_mesh', note: 'x' }],
    [() => api.getMe(), 'GET', '/v1/me', undefined],
    [() => api.updateMe({ affiliation: null }), 'POST', '/v1/me', { affiliation: null }],
    [() => api.createTransferCode(), 'POST', '/v1/me/transfer-code', undefined],
    [() => api.claimTransferCode('abcd2345'), 'POST', '/v1/me/claim', { code: 'abcd2345' }],
    [() => api.claimTransferCode('ABCD2345', { discard: true }), 'POST', '/v1/me/claim', { code: 'ABCD2345', discard: true }],
    [() => api.createGroup({ name: 'MRC LMB', kind: 'lab' }), 'POST', '/v1/groups', { name: 'MRC LMB', kind: 'lab' }],
    [() => api.joinGroup('ABC234'), 'POST', '/v1/groups/join', { join_code: 'ABC234' }],
    [() => api.leaveGroup('g1'), 'POST', '/v1/groups/g1/leave', undefined],
    [() => api.getLibrary(), 'GET', '/v1/library', undefined],
    [() => api.getLibrary({ before: '2026-10-01:3', limit: 60 }), 'GET', '/v1/library?before=2026-10-01%3A3&limit=60', undefined],
    [() => api.getReviewQueue(), 'GET', '/v1/review/queue', undefined],
    [() => api.submitReview({ round_id: R, option: 'b' }), 'POST', '/v1/review', { round_id: R, option: 'b' }],
    [() => api.getRanks({ scope: 'lab', group_id: 'g1', period: 'week', date: '2026-10-03' }), 'GET', '/v1/ranks?scope=lab&group_id=g1&period=week&date=2026-10-03', undefined],
    [() => api.getRanks({ scope: 'global', group_id: undefined, period: 'day' }), 'GET', '/v1/ranks?scope=global&period=day', undefined],
    [() => api.getDayStats('2026-10-03', { scope: 'friends', group_id: 'g2' }), 'GET', '/v1/stats/day/2026-10-03?scope=friends&group_id=g2', undefined],
  ];
  responder = () => json(200, { ok: true });
  for (const [fn, method, path, body] of cases) {
    await fn();
    const c = last();
    assert.equal(c.method, method, path);
    assert.equal(c.url, BASE + path);
    assert.deepEqual(c.body, body, `${path} body`);
    assert.equal(c.init.credentials, 'omit');
    if (body === undefined) assert.ok(!('Content-Type' in c.headers), `${path}: no Content-Type without a body`);
    else assert.equal(c.headers['Content-Type'], 'application/json');
    assert.ok(!('X-NG-Debug-Now' in c.headers), 'debug clock never sent off localhost');
    if (path === '/v1/health') assert.ok(!('X-NG-Device' in c.headers), '/v1/health is the only call without the device header');
    else assert.match(c.headers['X-NG-Device'], UUID_V4, `${path} sends X-NG-Device`);
  }
});

test('path segments are URL-encoded', async () => {
  responder = () => json(200, {});
  await api.leaveGroup('a/b?c');
  assert.equal(last().url, `${BASE}/v1/groups/a%2Fb%3Fc/leave`);
});

test('ApiError: contract error body, 409 state, non-JSON errors, bad JSON', async () => {
  const state = { round_id: 'r7Qm2xK9pLs4Tz8A', round_index: 1, stage: 'type', score: 900, wrong: ['a'], eliminated: [], clues_opened: [], clues: {} };
  responder = () => json(409, { error: { code: 'already_guessed', message: 'Option already guessed' }, state });
  await assert.rejects(api.guess('r7Qm2xK9pLs4Tz8A', 'a'), (e) => {
    assert.ok(e instanceof api.ApiError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'already_guessed');
    assert.equal(e.message, 'Option already guessed');
    assert.deepEqual(e.state, state);
    assert.equal(e.isNetwork, false);
    return true;
  });
  responder = () => json(403, { error: { code: 'day_closed', message: 'closed' } });
  await assert.rejects(api.guess('r', 'a'), (e) => e.status === 403 && e.code === 'day_closed' && e.state === null);
  responder = () => new Response('<html>Bad gateway</html>', { status: 502 });
  await assert.rejects(api.getToday(), (e) => e.status === 502 && e.code === 'http' && !e.isNetwork);
  responder = () => new Response('{not json', { status: 200 });
  await assert.rejects(api.getToday(), (e) => e.code === 'bad_response');
});

test('network failure → ApiError status 0, code network, isNetwork; outcome listeners are told', async () => {
  const outcomes = [];
  const off = api.onRequestOutcome((o) => outcomes.push(o));
  responder = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api.getToday(), (e) => e.status === 0 && e.code === 'network' && e.isNetwork);
  responder = () => json(200, {});
  await api.getToday();
  off();
  assert.deepEqual(outcomes, [{ ok: false, network: true }, { ok: true, network: false }]);
  // a client-side status-0 error that is not a transport failure is not "network"
  assert.equal(new api.ApiError(0, 'busy', 'busy').isNetwork, false);
  assert.equal(new api.ApiError(0, 'timeout', 'slow').isNetwork, true);
});

test('X-From-Cache: 1 (service worker fallback) marks the parsed body with FROM_CACHE, not enumerable', async () => {
  responder = () => json(200, { date: '2026-10-03', day_number: 33, rounds: [] }, { 'X-From-Cache': '1' });
  const day = await api.getDay('2026-10-03');
  assert.equal(day[api.FROM_CACHE], true);
  assert.deepEqual(Object.keys(day), ['date', 'day_number', 'rounds']);
  responder = () => json(200, { date: '2026-10-03', day_number: 33, rounds: [] });
  assert.equal((await api.getDay('2026-10-03'))[api.FROM_CACHE], undefined);
});

test('a cached /v1/day or an asset (service worker cache-first) does not report the device online', async () => {
  const outcomes = [];
  const off = api.onRequestOutcome((o) => outcomes.push(o));
  responder = () => json(200, { date: '2026-10-03', day_number: 33, rounds: [] }, { 'X-From-Cache': '1' });
  await api.getDay('2026-10-03');
  responder = () => json(200, { ok: 1 });
  await api.assetJSON(`/v1/asset/${'c'.repeat(64)}.json`);
  responder = () => json(200, { date: '2026-10-03', day_number: 33, rounds: [] });
  await api.getDay('2026-10-03');
  off();
  assert.deepEqual(outcomes, [{ ok: true, network: false }]);
});

test('assets: device header (gated), memoised by path, failures not memoised, non-asset paths refused', async () => {
  const P = `/v1/asset/${'a'.repeat(64)}.json`;
  let n = 0;
  responder = (c) => {
    n++;
    return c.url.endsWith('.json') ? json(200, { v: 1 }) : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  const [a, b] = await Promise.all([api.assetJSON(P), api.assetJSON(P)]);
  assert.deepEqual(a, { v: 1 });
  assert.equal(a, b);
  assert.equal(n, 1, 'one request for concurrent and repeated reads');
  assert.match(last().headers['X-NG-Device'], UUID_V4);
  assert.equal(last().url, BASE + P);

  const G = `/v1/asset/${'b'.repeat(64)}.glb`;
  responder = () => json(404, { error: { code: 'not_found', message: 'locked' } });
  await assert.rejects(api.assetArrayBuffer(G), (e) => e.status === 404 && e.code === 'not_found');
  responder = () => new Response(new Uint8Array([7, 7]), { status: 200 });
  const buf = await api.assetArrayBuffer(G); // the earlier 404 (gate not yet passed) was not memoised
  assert.equal(buf.byteLength, 2);

  await assert.rejects(api.assetBlob('/v1/today'), (e) => e.code === 'bad_asset');
  await assert.rejects(api.assetBlob(`/v1/asset/${'c'.repeat(64)}.exe`), (e) => e.code === 'bad_asset');
});

test('?now= debug clock advances in real time from page load (frozen values hit the 2/s POST window)', () => {
  const base = '2026-10-03T23:59:30.000Z';
  const t0 = Date.now();
  const a = Date.parse(api.debugNowHeader(base, t0));
  const b = Date.parse(api.debugNowHeader(base, t0 + 31_000));
  assert.ok(a >= Date.parse(base) && a - Date.parse(base) < 60_000, 'starts at ?now= (plus time since load)');
  assert.equal(b - a, 31_000, 'advances with the wall clock: 23:59:30 + 31 s crosses midnight');
  assert.equal(api.debugNowHeader(null, t0), null);
  assert.equal(api.debugNowHeader('garbage', t0), null);
});
