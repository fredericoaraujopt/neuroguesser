// Library tab + detail sheet (ARCHITECTURE.md §3 "Library", §3.1 "Atlas coverage grows"; contracts/api.md
// "Library and review"; handoff screen 5).
//
//   header "Library" + mono "N seen · M named"
//   due card: thumbs of the due types (from entries) + "Review N cells · ~2 min" (N = review queue length),
//             then a "✓ Review done…" note once the queue is empty (written by review.js into IndexedDB)
//   atlas coverage per species_common (4 px accent meter + mono seen/total; the fill animates from the value
//             this device last saw, kept in IndexedDB)
//   species chips (All + every species with a seen type), 2-column card grid (thumb, name, species · region,
//             "#33·2", status word), infinite scroll by next_before, detail sheet (large thumb, name, fact,
//             Open neuron profile → #/library/cell/<date>/<n> (v0.6.0, profile.js), Neuroglancer ↗, Close)
//   offline: the cached first page (IndexedDB 'cache:library'), read-only (no review, no older pages).
//
// Exports: default Library, openLibraryDetail(props), LibraryDetailSheet(props) (app.js sheet 'libraryDetail'),
// and the data helpers review.js shares: loadLibrary, loadReviewQueue, Thumb, todayDate, REVIEW_DONE_KEY.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { store, useStore, openSheet } from '../store.js';
import * as api from '../api.js';
import * as idb from '../idb.js';
import { navigate } from '../router.js';
import { Button, Chip, Meter, OfflineChip } from '../ui/components.js';
import { Sheet } from '../ui/sheet.js';
import { useCountUp } from '../fx/celebrate.js';
import { haptic } from '../fx/haptics.js';
import { fmtPts } from '../format.js';
import { utcDate } from '../time.js';

loadCss('css/library.css');

const PAGE = 60;
const CACHE_KEY = 'cache:library';             // { data, at } — GET /v1/library first page (idb.js key list)
const ATLAS_KEY = 'library:atlasSeen';         // { [species_common]: seen } last values this device showed
export const REVIEW_DONE_KEY = 'library:reviewDone'; // { date, named, total, note } — written by review.js
const THUMB_KEY = (path) => `library:thumb:${path}`; // Blob, for offline thumbnails
const QUEUE_FRESH_MS = 60000;
const INTERVALS = [2, 7, 21];
const DAY_MS = 86400000;

// ======================================================================================
// Data
// ======================================================================================

