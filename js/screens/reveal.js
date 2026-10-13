// Per-round reveal (ARCHITECTURE.md §3 "Reveal" as changed by §3.3 item 2 (v1.2): the reveal leads with the neuron,
// not the method; handoff screen 3; contracts round_reveal v1.1).
//
//   hero MeshViewer (420 px): "Cell | In context" (context default: reveal.context volume + labels + siblings
//     at neuron_offset_um), toggles "✓ Volume" · "✓ <type> · N" (only with siblings) · "✓ Layers"/"✓ Regions",
//     legend, µm scale bar, zoom ± and ⤢ full view; verdict top-left "✓ Named · 1,200 pts" / "✓ Met · 800 pts"
//     (accent) or "✕ Missed · 200 pts" (state-error)
//   day progress bar (§3.3 item 3; the round that just finished fills here on phones)
//   overline "#33 · ROUND 2 · IT WAS", name (23), species · region
//   atlas collection bar for the round's species, "+1 new type" when this round's type is new (§3.4 item 3,
//     js/ui/atlas-bar.js)
//   tabs Facts · Ephys · Genes · Graph · How it was made · Papers (empty ones hidden; Facts is the default):
//     Facts (v1.3, §3.4 item 1): role line → "Did you know?" card in three labelled parts, one item each —
//       (v1.4: led by "In short", the type's `summary` fact, when the reveal has one)
//       "What it does" (a `function` fact, else the role line), "How to tell it apart" (the `identify` fact whose
//       look-alikes best match this round's options, "vs <contrast_with_labels>"), "Who it talks to" (a
//       `connectivity` fact + a data line templated from the round's graph clue) — each fact with "— Citation ↗" to
//       the DOI and its verbatim quote(s) behind "Show quote" (support quotes with their own citations) → transmitter
//       line → "Also called" → the facts not in a part; nothing yet → "More about this cell soon"
//     How it was made: provenance line, How this cell was typed (summary + typing facts, label in words), imaging
//       method (name, variant, your method verdict, voxel, what to notice, Neuroglancer ↗)
//     Papers: every citation (DOI links) + attribution
//   one-line personal outcome; "Next round →" / "Today's results" (accent) + "Neuroglancer ↗"; "Report a problem";
//   footer "✓ Added to your library · review in N days".
//
// Delight (§3.1): a perfect round (1,200) pulses an accent ring around the verdict, stamps "PERFECT ROUND"
// and fires haptic('celebrate'); after a round finishes, leaderboard overtakes are announced as a toast.
// Both only on the "fresh" reveal (not yet acknowledged), never on a revisit from the summary.
//
// Exports: default Reveal({ params: { n } }) (today.js), RevealView (pure; dev/reveal.html renders it with a
// hand-written reveal), FactsPanel / MadePanel (tab panels, unit-tested), and pure helpers (verdictOf, outcomeLine,
// transmitterLine, roleLine, triviaParts, pickIdentify, graphDataLine, quotesOf, revealTabs, ephysCaption, fmtVoxel,
// methodVerdict, reviewDays, niceTicks, tracePath, fmtNum, safeUrl, doiUrl).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { useStore } from '../store.js';
import * as api from '../api.js';
import { Button, GhostButton, Segmented, ScaleBar, OfflineChip } from '../ui/components.js';
import { MeshViewer } from '../viewer/mesh-viewer.js';
import { GraphView } from '../viewer/graph-view.js';
import { loadReveal, ackReveal, outcomeOf, currentView } from '../game.js';
import { fmtPts, fmtSigned, methodName, GLYPH } from '../format.js';
import { emKind } from '../viewer/em2/factory.js';
import { haptic } from '../fx/haptics.js';
import { pulse, stamp } from '../fx/celebrate.js';
import { checkOvertakes, announceOvertakes } from '../fx/overtake.js';
import { openReport, useReported } from './report.js';
import { markDayComplete } from './summary.js';
import { DayProgress } from '../ui/day-progress.js';
import { AtlasBar } from '../ui/atlas-bar.js';

loadCss('css/reveal.css');

const MINUS = GLYPH.minus;
const NBSP = ' '; // keeps a link's "↗" on the line of its last word when a citation wraps
const REVIEW_DAYS = { named: 7, met: 2, missed: 2 }; // api.md SRS: named → step 1 (7 d), met/missed → step 0 (2 d)

// ======================================================================================
// Pure helpers
// ======================================================================================

/** Only http(s) links leave the app (reveal URLs are data, never javascript:). */
export function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) ? u : null;
}
export const doiUrl = (doi) => `https://doi.org/${encodeURI(String(doi || ''))}`;

/** Compact number: 3 significant digits, true minus, thousands commas from 1,000. */
export function fmtNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  let s;
  if (a >= 1000) s = fmtPts(a);
  else if (a === 0) s = '0';
  else s = String(Number(a.toPrecision(3)));
  return v < 0 ? MINUS + s : s;
}

/** Verdict for the hero: { word, glyph, tone, points }. */
export function verdictOf(state) {
  const outcome = outcomeOf(state);
  const points = state ? state.score : 0;
  if (outcome === 'named') return { word: 'Named', glyph: '✓', tone: 'accent', points };
  if (outcome === 'met') return { word: 'Met', glyph: '✓', tone: 'accent', points };
  if (outcome === 'missed') return { word: 'Missed', glyph: '✕', tone: 'error', points };
  return { word: 'Revealed', glyph: '·', tone: 'muted', points };
}

/** A layer toggle's text: "✓ Volume" when on, "Volume off" when off (every state is a glyph or a word). */
export function toggleText(label, on) {
  return on ? `✓ ${label}` : `${label} off`;
}

const SHORT_MAX = 10;
const shortOk = (x) => typeof x === 'string' && x.length > 0 && x.length <= SHORT_MAX && x.split(' ').length <= 2
  && /[A-Z0-9]/.test(x);
/**
 * Short form of a cell type for chips ("Dm8 medulla amacrine neuron" → "Dm8", "Mushroom body output neuron (MBON)" →
 * "MBON", "L2/3 IT pyramidal neuron" → "L2/3 IT"): the name's abbreviation in brackets, else the first synonym of at
 * most two words and 10 characters with a capital or digit, else the name's first word when the rest is just
 * "neuron" / "cell"; none of them → "Same type". App Design Guide §4: no repeated long names.
 */
