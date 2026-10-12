// Ranks tab (W2 "social"; ARCHITECTURE.md §3 "Ranks", §3.1 overtake FLIP; contracts/api.md "Ranks and stats").
//   period segmented (Today / Week / All-time) · scope chips (Friends / Lab / Global; group picker when the user
//   has several of a kind; "Create or join a group" when none) · Your rank card · "How #N was solved" (Today
//   only, round selector 1–5) · rows (compact strip on Today, tap → full strip) · Global top 5 + ⋮ + pinned row.
// Overtake: every board view keeps its own "last seen" snapshot (fx/overtake lastRanksSnapshot under the key
// "seen:<ranksKey>"); when the board changed since then, rows are first rendered in the last-seen order and then
// FLIP-glide to the new one, and when the player moved up the "you" row glows (1.2 s) with a celebrate haptic.
// Exports: default Ranks({ params }) + pure helpers (parseStrip, bucketBars, boardOf, beforeBoard, overtakeOf).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { useStore } from '../store.js';
import * as api from '../api.js';
import * as idb from '../idb.js';
import { Segmented, Chip, Button, Countdown } from '../ui/components.js';
import { navigate } from '../router.js';
import { fmtPts, initials as initialsOf } from '../format.js';
import { flip, useCountUp, motionAllowed } from '../fx/celebrate.js';
import { haptic } from '../fx/haptics.js';
import { lastRanksSnapshot, saveRanksSnapshot, ranksKey } from '../fx/overtake.js';
import { addDays } from '../time.js';
import { loadMe } from '../game.js';

loadCss('css/social.css');

export const PERIODS = [
  { id: 'day', label: 'Today', unit: 'pts today' },
  { id: 'week', label: 'Week', unit: 'pts this week' },
  { id: 'all', label: 'All-time', unit: 'pts all-time' },
];
const PREFS_KEY = 'ranks:view';
const FLIP_MS = 650;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (no DOM)

/**
 * Rank-row strip ("1 □□ ✓ M\n2 ■□ ✕✓ ·", scoring.md glyphs) → one entry per finished round:
 * { round, used (paid clues, 0–2), wrong, correct, method (bool), outcome: 'named'|'met'|'missed', text }.
 */
export function parseStrip(strip) {
  if (!strip) return [];
  const out = [];
  for (const raw of String(strip).split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const tokens = text.split(/\s+/);
    const round = parseInt(tokens[0], 10);
    if (!Number.isFinite(round)) continue;
    let used = 0;
    let wrong = 0;
    let correct = false;
    let method = false;
    for (const tok of tokens.slice(1)) {
      const chars = Array.from(tok);
      if (chars.every((c) => c === '■' || c === '□')) used += chars.filter((c) => c === '■').length;
      else if (chars.every((c) => c === '✕' || c === '✓')) {
        wrong += chars.filter((c) => c === '✕').length;
        if (chars.includes('✓')) correct = true;
      } else if (tok === 'M') method = true;
    }
    const outcome = !correct ? 'missed' : used === 0 && wrong === 0 ? 'named' : 'met';
    out.push({ round, used: Math.min(2, used), wrong, correct, method, outcome, text });
  }
  return out;
}

export const BUCKETS = [
  ['0', 'first try'],
  ['1', '1 extra step'],
  ['2', '2 extra steps'],
  ['3', '3 extra steps'],
  ['4', '4 extra steps'],
  ['missed', 'missed'],
];

