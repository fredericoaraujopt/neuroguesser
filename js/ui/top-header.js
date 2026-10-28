// Desktop top header (ARCHITECTURE.md §3.3 item 4): wordmark "NeuroGuesser", the day progress bar
// (js/ui/day-progress.js, variant "header") and the nav Today · Library · Ranks · Profile (active = ink 700 + 2 px
// accent underline). app.js renders <TopHeader> whenever the tab bar shows; it mounts only at 1024 px and up
// (matchMedia), so phones carry no hidden copy of the nav or of the day total. css/desktop.css lays it out, hides the
// tab bar there, and keeps .topbar display: none below 1024 px as a safety net.
import { useEffect, useState } from 'preact/hooks';
import { html, cx } from './html.js';
import { haptic } from '../fx/haptics.js';
import { Tick } from './components.js';
import { TodayProgress } from './day-progress.js';
import { LevelChip, levelChipLabel } from './xp-bar.js'; // v1.3 (§3.4 item 2): the level chip on Profile

export const WIDE_QUERY = '(min-width: 1024px)'; // the same breakpoint as css/desktop.css and day-progress.js

function mediaList(query) {
  try { return typeof matchMedia === 'function' ? matchMedia(query) : null; } catch (_) { return null; }
}

/** true while `query` matches (re-renders when it starts or stops matching); false without matchMedia. */
export function useMedia(query = WIDE_QUERY) {
  const [on, setOn] = useState(() => { const m = mediaList(query); return !!(m && m.matches); });
  useEffect(() => {
    const m = mediaList(query);
    if (!m) return undefined;
    const sync = () => setOn(!!m.matches);
    sync();
    if (m.addEventListener) m.addEventListener('change', sync); else if (m.addListener) m.addListener(sync);
    return () => { if (m.removeEventListener) m.removeEventListener('change', sync); else if (m.removeListener) m.removeListener(sync); };
  }, [query]);
  return on;
}

/**
 * The header bar (pure). active: the route's tab ('today' | 'library' | 'ranks') or 'profile' (#/settings);
 * xp: me.xp_total — the Profile link then carries the level chip ("Lv 4" + a mini bar to the next level).
 */
export function HeaderBar({ active, dueCount = 0, xp = null }) {
  const level = typeof xp === 'number' && Number.isFinite(xp);
  const items = [
    { id: 'today', label: 'Today', href: '#/today' },
    { id: 'library', label: 'Library', href: '#/library', badge: dueCount > 0 ? ` · ${dueCount}` : '' },
    { id: 'ranks', label: 'Ranks', href: '#/ranks' },
    { id: 'profile', label: 'Profile', href: '#/settings' },
  ];
  return html`<header class="topbar">
    <a class="topbar-mark" href="#/today" onClick=${() => haptic('selection')}>NeuroGuesser</a>
    <div class="topbar-progress"><${TodayProgress} variant="header" /></div>
    <nav class="topbar-nav" aria-label="Main">
      ${items.map((t) => html`<a key=${t.id} href=${t.href} class=${cx('topbar-link', active === t.id && 'is-active')}
        aria-current=${active === t.id ? 'page' : null}
        aria-label=${t.badge ? `${t.label}, ${dueCount} due for review` : t.id === 'profile' && level ? `${t.label}, ${levelChipLabel(xp)}` : t.label}
        onClick=${() => haptic('selection')}><span>${t.label}${t.badge ? html`<span class="tab-badge">${t.badge}</span>` : null}${t.id === 'profile' && level ? html`<${LevelChip} xp=${xp} />` : null}</span><${Tick} /></a>`)}
    </nav>
  </header>`;
}

/** app.js entry: the header bar on wide screens, nothing below 1024 px. */
export function TopHeader(props) {
  return useMedia(WIDE_QUERY) ? html`<${HeaderBar} ...${props} />` : null;
}

export default TopHeader;
