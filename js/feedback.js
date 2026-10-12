// Prototype feedback loop (ARCHITECTURE.md §3.2; contracts/api.md "Product feedback").
//
//   <FeedbackLayer hidden />  mounted by app.js: the "✎ Feedback" button (bottom-left above the tab bar, hidden in
//                             full view, review and sheets, Settings toggle) and the "N of your notes were addressed
//                             in vX →" notice; flushes the offline queue at boot, on 'online' and on resume.
//   FeedbackSheet             sheet id 'feedback' (app.js SHEETS): category chips, text, screenshot (downscaled to
//                             ≤ 1600 px JPEG), the visible auto-context line, Send → POST /v1/feedback or the queue.
//   YourFeedback              Settings → Your feedback: "Show feedback button", Write feedback, waiting + sent notes
//                             with status words, replies and "fixed in vX".
//
// IndexedDB keys: feedback:queue  [{ qid, body, queued_at }] notes not yet accepted by the server
//                 feedback:seen   { feedback_id: signature } replies/fixes already announced
//                 cache:feedback  last GET /v1/feedback/mine (offline list; cleared on a device move)
// Settings: session.settings.feedbackButton (default true).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from './ui/html.js';
import { store, useStore, showToast, openSheet, setSettings } from './store.js';
import * as api from './api.js';
import * as idb from './idb.js';
import { Sheet } from './ui/sheet.js';
import { Chip, Button, Toggle } from './ui/components.js';
import { haptic } from './fx/haptics.js';
import { navigate, getRoute } from './router.js';
import { resolveTodayView } from './game.js';
import { FEEDBACK_ENABLED } from '../config.js';
import { VERSION } from '../version.js';

loadCss('css/feedback.css');

export const CATEGORIES = Object.freeze([
  { id: 'ui', label: 'UI' }, { id: 'ux', label: 'UX' }, { id: 'data', label: 'Data' },
  { id: 'bug', label: 'Bug' }, { id: 'idea', label: 'Idea' }, { id: 'other', label: 'Other' },
]);
/** Status → word (ARCHITECTURE.md §3.2) + tone class; every state is colour + word. */
export const STATUS_WORDS = Object.freeze({
  new: { word: 'New', tone: 'muted' },
  seen: { word: 'Seen', tone: 'soft' },
  planned: { word: 'Planned', tone: 'warn' },
  done: { word: 'Done ✓', tone: 'accent' },
  wontfix: { word: 'Won’t fix', tone: 'muted' },
});
export const MAX_TEXT = 2000;
export const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
export const MAX_SIDE_PX = 1600;
const QUEUE_KEY = 'feedback:queue';
const SEEN_KEY = 'feedback:seen';
const CACHE_KEY = 'cache:feedback';
const NOTICE_MS = 9000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (tests/feedback.test.js)