/** stats_day round buckets → bar rows { key, label, n, pct (0–100, rounded), width (0–1 of the largest), you }. */
export function bucketBars(buckets, you) {
  if (!buckets) return null;
  const counts = BUCKETS.map(([k]) => Math.max(0, Number(buckets[k]) || 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...counts);
  return BUCKETS.map(([key, label], i) => ({
    key, label, n: counts[i],
    pct: total > 0 ? Math.round((counts[i] / total) * 100) : 0,
    width: max > 0 ? counts[i] / max : 0,
    you: you === key,
  }));
}

/** GET /v1/ranks → the rendered board: rows in order + the pinned own row (Global, when not in the top 5). */
export function boardOf(resp) {
  const rows = resp && Array.isArray(resp.rows) ? resp.rows.slice() : [];
  const me = resp ? resp.me : null;
  const inRows = !!me && rows.some((r) => r.user_id === me.user_id);
  return { rows, pinned: me && !inRows ? me : null };
}

/**
 * The board as it was last seen (snapshot from fx/overtake snapshotOf: { rows: [{user_id, rank, display_name,
 * total, is_me}], me }), filled with the current rows' details so the same user keeps the same row (and its score
 * counts up from the old total). A player who was not on the board then starts at the bottom (Global: the pinned
 * slot) with no rank and 0 points, so they glide up into place. Returns null without a snapshot.
 */
export function beforeBoard(prev, resp, meId) {
  if (!prev || !Array.isArray(prev.rows) || !resp) return null;
  const byId = new Map();
  for (const r of [...(resp.rows || []), resp.me].filter(Boolean)) byId.set(r.user_id, r);
  const fill = (s, isMe) => {
    const cur = byId.get(s.user_id);
    if (cur) return { ...cur, rank: s.rank, total: s.total };
    return {
      rank: s.rank, user_id: s.user_id, display_name: s.display_name || '', initials: initialsOf(s.display_name || ''),
      affiliation: null, total: s.total || 0, streak: 0, strip: null, is_me: !!(isMe || s.is_me),
    };
  };
  const rows = prev.rows.map((r) => fill(r, false));
  const prevMeInRows = !!prev.me && prev.rows.some((r) => r.user_id === prev.me.user_id);
  let pinned = prev.me && !prevMeInRows ? fill(prev.me, true) : null;
  const meNow = resp.me;
  const hadMe = !!prev.me || prev.rows.some((r) => r.is_me || (meId && r.user_id === meId));
  if (meNow && !hadMe) {
    const entry = { ...meNow, rank: null, total: 0 };
    if (resp.scope === 'global') pinned = entry; else rows.push(entry);
  }
  return { rows, pinned };
}

/** Order + numbers signature: equal signatures mean nothing to animate. */
export function boardSignature(b) {
  if (!b) return '';
  const part = (r) => `${r.user_id}:${r.rank}:${r.total}`;
  return [...b.rows.map(part), b.pinned ? `pin:${part(b.pinned)}` : ''].join('|');
}

/**
 * Did "you" move up between two boards? → { oldRank, newRank, passed: [display_name] } or null.
 * passed = players above you before and below you now (visual order; the pinned row counts as last).
 */
export function overtakeOf(before, after, meId) {
  if (!before || !after) return null;
  const flat = (b) => [...b.rows, ...(b.pinned ? [b.pinned] : [])];
  const fb = flat(before);
  const fa = flat(after);
  const isMe = (r) => (meId ? r.user_id === meId : r.is_me);
  const ib = fb.findIndex(isMe);
  const ia = fa.findIndex(isMe);
  if (ib < 0 || ia < 0) return null;
  const mb = fb[ib];
  const ma = fa[ia];
  const posB = new Map(fb.map((r, i) => [r.user_id, i]));
  const passed = fa
    .filter((r, i) => !isMe(r) && posB.has(r.user_id) && posB.get(r.user_id) < ib && i > ia)
    .map((r) => r.display_name);
  // a player new to the board (no rank before) only counts as moving up when they passed someone
  const rankUp = mb.rank != null && ma.rank != null && ma.rank < mb.rank;
  if (!rankUp && !passed.length) return null;
  return { oldRank: mb.rank, newRank: ma.rank, passed };
}

/** One-line note for the Your rank card: "↑ Passed Ana Ribeiro" / "↑ Passed Ana Ribeiro and 2 others" / "↑ Up 3 places". */
export function overtakeNote(ev) {
  if (!ev) return null;
  const p = ev.passed || [];
  if (p.length === 1) return `↑ Passed ${p[0]}`;
  if (p.length === 2) return `↑ Passed ${p[0]} and ${p[1]}`;
  if (p.length > 2) return `↑ Passed ${p[0]} and ${p.length - 1} others`;
  const n = ev.oldRank != null && ev.newRank != null ? ev.oldRank - ev.newRank : 0;
  return n > 0 ? `↑ Up ${fmtPts(n)} ${n === 1 ? 'place' : 'places'}` : null;
}

/** Monday of the ISO week of a 'YYYY-MM-DD' date. */
export function isoMonday(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -dow);
}