/** The server's UTC date (today slice when loaded, else the clock-offset-corrected local clock). */
export function todayDate() {
  const t = store.get().today;
  return t.todayDate || (!t.graceActive && t.date) || utcDate();
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
export const roundTag = (dayNumber, roundIndex) => `#${dayNumber}·${roundIndex}`;

/**
 * Cells the due card's button promises: the review queue's length when it has items, else min(due, 5) (the
 * queue's cap). An empty queue while types are still due is stale (dropped by answers, or a failed reload), not
 * "nothing to review": the Review screen fetches its own queue.
 */
export function reviewCellCount(queueItems, dueCount) {
  if (Array.isArray(queueItems) && queueItems.length) return queueItems.length;
  return Math.min(Math.max(0, dueCount | 0), 5);
}
/** Rough duration copy for the due card: "~1 min" for 1–2 cells, "~2 min" otherwise. */
export const reviewMinutes = (n) => (n <= 2 ? 1 : 2);
const libState = () => store.get().library;

/** Keep the tab badge (me.due_count) in step with the library's due list. */
function syncDueBadge(dueCount) {
  store.set((s) => (s.session.me && s.session.me.due_count !== dueCount
    ? { session: { ...s.session, me: { ...s.session.me, due_count: dueCount } } }
    : null));
}

let libraryInflight = null;

/**
 * Load (or refresh) the first page. Renders the IndexedDB copy first when the store is empty, then the network
 * result; a network failure keeps the cached copy on screen read-only (status 'offline').
 */
export function loadLibrary() {
  if (libraryInflight) return libraryInflight;
  libraryInflight = (async () => {
    if (!libState().data) {
      store.update('library', { status: 'loading', error: null });
      const cached = await idb.get(CACHE_KEY);
      if (cached && cached.data && !libState().data) store.update('library', { data: cached.data, fromCache: true });
    }
    try {
      const data = await api.getLibrary({ limit: PAGE });
      store.update('library', { status: 'ready', data, fromCache: false, error: null, moreError: null, loadingMore: false, loadedAt: Date.now() });
      idb.set(CACHE_KEY, { data, at: Date.now() });
      keepOfflineThumbs(data.entries.map((e) => e.thumb));
      prefetchOfflineThumbs(data.entries.map((e) => e.thumb));
      syncDueBadge(data.due.length);
      // the queue only sharpens the due card ("Review N cells"); a failure must not surface as an unhandled rejection
      if (data.due.length) loadReviewQueue().catch(() => {});
      else store.update('library', { queue: { items: [], at: Date.now() } });
      return { ok: true, resp: data, err: null };
    } catch (err) {
      const offline = err instanceof api.ApiError && err.isNetwork;
      store.update('library', { status: offline ? 'offline' : 'error', error: err, fromCache: !!libState().data });
      return { ok: false, resp: null, err };
    }
  })().finally(() => { libraryInflight = null; });
  return libraryInflight;
}

/** Next page by next_before (infinite scroll). Merges into store.library.data.entries. */
export async function loadMoreLibrary() {
  const { data, loadingMore, status } = libState();
  if (!data || !data.next_before || loadingMore || status !== 'ready') return;
  store.update('library', { loadingMore: true, moreError: null });
  try {
    const page = await api.getLibrary({ before: data.next_before, limit: PAGE });
    store.update('library', (l) => {
      if (l.data !== data) return { loadingMore: false }; // refreshed meanwhile: drop this page
      const have = new Set(l.data.entries.map((e) => e.round_id));
      const entries = l.data.entries.concat(page.entries.filter((e) => !have.has(e.round_id)));
      return { loadingMore: false, data: { ...l.data, entries, next_before: page.next_before } };
    });
  } catch (err) {
    store.update('library', { loadingMore: false, moreError: err });
  }
}

let queueInflight = null;
/** GET /v1/review/queue → store.library.queue = { items, at } (null when it failed). */
export function loadReviewQueue() {
  if (queueInflight) return queueInflight;
  queueInflight = api.getReviewQueue()
    .then((q) => { store.update('library', { queue: { items: q.items, at: Date.now() } }); return q.items; })
    .catch((err) => { if (!libState().queue) store.update('library', { queue: null }); throw err; })
    .finally(() => { queueInflight = null; });
  return queueInflight;
}

/** The queue loaded in the last minute (so Review starts without a spinner), else null. */
export function freshQueue() {
  const q = libState().queue;
  return q && q.items && q.items.length && Date.now() - q.at < QUEUE_FRESH_MS ? q.items : null;
}

// ======================================================================================
// Thumbnails: api.assetObjectURL (gated, memoised) + an IndexedDB Blob copy for offline
// ======================================================================================

const thumbPromises = new Map();
const thumbResolved = new Map();
let offlineThumbs = null; // thumbs of the cached first page: the only ones kept in IndexedDB (bounded, ~60)

/** Offline copies follow the cached first page: drop the others, allow these. */
function keepOfflineThumbs(paths) {
  offlineThumbs = new Set(paths);
  idb.keys(THUMB_KEY('')).then((keys) => {
    for (const k of keys) if (!offlineThumbs.has(k.slice(THUMB_KEY('').length))) idb.del(k);
  }).catch(() => {});
}

let prefetching = false;
/**
 * Copy the cached first page's thumbnails into IndexedDB in the background (idle time, 2 at a time, skipped with
 * Save-Data), so the saved library shows them offline even for cards that never scrolled into view online.
 * Stops at the first network failure; already-stored thumbnails are not fetched again.
 */
function prefetchOfflineThumbs(paths) {
  if (prefetching || typeof navigator === 'undefined') return;
  if (navigator.connection && navigator.connection.saveData) return;
  prefetching = true;
  const queue = [...new Set(paths.filter(Boolean))];
  const worker = async () => {
    while (queue.length) {
      const path = queue.shift();
      if (offlineThumbs && !offlineThumbs.has(path)) continue;
      try {
        if (await idb.get(THUMB_KEY(path))) continue;
        const blob = await api.assetBlob(path);
        if (!offlineThumbs || offlineThumbs.has(path)) await idb.set(THUMB_KEY(path), blob);
      } catch (err) {
        if (err instanceof api.ApiError && err.isNetwork) queue.length = 0;
      }
    }
  };
  const start = () => { Promise.all([worker(), worker()]).finally(() => { prefetching = false; }); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 4000 });
  else setTimeout(start, 1500);
}