/** Compare "0.3.2"-style versions numerically (missing parts = 0; a suffix after the 3 numbers is ignored). */
export function cmpVersion(a, b) {
  const pa = String(a || '').split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
  const pb = String(b || '').split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Which screen the player is on: { screen (≤ 64, e.g. "round:type"), label, round_id?, stage? }. */
export function describeScreen(route, today) {
  const name = route && route.name;
  if (!name) return { screen: 'unknown', label: 'unknown screen' };
  if (name.startsWith('today')) {
    const t = today || {};
    if (!t.rounds || !t.rounds.length) {
      const st = t.status && t.status !== 'ready' ? t.status : 'empty';
      return { screen: `today:${st}`, label: `today · ${st === 'empty' ? 'no rounds' : st}` };
    }
    const v = resolveTodayView(t, name, route.params || {});
    const r = v.index ? t.rounds[v.index - 1] : null;
    const st = v.index ? (t.progress || [])[v.index - 1] : null;
    const rid = r && r.round_id ? { round_id: r.round_id } : {};
    if (v.kind === 'round') {
      const stage = st ? st.stage : 'type';
      return { screen: `round:${stage}`, label: `round ${v.index} · ${stage} stage`, ...rid, stage };
    }
    if (v.kind === 'reveal') return { screen: 'reveal', label: `reveal · round ${v.index}`, ...rid, stage: 'done' };
    if (v.kind === 'summary') return { screen: 'summary', label: 'day summary' };
    return { screen: 'today:empty', label: 'today · no rounds' };
  }
  return { screen: name, label: name };
}

/**
 * The auto-captured context: { screen, context (api.md shape), line (what the player sees), route }.
 * env = { route, today, online, hash, width, height, dpr, ua, standalone, version }
 */
export function buildContext(env) {
  const d = describeScreen(env.route, env.today);
  const width = Math.max(0, Math.round(env.width || 0));
  const height = Math.max(0, Math.round(env.height || 0));
  const dpr = env.dpr > 0 ? Math.round(env.dpr * 100) / 100 : 1;
  const context = {
    route: String(env.hash || '#/').slice(0, 200),
    ...(d.round_id ? { round_id: d.round_id } : {}),
    ...(d.stage ? { stage: d.stage } : {}),
    app_version: String(env.version || VERSION),
    viewport: [width, height],
    dpr,
    ua: String(env.ua || '').slice(0, 200),
    standalone: !!env.standalone,
    online: env.online !== false,
  };
  const parts = [d.label, `v${context.app_version}`, `${width}×${height}${dpr !== 1 ? ` @${dpr}x` : ''}`,
    context.standalone ? 'installed app' : 'browser'];
  if (!context.online) parts.push('offline');
  return { screen: d.screen.slice(0, 64), context, line: parts.join(' · '), route: context.route };
}

/** The current context, read from the page (browser only). */
export function captureContext() {
  const w = typeof window !== 'undefined' ? window : {};
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  let standalone = nav.standalone === true;
  try { standalone = standalone || (!!w.matchMedia && w.matchMedia('(display-mode: standalone)').matches); } catch (_) { /* old browsers */ }
  const s = store.get();
  return buildContext({
    route: getRoute(), today: s.today, online: s.ui.online !== false && nav.onLine !== false,
    hash: typeof location !== 'undefined' ? location.hash || '#/' : '#/',
    width: w.innerWidth, height: w.innerHeight, dpr: w.devicePixelRatio || 1, ua: nav.userAgent, standalone,
  });
}

/** Signature of what the player has been told about a note (status, fix version, reply). */
export const signatureOf = (it) => `${it.status}|${it.fixed_in || ''}|${it.reply || ''}`;

/**
 * What to announce from GET /v1/feedback/mine. `seen` = { id: signature }.
 * addressed: done with fixed_in ≤ the running version (the update with the fix is installed);
 * replies:   a reply that is not such a fix (planned / won't fix / done without a version).
 * A done note whose fixed_in is newer than the running app waits until the app updates.
 */
export function newsFrom(items, seen, version = VERSION) {
  const addressed = [];
  const replies = [];
  for (const it of items || []) {
    if (!it || (seen && seen[it.feedback_id] === signatureOf(it))) continue;
    if (it.status === 'done' && it.fixed_in) {
      if (cmpVersion(it.fixed_in, version) <= 0) addressed.push(it);
    } else if (it.reply) {
      replies.push(it);
    }
  }
  return { addressed, replies };
}

/** "2 of your notes were addressed in v0.3.2 →" (+ " · 1 new reply"); null when there is nothing to say. */
export function noticeText({ addressed, replies }, version = VERSION) {
  const r = replies.length ? `${replies.length} new ${replies.length === 1 ? 'reply' : 'replies'}` : '';
  if (addressed.length) {
    const versions = [...new Set(addressed.map((i) => i.fixed_in))];
    const v = versions.length === 1 ? versions[0] : version;
    const n = addressed.length;
    return `${n} of your notes ${n === 1 ? 'was' : 'were'} addressed in v${v}${r ? ` · ${r}` : ''} →`;
  }
  if (replies.length) return `${r[0].toUpperCase()}${r.slice(1)} to your feedback →`;
  return null;
}

/**
 * The note as the Worker accepts it (api.md: no control characters except newlines): CR LF / CR → LF, tabs → two
 * spaces, other control characters dropped, trimmed. Pasted text (a spreadsheet row, code) would otherwise be a 400.
 */
export function cleanNoteText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
}

