// Dev page for the reveal track: renders the real RevealView / SummaryView / ShareSheet / ReportSheet from the
// hand-written, schema-valid fixture dev/reveal.fixture.json (every optional round_reveal field, v1.3 structured trivia
// with real verified facts), so every tab and state is testable even though the synthetic fixture days have no ephys,
// genes, function or facts.
//
//   http://localhost:5173/dev/reveal.html
//   URL params (for screenshots): view=reveal|summary|share|report|milestone · outcome=perfect|named|met|missed|skipped
//     tab=facts|ephys|genes|graph|how it was made|papers · match=same_cell|same_type|same_subclass|same_class · pb=1 · fresh=1
//     trivia=v13|v12|none (v1.3 categorised facts | the v1.2 uncategorised stand-ins | no facts; default v13)
//     facts=0…4 (how many of those facts; default all) · quote=N (expand the Nth "Show quote" toggle; 1 = the first)
//     atlas=new|seen|off (the reveal's atlas bar: this round's type is new (+1) | seen before | no /v1/me atlas)
//     xp=up|first|none|off (summary XP: one level up | a first day from 0 XP | no level crossed | no xp_total)
//     progress=mid|done|grace (the day progress bar: rounds 3–5 to play | all done | grace, rounds 2–3 open)
//     fill=1 (round 2's segment fills as when the round just finished) · scroll=N (scroll the screen N px)
//     frame=full (no controls; the app frame fills the window, as index.html lays it out, with css/desktop.css and,
//       from 1024 px, the top header with the level chip)
//     day=YYYY-MM-DD (closed fixture day whose GLBs feed the 3D hero; default 2026-10-01) · offline=1 (no Worker)
//
// The JSON trivia assets (ephys trace, graph clue) are served from the fixture; the same-cell function image is
// drawn here; the mesh, context volume, labels and siblings come from a CLOSED dev-fixture day of the local
// Worker (closed days' reveal assets need no play), so the hero viewer shows real GLBs when the stack is up.
// Nothing here is shipped to players.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, render, cx, loadCss } from '../js/ui/html.js';
import { store, hydrateSession, setSettings, useStore, showToast, initialState } from '../js/store.js';
import * as api from '../js/api.js';
import { ApiError } from '../js/api.js';
import { Chip, Toggle, Toast, TabBar, Button } from '../js/ui/components.js';
import { RevealView, revealTabs } from '../js/screens/reveal.js';
import { SummaryView } from '../js/screens/summary.js';
import ShareSheet from '../js/screens/share.js';
import ReportSheet from '../js/screens/report.js';
import { MilestoneSheet } from '../js/fx/milestone.js';
import { isMilestone } from '../js/fx/celebrate.js';
import { doneTotal } from '../js/format.js';
import { TopHeader } from '../js/ui/top-header.js';
import { noteRoundFinished, _resetAtlasMemory } from '../js/ui/atlas-bar.js';
import { xpForLevel } from '../js/levels.js';

const params = new URLSearchParams(location.search);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- state variants (schema-valid round_state)
const OUTCOMES = [
  { id: 'perfect', label: 'Perfect 1,200' },
  { id: 'named', label: 'Named · method ✕' },
  { id: 'met', label: 'Met' },
  { id: 'missed', label: 'Missed' },
  { id: 'skipped', label: 'Missed · skipped' },
];
function stateFor(base, outcome) {
  const st = clone(base);
  const set = (o) => Object.assign(st, o);
  if (outcome === 'perfect' || outcome === 'named') {
    set({ wrong: [], eliminated: [], clues_opened: [], type_result: 'correct', type_score: 1000, outcome: 'named' });
  } else if (outcome === 'missed' || outcome === 'skipped') {
    set({ wrong: ['d', 'b', 'e'], eliminated: ['c'], clues_opened: ['context'], type_result: 'exhausted', type_score: 0, outcome: 'missed' });
  }
  if (outcome === 'named') set({ method_pick: 'fib_sem', method_correct: false, method_score: 0 });
  else if (outcome === 'skipped') set({ method_pick: null, method_correct: false, method_score: 0 });
  else set({ method_pick: st.method_answer, method_correct: true, method_score: 200 });
  st.score = st.type_score + st.method_score;
  return st;
}

