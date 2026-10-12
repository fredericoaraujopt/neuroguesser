// Round actions + pure derive helpers (ARCHITECTURE.md §4.3).
//
// Actions call the API, write resp.state (or err.state on a 409) into store.today.progress[roundIndex-1]
// and resolve to { ok, resp, err } (they never reject), so screens can trigger fx on the result:
//   const r = await guess(2, 'c');  if (r.ok && r.resp.correct) { burst(card); haptic('success'); }
// Pure helpers (no I/O) are unit-tested in tests/game.test.js.
import { store } from './store.js';
import * as api from './api.js';
import { ApiError, FROM_CACHE } from './api.js';
import * as idb from './idb.js';
import { computeOffset, setOffset } from './time.js';
import { strip as fmtStrip, shareText as fmtShareText, doneTotal } from './format.js';
import { navigate } from './router.js';

// ======================================================================================
// Pure helpers
// ======================================================================================

/**
 * Per option id → 'idle' | 'wrong' | 'out' | 'answer'.
 *   wrong  = guessed wrong (state.wrong)            → 45% opacity, strikethrough, "✕ wrong"
 *   out    = ruled out by a paid clue (eliminated)  → 45% opacity, strikethrough, "✕ out"
 *   answer = correct option, once the type stage is over (stage method|done) → "✓ answer"
 * "picked" is local UI state and not part of this.
 */
export function optionStates(roundPublic, roundState) {
  const st = roundState || null;
  const wrong = new Set((st && st.wrong) || []);
  const out = new Set((st && st.eliminated) || []);
  const answer = st && st.stage !== 'type' ? st.correct_option : null;
  const res = {};
  for (const o of (roundPublic && roundPublic.options) || []) {
    res[o.id] = o.id === answer ? 'answer' : wrong.has(o.id) ? 'wrong' : out.has(o.id) ? 'out' : 'idle';
  }
  return res;
}

/** Options still pickable ("N left"); 0 once the type stage is over. */
export function optionsLeft(roundPublic, roundState) {
  if (roundState && roundState.stage !== 'type') return 0;
  return Object.values(optionStates(roundPublic, roundState)).filter((s) => s === 'idle').length;
}

/** 3 − wrong guesses (never negative). */
export function guessesLeft(state) {
  return Math.max(0, 3 - ((state && state.wrong) ? state.wrong.length : 0));
}

export const isDone = (state) => !!state && state.stage === 'done';
export const stageOf = (state) => (state ? state.stage : 'type');

/** Points still available (type stage), type score (method stage) or round score (done). Unstarted = 1,000. */
export function pointsOf(state) { return state ? state.score : 1000; }

/** Σ score of done rounds. */
export function dayTotal(progress) { return doneTotal(progress); }
export function roundsDone(progress) { return (progress || []).filter(isDone).length; }

/** 'named' | 'met' | 'missed' once the type stage is over, else null (derived if the field is absent). */
export function outcomeOf(state) {
  if (!state || state.stage === 'type') return null;
  if (state.outcome) return state.outcome;
  if (state.type_result === 'exhausted') return 'missed';
  return (state.wrong || []).length === 0 && (state.clues_opened || []).length === 0 ? 'named' : 'met';
}

/** A perfect round: named + method right = 1,200. */
export const isPerfect = (state) => isDone(state) && state.score === 1200;

export const strip = fmtStrip;
export const shareText = fmtShareText;

/**
 * Which Today view to show, from the today slice:
 *   { kind: 'round' | 'reveal' | 'summary' | 'empty', index: 1-5 | null, graceOver?: true }
 * - the first round (in order) that is not done → round; a done round whose reveal was not acknowledged
 *   (revealAck) → reveal; all done and acknowledged → summary; no rounds → empty.
 * - grace (today.graceActive): only yesterday's grace.round_indexes count; once they are all done and
 *   acknowledged → { kind: 'empty', graceOver: true } and the controller loads the real today.
 */