/** Fit (w, h) inside maxPx on the long side, never upscaling. */
export function fitSize(w, h, maxPx = MAX_SIDE_PX) {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const s = Math.min(1, maxPx / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Decoded size of a base64 data URL. */
export function dataUrlBytes(dataUrl) {
  const i = String(dataUrl).indexOf(',');
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : '';
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "3 Oct" in the player's time zone. */
export function fmtDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Local queue id (crypto.getRandomValues works on plain-http LAN pages, where randomUUID does not). */
function localId() {
  const b = new Uint8Array(8);
  try { crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------------------
// Screenshot: any image the browser decodes → ≤ 1600 px JPEG data URL ≤ 3 MB (browser only)

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be read.')); };
    img.src = url;
  });
}

export async function downscaleImage(file, { maxPx = MAX_SIDE_PX, maxBytes = MAX_SCREENSHOT_BYTES } = {}) {
  const { img, url } = await loadImage(file);
  try {
    const { w, h } = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height, maxPx);
    if (!w || !h) throw new Error('This image is empty.');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h); // transparent pixels would turn black in JPEG anyway; make it explicit
    g.drawImage(img, 0, 0, w, h);
    for (const q of [0.85, 0.72, 0.6, 0.45]) {
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('This browser cannot encode JPEG.');
      const bytes = dataUrlBytes(dataUrl);
      if (bytes <= maxBytes) return { dataUrl, width: w, height: h, bytes };
    }
    throw new Error('This image is too large even after shrinking.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------------------------------------
// State (store slice `feedback`, additive), queue, sending, news

const initial = { notice: null, queue: [], mine: null, mineStatus: 'idle', focusList: 0 };
function slice() {
  if (!store.get().feedback) store.set({ feedback: { ...initial } });
  return store.get().feedback;
}
function patch(p) { slice(); store.update('feedback', p); }

const queueMeta = (q) => q.map((e) => ({ qid: e.qid, text: e.body.text, category: e.body.category, queued_at: e.queued_at, has_screenshot: !!e.body.screenshot }));

async function readQueue() {
  const q = await idb.get(QUEUE_KEY);
  return Array.isArray(q) ? q.filter((e) => e && e.body && typeof e.body.text === 'string') : [];
}
async function writeQueue(q) {
  await idb.set(QUEUE_KEY, q);
  patch({ queue: queueMeta(q) });
}

export async function enqueue(body, now = Date.now()) {
  const q = await readQueue();
  q.push({ qid: localId(), body, queued_at: new Date(now).toISOString() });
  await writeQueue(q);
  return q.length;
}

/** Network failures, server errors and the hourly cap keep a note for later; a 400 never will succeed. */
export const isRetryable = (err) => !!err && (err.status === 0 || err.status >= 500 || err.status === 429 || err.code === 'rate_limited');

/** Send now, or keep it in the queue: → { status: 'sent' | 'queued' | 'error', id?, err?, reason? }. */
export async function submitFeedback(body, { send = api.sendFeedback } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await enqueue(body);
    return { status: 'queued', reason: 'offline' };
  }
  try {
    const resp = await send(body);
    flushQueue({ send }); // the connection works: send anything still waiting
    return { status: 'sent', id: resp && resp.feedback_id };
  } catch (err) {
    if (isRetryable(err)) {
      await enqueue(body);
      return { status: 'queued', reason: err.status === 429 || err.code === 'rate_limited' ? 'rate' : 'offline', err };
    }
    return { status: 'error', err };
  }
}

/** The Worker takes ≤ 2 POSTs per second per device: queued notes go out this far apart. */
export const FLUSH_GAP_MS = 600;
const RETRY_FIRST_MS = 30000;
const RETRY_MAX_MS = 15 * 60000;
let retryTimer = null;
let retryDelay = RETRY_FIRST_MS;
/** A flush stopped on a transport/server/rate failure with notes left: try again later (30 s, doubling to 15 min),
 * so a note queued while the Worker was unreachable (the phone was online all along: no 'online' event) still goes. */
function scheduleRetry() {
  if (retryTimer || typeof window === 'undefined') return;
  retryTimer = setTimeout(() => { retryTimer = null; flushQueue(); }, retryDelay);
  if (typeof retryTimer.unref === 'function') retryTimer.unref(); // never keeps a test process alive
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

let flushing = null;
/** Send queued notes oldest first, FLUSH_GAP_MS apart; stops at the first network/server/rate failure. → number sent. */
export function flushQueue({ send = api.sendFeedback, gapMs = FLUSH_GAP_MS } = {}) {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    let stopped = false;
    try {
      let q = await readQueue();
      while (q.length) {
        const [head] = q;
        try {
          await send(head.body);
          sent++;
        } catch (err) {
          if (isRetryable(err)) { stopped = true; break; }
          console.warn('[feedback] dropping a queued note the server refused:', err && err.message);
        }
        q = (await readQueue()).filter((e) => e.qid !== head.qid);
        await writeQueue(q);
        if (q.length && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      }
      if (!q.length) patch({ queue: [] });
    } catch (err) {
      console.warn('[feedback] queue flush failed', err);
    } finally {
      flushing = null;
    }
    if (stopped) scheduleRetry();
    else {
      retryDelay = RETRY_FIRST_MS;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    }
    if (sent) {
      if (typeof document !== 'undefined') showToast(sent === 1 ? 'Your saved note was sent' : `${sent} saved notes were sent`, { glyph: '✓', kind: 'accent' });
      refreshMine();
    }
    return sent;
  })();
  return flushing;
}

/** GET /v1/feedback/mine → store + cache. → items | null */
export async function refreshMine() {
  if (!FEEDBACK_ENABLED) return null;
  const cur = slice();
  if (cur.mineStatus !== 'ready') patch({ mineStatus: 'loading' });
  try {
    const resp = await api.getMyFeedback();
    const items = Array.isArray(resp && resp.items) ? resp.items : [];
    patch({ mine: items, mineStatus: 'ready' });
    idb.set(CACHE_KEY, items);
    return items;
  } catch (err) {
    if (!slice().mine) {
      const cached = await idb.get(CACHE_KEY);
      patch(Array.isArray(cached) ? { mine: cached, mineStatus: 'cached' } : { mineStatus: 'error' });
    } else {
      patch({ mineStatus: 'cached' });
    }
    return null;
  }
}

async function markSeen(items) {
  if (!items.length) return;
  const seen = (await idb.get(SEEN_KEY)) || {};
  for (const it of items) seen[it.feedback_id] = signatureOf(it);
  await idb.set(SEEN_KEY, seen);
}

/** The notice waits (in the store) until it can be seen: no sheet, full view or review on top. FeedbackLayer shows
 * it for NOTICE_MS and only then counts its notes as announced, so a notice raised behind onboarding is not lost. */
function setNotice(text, items = []) {
  patch({ notice: text ? { text, id: Date.now(), items } : null });
}

/** Announce fixes that reached this version and new replies (once each). */
export async function checkNews() {
  const items = await refreshMine();
  if (!items) return null;
  const seen = (await idb.get(SEEN_KEY)) || {};
  const news = newsFrom(items, seen, VERSION);
  const text = noticeText(news, VERSION);
  if (text) setNotice(text, [...news.addressed, ...news.replies]);
  return text;
}

export function openFeedbackList() {
  setNotice(null);
  patch({ focusList: Date.now() });
  navigate('/settings?section=feedback');
}

let started = false;
/** Boot wiring (FeedbackLayer calls it once): queue → store, flush, then the news check. */
export function initFeedback() {
  if (started || !FEEDBACK_ENABLED || typeof window === 'undefined') return;
  started = true;
  slice();
  readQueue().then((q) => patch({ queue: queueMeta(q) }));
  window.addEventListener('online', () => { flushQueue(); });
  let lastCheck = 0;
  const check = () => {
    lastCheck = Date.now();
    flushQueue().finally(() => checkNews());
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 5 * 60000) check();
  });
  setTimeout(check, 2500); // after Today, /me and onboarding have settled
}

