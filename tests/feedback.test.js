// Prototype feedback loop (js/feedback.js; ARCHITECTURE.md §3.2): context capture, news ("addressed in vX"),
// the offline queue, image sizing, LAN phone mode in config.js and the uuid fallback for plain-http pages.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// No network in unit tests: anything that slips through fails fast as a transport error.
globalThis.fetch = async () => { throw new TypeError('fetch disabled in unit tests'); };

const fb = await import('../js/feedback.js');
const { ApiError } = await import('../js/api.js');
const idb = await import('../js/idb.js');
const { resolveConfig, isLanHost, PRODUCTION_API, DEV_API, FEEDBACK_ENABLED } = await import('../config.js');
const { VERSION } = await import('../version.js');

const today = {
  status: 'ready',
  rounds: [1, 2, 3, 4, 5].map((n) => ({ round_id: `r${n}xxxxxxxxxxxxxxx`, round_index: n })),
  progress: [{ stage: 'done' }, { stage: 'method' }, null, null, null],
  revealAck: [true, false, false, false, false],
};
const route = (name, params = {}) => ({ name, params });

test('cmpVersion: numeric, missing parts are 0', () => {
  assert.equal(fb.cmpVersion('0.3.2', '0.3.10'), -1);
  assert.equal(fb.cmpVersion('0.10.0', '0.9.9'), 1);
  assert.equal(fb.cmpVersion('1.0', '1.0.0'), 0);
  assert.equal(fb.cmpVersion('0.3.2-beta.1', '0.3.2'), 0);
});

test('describeScreen: round stage, reveal, summary, empty Today and the other tabs', () => {
  assert.deepEqual(fb.describeScreen(route('today-round', { n: '3' }), today),
    { screen: 'round:type', label: 'round 3 · type stage', round_id: 'r3xxxxxxxxxxxxxxx', stage: 'type' });
  assert.deepEqual(fb.describeScreen(route('today-round', { n: '2' }), today),
    { screen: 'round:method', label: 'round 2 · method stage', round_id: 'r2xxxxxxxxxxxxxxx', stage: 'method' });
  assert.equal(fb.describeScreen(route('today-reveal', { n: '1' }), today).screen, 'reveal');
  assert.equal(fb.describeScreen(route('today-reveal', { n: '1' }), today).stage, 'done');
  // #/today resolves to the first unfinished round (round 2, method stage)
  assert.equal(fb.describeScreen(route('today'), today).screen, 'round:method');
  const allDone = { ...today, progress: today.rounds.map(() => ({ stage: 'done' })), revealAck: [true, true, true, true, true] };
  assert.equal(fb.describeScreen(route('today'), allDone).screen, 'summary');
  assert.equal(fb.describeScreen(route('today'), { status: 'loading', rounds: [] }).screen, 'today:loading');
  assert.equal(fb.describeScreen(route('today'), { status: 'ready', rounds: [] }).screen, 'today:empty');
  assert.equal(fb.describeScreen(route('library'), today).screen, 'library');
  assert.equal(fb.describeScreen(route('settings'), today).screen, 'settings');
  assert.equal(fb.describeScreen(null, today).screen, 'unknown');
});

test('buildContext: the api.md context shape, a bounded ua, and the visible line', () => {
  const ua = 'U'.repeat(300);
  const c = fb.buildContext({
    route: route('today-round', { n: '3' }), today, online: true, hash: '#/today/round/3',
    width: 390.4, height: 844, dpr: 3, ua, standalone: true, version: '0.3.1',
  });
  assert.equal(c.screen, 'round:type');
  assert.deepEqual(Object.keys(c.context).sort(), ['app_version', 'dpr', 'online', 'round_id', 'route', 'stage', 'standalone', 'ua', 'viewport']);
  assert.deepEqual(c.context.viewport, [390, 844]);
  assert.equal(c.context.ua.length, 200);
  assert.equal(c.context.route, '#/today/round/3');
  assert.equal(c.line, 'round 3 · type stage · v0.3.1 · 390×844 @3x · installed app');
  const off = fb.buildContext({ route: route('library'), today, online: false, hash: '#/library', width: 375, height: 780, dpr: 1, ua: 'x', standalone: false });
  assert.equal(off.line, `library · v${VERSION} · 375×780 · browser · offline`);
  assert.equal('round_id' in off.context, false);
  assert.equal(off.context.online, false);
});