export function currentView(today) {
  const rounds = (today && today.rounds) || [];
  if (!rounds.length) return { kind: 'empty', index: null };
  const progress = today.progress || [];
  const ack = today.revealAck || [];
  const grace = today.graceActive && today.grace && Array.isArray(today.grace.round_indexes);
  const indexes = grace
    ? [...today.grace.round_indexes].sort((a, b) => a - b)
    : rounds.map((r, i) => r.round_index || i + 1);
  for (const n of indexes) {
    const st = progress[n - 1];
    if (!isDone(st)) return { kind: 'round', index: n };
    if (!ack[n - 1]) return { kind: 'reveal', index: n };
  }
  return grace ? { kind: 'empty', index: null, graceOver: true } : { kind: 'summary', index: null };
}

export function pathForView(view) {
  if (view.kind === 'round') return `/today/round/${view.index}`;
  if (view.kind === 'reveal') return `/today/reveal/${view.index}`;
  return '/today';
}

/**
 * Resolve a Today route (#/today, #/today/round/:n, #/today/reveal/:n) against the today slice.
 * Returns { kind, index, path, graceOver? }; the controller replaces the hash when path differs.
 * - round/:n done → its reveal if not yet acknowledged, else the automatic view;
 * - reveal/:n → shown whenever round n is done (acknowledged or not: summary rows link here);
 * - #/today and anything invalid → currentView().
 */
export function resolveTodayView(today, name, params = {}) {
  const auto = currentView(today);
  const autoRes = { ...auto, path: pathForView(auto) };
  const rounds = (today && today.rounds) || [];
  if (!rounds.length) return autoRes;
  const n = Number.parseInt(params && params.n, 10);
  const valid = Number.isInteger(n) && n >= 1 && n <= rounds.length;
  if (!valid) return autoRes;
  const st = (today.progress || [])[n - 1];
  if (name === 'today-round') {
    if (!isDone(st)) return { kind: 'round', index: n, path: `/today/round/${n}` };
    if (!(today.revealAck || [])[n - 1]) return { kind: 'reveal', index: n, path: `/today/reveal/${n}` };
    return autoRes;
  }
  if (name === 'today-reveal') {
    if (isDone(st)) return { kind: 'reveal', index: n, path: `/today/reveal/${n}` };
    return autoRes;
  }
  return autoRes;
}

/**
 * The mesh asset the Today screen draws first (the current round's, or the round whose reveal is due), or null
 * (summary, empty). loadToday fetches it as soon as /v1/day is known instead of when the round screen mounts.
 */
export function firstMeshAsset(today) {
  const v = currentView(today);
  if (v.kind !== 'round' && v.kind !== 'reveal') return null;
  const r = (today.rounds || [])[v.index - 1];
  return (r && r.mesh && r.mesh.asset) || null;
}

/** First-sight default for revealAck: rounds already done when this device first sees the date count as seen. */
export function initialRevealAck(progressRounds) {
  const out = [false, false, false, false, false];
  (progressRounds || []).forEach((st, i) => { if (i < 5) out[i] = isDone(st); });
  return out;
}

function normaliseProgress(rounds) {
  const out = [null, null, null, null, null];
  (rounds || []).forEach((st, i) => { if (i < 5) out[i] = st || null; });
  return out;
}

// Per-round write counters. A /progress read (loadToday on resume, refreshProgress after a round) can be
// answered before a round action that the player made meanwhile; its older round_state must not overwrite
// the newer one the action wrote. Reads take a mark before the request and keep, for every round written
// since, the state already in the store.
const writeSeq = [0, 0, 0, 0, 0];
function writeMark() { return { date: todayState().date, seq: [...writeSeq] }; }
function keepNewer(fetched, mark, date) {
  const t = todayState();
  let kept = false;
  if (!mark || !date || mark.date !== date || t.date !== date) return { progress: fetched, kept };
  const progress = fetched.map((st, i) => {
    if (writeSeq[i] !== mark.seq[i] && t.progress[i]) { kept = true; return t.progress[i]; }
    return st;
  });
  return { progress, kept };
}

// ======================================================================================
// Loading Today (+ offline cache)
// ======================================================================================

let loadSeq = 0;
let loadPromise = null;

