// Atlas collection bar (ARCHITECTURE.md §3.4 item 3; contracts api.md GET /v1/me `atlas`, v1.3): after each reveal,
// the round's species and how many of its cell types the player has collected, with a +1 when this round's type is new.
//
//   Fly atlas                           +1 NEW TYPE   24/56
//   ===================------------------------------------
//
// me.atlas rows are { species_common, seen, total }: seen = distinct types the player has finished (any outcome), the
// same rule as the Library's atlas coverage. A round adds a type when the species' `seen` grew between me.atlas just
// before the round finished and me.atlas after it (GET /v1/me reloads when a round finishes, game.js afterWrite). This
// module watches the store from import (reveal.js imports it, and today.js imports reveal.js, so it runs before any
// round can finish): the first time it sees a day, the rounds already done are its baseline (a reload or a resume
// never animates); a round that becomes done later records the me.atlas of that moment. The bar on that round's
// fresh (not yet acknowledged) reveal then shows the old count for a beat, fills to the new one, counts up and stamps
// "+1 new type" — once per round per session; a remount shows the end state with the same words. When /v1/me answers
// after the reveal has mounted, the bar fills from the old count the moment it does. A revisit (the summary's rows)
// shows the plain count. Reduced motion / Celebrations off: the same words, no motion. No haptic (§3.1: the meter fill
// is the whole moment).
//
// Exports: AtlasBar (component), atlasRow / atlasSnapshot / atlasGrowth / observeAtlas / noteRoundFinished (pure or
// module memory, unit-tested in tests/progress-bars.test.js), _resetAtlasMemory (tests).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from './html.js';
import { store, useStore } from '../store.js';
import { useCountUp, stamp, motionAllowed } from '../fx/celebrate.js';

loadCss('css/progress-bars.css');

const HOLD_MS = 650; // the old count stays for a beat (after the day progress bar's own fill) before the +1

/** The species' row of me.atlas as { seen, total } (seen clamped to 0 … total), or null without data. */
export function atlasRow(me, species) {
  if (!me || !Array.isArray(me.atlas) || !species) return null;
  const r = me.atlas.find((a) => a && a.species_common === species);
  if (!r || !Number.isFinite(r.total) || r.total <= 0) return null;
  const seen = Number.isFinite(r.seen) ? Math.max(0, Math.min(r.total, Math.floor(r.seen))) : 0;
  return { seen, total: Math.floor(r.total) };
}

/** { [species_common]: seen } of me.atlas, or null. */
export function atlasSnapshot(me) {
  if (!me || !Array.isArray(me.atlas)) return null;
  const out = {};
  for (const a of me.atlas) if (a && a.species_common && Number.isFinite(a.seen)) out[a.species_common] = a.seen;
  return out;
}

// ---- module memory (this session only) ----
const baseline = new Map(); // date → Set of round_ids already done when this session first saw the day
const finished = new Map(); // round_id → { at, before: atlasSnapshot(me) when the round became done }
const played = new Set();   // round_ids whose +1 has played

/** Record that `roundId` became done now, with the me.atlas from just before (the first record wins). */
export function noteRoundFinished(roundId, me, at = Date.now()) {
  if (roundId && !finished.has(roundId)) finished.set(roundId, { at, before: atlasSnapshot(me) });
}

/** Store observer: rounds that become done after this session first saw their day. Never throws. */
export function observeAtlas(s) {
  try {
    const t = s && s.today;
    if (!t || !t.date || !Array.isArray(t.rounds) || !t.rounds.length) return;
    const done = (t.progress || []).filter((st) => st && st.stage === 'done' && st.round_id).map((st) => st.round_id);
    const known = baseline.get(t.date);
    if (!known) { baseline.set(t.date, new Set(done)); return; }
    for (const id of done) {
      if (known.has(id)) continue;
      known.add(id);
      noteRoundFinished(id, s.session && s.session.me);
    }
  } catch (_) { /* never break the store */ }
}

/**
 * { row, from, grew }: the species' current row; grew = this round added a type (its `seen` is above the count
 * recorded when the round finished in this session); from = that earlier count (row.seen otherwise).
 */
export function atlasGrowth(roundId, species, me) {
  const row = atlasRow(me, species);
  const rec = roundId ? finished.get(roundId) : null;
  const before = rec && rec.before ? rec.before[species] : undefined;
  if (!row || !Number.isFinite(before) || !(row.seen > before)) return { row, from: row ? row.seen : 0, grew: false };
  return { row, from: Math.max(0, Math.min(row.seen, before)), grew: true };
}

/** Tests only. */
export function _resetAtlasMemory() { baseline.clear(); finished.clear(); played.clear(); }

store.subscribe(observeAtlas);
observeAtlas(store.get());

/** "Fly atlas: 24 of 56 cell types collected, 1 new from this round" (screen readers; the bar itself is drawn). */
export function atlasLabel(species, row, added = 0) {
  if (!row) return '';
  return `${species} atlas: ${row.seen} of ${row.total} cell types collected${added > 0 ? `, ${added} new from this round` : ''}`;
}

/**
 * <AtlasBar species roundId fresh class> — the species' collection bar (store-connected: session.me). Nothing without
 * atlas data (no species, an older Worker, or /v1/me not loaded yet). fresh: the round's reveal has not been
 * acknowledged yet, so a new type is celebrated.
 */
export function AtlasBar({ species, roundId = null, fresh = false, class: klass }) {
  const me = useStore((s) => s.session.me);
  const g = atlasGrowth(roundId, species, me);
  const celebrate = !!(fresh && g.grew);
  const [hold, setHold] = useState(() => celebrate && !played.has(roundId) && motionAllowed());
  const chipRef = useRef(null);

  useEffect(() => {
    if (!hold) return undefined;
    const id = setTimeout(() => setHold(false), HOLD_MS);
    return () => clearTimeout(id);
  }, [hold]);
  // the "+1 new type" chip stamps in once per round per session (a late /v1/me answer gets the same moment)
  useEffect(() => {
    if (!celebrate || hold || played.has(roundId)) return;
    played.add(roundId);
    stamp(chipRef.current);
  }, [celebrate, hold, roundId]);

  const total = g.row ? g.row.total : 0;
  const value = g.row ? (hold ? g.from : g.row.seen) : 0;
  const shown = useCountUp(value, { duration: 600 });
  if (!g.row) return null;
  const frac = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const added = celebrate && !hold ? g.row.seen - g.from : 0;
  return html`<div class=${cx('atlas-bar', klass)} role="img" aria-label=${atlasLabel(species, { seen: value, total }, added)}>
    <div class="atlas-top" aria-hidden="true">
      <span class="atlas-sp">${species} atlas</span>
      <span class="atlas-right">
        ${added > 0 ? html`<span class="chip-mono atlas-new" ref=${chipRef}>+${added} new type${added > 1 ? 's' : ''}</span>` : null}
        <span class=${cx('atlas-num', added > 0 && 'is-up')}>${shown}/${total}</span>
      </span>
    </div>
    <div class="meter atlas-meter" aria-hidden="true"><span style=${{ transform: `scaleX(${frac})` }}></span></div>
  </div>`;
}

export default AtlasBar;