test('newsFrom / noticeText: fixes announce once the running version has them; replies once; seen ones never again', () => {
  const items = [
    { feedback_id: 'a', status: 'done', fixed_in: '0.3.2', reply: 'Smaller pill.' },
    { feedback_id: 'b', status: 'done', fixed_in: '0.3.2', reply: null },
    { feedback_id: 'c', status: 'done', fixed_in: '0.3.3', reply: 'Next build.' }, // newer than the app: waits
    { feedback_id: 'd', status: 'planned', fixed_in: null, reply: 'Will do with the Library rework.' },
    { feedback_id: 'e', status: 'seen', fixed_in: null, reply: null },
    { feedback_id: 'f', status: 'new', fixed_in: null, reply: null },
  ];
  const news = fb.newsFrom(items, {}, '0.3.2');
  assert.deepEqual(news.addressed.map((i) => i.feedback_id), ['a', 'b']);
  assert.deepEqual(news.replies.map((i) => i.feedback_id), ['d']);
  assert.equal(fb.noticeText(news, '0.3.2'), '2 of your notes were addressed in v0.3.2 · 1 new reply →');
  const seen = Object.fromEntries([...news.addressed, ...news.replies].map((i) => [i.feedback_id, fb.signatureOf(i)]));
  const later = fb.newsFrom(items, seen, '0.3.3');
  assert.deepEqual(later.addressed.map((i) => i.feedback_id), ['c']);
  assert.equal(fb.noticeText(later, '0.3.3'), '1 of your notes was addressed in v0.3.3 →');
  // a changed status re-announces
  const changed = items.map((i) => (i.feedback_id === 'd' ? { ...i, status: 'wontfix', reply: 'Out of scope.' } : i));
  assert.deepEqual(fb.newsFrom(changed, { ...seen, c: fb.signatureOf(items[2]) }, '0.3.3').replies.map((i) => i.feedback_id), ['d']);
  assert.equal(fb.noticeText({ addressed: [], replies: [items[3]] }), '1 new reply to your feedback →');
  assert.equal(fb.noticeText({ addressed: [], replies: [] }), null);
  // different fix versions → the running version is named
  assert.equal(fb.noticeText({ addressed: [{ fixed_in: '0.3.1' }, { fixed_in: '0.3.2' }], replies: [] }, '0.3.2'), '2 of your notes were addressed in v0.3.2 →');
});

test('fitSize never upscales and keeps the long side ≤ 1600; dataUrlBytes; fmtBytes', () => {
  assert.deepEqual(fb.fitSize(1179, 2556), { w: 738, h: 1600 });
  assert.deepEqual(fb.fitSize(2556, 1179), { w: 1600, h: 738 });
  assert.deepEqual(fb.fitSize(800, 600), { w: 800, h: 600 });
  assert.deepEqual(fb.fitSize(0, 600), { w: 0, h: 0 });
  assert.equal(fb.dataUrlBytes('data:image/jpeg;base64,/9j/4A=='), 4);
  assert.equal(fb.dataUrlBytes(`data:image/png;base64,${Buffer.alloc(3000).toString('base64')}`), 3000);
  assert.equal(fb.fmtBytes(240 * 1024), '240 KB');
  assert.equal(fb.fmtBytes(2.5 * 1024 * 1024), '2.5 MB');
});

test('submitFeedback: sent, queued on network/5xx/429, refused (400) is an error and not queued', async () => {
  await idb.del('feedback:queue');
  const body = (t) => ({ text: t, category: 'ui', screen: 'library', context: {} });
  const ok = await fb.submitFeedback(body('sent'), { send: async () => ({ feedback_id: 'X' }) });
  assert.deepEqual(ok, { status: 'sent', id: 'X' });
  const net = await fb.submitFeedback(body('net'), { send: async () => { throw new ApiError(0, 'network', 'down'); } });
  assert.equal(net.status, 'queued');
  assert.equal(net.reason, 'offline');
  const rate = await fb.submitFeedback(body('rate'), { send: async () => { throw new ApiError(429, 'rate_limited', 'slow'); } });
  assert.equal(rate.reason, 'rate');
  const bad = await fb.submitFeedback(body('bad'), { send: async () => { throw new ApiError(400, 'bad_request', 'text must not be empty.'); } });
  assert.equal(bad.status, 'error');
  const q = await idb.get('feedback:queue');
  assert.deepEqual(q.map((e) => e.body.text), ['net', 'rate']);
  assert.ok(q.every((e) => /^[0-9a-f]{16}$/.test(e.qid) && !Number.isNaN(Date.parse(e.queued_at))));
});