/**
 * Load /v1/today, then /v1/day/{date} + /progress for the active date (yesterday's while grace is active).
 * { force } starts a new load even if one is running; { skipGrace } leaves yesterday's grace rounds.
 * Offline: falls back to the IndexedDB cache (status 'offline'). Never rejects.
 */
export function loadToday({ force = false, skipGrace = false } = {}) {
  if (loadPromise && !force) return loadPromise;
  const p = doLoad(++loadSeq, { skipGrace }).catch((err) => {
    console.error(err);
    return { ok: false, resp: null, err };
  });
  loadPromise = p;
  p.finally(() => { if (loadPromise === p) loadPromise = null; });
  return p;
}

const todayState = () => store.get().today;
const hasData = (t) => t.rounds.length > 0 || t.status === 'empty';
const inBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

// Cold start (QA perf, real season, Fast 3G + 4× CPU): the round screen's own import of the 3D viewer and its mesh
// fetch only started once Today had rendered, after a module waterfall (today → round/reveal → mesh-viewer →
// three-common → three). Starting both while /v1/today and /v1/day are in flight overlaps them with it.
let viewerWarm = null;
/** Start loading the 3D viewer modules (three.js) early; resolves when loaded (never rejects). Browser only. */
export function warmViewer() {
  if (!viewerWarm && inBrowser()) {
    viewerWarm = import('./viewer/mesh-viewer.js').then(() => true, () => { viewerWarm = null; return false; });
  }
  return viewerWarm || Promise.resolve(false);
}

function warmFirstMesh() {
  if (!inBrowser()) return;
  const asset = firstMeshAsset(todayState());
  if (asset) api.assetArrayBuffer(asset).catch(() => {});   // memoised: the viewer's own call gets this load
}

/**
 * Warm round n's public mesh at low network priority (Today calls it on the reveal of round n − 1), so "Next round"
 * opens on a drawn cell. No-op without such a round. Never rejects.
 */
export function prefetchRound(n) {
  const r = todayState().rounds[n - 1];
  if (!r || !r.mesh || !r.mesh.asset || !inBrowser()) return Promise.resolve(false);
  return api.prefetchAsset(r.mesh.asset, 'buffer');
}

async function doLoad(seq, { skipGrace }) {
  const t0 = todayState();
  if (!hasData(t0)) store.update('today', { status: 'loading', error: null });
  warmViewer();

  let todayResp;
  const sentAt = Date.now();
  try {
    todayResp = await api.getToday();
  } catch (err) {
    if (seq !== loadSeq) return { ok: false, resp: null, err };
    return loadFailed(err, null);
  }
  if (seq !== loadSeq) return { ok: false, resp: null, err: null };
  const offsetMs = computeOffset(todayResp.now, sentAt, Date.now());
  setOffset(offsetMs);
  idb.set('cache:today', { today: todayResp, offsetMs, at: Date.now() });

  const plan = await planActiveDay(todayResp, skipGrace);
  if (!plan.date) {
    applyEmpty(todayResp);
    return { ok: true, resp: todayResp, err: null };
  }

  const mark = writeMark();
  const [dayR, progR] = await Promise.allSettled([api.getDay(plan.date), api.getProgress(plan.date)]);
  if (seq !== loadSeq) return { ok: false, resp: null, err: null };
  let day = dayR.status === 'fulfilled' ? dayR.value : null;
  let progress = progR.status === 'fulfilled' ? progR.value : null;
  const err = (dayR.status === 'rejected' && dayR.reason) || (progR.status === 'rejected' && progR.reason) || null;
  let fromCache = !!(day && day[FROM_CACHE]);
  if (err && !(err instanceof ApiError && err.isNetwork)) {
    // A real server answer (e.g. 404 for a withdrawn day): show it, keep any data on screen.
    return loadFailed(err, todayResp);
  }
  if (!day) { day = await idb.get(`cache:day:${plan.date}`); fromCache = true; }
  if (!progress) { progress = await idb.get(`cache:progress:${plan.date}`); fromCache = true; }
  if (!day) return loadFailed(err || new ApiError(0, 'network', 'Offline'), todayResp);

  await applyDay({ todayResp, plan, day, progress, fromCache, offline: !!err, mark });
  if (!err) warmFirstMesh();
  if (day) idb.set(`cache:day:${plan.date}`, stripSymbols(day));
  if (progress && !err) persistProgress();
  return { ok: !err, resp: todayResp, err };
}