/** Snapshot key of a board view: day boards by date, week boards by ISO week, all-time boards once. */
export function seenKey({ period, scope, groupId, date }) {
  const keyDate = period === 'all' ? 'all' : period === 'week' ? isoMonday(date) : date;
  return `seen:${ranksKey({ scope, groupId, date: keyDate, period })}`;
}

/** Scope chips + groups of each kind; the Lab chip is named after the lab when there is exactly one. */
export function scopeModel(groups = []) {
  const friends = groups.filter((g) => g.kind === 'friends');
  const lab = groups.filter((g) => g.kind === 'lab');
  return {
    friends, lab,
    chips: [
      { id: 'friends', label: 'Friends' },
      { id: 'lab', label: lab.length === 1 ? lab[0].name : 'Lab' },
      { id: 'global', label: 'Global' },
    ],
  };
}

/** Default scope for a user's groups: friends, else lab, else global. */
export function defaultScope(groups = []) {
  if (groups.some((g) => g.kind === 'friends')) return 'friends';
  if (groups.some((g) => g.kind === 'lab')) return 'lab';
  return 'global';
}

function stripLabel(lines) {
  return lines.map((l) => `round ${l.round} ${l.outcome}${l.used ? `, ${l.used} clue${l.used > 1 ? 's' : ''}` : ''}`
    + `${l.correct && l.wrong ? `, ${l.wrong} wrong` : ''}, method ${l.method ? 'right' : 'wrong'}`).join('; ');
}

// ---------------------------------------------------------------------------------------------------------
// Components

function MiniStrip({ lines }) {
  if (!lines.length) return null;
  return html`<span class="rk-mini" aria-hidden="true">
    ${lines.map((l) => html`<span key=${l.round} class="rk-mini-col">
      <span class="rk-mini-boxes"><i class=${cx('rk-box', l.used > 0 && 'is-used')}></i><i class=${cx('rk-box', l.used > 1 && 'is-used')}></i></span>
      <span class=${cx('rk-mini-glyph', l.correct ? 'is-ok' : 'is-miss')}>${l.correct ? '✓' : '✕'}</span>
    </span>`)}
  </span>`;
}

function FullStrip({ lines, id }) {
  return html`<div class="rk-strip" id=${id}>
    ${lines.map((l) => html`<div key=${l.round} class="rk-strip-line">
      <span class="rk-strip-n">${l.round}</span>
      <span class="rk-strip-boxes" aria-label=${`${l.used} of 2 paid clues`}>${'■'.repeat(l.used)}${'□'.repeat(2 - l.used)}</span>
      <span class="rk-strip-marks"><span class="t-error">${'✕'.repeat(l.wrong)}</span>${l.correct ? html`<span class="t-accent">✓</span>` : null}</span>
      <span class=${l.method ? 't-accent' : 't-muted'} aria-label=${l.method ? 'method right' : 'method wrong'}>${l.method ? 'M' : '·'}</span>
      <span class=${cx('rk-strip-word', l.outcome === 'missed' ? 't-error' : l.outcome === 'named' ? 't-accent' : 't-soft')}>${l.outcome}</span>
    </div>`)}
  </div>`;
}

