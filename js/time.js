// UTC time helpers, the server clock offset (from GET /v1/today) and rollover detection.
// Everything except watchRollover() is pure and unit-tested (tests/time.test.js).

const DAY_MS = 86400000;
let offsetMs = 0;

/** Offset = server time − local time, using the midpoint of the request as the local reference. */
export function computeOffset(serverIso, sentAtMs, receivedAtMs) {
  const server = Date.parse(serverIso);
  if (Number.isNaN(server)) return 0;
  const local = (sentAtMs + (receivedAtMs ?? sentAtMs)) / 2;
  return Math.round(server - local);
}
export function setOffset(ms) { offsetMs = Number.isFinite(ms) ? ms : 0; }
export function getOffset() { return offsetMs; }
/** Server-corrected now (ms). */
export function now() { return Date.now() + offsetMs; }

/** 'YYYY-MM-DD' (UTC) for a timestamp in ms. */
export function utcDate(ms = now()) { return new Date(ms).toISOString().slice(0, 10); }
/** ms of the next 00:00 UTC strictly after ms. */
export function nextUtcMidnight(ms = now()) { return (Math.floor(ms / DAY_MS) + 1) * DAY_MS; }
/** Add whole days to a 'YYYY-MM-DD' date. */
export function addDays(date, n) { return utcDate(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS); }
/** ms until an ISO timestamp (never negative). */
export function msUntil(iso, nowMs = now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - nowMs);
}

/**
 * The deadline at which the Today data must be reloaded: the earliest of next_rollover_at and, while the
 * grace day is on screen, grace.until. null when nothing is loaded.
 */
export function nextDeadline({ nextRolloverAt, grace, graceActive } = {}) {
  const times = [];
  if (nextRolloverAt) times.push(Date.parse(nextRolloverAt));
  if (graceActive && grace && grace.until) times.push(Date.parse(grace.until));
  const valid = times.filter((t) => !Number.isNaN(t));
  return valid.length ? Math.min(...valid) : null;
}

/** True when the loaded Today data is past its deadline (rollover at 00:00 UTC, or the grace window ended). */
export function isRolloverDue(today, nowMs = now()) {
  const d = nextDeadline(today);
  return d !== null && nowMs >= d;
}

/** True when the data is older than staleMs (wwads: refetch on resume when > 5 min stale). */
export function isStale(loadedAtMs, nowMs = Date.now(), staleMs = 5 * 60000) {
  return !loadedAtMs || nowMs - loadedAtMs > staleMs;
}

/**
 * Watch for the 00:00 UTC rollover and app resume.
 *   getToday(): returns the store's today slice ({ nextRolloverAt, grace, graceActive, loadedAt })
 *   onRollover(): reload /v1/today (forced)
 *   onResume(): called on visibilitychange→visible / online / pageshow(persisted) when the data is stale
 * Checks every second while visible (cheap comparison), and immediately on resume events.
 * Returns stop().
 */
export function watchRollover({ getToday, onRollover, onResume, staleMs = 5 * 60000, intervalMs = 1000 } = {}) {
  if (typeof document === 'undefined') return () => {};
  let firedFor = null;
  let firedAt = 0;
  let timer = null;

  const check = (resumed = false) => {
    const today = getToday();
    const deadline = nextDeadline(today);
    if (deadline !== null && now() >= deadline) {
      // fire once per deadline; retry every 30 s if the reload did not move the deadline (e.g. offline)
      if (firedFor !== deadline || Date.now() - firedAt > 30000) {
        firedFor = deadline;
        firedAt = Date.now();
        onRollover && onRollover();
      }
      return;
    }
    const busy = today.status === 'loading' || today.status === 'idle';
    if (resumed && !busy && isStale(today.loadedAt, Date.now(), staleMs)) onResume && onResume();
  };
  const start = () => { if (!timer) timer = setInterval(() => check(false), intervalMs); };
  const stopTimer = () => { clearInterval(timer); timer = null; };
  const onVis = () => {
    if (document.visibilityState === 'visible') { check(true); start(); } else stopTimer();
  };
  const onOnline = () => check(true);
  const onShow = (e) => { if (e.persisted) check(true); };

  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('online', onOnline);
  window.addEventListener('pageshow', onShow);
  window.addEventListener('focus', onOnline);
  if (document.visibilityState !== 'hidden') start();

  return () => {
    stopTimer();
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pageshow', onShow);
    window.removeEventListener('focus', onOnline);
  };
}
