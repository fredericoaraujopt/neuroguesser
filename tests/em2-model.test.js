// EM format 2 viewer, pure parts (em-v2-spec.md §11 "App unit"): js/viewer/em2/model.js (formats, rects, LOD,
// frames, readouts and spoiler rules, gestures, wheel, load plan, scale bar, presets, framings, layouts, 3D camera),
// mesh-cut.js (plane cuts) and overlay.js (outline paths).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../js/viewer/em2/model.js');
const { cutMesh, meshToLocal, boundsOf } = await import('../js/viewer/em2/mesh-cut.js');
const { ringsPath, rowRuns, Overlay } = await import('../js/viewer/em2/overlay.js');

const A = (c, ext = 'webp') => `/v1/asset/${c.repeat(64)}.${ext}`;
/** contracts/examples/round_answer_em_v2.json's em (FlyWire-like: 8 × 8 × 40, det < 0, a lost section 3). */
function v2(over = {}) {
  return {
    format: 2, px_nm: [8, 8], section_nm: 40,
    em_to_mesh: [[-0.001, 0, 0], [0, -0.001, 0], [0, 0, -0.001]],
    centre_nm: [-1210, 640], bbox_nm: [-35210, -52800, -61000, 40800, 113200, 55300],
    outline_source: 'segmentation',
    z: { n: 32, soma_index: 16, z0_nm: 12, missing: [3] },
    stack: { size_px: 640, cols: 4, rect_nm: [-3770, -1920, 1350, 3200], chunks: [
      { asset: A('1'), bytes: 1412000, sections: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] },
      { asset: A('2'), bytes: 1398000, sections: [0, 1, 2, 3, 4, 5, 6, 7, 24, 25, 26, 27, 28, 29, 30, 31] }] },
    levels: [
      { asset: A('3'), bytes: 352000, px_nm: [8, 8], size_px: [1024, 1024], rect_nm: [-5306, -3456, 2886, 4736], section: 0 },
      { asset: A('4'), bytes: 341000, px_nm: [16, 16], size_px: [1024, 1024], rect_nm: [-9402, -7552, 6982, 8832], section: 0 },
      { asset: A('5'), bytes: 336000, px_nm: [32, 32], size_px: [1024, 1024], rect_nm: [-17594, -15744, 15174, 17024], section: 0 },
      { asset: A('6'), bytes: 318000, px_nm: [64, 64], size_px: [1024, 1024], rect_nm: [-33978, -32128, 31558, 33408], section: 0 },
      { asset: A('7'), bytes: 205000, px_nm: [128, 128], size_px: [595, 930], rect_nm: [-35322, -52864, 40838, 66176], section: 0 },
      { asset: A('8'), bytes: 66000, px_nm: [256, 256], size_px: [298, 650], rect_nm: [-35322, -52992, 40966, 113408], section: 0 },
    ],
    ortho: { asset: A('9'), bytes: 112000, width_px: 1024, rows: 204, missing_rows: [89, 162],
      xz: { y_nm: 644, x0_nm: -5306, x1_nm: 2886 }, yz: { x_nm: -1206, y0_nm: -3456, y1_nm: 4736 } },
    ortho_ctx: { asset: A('a'), bytes: 610000, size_px: [2048, 1184], levels: [
      { px_nm: [64, 64], vz_nm: 80, xz: { y_nm: 672, rect_nm: [-33978, -32808, 31558, 32792], atlas_px: [0, 0, 1024, 820] },
        yz: { x_nm: -1178, rect_nm: [-32128, -32808, 33408, 32792], atlas_px: [1024, 0, 1024, 820] } },
      { px_nm: [256, 256], vz_nm: 320, xz: { y_nm: 640, rect_nm: [-35322, -61128, 40966, 55352], atlas_px: [0, 820, 298, 364] },
        yz: { x_nm: -1146, rect_nm: [-52992, -61128, 113408, 55352], atlas_px: [1024, 820, 650, 364] } }] },
    outlines: { asset: A('b', 'json'), bytes: 96000 },
    ...over,
  };
}
const V1 = { atlas: A('c'), xz: A('d'), mask: A('e', 'png'), field_um: 8.192, n_slices: 32 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const SPOILER = /\d+(\.\d+)? ?nm section|thickness|z-step|µm deep|[+−-]\d+\.\d+ µm/;

test('parseEm: format 2, dual (v1 kept as the fallback), format 1, unknown and none', () => {
  const e = v2();
  assert.deepEqual(M.parseEm(e), { kind: 'v2', v1: null, v2: e, dual: false });
  const dual = { ...V1, v2: e };
  const d = M.parseEm(dual);
  assert.equal(d.kind, 'v2');
  assert.equal(d.dual, true);
  assert.equal(d.v2, e);
  assert.deepEqual(d.v1, V1);
  assert.equal(M.parseEm(V1).kind, 'v1');
  assert.equal(M.parseEm(V1).v1, V1);
  assert.equal(M.parseEm({ ...V1, v2: { format: 3 } }).kind, 'v1', 'a dual whose v2 is unreadable still shows format 1');
  assert.equal(M.parseEm({ ...e, format: 3 }).kind, 'unknown');
  assert.equal(M.parseEm({}).kind, 'unknown');
  assert.equal(M.parseEm('x').kind, 'unknown');
  assert.equal(M.parseEm(null).kind, 'none');
  assert.equal(M.parseEm(undefined).kind, 'none');
  const broken = v2(); delete broken.ortho;
  assert.equal(M.parseEm(broken).kind, 'unknown');
  assert.equal(M.v2Assets(e).length, 11);
  assert.ok(M.v2Assets(e).every((p) => /^\/v1\/asset\/[a-f0-9]{64}\.(webp|json)$/.test(p)));
});

test('rects: the stack inside level 0, levels nest, the coarsest covers B (XY), the last context level B (x, z) and (y, z)', () => {
  const e = v2();
  assert.ok(M.rectContains(e.levels[0].rect_nm, e.stack.rect_nm));
  for (let l = 1; l < e.levels.length; l++) assert.ok(M.rectContains(e.levels[l].rect_nm, e.levels[l - 1].rect_nm), `level ${l}`);
  assert.ok(M.rectContains(M.coarsestRect(e), M.bboxXY(e)));
  const last = e.ortho_ctx.levels[e.ortho_ctx.levels.length - 1];
  const b = e.bbox_nm;
  assert.ok(M.rectContains(last.xz.rect_nm, [b[0], b[2], b[3], b[5]]));
  assert.ok(M.rectContains(last.yz.rect_nm, [b[1], b[2], b[4], b[5]]));
  assert.equal(M.rectsIntersect([0, 0, 10, 10], [10, 0, 20, 10]), false, 'end-exclusive');
  assert.equal(M.pointInRect([0, 0, 10, 10], 9.99, 0), true);
  assert.equal(M.pointInRect([0, 0, 10, 10], 10, 0), false);
});

test('em_to_mesh: inverse with det < 0 (FlyWire reflection) and with rotation + non-square px (H01-like)', () => {
  const e = v2();
  assert.ok(M.mat3Det(e.em_to_mesh) < 0);
  const inv = M.mat3Inverse(e.em_to_mesh);
  for (const v of [[100, -2000, 40], [-35210, 113200, 55300], [0, 0, 0]]) {
    const back = M.meshToEm(e, M.emToMesh(e, v));
    v.forEach((x, i) => assert.ok(near(back[i], x), `${v} → ${back}`));
  }
  assert.ok(near(inv[0][0], -1000));
  const a = (-30 * Math.PI) / 180;
  const h01 = v2({ px_nm: [5.55, 4], em_to_mesh: [[0.001 * Math.cos(a), -0.001 * Math.sin(a), 0], [0.001 * Math.sin(a), 0.001 * Math.cos(a), 0], [0, 0, 0.001]] });
  const v = [5550, -4000, 33];
  const back = M.meshToEm(h01, M.emToMesh(h01, v));
  v.forEach((x, i) => assert.ok(near(back[i], x)));
  assert.equal(M.mat3Inverse([[1, 2, 3], [2, 4, 6], [0, 0, 1]]), null, 'singular');
  // mesh-cut.js applies the same inverse to every vertex
  const local = meshToLocal(new Float32Array([0.1, -0.2, 0.3]), inv);
  assert.ok(near(local[0], -100, 1e-5) && near(local[1], 200, 1e-5) && near(local[2], -300, 1e-5));
});

test('sections, rows and z: offsets, the native ortho band, row ↔ z, chunk tiles', () => {
  const e = v2();
  assert.equal(M.sectionZ(e, 16), 12);
  assert.equal(M.sectionZ(e, 0), 12 - 16 * 40);
  assert.equal(M.sectionZ(e, 31), 12 + 15 * 40);
  assert.equal(M.sectionAtZ(e, M.sectionZ(e, 5)), 5);
  const b = M.orthoBand(e);
  assert.equal(b.rows, 204);
  assert.equal(b.top, 12 - 102.5 * 40);
  assert.equal(b.bottom - b.top, 204 * 40);
  assert.equal(M.rowCentreZ(e, 102), 12, 'row N/2 is the soma section');
  assert.equal(M.rowAtZ(e, 12), 102);
  assert.equal(M.rowAtZ(e, M.rowCentreZ(e, 37)), 37);
  assert.equal(M.stackIndexOfRow(e, 102), 16);
  assert.equal(M.stackIndexOfRow(e, 86), 0);
  assert.equal(M.stackIndexOfRow(e, 117), 31);
  assert.equal(M.stackIndexOfRow(e, 85), null);
  assert.equal(M.stackIndexOfRow(e, 89), 3, 'the missing row 89 is the lost section 3');
  assert.deepEqual(M.stackTile(e, 16), { chunk: 0, t: 8, col: 0, row: 2 });
  assert.deepEqual(M.stackTile(e, 8), { chunk: 0, t: 0, col: 0, row: 0 });
  assert.deepEqual(M.stackTile(e, 0), { chunk: 1, t: 0, col: 0, row: 0 });
  assert.deepEqual(M.stackTile(e, 31), { chunk: 1, t: 15, col: 3, row: 3 });
  assert.equal(M.isMissing(e, 3), true);
  assert.equal(M.isMissing(e, 16), false);
  assert.equal(M.clampSection(40), 31);
  assert.equal(M.clampSection(-2), 0);
  assert.equal(M.clampSection(NaN), 16);
  const r = M.orthoRects(e);
  assert.deepEqual(r.xz, [-5306, b.top, 2886, b.bottom]);
  assert.deepEqual(r.yz, [-3456, b.top, 4736, b.bottom]);
});

test('level choice (LOD): ≤ 2× minified, the coarsest loaded never discards, data saver draws the next coarser loaded', () => {
  const e = v2();
  const all = () => ({ scale: 1 });
  assert.deepEqual(M.chooseLevels(e, 4, all).drawn, [5, 4, 3, 2, 1, 0], '8 nm px at 2 device px: everything');
  assert.deepEqual(M.chooseLevels(e, 16, all).drawn, [5, 4, 3, 2, 1, 0], 'level 0 exactly at 0.5 device px per texel');
  assert.deepEqual(M.chooseLevels(e, 20, all).drawn, [5, 4, 3, 2, 1], 'level 0 minified > 2×');
  assert.deepEqual(M.chooseLevels(e, 600, all), { drawn: [5], coarsest: 5 });
  const only = (set) => (l) => (set.includes(l) ? { scale: 1 } : false);
  assert.deepEqual(M.chooseLevels(e, 20, only([0, 5])), { drawn: [5], coarsest: 5 });
  assert.deepEqual(M.chooseLevels(e, 600, only([0])), { drawn: [0], coarsest: 0 }, 'only level 0 loaded: it never discards');
  // a half-resolution decode doubles that level's px
  assert.deepEqual(M.levelPx(e, 0, 0.5), [16, 16]);
  assert.deepEqual(M.chooseLevels(e, 20, (l) => (l === 0 ? { scale: 0.5 } : { scale: 1 })).drawn, [5, 4, 3, 2, 1, 0]);
  // H01: the most minified axis decides
  assert.equal(M.texelDev([5.55, 4], 8), 0.5);
});

test('readouts: px of what is at the centre, "finest" only at full resolution; no thickness, z-step or depth before done', () => {
  const e = v2();
  const view = { cx: -1210, cy: 640, zv: 12, u: 4 };
  const ready = () => ({ scale: 1 });
  const st = { section: 16, stack: ready, level: ready, ortho: { scale: 1 }, ctx: ready };
  assert.deepEqual(M.centreSource(e, 'xy', view, 2, st), { kind: 'stack', index: 16, px: [8, 8], finest: true });
  assert.equal(M.centreSource(e, 'xy', view, 2, { ...st, stack: () => ({ scale: 0.5 }) }).finest, false, 'half-resolution stack');
  const lv0 = M.centreSource(e, 'xy', view, 2, { ...st, stack: () => false });
  assert.deepEqual(lv0, { kind: 'level', index: 0, px: [8, 8], finest: true });
  assert.deepEqual(M.centreSource(e, 'xy', view, 2, { ...st, stack: () => false, level: (l) => (l === 0 ? { scale: 0.5 } : { scale: 1 }) }).px, [16, 16]);
  assert.equal(M.centreSource(e, 'xy', view, 2, { ...st, stack: () => false, level: (l) => (l === 0 ? { scale: 0.5 } : { scale: 1 }) }).finest, false);
  assert.deepEqual(M.centreSource(e, 'xy', { ...view, u: 70 }, 35, st).px, [32, 32], '32 nm texels at 35 nm per device px: drawn');
  assert.deepEqual(M.centreSource(e, 'xy', { ...view, u: 140 }, 70, st).px, [64, 64], 'zoomed out: a coarser level');
  assert.equal(M.centreSource(e, 'xy', { ...view, section: 3 }, 2, { ...st, section: 3 }).kind, 'level', 'lost section: the level under it');
  assert.equal(M.centreSource(e, 'xz', view, 2, st).kind, 'ortho');
  assert.equal(M.centreSource(e, 'xz', { ...view, u: 300 }, 150, st).kind, 'ctx');
  assert.equal(M.centreSource(e, '3d', view, 2, st), null);

  assert.equal(M.pxLabel([8, 8], true), '8 nm px · finest');
  assert.equal(M.pxLabel([64, 64]), '64 nm px');
  assert.equal(M.pxLabel([5.55, 4], true), '5.55 × 4 nm px · finest');
  assert.equal(M.pxLabel([11.1, 8]), '11.1 × 8 nm px');
  assert.equal(M.pxLabel([3.8, 3.8], true), '3.8 nm px · finest');
  for (const panel of ['xy', 'xz', 'yz', '3d']) {
    for (const section of [0, 3, 16, 31]) {
      const before = M.readoutLines({ panel, px: [8, 8], isFinest: true, done: false, sectionNm: 40, section });
      assert.ok(before.every((l) => !SPOILER.test(l)), `${panel} ${section}: ${before}`);
    }
  }
  assert.deepEqual(M.readoutLines({ panel: 'xy', px: [8, 8], isFinest: true, done: false, sectionNm: 40, section: 19 }), ['8 nm px · finest']);
  assert.deepEqual(M.readoutLines({ panel: '3d', px: null, done: false, sectionNm: 40, section: 19 }), [], '3D: scale bar only');
  assert.deepEqual(M.readoutLines({ panel: 'xy', px: [8, 8], isFinest: true, done: true, sectionNm: 40, section: 19 }),
    ['8 nm px · finest · 40 nm sections', 'z 20/32 · +0.12 µm']);
  assert.equal(M.zLabel(16), 'z 17/32');
  assert.equal(M.zLabel(3, 32, { done: true, sectionNm: 40 }), 'z 4/32 · −0.52 µm');
  assert.equal(M.zLabel(3, 32, { done: false, sectionNm: 40 }), 'z 4/32');
  assert.equal(M.sectionsNote(false, 40), '');
  assert.equal(M.sectionsNote(true, 33), '33 nm sections');
  assert.equal(M.lensLabel(false, 'xz', e), '', 'the lens shows the aspect only before done');
  assert.equal(M.lensLabel(true, 'xz', e), '8 × 40 nm');
  assert.equal(M.lensLabel(true, 'yz', v2({ px_nm: [5.55, 4], section_nm: 33 })), '4 × 33 nm');
  assert.equal(M.ariaSection(16), 'section 17 of 32');
  assert.equal(M.ariaSection(4, 32, true), 'section 5 of 32, not imaged');
});

test('classifyTouch: z drag inside the stack frame (≥ 96 px), pan outside or on a small frame, scrub near the section line, two fingers', () => {
  const frame = { x0: 50, y0: 50, x1: 250, y1: 250 };
  assert.equal(M.classifyTouch({ panel: 'xy', x: 100, y: 100, stackFrame: frame }), 'section');
  assert.equal(M.classifyTouch({ panel: 'xy', x: 20, y: 100, stackFrame: frame }), 'pan');
  assert.equal(M.classifyTouch({ panel: 'xy', x: 100, y: 100, stackFrame: { x0: 50, y0: 50, x1: 145, y1: 145 } }), 'pan', '95 px frame');
  assert.equal(M.classifyTouch({ panel: 'xy', x: 100, y: 100, stackFrame: { x0: 50, y0: 50, x1: 146, y1: 146 } }), 'section', '96 px frame');
  assert.equal(M.classifyTouch({ panel: 'xy', count: 2, x: 100, y: 100, stackFrame: frame }), 'pinch');
  assert.equal(M.classifyTouch({ panel: 'xz', x: 100, y: 210, sectionLine: { axis: 'y', pos: 200 } }), 'scrub');
  assert.equal(M.classifyTouch({ panel: 'xz', x: 100, y: 217, sectionLine: { axis: 'y', pos: 200 } }), 'pan');
  assert.equal(M.classifyTouch({ panel: 'yz', x: 190, y: 10, sectionLine: { axis: 'x', pos: 200 } }), 'scrub');
  assert.equal(M.classifyTouch({ panel: '3d', x: 1, y: 1 }), 'rotate');
  assert.equal(M.classifyTouch({ panel: '3d', count: 2, x: 1, y: 1 }), 'pinch3d');
  assert.equal(M.sectionsForDrag(23), 0);
  assert.equal(M.sectionsForDrag(48), 2, 'down = next, 24 px per section');
  assert.equal(M.sectionsForDrag(-25), -1);
  assert.equal(M.LONG_PRESS_MS, 500);
});

test('wheelStep: pixel deltas accumulate per 50 px (reset after 200 ms idle), lines, pages, Shift ×10, Ctrl/⌘ zoom', () => {
  const acc = { px: 0, lines: 0, t: 0 };
  assert.deepEqual(M.wheelStep({ deltaY: 30, deltaMode: 0 }, acc, 1000), { kind: 'section', delta: 0 });
  assert.deepEqual(M.wheelStep({ deltaY: 30, deltaMode: 0 }, acc, 1100), { kind: 'section', delta: 1 });
  assert.deepEqual(M.wheelStep({ deltaY: 40, deltaMode: 0 }, acc, 1500), { kind: 'section', delta: 0 }, 'idle > 200 ms: the remainder is dropped');
  assert.deepEqual(M.wheelStep({ deltaY: -100, deltaMode: 0 }, { px: 0, lines: 0, t: 0 }, 5000), { kind: 'section', delta: -2 });
  assert.deepEqual(M.wheelStep({ deltaY: 3, deltaMode: 1 }, { px: 0, lines: 0, t: 0 }, 1), { kind: 'section', delta: 3 }, '1 per line');
  assert.deepEqual(M.wheelStep({ deltaY: 1, deltaMode: 2 }, { px: 0, lines: 0, t: 0 }, 1), { kind: 'section', delta: 10 }, 'a page');
  assert.deepEqual(M.wheelStep({ deltaY: 50, deltaMode: 0, shiftKey: true }, { px: 0, lines: 0, t: 0 }, 1), { kind: 'section', delta: 10 });
  assert.deepEqual(M.wheelStep({ deltaY: 0, deltaX: -50, deltaMode: 0, shiftKey: true }, { px: 0, lines: 0, t: 0 }, 1), { kind: 'section', delta: -10 }, 'Shift turned vertical into horizontal');
  const z = M.wheelStep({ deltaY: -10, deltaMode: 0, ctrlKey: true }, acc, 1);
  assert.equal(z.kind, 'zoom');
  assert.ok(near(z.factor, Math.exp(0.1)));
  assert.equal(M.wheelStep({ deltaY: 500, deltaMode: 0, metaKey: true }, acc, 1).factor, 0.5, 'clamped per event');
});

test('load plan: the §8.6 order; data saver gates', () => {
  const e = v2();
  const normal = M.loadPlan(e);
  assert.deepEqual(normal.map((i) => i.id), ['level0', 'level5', 'ortho', 'outlines', 'stackA', 'level1', 'level2', 'level3', 'level4', 'stackB', 'ctx']);
  assert.deepEqual(normal.map((i) => i.group), [1, 1, 2, 2, 3, 4, 4, 4, 4, 5, 6]);
  assert.ok(normal.every((i) => i.gate === 'now'));
  assert.equal(normal.find((i) => i.id === 'stackA').asset, e.stack.chunks[0].asset);
  assert.equal(normal.find((i) => i.id === 'level5').bytes, 66000);
  const saver = M.loadPlan(e, { saveData: true });
  const gate = Object.fromEntries(saver.map((i) => [i.id, i.gate]));
  assert.deepEqual(gate, { level0: 'now', level5: 'now', ortho: 'now', outlines: 'now', stackA: 'z-or-idle', level1: 'lod', level2: 'lod', level3: 'lod', level4: 'lod', stackB: 'deep', ctx: 'demand' });
  const firstPaint = saver.filter((i) => i.group === 1).reduce((s, i) => s + i.bytes, 0);
  assert.equal(firstPaint, 352000 + 66000);
  assert.deepEqual([0, 8, 9, 16, 23, 24, 31].map(M.wantsStackB), [true, true, false, false, false, true, true]);
  assert.equal(M.saveDataFrom({ saveData: true }), true);
  assert.equal(M.saveDataFrom({ effectiveType: '3g' }), true);
  assert.equal(M.saveDataFrom({ effectiveType: '4g' }), false);
  assert.equal(M.saveDataFrom(null, true), true);
  assert.equal(M.saveDataFrom(undefined), false);
  assert.equal(M.fmtMB(400000), '0.4 MB');
});

test('scale bar: 10 nm … 1 mm steps, nm below 1 µm', () => {
  assert.deepEqual(M.scaleBar(1, 120), { nm: 100, px: 100, label: '100 nm' });
  assert.equal(M.scaleBar(0.4, 120).label, '20 nm');
  assert.equal(M.scaleBar(50, 120).label, '5 µm');
  assert.equal(M.scaleBar(20000, 120).label, '1 mm');
  assert.equal(M.scaleBar(0.01, 120).label, '10 nm', 'the smallest step even when too long');
  assert.equal(M.scaleBar(0, 120).px, 0);
  for (const s of [10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6]) assert.ok(M.SCALE_STEPS_NM.includes(s));
  assert.equal(M.scaleLabel(500), '500 nm');
  assert.equal(M.scaleLabel(2000), '2 µm');
});

test('framings, zoom limits and pan clamp; the dive path; Look again presets', () => {
  const e = v2();
  const n = M.frameNative(e, 375, 300);
  assert.ok(near(n.u, 5120 / (0.92 * 300)));
  assert.deepEqual([n.cx, n.cy, n.zv], [-1210, 640, 12]);
  const c = M.frameCell(e, 375, 300, ['xy']);
  assert.ok(near(c.u, Math.max(76010 / (375 * 0.85), 166000 / (300 * 0.85))));
  const quad = M.frameCell(e, 375, 300, ['xy', 'xz', 'yz']);
  assert.ok(quad.u >= c.u);
  const lim = M.zoomLimits(e, c.u, 2);
  assert.ok(near(lim.uMin, (8 * 2) / 24), '1 native px = 24 device px');
  assert.ok(near(lim.uMax, c.u / 0.8));
  const cl = M.clampView({ cx: 1e7, cy: -1e7, zv: 1e9, u: 1e-3 }, e, lim);
  assert.deepEqual([cl.cx, cl.cy, cl.zv], [40966, -52992, 55300]);
  assert.equal(cl.u, lim.uMin);
  // dive: whole cell → native, log zoom; the stack never leaves the screen
  const a = M.diveView(0, c, n);
  const b = M.diveView(1, c, n);
  assert.ok(near(a.u, c.u) && near(b.u, n.u) && near(b.cx, n.cx) && near(b.cy, n.cy));
  let prev = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const v = M.diveView(t, c, n);
    assert.ok(v.u <= prev + 1e-9, 'zooms in monotonically');
    prev = v.u;
    const [sx, sy] = M.planeToScreen('xy', v, 375, 300, n.cx, n.cy);
    assert.ok(sx >= -1 && sx <= 376 && sy >= -1 && sy <= 301, `t=${t.toFixed(2)}: the target at ${sx}, ${sy}`);
  }
  // presets (round_reveal.method.look_again)
  const sec = M.lookAgainView({ label: 'Sections in XZ', panel: 'xz', frame: 'section', value: 12 }, e, { w: 375, h: 300 });
  assert.equal(sec.panel, 'xz');
  assert.ok(near(sec.view.u, 40 / 12));
  assert.equal(sec.section, 16);
  const nat = M.lookAgainView({ label: 'Native pixels', panel: 'xy', frame: 'native', value: 10 }, e, { w: 375, h: 300 });
  assert.ok(near(nat.view.u, 0.8));
  assert.deepEqual([nat.view.cx, nat.view.cy, nat.view.zv], [-1210, 640, 12]);
  const field = M.lookAgainView({ label: 'Beam tiles', panel: 'xy', frame: 'field', value: 120 }, e, { w: 400, h: 300 });
  assert.ok(near(field.view.u, 300));
  const cell = M.lookAgainView({ label: 'Whole cell', panel: 'xy', frame: 'cell' }, e, { w: 375, h: 300 });
  assert.ok(near(cell.view.u, c.u));
  assert.equal(M.lookAgainView({ panel: 'nope', frame: 'native' }, e).panel, 'xy');
});