function RankRow({ row, today, open, onToggle }) {
  const total = useCountUp(row.total || 0, { duration: 700 });
  const lines = today ? parseStrip(row.strip) : [];
  const expandable = today && lines.length > 0;
  const name = row.is_me ? 'You' : row.display_name;
  const sub = [row.affiliation, row.streak > 0 ? `${row.streak} d streak` : null].filter(Boolean).join(' · ');
  const rankText = row.rank == null ? '—' : fmtPts(row.rank);
  const label = `${row.rank == null ? 'Unranked' : `Rank ${rankText}`}, ${row.is_me ? `you (${row.display_name})` : row.display_name}`
    + `${row.affiliation ? `, ${row.affiliation}` : ''}, ${fmtPts(row.total || 0)} points`
    + `${row.streak > 0 ? `, ${row.streak}-day streak` : ''}${expandable ? `. ${stripLabel(lines)}` : ''}`;
  const stripId = `rk-strip-${row.user_id}`;
  const inner = html`
    <span class="rk-rank">${rankText}</span>
    <span class="rk-avatar" aria-hidden="true">${row.initials || initialsOf(row.display_name)}</span>
    <span class="rk-who"><span class="rk-name">${name}</span>${sub ? html`<span class="rk-sub">${sub}</span>` : null}</span>
    <span class="rk-score"><span class="rk-total">${fmtPts(total)}</span>${today ? html`<${MiniStrip} lines=${lines} />` : null}</span>`;
  return html`<div class=${cx('rk-row-wrap', row.is_me && 'is-me', open && 'is-open')} data-key=${row.user_id}>
    ${expandable
    ? html`<button type="button" class="rk-row" aria-expanded=${open ? 'true' : 'false'} aria-controls=${open ? stripId : null}
        aria-label=${label} onClick=${() => { haptic('selection'); onToggle(row.user_id); }}>${inner}</button>`
    : html`<div class="rk-row" role="group" aria-label=${label}>${inner}</div>`}
    ${open && expandable ? html`<${FullStrip} lines=${lines} id=${stripId} />` : null}
  </div>`;
}

function YourRank({ me, unit, of, streak, note }) {
  const total = useCountUp(me ? me.total : 0, { duration: 700 });
  return html`<div class=${cx('rk-me', !me && 'is-empty')} role="group" aria-label="Your rank">
    <span class="rk-me-rank">${me && me.rank != null ? `#${fmtPts(me.rank)}` : '—'}</span>
    <span class="rk-me-who">
      <span class="rk-me-name">You</span>
      <span class="rk-me-sub">${me ? of : 'Not on this board yet'}${streak > 0 ? ` · ${streak} d streak` : ''}</span>
      ${note ? html`<span class="rk-me-note" role="status">${note}</span>` : null}
    </span>
    <span class="rk-me-score"><span class="rk-me-total">${me ? fmtPts(total) : '—'}</span><span class="rk-me-unit">${unit}</span></span>
  </div>`;
}

function Solved({ stats, dayNumber, round, onRound }) {
  const r = stats.rounds.find((x) => x.round_index === round) || stats.rounds[round - 1];
  const bars = r ? bucketBars(r.buckets, r.you) : null;
  const title = dayNumber ? `How #${dayNumber} was solved` : "How today's neurons were solved";
  return html`<div class="rk-solved" role="group" aria-label=${title}>
    <div class="rk-solved-head"><span class="card-title-sm">${title}</span>
      <span class="t-num-11 t-muted">${fmtPts(stats.n_players)} ${stats.n_players === 1 ? 'player' : 'players'}</span></div>
    <div class="rk-rounds" role="tablist" aria-label="Round">
      <span class="t-micro t-muted" aria-hidden="true">Round</span>
      ${[1, 2, 3, 4, 5].map((i) => html`<button type="button" role="tab" key=${i} aria-selected=${i === round ? 'true' : 'false'}
        aria-label=${`Round ${i}`} class=${cx(i === round && 'is-active')}
        onClick=${() => { if (i !== round) { haptic('selection'); onRound(i); } }}>${i}</button>`)}
    </div>
    ${bars ? html`<div class="rk-bars" key=${`r${round}`}>
      ${bars.map((b) => html`<div key=${b.key} class=${cx('rk-bar-row', b.you && 'is-you')}>
        <span class="rk-bar-label">${b.label}</span>
        <span class="rk-bar-track"><span class="rk-bar-fill" style=${{ width: `${(b.width * 100).toFixed(1)}%` }}></span></span>
        <span class="rk-bar-pct">${b.pct}%</span>
        <span class="rk-bar-you">${b.you ? 'you' : ''}</span>
      </div>`)}
    </div>` : html`<span class="t-micro t-muted rk-solved-locked">Finish round ${round} to see how others solved it</span>`}
  </div>`;
}

