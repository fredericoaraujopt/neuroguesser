// store.js: createStore semantics and useStore re-render correctness (rendered with Preact on a minimal DOM).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer, flush } from './_dom.js';

const { h, render } = await import('preact');
const storeMod = await import('../js/store.js');
const { createStore, shallowEqual, useStore, store, initialState } = storeMod;

test('createStore: set merges top-level slices, update merges inside a slice, subscribers see every change', () => {
  const s = createStore({ a: { x: 1, y: 2 }, list: [1, 2] });
  const seen = [];
  const unsub = s.subscribe((st) => seen.push(st));
  const before = s.get();
  s.set({ b: 3 });
  assert.deepEqual(s.get(), { a: { x: 1, y: 2 }, list: [1, 2], b: 3 });
  assert.notEqual(s.get(), before, 'state objects are replaced, never mutated');
  s.update('a', { y: 5 });
  assert.deepEqual(s.get().a, { x: 1, y: 5 });
  s.update('a', (a) => ({ x: a.x + 1 }));
  assert.deepEqual(s.get().a, { x: 2, y: 5 });
  s.update('list', (l) => [...l, 3]);
  assert.deepEqual(s.get().list, [1, 2, 3], 'array slices are replaced, not spread into objects');
  s.set(() => null); // no patch → no notification
  assert.equal(seen.length, 4);
  unsub();
  s.set({ c: 1 });
  assert.equal(seen.length, 4, 'unsubscribed');
});

test('createStore: a throwing subscriber does not stop the others', () => {
  const s = createStore({ n: 0 });
  let ok = 0;
  const origError = console.error;
  console.error = () => {};
  try {
    s.subscribe(() => { throw new Error('boom'); });
    s.subscribe(() => { ok++; });
    s.set({ n: 1 });
  } finally { console.error = origError; }
  assert.equal(ok, 1);
});

test('shallowEqual', () => {
  assert.ok(shallowEqual(1, 1));
  assert.ok(shallowEqual(null, null));
  assert.ok(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }));
  assert.ok(shallowEqual([1, 2], [1, 2]));
  assert.ok(!shallowEqual({ a: {} }, { a: {} }), 'shallow only');
  assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!shallowEqual([1], { 0: 1 }));
  assert.ok(!shallowEqual(null, {}));
  assert.ok(shallowEqual(NaN, NaN));
});

test('initial state has the §4.1 shape', () => {
  const s = initialState();
  assert.deepEqual(Object.keys(s).sort(), ['library', 'reveals', 'session', 'today', 'ui']);
  assert.deepEqual(s.session.settings, { haptics: true, celebrations: true });
  for (const k of ['status', 'date', 'dayNumber', 'now', 'nextRolloverAt', 'grace', 'rounds', 'progress', 'total', 'roundsDone', 'streak', 'revealAck', 'error']) {
    assert.ok(k in s.today, `today.${k}`);
  }
  assert.deepEqual(Object.keys(s.ui).sort(), ['fullView', 'online', 'sheet', 'toast']);
});

test('useStore re-renders only when the selected value changes (shallow compare)', async () => {
  store.set(initialState());
  const renders = { status: 0, pair: 0 };
  let lastStatus = null;
  function Status() { renders.status++; lastStatus = useStore((s) => s.today.status); return h('span', null, lastStatus); }
  // a selector returning a fresh object every time: shallow compare must keep it quiet
  function Pair() { renders.pair++; const p = useStore((s) => ({ online: s.ui.online, n: s.today.total })); return h('span', null, `${p.online}:${p.n}`); }
  const root = createContainer();
  render(h('div', null, h(Status), h(Pair)), root);
  await flush();
  assert.equal(renders.status, 1);
  assert.equal(renders.pair, 1);

  store.update('ui', { toast: { id: 1, text: 'x' } });          // unrelated slice
  store.update('today', { error: null, loadedAt: 5 });           // same slice, unselected fields
  await flush();
  assert.equal(renders.status, 1, 'unrelated updates do not re-render');
  assert.equal(renders.pair, 1, 'a fresh but shallow-equal object does not re-render');

  store.update('today', { status: 'ready' });
  await flush();
  assert.equal(renders.status, 2);
  assert.equal(lastStatus, 'ready');
  assert.equal(root.textContent, 'readytrue:0');

  store.update('today', { total: 1200 });
  await flush();
  assert.equal(renders.pair, 2);
  assert.equal(root.textContent, 'readytrue:1200');

  render(null, root);
  await flush();
  store.update('today', { status: 'error' });
  await flush();
  assert.equal(renders.status, 2, 'no re-render (and no subscription) after unmount');
});

test('useStore catches an update made between the first render and its subscription', async () => {
  store.set(initialState());
  let seen = null;
  function C() { seen = useStore((s) => s.today.status); return null; }
  const root = createContainer();
  render(h(C), root);
  store.update('today', { status: 'loading' }); // before the effect subscribes (effects run after paint)
  await flush();
  assert.equal(seen, 'loading');
  render(null, root);
});