const SECTIONS = [
  { id: 'notice', label: 'What to notice (method)' },
  { id: 'facts', label: 'Literature facts' },
  { id: 'howFacts', label: 'How-typed facts' },
  { id: 'nt', label: 'Transmitter' },
  { id: 'scf', label: 'Same-cell function' },
  { id: 'ephys', label: 'Ephys' },
  { id: 'trace', label: 'Ephys trace' },
  { id: 'genes', label: 'Genes' },
  { id: 'graph', label: 'Graph clue' },
  { id: 'siblings', label: 'Siblings' },
];
function revealFor(base, on, match, nFacts = 4, trivia = 'v13', fixture = null) {
  const r = clone(base);
  const tr = r.trivia;
  if (trivia === 'v12' && fixture) tr.facts = clone(fixture.trivia_v12_facts);
  if (!on.notice) delete r.method.what_to_notice;
  if (!on.facts || nFacts <= 0 || trivia === 'none') delete tr.facts;
  else tr.facts = tr.facts.slice(0, nFacts);
  if (!on.howFacts) delete r.how_typed.facts;
  if (!on.nt) delete tr.neurotransmitter;
  if (!on.scf) delete tr.same_cell_function;
  if (!on.genes) delete tr.genes;
  if (!on.siblings) { delete r.context.siblings; delete r.context.siblings_count; }
  if (!on.ephys) delete tr.ephys;
  else {
    tr.ephys.match_level = match;
    if (!on.trace) delete tr.ephys.trace;
  }
  return r;
}

