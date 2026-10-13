// MeshViewer pure parts (js/viewer/mesh-viewer.js): view clamping, framing, px/µm, zoom about a point, tap slop,
// layer-plane geometry, GLB → neuron with client-side normals, LINES → fat-line segment pairs.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const mv = await import('../js/viewer/mesh-viewer.js');
const { THREE, parseGLB, dataMaterial } = await import('../js/viewer/three-common.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

/** Minimal GLB (assets.md profile: no names, no materials, no NORMAL, uint16 indices). */
function glb({ positions, indices, mode = 4, nodes = 1 }) {
  const pos = new Float32Array(positions);
  const idx = new Uint16Array(indices);
  const idxBytes = idx.byteLength + ((4 - (idx.byteLength % 4)) % 4);
  const bin = new Uint8Array(pos.byteLength + idxBytes);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const min = [0, 1, 2].map((k) => Math.min(...positions.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...positions.filter((_, i) => i % 3 === k)));
  const json = {
    asset: { version: '2.0', generator: 'ngbake' }, scene: 0,
    scenes: [{ nodes: Array.from({ length: nodes }, (_, i) => i) }],
    nodes: Array.from({ length: nodes }, () => ({ mesh: 0 })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
    buffers: [{ byteLength: bin.byteLength }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  if (pad) { const j = new Uint8Array(jsonBytes.length + pad).fill(0x20); j.set(jsonBytes); jsonBytes = j; }
  const total = 12 + 8 + jsonBytes.length + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jsonBytes.length).set(jsonBytes);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, bin.byteLength, true); dv.setUint32(o + 4, 0x004e4942, true);
  new Uint8Array(out, o + 8, bin.byteLength).set(bin);
  return out;
}

const TETRA = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] };

test('clampView: tilt ±1.4 rad, zoom 0.5–8×, missing fields from the base', () => {
  assert.deepEqual(mv.clampView({}), { ...mv.DEFAULT_VIEW });
  const v = mv.clampView({ tilt: 3, zoom: 20, yaw: 7, panX: 2 });
  assert.equal(v.tilt, 1.4); assert.equal(v.zoom, 8); assert.equal(v.yaw, 7); assert.equal(v.panX, 2); assert.equal(v.panY, 0);
  assert.equal(mv.clampView({ tilt: -9, zoom: 0.01 }).tilt, -1.4);
  assert.equal(mv.clampView({ zoom: 0.01 }).zoom, 0.5);
  assert.equal(mv.clampView({ zoom: NaN, tilt: Infinity }, { yaw: 1, tilt: 0.5, zoom: 2, panX: 0, panY: 0 }).zoom, 2);
  assert.equal(mv.DEFAULT_VIEW.tilt, 0.22);
  assert.equal(mv.ZOOM_MIN, 0.5); assert.equal(mv.ZOOM_MAX, 8); assert.equal(mv.TILT_MAX, 1.4);
});

test('frameHalfHeight: rotation-safe horizontally (x–z diagonal), fill 0.86, narrow viewports widen the frame', () => {
  const box = [-30, -50, -40, 30, 50, 40];               // sx 60, sy 100, sz 80 → x–z diagonal 100
  const h0 = mv.frameHalfHeight(box, 1, { tilt: 0 });
  near(h0, 50 / 0.86);                                   // vertical 100 / 2, horizontal 100 / 2
  const tall = mv.frameHalfHeight(box, 0.5, { tilt: 0 });
  near(tall, (50 / 0.5) / 0.86);                         // portrait: the horizontal extent wins
  assert.ok(mv.frameHalfHeight(box, 1) > h0, 'the default tilt shows a little of the top');
  assert.equal(mv.frameHalfHeight(null, 1), 50);
  assert.deepEqual(mv.normBbox([5, 5, 5, 0, 0, 0]), [0, 0, 0, 5, 5, 5]);
  assert.equal(mv.normBbox([1, 2]), null);
});