test('flushQueue: oldest first, stops at a transport failure, drops what the server refuses', async () => {
  await idb.set('feedback:queue', ['one', 'two', 'three', 'four'].map((t, i) => ({ qid: `q${i}`, body: { text: t }, queued_at: '2026-10-03T10:00:00Z' })));
  const seen = [];
  let calls = 0;
  const send = async (b) => {
    calls++;
    if (b.text === 'two') throw new ApiError(400, 'bad_request', 'nope');
    if (b.text === 'three' && calls < 5) throw new ApiError(0, 'network', 'down');
    seen.push(b.text);
    return { feedback_id: b.text };
  };
  assert.equal(await fb.flushQueue({ send, gapMs: 0 }), 1); // one sent, two dropped, stop at three
  assert.deepEqual((await idb.get('feedback:queue')).map((e) => e.body.text), ['three', 'four']);
  assert.equal(await fb.flushQueue({ send, gapMs: 0 }), 0); // still offline for three (calls = 4)
  assert.equal(await fb.flushQueue({ send, gapMs: 0 }), 2);
  assert.deepEqual(seen, ['one', 'three', 'four']);
  assert.deepEqual(await idb.get('feedback:queue'), []);
});

test('flushQueue paces queued notes under the Worker\'s 2 POSTs/s per device', async () => {
  assert.ok(fb.FLUSH_GAP_MS >= 500);
  await idb.set('feedback:queue', ['a', 'b', 'c'].map((t, i) => ({ qid: `p${i}`, body: { text: t }, queued_at: '2026-10-03T10:00:00Z' })));
  const at = [];
  assert.equal(await fb.flushQueue({ send: async () => { at.push(Date.now()); return {}; }, gapMs: 60 }), 3);
  assert.ok(at[1] - at[0] >= 55 && at[2] - at[1] >= 55, `gaps ${at[1] - at[0]}, ${at[2] - at[1]}`);
});

test('cleanNoteText: what the Worker accepts (newlines kept, tabs → spaces, other control characters dropped)', () => {
  assert.equal(fb.cleanNoteText('  a\tb\r\nc\rd\u0007e\u009f  '), 'a  b\nc\nde');
  assert.equal(fb.cleanNoteText('\n\t \n'), '');
  assert.equal(fb.cleanNoteText('Kenyon cell ✓ — fine'), 'Kenyon cell ✓ — fine');
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(fb.cleanNoteText('x\u0000\u001b[31my\u0085')));
});

test('config: LAN phone mode uses the page host on :8787, never the dev overrides; localhost and production unchanged', () => {
  for (const h of ['192.168.1.20', '10.0.0.7', '172.16.4.2', '172.31.255.1', '169.254.3.3', 'freds-mac.local', '[fd12:3456::1]', 'fe80::1']) {
    assert.equal(isLanHost(h), true, h);
  }
  for (const h of ['172.32.0.1', '8.8.8.8', '192.169.0.1', 'localhost', 'user.github.io', '.local', '300.1.1.1']) {
    assert.equal(isLanHost(h), false, h);
  }
  const lan = resolveConfig({ hostname: '192.168.1.20', search: '?api=https://evil.example&now=2026-10-03T00:00:00Z', protocol: 'http:' });
  assert.equal(lan.apiBase, 'http://192.168.1.20:8787');
  assert.equal(lan.isLan, true);
  assert.equal(lan.isLocal, false);
  assert.equal(lan.debugNow, null, 'debug-now stays localhost-only');
  assert.equal(lan.registerSW, false);
  assert.equal(resolveConfig({ hostname: 'freds-mac.local', search: '' }).apiBase, 'http://freds-mac.local:8787');
  assert.equal(resolveConfig({ hostname: '[fd12::1]', search: '', protocol: 'http:' }).apiBase, 'http://[fd12::1]:8787');
  assert.equal(resolveConfig({ hostname: 'localhost', search: '' }).apiBase, DEV_API);
  assert.equal(resolveConfig({ hostname: 'localhost', search: '' }).isLan, false);
  assert.equal(resolveConfig({ hostname: 'user.github.io', search: '' }).apiBase, PRODUCTION_API);
  // a public institute address still counts as the dev stack when the page comes from the dev port 5173
  assert.equal(resolveConfig({ hostname: '131.111.8.20', port: '5173', search: '', protocol: 'http:' }).apiBase, 'http://131.111.8.20:8787');
  assert.equal(resolveConfig({ hostname: '131.111.8.20', port: '', search: '' }).apiBase, PRODUCTION_API);
  assert.equal(resolveConfig({ hostname: 'user.github.io', search: '' }).feedbackEnabled, FEEDBACK_ENABLED);
});

test('device id: a uuid v4 from crypto.getRandomValues when crypto.randomUUID is missing (plain-http LAN page)', async () => {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    await idb.del('deviceId');
    const api = await import(`../js/api.js?insecure=${Date.now()}`);
    const id = await api.getDeviceId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    delete globalThis.crypto.randomUUID;
    if (desc) assert.equal(typeof globalThis.crypto.randomUUID, 'function');
  }
});