test('Native framing never minifies the native pixels past the LOD limit (a small dpr-1 panel still shows 8 nm px)', () => {
  const e = v2();
  // a 1366 × 768 laptop's 4panel XY panel at dpr 1: the plain fit would minify 8 nm px 2.1× → LOD discards the stack
  const fit = M.frameNative(e, 450, 333);
  assert.ok(M.texelDev(e.px_nm, fit.u / 1) < M.LOD_DISCARD, 'the reason: the bare fit is past the LOD limit');
  const n1 = M.frameNative(e, 450, 333, 1);
  assert.ok(M.texelDev(e.px_nm, n1.u / 1) >= M.LOD_DISCARD, 'with the dpr: the stack and the native XZ/YZ are drawn');
  assert.deepEqual([n1.cx, n1.cy, n1.zv], [fit.cx, fit.cy, fit.zv]);
  const lv = M.chooseLevels(e, n1.u / 1).drawn;
  assert.ok(lv.includes(0), 'level 0 drawn at Native');
  // phones (dpr ≥ 2) and roomy panels keep the plain 92 % fit
  assert.ok(near(M.frameNative(e, 375, 300, 2).u, M.frameNative(e, 375, 300).u));
  assert.ok(near(M.frameNative(e, 900, 700, 1).u, M.frameNative(e, 900, 700).u));
  // H01-like non-square px: the finer axis decides
  const h = v2({ px_nm: [5.55, 4] });
  assert.ok(M.texelDev(h.px_nm, M.frameNative(h, 700, 420, 1).u) >= M.LOD_DISCARD);
  assert.ok(near(M.lookAgainView({ panel: 'xy', frame: 'native' }, e, { w: 450, h: 333, dpr: 1 }).view.u, n1.u));
});