// ---------------------------------------------------------------- assets
/** A small orientation-tuning figure for same_cell_function.asset (data-black on sunken, outward ticks). */
function functionImageUrl() {
  const c = document.createElement('canvas');
  const W = 330; const H = 120; const s = 2;
  c.width = W * s; c.height = H * s;
  const g = c.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const tok = (n) => cs.getPropertyValue(n).trim();
  g.scale(s, s);
  g.fillStyle = tok('--surface-sunken'); g.fillRect(0, 0, W, H);
  g.strokeStyle = tok('--ink'); g.fillStyle = tok('--ink'); g.lineWidth = 0.75;
  const L = 36; const R = W - 12; const T = 10; const B = H - 28;
  g.beginPath(); g.moveTo(L, T); g.lineTo(L, B); g.lineTo(R, B); g.stroke();
  g.font = `400 8px ${tok('--font-sans')}`; g.textAlign = 'center';
  for (let k = 0; k <= 4; k++) { const x = L + (k / 4) * (R - L); g.beginPath(); g.moveTo(x, B); g.lineTo(x, B + 4); g.stroke(); g.fillText(String(k * 90), x, B + 13); }
  g.fillText('Direction (deg)', (L + R) / 2, B + 24);
  g.save(); g.translate(10, (T + B) / 2); g.rotate(-Math.PI / 2); g.fillText('ΔF/F', 0, 0); g.restore();
  g.strokeStyle = tok('--data-black'); g.lineWidth = 1; g.beginPath();
  for (let i = 0; i <= 120; i++) {
    const d = (i / 120) * 360;
    const r = 0.1 + 0.9 * Math.exp(-((d - 90) ** 2) / 600) + 0.55 * Math.exp(-((d - 270) ** 2) / 600);
    const x = L + (d / 360) * (R - L); const y = B - r * (B - T);
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.stroke();
  return new Promise((resolve) => c.toBlob((b) => resolve(URL.createObjectURL(b)), 'image/png'));
}

function makeLoader(fx, live) {
  let fnUrl = null;
  const scfPath = fx.reveal.trivia.same_cell_function.asset;
  return {
    json: async (p) => (fx.assets[p] ? fx.assets[p] : api.assetJSON(p)),
    buffer: async (p) => api.assetArrayBuffer(p),
    url: async (p) => {
      if (p === scfPath) { if (!fnUrl) fnUrl = await functionImageUrl(); return fnUrl; }
      return api.assetObjectURL(p);
    },
    live,
  };
}

/** Swap the fixture's GLB/label/thumb paths for a closed fixture day's real ones (still schema-valid). */
async function loadLive(fx, day) {
  if (params.get('offline') === '1') return { ok: false, note: 'offline=1: 3D hero shows the viewer without assets' };
  try {
    const d = await api.getDay(day);
    const round = d.rounds.find((r) => r.round_index === 2) || d.rounds[0];
    const rv = await api.getReveal(round.round_id);
    return { ok: true, round, reveal: rv, note: `3D assets: dev Worker, closed day ${day} round ${round.round_index} (${rv.type.name})` };
  } catch (err) {
    return { ok: false, note: `3D assets unavailable (${err.code || err.message}); is the dev stack up? Everything else works.` };
  }
}
function withLive(fx, live) {
  const out = clone(fx);
  if (!live || !live.ok) return out;
  out.round.mesh = clone(live.round.mesh);
  const c = live.reveal.context;
  out.reveal.context = { ...out.reveal.context, volume: c.volume, labels: c.labels, neuron_offset_um: c.neuron_offset_um };
  if (c.siblings) { out.reveal.context.siblings = c.siblings; out.reveal.context.siblings_count = c.siblings_count; }
  out.reveal.neuron.thumb = live.reveal.neuron.thumb;
  out.state.clues.context = { volume: c.volume, labels: c.labels, neuron_offset_um: c.neuron_offset_um };
  return out;
}

// ---------------------------------------------------------------- /v1/me: atlas (reveal) and XP (summary, header)
const TRIVIA = [{ id: 'v13', label: 'v1.3 categorised' }, { id: 'v12', label: 'v1.2 uncategorised' }, { id: 'none', label: 'None' }];
const ATLAS_MODES = [{ id: 'new', label: 'New type (+1)' }, { id: 'seen', label: 'Seen before' }, { id: 'off', label: 'No atlas data' }];
const XP_MODES = [{ id: 'up', label: 'Level up' }, { id: 'first', label: 'First day' }, { id: 'none', label: 'No level' }, { id: 'off', label: 'No XP data' }];
const ATLAS = [
  { species_common: 'Electric fish', seen: 2, total: 6 }, { species_common: 'Fly', seen: 23, total: 55 },
  { species_common: 'Human', seen: 1, total: 7 }, { species_common: 'Mouse', seen: 5, total: 11 },
];
/** me.xp_total after the day: one level crossed (9 → 10) | from 0 XP | inside level 10 | none. */
function xpFor(mode, total) {
  if (mode === 'off') return null;
  if (mode === 'first') return total;
  if (mode === 'none') return xpForLevel(10) + 1000 + total;
  return xpForLevel(10) + 1500;
}
/**
 * Put a /v1/me in the store as the real app would have it after this round: atlas=new records the round finishing with
 * one Mouse type fewer, then /v1/me with the new count (the reveal's bar plays its +1); seen: the count, no record.
 */
function applyMe(mode, xp, roundId) {
  const me = { user_id: 'dev', display_name: 'Dev player', initials: 'D', affiliation: null, created_at: '2026-10-01T00:00:00Z',
    streak: 7, best_streak: 7, due_count: 2, groups: [], best_day_total: 4200, days_played: 7 };
  if (xp != null) me.xp_total = xp;
  _resetAtlasMemory();
  if (mode === 'off') { store.update('session', { me }); return; }
  const after = { ...me, atlas: clone(ATLAS) };
  if (mode === 'new') {
    const before = { ...me, atlas: ATLAS.map((a) => (a.species_common === 'Mouse' ? { ...a, seen: a.seen - 1 } : { ...a })) };
    store.update('session', { me: before });
    noteRoundFinished(roundId, before);
  }
  store.update('session', { me: after });
}

// ---------------------------------------------------------------- report mocks
const REPORT_MOCKS = [
  { id: 'ok', label: '200 ok' },
  { id: 'dup', label: '409 already' },
  { id: 'notdone', label: '403 not_done' },
  { id: 'network', label: 'network' },
];
const mockSubmit = (mode) => async (body) => {
  console.info('[dev] POST /v1/report', body);
  await new Promise((r) => setTimeout(r, 450));
  if (mode === 'dup') throw new ApiError(409, 'already_reported', 'Already reported');
  if (mode === 'notdone') throw new ApiError(403, 'not_done', 'Round not done');
  if (mode === 'network') throw new ApiError(0, 'network', 'Could not reach the NeuroGuesser server.');
  return { report_id: 'dev-report' };
};

// ---------------------------------------------------------------- page
const PROGRESS = [
  { id: 'mid', label: 'Mid-day (3–5 to play)' }, { id: 'done', label: 'All done' }, { id: 'grace', label: 'Grace (2–3 open)' },
];
/** The active day for the progress bar, as store.today has it (round 2 = this reveal's state). */
function dayFor(fixture, state, mode, pending) {
  const all = clone(fixture.summary.progress);
  all[1] = pending ? null : state;
  const progress = mode === 'done' ? all : [all[0], all[1], null, null, null];
  const rounds = all.map((st, i) => ({ round_id: (st && st.round_id) || fixture.summary.progress[i].round_id, round_index: i + 1 }));
  const grace = mode === 'grace' ? { date: fixture.summary.date, round_indexes: [2, 3], until: '2026-10-05T00:30:00Z' } : null;
  return { date: `dev-${mode}`, rounds, progress, graceActive: !!grace, grace };
}

const VIEWS = [
  { id: 'reveal', label: 'Reveal' }, { id: 'summary', label: 'Summary' }, { id: 'share', label: 'Share' },
  { id: 'report', label: 'Report' }, { id: 'milestone', label: 'Milestone' },
];

function Section({ title, children }) {
  return html`<section class="card"><span class="card-title">${title}</span>${children}</section>`;
}

function Dev({ fixture }) {
  const [live, setLive] = useState(null);
  const [view, setView] = useState(params.get('view') || 'reveal');
  const [outcome, setOutcome] = useState(params.get('outcome') || 'perfect');
  const [match, setMatch] = useState(params.get('match') || 'same_subclass');
  const [on, setOn] = useState(Object.fromEntries(SECTIONS.map((s) => [s.id, true])));
  const [epoch, setEpoch] = useState(0);
  const [fresh, setFresh] = useState(params.get('fresh') === '1' || params.get('fresh') === null);
  const [pb, setPb] = useState(params.get('pb') !== '0');
  const [streak, setStreak] = useState(Number(params.get('streak')) || fixture.summary.streak);
  const [mock, setMock] = useState('ok');
  const [nFacts, setNFacts] = useState(params.get('facts') === null ? 4 : Number(params.get('facts')));
  const [trivia, setTrivia] = useState(params.get('trivia') || 'v13');
  const [atlas, setAtlas] = useState(params.get('atlas') || 'new');
  const [xpMode, setXpMode] = useState(params.get('xp') || 'up');
  const [dayMode, setDayMode] = useState(params.get('progress') || 'mid');
  const [pending, setPending] = useState(params.get('fill') === '1'); // round 2 not done yet → fills when cleared
  const [sheet, setSheet] = useState(null);
  const settings = useStore((s) => s.session.settings);

  useEffect(() => { loadLive(fixture, params.get('day') || '2026-10-01').then(setLive); }, []);
  useEffect(() => {
    if (view === 'share' || view === 'report' || view === 'milestone') setSheet(view);
    else setSheet(null);
  }, [view]);

  const fx = useMemo(() => withLive(fixture, live), [live]);
  const loader = useMemo(() => makeLoader(fixture, live), [live]);
  const reveal = useMemo(() => revealFor(fx.reveal, on, match, nFacts, trivia, fixture), [fx, on, match, nFacts, trivia]);
  const state = useMemo(() => {
    const st = stateFor(fx.state, outcome);
    if (!on.graph) delete st.clues.graph;
    return st;
  }, [fx, outcome, on.graph]);
  const progress = useMemo(() => {
    const p = clone(fixture.summary.progress);
    p[1] = state;
    return p;
  }, [state]);
  const rounds = progress.map((st) => ({ round_id: st.round_id, round_index: st.round_index }));
  const names = Object.fromEntries(fixture.summary.names.map((x) => [x.round_id, { name: x.name, sub: x.sub }]));
  const tabs = revealTabs(reveal, state.clues.graph ? state.clues.graph.asset : null);
  const day = useMemo(() => dayFor(fixture, state, dayMode, pending), [state, dayMode, pending]);
  const xp = xpFor(xpMode, doneTotal(progress));
  // the store's day (the desktop header's progress bar) and /v1/me (atlas bar, XP card, level chip)
  useEffect(() => { store.update('today', { ...initialState().today, status: 'ready', ...day, dayNumber: fixture.summary.day_number }); }, [day]);
  useEffect(() => { applyMe(atlas, xp, fx.round.round_id); }, [atlas, xp, epoch]);
  // fill demo: the bar first sees round 2 as not done, then done (as when the round just finished)
  useEffect(() => {
    if (!pending || !live) return undefined;
    const id = setTimeout(() => setPending(false), 700);
    return () => clearTimeout(id);
  }, [pending, live]);
  const replay = () => { setFresh(true); applyMe(atlas, xp, fx.round.round_id); setEpoch((e) => e + 1); setPending(true); };

  // summary milestone, as the connected Summary does it
  useEffect(() => {
    if (view !== 'summary' || !fresh || !isMilestone(streak)) return undefined;
    const id = setTimeout(() => setSheet('milestone'), 1100);
    return () => clearTimeout(id);
  }, [view, epoch]);

  const closeSheet = () => { setSheet(null); if (view !== 'reveal' && view !== 'summary') setView('reveal'); };

  let screen = null;
  if (view === 'summary') {
    screen = html`<${SummaryView} key=${`s${epoch}`} dayNumber=${fixture.summary.day_number} date="dev-summary" total=${doneTotal(progress)}
      progress=${progress} rounds=${rounds} names=${names} streak=${streak}
      nextRolloverAt=${new Date(Date.now() + 5 * 3600e3 + 12 * 60e3).toISOString()} personalBest=${pb} fresh=${fresh}
      xp=${xp} xpReady=${true} xpPaused=${!!sheet}
      onShare=${() => setSheet('share')} onOpenRound=${(n) => { setView('reveal'); setFresh(false); showToast(`→ #/today/reveal/${n}`); }} />`;
  } else {
    screen = html`<${RevealView} key=${`r${epoch}`} n=${2} dayNumber=${fx.round.day_number} round=${fx.round} state=${state}
      reveal=${reveal} fresh=${fresh} nextLabel="Next round →" loader=${loader} day=${day}
      graphAsset=${state.clues.graph ? state.clues.graph.asset : null}
      onNext=${() => showToast('ackReveal(2) → next round')} onReport=${() => setSheet('report')}
      onFullView=${() => showToast('openFullView({ roundIndex: 2, mode: "3d" })')} />`;
  }
  let overlay = null;
  if (sheet === 'share') overlay = html`<${ShareSheet} dayNumber=${fixture.summary.day_number} progress=${progress} streak=${streak} onClose=${closeSheet} />`;
  if (sheet === 'report') overlay = html`<${ReportSheet} key=${`rep${epoch}${mock}`} roundIndex=${2} roundId=${`devReport-${epoch}-${mock}`}
    typeName=${reveal.type.name} dayNumber=${fx.round.day_number} submit=${mockSubmit(mock)} onClose=${closeSheet} />`;
  if (sheet === 'milestone') overlay = html`<${MilestoneSheet} streak=${streak} onClose=${closeSheet} />`;

  const chips = (items, value, set) => html`<div class="chips">${items.map((it) => html`<${Chip} key=${it.id}
    active=${value === it.id} onClick=${() => set(it.id)}>${it.label}</${Chip}>`)}</div>`;

  return html`<div class=${cx('dev', params.get('frame') === 'full' && 'is-full')}>
    <div class="dev-controls">
      <div class="stack-4">
        <span class="overline">NeuroGuesser · dev</span>
        <span class="t-title">Reveal, summary, share, report</span>
        <span class="t-label t-muted">Real components, hand-written schema-valid reveal (dev/reveal.fixture.json).</span>
      </div>
      <${Section} title="View">${chips(VIEWS, view, (v) => { setView(v); setSheet(['share', 'report', 'milestone'].includes(v) ? v : null); })}</${Section}>
      <${Section} title="Round outcome">
        ${chips(OUTCOMES, outcome, (o) => { setOutcome(o); setEpoch((e) => e + 1); })}
        <div class="row"><${Button} size="sm" variant="outline" onClick=${replay}>Replay celebrations</${Button}>
          <span class="t-micro t-muted">fresh = ${String(fresh)}</span></div>
      </${Section}>
      <${Section} title="Reveal sections">
        <div class="chips">${SECTIONS.map((s) => html`<${Chip} key=${s.id} active=${on[s.id]}
          onClick=${() => setOn((o) => ({ ...o, [s.id]: !o[s.id] }))}>${on[s.id] ? '✓ ' : ''}${s.label}</${Chip}>`)}</div>
        <span class="t-micro t-muted">Tabs shown: ${tabs.join(' · ') || 'none'}</span>
        <span class="t-label t-muted">Trivia (Facts tab)</span>
        ${chips(TRIVIA, trivia, setTrivia)}
        <span class="t-label t-muted">How many of those facts</span>
        ${chips([0, 1, 2, 3, 4].map((k) => ({ id: k, label: String(k) })), nFacts, setNFacts)}
        <span class="t-label t-muted">Ephys match level</span>
        ${chips(['same_cell', 'same_type', 'same_subclass', 'same_class'].map((id) => ({ id, label: id })), match, setMatch)}
      </${Section}>
      <${Section} title="Atlas bar (reveal)">
        ${chips(ATLAS_MODES, atlas, (m) => { setAtlas(m); applyMe(m, xp, fx.round.round_id); setEpoch((e) => e + 1); })}
        <span class="t-micro t-muted">New type: fresh reveals hold the old count, then fill and stamp "+1 new type".</span>
      </${Section}>
      <${Section} title="XP (summary, header, profile)">
        ${chips(XP_MODES, xpMode, (m) => { setXpMode(m); setEpoch((e) => e + 1); })}
        <span class="t-micro t-muted">me.xp_total = ${xp == null ? 'absent' : xp}; the summary counts today's ${doneTotal(progress)} points in.</span>
      </${Section}>
      <${Section} title="Day progress bar">
        ${chips(PROGRESS, dayMode, setDayMode)}
        <span class="t-micro t-muted">Replay celebrations also replays round 2's fill.</span>
      </${Section}>
      <${Section} title="Summary">
        <${Toggle} label="Personal best" checked=${pb} onChange=${setPb} />
        <span class="t-label t-muted">Streak (milestones 3, 7, 14, 30…)</span>
        ${chips([1, 6, 7, 12, 30].map((n) => ({ id: n, label: String(n) })), streak, setStreak)}
      </${Section}>
      <${Section} title="Report POST mock">${chips(REPORT_MOCKS, mock, setMock)}</${Section}>
      <${Section} title="Settings (real, this origin)">
        <${Toggle} label="Celebrations" hint="Off = reduced motion" checked=${settings.celebrations !== false} onChange=${(v) => setSettings({ celebrations: v })} />
        <${Toggle} label="Haptics" checked=${settings.haptics !== false} onChange=${(v) => setSettings({ haptics: v })} />
      </${Section}>
      <span class="dev-status">${live ? live.note : 'Loading 3D assets from the dev Worker…'}</span>
    </div>
    <div class="dev-phone">
      ${!live ? html`<div class="placeholder-surface">Loading…</div>` : html`<div class="app-root">
        ${params.get('frame') === 'full' ? html`<${TopHeader} active="today" dueCount=${2} xp=${xp} />` : null}
        <main class="app-main">${screen}</main>
        <${TabBar} active="today" dueCount=${2} />
        ${overlay}
        <${Toast} />
      </div>`}
    </div>
  </div>`;
}

async function main() {
  if (params.get('frame') === 'full') loadCss('css/desktop.css'); // the laptop layout only in the full frame (it is per window)
  await hydrateSession();
  document.documentElement.classList.toggle('no-motion', store.get().session.settings.celebrations === false);
  store.subscribe((s) => document.documentElement.classList.toggle('no-motion', s.session.settings.celebrations === false));
  const fixture = await fetch('reveal.fixture.json').then((r) => r.json());
  window.__ngDev = { fixture, store };
  render(html`<${Dev} fixture=${fixture} />`, document.getElementById('app'));
  const tab = params.get('tab');
  // screenshot automation, once rendered: open a detail tab, expand the first quote, scroll the screen
  setTimeout(() => {
    if (tab) {
      const btn = [...document.querySelectorAll('.reveal [role="tab"]')].find((b) => b.textContent.trim().toLowerCase() === tab.toLowerCase());
      if (btn) btn.click();
    }
    setTimeout(() => {
      const qn = Number(params.get('quote'));
      if (qn > 0) { const q = document.querySelectorAll('.dyk-toggle')[qn - 1]; if (q) q.click(); }
      const y = Number(params.get('scroll'));
      if (y > 0) { const sc = document.querySelector('.dev-phone .screen'); if (sc) sc.scrollTop = y; }
    }, 150);
  }, 300);
}
main().catch((err) => { console.error(err); document.body.textContent = `dev page failed: ${err.message}`; });