export function thumbURL(path) {
  if (!path) return Promise.reject(new Error('no thumb'));
  if (thumbPromises.has(path)) return thumbPromises.get(path);
  const p = (async () => {
    try {
      const url = await api.assetObjectURL(path);
      if (!offlineThumbs || offlineThumbs.has(path)) {
        idb.get(THUMB_KEY(path)).then((have) => {
          if (!have) return api.assetBlob(path).then((b) => idb.set(THUMB_KEY(path), b));
          return undefined;
        }).catch(() => {});
      }
      return url;
    } catch (err) {
      const blob = await idb.get(THUMB_KEY(path));
      if (blob && typeof Blob !== 'undefined' && blob instanceof Blob) return URL.createObjectURL(blob);
      throw err;
    }
  })();
  thumbPromises.set(path, p);
  p.then((url) => thumbResolved.set(path, url), () => thumbPromises.delete(path));
  return p;
}

/** Thumbnail on the sunken data background; fetched when it scrolls near the viewport. */
export function Thumb({ path, alt = '', eager = false, class: klass }) {
  const ref = useRef(null);
  const [url, setUrl] = useState(() => thumbResolved.get(path) || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const known = thumbResolved.get(path) || null;
    setUrl(known);
    setFailed(false);
    if (!path || known) return undefined;
    let alive = true;
    const start = () => thumbURL(path).then((u) => { if (alive) setUrl(u); }, () => { if (alive) setFailed(true); });
    const el = ref.current;
    if (eager || !el || typeof IntersectionObserver === 'undefined') { start(); return () => { alive = false; }; }
    const io = new IntersectionObserver((list) => {
      if (list.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    }, { root: el.closest('.screen'), rootMargin: '320px 0px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [path]);

  return html`<div ref=${ref} class=${cx('lib-thumb', klass)}>
    ${url ? html`<img src=${url} alt=${alt} decoding="async" draggable="false" />`
      : failed ? html`<span class="lib-thumb-miss" aria-hidden="true">—</span>` : null}
  </div>`;
}

// ======================================================================================
// Status words (colour + word/glyph)
// ======================================================================================

const OUTCOME = {
  named: { word: '✓ named', title: '✓ Named', tone: 'accent' },
  met: { word: '✓ met', title: '✓ Met', tone: 'accent' },
  missed: { word: '✕ missed', title: '✕ Missed', tone: 'error' },
};

export function entryStatus(entry) {
  if (entry.review && entry.review.due) return { word: '↻ review', tone: 'warn' };
  return OUTCOME[entry.outcome] || OUTCOME.missed;
}

// ======================================================================================
// Screen
// ======================================================================================

export default function Library() {
  const lib = useStore((s) => s.library);
  const online = useStore((s) => s.ui.online);
  const [filter, setFilter] = useState('All');
  const [memory, setMemory] = useState(null); // { atlas: {sp: seen}, reviewDone } as stored before this visit

  useEffect(() => {
    loadLibrary();
    let alive = true;
    Promise.all([idb.get(ATLAS_KEY), idb.get(REVIEW_DONE_KEY)]).then(([atlas, reviewDone]) => {
      if (alive) setMemory({ atlas: atlas && typeof atlas === 'object' ? atlas : {}, reviewDone: reviewDone || null });
    });
    return () => { alive = false; };
  }, []);

  // back online while showing the saved copy → refresh; a new UTC day (rollover) → refresh (due list moves)
  useEffect(() => { if (online && (lib.status === 'offline')) loadLibrary(); }, [online]);
  const dayKey = useStore((s) => s.today.todayDate);
  const firstDay = useRef(dayKey);
  useEffect(() => {
    if (!dayKey || dayKey === firstDay.current) return;
    const rolled = !!firstDay.current; // null → first /today load after boot (mount already loaded): no second fetch
    firstDay.current = dayKey;
    if (rolled) loadLibrary();
  }, [dayKey]);

  // remember what the atlas showed (fresh data only), so the next visit animates from here
  const data = lib.data;
  useEffect(() => {
    if (!data || lib.fromCache || !memory) return;
    idb.set(ATLAS_KEY, Object.fromEntries(data.atlas.map((a) => [a.species_common, a.seen])));
  }, [data, lib.fromCache, !!memory]);

  // a species filter that no longer has entries (e.g. after a refresh) falls back to All
  const speciesSeen = data ? data.atlas.filter((a) => a.seen > 0).map((a) => a.species_common) : [];
  useEffect(() => {
    if (filter !== 'All' && data && !speciesSeen.includes(filter)) setFilter('All');
  }, [data]);

  if (!data) {
    if (lib.status === 'offline') return html`<${NoDataState} offline />`;
    if (lib.status === 'error') return html`<${NoDataState} error=${lib.error} />`;
    return html`<${LoadingState} />`;
  }

  const readOnly = lib.status === 'offline' || !online;
  const entries = data.entries;
  const shown = filter === 'All' ? entries : entries.filter((e) => e.type.species_common === filter);
  const empty = data.counts.total === 0 && entries.length === 0;

  return html`<div class="screen lib-screen">
    <div class="screen-pad">
      <div class="screen-head">
        <h1 class="t-title lib-h1">Library</h1>
        <span class="lib-counts">${fmtPts(data.counts.total)} seen · ${fmtPts(data.counts.named)} named</span>
      </div>
      ${readOnly ? html`<div class="lib-offline" role="status"><${OfflineChip} force /><span class="t-micro t-muted">Saved library · read-only until you reconnect</span></div>` : null}
      ${lib.status === 'error' ? html`<div class="note lib-error" role="alert">
        <span>✕ Couldn't refresh your library. Showing the last copy.</span>
        <button type="button" class="btn-text" onClick=${() => { haptic('selection'); loadLibrary(); }}>Retry</button>
      </div>` : null}

      ${empty ? html`<${EmptyCard} />` : html`<${DueSection} data=${data} queue=${lib.queue} readOnly=${readOnly} memory=${memory} />`}

      ${memory ? html`<${Atlas} atlas=${data.atlas} from=${memory.atlas} />` : html`<div class="lib-atlas" aria-hidden="true"><span class="card-title-sm">Atlas coverage</span>${data.atlas.map((a) => html`<div key=${a.species_common} class="lib-atlas-row"><span class="sp">${a.species_common}</span><div class="meter"></div><span class="num"> </span></div>`)}</div>`}

      ${speciesSeen.length ? html`<div class="chips" role="group" aria-label="Filter by species">
        ${['All', ...speciesSeen].map((sp) => html`<${Chip} key=${sp} active=${filter === sp} onClick=${() => setFilter(sp)}>${sp}</${Chip}>`)}
      </div>` : null}

      ${shown.length ? html`<ul class="lib-grid fx-stagger" aria-label=${filter === 'All' ? 'Cells you have met' : `${filter} cells you have met`}>
        ${shown.map((e) => html`<li key=${e.round_id}><${CellCard} entry=${e} /></li>`)}
      </ul>` : null}

      ${empty ? null : html`<${GridFoot} lib=${lib} readOnly=${readOnly} shownCount=${shown.length} filter=${filter} />`}
    </div>
  </div>`;
}

function CellCard({ entry }) {
  const st = entryStatus(entry);
  const open = () => { haptic('selection'); openLibraryDetail({ entry }); };
  return html`<button type="button" class="lib-card" onClick=${open}
    aria-label=${`${entry.type.name}, ${entry.type.species_common}, ${entry.type.region}, NeuroGuesser ${roundTag(entry.day_number, entry.round_index)}, ${st.word.slice(2)}`}>
    <${Thumb} path=${entry.thumb} />
    <span class="lib-card-body">
      <span class="lib-card-name">${entry.type.name}</span>
      <span class="lib-card-sub">${entry.type.species_common} · ${entry.type.region}</span>
      <span class="lib-card-foot">
        <span class="lib-card-day">${roundTag(entry.day_number, entry.round_index)}</span>
        <span class=${cx('lib-status', `is-${st.tone}`)}>${st.word}</span>
      </span>
    </span>
  </button>`;
}

/** Infinite scroll: a sentinel under the grid loads the next page while it is near the viewport. */
function GridFoot({ lib, readOnly, shownCount, filter }) {
  const ref = useRef(null);
  const data = lib.data;
  const more = !!data.next_before;
  const canLoad = more && !readOnly && lib.status === 'ready' && !lib.moreError;

  useEffect(() => {
    const el = ref.current;
    if (!canLoad || lib.loadingMore || !el) return undefined;
    if (typeof IntersectionObserver === 'undefined') { loadMoreLibrary(); return undefined; }
    const io = new IntersectionObserver((list) => {
      if (list.some((e) => e.isIntersecting)) { io.disconnect(); loadMoreLibrary(); }
    }, { root: el.closest('.screen'), rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [canLoad, lib.loadingMore, data.next_before, filter]);

  let foot = null;
  if (lib.loadingMore) foot = html`<span role="status">Loading older cells…</span>`;
  else if (lib.moreError) {
    foot = html`<span class="row">✕ Couldn't load older cells
      <button type="button" class="btn-text" onClick=${() => { haptic('selection'); store.update('library', { moreError: null }); loadMoreLibrary(); }}>Retry</button></span>`;
  } else if (more && readOnly) foot = html`<span>Older cells need a connection</span>`;
  else if (!more && shownCount === 0 && filter !== 'All') foot = html`<span>No ${filter} cells yet</span>`;
  else if (!more && shownCount > 6) foot = html`<span>${filter === 'All' ? 'Every cell you have met' : `Every ${filter} cell you have met`} · ${shownCount}</span>`;
  return html`<div class="lib-foot">${foot}<div ref=${ref} class="lib-sentinel" aria-hidden="true"></div></div>`;
}

// ---- due card / review-done note ----

function DueSection({ data, queue, readOnly, memory }) {
  const today = todayDate();
  const dueTypes = data.due || [];
  if (!dueTypes.length) {
    const done = memory && memory.reviewDone && memory.reviewDone.date === today ? memory.reviewDone : null;
    if (done) return html`<div class="note lib-note" role="status">${done.note}</div>`;
    const next = data.entries.map((e) => e.review && e.review.next_review_at).filter((d) => d && d > today).sort()[0];
    if (!next) return null;
    const n = daysBetween(today, next);
    return html`<div class="note lib-note is-quiet">↻ Nothing due today · next review in ${n} ${n === 1 ? 'day' : 'days'}</div>`;
  }

  // thumbs: the newest entry of each due type, in due order (most overdue first); queue items fill gaps
  const byType = new Map();
  for (const e of data.entries) if (!byType.has(e.type.type_id)) byType.set(e.type.type_id, e);
  const qItems = queue && queue.items ? queue.items : [];
  const qByType = new Map(qItems.map((q) => [q.type_id, q]));
  const thumbs = [];
  for (const t of dueTypes) {
    const e = byType.get(t);
    const q = qByType.get(t);
    if (e) thumbs.push({ key: t, thumb: e.thumb, outcome: e.outcome, day: e.day_number, name: e.type.name });
    else if (q) thumbs.push({ key: t, thumb: q.thumb, outcome: q.outcome, day: q.day_number, name: q.name });
    if (thumbs.length === 3) break;
  }

  const n = reviewCellCount(queue && queue.items, dueTypes.length);
  const start = () => { navigate('/review'); };
  const label = readOnly ? 'Offline · review needs a connection' : `Review ${n} ${n === 1 ? 'cell' : 'cells'} · ~${reviewMinutes(n)} min`;
  return html`<section class="card lib-due" aria-label="Due for review">
    <div class="lib-due-head"><span class="card-title">↻ Due for review</span><span class="t-micro t-muted">spaced repetition</span></div>
    ${thumbs.length ? html`<div class="lib-due-thumbs">
      ${thumbs.map((x) => html`<div key=${x.key} class="lib-due-thumb">
        <${Thumb} path=${x.thumb} alt=${x.name} eager />
        <span class="lib-due-label">${x.outcome} #${x.day}</span>
      </div>`)}
    </div>` : null}
    <${Button} block size="sm" haptic="selection" disabled=${readOnly} onClick=${start}>${label}</${Button}>
  </section>`;
}

function EmptyCard() {
  return html`<div class="card lib-empty">
    <span class="overline">Your library</span>
    <span class="card-title">No cells yet</span>
    <span class="t-body t-soft">Every neuron you finish in Today lands here, with a review schedule: missed and met cells come back in 2 days, named ones in 7, then 21.</span>
    <${Button} variant="outline" block size="sm" onClick=${() => navigate('/today')}>Play today's neurons</${Button}>
  </div>`;
}

// ---- atlas coverage (meter fill animates from the last seen value) ----

function Atlas({ atlas, from }) {
  return html`<section class="lib-atlas" aria-label="Atlas coverage">
    <span class="card-title-sm">Atlas coverage</span>
    ${atlas.map((a) => {
      const known = Number.isFinite(from[a.species_common]);
      return html`<${AtlasRow} key=${a.species_common} row=${a} from=${known ? from[a.species_common] : 0} grew=${known && a.seen > from[a.species_common]} />`;
    })}
  </section>`;
}

function AtlasRow({ row, from, grew }) {
  const start = Math.min(from, row.seen);
  const shown = useCountUp(row.seen, { from: start, duration: 700 });
  return html`<div class="lib-atlas-row">
    <span class="sp">${row.species_common}</span>
    <${Meter} value=${row.seen} max=${row.total} from=${start} label=${`${row.species_common}: ${row.seen} of ${row.total} types seen`} />
    <span class=${cx('num', grew && 'is-up')}>${shown}/${row.total}</span>
  </div>`;
}

// ---- states ----

function LoadingState() {
  return html`<div class="screen lib-screen" aria-busy="true"><div class="screen-pad">
    <div class="screen-head"><span class="t-title">Library</span><span class="lib-counts">— seen · — named</span></div>
    <div class="skeleton lib-skel-due"></div>
    <div class="lib-atlas" aria-hidden="true"><span class="card-title-sm">Atlas coverage</span>
      ${[0, 1, 2, 3].map((i) => html`<div key=${i} class="lib-atlas-row"><span class="sp t-muted">—</span><div class="meter"></div><span class="num">—</span></div>`)}
    </div>
    <div class="lib-grid">${[0, 1, 2, 3].map((i) => html`<div key=${i} class="skeleton lib-skel-card"></div>`)}</div>
    <span class="sr-only" role="status">Loading your library…</span>
  </div></div>`;
}

function NoDataState({ offline = false, error = null }) {
  return html`<div class="screen lib-screen"><div class="screen-pad">
    <div class="screen-head"><span class="t-title">Library</span></div>
    <div class="card lib-empty" role=${offline ? 'status' : 'alert'}>
      ${offline ? html`<span class="overline is-warn">! Offline</span>` : html`<span class="overline is-error">✕ Couldn't load</span>`}
      <span class="card-title">${offline ? 'Your library needs a connection' : 'Your library didn’t load'}</span>
      <span class="t-body t-soft">${offline
        ? 'Open the Library once while online and it stays readable offline.'
        : (error && error.message) || 'Something went wrong while loading your library.'}</span>
      <${Button} block size="sm" haptic="selection" onClick=${() => loadLibrary()}>Retry</${Button}>
    </div>
  </div></div>`;
}

// ======================================================================================
// Detail sheet (store.ui.sheet 'libraryDetail')
// ======================================================================================

export function openLibraryDetail(props = {}) { openSheet('libraryDetail', props); }

export function LibraryDetailSheet({ entry, onClose }) {
  if (!entry) {
    return html`<${Sheet} label="Cell details" onClose=${onClose}>
      <span class="t-body t-soft">This cell is no longer in your library.</span>
      <${Button} variant="outline" block size="sm" onClick=${onClose}>Close</${Button}>
    </${Sheet}>`;
  }
  const outcome = OUTCOME[entry.outcome] || OUTCOME.missed;
  const review = entry.review;
  const today = todayDate();
  let reviewLine = null;
  if (review && review.due) reviewLine = html`<span class="lib-status is-warn">↻ due for review</span>`;
  else if (review && review.next_review_at) {
    const n = daysBetween(today, review.next_review_at);
    reviewLine = html`<span class="t-muted">↻ review in <span class="t-num">${n}</span> ${n === 1 ? 'day' : 'days'}</span>`;
  }
  return html`<${Sheet} label=${`${entry.type.name}, details`} onClose=${onClose} class="lib-detail">
    <${Thumb} path=${entry.thumb} alt=${`${entry.type.name}, silhouette`} eager class="is-large" />
    <div class="lib-detail-head">
      <div class="stack-4">
        <span class="sheet-title">${entry.type.name}</span>
        <span class="t-label t-muted"><i>${entry.type.species}</i> · ${entry.type.region}</span>
      </div>
      <span class="t-num-11 t-muted lib-detail-tag">${roundTag(entry.day_number, entry.round_index)}</span>
    </div>
    <div class="lib-detail-meta">
      <span class=${cx('lib-status', `is-${outcome.tone}`)}>${outcome.title}</span>
      <span class="t-num">${fmtPts(entry.score)} pts</span>
      ${reviewLine}
    </div>
    ${entry.fact ? html`<p class="lib-fact">${entry.fact}</p>` : null}
    <${Button} block haptic="selection" onClick=${() => { onClose(); navigate(`/library/cell/${entry.date}/${entry.round_index}`); }}>Open neuron profile</${Button}>
    <div class="grid-2">
      ${entry.neuroglancer_url
        ? html`<${Button} variant="link-outline" size="sm" href=${entry.neuroglancer_url} haptic="selection">Neuroglancer ↗</${Button}>`
        : html`<${Button} variant="outline" size="sm" disabled>Neuroglancer ↗</${Button}>`}
      <${Button} variant="outline" size="sm" onClick=${onClose}>Close</${Button}>
    </div>
  </${Sheet}>`;
}

export { INTERVALS };