// ---------------------------------------------------------------------------------------------------------
// UI

let draft = null; // { category, text, shot } kept if the sheet is closed without sending
let focusPillOnReturn = false;

/** Open the Feedback sheet with the context of the screen it was opened from. */
export function openFeedback({ fromKeyboard = false, category } = {}) {
  focusPillOnReturn = fromKeyboard;
  openSheet('feedback', { origin: captureContext(), category });
}

function FeedbackButton() {
  const ref = useRef(null);
  useEffect(() => {
    if (focusPillOnReturn && ref.current) { focusPillOnReturn = false; ref.current.focus({ preventScroll: true }); }
  }, []);
  return html`<button type="button" ref=${ref} class="fb-pill" aria-label="Send feedback about this screen"
    onClick=${(e) => { haptic('selection'); openFeedback({ fromKeyboard: e.detail === 0 }); }}>
    <span class="fb-pill-glyph" aria-hidden="true">✎</span><span>Feedback</span>
  </button>`;
}

/**
 * app.js: the button in its strip above the tab bar (.fb-dock: reserved space, so it never covers the screen) + the
 * "addressed" notice. hidden = no tab bar (full view, review, full-screen sheets): no strip. While a bottom sheet is
 * open the strip stays (nothing behind the scrim reflows) but the button is gone.
 */