function stripSymbols(obj) { return JSON.parse(JSON.stringify(obj)); }

async function planActiveDay(todayResp, skipGrace) {
  const g = todayResp.grace;
  let graceActive = false;
  if (g && Array.isArray(g.round_indexes) && g.round_indexes.length) {
    if (skipGrace) await idb.set(`graceSkip:${g.date}`, true);
    const skipped = skipGrace || (await idb.get(`graceSkip:${g.date}`));
    graceActive = !skipped;
  }
  if (graceActive) return { date: g.date, graceActive: true };
  if (todayResp.has_rounds && todayResp.day_number != null) return { date: todayResp.date, graceActive: false };
  return { date: null, graceActive: false };
}

function applyEmpty(todayResp, extra = {}) {
  store.update('today', {
    status: 'empty', date: todayResp.date, todayDate: todayResp.date, dayNumber: null,
    now: todayResp.now, nextRolloverAt: todayResp.next_rollover_at, grace: todayResp.grace, graceActive: false,
    rounds: [], progress: [], total: 0, roundsDone: 0, revealAck: [false, false, false, false, false],
    error: null, fromCache: false, loadedAt: Date.now(), ...extra,
  });
}

async function applyDay({ todayResp, plan, day, progress, fromCache, offline, mark = null }) {
  const rounds = [...(day.rounds || [])].sort((a, b) => a.round_index - b.round_index);
  const serverProg = normaliseProgress(progress && progress.rounds);
  let ack = await idb.get(`revealAck:${plan.date}`);
  if (!Array.isArray(ack) || ack.length !== 5) {
    ack = initialRevealAck(serverProg);
    await idb.set(`revealAck:${plan.date}`, ack);
  }
  // after the last await: keep round states that actions wrote since the request went out, and any
  // acknowledgement made meanwhile (acks only go false → true)
  const { progress: prog, kept } = keepNewer(serverProg, mark, plan.date);
  const cur = todayState();
  if (cur.date === plan.date) ack = ack.map((v, i) => !!v || !!(cur.revealAck && cur.revealAck[i]));
  store.update('today', {
    status: offline ? 'offline' : 'ready',
    date: plan.date,
    todayDate: todayResp.date,
    dayNumber: day.day_number,
    now: todayResp.now,
    nextRolloverAt: todayResp.next_rollover_at,
    grace: todayResp.grace,
    graceActive: plan.graceActive,
    rounds,
    progress: prog,
    total: progress && !kept ? progress.total : dayTotal(prog),
    roundsDone: progress && !kept ? progress.rounds_done : roundsDone(prog),
    streak: progress ? progress.streak : todayState().streak,
    revealAck: ack,
    error: null,
    fromCache,
    loadedAt: offline ? todayState().loadedAt : Date.now(),
  });
}

/** /v1/today (or day/progress) failed. Network → cached data ('offline'); otherwise 'error' (Retry). */
async function loadFailed(err, todayResp) {
  const network = err instanceof ApiError && err.isNetwork;
  const t = todayState();
  if (hasData(t)) {
    // Refresh failed: keep what is on screen.
    store.update('today', { status: network && t.status === 'ready' ? 'offline' : t.status, error: err });
    return { ok: false, resp: null, err };
  }
  if (network) {
    const cached = await idb.get('cache:today');
    const tr = todayResp || (cached && cached.today);
    if (!todayResp && cached) setOffset(cached.offsetMs || 0);
    if (tr) {
      const plan = await planActiveDay(tr, false);
      if (!plan.date) {
        applyEmpty(tr, { fromCache: true });
        return { ok: false, resp: null, err };
      }
      const day = await idb.get(`cache:day:${plan.date}`);
      const progress = await idb.get(`cache:progress:${plan.date}`);
      if (day) {
        await applyDay({ todayResp: tr, plan, day, progress, fromCache: true, offline: true });
        store.update('today', { error: err });
        return { ok: false, resp: null, err };
      }
    }
    // Nothing cached: "offline" only when the device says so; otherwise the server is unreachable (error + Retry).
    const deviceOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    store.update('today', { status: deviceOffline ? 'offline' : 'error', error: err });
    return { ok: false, resp: null, err };
  }
  store.update('today', { status: 'error', error: err });
  return { ok: false, resp: null, err };
}

