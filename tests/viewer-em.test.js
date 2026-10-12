// EmViewer pure parts (js/viewer/em-viewer.js): atlas layout (assets.md: 512 px tiles, 8 columns, row-major),
// mask colouring (data-orange @32 %, only mask pixels), fit/zoom/pan maths, sampling choice.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const em = await import('../js/viewer/em-viewer.js');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('tileRect: slice k at column k % 8, row ⌊k / 8⌋ of a 4096 × 2048 atlas', () => {
  assert.deepEqual(em.tileRect(0), { sx: 0, sy: 0, sw: 512, sh: 512 });
  assert.deepEqual(em.tileRect(16), { sx: 0, sy: 1024, sw: 512, sh: 512 }, 'the soma tile');
  assert.deepEqual(em.tileRect(9), { sx: 512, sy: 512, sw: 512, sh: 512 });
  const last = em.tileRect(31);
  assert.equal(last.sx + last.sw, 4096); assert.equal(last.sy + last.sh, 2048);
});

test('clampSlice: 0 … n−1, rounded; non-numbers → the middle (the soma slice)', () => {
  assert.equal(em.clampSlice(-3), 0);
  assert.equal(em.clampSlice(99), 31);
  assert.equal(em.clampSlice(4.6), 5);
  assert.equal(em.clampSlice(NaN), 16);
  assert.equal(em.clampSlice(undefined, 32), 16);
});

test('colouriseMask: data-orange at 32 % where the mask is set, transparent elsewhere', () => {
  const src = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 127, 127, 127, 255, 128, 128, 128, 255]);
  const out = new Uint8ClampedArray(src.length);
  const n = em.colouriseMask(src, out);
  assert.equal(n, 2);
  assert.deepEqual([...out.slice(0, 4)], [0xdf, 0x9a, 0x00, Math.round(0.32 * 255)]);
  assert.deepEqual([...out.slice(4, 8)], [0, 0, 0, 0]);
  assert.deepEqual([...out.slice(8, 12)], [0, 0, 0, 0]);
  assert.deepEqual([...out.slice(12, 16)], [0xdf, 0x9a, 0x00, 82]);
  assert.deepEqual([...em.MASK_RGB], [0xdf, 0x9a, 0x00]);
  assert.equal(em.MASK_ALPHA, 0.32);
  // in place (the viewer reuses the ImageData buffer)
  const inplace = new Uint8ClampedArray([255, 255, 255, 255]);
  em.colouriseMask(inplace, inplace);
  assert.deepEqual([...inplace], [0xdf, 0x9a, 0x00, 82]);
});

test('emLayout: cover fills the viewer, contain shows the whole 8.192 µm field; pan in µm (+y up)', () => {
  const cover = em.emLayout({ w: 375, h: 780 });
  near(cover.scale, 780 / 512); near(cover.dw, 780); near(cover.pxPerUm, 780 / 8.192);
  near(cover.dx, (375 - 780) / 2); near(cover.dy, 0);
  const contain = em.emLayout({ w: 375, h: 780, fit: 'contain' });
  near(contain.dw, 375); near(contain.dx, 0); near(contain.dy, (780 - 375) / 2);
  const panned = em.emLayout({ w: 400, h: 400, zoom: 2, panX: 1, panY: 1 });
  near(panned.pxPerUm, (400 / 512) * 2 * 512 / 8.192);
  near(panned.dx, 200 - 400 + panned.pxPerUm);
  near(panned.dy, 200 - 400 - panned.pxPerUm, 1e-9);
});

test('emZoomAbout keeps the image point under the cursor; zoom clamped 0.5–8×', () => {
  const v = { zoom: 1, panX: 0.5, panY: -0.25 };
  const k = 50;
  const sx = 60, sy = 30;
  const u = { x: (sx - v.panX * k) / k, y: (sy - v.panY * k) / k };
  const z = em.emZoomAbout(v, 2, sx, sy, k);
  const k2 = 100;
  near((sx - z.panX * k2) / k2, u.x); near((sy - z.panY * k2) / k2, u.y);
  assert.equal(em.emZoomAbout({ zoom: 8, panX: 0, panY: 0 }, 2, 0, 0, 10).zoom, 8);
  assert.equal(em.emZoomAbout({ zoom: 0.5, panX: 0, panY: 0 }, 0.1, 0, 0, 10).zoom, 0.5);
});

test('clampPan keeps a quarter of the image on screen', () => {
  const L = em.emLayout({ w: 400, h: 400 });
  const c = em.clampPan({ zoom: 1, panX: 1e6, panY: -1e6 }, L, 400, 400);
  near(c.panX, (200 + L.dw / 4) / L.pxPerUm); near(c.panY, -(200 + L.dh / 4) / L.pxPerUm);
});

test('smoothingFor: linear while shrinking, nearest once an image pixel spans ≥ 2 device px; explicit modes win', () => {
  assert.equal(em.smoothingFor('auto', 0.73, 2), true);
  assert.equal(em.smoothingFor('auto', 1.2, 2), false);
  assert.equal(em.smoothingFor('auto', 1.9, 1), true);
  assert.equal(em.smoothingFor('nearest', 0.3, 1), false);
  assert.equal(em.smoothingFor('linear', 6, 2), true);
  assert.deepEqual([...em.SAMPLING], ['auto', 'nearest', 'linear']);
});

test('the EM module never formats a voxel size, thickness or z-step', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/viewer/em-viewer.js', import.meta.url), 'utf8');
  assert.ok(!/voxel_nm|\bnm\b.*slice|thickness\s*[:=]/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
});

test('acquireImage/releaseImage: viewers of the same Blob share one decode; the last release closes it', async () => {
  let decodes = 0;
  let closed = 0;
  const decoder = async () => { decodes++; return { width: 4096, close() { closed++; } }; };
  const blob = { size: 1 };
  const a = await em.acquireImage(blob, decoder);
  const b = await em.acquireImage(blob, decoder);
  assert.equal(decodes, 1, 'decoded once');
  assert.equal(a, b, 'same image');
  em.releaseImage(blob);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(closed, 0, 'still used by the other viewer');
  em.releaseImage(blob);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(closed, 1, 'closed by the last release');
  await em.acquireImage(blob, decoder);
  assert.equal(decodes, 2, 'a later viewer decodes afresh');
  em.releaseImage(blob);
  assert.equal(await em.acquireImage(null, decoder), null, 'no blob → null');
  em.releaseImage(null);
  // a failed decode is not cached
  const bad = { size: 2 };
  let fail = true;
  const flaky = async () => { if (fail) throw new Error('decode'); return { close() {} }; };
  await assert.rejects(em.acquireImage(bad, flaky));
  em.releaseImage(bad);
  fail = false;
  assert.ok(await em.acquireImage(bad, flaky), 'retried after a failure');
  em.releaseImage(bad);
});