export function FeedbackLayer({ hidden = false }) {
  const show = useStore((s) => s.session.settings.feedbackButton !== false);
  const notice = useStore((s) => (s.feedback ? s.feedback.notice : null));
  const sheetOpen = useStore((s) => !!s.ui.sheet);
  useEffect(() => { initFeedback(); }, []);
  const shown = notice && !hidden && !sheetOpen ? notice : null;
  useEffect(() => {
    if (!shown) return undefined;
    markSeen(shown.items || []);
    const t = setTimeout(() => { const cur = slice().notice; if (cur && cur.id === shown.id) patch({ notice: null }); }, NOTICE_MS);
    return () => clearTimeout(t);
  }, [shown && shown.id]);
  if (!FEEDBACK_ENABLED) return null;
  return html`
    ${show && !hidden ? html`<div class="fb-dock">${sheetOpen ? null : html`<${FeedbackButton} />`}</div>` : null}
    <div class="toast-host fb-notice-host" aria-live="polite">
      ${shown ? html`<button type="button" key=${shown.id} class="toast is-accent fb-notice"
        onClick=${() => { haptic('selection'); openFeedbackList(); }}>
        <span class="toast-glyph" aria-hidden="true">✓</span><span>${shown.text}</span></button>` : null}
    </div>`;
}

function errorText(err) {
  if (!err) return 'Could not send. Try again.';
  if (err.status === 400) return `The server refused this note: ${err.message}`;
  return err.message || 'Could not send. Try again.';
}

