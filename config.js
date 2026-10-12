// Runtime configuration. No build step: edit PRODUCTION_API before deploying.
//
// Dev overrides (honoured ONLY when the page is served from localhost or 127.0.0.1):
//   ?api=http://localhost:8787     API base URL
//   ?now=2026-10-03T23:59:30Z      sends X-NG-Debug-Now on every API request (the Worker honours it only
//                                  with ALLOW_DEBUG_NOW=1 and a localhost request host); the clock starts
//                                  there on page load and advances in real time (api.js debugNowHeader)
//   ?sw=1                          register the service worker on localhost (off by default in dev so
//                                  edited files are never served from a stale cache)

export const PRODUCTION_API = 'https://neuroguesser-api-production.fredericoaraujo.workers.dev';
export const DEV_API = 'http://localhost:8787';
export const DEV_HOSTS = ['localhost', '127.0.0.1'];
export const DEV_API_PORT = 8787;
export const DEV_APP_PORT = '5173';

// Prototype feedback loop (ARCHITECTURE.md §3.2): the "✎ Feedback" button, the Feedback sheet and Settings →
// Your feedback. Set to false to remove all of it from the app.
export const FEEDBACK_ENABLED = true;

/**
 * LAN phone mode (neuroguesser-content/scripts/dev-lan.sh): a page served from a private IPv4 address
 * (10/8, 172.16/12, 192.168/16, 169.254/16), an IPv6 unique-local/link-local address or a *.local name (or from
 * any host on the dev port 5173) talks to the dev Worker on the same host, port 8787. No ?api=/?now= overrides
 * there (debug-now stays localhost-only).
 */
export function isLanHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (/\.local$/.test(h) && h.length > 6) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.slice(1).some((x) => Number(x) > 255)) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

export function resolveConfig(loc) {
  const hostname = loc ? loc.hostname : '';
  const isLocal = DEV_HOSTS.includes(hostname);
  // the dev static server always listens on :5173 (dev-up.sh / dev-lan.sh), production never does: this also covers a
  // Mac that the institute network gives a public address
  const isLan = !isLocal && (isLanHost(hostname) || String((loc && loc.port) || '') === DEV_APP_PORT);
  const params = new URLSearchParams(loc ? loc.search : '');
  const lanHost = /:/.test(hostname) && !/^\[/.test(hostname) ? `[${hostname}]` : hostname;
  let apiBase = isLocal ? DEV_API
    : isLan ? `${loc && loc.protocol === 'https:' ? 'https:' : 'http:'}//${lanHost}:${DEV_API_PORT}`
      : PRODUCTION_API;
  let debugNow = null;
  if (isLocal) {
    const api = params.get('api');
    if (api && /^https?:\/\/[^\s]+$/i.test(api)) apiBase = api;
    const now = params.get('now');
    if (now && !Number.isNaN(Date.parse(now))) debugNow = new Date(Date.parse(now)).toISOString();
  }
  return Object.freeze({
    apiBase: apiBase.replace(/\/+$/, ''),
    debugNow,
    isLocal,
    isLan,
    feedbackEnabled: FEEDBACK_ENABLED,
    // a LAN page is plain http (no service worker there anyway), and dev files must never come from a stale cache
    registerSW: !(isLocal || isLan) || params.get('sw') === '1',
  });
}

export const config = resolveConfig(typeof location !== 'undefined' ? location : null);