function StateCard({ glyph, title, body, children }) {
  return html`<div class="rk-state" role="status">
    <span class="empty-glyph" aria-hidden="true">${glyph}</span>
    <span class="t-card">${title}</span>
    ${body ? html`<span class="t-body t-soft">${body}</span>` : null}
    ${children}
  </div>`;
}

function Skeleton() {
  return html`<div class="rk-skel" aria-busy="true" aria-label="Loading ranks">
    <div class="skeleton rk-skel-me"></div>
    ${[0, 1, 2, 3].map((i) => html`<div key=${i} class="skeleton rk-skel-row"></div>`)}
  </div>`;
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch (_) { /* fall through */ }
  return Promise.resolve(false);
}

function GroupCta({ kind }) {
  return html`<div class="card rk-cta">
    <span class="overline">${kind === 'lab' ? 'No lab group yet' : 'No friends group yet'}</span>
    <span class="t-body t-soft">${kind === 'lab'
    ? 'Make a group for your lab and share its join code, or join one with a code from a colleague.'
    : 'Make a group for your friends and share its join code, or join one with a code from a friend.'}</span>
    <${Button} block onClick=${() => navigate(`/settings?group=${kind}`)}>Create or join a group</${Button}>
  </div>`;
}

function EmptyBoard({ period, group, today }) {
  const [copied, setCopied] = useState(false);
  const when = period === 'day' ? 'today' : period === 'week' ? 'this week' : 'yet';
  const title = group ? `Nobody in ${group.name} has scored ${when}` : `No scores ${when}`;
  return html`<${StateCard} glyph="#" title=${title}
    body=${group ? 'Scores appear as soon as a member finishes a round. Share the join code to bring people in.'
      : 'Scores appear as soon as someone finishes a round.'}>
    ${group && group.join_code ? html`<div class="rk-code-row">
      <span class="t-num-13 rk-code">${group.join_code}</span>
      <${Button} variant="outline" size="sm" onClick=${() => copyText(group.join_code).then((ok) => { setCopied(ok); if (ok) setTimeout(() => setCopied(false), 2000); })}>${copied ? '✓ Copied' : 'Copy code'}</${Button}>
    </div>` : null}
    ${today ? html`<${Button} variant="outline" block onClick=${() => navigate('/today')}>Play today's neurons</${Button}>` : null}
  </${StateCard}>`;
}

async function loadPrefs() {
  try { return (await idb.get(PREFS_KEY)) || null; } catch (_) { return null; }
}

async function pruneSeen(today) {
  try {
    const cutoff = addDays(today, -21);
    const keys = await idb.keys('lastRanks:seen:');
    for (const k of keys) {
      const m = /:(\d{4}-\d{2}-\d{2})(?::|$)/.exec(k);
      if (m && m[1] < cutoff) await idb.del(k);
    }
  } catch (_) { /* best effort */ }
}

export default function Ranks() {
  const me = useStore((s) => s.session.me);
  const online = useStore((s) => s.ui.online);
  const today = useStore((s) => ({ date: s.today.date, todayDate: s.today.todayDate, dayNumber: s.today.dayNumber, nextRolloverAt: s.today.nextRolloverAt }));

  const groups = (me && me.groups) || [];
  const scopes = scopeModel(groups);

  const [prefs, setPrefs] = useState(null); // { period, scope, groupIds: { friends, lab } }
  const [status, setStatus] = useState('loading'); // loading | ready | error | offline
  const [error, setError] = useState(null);
  const [board, setBoard] = useState(null); // { viewKey, phase, rows, pinned, resp, note }
  const [stats, setStats] = useState(null);
  const [round, setRound] = useState(1);
  const [openId, setOpenId] = useState(null);
  const [tick, setTick] = useState(0);
  const listRef = useRef(null);
  const pending = useRef(null);
  const playRef = useRef(null);
  const reqId = useRef(0);
  const retryRef = useRef(false);
  const retry = () => { retryRef.current = true; setTick((n) => n + 1); };

  // boot: refresh /me (groups), restore the last view, prune old snapshots
  useEffect(() => {
    loadMe();
    let alive = true;
    loadPrefs().then((p) => { if (alive) setPrefs(p || {}); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (today.todayDate) pruneSeen(today.todayDate); }, [today.todayDate]);

  // re-fetch when the app comes back to the foreground
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setTick((n) => n + 1); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const period = (prefs && prefs.period) || 'day';
  const meKnown = !!me;
  let scope = prefs && prefs.scope ? prefs.scope : (meKnown ? defaultScope(groups) : 'global');
  const ofKind = scope === 'global' ? [] : scopes[scope] || [];
  const wantedGroup = scope !== 'global' && prefs && prefs.groupIds ? prefs.groupIds[scope] : null;
  const group = scope === 'global' ? null : (ofKind.find((g) => g.group_id === wantedGroup) || ofKind[0] || null);
  const needsGroup = scope !== 'global' && meKnown && !group;
  if (scope !== 'global' && !meKnown) scope = 'global'; // groups unknown until /me arrives
  const groupId = group ? group.group_id : null;
  const date = today.todayDate || null;
  const viewKey = `${period}|${scope}|${groupId || '-'}`;

  const savePrefs = (patch) => {
    const next = { period, scope: prefs && prefs.scope ? prefs.scope : scope, groupIds: { ...((prefs && prefs.groupIds) || {}) }, ...patch };
    setPrefs(next);
    idb.set(PREFS_KEY, next);
  };

  // ---- fetch + FLIP orchestration ----
  useEffect(() => {
    if (!prefs) return undefined;
    // "Try again" always fetches: store.ui.online stays false after a failed request (server unreachable,
    // timeout) until some request succeeds, and no 'online' event comes while the browser itself is online
    const force = retryRef.current;
    retryRef.current = false;
    if (needsGroup) { setStatus('ready'); return undefined; }
    if (!online && !force) { setStatus('offline'); return undefined; }
    const id = ++reqId.current;
    const sameView = board && board.viewKey === viewKey;
    if (!sameView || force) setStatus('loading');
    if (!sameView) setOpenId(null);
    (async () => {
      try {
        const params = { scope, period, group_id: groupId || undefined, date: period === 'day' && date ? date : undefined };
        const statsParams = { scope, group_id: groupId || undefined };
        const [ranksResp, statsResp] = await Promise.all([
          api.getRanks(params),
          period === 'day' && date ? api.getDayStats(date, statsParams).catch(() => null) : Promise.resolve(null),
        ]);
        let st = statsResp;
        if (period === 'day' && !date && ranksResp.date) st = await api.getDayStats(ranksResp.date, statsParams).catch(() => null);
        if (id !== reqId.current) return;

        const meId = (ranksResp.me && ranksResp.me.user_id) || (me && me.user_id) || null;
        const key = seenKey({ period, scope, groupId, date: ranksResp.date });
        let prev = await lastRanksSnapshot(key);
        if (!prev && period === 'day') prev = await lastRanksSnapshot(ranksKey({ scope, groupId, date: ranksResp.date }));
        if (id !== reqId.current) return;

        // `flip`: this view's list glides from the last-seen order, so it must not also run the .fx-stagger
        // fade-in (that CSS animation holds each row at opacity 0 for its stagger delay and restarts on rows
        // Preact moves, which hid the "you" row for most of its glide). Sticky per view: re-adding the class
        // later would replay the fade on every row.
        const after = { ...boardOf(ranksResp), viewKey, phase: 'after', resp: ranksResp, note: null, flip: false };
        const before = beforeBoard(prev, ranksResp, meId);
        if (before && boardSignature(before) !== boardSignature(after)) {
          const ev = overtakeOf(before, after, meId);
          if (ev) after.note = overtakeNote(ev);
          after.flip = true;
          pending.current = { after, glow: ev ? meId : null, celebrate: !!ev };
          setBoard({ ...before, viewKey, phase: 'before', resp: ranksResp, note: null, flip: true });
        } else {
          pending.current = null;
          setBoard((cur) => {
            const same = !!cur && cur.viewKey === viewKey;
            const next = { ...after, flip: same && !!cur.flip };
            if (same && cur.note && boardSignature(cur) === boardSignature(after)) next.note = cur.note;
            return next;
          });
        }
        setStats(st);
        if (st && period === 'day') {
          const done = st.rounds.filter((x) => x.you !== null).map((x) => x.round_index);
          if (!sameView) setRound(done.length ? Math.max(...done) : 1);
        }
        setError(null);
        setStatus('ready');
        saveRanksSnapshot(key, ranksResp);
      } catch (err) {
        if (id !== reqId.current) return;
        if (err && err.isNetwork) { setStatus('offline'); return; }
        if (err && err.status === 403) loadMe(); // no longer a member: /me drops the group, the view falls back
        setError(err);
        setStatus('error');
      }
    })();
    return undefined;
  }, [prefs ? viewKey : null, online, needsGroup, date, tick]);

  // phase 'before' is committed: capture the rects, then commit the new order
  useLayoutEffect(() => {
    if (!board || board.phase !== 'before' || !pending.current) return;
    const p = pending.current;
    pending.current = null;
    playRef.current = { play: flip(listRef.current), glow: p.glow, celebrate: p.celebrate };
    setBoard(p.after);
  }, [board]);
  // phase 'after' is committed: glide every row from its last-seen place; glow + celebrate on an overtake
  useLayoutEffect(() => {
    if (!board || board.phase !== 'after' || !playRef.current) return;
    const { play, glow, celebrate } = playRef.current;
    playRef.current = null;
    play({ duration: FLIP_MS, glowKey: glow });
    if (celebrate) {
      haptic('celebrate');
      // the list can start below the fold (rank card + distribution): bring the "you" row into view as it glides
      const el = listRef.current && listRef.current.querySelector('.rk-row-wrap.is-me');
      const screen = el && el.closest('.screen');
      if (el && screen) {
        const r = el.getBoundingClientRect();
        const s = screen.getBoundingClientRect();
        if (r.bottom > s.bottom - 8 || r.top < s.top) {
          screen.scrollTo({ top: Math.max(0, screen.scrollTop + r.top - s.top - s.height / 2 + r.height / 2), behavior: motionAllowed() ? 'smooth' : 'auto' });
        }
      }
    }
  }, [board]);

  const toggleRow = useCallback((uid) => setOpenId((cur) => (cur === uid ? null : uid)), []);

  // ---- view ----
  const periodInfo = PERIODS.find((p) => p.id === period) || PERIODS[0];
  const isToday = period === 'day';
  const resp = board && board.viewKey === viewKey ? board.resp : null;
  const flat = board && board.viewKey === viewKey ? [...board.rows, ...(board.pinned ? [board.pinned] : [])] : [];
  const myRow = flat.find((r) => r.is_me) || null;
  const nPlayers = resp ? resp.n_players : 0;
  const groupName = (resp && resp.group && resp.group.name) || (group && group.name) || '';
  const of = scope === 'global' ? `of ${fmtPts(nPlayers)} ${nPlayers === 1 ? 'player' : 'players'}`
    : scope === 'friends' ? `of ${fmtPts(nPlayers)} ${nPlayers === 1 ? 'friend' : 'friends'}`
      : `of ${fmtPts(nPlayers)} in ${groupName}`;
  const streak = myRow ? myRow.streak : me ? me.streak : 0;
  const dayNumber = (() => {
    const d = resp ? resp.date : date;
    if (!d || !today.date || !today.dayNumber) return null;
    const diff = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today.date}T00:00:00Z`)) / 86400000);
    const n = today.dayNumber + diff;
    return n >= 1 ? n : null;
  })();

  const items = [];
  if (board && board.viewKey === viewKey) {
    for (const r of board.rows) {
      items.push(html`<${RankRow} key=${r.user_id} row=${r} today=${isToday} open=${openId === r.user_id} onToggle=${toggleRow} />`);
    }
    if (board.pinned) {
      items.push(html`<div key="__gap" class="rk-gap" aria-hidden="true">⋮</div>`);
      items.push(html`<${RankRow} key=${board.pinned.user_id} row=${board.pinned} today=${isToday} open=${openId === board.pinned.user_id} onToggle=${toggleRow} />`);
    }
  }

  let body;
  if (needsGroup) {
    body = html`<${GroupCta} kind=${scope} />`;
  } else if (status === 'offline') {
    body = html`<${StateCard} glyph="!" title="Ranks need a connection"
      body="Scores and boards live on the server. Your games are saved; ranks come back when you are online.">
      <${Button} variant="outline" block onClick=${retry}>Try again</${Button}>
    </${StateCard}>`;
  } else if (status === 'error' && !resp) {
    body = html`<${StateCard} glyph="✕" title="Ranks didn't load"
      body=${error && error.message ? error.message : 'Something went wrong on the server.'}>
      <${Button} variant="outline" block onClick=${retry}>Try again</${Button}>
    </${StateCard}>`;
  } else if (!resp) {
    body = html`<${Skeleton} />`;
  } else {
    const empty = !flat.length;
    body = html`
      <${YourRank} me=${myRow} unit=${periodInfo.unit} of=${of} streak=${streak} note=${board.note} />
      ${isToday && stats && stats.rounds && stats.rounds.length ? html`<${Solved} stats=${stats} dayNumber=${dayNumber} round=${round} onRound=${setRound} />` : null}
      ${empty ? html`<${EmptyBoard} period=${period} group=${group} today=${isToday && !myRow} />`
    : html`<div class=${cx('rk-list', !board.flip && 'fx-stagger')} ref=${listRef}>${items}</div>`}
      ${!empty && isToday ? html`<span class="rk-legend">■ paid clue opened · ✓/✕ cell type · M method right · extra step = a paid clue or a wrong guess · tap a row for the full strip</span>` : null}
      ${scope === 'global' && groups.length === 0 ? html`<${Button} variant="text" class="rk-cta-link" onClick=${() => navigate('/settings?group=lab')}>Play with your lab: create or join a group</${Button}>` : null}`;
  }

  return html`<div class="screen rk"><div class="screen-pad">
    <div class="screen-head">
      <span class="t-title">Leaderboard</span>
      <span class="rk-head-right">
        ${today.nextRolloverAt ? html`<span class="t-num-11 t-muted rk-next">next neurons <${Countdown} to=${today.nextRolloverAt} /></span>` : null}
        <${Button} variant="text" onClick=${() => navigate('/settings')}>Profile</${Button}>
      </span>
    </div>
    <${Segmented} label="Period" options=${PERIODS} value=${period} onChange=${(id) => savePrefs({ period: id })} />
    <div class="chips rk-scopes" role="group" aria-label="Scope">
      ${scopes.chips.map((c) => html`<${Chip} key=${c.id} active=${scope === c.id} onClick=${() => savePrefs({ scope: c.id })}>${c.label}</${Chip}>`)}
    </div>
    ${ofKind.length > 1 ? html`<div class="chips rk-groups" role="group" aria-label=${scope === 'lab' ? 'Lab group' : 'Friends group'}>
      ${ofKind.map((g) => html`<${Chip} key=${g.group_id} active=${groupId === g.group_id}
        onClick=${() => savePrefs({ groupIds: { ...((prefs && prefs.groupIds) || {}), [scope]: g.group_id } })}>${g.name}</${Chip}>`)}
    </div>` : null}
    ${body}
  </div></div>`;
}