test('pxPerUmOf and zoomAbout keep the point under the cursor still', () => {
  near(mv.pxPerUmOf(400, 100, 1), 2);
  near(mv.pxPerUmOf(400, 100, 2), 4);
  assert.equal(mv.pxPerUmOf(0, 100, 1), 0);
  const view = { yaw: 0, tilt: 0, zoom: 1, panX: 3, panY: -2 };
  const k1 = 2;
  const sx = 80, sy = -40;                               // px from the centre, +y up
  const before = { x: -view.panX + sx / k1, y: -view.panY + sy / k1 };   // specimen point under the cursor
  const z = mv.zoomAbout(view, 2, sx, sy, k1);
  assert.equal(z.zoom, 2);
  const k2 = k1 * 2;
  near(-z.panX + sx / k2, before.x); near(-z.panY + sy / k2, before.y);
  assert.equal(mv.zoomAbout({ ...view, zoom: 8 }, 3, 0, 0, 1).zoom, 8, 'clamped');
  assert.equal(mv.zoomAbout(view, 1.5, 0, 0, 1).panX, 3, 'zooming about the centre keeps the pan');
});

test('isTap: < 4 px between down and up', () => {
  assert.equal(mv.isTap(0, 0), true);
  assert.equal(mv.isTap(2.5, 2.5), true);
  assert.equal(mv.isTap(3, 3), false);
  assert.equal(mv.isTap(4, 0), false);
});

test('planeGeometry: a plane per axis spanning the bbox; label anchored at the left-front corner', () => {
  const b = [0, 0, 0, 2500, 2200, 180];
  const y = mv.planeGeometry({ label: 'L1', axis: 'y', at_um: 2200 }, b);
  assert.deepEqual(y.corners, [[0, 2200, 0], [2500, 2200, 0], [2500, 2200, 180], [0, 2200, 180]]);
  assert.deepEqual(y.anchor, [0, 2200, 180]);
  assert.ok(mv.planeGeometry({ axis: 'x', at_um: 10 }, b).corners.every((c) => c[0] === 10));
  assert.ok(mv.planeGeometry({ axis: 'z', at_um: 90 }, b).corners.every((c) => c[2] === 90));
  assert.equal(mv.planeGeometry({ axis: 'y', at_um: NaN }, b), null);
  assert.equal(mv.guessVolumeStyle(12), 'box');
  assert.equal(mv.guessVolumeStyle(5000), 'surface');
});

test('buildNeuron: GLB without NORMAL → smooth normals computed, our material, drawn after context/siblings', async () => {
  const material = mv.neuronMaterial();
  const group = await mv.buildNeuron(glb(TETRA), material);
  const meshes = [];
  group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  assert.equal(meshes.length, 1);
  const g = meshes[0].geometry;
  assert.ok(g.getAttribute('normal'), 'normals computed client-side');
  assert.equal(g.getAttribute('normal').count, 4);
  assert.equal(meshes[0].material, material);
  assert.equal(meshes[0].renderOrder, 3);
  assert.equal(mv.triangleCount(group), 4);
  assert.equal(material.opacity, 1);
  assert.equal(material.depthWrite, true);
  assert.equal(material.color.getHex(), 0xeceff3, 'data-black');
  await assert.rejects(() => mv.buildNeuron(glb({ positions: [0, 0, 0, 1, 0, 0], indices: [0, 1], mode: 1 }), material), /no triangles/);
});

test('lineSegmentPositions: LINES siblings (one node per sibling) → endpoint pairs for LineSegments2', async () => {
  const lines = glb({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], indices: [0, 1, 1, 2], mode: 1, nodes: 3 });
  const scene = await parseGLB(lines);
  const segs = mv.lineSegmentPositions(scene);
  assert.equal(segs.length, 3 * 2 * 2 * 3, '3 nodes × 2 segments × 2 endpoints × xyz');
  assert.deepEqual([...segs.slice(0, 12)], [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
  const strip = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0)]));
  assert.equal(mv.lineSegmentPositions(strip).length, 2 * 2 * 3);
});

