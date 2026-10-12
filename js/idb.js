// Tiny IndexedDB key-value store (one object store, structured-clone values).
// Falls back to an in-memory Map when IndexedDB is unavailable (Node tests, some private modes), so callers
// never have to care. Every function is async and never throws for storage reasons.
//
// Keys used by the foundation (others may add their own, prefixed by their screen name):
//   deviceId                         X-NG-Device (uuid v4)
//   settings                         { haptics, celebrations, dataSaver }
//   onboarded                        true once onboarding was finished or skipped
//   revealAck:<date>                 [bool × 5] reveal acknowledged per round
//   graceSkip:<date>                 true when the player chose to leave yesterday's grace rounds
//   cache:today                      { today, offsetMs, at }   last GET /v1/today (offline)
//   cache:day:<date>                 GET /v1/day/{date}
//   cache:progress:<date>            GET /v1/day/{date}/progress (kept up to date by game actions)
//   cache:me                         GET /v1/me
//   cache:library                    GET /v1/library first page (Library screen)
//   reveal:<round_id>                round_reveal JSON
//   lastRanks:<scope>:<group>:<date> rank snapshot (fx/overtake.js)

const DB_NAME = 'neuroguesser';
const STORE = 'kv';
const memory = new Map();
let dbPromise = null;

function hasIDB() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch (_) { return false; }
}

function openDB() {
  if (!hasIDB()) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (_) { resolve(null); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return openDB().then((db) => {
    if (!db) return fn(null);
    return new Promise((resolve) => {
      let out;
      try {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const req = fn(store);
        if (req) req.onsuccess = () => { out = req.result; };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => resolve(fn(null));
        tx.onabort = () => resolve(fn(null));
      } catch (_) { resolve(fn(null)); }
    });
  });
}

export function get(key) {
  return run('readonly', (store) => (store ? store.get(key) : memory.get(key)));
}

export function set(key, value) {
  memory.set(key, value);
  return run('readwrite', (store) => (store ? store.put(value, key) : undefined)).then(() => value);
}

export function del(key) {
  memory.delete(key);
  return run('readwrite', (store) => (store ? store.delete(key) : undefined)).then(() => undefined);
}

export function keys(prefix = '') {
  return run('readonly', (store) => {
    if (store) return store.getAllKeys();
    return [...memory.keys()];
  }).then((all) => (all || []).filter((k) => typeof k === 'string' && k.startsWith(prefix)));
}

export const idb = { get, set, del, keys };
export default idb;