let leavingGrace = null;
/**
 * Leave yesterday's grace rounds and show today (remembered for that date). Also called once the grace
 * rounds are all done and acknowledged; concurrent calls share one load.
 */
export function leaveGrace() {
  if (!leavingGrace) {
    const p = loadToday({ force: true, skipGrace: true });
    leavingGrace = p;
    p.finally(() => { if (leavingGrace === p) leavingGrace = null; });
  }
  return leavingGrace;
}

// ======================================================================================
// Round actions
// ======================================================================================

const inflight = new Map();

function roundAt(index) { return todayState().rounds[index - 1] || null; }

function writeState(index, state) {
  if (!state) return;
  if (index >= 1 && index <= 5) writeSeq[index - 1]++;
  store.update('today', (t) => {
    const progress = normaliseProgress(t.progress);
    progress[index - 1] = state;
    return { progress, total: dayTotal(progress), roundsDone: roundsDone(progress) };
  });
  persistProgress();
}

function persistProgress() {
  const t = todayState();
  if (!t.date) return;
  idb.set(`cache:progress:${t.date}`, {
    date: t.date, day_number: t.dayNumber, rounds: t.progress, total: t.total, rounds_done: t.roundsDone, streak: t.streak,
  });
}

function afterWrite(index, prev, state) {
  if (state && state.stage === 'done' && !isDone(prev)) {
    // round finished: streak (5th round), Library badge, and warm the reveal
    refreshProgress();
    loadMe();
    loadReveal(index);
  }
}

function act(index, fn) {
  const round = roundAt(index);
  if (!round) return Promise.resolve({ ok: false, resp: null, err: new ApiError(404, 'not_found', 'No such round') });
  if (inflight.has(index)) return Promise.resolve({ ok: false, resp: null, err: new ApiError(0, 'busy', 'A request for this round is already running') });
  const prev = todayState().progress[index - 1];
  const p = (async () => {
    try {
      const resp = await fn(round);
      if (resp && resp.state) { writeState(index, resp.state); afterWrite(index, prev, resp.state); }
      return { ok: true, resp, err: null };
    } catch (err) {
      if (err instanceof ApiError && err.state) { writeState(index, err.state); afterWrite(index, prev, err.state); }
      return { ok: false, resp: null, err };
    } finally {
      inflight.delete(index);
    }
  })();
  inflight.set(index, p);
  return p;
}

/** Open a paid clue ('context' | 'graph'). resp: { kind, assets, eliminated_option, score, state } */
export function openClue(roundIndex, kind) { return act(roundIndex, (r) => api.openClue(r.round_id, kind)); }

/** Guess an option ('a'–'f'). resp: { correct, score, wrong_count?, exhausted?, correct_option?, em?, method_options?, state } */
export function guess(roundIndex, optionId) { return act(roundIndex, (r) => api.guess(r.round_id, optionId)); }

/** Lock in a method_id, or null to skip. resp: { correct, method_answer, score, state } */
export function chooseMethod(roundIndex, methodId) { return act(roundIndex, (r) => api.chooseMethod(r.round_id, methodId ?? null)); }

/** True while an action for this round is in flight (disable buttons). */
export const isBusy = (roundIndex) => inflight.has(roundIndex);

const revealInflight = new Map();
// v1.2: reveals gained literature facts and were updated in place on the Worker (reveal_updated), so a reveal
// cached on the device before v1.2 (old key `reveal:<id>`) is fetched once more; offline it still serves.
const revealKey = (id) => `reveal:v1.2:${id}`;
// v1.3: reveals keep being refreshed in place (structured trivia, EM reveal text), so a reveal served from the device is
// compared with the Worker's once per session, in the background; a changed one replaces the copy on screen and on the
// device. Offline or failing: the device copy stays (checked again on the next load).
const revealChecked = new Set(); // round_ids whose reveal came from (or was checked against) the Worker this session
function revalidateReveal(id, cached) {
  revealChecked.add(id);
  api.getReveal(id).then((fresh) => {
    if (!fresh || typeof fresh !== 'object' || JSON.stringify(fresh) === JSON.stringify(cached)) return;
    idb.set(revealKey(id), fresh);
    store.update('reveals', { [id]: fresh });
  }).catch(() => { revealChecked.delete(id); });
}