export function FeedbackSheet({ onClose, origin: originProp, category: presetCategory }) {
  const [origin] = useState(() => originProp || captureContext());
  const [category, setCategory] = useState((draft && draft.category) || presetCategory || 'ui');
  const [text, setText] = useState((draft && draft.text) || '');
  const [shot, setShot] = useState((draft && draft.shot) || null);
  const [shotBusy, setShotBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [sending, setSending] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const keepDraft = useRef(true);
  const latest = useRef(null);
  latest.current = { category, text, shot };

  // Runs after <Sheet> focused itself (parent effects run after child effects): the text area gets the caret.
  useEffect(() => { if (taRef.current) taRef.current.focus({ preventScroll: true }); }, []);
  // Escape / scrim keep an unsent draft for the next open; Cancel and Send drop it.
  useEffect(() => () => { draft = keepDraft.current ? latest.current : null; }, []);
  const cancel = () => { keepDraft.current = false; onClose(); };

  const trimmed = cleanNoteText(text);
  const len = Array.from(trimmed).length;
  const tooLong = len > MAX_TEXT;
  const canSend = !!trimmed && !tooLong && !sending && !shotBusy;

  const pickFile = async (e) => {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!file) return;
    setShotBusy(true);
    setMsg(null);
    try {
      const out = await downscaleImage(file);
      setShot({ ...out, name: file.name || 'screenshot' });
      haptic('light');
    } catch (err) {
      setMsg({ kind: 'error', text: err.message || 'This image could not be attached.' });
    } finally {
      setShotBusy(false);
    }
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setMsg(null);
    const body = {
      text: trimmed,
      category,
      screen: origin.screen,
      context: { ...origin.context, online: store.get().ui.online !== false && navigator.onLine !== false },
      ...(shot ? { screenshot: shot.dataUrl } : {}),
    };
    const res = await submitFeedback(body);
    if (res.status === 'error') {
      haptic('error');
      setSending(false);
      setMsg({ kind: 'error', text: errorText(res.err) });
      return;
    }
    haptic('success');
    keepDraft.current = false;
    onClose();
    if (res.status === 'sent') {
      showToast('Thanks — sent', { kind: 'accent', glyph: '✓' });
      refreshMine();
    } else {
      showToast(res.reason === 'rate' ? 'Saved. 10 notes an hour max: it sends later.' : 'Saved. It sends when you are back online.', { glyph: '↻', duration: 3600 });
    }
  };

  return html`<${Sheet} label="Send feedback" onClose=${onClose} class="fb-sheet">
    <div class="stack-4">
      <span class="overline">Prototype feedback</span>
      <span class="sheet-title" id="fb-title">What should change?</span>
    </div>
    <div class="chips fb-cats" role="group" aria-label="Category">
      ${CATEGORIES.map((c) => html`<${Chip} key=${c.id} active=${category === c.id} onClick=${() => setCategory(c.id)}>${c.label}</${Chip}>`)}
    </div>
    ${category === 'data' ? html`<span class="t-micro t-muted fb-hint">A wrong cell type, a bad mesh or a wrong fact on one round?
      “Report a problem” on that round’s reveal sends it straight to the data review.</span>` : null}
    <div class="field">
      <textarea ref=${taRef} id="fb-text" class="input fb-text" rows="5" aria-labelledby="fb-title" aria-describedby="fb-count fb-ctx"
        placeholder="What did you expect, what happened, what would be better?" value=${text}
        onInput=${(e) => { setText(e.currentTarget.value); setMsg(null); }}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}></textarea>
      <span id="fb-count" class=${cx('t-num-11 fb-count', tooLong ? 't-error' : 't-muted')}>${tooLong ? '✕ ' : ''}${len} / ${MAX_TEXT}</span>
    </div>
    <div class="fb-attach">
      <input ref=${fileRef} type="file" accept="image/*" class="sr-only" tabIndex="-1" aria-hidden="true" onChange=${pickFile} />
      ${shot ? html`<div class="fb-shot">
          <img class="fb-thumb" src=${shot.dataUrl} alt="Attached screenshot" />
          <span class="stack-4"><span class="t-label">Screenshot attached</span>
            <span class="t-num-11 t-muted">${shot.width}×${shot.height} · ${fmtBytes(shot.bytes)}</span></span>
          <${Button} variant="text" class="fb-remove" onClick=${() => setShot(null)}>Remove</${Button}>
        </div>`
    : html`<${Button} variant="outline" size="sm" block disabled=${shotBusy} onClick=${() => fileRef.current && fileRef.current.click()}>
          ${shotBusy ? 'Shrinking…' : '+ Attach screenshot'}</${Button}>`}
    </div>
    <p class="fb-context" id="fb-ctx">
      <span class="overline">Sent with</span>
      <span class="t-num-11 fb-ctx-line">${origin.line}</span>
      <span class="t-num-11 t-muted fb-ctx-route">${origin.route}</span>
    </p>
    ${msg ? html`<span class=${cx('fb-msg', msg.kind === 'error' ? 't-error' : 't-soft')} role="alert">✕ ${msg.text}</span>` : null}
    <div class="grid-1-2">
      <${Button} variant="outline" onClick=${cancel}>Cancel</${Button}>
      <${Button} disabled=${!canSend} haptic="selection" onClick=${send}>${sending ? 'Sending…' : 'Send'}</${Button}>
    </div>
  </${Sheet}>`;
}

export default FeedbackSheet;

// ---------------------------------------------------------------------------------------------------------
// Settings → Your feedback

function StatusWord({ status }) {
  const s = STATUS_WORDS[status] || { word: status, tone: 'muted' };
  return html`<span class=${cx('fb-status', `is-${s.tone}`)}>${s.word}</span>`;
}