export function shortTypeName(type) {
  const t = type || {};
  const name = typeof t.name === 'string' ? t.name : '';
  const paren = /\(([^()]+)\)/.exec(name);
  if (paren && shortOk(paren[1])) return paren[1];
  for (const syn of t.synonyms || []) if (shortOk(syn)) return syn;
  const m = /^(\S+) (?:neuron|cell)$/.exec(name);
  if (m && shortOk(m[1])) return m[1];
  if (shortOk(name)) return name;
  return 'Same type';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "Got it after 1 wrong guess and 1 clue · method ✓ +200" (one line, no answer text). */
export function outcomeLine(state) {
  if (!state || state.stage === 'type') return 'The day is over, so the answer is shown.';
  const clues = (state.clues_opened || []).length;
  const wrong = (state.wrong || []).length;
  const outcome = outcomeOf(state);
  const cluePart = clues ? plural(clues, 'clue', 'clues') : null;
  let head;
  if (outcome === 'named') head = 'Named on the first guess, no clues';
  else if (outcome === 'met') head = `Got it after ${[wrong ? plural(wrong, 'wrong guess', 'wrong guesses') : null, cluePart].filter(Boolean).join(' and ')}`;
  else head = `Not named: ${plural(wrong, 'wrong guess', 'wrong guesses')}${cluePart ? ` after ${cluePart}` : ''}`;
  if (state.stage !== 'done') return head;
  const method = state.method_correct ? 'method ✓ +200' : state.method_pick == null ? 'method skipped' : 'method ✕';
  return `${head} · ${method}`;
}

const NT_KIND = { predicted: 'predicted', known: 'known', implied_by_class: 'implied by class' };
/** "Transmitter: acetylcholine · predicted, certainty 0.90" or null. */
export function transmitterLine(nt) {
  if (!nt || !nt.value) return null;
  const kind = NT_KIND[nt.kind] || nt.kind;
  const conf = typeof nt.confidence === 'number' ? `, certainty ${nt.confidence.toFixed(2)}` : '';
  return `Transmitter: ${nt.value} · ${kind}${conf}`;
}

/**
 * The type's role as a line: first letter capitalised only when it is a plain lower-case word ("carries odour
 * signals…" → "Carries odour signals…"; "mPFC-projecting…", "GABAergic…" and Greek stay as written). null if none.
 */
export function roleLine(role) {
  const r = typeof role === 'string' ? role.trim() : '';
  if (!r) return null;
  return /^[a-z][a-z]/.test(r) ? r[0].toUpperCase() + r.slice(1) : r;
}

// ---- v1.3 structured trivia (ARCHITECTURE.md §3.4 item 1; contracts quoted_fact.category / contrast_with_labels /
// support). Literature facts are about the biology of the type, never how_typed (typing methodology). ----

/** The three labelled parts of the "Did you know?" card, in order, and the quoted_fact category each one shows. */
export const TRIVIA_PARTS = [
  { id: 'does', category: 'function', label: 'What it does' },
  { id: 'apart', category: 'identify', label: 'How to tell it apart' },
  { id: 'talks', category: 'connectivity', label: 'Who it talks to' },
];
/** v1.4 (feedback qshG): "In short" leads the card when the reveal carries the type's `summary` fact — one or two plain
 * sentences on what the cell does, tied to its shape (quoted and cited like every other fact). */
export const SUMMARY_PART = { id: 'short', category: 'summary', label: 'In short' };
/** v0.6.1 (note 1ntJ…): the notice under every trivia card. Settings → About says the same at length. */
export const AI_NOTICE = 'Vibe coded with AI help: these facts are paraphrased from the quoted papers and checked, but they can still be wrong. Check the source before relying on one.';
const sameLabel = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * The look-alike tip to show: the identify fact whose contrast_with_labels name the most of this round's options (the
 * bake already prefers such a tip; this keeps the choice right when a reveal carries more than one). First on a tie;
 * null without identify facts.
 */
export function pickIdentify(facts, optionLabels = []) {
  const opts = new Set((optionLabels || []).map(sameLabel).filter(Boolean));
  let best = null;
  let bestN = -1;
  for (const f of facts || []) {
    if (!f || !f.text || f.category !== 'identify') continue;
    const n = (f.contrast_with_labels || []).filter((l) => opts.has(sameLabel(l))).length;
    if (n > bestN) { best = f; bestN = n; }
  }
  return best;
}

const sharePct = (share) => {
  if (typeof share !== 'number' || !Number.isFinite(share)) return null;
  const p = Math.round(share * 100);
  return p < 1 ? 'under 1%' : `${p}%`;
};
const typedPartners = (list) => (Array.isArray(list) ? list : [])
  .filter((p) => p && typeof p.label === 'string' && p.label.trim() && sameLabel(p.label) !== 'untyped').slice(0, 2);
/** "43% of its input synapses come from A and 37% from B" (shares lead: partner labels often end in a parenthesis) */
function partnerClause(list, side) {
  const [a, b] = list;
  const [verb, prep] = side === 'in' ? ['come', 'from'] : ['go', 'to'];
  const pa = sharePct(a.share);
  const head = pa ? `${pa} of its ${side === 'in' ? 'input' : 'output'} synapses ${verb} ${prep} ${a.label}`
    : `its ${side === 'in' ? 'input' : 'output'} synapses ${verb} mainly ${prep} ${a.label}`;
  if (!b) return head;
  const pb = sharePct(b.share);
  return pa && pb ? `${head} and ${pb} ${prep} ${b.label}` : `${head} and ${b.label}`;
}

/**
 * The "Who it talks to" data line, templated from this round's graph clue (graph_clue.schema.json: up to 3 inputs and
 * outputs by synapse count, shares over the non-same-type partners): the top two typed partners on each side,
 * "untyped" left out. "Here, 41% of its input synapses come from PN and 12% from APL; 35% of its output synapses go to
 * MBON-γ1pedc." null when neither side names a typed partner (no partner data, too few typed partners, or no graph).
 */
export function graphDataLine(graph) {
  if (!graph || typeof graph !== 'object') return null;
  const ins = typedPartners(graph.inputs);
  const outs = typedPartners(graph.outputs);
  if (!ins.length && !outs.length) return null;
  const parts = [ins.length ? partnerClause(ins, 'in') : null, outs.length ? partnerClause(outs, 'out') : null];
  return `Here, ${parts.filter(Boolean).join('; ')}.`;
}

/** Every verbatim quote behind a fact: its own, then each support quote (comparative claims), with their citations. */
export function quotesOf(fact) {
  if (!fact) return [];
  const out = [];
  if (fact.quote) out.push({ quote: fact.quote, citation: fact.citation, doi: fact.doi, main: true });
  for (const s of fact.support || []) if (s && s.quote) out.push({ quote: s.quote, citation: s.citation, doi: s.doi, main: false });
  return out;
}

/**
 * The Facts tab's trivia (pure). parts: the "Did you know?" card, one item per part —
 *   In short             v1.4: the `summary` fact, when the reveal has one (always first);
 *   What it does         the first `function` fact; else the type's role line (what is known, no citation);
 *   How to tell it apart the identify fact for this round's options (pickIdentify), with "vs" its contrast labels;
 *   Who it talks to      the first `connectivity` fact and/or the data line from the graph clue;
 * a part with nothing to show is left out. extra: every fact not in a part (a second fact of a kind, `other` and
 * uncategorised v1.2 facts), listed under the card. card: whether the card shows (a literature fact or the data
 * line; the role line alone is not a card); literature: a part holds a literature fact (the card then says "from the
 * literature"). roleLine: the role, when it is not already the "What it does" item.
 * extraTitle: "More facts" under a card with literature, "From the literature" under one without, else "Did you know?".
 */
export function triviaParts(reveal, { optionLabels = [], graph = null } = {}) {
  const facts = ((reveal && reveal.trivia && reveal.trivia.facts) || []).filter((f) => f && f.text);
  const role = roleLine(reveal && reveal.type ? reveal.type.role : null);
  const summary = facts.find((f) => f.category === 'summary') || null;
  const fn = facts.find((f) => f.category === 'function') || null;
  const id = pickIdentify(facts, optionLabels);
  const conn = facts.find((f) => f.category === 'connectivity') || null;
  const data = graphDataLine(graph);
  const parts = [];
  if (summary) parts.push({ ...SUMMARY_PART, fact: summary });
  if (fn || role) parts.push({ ...TRIVIA_PARTS[0], fact: fn, text: fn ? null : role });
  if (id) parts.push({ ...TRIVIA_PARTS[1], fact: id, vs: (id.contrast_with_labels || []).filter((l) => typeof l === 'string' && l.trim()) });
  if (conn || data) parts.push({ ...TRIVIA_PARTS[2], fact: conn, data });
  const literature = !!(summary || fn || id || conn);
  const card = literature || !!data;
  const used = new Set([summary, fn, id, conn].filter(Boolean));
  return {
    card,
    literature,
    parts: card ? parts : [],
    extra: facts.filter((f) => !used.has(f)),
    roleLine: summary || (card && !fn) ? null : role,
    extraTitle: !card ? 'Did you know?' : literature ? 'More facts' : 'From the literature',
  };
}