test('frame helpers: centre and offset in the context frame (assets.md: v + neuron_offset_um)', () => {
  assert.deepEqual(mv.bboxCentre([0, 0, 0, 10, 20, 30]), [5, 10, 15]);
  assert.deepEqual(mv.offsetBbox([-1, -2, -3, 1, 2, 3], [10, 20, 30]), [9, 18, 27, 11, 22, 33]);
});

test('shellLayerOpacity: front + back layer of a closed double-sided shell blend to the contract fill', () => {
  for (const fill of [0.035, 0.10]) {
    const a = mv.shellLayerOpacity(fill);
    near(1 - (1 - a) ** 2, fill, 1e-9);
    assert.ok(a < fill && a > fill / 2);
  }
  assert.equal(mv.shellLayerOpacity(0), 0);
  assert.equal(mv.shellLayerOpacity(NaN), 0);
});

test('without WebGL the viewer shows its status line and every public method is a safe no-op', async () => {
  const { createContainer } = await import('./_dom.js');
  const container = createContainer();
  const hadDoc = 'document' in globalThis;
  const prevDoc = globalThis.document;
  const prevErr = console.error; const prevWarn = console.warn;
  globalThis.document = container.ownerDocument;
  console.error = () => {}; console.warn = () => {};
  try {
    const v = new mv.MeshViewer(container, { autoRotate: true });
    assert.equal(v.renderer, null);
    const root = container.childNodes[0];
    assert.match(root.textContent, /needs WebGL/);
    v.setLayers({ volume: false, siblings: true, labels: false });   // used to throw (no scene groups)
    v.setDragMode('pan'); v.zoomBy(1.25); v.resetView(); v.setView({ yaw: 1 }); v.stopAutoRotate();
    assert.equal(typeof v.getView().zoom, 'number');
    const off = v.onChange(() => {}); off();
    v.onTap(() => {})();
    await v.loadNeuron(new ArrayBuffer(8), { bboxUm: [0, 0, 0, 1, 1, 1] });
    await v.setContext({ volume: new ArrayBuffer(8), labels: null, offsetUm: [0, 0, 0] });
    await v.setSiblings(null);
    v.resize();
    v.dispose();
    assert.equal(container.childNodes.length, 0, 'dispose removes the viewer DOM');
  } finally {
    console.error = prevErr; console.warn = prevWarn;
    if (hadDoc) globalThis.document = prevDoc; else delete globalThis.document;
  }
});

test('setExclusiveHost: viewers outside the open full view stop rendering continuously', () => {
  const inside = { id: 'in' };
  const outside = { id: 'out' };
  const host = { contains: (el) => el === inside };
  const make = (root) => {
    const v = Object.create(mv.MeshViewer.prototype);
    Object.assign(v, { _root: root, _lost: false, _visible: true, _autoRotating: true, _tween: null });
    v._loop = { on: null, setContinuous(on) { this.on = on; }, invalidate() {} };
    return v;
  };
  const a = make(inside);
  const b = make(outside);
  try {
    mv.setExclusiveHost(host);
    a._syncContinuous(); b._syncContinuous();
    assert.equal(a._loop.on, true, 'the full view’s own viewer keeps rendering');
    assert.equal(b._loop.on, false, 'the covered viewer pauses');
  } finally {
    mv.setExclusiveHost(null);
  }
  b._syncContinuous();
  assert.equal(b._loop.on, true, 'resumes once the full view closes');
});