test('XY outlines: the soma section\'s level rings never run over the stack rect while the stack quad owns it', () => {
  class P2 {
    constructor() { this.ops = []; }
    moveTo(x, y) { this.ops.push(['M', x, y]); }
    lineTo(x, y) { this.ops.push(['L', x, y]); }
    rect(x, y, w, h) { this.ops.push(['R', x, y, w, h]); }
    closePath() { this.ops.push(['Z']); }
  }
  const prev = globalThis.Path2D;
  globalThis.Path2D = P2;
  try {
    const e = v2();
    const calls = [];
    const ctx = new Proxy({}, {
      get: (t, k) => (k in t ? t[k] : (k === 'clip' || k === 'stroke' ? (...a) => calls.push([k, ...a]) : () => {})),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    const ov = new Overlay({ getContext: () => ctx, width: 750, height: 600 });
    const ring = [100, 100, 900, 100, 900, 900, 100, 900];
    ov.setOutlines({ v: 1, q: 2, stack: Array.from({ length: 32 }, (_, i) => (i === 3 ? [] : [ring])), levels: [[ring], [ring], [ring]], xz: [], yz: [] }, e);
    const draw = (over) => {
      calls.length = 0;
      ov.drawPanel({ panel: { id: 'xy', x: 0, y: 0, w: 375, h: 300 }, dpr: 2, view: M.frameNative(e, 375, 300), v2: e, section: 16,
        layers: { outline: true, axes: false }, stackShown: false, stackCovered: false, missingStack: false, orthoShown: false,
        cutXY: () => null, lens: false, ...over });
      // the clip set just before the level-0 rings are stroked
      const i = calls.findIndex((c) => c[0] === 'stroke' && c[1] === ov.paths.levels[0]);
      const clip = calls.slice(0, i).reverse().find((c) => c[0] === 'clip');
      return clip[1].ops.filter((o) => o[0] === 'R');
    };
    const st = e.stack.rect_nm;
    const hole = ['R', st[0], st[1], st[2] - st[0], st[3] - st[1]];
    assert.deepEqual(draw({ section: 3, missingStack: true, stackCovered: true })[1], hole, 'a lost section: no soma outline over the hatch');
    assert.deepEqual(draw({ section: 20, stackCovered: true })[1], hole, 'a section still loading: likewise');
    assert.deepEqual(draw({ section: 20, stackShown: true, stackCovered: true })[1], hole, 'the tile drawn: its own stack[k] ring');
    assert.equal(draw({ section: 16 }).length, 1, 'level 0 is the soma section itself (or the stack is too minified): R_0 whole');
  } finally {
    globalThis.Path2D = prev;
  }
});

test('XZ/YZ outlines: clipped out of the lost rows (± the stroke width), runs merged; the hatch shows instead', async () => {
  const { lostRowBands } = await import('../js/viewer/em2/overlay.js');
  const e = v2();                                  // ortho missing_rows [89, 162], 40 nm sections
  const band = M.orthoBand(e);
  assert.deepEqual(lostRowBands(e), [[band.top + 89 * 40, band.top + 90 * 40], [band.top + 162 * 40, band.top + 163 * 40]]);
  assert.deepEqual(lostRowBands(v2({ ortho: { ...e.ortho, missing_rows: [] } })), []);
  // rows 8 and 10 grown by more than half a row touch: one band
  const two = v2({ ortho: { ...e.ortho, missing_rows: [10, 8] } });
  assert.deepEqual(lostRowBands(two, 25), [[band.top + 8 * 40 - 25, band.top + 11 * 40 + 25]]);
  class P2 {
    constructor() { this.ops = []; }
    moveTo(x, y) { this.ops.push(['M', x, y]); }
    lineTo(x, y) { this.ops.push(['L', x, y]); }
    rect(x, y, w, h) { this.ops.push(['R', x, y, w, h]); }
    closePath() { this.ops.push(['Z']); }
  }
  const prev = globalThis.Path2D;
  globalThis.Path2D = P2;
  try {
    const calls = [];
    const ctx = new Proxy({}, {
      get: (t, k) => (k in t ? t[k] : (k === 'clip' || k === 'stroke' ? (...a) => calls.push([k, ...a]) : () => {})),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    const ov = new Overlay({ getContext: () => ctx, width: 750, height: 600 });
    const ring = [100, 100, 900, 100, 900, 300, 100, 300];
    ov.setOutlines({ v: 1, q: 2, stack: Array.from({ length: 32 }, () => []), levels: [[], [], []], xz: [ring], yz: [ring] }, e);
    const view = { cx: 0, cy: 0, zv: 0, u: 10 };
    for (const id of ['xz', 'yz']) {
      calls.length = 0;
      ov.drawPanel({ panel: { id, x: 0, y: 0, w: 375, h: 300 }, dpr: 2, view, v2: e, section: 16, layers: { outline: true, axes: false },
        orthoShown: true, cutXZ: () => null, cutYZ: () => null, lens: false });
      const i = calls.findIndex((c) => c[0] === 'stroke' && c[1] === ov.paths[id]);
      assert.ok(i > 0, `${id} outline stroked`);
      const clip = calls.slice(0, i).reverse().find((c) => c[0] === 'clip');
      assert.equal(clip[2], 'evenodd');
      const rects = clip[1].ops.filter((o) => o[0] === 'R');
      assert.equal(rects.length, 3, `${id}: the native rect and one hole per lost row`);
      const pad = 1.5 * view.u;
      const z0 = band.top + 89 * 40 - pad;
      assert.ok(id === 'xz' ? near(rects[1][2], z0) && near(rects[1][4], 40 + 2 * pad) : near(rects[1][1], z0) && near(rects[1][3], 40 + 2 * pad),
        `${id}: the hole is the lost row grown by the stroke width, along z`);
    }
  } finally {
    globalThis.Path2D = prev;
  }
});

test('views: screen ↔ plane per panel, pan follows the finger, zoom keeps the point under the pointer', () => {
  const v = { cx: 100, cy: 200, zv: 300, u: 2 };
  assert.deepEqual(M.screenToPlane('xy', v, 100, 50, 50, 25), [100, 200]);
  assert.deepEqual(M.screenToPlane('xz', v, 100, 50, 60, 25), [120, 300]);
  assert.deepEqual(M.screenToPlane('yz', v, 100, 50, 50, 35), [300, 220], 'YZ: z right, y down');
  for (const p of ['xy', 'xz', 'yz']) {
    const [h, w] = M.screenToPlane(p, v, 100, 50, 13, 41);
    assert.deepEqual(M.planeToScreen(p, v, 100, 50, h, w), [13, 41]);
    const z = M.zoomViewAbout(p, v, 2, 13, 41, 100, 50);
    assert.equal(z.u, 1);
    assert.deepEqual(M.screenToPlane(p, z, 100, 50, 13, 41), [h, w]);
  }
  assert.deepEqual(M.panView('xy', v, 10, -5), { cx: 80, cy: 210, zv: 300, u: 2 });
  assert.deepEqual(M.panView('yz', v, 10, -5), { cx: 100, cy: 210, zv: 280, u: 2 });
  const lim = { uMin: 1.5, uMax: 3 };
  assert.equal(M.zoomViewAbout('xy', v, 10, 0, 0, 100, 50, lim).u, 1.5);
  const e = v2();
  const f = M.stackFrameOnScreen(e, { cx: -1210, cy: 640, zv: 12, u: 10 }, 400, 300);
  assert.ok(near(f.x1 - f.x0, 512));
  const line = M.sectionLineOnScreen('xz', e, { cx: 0, cy: 0, zv: 12, u: 10 }, 400, 300, 17);
  assert.deepEqual(line, { axis: 'y', pos: 154 });
  assert.equal(M.sectionAtScreen('xz', e, { cx: 0, cy: 0, zv: 12, u: 10 }, 400, 300, 0, 154), 17);
  assert.equal(M.sectionAtScreen('yz', e, { cx: 0, cy: 0, zv: 12, u: 10 }, 400, 300, 1e6, 0), 31, 'clamped');
  assert.equal(M.stackCovers(e, { cx: -1210, cy: 640, zv: 12, u: 1 }, 400, 300), true);
  assert.equal(M.stackCovers(e, { cx: -1210, cy: 640, zv: 12, u: 50 }, 400, 300), false);
});

test('layouts: Neuroglancer 4panel order (XY | XZ over 3D | YZ) with 1 px gutters; the phone full-view ⊞ threshold', () => {
  const q = M.panelRects('quad', 'xy', 1001, 801);
  assert.deepEqual(q.map((p) => p.id), ['xy', 'xz', '3d', 'yz']);
  assert.deepEqual(q[0], { id: 'xy', x: 0, y: 0, w: 500, h: 400 });
  assert.deepEqual(q[1], { id: 'xz', x: 501, y: 0, w: 500, h: 400 });
  assert.deepEqual(q[2], { id: '3d', x: 0, y: 401, w: 500, h: 400 });
  assert.deepEqual(q[3], { id: 'yz', x: 501, y: 401, w: 500, h: 400 });
  assert.deepEqual(M.panelRects('single', 'yz', 375, 300), [{ id: 'yz', x: 0, y: 0, w: 375, h: 300 }]);
  assert.equal(M.panelRects('single', 'bogus', 10, 10)[0].id, 'xy');
  assert.equal(M.canQuad(390, 844), true);
  assert.equal(M.canQuad(375, 780), true);
  assert.equal(M.canQuad(375, 400), false, 'the inline viewer on a phone');
  assert.equal(M.canQuad(360, 844), false);
  assert.deepEqual(M.QUAD_ORDER, ['xy', 'xz', '3d', 'yz']);
});

test('3D camera: front, yaw 30°, tilt 20°; tilted towards the XY plane normal when it would be seen near edge-on', () => {
  const e = v2();
  const d = M.defaultCamera3d(e);
  assert.ok(near(d.yaw, Math.PI / 6) && near(d.tilt, Math.PI / 9));
  // horizontal sections (BANC / this male CNS profile: EM z → mesh −y): |n·d| < 0.5 → 60°
  const flat = v2({ em_to_mesh: [[0.001, 0, 0], [0, 0, -0.001], [0, 0.001, 0]] });
  const f = M.defaultCamera3d(flat);
  const dir = [Math.sin(f.yaw) * Math.cos(f.tilt), Math.sin(f.tilt), Math.cos(f.yaw) * Math.cos(f.tilt)];
  const n = [0, -1, 0];
  assert.ok(near(Math.abs(dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2]), Math.sin(Math.PI / 3), 1e-9));
  assert.ok(Math.abs(f.tilt) > 0.9);
});

test('3D camera: on the side of the opaque XY plane that holds most of the mesh (the plane never hides the neuron)', () => {
  const dirOf = (c) => [Math.sin(c.yaw) * Math.cos(c.tilt), Math.sin(c.tilt), Math.cos(c.yaw) * Math.cos(c.tilt)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // FlyWire-like (EM z → mesh −z): the default camera (mesh front) is on the −z side of the EM, n·d < 0
  const e = v2();
  const n = [0, 0, -1];
  const z16 = M.sectionZ(e, M.SOMA_INDEX);
  // a mesh mostly at EM z > the soma section (n·d > 0 needed): mirrored through the plane, same angle to it
  const behind = new Float32Array([0, 0, z16 + 5000, 10, 0, z16 + 9000, 0, 10, z16 + 20000, 0, 0, z16 - 3000]);
  assert.equal(M.meshSide(e, behind), 1);
  const base = M.defaultCamera3d(e);
  const c = M.defaultCamera3d(e, { side: M.meshSide(e, behind) });
  assert.ok(dot(dirOf(base), n) < 0 && dot(dirOf(c), n) > 0, 'the camera moved to the mesh side');
  assert.ok(near(Math.abs(dot(dirOf(c), n)), Math.abs(dot(dirOf(base), n)), 1e-9), 'same angle to the plane');
  assert.ok(near(c.tilt, base.tilt, 1e-9), 'still 20° above the horizon');
  // the mesh already on the camera's side: unchanged
  const front = new Float32Array([0, 0, z16 - 5000, 0, 0, z16 - 8000, 0, 0, z16 + 1000]);
  assert.equal(M.meshSide(e, front), -1);
  assert.deepEqual(M.defaultCamera3d(e, { side: -1 }), base);
  assert.equal(M.meshSide(e, new Float32Array([0, 0, z16])), 0, 'no vertex off the plane');
  assert.deepEqual(M.defaultCamera3d(e, { side: 0 }), base);
  // BANC-like horizontal sections (EM z → mesh +y), the mesh below the soma: tilted to 60° from BELOW, not above
  const flat = v2({ em_to_mesh: [[0.001, 0, 0], [0, 0, 0.001], [0, -0.001, 0]] });
  const below = new Float32Array([0, 0, -40000, 0, 0, -20000, 0, 0, 3000]);
  assert.equal(M.meshSide(flat, below), -1);
  const f = M.defaultCamera3d(flat, { side: -1 });
  assert.ok(near(dot(dirOf(f), [0, 1, 0]), -Math.sin(Math.PI / 3), 1e-9), 'looks up at the plane from the mesh side');
  assert.ok(f.tilt < -0.9);
  const g = M.defaultCamera3d(flat, { side: 1 });
  assert.ok(near(dot(dirOf(g), [0, 1, 0]), Math.sin(Math.PI / 3), 1e-9));
});

test('3D fit: mesh ∪ planes centred and filling the view from the camera angle, not a sphere about the soma', () => {
  // a neuron whose soma (the origin) sits at one end of its arbor: 200 × 80 × 60 µm, soma at x = −180
  const pts = [];
  for (const x of [-20, 180]) for (const y of [-70, 10]) for (const z of [-30, 30]) pts.push([x, y, z]);
  for (const cam of [{ yaw: Math.PI / 6, tilt: Math.PI / 9 }, { yaw: Math.PI / 6, tilt: -Math.PI / 3 }, { yaw: 2.6, tilt: 1.2 }]) {
    const f = M.fitView3d(pts, cam);
    // the camera basis three.js lookAt builds (up = +y): z = d, x = up × d, y = d × x
    const d = [Math.sin(cam.yaw) * Math.cos(cam.tilt), Math.sin(cam.tilt), Math.cos(cam.yaw) * Math.cos(cam.tilt)];
    const xl = Math.hypot(d[2], d[0]);
    const ax = [d[2] / xl, 0, -d[0] / xl];
    const ay = [d[1] * ax[2] - d[2] * ax[1], d[2] * ax[0] - d[0] * ax[2], d[0] * ax[1] - d[1] * ax[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const u = pts.map((p) => dot(p, ax) - dot(f.target, ax));
    const v = pts.map((p) => dot(p, ay) - dot(f.target, ay));
    assert.ok(near(Math.max(...u), f.hw, 1e-6) && near(Math.min(...u), -f.hw, 1e-6), 'centred and tight across');
    assert.ok(near(Math.max(...v), f.hh, 1e-6) && near(Math.min(...v), -f.hh, 1e-6), 'centred and tight up and down');
    const sphere = Math.max(...pts.map((p) => Math.hypot(...p)));   // the old frame: every corner's distance to the soma
    assert.ok(Math.max(f.hw, f.hh) < 0.75 * sphere, 'at least a third bigger on screen than the sphere about the soma');
  }
  assert.deepEqual(M.fitView3d([], { yaw: 0, tilt: 0 }), { target: [0, 0, 0], hw: 100, hh: 100 });
});

test('footprint opacity: 0 below a 12 µm view, 0.7 above 36 µm, linear between', () => {
  assert.equal(M.footprintAlpha(5), 0);
  assert.equal(M.footprintAlpha(12), 0);
  assert.ok(near(M.footprintAlpha(24), 0.35));
  assert.equal(M.footprintAlpha(36), 0.7);
  assert.equal(M.footprintAlpha(500), 0.7);
});

test('mesh cut: a closed contour per crossing, chained across triangles; the plane axes per panel', () => {
  // a 2 × 2 × 2 cube centred on the origin (12 triangles, shared vertices)
  const P = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
  const I = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  const xy = cutMesh(P, I, 'z', 0.25);
  assert.equal(xy.length, 1);
  assert.equal(xy[0].closed, true);
  const pts = xy[0].pts;
  for (let i = 0; i < pts.length; i += 2) assert.ok(Math.abs(Math.abs(pts[i]) - 1) < 1e-6 || Math.abs(Math.abs(pts[i + 1]) - 1) < 1e-6, 'on the square');
  assert.ok(pts.length / 2 >= 4);
  const xz = cutMesh(P, I, 'y', 0.5);
  assert.equal(xz.length, 1);
  assert.equal(xz[0].closed, true);
  const yz = cutMesh(P, I, 'x', -0.5);
  assert.equal(yz.length, 1);
  assert.deepEqual(cutMesh(P, I, 'z', 5), [], 'a plane that misses');
  assert.deepEqual(cutMesh(P, I, 'q', 0), []);
  assert.deepEqual(boundsOf(P), [-1, -1, -1, 1, 1, 1]);
  // non-indexed soup works too (one open strip per triangle pair is still chained by shared edge points)
  const soup = new Float32Array([...I].flatMap((k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]));
  assert.equal(cutMesh(soup, null, 'z', 0.25).reduce((s, l) => s + l.pts.length, 0) > 0, true);
});

test('outline paths: rings → plane nm (stack, level, XZ, YZ swapped); border runs of a cut-off cell are left out', () => {
  const e = v2();
  const m = M.outlineMap(e, 'stack', 0, 2);
  assert.deepEqual([m.ax + m.bx * 0, m.ay + m.by * 0], [-3770, -1920]);
  assert.deepEqual([m.ax + m.bx * 1280, m.ay + m.by * 1280], [1350, 3200], 'edge-based: 640 px · q');
  const ml = M.outlineMap(e, 'level', 5, 2);
  assert.deepEqual([ml.ax + ml.bx * 596, ml.ay + ml.by * 1300], [40966, 113408]);
  const mz = M.outlineMap(e, 'yz', 0, 2);
  assert.equal(mz.swap, true);
  class P2 { constructor() { this.ops = []; } moveTo(x, y) { this.ops.push(['M', x, y]); } lineTo(x, y) { this.ops.push(['L', x, y]); } closePath() { this.ops.push(['Z']); } }
  const ident = { ax: 0, bx: 1, ay: 0, by: 1, swap: false };
  const inside = ringsPath([[10, 10, 20, 10, 20, 20, 10, 20]], ident, 100, 100, P2);
  assert.deepEqual(inside.ops.map((o) => o[0]).join(''), 'MLLLL', 'closed: back to the first vertex');
  // a cell leaving the image at the top: the ring closes along the border (y = 0) — that run is not drawn
  const cut = ringsPath([[10, 0, 30, 0, 30, 20, 10, 20]], ident, 100, 100, P2);
  assert.deepEqual(cut.ops, [['M', 30, 0], ['L', 30, 20], ['L', 10, 20], ['L', 10, 0]]);
  const swapped = ringsPath([[1, 2, 3, 2, 3, 4]], { ...ident, swap: true }, Infinity, Infinity, P2);
  assert.deepEqual(swapped.ops[0], ['M', 2, 1]);
  assert.deepEqual(rowRuns([162, 89, 90, 91, 5]), [[5, 5], [89, 91], [162, 162]]);
});
