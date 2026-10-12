// EM format 2 in the screens (em-v2-spec.md §8.1, §8.4, §8.7, §11): createEmView picks format 2, the dual fallback,
// format 1 or "update the app"; the round's full-view args carry the stage's panel; the full view's model knows the
// three shapes; the reveal's "Look again" chips open the full view on a preset (format 2 rounds only); the round
// warms only format 2's first groups. The WebGL stage itself is exercised in the browser (dev/em2.html).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContainer, flush } from './_dom.js';

const { h, render } = await import('preact');
const F = await import('../js/viewer/em2/factory.js');
const L = await import('../js/viewer/em2/loader.js');
const round = await import('../js/screens/round.js');
const fv = await import('../js/screens/fullview.js');
const rv = await import('../js/screens/reveal.js');

const A = (c, ext = 'webp') => `/v1/asset/${c.repeat(64)}.${ext}`;
function v2() {
  return {
    format: 2, px_nm: [8, 8], section_nm: 40, em_to_mesh: [[-0.001, 0, 0], [0, -0.001, 0], [0, 0, -0.001]],
    centre_nm: [0, 0], bbox_nm: [-20000, -20000, -20000, 20000, 20000, 20000], outline_source: 'segmentation',
    z: { n: 32, soma_index: 16, z0_nm: 20, missing: [] },
    stack: { size_px: 640, cols: 4, rect_nm: [-2560, -2560, 2560, 2560], chunks: [
      { asset: A('1'), bytes: 10, sections: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] },
      { asset: A('2'), bytes: 10, sections: [0, 1, 2, 3, 4, 5, 6, 7, 24, 25, 26, 27, 28, 29, 30, 31] }] },
    levels: [
      { asset: A('3'), bytes: 10, px_nm: [8, 8], size_px: [1024, 1024], rect_nm: [-4096, -4096, 4096, 4096], section: 0 },
      { asset: A('4'), bytes: 10, px_nm: [16, 16], size_px: [1024, 1024], rect_nm: [-8192, -8192, 8192, 8192], section: 0 },
      { asset: A('5'), bytes: 10, px_nm: [32, 32], size_px: [1250, 1250], rect_nm: [-20000, -20000, 20000, 20000], section: 0 },
    ],
    ortho: { asset: A('6'), bytes: 10, width_px: 1024, rows: 204, missing_rows: [],
      xz: { y_nm: 4, x0_nm: -4096, x1_nm: 4096 }, yz: { x_nm: 4, y0_nm: -4096, y1_nm: 4096 } },
    ortho_ctx: { asset: A('7'), bytes: 10, size_px: [1024, 512], levels: [
      { px_nm: [64, 64], vz_nm: 80, xz: { y_nm: 32, rect_nm: [-20000, -20000, 20000, 20000], atlas_px: [0, 0, 625, 500] },
        yz: { x_nm: 32, rect_nm: [-20000, -20000, 20000, 20000], atlas_px: [625, 0, 625, 500] } }] },
    outlines: { asset: A('8', 'json'), bytes: 10 },
  };
}
const V1 = { atlas: A('a'), xz: A('b'), mask: A('c', 'png'), field_um: 8.192, n_slices: 32 };

function impls(log, { v2Throws = false, v2Rejects = false } = {}) {
  return {
    v2: async (c, e) => {
      log.push(['v2', e.format]);
      if (v2Throws) throw new Error('no WebGL 2');
      const ready = v2Rejects ? Promise.reject(new Error('no level loaded')) : Promise.resolve('stage');
      ready.catch(() => {});
      return { kind: 'v2', stage: {}, viewer: null, ready, dispose() { log.push(['dispose v2']); } };
    },
    v1: async (c, e) => { log.push(['v1', e.atlas]); return { kind: 'v1', stage: null, viewer: {}, ready: Promise.resolve('viewer'), dispose() {} }; },
  };
}