test('in context today’s cell stays dominant: inflated surface + sunken keyline, softer siblings', async () => {
  assert.ok(mv.SIBLING_OPACITY <= 0.45 && mv.SIBLING_TRI_OPACITY <= mv.SIBLING_OPACITY, 'data-sky ≤ 45 %');
  assert.ok(mv.SIBLING_LINE_PX <= 0.6);
  const cell = mv.neuronMaterial();
  assert.equal(cell.userData.inflate.value, 0);
  const halo = mv.haloMaterial();
  // W4 review: depth-tested + written (early-z among its own overlapping layers: the old no-depth-test halo cost
  // ≈ the rest of the scene per frame), but pushed behind the whole cell so the cell always draws over it;
  // nothing else in the scene writes depth, so the volume and siblings cannot hide it
  assert.equal(halo.side, THREE.DoubleSide, 'no reliance on winding: real meshes are not manifold');
  assert.equal(halo.depthTest, true);
  assert.equal(halo.depthWrite, true);
  for (const k of ['context-face', 'context-edge', 'layer']) assert.equal(dataMaterial(k).depthWrite, false, `${k} writes no depth`);
  assert.equal(dataMaterial('siblings', { width: 0.5 }).depthWrite, false, 'siblings write no depth');
  assert.equal(halo.color.getHex(), 0x171e29, 'surface-sunken');
  // the inflation is a vertex-shader push along the normal, driven by a shared uniform; the halo also moves away
  // from the camera after projection set-up (same pixels, deeper)
  const src = '#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}';
  const shader = { uniforms: {}, vertexShader: src };
  halo.onBeforeCompile(shader);
  assert.equal(shader.uniforms.ngInflate, halo.userData.inflate);
  assert.equal(shader.uniforms.ngPush, halo.userData.push);
  assert.match(shader.vertexShader, /uniform float ngInflate;\nuniform float ngPush;/);
  assert.match(shader.vertexShader, /#include <begin_vertex>\n\tfloat ngLen = length\( normal \);\n\tif \( ngLen > 0\.0 \) transformed \+= normal \/ ngLen \* ngInflate;/);
  assert.match(shader.vertexShader, /#include <project_vertex>\n\tmvPosition\.z -= ngPush;\n\tgl_Position = projectionMatrix \* mvPosition;/);
  assert.equal(halo.customProgramCacheKey(), 'ng-inflate-push');
  // today's cell itself is inflated but not pushed (its own program)
  const cs = { uniforms: {}, vertexShader: src };
  cell.onBeforeCompile(cs);
  assert.equal(cs.uniforms.ngPush, undefined);
  assert.doesNotMatch(cs.vertexShader, /ngPush/);
  assert.equal(cell.customProgramCacheKey(), 'ng-inflate');
});

test('labelRect: point labels right or left of their leader line, plane labels by their text only', () => {
  const pt = { kind: 'point', x: 100, y: 50, w: 40, h: 14 };
  assert.deepEqual(mv.labelRect(pt, 'right'), [100, 42, 140, 56]);
  assert.deepEqual(mv.labelRect(pt, 'left'), [60, 42, 100, 56]);
  assert.deepEqual(mv.labelRect({ kind: 'plane', x: 10, y: 20, w: 30, h: 17 }), [16, 23, 40, 37]);
});

test('layoutLabels: nearest to today’s cell first; the rest move to the other side or hide; no overlaps', () => {
  const cell = { x: 100, y: 100 };
  const mk = (x, y, w, prev = null) => {
    const it = { kind: 'point', x, y, w, h: 14, prev };
    it.priority = mv.labelPriority(it, cell);
    return it;
  };
  // FlyWire-like pile-up: four labels within a few px of each other
  const items = [mk(160, 100, 50), mk(104, 102, 40), mk(96, 98, 46), mk(106, 104, 30)];
  const sides = mv.layoutLabels(items, { width: 375 });
  assert.equal(sides[1], 'right', 'the nearest label keeps its place');
  assert.equal(sides[2], 'left', 'the next one flips to the free side');
  assert.equal(sides[3], null, 'no room left: hidden');
  assert.equal(sides[0], 'right', 'a distant label is unaffected');
  const rects = items.map((it, i) => (sides[i] ? mv.labelRect(it, sides[i]) : null)).filter(Boolean);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      assert.ok(!(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]), 'kept labels never overlap');
    }
  }
  // the soma marker is a hard obstacle; layer planes are placed before any point
  const plane = { kind: 'plane', x: 0, y: 90, w: 30, h: 17, prev: null };
  plane.priority = mv.labelPriority(plane, cell);
  assert.ok(plane.priority < items[1].priority);
  assert.deepEqual(mv.layoutLabels([mk(100, 100, 30)], { obstacles: [[94, 94, 106, 106]], width: 375 }), [null], 'never over the soma marker');
  // stays inside the viewport when it can
  assert.deepEqual(mv.layoutLabels([mk(370, 50, 40)], { width: 375 }), ['left']);
  // prefers the side that covers less of today's cell (soft), with hysteresis for last frame's side
  const near = mk(100, 60, 40);
  assert.deepEqual(mv.layoutLabels([near], { width: 375, soft: [[100, 40, 200, 80]] }), ['left']);
  const prevRight = mk(100, 60, 40, 'right');
  assert.deepEqual(mv.layoutLabels([prevRight], { width: 375, soft: [[139, 40, 200, 80]] }), ['right'], 'a 1 px gain does not flip it');
});

