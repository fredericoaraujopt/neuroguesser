// js/fx: haptics feature detection (Vibration API, iOS switch ticks, none), the Settings switches,
// celebrations under reduced motion / Celebrations off, milestone maths, and checkOvertakes end to end.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { haptic, hapticsSupport, PATTERNS, TICKS, TICK_GAP_MS } = await import('../js/fx/haptics.js');
const fx = await import('../js/fx/celebrate.js');
const { store, initialState } = await import('../js/store.js');
const idb = await import('../js/idb.js');

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function withGlobals(globals, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  const restore = () => {
    for (const k of Object.keys(globals)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) { restore(); throw err; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('haptics: the five kinds use the §3.1 vibration patterns and tick counts', () => {
  assert.deepEqual(PATTERNS, { selection: 8, light: 12, success: [12, 60, 18], error: [30, 50, 30], celebrate: [10, 40, 10, 40, 30] });
  for (const k of Object.keys(PATTERNS)) assert.ok(TICKS[k] >= 1 && TICKS[k] <= 3, k);
  assert.ok(TICK_GAP_MS >= 60 && TICK_GAP_MS <= 100);
});

test('haptics: Vibration API when present, respects Settings → Haptics, unknown kinds and failures are no-ops', () => {
  store.set(initialState());
  const seen = [];
  const nav = { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140', vibrate: (p) => { seen.push(p); return true; } };
  withGlobals({ navigator: nav }, () => {
    assert.equal(hapticsSupport(), 'vibrate');
    assert.equal(haptic('success'), true);
    assert.equal(haptic('selection'), true);
    assert.equal(haptic('nope'), false);
    store.update('session', { settings: { haptics: false, celebrations: true } });
    assert.equal(haptic('celebrate'), false, 'Haptics off');
    store.update('session', { settings: { haptics: true, celebrations: false } });
    assert.equal(haptic('error'), true, 'Celebrations off does not silence haptics (independent switches)');
    nav.vibrate = () => { throw new Error('blocked'); };
    assert.equal(haptic('light'), false, 'never throws');
  });
  assert.deepEqual(seen, [[12, 60, 18], 8, [30, 50, 30]]);
  store.set(initialState());
});

test('haptics: no Vibration API and not iOS → none (desktop Safari, Node)', () => {
  withGlobals({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', platform: 'MacIntel', maxTouchPoints: 0 }, document: {} }, () => {
    assert.equal(hapticsSupport(), 'none');
    assert.equal(haptic('success'), false);
  });
});

test('haptics: iOS (no Vibration API) clicks a fresh hidden <label><input switch></label> per tick, 1–3 ticks', async () => {
  store.set(initialState());
  const made = [];
  let clicks = 0;
  let attached = 0;
  const el = (tag) => {
    const node = { tag, attrs: {}, style: {}, children: [], parentNode: null, setAttribute(k, v) { this.attrs[k] = v; },
      append(...c) { this.children.push(...c); }, focus() {} };
    if (tag === 'label') node.click = () => { clicks++; assert.ok(node.parentNode, 'clicked while attached'); };
    made.push(node);
    return node;
  };
  const host = { appendChild(n) { n.parentNode = host; attached++; }, removeChild(n) { n.parentNode = null; attached--; } };
  const doc = { createElement: el, head: host, body: host, activeElement: null };
  const nav = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 };
  await withGlobals({ navigator: nav, document: doc }, async () => {
    assert.equal(hapticsSupport(), 'ios-switch');
    assert.equal(haptic('selection'), true);
    assert.equal(clicks, 1, 'first tick is synchronous (inside the user gesture)');
    assert.equal(attached, 0, 'the switch is removed after its tick');
    const label = made.find((n) => n.tag === 'label');
    const input = made.find((n) => n.tag === 'input');
    assert.equal(input.type, 'checkbox');
    assert.ok('switch' in input.attrs, 'switch attribute');
    assert.ok(label.children.includes(input), 'the switch sits inside its label');
    assert.equal(label.style.display, 'none');
    clicks = 0;
    haptic('error');
    assert.equal(clicks, 1);
    await sleep(TICK_GAP_MS * 3 + 40);
    assert.equal(clicks, TICKS.error);
    assert.equal(attached, 0);
    store.update('session', { settings: { haptics: false, celebrations: true } });
    clicks = 0;
    assert.equal(haptic('celebrate'), false);
    assert.equal(clicks, 0);
  });
  // an iPad reports itself as a Mac with touch
  withGlobals({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }, document: {} }, () => {
    assert.equal(hapticsSupport(), 'ios-switch');
  });
  store.set(initialState());
});

test('celebrate: no DOM, reduced motion or Celebrations off → no effect, end state at once, never throws', async () => {
  store.set(initialState());
  assert.equal(fx.motionAllowed(), false, 'no DOM under node');
  for (const f of [fx.burst, fx.checkDraw, fx.shake, fx.pulse, fx.flash, fx.glow, fx.stamp, fx.rays]) await f(null);
  await fx.floatUp('+200', null, null);
  let frames = [];
  await fx.countUp(0, 4200, (v) => frames.push(v));
  assert.deepEqual(frames, [4200], 'instant end value');

  const appended = [];
  const fakeDoc = { getElementById: () => ({ appendChild: (n) => appended.push(n) }), createElement: () => ({ style: {}, setAttribute() {}, animate() {} }), body: { appendChild: (n) => appended.push(n) } };
  const card = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 76 }), animate: () => { throw new Error('should not animate'); } };
  await withGlobals({ document: fakeDoc, matchMedia: (q) => ({ matches: q.includes('reduce') }) }, async () => {
    assert.equal(fx.motionAllowed(), false, 'prefers-reduced-motion');
    await fx.burst(card);
    await fx.shake(card);
    await fx.pulse(card);
    frames = [];
    await fx.countUp(0, 10, (v) => frames.push(v));
    assert.deepEqual(frames, [10]);
  });
  await withGlobals({ document: fakeDoc, matchMedia: () => ({ matches: false }) }, async () => {
    store.update('session', { settings: { haptics: true, celebrations: false } });
    assert.equal(fx.motionAllowed(), false, 'Celebrations off');
    await fx.burst(card, { count: 28, big: true });
    store.set(initialState());
    assert.equal(fx.motionAllowed(), true);
  });
  assert.equal(appended.length, 0, 'no particles or rings were added');
});

