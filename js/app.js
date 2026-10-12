// <App/>: router outlet, tab bar, overlay host (store.ui.sheet / store.ui.fullView), toast.
// The #fx-layer for celebrations lives outside the Preact root (index.html).
//
// Overlay registry (ARCHITECTURE.md §4.5) — open with store.openSheet(id, props) or the module's opener:
//   share         screens/share.js        default            openShare(props)
//   report        screens/report.js       default            openReport(props)
//   clueConfirm   screens/round.js        ClueConfirmSheet   openClueConfirm(props)
//   libraryDetail screens/library.js      LibraryDetailSheet openLibraryDetail(props)
//   onboarding    screens/onboarding.js   default            openOnboarding(props)
//   milestone     fx/milestone.js         MilestoneSheet     openMilestone({ streak })
//   feedback      feedback.js             FeedbackSheet      openFeedback()   (+ <FeedbackLayer/>: ✎ button, notice)
//   fullView      screens/fullview.js     default            openFullView({ roundIndex, mode })
// Sheet components receive { ...props, onClose } and render their own <Sheet> (js/ui/sheet.js).
// props.full = true hides the tab bar while the sheet is open.
import { Component } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { html, cx } from './ui/html.js';
import { useRoute } from './router.js';
import { useStore, store, closeSheet } from './store.js';
import { TabBar, Toast } from './ui/components.js';
import { TopHeader } from './ui/top-header.js'; // desktop header: mounts at >= 1024 px (css/desktop.css)
import { FeedbackLayer } from './feedback.js';

const SHEETS = {
  share: () => import('./screens/share.js').then((m) => m.default),
  report: () => import('./screens/report.js').then((m) => m.default),
  clueConfirm: () => import('./screens/round.js').then((m) => m.ClueConfirmSheet),
  libraryDetail: () => import('./screens/library.js').then((m) => m.LibraryDetailSheet),
  onboarding: () => import('./screens/onboarding.js').then((m) => m.default),
  milestone: () => import('./fx/milestone.js').then((m) => m.MilestoneSheet),
  feedback: () => import('./feedback.js').then((m) => m.FeedbackSheet), // prototype feedback (ARCHITECTURE.md §3.2)
};
const loadFullView = () => import('./screens/fullview.js').then((m) => m.default);

/** Additive extension point: registerSheet('mySheet', () => import(...).then((m) => m.MySheet)). */
export function registerSheet(id, loader) { SHEETS[id] = loader; }

const closeFullView = () => store.update('ui', { fullView: null });

// ---- lazy component loading with a module-level cache (no flash on re-render) ----
const loaded = new Map();

function entryFor(key, loader) {
  let e = loaded.get(key);
  if (!e) {
    e = { Comp: null, err: null, promise: null };
    e.promise = Promise.resolve().then(loader).then(
      (Comp) => {
        if (typeof Comp !== 'function') throw new Error(`${key}: module has no component export`);
        e.Comp = Comp;
      },
    ).catch((err) => {
      console.error(err);
      e.err = err; // kept until a render reports it (useLazy), so the re-render does not re-import in a loop
    });
    loaded.set(key, e);
  }
  return e;
}

function useLazy(key, loader) {
  const [, setTick] = useState(0);
  const e = key && loader ? entryFor(key, loader) : null;
  // what this render saw; the module may resolve before the effect runs, so compare with that
  const renderedReady = !!(e && (e.Comp || e.err));
  useEffect(() => {
    if (!e || renderedReady) return undefined;
    let alive = true;
    e.promise.then(() => { if (alive) setTick((n) => n + 1); });
    return () => { alive = false; };
  }, [key, e, renderedReady]);
  // a failed import is reported once (the ErrorBoundary shows it); dropping it here makes "Try again" re-import
  if (e && e.err && loaded.get(key) === e) loaded.delete(key);
  return e || { Comp: null, err: null };
}

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.error('[screen error]', err); }
  render() {
    if (this.state.err) {
      return html`<div class="screen"><div class="today-state" role="alert">
        <span class="overline is-error">✕ Screen error</span>
        <span class="t-title">This screen hit a problem</span>
        <span class="t-body t-soft">${String(this.state.err && this.state.err.message || this.state.err)}</span>
        <div class="actions">
          <button type="button" class="btn btn-primary btn-block" onClick=${() => this.setState({ err: null })}>Try again</button>
          <button type="button" class="btn btn-outline btn-block" onClick=${() => location.reload()}>Reload app</button>
        </div>
      </div></div>`;
    }
    return this.props.children;
  }
}

function RouteOutlet({ route }) {
  const r = route.route;
  const { Comp, err } = useLazy(r ? `route:${r.screen || r.name}` : null, r ? () => r.load().then((m) => m.default) : null);
  if (err) throw err;
  if (!Comp) return null;
  return html`<${Comp} params=${route.params} />`;
}

function LazyOverlay({ id, loader, props }) {
  const { Comp, err } = useLazy(`overlay:${id}`, loader);
  if (err) throw err;
  if (!Comp) return null;
  return html`<${Comp} ...${props} />`;
}

export function App() {
  const route = useRoute();
  const sheet = useStore((s) => s.ui.sheet);
  const fullView = useStore((s) => s.ui.fullView);
  const due = useStore((s) => (s.session.me ? s.session.me.due_count : 0));
  const xp = useStore((s) => (s.session.me && typeof s.session.me.xp_total === 'number' ? s.session.me.xp_total : null)); // level chip (v1.3)

  const fullRoute = !!(route.route && route.route.fullScreen);
  const sheetFull = !!(sheet && sheet.props && sheet.props.full);
  const showTabs = !fullRoute && !fullView && !sheetFull;
  const screenKey = route.route ? (route.route.screen || route.name) : 'none';
  const sheetLoader = sheet ? SHEETS[sheet.id] : null;
  if (sheet && !sheetLoader) console.warn(`[app] unknown sheet id: ${sheet.id}`);

  return html`
    ${showTabs ? html`<${TopHeader} active=${route.name === 'settings' ? 'profile' : (route.route ? route.route.tab : null)} dueCount=${due} xp=${xp} />` : null}
    <main id="main" class=${cx('app-main', !showTabs && 'is-full')}>
      <${ErrorBoundary} key=${screenKey}><${RouteOutlet} route=${route} /></${ErrorBoundary}>
    </main>
    ${showTabs ? html`<${TabBar} active=${route.route ? route.route.tab : null} dueCount=${due} />` : null}
    ${fullView ? html`<${ErrorBoundary} key="fullview"><${LazyOverlay} id="fullView" loader=${loadFullView}
      props=${{ ...fullView, onClose: closeFullView }} /></${ErrorBoundary}>` : null}
    ${sheet && sheetLoader ? html`<${ErrorBoundary} key=${`sheet:${sheet.id}`}><${LazyOverlay} id=${sheet.id} loader=${sheetLoader}
      props=${{ ...sheet.props, onClose: closeSheet }} /></${ErrorBoundary}>` : null}
    <${Toast} low=${!showTabs} />
    <${FeedbackLayer} hidden=${!showTabs} />
  `;
}

export default App;