test('layoutLabels: a shown label holds its side while it only uses up the gap; it never overlaps', () => {
  const a = { kind: 'point', x: 100, y: 100, w: 40, h: 14, prev: 'right', priority: 0 };
  // a's rect ends at x = 140; b's right rect starts at b.x, i.e. d = b.x − 140 px after it (d < 0: overlap)
  const at = (d, prev) => ({ kind: 'point', x: 140 + d, y: 100, w: 40, h: 14, prev, priority: 1 });
  const wide = { width: 1000 };
  assert.ok(mv.LABEL_HOLD_PX <= mv.LABEL_GAP_PX, 'the hold may use the gap, never go past it');
  // inside the gap (1 px of air): kept if it was shown there, hidden if it was not
  assert.deepEqual(mv.layoutLabels([a, at(1, 'right')], wide), ['right', 'right']);
  assert.equal(mv.layoutLabels([a, at(1, null)], wide)[1], null);
  // touching is still fine for a shown label
  assert.deepEqual(mv.layoutLabels([a, at(0, 'right')], wide), ['right', 'right']);
  // any overlap (W4 review: −3 px was tolerated and "LO" ran into "GNG"): even a shown label gives way
  assert.equal(mv.layoutLabels([a, at(-0.5, 'right')], wide)[1], null);
  assert.equal(mv.layoutLabels([a, at(-1, 'right')], wide)[1], null);
  // the soma marker obstacle gets the same rule
  const s = { kind: 'point', x: 100, y: 100, w: 30, h: 14, prev: 'right', priority: 0 };
  assert.deepEqual(mv.layoutLabels([s], { obstacles: [[60, 90, 100.5, 110]], width: 1000 }), [null], 'held label 0.5 px into the marker, and no room left of it: hidden');
});

test('layoutLabels: a region named in both hemispheres is labelled once, on the side nearest today’s cell', () => {
  const cell = { x: 100, y: 100 };
  const mk = (text, x, y) => {
    const it = { kind: 'point', text, x, y, w: 30, h: 14, prev: null };
    it.priority = mv.labelPriority(it, cell);
    return it;
  };
  const items = [mk('ME', 300, 100), mk('ME', 120, 100), mk('LA', 20, 160), mk('LA', 360, 160), mk('AL', 200, 40)];
  assert.deepEqual(mv.layoutLabels(items, { width: 1000 }), [null, 'right', 'right', null, 'right']);
  // plane labels and unnamed items are never merged
  const planes = [{ kind: 'plane', text: '', x: 0, y: 0, w: 20, h: 14, priority: -1e6 }, { kind: 'plane', text: '', x: 0, y: 50, w: 20, h: 14, priority: -1e6 }];
  assert.deepEqual(mv.layoutLabels(planes, { width: 1000 }), ['right', 'right']);
});

test('labelPriority: hysteresis keeps a shown label ahead of an equally near hidden one', () => {
  const cell = { x: 0, y: 0 };
  const shown = mv.labelPriority({ kind: 'point', x: 30, y: 40, prev: 'right' }, cell);
  const hidden = mv.labelPriority({ kind: 'point', x: 30, y: 40, prev: null }, cell);
  near(hidden, 50); near(shown, 35);
  assert.equal(mv.labelPriority({ kind: 'plane', x: 999, y: 999 }, cell), -1e6);
});
