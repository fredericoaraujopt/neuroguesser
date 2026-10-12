// Boot: theme, session (settings, onboarding, device id), render <App/>, Today + /me, online/offline,
// rollover/resume handling, service worker registration.
import { html, render } from './ui/html.js';
import { App } from './app.js';
import { store, hydrateSession } from './store.js';
import { getDeviceId, onRequestOutcome } from './api.js';
import { loadToday, loadMe } from './game.js';
import { watchRollover } from './time.js';
import { initRouter } from './router.js';
import { config } from '../config.js';
import { VERSION } from '../version.js';

function setOnline(online) {
  if (store.get().ui.online !== online) store.update('ui', { online });
}

function applyMotionPreference() {
  const off = store.get().session.settings.celebrations === false;
  document.documentElement.classList.toggle('no-motion', off);
}

function refreshAll() {
  loadToday({ force: true });
  loadMe();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !config.registerSW) return;
  let hadController = !!navigator.serviceWorker.controller;
  let updateReady = false;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw] registration failed', err));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    updateReady = true; // a new shell took over: reload on the next resume, never mid-round
  });
  let wasHidden = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { wasHidden = true; return; }
    if (wasHidden && updateReady) location.reload();
  });
}

async function boot() {
  document.documentElement.dataset.theme = 'app-dark';
  initRouter();

  setOnline(typeof navigator.onLine === 'boolean' ? navigator.onLine : true);
  window.addEventListener('online', () => { setOnline(true); refreshAll(); });
  window.addEventListener('offline', () => setOnline(false));
  onRequestOutcome(({ ok, network }) => {
    if (ok) setOnline(true);
    else if (network) setOnline(false);
  });

  await hydrateSession();
  store.update('session', { deviceId: await getDeviceId() });
  applyMotionPreference();
  store.subscribe(applyMotionPreference);

  const root = document.getElementById('app');
  root.textContent = '';
  render(html`<${App} />`, root);

  loadToday();
  loadMe();
  watchRollover({
    getToday: () => store.get().today,
    onRollover: refreshAll,
    onResume: refreshAll,
  });

  if (!store.get().session.onboarded) {
    import('./screens/onboarding.js')
      .then((m) => { if (m.openOnboarding && !store.get().ui.sheet) m.openOnboarding({}); })
      .catch((err) => console.warn('[onboarding]', err));
  }

  registerServiceWorker();

  if (config.isLocal) {
    // dev handle for debugging and the Playwright checks; never on production hosts
    window.__ng = { store, VERSION, config };
  }
}

boot().catch((err) => {
  console.error(err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = '<div class="center-col"><span class="overline is-error">✕ NeuroGuesser could not start</span>'
      + '<span class="t-body">Reload the page to try again.</span></div>';
  }
});