/**
 * Visible detail tabs, in order; Facts is always there (the default; it shows "More about this cell soon" when the
 * type has no facts yet). graphAsset: the round_state's graph clue asset (free once done).
 */
export function revealTabs(reveal, graphAsset) {
  if (!reveal) return [];
  const tr = reveal.trivia || {};
  const tabs = ['facts'];
  if (tr.ephys || tr.same_cell_function) tabs.push('ephys');
  if (tr.genes && Array.isArray(tr.genes.values) && tr.genes.values.length) tabs.push('genes');
  if (graphAsset) tabs.push('graph');
  if (reveal.method || reveal.how_typed || reveal.provenance) tabs.push('made');
  if ((Array.isArray(reveal.papers) && reveal.papers.length) || reveal.attribution) tabs.push('papers');
  return tabs;
}
export const TAB_LABELS = {
  facts: 'Facts', ephys: 'Ephys', genes: 'Genes', graph: 'Graph', made: 'Method', papers: 'Papers',
};

const MATCH_WORD = { same_type: 'type', same_subclass: 'subclass', same_class: 'class' };
/** "Recorded from this cell · <source>" or "Matched <type|subclass|class> (<reference_type>), not this cell · <source>". */
export function ephysCaption(ephys) {
  if (!ephys) return '';
  if (ephys.match_level === 'same_cell') return `Recorded from this cell · ${ephys.source}`;
  const word = MATCH_WORD[ephys.match_level] || 'type';
  return `Matched ${word} (${ephys.reference_type}), not this cell · ${ephys.source}`;
}

/** Genes caption: "Matched subclass, not this cell · <source>". */
export function genesCaption(genes) {
  if (!genes) return '';
  return `Matched ${genes.level}, not this cell · ${genes.source}`;
}

/** [4, 4, 40] → "4 × 4 × 40 nm" */
export function fmtVoxel(v) {
  if (!Array.isArray(v) || v.length !== 3) return '—';
  return `${v.map((x) => fmtNum(x)).join(' × ')} nm`;
}

/**
 * The imaging card's voxel rows (em-v2-spec.md §8.7). A format 2 round's reveal carries shown_voxel_nm (the finest
 * served voxel; voxel_nm stays the acquisition voxel):
 *  - served coarser than acquired (FlyWire, BANC, MICrONS: 8 nm public copy of 4 nm imaging): "Acquired 4 × 4 × 40 nm"
 *    + "Shown (finest public copy) 8 × 8 × 40 nm" (the bake's rounds.py shown_is_coarser rule);
 *  - the same pixels drawn at their physical size (H01: the 4 × 4 nm release pixel is 5.55 × 4 nm): "Acquired …"
 *    + "Shown (true pixel size) 5.55 × 4 × 33 nm";
 *  - shown = acquired, and format 1 rounds: one "Voxel" row.
 * → [{ k, v }]
 */
export function voxelRows(m) {
  const acq = m && m.voxel_nm;
  const shown = m && m.shown_voxel_nm;
  const ok = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && x > 0);
  if (!ok(acq) || !ok(shown) || shown.every((x, i) => Math.abs(x - acq[i]) <= 0.01 * acq[i])) {
    return [{ k: 'Voxel', v: fmtVoxel(acq) }];
  }
  const coarser = Math.min(shown[0], shown[1]) > Math.max(acq[0], acq[1]) * 1.01;
  return [
    { k: 'Acquired', v: fmtVoxel(acq) },
    { k: coarser ? 'Shown (finest public copy)' : 'Shown (true pixel size)', v: fmtVoxel(shown) },
  ];
}

/** Method bonus verdict: "✓ +200" (accent) / "✕ you said FIB-SEM" (error) / "— skipped" (muted). */
export function methodVerdict(state) {
  if (!state || state.stage !== 'done') return { text: '— not played', tone: 'muted' };
  if (state.method_correct) return { text: '✓ +200', tone: 'accent' };
  if (state.method_pick == null) return { text: '— skipped', tone: 'muted' };
  return { text: `✕ you said ${methodName(state.method_pick)}`, tone: 'error' };
}

export const reviewDays = (outcome) => REVIEW_DAYS[outcome] || 2;

const LABEL_CLASS = {
  expert: 'expert', expert_cross_matched: 'expert, cross-matched', transferred: 'transferred from another dataset',
  classifier: 'classifier', molecular_label: 'molecular label',
};
/**
 * "Type label" value: provenance.summary_word · label class in words, without repeating the word
 * ("putative · classifier", but "expert, cross-matched" and "molecular label", never "expert · expert, …").
 */
export function typeLabelText(summaryWord, labelClass) {
  const sw = summaryWord || '';
  const cw = labelClass ? LABEL_CLASS[labelClass] || String(labelClass).replace(/_/g, ' ') : '';
  if (!cw) return sw || '—';
  if (!sw || cw === sw || cw.startsWith(`${sw},`) || cw.startsWith(`${sw} `)) return cw;
  return `${sw} · ${cw}`;
}

/** Nice axis step (1, 2, 2.5, 5 × 10^k) for about `target` intervals. */
export function niceStep(range, target = 4) {
  if (!(range > 0)) return 1;
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}
/** { lo, hi, step, ticks } covering [min, max] with nice round ticks. */
export function niceTicks(min, max, target = 4) {
  let a = Number(min);
  let b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { lo: 0, hi: 1, step: 1, ticks: [0, 1] };
  if (a > b) [a, b] = [b, a];
  if (a === b) { a -= 1; b += 1; }
  const step = niceStep(b - a, target);
  const lo = Math.floor(a / step + 1e-9) * step;
  const hi = Math.ceil(b / step - 1e-9) * step;
  const ticks = [];
  for (let k = 0, v = lo; v <= hi + step * 1e-6 && k < 50; k++, v = lo + k * step) ticks.push(Number(v.toFixed(10)));
  return { lo, hi, step, ticks };
}

/**
 * SVG path for a sweep: x(t), y(v) map to px. Longer than 2 points per pixel column → min/max per column
 * (keeps every spike). Returns '' for < 2 samples.
 */
export function tracePath(values, { dt, t0 = 0, x, y, widthPx = 260 }) {
  const n = Array.isArray(values) ? values.length : 0;
  if (n < 2) return '';
  const pts = [];
  if (n <= widthPx * 2) {
    for (let i = 0; i < n; i++) pts.push([x(t0 + i * dt), y(values[i])]);
  } else {
    const per = n / widthPx;
    for (let c = 0; c < widthPx; c++) {
      const s = Math.floor(c * per);
      const e = Math.min(n, Math.floor((c + 1) * per));
      let iMin = s;
      let iMax = s;
      for (let i = s; i < e; i++) { if (values[i] < values[iMin]) iMin = i; if (values[i] > values[iMax]) iMax = i; }
      for (const i of iMin <= iMax ? [iMin, iMax] : [iMax, iMin]) pts.push([x(t0 + i * dt), y(values[i])]);
    }
  }
  return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('');
}