test('celebrate: countUp can be cancelled and lands on the end value in a hidden tab', async () => {
  store.set(initialState());
  await withGlobals({ document: {}, matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 0 }, async () => {
    const frames = [];
    const p = fx.countUp(0, 100, (v) => frames.push(v), { duration: 30 });
    assert.equal(await p, 100);
    assert.equal(frames[frames.length - 1], 100, 'no frames delivered, the timeout lands on `to`');
    const seen = [];
    const q = fx.countUp(0, 100, (v) => seen.push(v), { duration: 500 });
    q.cancel();
    assert.equal(await q, 100);
    assert.deepEqual(seen, [], 'cancelled: no further frames');
  });
});

test('streak milestones: 3, 7, 14, 30, 50, 100, 200, 365 and progress between them', () => {
  assert.deepEqual(fx.STREAK_MILESTONES, [3, 7, 14, 30, 50, 100, 200, 365]);
  assert.equal(fx.isMilestone(7), true);
  assert.equal(fx.isMilestone(8), false);
  assert.equal(fx.nextMilestone(0), 3);
  assert.equal(fx.nextMilestone(7), 14);
  assert.equal(fx.nextMilestone(365), null);
  assert.equal(fx.prevMilestone(2), 0);
  assert.equal(fx.prevMilestone(13), 7);
  assert.equal(fx.milestoneProgress(0), 0);
  assert.equal(fx.milestoneProgress(10), 3 / 7);
  assert.equal(fx.milestoneProgress(400), 1);
});

test('checkOvertakes: Global + each group for the ACTIVE date; first look stores a snapshot, then reports passes', async () => {
  const { checkOvertakes, ranksKey } = await import('../js/fx/overtake.js');
  const row = (user_id, rank, display_name, is_me = false) => ({ rank, user_id, display_name, initials: 'XX', affiliation: null, total: 0, streak: 0, strip: null, is_me });
  let phase = 0;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    asked.push(u.search);
    const scope = u.searchParams.get('scope');
    let rows;
    if (scope === 'global') rows = phase ? [row('x', 1, 'X'), row('me', 2, 'Me', true)] : [row('x', 1, 'X'), row('y', 2, 'Y')];
    else rows = phase ? [row('me', 1, 'Me', true), row('ana', 2, 'Ana Ribeiro')] : [row('ana', 1, 'Ana Ribeiro'), row('me', 2, 'Me', true)];
    const me = scope === 'global' ? (phase ? rows[1] : { ...row('me', 40, 'Me', true) }) : rows.find((r) => r.is_me);
    return new Response(JSON.stringify({ scope, period: 'day', date: u.searchParams.get('date'), n_players: 50, rows, me, ...(scope !== 'global' ? { group: { group_id: 'g1', name: 'MRC LMB' } } : {}) }), { status: 200 });
  };
  store.set(initialState());
  store.update('session', { me: { user_id: 'me', groups: [{ group_id: 'g1', kind: 'lab', name: 'MRC LMB', join_code: 'ABC234', n_members: 4 }] } });
  // grace: the round finished after midnight belongs to yesterday's board
  store.update('today', { date: '2026-10-02', todayDate: '2026-10-03', graceActive: true });
  assert.deepEqual(await checkOvertakes(), [], 'no previous snapshot: nothing to celebrate yet');
  assert.ok(asked.every((q) => q.includes('date=2026-10-02') && q.includes('period=day')), asked.join(' '));
  assert.ok(asked.some((q) => q.includes('scope=lab') && q.includes('group_id=g1')));
  assert.ok(await idb.get(`lastRanks:${ranksKey({ scope: 'lab', groupId: 'g1', date: '2026-10-02' })}`));
  phase = 1;
  const events = await checkOvertakes();
  const lab = events.find((e) => e.scope === 'lab');
  assert.deepEqual({ ...lab }, { scope: 'lab', groupId: 'g1', groupName: 'MRC LMB', oldRank: 2, newRank: 1, passed: ['Ana Ribeiro'] });
  const glob = events.find((e) => e.scope === 'global');
  assert.equal(glob.oldRank, 40);
  assert.equal(glob.newRank, 2);
  store.set(initialState());
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
});