/** Load (and cache) the reveal of a round. Resolves { ok, resp: round_reveal, err }. */
export function loadReveal(roundIndex) {
  const round = roundAt(roundIndex);
  if (!round) return Promise.resolve({ ok: false, resp: null, err: new ApiError(404, 'not_found', 'No such round') });
  return loadRevealById(round.round_id);
}

/**
 * Load (and cache) the reveal of any round by its round_id (v0.6.0: the Library's neuron profile, a round of any
 * day): the same device copy, background revalidation and store.reveals as loadReveal.
 */
export function loadRevealById(id) {
  const have = store.get().reveals[id];
  if (have) return Promise.resolve({ ok: true, resp: have, err: null });
  if (revealInflight.has(id)) return revealInflight.get(id);
  const p = (async () => {
    try {
      let resp = await idb.get(revealKey(id));
      if (!resp) {
        const old = await idb.get(`reveal:${id}`);
        try {
          resp = await api.getReveal(id);
          revealChecked.add(id);
        } catch (err) {
          if (!old) throw err;
          resp = old;   // offline: the pre-v1.2 copy is better than no reveal; refetched on a later load
        }
        if (resp !== old) {
          idb.set(revealKey(id), resp);
          if (old) idb.del(`reveal:${id}`);
        }
      } else if (!revealChecked.has(id)) {
        revalidateReveal(id, resp);
      }
      store.update('reveals', { [id]: resp });
      return { ok: true, resp, err: null };
    } catch (err) {
      return { ok: false, resp: null, err };
    } finally {
      revealInflight.delete(id);
    }
  })();
  revealInflight.set(id, p);
  return p;
}

/**
 * Acknowledge a reveal ("Next round →" / "Today's results"). Persists revealAck[date] in IndexedDB.
 * { advance: true } (default) then routes to #/today, which shows the next round or the summary.
 */
export async function ackReveal(roundIndex, { advance = true } = {}) {
  const t = todayState();
  const revealAck = [...(t.revealAck || [false, false, false, false, false])];
  revealAck[roundIndex - 1] = true;
  store.update('today', { revealAck });
  if (t.date) await idb.set(`revealAck:${t.date}`, revealAck);
  const view = currentView(todayState());
  // grace rounds all finished: move on to today (skipping grace, so a server that still lists them
  // cannot keep the app on a loading screen)
  if (view.graceOver) leaveGrace();
  if (advance && typeof location !== 'undefined') navigate('/today', { replace: true });
  return { ok: true, resp: null, err: null };
}

/** Re-read /progress for the active date (streak after the 5th round, totals). */
export async function refreshProgress() {
  const t = todayState();
  if (!t.date) return { ok: false, resp: null, err: null };
  const mark = writeMark();
  try {
    const resp = await api.getProgress(t.date);
    if (todayState().date !== resp.date) return { ok: false, resp, err: null };
    const { progress, kept } = keepNewer(normaliseProgress(resp.rounds), mark, resp.date);
    store.update('today', {
      progress,
      total: kept ? dayTotal(progress) : resp.total,
      roundsDone: kept ? roundsDone(progress) : resp.rounds_done,
      streak: resp.streak,
    });
    persistProgress();
    return { ok: true, resp, err: null };
  } catch (err) {
    return { ok: false, resp: null, err };
  }
}

/** GET /v1/me → store.session.me (+ IndexedDB cache for offline). */
export async function loadMe() {
  try {
    const me = await api.getMe();
    store.update('session', { me });
    idb.set('cache:me', me);
    return { ok: true, resp: me, err: null };
  } catch (err) {
    return { ok: false, resp: null, err };
  }
}