/** Axis tick label: plain digits (no thousands comma, as in the handoff figure), true minus. */
const fmtTick = (v) => { const s = String(Math.abs(Number(v.toFixed(6)))); return v < 0 ? MINUS + s : s; };

// ======================================================================================
// Asset loading (injectable: the dev page serves the hand-written trivia assets from memory)
// ======================================================================================

export const defaultLoader = { buffer: api.assetArrayBuffer, json: api.assetJSON, url: api.assetObjectURL };

/** Async asset hook → { data, error, loading }. */
function useAsset(kind, path, loader) {
  const [res, setRes] = useState({ data: null, error: null, loading: !!path });
  useEffect(() => {
    if (!path) { setRes({ data: null, error: null, loading: false }); return undefined; }
    let alive = true;
    setRes({ data: null, error: null, loading: true });
    Promise.resolve().then(() => loader[kind](path)).then(
      (data) => { if (alive) setRes({ data, error: null, loading: false }); },
      (error) => { if (alive) setRes({ data: null, error, loading: false }); },
    );
    return () => { alive = false; };
  }, [kind, path]);
  return res;
}

/** Width of an element (ResizeObserver), for SVG figures that take numbers. */
function useWidth(fallback = 343) {
  const ref = useRef(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => { const cw = Math.round(el.clientWidth); if (cw > 0) setW(cw); };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ======================================================================================
// Hero: MeshViewer with Cell | In context
// ======================================================================================

function labelsWord(labels) {
  if (!labels) return null;
  const planes = Array.isArray(labels.planes) && labels.planes.length > 0;
  const points = Array.isArray(labels.points) && labels.points.length > 0;
  if (planes && points) return 'Labels';
  if (planes) return 'Layers';
  if (points) return 'Regions';
  return null;
}

function RevealHero({ round, reveal, verdict, perfect, verdictRef, perfectRef, loader, onFullView, dayNumber, n, retryKey = 0, cellLabel = 'today’s cell' }) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const queue = useRef(Promise.resolve());
  const [mode, setMode] = useState('context');
  const [layers, setLayers] = useState({ volume: true, siblings: true, labels: true });
  const [labels, setLabels] = useState(null);
  const [pxPerUm, setPxPerUm] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const online = useStore((s) => s.ui.online);
  const failedRef = useRef(false);
  failedRef.current = failed;
  const ctx = reveal ? reveal.context : null;
  const inContext = mode === 'context' && !!ctx;

  // a failed load (offline, server unreachable) loads again once the device is back online or the player taps
  // Retry; a hero that loaded is left alone
  useEffect(() => {
    if (online && failedRef.current) { setFailed(false); setAttempt((a) => a + 1); }
  }, [online, retryKey]);

  // serialise viewer calls so a quick Cell ↔ In context switch never interleaves async loads; a failure is
  // shown only while the effect that queued it is current (a newer asset set clears it)
  const enqueue = (fn, isCurrent = () => true) => {
    queue.current = queue.current.then(fn).catch((err) => {
      if (!isCurrent()) return;
      console.warn('[reveal] viewer', err);
      setFailed(true);
    });
    return queue.current;
  };

  useEffect(() => {
    // no auto-rotation on the reveal (handoff: the specimen spins only until the round is done); drag orbits
    const v = new MeshViewer(hostRef.current, { autoRotate: false, interactive: true });
    viewerRef.current = v;
    const off = v.onChange((info) => {
      const p = info && info.pxPerUm;
      if (p > 0) setPxPerUm((old) => (Math.abs(old - p) / p > 0.004 ? p : old));
    });
    return () => {
      if (typeof off === 'function') off();
      viewerRef.current = null;
      try { v.dispose(); } catch (_) { /* ignore */ }
    };
  }, []);

  const meshAsset = round && round.mesh ? round.mesh.asset : null;
  useEffect(() => {
    if (!meshAsset) return undefined;
    let alive = true;
    setFailed(false);
    enqueue(async () => {
      const buf = await loader.buffer(meshAsset);
      if (alive && viewerRef.current) await viewerRef.current.loadNeuron(buf, { bboxUm: round.mesh.bbox_um });
    }, () => alive);
    return () => { alive = false; };
  }, [meshAsset, attempt]);

  useEffect(() => {
    let alive = true;
    if (!inContext) {
      enqueue(async () => {
        const v = viewerRef.current;
        if (!v) return;
        await v.setSiblings(null);
        await v.setContext(null);
      }, () => alive);
      return () => { alive = false; };
    }
    enqueue(async () => {
      const [volume, lab] = await Promise.all([loader.buffer(ctx.volume), loader.json(ctx.labels)]);
      if (!alive || !viewerRef.current) return;
      setLabels(lab);
      await viewerRef.current.setContext({ volume, labels: lab, offsetUm: ctx.neuron_offset_um });
      if (ctx.siblings) {
        const sib = await loader.buffer(ctx.siblings);
        if (alive && viewerRef.current) await viewerRef.current.setSiblings(sib);
      }
      if (alive && viewerRef.current) viewerRef.current.setLayers(layers);
    }, () => alive);
    return () => { alive = false; };
  }, [inContext, ctx && ctx.volume, ctx && ctx.siblings, attempt]);

  useEffect(() => { if (viewerRef.current && inContext) viewerRef.current.setLayers(layers); }, [layers.volume, layers.siblings, layers.labels]);

  const toggle = (key) => { haptic('selection'); setLayers((l) => ({ ...l, [key]: !l[key] })); };
  const typeName = reveal ? reveal.type.name : '';
  const sibCount = ctx && ctx.siblings ? ctx.siblings_count || 0 : 0;
  const word = labelsWord(labels);
  const volumeLabel = reveal ? `${reveal.neuron.dataset_name} volume` : 'volume';

  const modes = [{ id: 'cell', label: 'Cell' }, { id: 'context', label: 'In context' }];
  return html`<div class=${cx('viewer reveal-hero', inContext && 'is-context')}>
    <div class="viewer-canvas" ref=${hostRef} role="img"
      aria-label=${reveal ? `${typeName}${inContext ? ` in the ${volumeLabel}` : ''}, 3D. Drag to rotate.` : '3D view of the cell'}></div>
    <div class="reveal-hero-top">
      <div class="reveal-verdict-wrap">
        <span class=${cx('reveal-verdict', `is-${verdict.tone}`)} ref=${verdictRef}>
          ${verdict.glyph} ${verdict.word}
        </span>
        ${perfect ? html`<span class="overline is-accent reveal-perfect" ref=${perfectRef}>Perfect round</span>` : null}
        <${OfflineChip} />
      </div>
      ${ctx ? html`<div class="text-switch" role="tablist" aria-label="3D view">
        ${modes.map((m) => html`<button key=${m.id} type="button" role="tab" aria-selected=${mode === m.id ? 'true' : 'false'}
          class=${mode === m.id ? 'is-active' : ''} onClick=${() => { if (mode !== m.id) { haptic('selection'); setMode(m.id); } }}>${m.label}</button>`)}
      </div>` : null}
    </div>
    <div class="reveal-hero-tools">
      ${onFullView ? html`<${GhostButton} label="Full view" haptic="selection" onClick=${() => {
        // continue in the hero's mode ("In context" by default) and orientation
        let view = null;
        try { view = viewerRef.current ? viewerRef.current.getView() : null; } catch (_) { view = null; }
        onFullView({ context: inContext, view });
      }}>⤢</${GhostButton}>` : null}
      <${GhostButton} label="Zoom in" size="lg" onClick=${() => viewerRef.current && viewerRef.current.zoomBy(1.25)}>+</${GhostButton}>
      <${GhostButton} label="Zoom out" size="lg" onClick=${() => viewerRef.current && viewerRef.current.zoomBy(0.8)}>−</${GhostButton}>
    </div>
    ${failed ? html`<span class="reveal-hero-note t-micro" role="status">✕ 3D view unavailable</span>` : null}
    <div class=${cx('reveal-hero-keys', !inContext && 'is-low')}>
      <${ScaleBar} pxPerUm=${pxPerUm} align="right" />
    </div>
    ${inContext ? html`<div class="toggle-row reveal-toggles">
      <button type="button" aria-pressed=${layers.volume ? 'true' : 'false'} onClick=${() => toggle('volume')}>${toggleText('Volume', layers.volume)}</button>
      ${sibCount ? html`<button type="button" aria-pressed=${layers.siblings ? 'true' : 'false'} onClick=${() => toggle('siblings')}
        aria-label=${`${typeName}, ${sibCount} nearby`}><span class="reveal-toggle-text">${toggleText(shortTypeName(reveal && reveal.type), layers.siblings)}</span><span class="reveal-toggle-count t-num">${`\u00a0· ${sibCount}`}</span></button>` : null}
      ${word ? html`<button type="button" aria-pressed=${layers.labels ? 'true' : 'false'} onClick=${() => toggle('labels')}>${toggleText(word, layers.labels)}</button>` : null}
    </div>` : null}
  </div>`;
}

// ======================================================================================
// Body sections
// ======================================================================================

/** Long mono identifiers ("aibs_metamodel_celltypes_v661.cell_type") may wrap after _ . / instead of mid-word. */
function breakAfterPunct(s) {
  const parts = String(s).replace(/([_./])/g, '$1\u0000').split('\u0000');
  return parts.map((p, i) => (i < parts.length - 1 ? html`${p}<wbr />` : p));
}

function Cite({ fact }) {
  return html`<span class="reveal-cite">from ${fact.citation}, quoted · <a href=${doiUrl(fact.doi)} target="_blank" rel="noopener noreferrer">doi:${fact.doi} ↗</a></span>`;
}

/**
 * A literature fact's text, "— Citation ↗" linking to the DOI, and its verbatim quote(s) behind "Show quote" — for a
 * comparative tip, the support quotes too, each with its own citation (44 px targets; aria-expanded on the toggle).
 */
function FactBody({ fact, id }) {
  const [open, setOpen] = useState(false);
  const qid = `${id}-q`;
  const quotes = quotesOf(fact);
  const many = quotes.length > 1;
  return html`<div class="dyk-body">
    <p class="t-read dyk-text">${fact.text}</p>
    <div class="dyk-meta">
      <a class="dyk-cite" href=${doiUrl(fact.doi)} target="_blank" rel="noopener noreferrer"
        aria-label=${`${fact.citation}, doi ${fact.doi}, opens the paper`}>— ${fact.citation}${NBSP}↗</a>
      ${quotes.length ? html`<button type="button" class="dyk-toggle" aria-expanded=${open ? 'true' : 'false'} aria-controls=${qid}
        onClick=${() => { haptic('selection'); setOpen(!open); }}>${open ? `Hide quote${many ? 's' : ''}` : many ? `Show ${quotes.length} quotes` : 'Show quote'}</button>` : null}
    </div>
    ${quotes.length && open ? html`<div class="dyk-quotes" id=${qid}>
      ${quotes.map((q, i) => html`<blockquote key=${i} class="dyk-quote">
        <p>“${q.quote}”</p>
        <span class="t-micro t-muted">Verbatim from ${q.main ? q.citation : html`<a class="dyk-quote-cite" href=${doiUrl(q.doi)} target="_blank"
          rel="noopener noreferrer" aria-label=${`${q.citation}, doi ${q.doi}, opens the paper`}>${q.citation}${NBSP}↗</a>`}</span>
      </blockquote>`)}
    </div>` : null}
  </div>`;
}

/** One labelled part of the card: "What it does" / "How to tell it apart" (+ "vs …") / "Who it talks to" (+ data). */
function TriviaPart({ part, idBase }) {
  const hid = `${idBase}-${part.id}`;
  return html`<section class=${cx('dyk-part', `is-${part.id}`)} aria-labelledby=${hid}>
    <div class="dyk-part-head">
      <h3 class="overline dyk-part-label" id=${hid}>${part.label}</h3>
      ${part.vs && part.vs.length ? html`<span class="dyk-vs">vs ${part.vs.join(', ')}</span>` : null}
    </div>
    ${part.fact ? html`<${FactBody} fact=${part.fact} id=${`${hid}-f`} />` : null}
    ${part.text ? html`<p class="t-read dyk-text">${part.text}</p>` : null}
    ${part.data ? html`<div class="dyk-data">
      <p class="t-read dyk-data-text">${part.data}</p>
      <span class="t-micro t-muted">From this dataset’s synapses</span>
    </div>` : null}
  </section>`;
}

function FactList({ facts, idBase }) {
  return html`<ol class="dyk-list">
    ${facts.map((f, i) => html`<li key=${`${f.doi}-${i}`} class="dyk-fact"><${FactBody} fact=${f} id=${`${idBase}-x${i + 1}`} /></li>`)}
  </ol>`;
}

/**
 * Facts tab (v1.3): the role line (unless it is the "What it does" item) → "Did you know?" in three labelled parts
 * (triviaParts) → transmitter → also called → the facts not in a part. No literature fact and no partner data: the role
 * line, any uncategorised facts, and "More about this cell soon" when there are none.
 * round: round_public (its option labels pick the look-alike tip); graphAsset: the round's graph clue (free once done),
 * loaded through `loader` for the data line.
 */
export function FactsPanel({ reveal, round = null, graphAsset = null, loader = defaultLoader }) {
  const t = reveal.type || {};
  const graph = useAsset('json', graphAsset, loader);
  const optionLabels = round && Array.isArray(round.options) ? round.options.map((o) => o && o.label) : [];
  const tp = triviaParts(reveal, { optionLabels, graph: graph.data });
  const nt = transmitterLine(reveal.trivia && reveal.trivia.neurotransmitter);
  const aka = (t.synonyms || []).filter((s) => s && s !== t.name && s !== t.dataset_label);
  const idBase = `dyk-${reveal.round_id}`;
  const [more, setMore] = useState(false);
  // the facts not in a part: under the card and the transmitter line; with no card (v1.2 facts without partner data)
  // they take the card's place, as "Did you know?"
  const extra = tp.extra.length ? html`<section class="card reveal-dyk is-extra" aria-label=${tp.extraTitle}>
    <h2 class="card-title dyk-title">${tp.extraTitle}</h2>
    <${FactList} facts=${tp.extra} idBase=${idBase} />
  </section>` : null;
  return html`<div class="reveal-facts-panel">
    ${tp.roleLine ? html`<p class="t-read reveal-role">${tp.roleLine}</p>` : null}
    ${tp.card ? html`<section class="card reveal-dyk" aria-label="Did you know?">
      <div class="row-between">
        <h2 class="card-title dyk-title">Did you know?</h2>
      </div>
      ${tp.parts.map((p) => html`<${TriviaPart} key=${p.id} part=${p} idBase=${idBase} />`)}
    </section>` : extra || html`<p class="t-label t-muted reveal-soon">More about this cell soon.</p>`}
    ${nt || aka.length ? html`<div class="kv reveal-kv reveal-fact-kv">
      ${nt ? html`<span class="k">Transmitter</span><span class="v reveal-v-text">${nt.replace(/^Transmitter: /, '')}</span>` : null}
      ${aka.length ? html`<span class="k">Also called</span><span class="v reveal-v-text">${aka.join(', ')}</span>` : null}
    </div>` : null}
    ${tp.card && extra ? html`<button type="button" class="btn-text reveal-more" aria-expanded=${more ? 'true' : 'false'}
      onClick=${() => { haptic('selection'); setMore(!more); }}>${more ? 'Fewer facts' : html`More facts · <span class="t-num">${tp.extra.length}</span>`}</button>` : null}
    ${tp.card && more ? extra : null}
    ${tp.literature || tp.extra.length ? html`<p class="t-body t-muted reveal-disclaimer">${AI_NOTICE}</p>` : null}
  </div>`;
}

const PROOF_LEVEL = {
  none: 'none', error_rate_audited: 'error rate audited', cleaned: 'cleaned', extended: 'extended',
  fully_proofread: 'fully proofread', hand_traced: 'hand traced',
};

function HowTyped({ reveal }) {
  const ht = reveal.how_typed || {};
  const p = reveal.provenance || {};
  const label = p.label || {};
  const conf = label.confidence;
  const proof = p.proofreading || {};
  const t = reveal.type || {};
  return html`<section class="card" aria-label="How this cell was typed">
    <span class="card-title-sm">How this cell was typed</span>
    ${ht.summary ? html`<p class="t-body t-soft reveal-p">${ht.summary}</p>` : null}
    ${(ht.facts || []).length ? html`<ul class="reveal-facts">
      ${ht.facts.map((f, i) => html`<li key=${i}><span class="t-body t-soft">${f.text}</span><${Cite} fact=${f} /></li>`)}
    </ul>` : null}
    <div class="kv reveal-kv">
      <span class="k">Type label</span>
      <span class="v reveal-v-text">${typeLabelText(p.summary_word, label.class)}</span>
      ${conf ? html`<span class="k">Certainty</span><span class="v reveal-v-text"><span class="t-num">${conf.value.toFixed(2)}</span> (${conf.meaning})</span>` : null}
      ${t.dataset_label ? html`<span class="k">Label in source</span><span class="v">${t.dataset_label}</span>` : null}
      ${label.source_table ? html`<span class="k">Source table</span><span class="v reveal-v-break">${breakAfterPunct(label.source_table)}</span>` : null}
      ${proof.level ? html`<span class="k">Proofreading</span><span class="v reveal-v-text">${PROOF_LEVEL[proof.level] || proof.level}${proof.detail ? ` · ${proof.detail}` : ''}</span>` : null}
    </div>
  </section>`;
}

function EphysTrace({ trace }) {
  const W = 333;
  const H = 150;
  const L = 40;
  const R = 300;
  const T = 10;
  const B = 120;
  const v = trace.v_mV || [];
  const t0 = trace.t0_ms || 0;
  const tEnd = t0 + trace.dt_ms * (v.length - 1);
  const yt = niceTicks(Math.min(...v), Math.max(...v), 3);
  const xt = niceTicks(t0, tEnd, 2);
  const x = (t) => L + ((t - xt.lo) / (xt.hi - xt.lo)) * (R - L);
  const y = (mv) => B - ((mv - yt.lo) / (yt.hi - yt.lo)) * (B - T);
  const d = tracePath(v, { dt: trace.dt_ms, t0, x, y, widthPx: R - L });
  return html`<svg class="ephys-svg" viewBox=${`0 0 ${W} ${H}`} role="img"
    aria-label=${`Membrane potential over time, ${fmtNum(Math.min(...v))} to ${fmtNum(Math.max(...v))} mV`}>
    <path class="ephys-trace" d=${d}></path>
    <g class="ephys-axis">
      <line x1=${L} y1=${T} x2=${L} y2=${B}></line>
      <line x1=${L} y1=${B} x2=${R} y2=${B}></line>
      ${yt.ticks.map((tv) => html`<line key=${`y${tv}`} x1=${L - 4} y1=${y(tv)} x2=${L} y2=${y(tv)}></line>`)}
      ${xt.ticks.map((tv) => html`<line key=${`x${tv}`} x1=${x(tv)} y1=${B} x2=${x(tv)} y2=${B + 4}></line>`)}
    </g>
    <g class="ephys-text" text-anchor="end">
      ${yt.ticks.map((tv) => html`<text key=${`yl${tv}`} x=${L - 7} y=${y(tv) + 3}>${fmtTick(tv)}</text>`)}
    </g>
    <g class="ephys-text" text-anchor="middle">
      ${xt.ticks.map((tv) => html`<text key=${`xl${tv}`} x=${x(tv)} y=${B + 14}>${fmtTick(tv)}</text>`)}
      <text x=${(L + R) / 2} y=${B + 26}>Time (ms)</text>
      <text transform=${`translate(10 ${(T + B) / 2}) rotate(-90)`}>Vm (mV)</text>
    </g>
  </svg>`;
}

function SameCellFunction({ scf, loader }) {
  const isImage = typeof scf.asset === 'string' && /\.(webp|png)$/.test(scf.asset);
  const img = useAsset('url', isImage ? scf.asset : null, loader);
  return html`<div class="reveal-panel is-panel reveal-scf">
    <span class="overline is-accent">This cell · ${scf.kind}</span>
    <p class="t-body t-soft reveal-p">${scf.summary}</p>
    ${img.data ? html`<img class="reveal-scf-img" src=${img.data} alt=${`${scf.kind}: ${scf.summary}`} />` : null}
    <span class="t-micro t-muted">${scf.source}</span>
  </div>`;
}

function EphysPanel({ trivia, loader }) {
  const ephys = trivia.ephys;
  const trace = useAsset('json', ephys && ephys.trace ? ephys.trace : null, loader);
  const tr = trace.data;
  const okTrace = tr && Array.isArray(tr.v_mV) && tr.v_mV.length >= 2 && tr.dt_ms > 0;
  const stim = okTrace && tr.stimulus ? `${fmtSigned(tr.stimulus.amp_pA)} pA step · ` : '';
  return html`<div class="stack-12">
    ${trivia.same_cell_function ? html`<${SameCellFunction} scf=${trivia.same_cell_function} loader=${loader} />` : null}
    ${ephys ? html`<div class="reveal-panel is-sunken reveal-ephys">
      ${ephys.trace ? (okTrace ? html`<${EphysTrace} trace=${tr} />`
        : html`<div class="reveal-figure-note t-micro t-muted">${trace.loading ? 'Loading trace…' : '✕ Trace unavailable'}</div>`) : null}
      <span class="reveal-caption">${stim}${ephysCaption(ephys)}</span>
      ${(ephys.features || []).length ? html`<table class="reveal-table">
        <thead><tr><th scope="col">Feature</th><th scope="col">Median</th><th scope="col">IQR</th><th scope="col">n</th></tr></thead>
        <tbody>${ephys.features.map((f, i) => html`<tr key=${i}>
          <th scope="row">${f.name} <span class="t-muted">(${f.unit})</span></th>
          <td>${fmtNum(f.median)}</td>
          <td>${Array.isArray(f.iqr) ? `${fmtNum(f.iqr[0])}–${fmtNum(f.iqr[1])}` : '—'}</td>
          <td>${f.n_cells ? fmtPts(f.n_cells) : '—'}</td>
        </tr>`)}</tbody>
      </table>` : null}
      <span class="reveal-caption">Licence: ${ephys.licence}</span>
    </div>` : null}
  </div>`;
}

function GenesPanel({ genes }) {
  const vals = genes.values || [];
  const max = Math.max(0, ...vals.map((g) => g.value)) || 1;
  const hasMarker = vals.some((g) => g.role === 'marker');
  const hasContext = vals.some((g) => g.role === 'context');
  return html`<div class="reveal-panel is-sunken reveal-genes">
    <div class="genes-rows" role="list" aria-label=${`Gene expression, ${genes.unit}`}>
      ${vals.map((g) => html`<div key=${g.symbol} class="genes-row" role="listitem"
        aria-label=${`${g.symbol}, ${g.role}, ${fmtNum(g.value)}`}>
        <span class="t-gene">${g.symbol}</span>
        <span class="genes-track"><i class=${g.role === 'marker' ? 'is-marker' : 'is-context'}
          style=${{ width: `${Math.max(0, Math.min(100, (g.value / max) * 100)).toFixed(1)}%` }}></i></span>
        <span class="genes-val">${g.value.toFixed(1)}</span>
      </div>`)}
    </div>
    <div class="genes-key">
      <span class="genes-keys">
        ${hasMarker ? html`<span><i class="is-marker"></i>marker</span>` : null}
        ${hasContext ? html`<span><i class="is-context"></i>context</span>` : null}
      </span>
      <span>${genes.unit}</span>
    </div>
    <span class="reveal-caption">${genesCaption(genes)}</span>
  </div>`;
}

function GraphPanel({ asset, loader }) {
  const g = useAsset('json', asset, loader);
  const [ref, width] = useWidth(327);
  return html`<div class="reveal-panel is-sunken reveal-graph" ref=${ref}>
    ${g.data ? html`<${GraphView} graph=${g.data} width=${Math.max(240, width - 16)} height=${240} />`
      : html`<div class="reveal-figure-note t-micro t-muted">${g.loading ? 'Loading partners…' : '✕ Partner graph unavailable'}</div>`}
  </div>`;
}

function MethodPanel({ reveal, state, onFullView }) {
  const m = reveal.method;
  const verdict = methodVerdict(state);
  const ng = safeUrl(reveal.neuron.neuroglancer_url);
  // EM format 2: "Look again" chips (≤ 3) open the full view on the preset (em-v2-spec.md §8.7)
  const looks = onFullView && Array.isArray(m.look_again) && state && emKind(state.em) === 'v2' ? m.look_again.slice(0, 3) : [];
  return html`<section class="card reveal-method" aria-label="How it was imaged">
    <span class="card-title-sm">How it was imaged</span>
    <div class="kv">
      <span class="reveal-method-name">${m.name}</span>
      <span class=${cx('reveal-method-verdict', `is-${verdict.tone}`)}>${verdict.text}</span>
      <span class="k">Variant</span><span class="v reveal-v-text">${m.detail}</span>
      ${voxelRows(m).map((r) => html`<span key=${`k-${r.k}`} class="k">${r.k}</span><span key=${`v-${r.k}`} class="v">${r.v}</span>`)}
      <span class="k">Dataset</span><span class="v reveal-v-text">${reveal.neuron.dataset_name} · ${reveal.neuron.release}</span>
      <span class="k">Neuron ID</span><span class="v reveal-v-break">${reveal.neuron.neuron_id}</span>
    </div>
    ${m.what_to_notice ? html`<div class="reveal-notice">
      <span class="overline">What to notice</span>
      <p class="t-body t-soft reveal-p">${m.what_to_notice}</p>
    </div>` : null}
    ${looks.length ? html`<div class="reveal-notice">
      <span class="overline">Look again</span>
      <div class="chips" role="group" aria-label="Look again in the EM">
        ${looks.map((l, i) => html`<button key=${i} type="button" class="chip" aria-label=${`Look again: ${l.label}`}
          onClick=${() => { haptic('selection'); onFullView({ mode: 'em', panel: l.panel, preset: l }); }}>⤢ ${l.label}</button>`)}
      </div>
    </div>` : null}
    ${ng ? html`<${Button} variant="link-outline" block size="sm" href=${ng}>Open in Neuroglancer ↗</${Button}>` : null}
  </section>`;
}

/** How it was made: provenance line, how the cell was typed, how it was imaged (your method guess, voxel, notice). */
export function MadePanel({ reveal, state, onFullView = null }) {
  return html`<div class="stack-12">
    ${reveal.provenance && reveal.provenance.line ? html`<p class="t-micro t-muted reveal-prov">${reveal.provenance.line}</p>` : null}
    ${reveal.how_typed || reveal.provenance ? html`<${HowTyped} reveal=${reveal} />` : null}
    ${reveal.method ? html`<${MethodPanel} reveal=${reveal} state=${state} onFullView=${onFullView} />` : null}
  </div>`;
}

const PAPER_ROLE = {
  dataset: 'Dataset', type_definition: 'Type definition', typing_method: 'Typing method', ephys: 'Ephys',
  genes: 'Genes', function: 'Function', fact: 'Fact source',
};
function PapersPanel({ reveal }) {
  return html`<div class="reveal-papers">
    ${(reveal.papers || []).map((p, i) => html`<a key=${i} class="reveal-paper" href=${doiUrl(p.doi)} target="_blank" rel="noopener noreferrer">
      <span class="overline">${PAPER_ROLE[p.role] || p.role}</span>
      <span class="reveal-paper-cite">${p.citation} ↗</span>
      <span class="t-micro t-muted t-num">doi:${p.doi}</span>
    </a>`)}
    ${reveal.attribution ? html`<p class="t-micro t-muted reveal-attrib">${reveal.attribution}</p>` : null}
  </div>`;
}

function DetailTabs({ reveal, round, state, graphAsset, loader, onFullView = null }) {
  const tabs = revealTabs(reveal, graphAsset);
  const [tab, setTab] = useState(tabs[0]);
  const active = tabs.includes(tab) ? tab : tabs[0];
  if (!tabs.length) return null;
  const tr = reveal.trivia || {};
  let panel = null;
  if (active === 'facts') panel = html`<${FactsPanel} reveal=${reveal} round=${round} graphAsset=${graphAsset} loader=${loader} />`;
  else if (active === 'ephys') panel = html`<${EphysPanel} trivia=${tr} loader=${loader} />`;
  else if (active === 'genes') panel = html`<${GenesPanel} genes=${tr.genes} />`;
  else if (active === 'graph') panel = html`<${GraphPanel} asset=${graphAsset} loader=${loader} />`;
  else if (active === 'made') panel = html`<${MadePanel} reveal=${reveal} state=${state} onFullView=${onFullView} />`;
  else panel = html`<${PapersPanel} reveal=${reveal} />`;
  return html`<div class="stack-12">
    <${Segmented} tall label="Cell details" value=${active} onChange=${setTab} class="reveal-tabs"
      options=${tabs.map((id) => ({ id, label: TAB_LABELS[id] }))} />
    <div role="tabpanel" aria-label=${TAB_LABELS[active]}>${panel}</div>
  </div>`;
}

// ======================================================================================
// RevealView (pure)
// ======================================================================================

/**
 * <RevealView n dayNumber round state reveal error onRetry fresh nextLabel onNext onReport reported onFullView
 *   graphAsset loader day overline footer>
 * round: round_public; state: round_state; reveal: round_reveal (null while loading); day: the active day for the
 * progress bar ({ date, rounds, progress, graceActive, grace }: store.today), none → no bar.
 * v0.6.0 (the Library's neuron profile, profile.js): overline replaces "#N · Round n · It was"; footer replaces the
 * "Added to your library" line (null: no line); cellLabel replaces the hero legend's "today’s cell".
 */
export function RevealView({
  n, dayNumber, round, state, reveal, error = null, onRetry,
  fresh = false, nextLabel = 'Next round →', onNext, onReport, reported = false, onFullView,
  graphAsset = null, loader = defaultLoader, day = null, overline = null, footer, cellLabel,
}) {
  const verdict = verdictOf(state);
  const perfect = !!state && state.stage === 'done' && state.score === 1200;
  const verdictRef = useRef(null);
  const perfectRef = useRef(null);
  const [retryKey, setRetryKey] = useState(0); // Retry also reloads a 3D hero that failed
  const outcome = outcomeOf(state);

  useEffect(() => {
    if (!fresh || !perfect) return undefined;
    const id = setTimeout(() => {
      haptic('celebrate');
      pulse(verdictRef.current, { rings: 2 });
      stamp(perfectRef.current);
    }, 420);
    return () => clearTimeout(id);
  }, [fresh, perfect]);

  const ng = reveal ? safeUrl(reveal.neuron.neuroglancer_url) : null;
  const t = reveal ? reveal.type : null;

  return html`<div class="screen reveal">
    <${RevealHero} round=${round} reveal=${reveal} verdict=${verdict} perfect=${perfect && fresh} verdictRef=${verdictRef}
      perfectRef=${perfectRef} loader=${loader} onFullView=${onFullView} dayNumber=${dayNumber} n=${n} retryKey=${retryKey}
      cellLabel=${cellLabel} />
    <div class="reveal-body">
      ${day && day.rounds && day.rounds.length ? html`<${DayProgress} today=${day} round=${n} class="in-reveal" />` : null}
      <div class="stack-4 reveal-head">
        <span class="reveal-over">${overline || (dayNumber ? `Day ${dayNumber} · It was` : 'It was')}</span>
        ${t ? html`<h1 class="reveal-name">${t.name}</h1>
          <span class="reveal-where"><i>${t.species}</i>${t.region ? ` · ${t.region}` : ''}</span>`
          : error ? null : html`<span class="skeleton reveal-skel-title" aria-hidden="true"></span>
            <span class="t-micro t-muted" role="status">Loading the reveal…</span>`}
      </div>
      ${t && t.species_common ? html`<${AtlasBar} species=${t.species_common} roundId=${(round && round.round_id) || reveal.round_id}
        fresh=${fresh} class="reveal-atlas" />` : null}

      ${error && !reveal ? html`<div class="card" role="alert">
        <span class="overline is-error">✕ Couldn’t load the reveal</span>
        <span class="t-body t-soft">${error.isNetwork ? 'You seem to be offline. The reveal loads once you are back online.' : (error.message || 'Something went wrong.')}</span>
        ${onRetry ? html`<${Button} variant="outline" block size="sm" haptic="selection" onClick=${() => { setRetryKey((k) => k + 1); onRetry(); }}>Retry</${Button}>` : null}
      </div>` : null}

      ${reveal ? html`<${DetailTabs} key=${reveal.round_id} reveal=${reveal} round=${round} state=${state} graphAsset=${graphAsset} loader=${loader} onFullView=${onFullView} />` : null}

      <div class="grid-2 reveal-actions">
        <${Button} onClick=${onNext}>${nextLabel}</${Button}>
        ${ng ? html`<${Button} variant="outline" href=${ng}>Neuroglancer ↗</${Button}>`
          : html`<${Button} variant="outline" disabled>Neuroglancer ↗</${Button}>`}
      </div>
      ${onReport ? html`<div class="reveal-report">
        <button type="button" class=${cx('btn-text', reported && 'is-muted')} onClick=${() => { haptic('selection'); onReport(); }}>
          ${reported ? '✓ Problem reported' : 'Report a problem'}
        </button>
      </div>` : null}
      ${footer !== undefined ? (footer ? html`<span class="reveal-footer">${footer}</span>` : null)
        : outcome && state.stage === 'done' ? html`<span class="reveal-footer">✓ Added to your library · review in ${reviewDays(outcome)} days</span>` : null}
    </div>
  </div>`;
}

// ======================================================================================
// Reveal (store-connected; today.js)
// ======================================================================================

const overtakeChecked = new Set(); // round_ids whose finish was already checked this session

/**
 * Announce leaderboard overtakes after a round finishes, once per round per session. Deliberately not tied to the
 * reveal's lifetime: checkOvertakes() stores the new ranks snapshot, so a check cancelled (or a toast dropped)
 * because the player tapped "Next round →" within the delay would lose that overtake for good.
 */
function scheduleOvertakeCheck(roundId, date, delayMs) {
  if (!roundId || overtakeChecked.has(roundId)) return;
  overtakeChecked.add(roundId);
  setTimeout(() => { checkOvertakes({ date }).then(announceOvertakes).catch(() => {}); }, delayMs);
}

function RevealRound({ n }) {
  const t = useStore((s) => s.today);
  const round = t.rounds[n - 1] || null;
  const state = t.progress[n - 1] || null;
  const roundId = round ? round.round_id : null;
  const reveal = useStore((s) => (roundId ? s.reveals[roundId] || null : null));
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [fresh] = useState(() => !(t.revealAck || [])[n - 1]);
  const reported = useReported(roundId);

  const online = useStore((s) => s.ui.online);

  useEffect(() => {
    if (!roundId) return undefined;
    let alive = true;
    setError(null);
    loadReveal(n).then((r) => { if (alive && !r.ok) setError(r.err || new Error('Could not load the reveal.')); });
    return () => { alive = false; };
  }, [roundId, retry]);

  // "The reveal loads once you are back online": retry a reveal that failed for lack of a connection
  useEffect(() => { if (online && error && error.isNetwork && !reveal) setRetry((k) => k + 1); }, [online]);

  // a round just finished: announce leaderboard overtakes (toast), once per round per session
  useEffect(() => { if (fresh) scheduleOvertakeCheck(roundId, t.date, 1400); }, [roundId]);

  const after = useMemo(() => {
    const ack = [...(t.revealAck || [false, false, false, false, false])];
    ack[n - 1] = true;
    return currentView({ ...t, revealAck: ack });
  }, [t, n]);
  const toSummary = after.kind === 'summary';

  if (!round) return null;
  const onNext = () => {
    const completesDay = toSummary && !(t.revealAck || [])[n - 1];
    haptic(completesDay ? 'success' : 'selection'); // day complete (§3.1): inside the tap, for iOS
    if (completesDay) markDayComplete(t.date);
    ackReveal(n);
  };
  const graphAsset = state && state.clues && state.clues.graph ? state.clues.graph.asset : null;
  return html`<${RevealView} n=${n} dayNumber=${round.day_number || t.dayNumber} round=${round} state=${state}
    reveal=${reveal} error=${error} onRetry=${() => setRetry((k) => k + 1)} fresh=${fresh} day=${t}
    nextLabel=${toSummary ? 'Today’s results' : 'Next round →'} onNext=${onNext}
    onReport=${() => openReport({ roundIndex: n, roundId, typeName: reveal ? reveal.type.name : null, dayNumber: round.day_number })}
    reported=${reported} graphAsset=${graphAsset}
    onFullView=${(extra = {}) => import('./fullview.js').then((m) => m.openFullView({ roundIndex: n, mode: '3d', ...extra })).catch(() => {})} />`;
}

export default function Reveal({ params = {} }) {
  const n = Math.min(5, Math.max(1, Number.parseInt(params.n, 10) || 1));
  return html`<${RevealRound} key=${n} n=${n} />`;
}