test('createEmView: format 2 → the stage; format 1 → EmViewer; dual → the stage, or format 1 when it cannot start or load', async () => {
  const c = createContainer();
  let log = [];
  assert.equal((await F.createEmView(c, v2(), { impl: impls(log) })).kind, 'v2');
  assert.deepEqual(log, [['v2', 2]]);
  log = [];
  assert.equal((await F.createEmView(c, V1, { impl: impls(log) })).kind, 'v1');
  assert.deepEqual(log, [['v1', V1.atlas]]);
  log = [];
  const dual = { ...V1, v2: v2() };
  const ok = await F.createEmView(c, dual, { impl: impls(log) });
  assert.equal(ok.kind, 'v2');
  assert.equal(await ok.ready, 'stage');
  assert.deepEqual(log, [['v2', 2]]);
  log = [];
  const noGl = await F.createEmView(c, dual, { impl: impls(log, { v2Throws: true }) });
  assert.equal(noGl.kind, 'v1', 'the stage failed to initialise');
  assert.deepEqual(log, [['v2', 2], ['v1', V1.atlas]]);
  log = [];
  const noLoad = await F.createEmView(c, dual, { impl: impls(log, { v2Rejects: true }) });
  assert.equal(await noLoad.ready, 'viewer', 'the stage failed to load: format 1 takes over');
  assert.equal(noLoad.kind, 'v1');
  assert.deepEqual(log, [['v2', 2], ['dispose v2'], ['v1', V1.atlas]]);
  // a pure format 2 round that fails reports it (no format 1 to fall back on)
  log = [];
  const bad = await F.createEmView(c, v2(), { impl: impls(log, { v2Throws: true }) });
  await assert.rejects(bad.ready, /no WebGL 2/);
  assert.equal((await F.createEmView(c, null, { impl: impls(log) })).kind, 'none');
});

test('an unknown format: "Update the app to see this EM" with a Reload button, never a broken viewer', async () => {
  const c = createContainer();
  const v = await F.createEmView(c, { format: 3 }, { impl: impls([]) });
  assert.equal(v.kind, 'update');
  assert.equal(c.textContent, 'Update the app to see this EM' + 'Reload');
  v.dispose();
  assert.equal(c.textContent, '');
  assert.equal(F.emKind({ format: 3 }), 'update');
  assert.equal(F.emKind({ ...V1, v2: v2() }), 'v2');
  assert.equal(F.emKind(V1), 'v1');
  assert.equal(F.emKind(null), 'none');
  const root = createContainer();
  render(h(F.UpdateEm, { onReload: () => {} }), root);
  await flush();
  assert.equal(root.textContent, 'Update the app to see this EMReload');
  render(null, root);
});

test('round: the full view continues on the stage\'s panel (format 2); format 1 args unchanged', () => {
  assert.deepEqual(round.fullViewArgs({ roundIndex: 2, mode: 'em', methodTab: 'xy', slice: 16, panel: 'yz' }),
    { roundIndex: 2, mode: 'em', plane: 'xy', slice: 16, panel: 'yz' });
  assert.deepEqual(round.fullViewArgs({ roundIndex: 2, mode: 'em', methodTab: 'xz', slice: 3 }),
    { roundIndex: 2, mode: 'em', plane: 'xz', slice: 3 });
  assert.deepEqual(round.fullViewArgs({ roundIndex: 2, mode: '3d', panel: 'yz' }), { roundIndex: 2, mode: '3d' });
  // the warm-up: format 2 prefetches its own first groups, format 1 keeps fetching atlas, mask and XZ
  const src = readFileSync(new URL('../js/screens/round.js', import.meta.url), 'utf8');
  assert.match(src, /if \(emK === 'v2'\) \{ prefetchEm\(em\); return; \}/);
});

