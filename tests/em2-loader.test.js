// EM format 2 asset loading (em-v2-spec.md §8.6): gated fetches with the device header, streamed with progress and a
// no-progress watchdog (a stalled body is retried once, then reported), a memo shared by the prefetch and the stage,
// one decode at a time, and the half-resolution retry when a decode fails.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const L = await import('../js/viewer/em2/loader.js');
const api = await import('../js/api.js');
const { PRODUCTION_API } = await import('../config.js');

const A = (c) => `/v1/asset/${c.repeat(64)}.webp`;
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Response whose body yields `chunks` (Uint8Array) one per `gap` ms, optionally stalling before chunk `stallAt`. */
function streamed(chunks, { gap = 1, stallAt = -1, signal } = {}) {
  let i = 0;
  const body = new ReadableStream({
    async pull(ctrl) {
      if (i === stallAt) {
        await new Promise((resolve) => { if (signal) signal.addEventListener('abort', resolve); });
        ctrl.error(new DOMException('aborted', 'AbortError'));
        return;
      }
      if (i >= chunks.length) { ctrl.close(); return; }
      await sleep(gap);
      ctrl.enqueue(chunks[i++]);
    },
  });
  const total = chunks.reduce((s, c) => s + c.length, 0);
  return new Response(body, { status: 200, headers: { 'Content-Length': String(total), 'Content-Type': 'image/webp' } });
}

test('emBlob: device header, streamed progress, one fetch per path (memo); a gated asset → ApiError 404', async () => {
  const prev = L.setLoaderTimings({ streamFrom: 1 });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith(A('4'))) return new Response('{"error":{"code":"not_found"}}', { status: 404 });
    return streamed([new Uint8Array(4), new Uint8Array(6)], { signal: init.signal });
  };
  try {
    const seen = [];
    const blob = await L.emBlob(A('1'), { onProgress: (a, b) => seen.push([a, b]), expectBytes: 10 });
    assert.equal(blob.size, 10);
    assert.deepEqual(seen.at(-1), [10, 10]);
    assert.ok(seen.length >= 2, 'progress while streaming');
    assert.equal(calls[0].url, `${PRODUCTION_API}${A('1')}`);
    assert.equal(calls[0].init.headers['X-NG-Device'], await api.getDeviceId());
    assert.equal(calls[0].init.credentials, 'omit');
    await L.emBlob(A('1'));
    assert.equal(calls.length, 1, 'memoised');
    await assert.rejects(L.emBlob(A('4')), (e) => e instanceof api.ApiError && e.status === 404);
    assert.equal(L.emMemoStats().entries, 1, 'a failure is not memoised');
  } finally {
    globalThis.fetch = realFetch;
    L.setLoaderTimings(prev);
    L.setEmAssetSource(null);
  }
});

test('a stalled body is aborted after the no-progress window, retried once, then reported as a timeout', async () => {
  const prev = L.setLoaderTimings({ streamFrom: 1, stall: 40 });
  let n = 0;
  globalThis.fetch = async (url, init) => { n++; return streamed([new Uint8Array(3), new Uint8Array(3)], { stallAt: 1, signal: init.signal }); };
  try {
    await assert.rejects(L.emBlob(A('2')), (e) => e instanceof api.ApiError && e.code === 'timeout' && e.isNetwork);
    assert.equal(n, 2, 'one retry');
    // a retry that gets through succeeds
    n = 0;
    globalThis.fetch = async (url, init) => { n++; return n === 1 ? streamed([new Uint8Array(3)], { stallAt: 0, signal: init.signal }) : streamed([new Uint8Array(5)]); };
    assert.equal((await L.emBlob(A('3'))).size, 5);
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = realFetch;
    L.setLoaderTimings(prev);
    L.setEmAssetSource(null);
  }
});

test('decodes are serialised, closed after the upload, and retried at half resolution when they fail', async () => {
  const realCIB = globalThis.createImageBitmap;
  const events = [];
  globalThis.createImageBitmap = async (blob, opts = {}) => {
    if (blob.size === 99 && !opts.resizeWidth) throw new DOMException('out of memory', 'EncodingError');
    const bmp = { width: opts.resizeWidth || 8, height: opts.resizeHeight || 8, close() { events.push(`close ${blob.size}`); } };
    events.push(`decode ${blob.size}${opts.resizeWidth ? ' half' : ''}`);
    return bmp;
  };
  try {
    const a = L.withDecoded(new Blob([new Uint8Array(10)]), [8, 8], async (bmp, { scale }) => { events.push(`upload 10 ×${scale}`); await sleep(20); });
    const b = L.withDecoded(new Blob([new Uint8Array(99)]), [2560, 2560], async (bmp, { scale }) => { events.push(`upload 99 ×${scale} ${bmp.width}`); });
    await Promise.all([a, b]);
    assert.deepEqual(events, ['decode 10', 'upload 10 ×1', 'close 10', 'decode 99 half', 'upload 99 ×0.5 1280', 'close 99']);
  } finally {
    globalThis.createImageBitmap = realCIB;
  }
});

test('the R8 feature-test image: a lossless 4 × 4 WebP of the known greys', () => {
  const blob = L.testWebpBlob();
  assert.equal(blob.type, 'image/webp');
  assert.ok(blob.size > 20 && blob.size < 80);
  assert.deepEqual(L.TEST_GREYS, [0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255]);
});