function FeedbackItem({ it }) {
  const cat = CATEGORIES.find((c) => c.id === it.category);
  const future = it.fixed_in && cmpVersion(it.fixed_in, VERSION) > 0;
  return html`<li class="fb-item">
    <div class="fb-item-head">
      <${StatusWord} status=${it.status} />
      <span class="t-num-11 t-muted">${cat ? cat.label : it.category} · ${fmtDay(it.at)}</span>
    </div>
    <p class="t-body fb-item-text">${it.text}</p>
    ${it.reply ? html`<div class="fb-reply"><span class="overline">Reply</span><p class="t-body t-soft">${it.reply}</p></div>` : null}
    ${it.fixed_in ? html`<span class=${cx('t-num-11', future ? 't-muted' : 't-accent')}>${future
    ? `Fixed in v${it.fixed_in} · this app is v${VERSION}, the update comes on the next reload`
    : `✓ Fixed in v${it.fixed_in}`}</span>` : null}
  </li>`;
}

export function YourFeedback() {
  const fb = useStore((s) => s.feedback || initial);
  const show = useStore((s) => s.session.settings.feedbackButton !== false);
  const online = useStore((s) => s.ui.online);
  const ref = useRef(null);
  const lastFocus = useRef(fb.focusList);

  useEffect(() => {
    slice();
    readQueue().then((q) => patch({ queue: queueMeta(q) }));
    setNotice(null);
    refreshMine().then((items) => {
      // Reading the list counts as being told; fixes for a newer version still get their "addressed" notice.
      if (items) markSeen(items.filter((it) => !(it.status === 'done' && it.fixed_in && cmpVersion(it.fixed_in, VERSION) > 0)));
    });
  }, []);

  // #/settings?section=feedback (the notice, from another screen) or a notice tap while already here → the list
  const reveal = () => requestAnimationFrame(() => {
    const sec = ref.current && ref.current.closest('section');
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'start' });
    if (ref.current) ref.current.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (new URLSearchParams(location.hash.split('?')[1] || '').get('section') === 'feedback') reveal();
  }, []);
  useEffect(() => {
    if (fb.focusList !== lastFocus.current) { lastFocus.current = fb.focusList; reveal(); }
  }, [fb.focusList]);

  const items = fb.mine || [];
  return html`<div class="card st-card fb-mine" ref=${ref} tabIndex="-1" aria-label="Your feedback">
    <${Toggle} label="Show feedback button" hint="The ✎ Feedback button above the tab bar" checked=${show}
      onChange=${(v) => setSettings({ feedbackButton: v })} />
    <${Button} variant="outline" block haptic="selection" onClick=${() => openFeedback({ fromKeyboard: false })}>✎ Write feedback</${Button}>
    ${fb.queue.length ? html`<div class="fb-queue" role="status">
      <span class="overline is-warn">↻ Waiting to send · ${fb.queue.length}</span>
      <ul class="fb-list">${fb.queue.map((q) => html`<li key=${q.qid} class="fb-item is-queued">
        <span class="t-num-11 t-muted">${(CATEGORIES.find((c) => c.id === q.category) || {}).label || q.category} · ${fmtDay(q.queued_at)}${q.has_screenshot ? ' · screenshot' : ''}</span>
        <p class="t-body fb-item-text">${q.text}</p></li>`)}</ul>
      <${Button} variant="text" disabled=${!online} onClick=${() => flushQueue()}>${online ? 'Try sending now' : 'Sends when you are online'}</${Button}>
    </div>` : null}
    ${fb.mineStatus === 'error' && !items.length ? html`<span class="t-body t-soft">${online ? 'Could not load your notes. Try again later.' : 'Your notes need a connection.'}</span>`
    : fb.mine === null ? html`<span class="t-body t-soft">Loading your notes…</span>`
      : !items.length ? (fb.queue.length ? null : html`<span class="t-body t-soft">No notes yet. Tap ✎ Feedback on any screen to say what should change; replies and fixes show up here.</span>`)
        : html`<ul class="fb-list" aria-label="Sent notes">${items.map((it) => html`<${FeedbackItem} key=${it.feedback_id} it=${it} />`)}</ul>`}
    ${fb.mineStatus === 'cached' && items.length ? html`<span class="t-micro t-muted">Saved copy: replies refresh when you are online.</span>` : null}
  </div>`;
}
