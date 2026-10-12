// Full view (js/screens/fullview.js) pure parts: what the overlay may show at each stage. Before `done`: no EM
// depth/thickness, no Neuroglancer; EM only once round_state.em exists; context from the opened clue (type
// stage) or the reveal (done, with siblings).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const fv = await import('../js/screens/fullview.js');
const A = (c) => `/v1/asset/${c.repeat(64)}`;

const ROUND = { round_id: 'r1', round_index: 2, mesh: { asset: `${A('a')}.glb`, bbox_um: [-10, -10, -10, 10, 10, 10] } };
const EM = { atlas: `${A('b')}.webp`, mask: `${A('c')}.png`, xz: `${A('d')}.webp`, field_um: 8.192, n_slices: 32 };
const CLUE_CTX = { volume: `${A('e')}.glb`, labels: `${A('f')}.json`, neuron_offset_um: [1, 2, 3] };
const REVEAL = {
  type: { name: 'Kenyon cell' },
  neuron: { neuroglancer_url: 'https://example.org/ng' },
  method: { id: 'fib_sem', voxel_nm: [8, 8, 8] },
  context: { volume: `${A('e')}.glb`, labels: `${A('f')}.json`, neuron_offset_um: [1, 2, 3], siblings: `${A('9')}.glb`, siblings_count: 12 },
};

test('type stage: mesh only; the context only if that clue was opened; never EM, voxel size or Neuroglancer', () => {
  const m = fv.fullViewModel({ round: ROUND, state: null, reveal: REVEAL });
  assert.equal(m.stage, 'type');
  assert.equal(m.em, null);
  assert.equal(m.context, null, 'the reveal context is not used before done');
  assert.equal(m.voxelNm, null);
  assert.equal(m.neuroglancerUrl, null);
  assert.deepEqual(fv.modesFor(m).map((x) => x.id), ['3d']);
  assert.equal(fv.normaliseMode('em', m), '3d');
  const opened = fv.fullViewModel({ round: ROUND, state: { stage: 'type', clues: { context: CLUE_CTX } } });
  assert.deepEqual(opened.context, { volume: CLUE_CTX.volume, labels: CLUE_CTX.labels, offsetUm: [1, 2, 3], siblings: null, siblingsCount: 0 });
  assert.equal(opened.siblingsLabel, null);
});

test('method stage: EM available, still no depth / voxel size / Neuroglancer', () => {
  const m = fv.fullViewModel({ round: ROUND, state: { stage: 'method', em: EM, clues: {} }, reveal: REVEAL });
  assert.equal(m.em, EM);
  assert.deepEqual(fv.modesFor(m).map((x) => x.label), ['3D', 'EM']);
  assert.equal(fv.normaliseMode('em', m), 'em');
  assert.equal(fv.normaliseMode('xz', m), 'em');
  assert.equal(fv.normaliseMode('mesh', m), '3d');
  assert.equal(m.voxelNm, null);
  assert.equal(m.neuroglancerUrl, null);
  const z = fv.zReadout(16, 32, m.voxelNm);
  assert.equal(z.z, 'z 17/32');
  assert.equal(z.depth, null);
  assert.ok(!/µm|nm/.test(z.z));
});

test('done: reveal context with siblings, depth from voxel_nm, Neuroglancer', () => {
  const m = fv.fullViewModel({ round: ROUND, state: { stage: 'done', em: EM, clues: { context: CLUE_CTX } }, reveal: REVEAL });
  assert.equal(m.done, true);
  assert.equal(m.context.siblings, REVEAL.context.siblings);
  assert.equal(m.siblingsLabel, 'Kenyon cell · 12');
  assert.equal(m.neuroglancerUrl, 'https://example.org/ng');
  assert.deepEqual(m.voxelNm, [8, 8, 8]);
  assert.deepEqual(fv.zReadout(16, 32, m.voxelNm), { z: 'z 17/32', depth: '0.13 µm deep' });
  assert.deepEqual(fv.zReadout(31, 32, [4, 4, 40]), { z: 'z 32/32', depth: '1.24 µm deep' });
  // done but the reveal not loaded yet: the clue context still shows, no link yet
  const early = fv.fullViewModel({ round: ROUND, state: { stage: 'done', em: EM, clues: { context: CLUE_CTX } } });
  assert.equal(early.context.volume, CLUE_CTX.volume);
  assert.equal(early.neuroglancerUrl, null);
});

test('zReadout / sliceAt / zoomText edge cases; scale-bar steps include the handoff sets', () => {
  assert.equal(fv.zReadout(-5, 32).z, 'z 1/32');
  assert.equal(fv.zReadout(99, 32).z, 'z 32/32');
  assert.equal(fv.sliceAt(0, 32), 0);
  assert.equal(fv.sliceAt(1, 32), 31);
  assert.equal(fv.sliceAt(0.5, 32), 16);
  assert.equal(fv.sliceAt(-1, 32), 0);
  assert.equal(fv.zoomText(1), '1.0×');
  assert.equal(fv.zoomText(2.345), '2.3×');
  for (const s of [10, 20, 50, 100, 200, 500]) assert.ok(fv.SCALE_3D.includes(s));
  for (const s of [1, 2, 5, 10, 20]) assert.ok(fv.SCALE_EM.includes(s));
  assert.equal(fv.SLICE_JUMP, 10);
});

test('openFullView / closeFullView write store.ui.fullView (extra opener fields pass through)', async () => {
  const { store } = await import('../js/store.js');
  fv.openFullView({ roundIndex: 3, mode: 'em', plane: 'xz' });
  assert.deepEqual(store.get().ui.fullView, { roundIndex: 3, mode: 'em', plane: 'xz' });
  fv.closeFullView();
  assert.equal(store.get().ui.fullView, null);
});