test('full view model: format 2, dual (the stage, format 1 kept as fallback) and unknown all offer EM; depth only after done', () => {
  const ROUND = { round_id: 'r1', mesh: { asset: A('m', 'glb'), bbox_um: [-1, -1, -1, 1, 1, 1] } };
  const m2 = fv.fullViewModel({ round: ROUND, state: { stage: 'method', em: v2(), clues: {} } });
  assert.ok(m2.em2);
  assert.equal(m2.em, null);
  assert.deepEqual(fv.modesFor(m2).map((x) => x.id), ['3d', 'em']);
  assert.equal(fv.normaliseMode('em', m2), 'em');
  assert.equal(fv.normaliseMode('yz', m2), 'em');
  assert.equal(m2.voxelNm, null);
  const dual = { ...V1, v2: v2() };
  const md = fv.fullViewModel({ round: ROUND, state: { stage: 'method', em: dual, clues: {} } });
  assert.equal(md.em2, dual);
  assert.deepEqual(md.em, V1);
  const mu = fv.fullViewModel({ round: ROUND, state: { stage: 'method', em: { format: 3 }, clues: {} } });
  assert.equal(mu.emUnknown, true);
  assert.equal(fv.normaliseMode('em', mu), 'em');
  const m1 = fv.fullViewModel({ round: ROUND, state: { stage: 'method', em: V1, clues: {} } });
  assert.equal(m1.em, V1);
  assert.equal(m1.em2, null);
});

test('reveal "How it was made": up to 3 Look again chips for a format 2 round open the full view on the preset', async () => {
  const look = [
    { label: 'Sections in XZ', panel: 'xz', frame: 'section', value: 12 },
    { label: 'Native pixels', panel: 'xy', frame: 'native', value: 10 },
    { label: 'Whole cell', panel: 'xy', frame: 'cell' },
  ];
  const reveal = {
    round_id: 'r1',
    neuron: { neuroglancer_url: 'https://example.org/ng', dataset_name: 'FlyWire', release: 'v783', neuron_id: '1' },
    method: { id: 'sstem', name: 'Serial-section TEM', detail: 'TEMCA', voxel_nm: [4, 4, 40], shown_voxel_nm: [8, 8, 40], what_to_notice: 'x', look_again: look },
  };
  const state = { stage: 'done', method_correct: true, method_pick: 'sstem', em: v2() };
  const opened = [];
  const root = createContainer();
  render(h(rv.MadePanel, { reveal, state, onFullView: (a) => opened.push(a) }), root);
  await flush();
  const text = root.textContent;
  assert.ok(text.includes('Look again'));
  for (const l of look) assert.ok(text.includes(`⤢ ${l.label}`), l.label);
  const find = (n, pred) => (pred(n) ? n : n.childNodes.map((c) => find(c, pred)).find(Boolean) || null);
  const chip = find(root, (n) => n.localName === 'button' && n.textContent === '⤢ Sections in XZ');
  chip.dispatch('click');
  assert.deepEqual(opened, [{ mode: 'em', panel: 'xz', preset: look[0] }]);
  // format 1 rounds, and screens without a full view, show no chips
  render(h(rv.MadePanel, { reveal, state: { ...state, em: V1 }, onFullView: () => {} }), root);
  await flush();
  assert.ok(!root.textContent.includes('Look again'));
  render(h(rv.MadePanel, { reveal, state }), root);
  await flush();
  assert.ok(!root.textContent.includes('Look again'));
  render(null, root);
});

test('prefetchEm: format 2 warms levels 0 and L, ortho, outlines and stack A; format 1 and dual-less shapes warm nothing here', async () => {
  const asked = [];
  L.setEmAssetSource(async (path) => { asked.push(path); return new Blob(['x']); });
  const e = v2();
  await F.prefetchEm(e);
  assert.deepEqual(asked.sort(), [e.levels[0].asset, e.levels[2].asset, e.ortho.asset, e.outlines.asset, e.stack.chunks[0].asset].sort());
  asked.length = 0;
  await F.prefetchEm({ ...V1, v2: e });
  assert.deepEqual(asked, [], 'already in the memo');
  await F.prefetchEm(V1);
  await F.prefetchEm(null);
  assert.deepEqual(asked, []);
  L.setEmAssetSource(null);
});
