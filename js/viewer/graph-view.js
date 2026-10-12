// GraphView({ graph, width, height }) (ARCHITECTURE.md §3 "Graph view", §4.4; contracts/graph_clue.schema.json):
// SVG partners diagram — up to 3 inputs on the left in data-sky, the cell in the centre (data-black), up to 3
// outputs on the right in data-orange; edge width ∝ share; each partner labelled with its type, n synapses and
// share %. Always the micro note "same-type partners hidden"; the generic `note` when partner data are missing;
// empty columns say so in words. Colours are keyed in words ("● input", "● output") — never colour alone.
// Without width/height the SVG scales to its container (viewBox 343 × 244, the round viewer's free area).
// Short boxes (< COMPACT_H, e.g. 288 × 168 at 320 × 640) use a tighter rhythm; edges are painted under the nodes
// and labels, and labels carry a sunken halo (css/viewer.css), so nothing overlaps at any supported size.
// Delight: edges and nodes fade in left → right (≤ 400 ms) unless reduced motion / Celebrations off.
// Type: the layout is computed for 10 px text (--fs-fig-graph); a sized view draws it scaled so the text reads at the
// SVG's computed font size, the token --fs-graph (css/tokens.css: 10 on phones, 13 on a laptop, desktop.css).
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, loadCss } from '../ui/html.js';
import { fmtPts } from '../format.js';
import { motionAllowed } from '../fx/celebrate.js';

loadCss('css/viewer.css');

export const SAME_TYPE_NOTE = 'same-type partners hidden';
export const DEFAULT_W = 343;
export const DEFAULT_H = 244;
const MIN_LABEL_PX = 22;             // a label always keeps a few characters before its ellipsis

/** Edge stroke width (px) for a share in 0…1: ∝ share, 0.75 px minimum, 6 px maximum. */
export function edgeWidth(share) {
  const s = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  return Math.round(Math.max(0.75, Math.min(6, 10 * s)) * 100) / 100;
}

/** 0.31 → "31%", 0.004 → "<1%". */
export function fmtShare(share) {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  if (share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}

// Advance widths of Liberation Sans (metric-compatible with Arial), 1/1000 em, printable ASCII from U+0020; other
// characters (γ, α, ′…) count as 556. × 1.03 covers hinting: within 3 % of the browser on the season's labels.
const ADV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667,
  556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556,
  500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584];
const ELLIPSIS = 1000;

/** Estimated width (px) of `text` in 10 px Sans (or `size` px). */
export function textWidth(text, size = 10) {
  let u = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0) - 32;
    u += c >= 0 && c < ADV.length ? ADV[c] : 556;
  }
  return (u * size * 1.03) / 1000;
}

/** Truncate to fit `px` at 10 px Sans (ellipsis). */
export function fitLabel(text, px) {
  const t = String(text || '');
  if (textWidth(t) <= px) return t;
  const room = Math.max(px, MIN_LABEL_PX) - (ELLIPSIS * 10 * 1.03) / 1000;
  const chars = [...t];
  let n = chars.length;
  while (n > 3 && textWidth(chars.slice(0, n).join('')) > room) n -= 1;
  return `${chars.slice(0, n).join('').trimEnd()}…`;
}

// Vertical rhythm (10 px text): regular for the 244 px design box, compact below COMPACT_H (320 × 640 gives ≈ 168).
// lab/num: baselines of the two label lines relative to the node, above (−) or below (+) it; headY: header
// baseline; keyGap: key baseline above the bottom edge.
const RHYTHM = {
  regular: { headY: 12, keyGap: 10, above: [-22, -10], below: [16, 28], pad: 3 },
  compact: { headY: 10, keyGap: 4, above: [-21, -10], below: [15, 26], pad: 4 },
};
export const COMPACT_H = 216;
const KEY_W = 250;          // "● input ● output · same-type partners hidden" ≈ 250 px at 10 px
const CAP = 7.5;            // cap height above a baseline
const DESC = 2.5;           // descender below a baseline
const NODE_R = 5;
const CELL_R = 9;

/**
 * Layout for a graph in a w × h box: partner positions, label baselines, edges, centre. Pure (unit-tested).
 * Upper partners carry their two label lines above the node, lower ones below it, so an edge leaves its node
 * away from its own label; the node band is as tall as the headers and the key allow (compact rhythm below
 * COMPACT_H). A label may slide inwards from its node (towards the cell, never past it) to show more of a long
 * name. Edges are drawn under the nodes and the labels, which carry a sunken halo where an edge passes behind.
 */
export function graphLayout(graph, w = DEFAULT_W, h = DEFAULT_H) {
  const g = graph || {};
  const inputs = Array.isArray(g.inputs) ? g.inputs.slice(0, 3) : [];
  const outputs = Array.isArray(g.outputs) ? g.outputs.slice(0, 3) : [];
  const R = h < COMPACT_H ? RHYTHM.compact : RHYTHM.regular;
  const cx = w / 2;
  const keyTwoLines = w < KEY_W + 16;
  const keyY = h - R.keyGap;                         // baseline of the (last) key line
  const keyTop = keyY - CAP - (keyTwoLines ? 12 : 0);
  const top = R.headY + DESC;                        // headers' bottom
  const bandTop = top + R.pad - R.above[0] + CAP;
  const bandBottom = Math.max(bandTop, keyTop - R.pad - R.below[1] - DESC);
  const cy = (bandTop + bandBottom) / 2;
  const xIn = Math.round(w * 0.2);
  const xOut = Math.round(w * 0.8);
  const gap = Math.min((bandBottom - bandTop) / 2, 66);
  const ys = (n) => Array.from({ length: n }, (_, i) => cy + (i - (n - 1) / 2) * gap);
  // a label may run from the outer margin to 4 px short of the centre line: at its height (above or below its node)
  // only the cell's own column is free, and the other side's label stops 4 px past it
  const maxLabelPx = cx - 4 - 8;
  const place = (list, x, side) => ys(list.length).map((y, i) => {
    const p = list[i];
    const share = Number(p.share) || 0;
    const below = y > cy + 0.5;
    const shortLabel = fitLabel(p.label || 'untyped', maxLabelPx);
    const half = Math.min(textWidth(shortLabel), maxLabelPx) / 2;
    const labelX = side === 'in'
      ? Math.max(8 + half, Math.min(x, cx - 4 - half))
      : Math.min(w - 8 - half, Math.max(x, cx + 4 + half));
    const [l1, l2] = below ? R.below : R.above;
    return {
      side, x, y, below,
      label: String(p.label || 'untyped'),
      shortLabel,
      labelX: Math.round(labelX * 10) / 10,
      labelY: y + l1,
      numY: y + l2,
      nSyn: Math.max(0, Math.round(Number(p.n_syn) || 0)),
      share,
      width: edgeWidth(share),
    };
  });
  const ins = place(inputs, xIn, 'in');
  const outs = place(outputs, xOut, 'out');
  const curve = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2;
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} C${mx.toFixed(1)} ${y1.toFixed(1)} ${mx.toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  return {
    w, h, cx, cy, xIn, xOut, top, headY: R.headY, keyY, keyTwoLines, compact: R === RHYTHM.compact,
    inputs: ins.map((p) => ({ ...p, d: curve(p.x + NODE_R, p.y, cx - CELL_R, cy) })),
    outputs: outs.map((p) => ({ ...p, d: curve(cx + CELL_R, cy, p.x - NODE_R, p.y) })),
    nSynIn: Math.max(0, Math.round(Number(g.n_syn_in) || 0)),
    nSynOut: Math.max(0, Math.round(Number(g.n_syn_out) || 0)),
    note: typeof g.note === 'string' && g.note ? g.note : null,
  };
}

/** One-sentence description for screen readers. */
export function graphSummary(graph) {
  if (!graph) return 'Graph clue unavailable.';
  const L = graphLayout(graph);
  if (L.note && !L.inputs.length && !L.outputs.length) return `Graph clue: ${L.note} (${SAME_TYPE_NOTE}).`;
  const list = (ps) => (ps.length ? ps.map((p) => `${p.label}, ${fmtPts(p.nSyn)} synapses, ${fmtShare(p.share)}`).join('; ') : 'none listed');
  return `Graph clue. Inputs: ${list(L.inputs)}. Outputs: ${list(L.outputs)}. ${SAME_TYPE_NOTE[0].toUpperCase()}${SAME_TYPE_NOTE.slice(1)}.`;
}

const colourOf = (p) => (p.side === 'in' ? 'var(--data-sky)' : 'var(--data-orange)');
const fadeOf = (p, i, animate) => (animate
  ? { class: 'gv-fade', style: { animationDelay: `${(p.side === 'in' ? 0 : 3) * 50 + i * 50}ms` } }
  : { class: null, style: null });

// Three layers so no edge is ever drawn over a node or a label: all edges, then all nodes, then all labels.
function PartnerEdge({ p, i, animate }) {
  const f = fadeOf(p, i, animate);
  return html`<path class=${f.class} style=${f.style} d=${p.d} fill="none" stroke=${colourOf(p)} stroke-width=${p.width} stroke-linecap="round"></path>`;
}
function PartnerNode({ p, i, animate }) {
  const f = fadeOf(p, i, animate);
  return html`<circle class=${f.class} style=${f.style} cx=${p.x} cy=${p.y} r="5" fill=${colourOf(p)}></circle>`;
}
function PartnerLabel({ p, i, animate }) {
  const f = fadeOf(p, i, animate);
  return html`<g class=${f.class} style=${f.style}>
    <text x=${p.labelX} y=${p.labelY} text-anchor="middle" class="gv-label"><title>${p.label}</title>${p.shortLabel}</text>
    <text x=${p.x} y=${p.numY} text-anchor="middle" class="gv-num">${fmtPts(p.nSyn)} syn · ${fmtShare(p.share)}</text>
  </g>`;
}

const FIG_PX = 10;  // the layout's text size (px in the drawing's own units)

export function GraphView({ graph, width, height }) {
  const sized = width > 0 && height > 0;
  const svgRef = useRef(null);
  const [k, setK] = useState(1);  // drawing scale: on-screen text px / FIG_PX (sized views only)
  useLayoutEffect(() => {
    let px = NaN;
    try { px = svgRef.current ? parseFloat(getComputedStyle(svgRef.current).fontSize) : NaN; } catch (_) { /* no CSSOM */ }
    const next = sized && px > FIG_PX ? Math.round((px / FIG_PX) * 1000) / 1000 : 1;
    if (next !== k) setK(next);
  });
  const w = width > 0 ? width / k : DEFAULT_W;
  const h = height > 0 ? height / k : DEFAULT_H;
  const L = useMemo(() => graphLayout(graph, w, h), [graph, w, h]);
  const animate = useMemo(() => motionAllowed(), [graph]);
  const svgProps = sized ? { width, height, ref: svgRef } : { width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet', ref: svgRef };

  if (!graph) {
    return html`<svg class="gv" ...${svgProps} viewBox=${`0 0 ${w} ${h}`} role="img" aria-label="Graph clue unavailable">
      <text x=${w / 2} y=${h / 2} text-anchor="middle" class="gv-empty">Graph unavailable</text>
    </svg>`;
  }

  const noData = L.note && !L.inputs.length && !L.outputs.length;
  const keyY = L.keyY;
  // key: "● input ● output · same-type partners hidden" on one centred line (≈ 250 px), or, when narrower,
  // the two swatches centred above the note
  const kx = L.keyTwoLines ? Math.max(8, (w - 92) / 2) : Math.max(8, (w - 250) / 2);
  const ky = L.keyTwoLines ? keyY - 12 : keyY;
  const parts = [...L.inputs, ...L.outputs];
  const idx = (p) => (p.side === 'in' ? L.inputs.indexOf(p) : L.outputs.indexOf(p));
  return html`<svg class="gv" ...${svgProps} viewBox=${`0 0 ${w} ${h}`} role="img" aria-label=${graphSummary(graph)}>
    ${noData ? html`
      <circle cx=${L.cx} cy=${L.cy - 10} r="9" fill="var(--data-black)"></circle>
      <text x=${L.cx} y=${L.cy + 18} text-anchor="middle" class="gv-empty">${L.note}</text>
    ` : html`
      <text x="8" y=${L.headY} class="gv-head">INPUTS${L.nSynIn ? ` · ${fmtPts(L.nSynIn)} SYN` : ''}</text>
      <text x=${w - 8} y=${L.headY} text-anchor="end" class="gv-head">OUTPUTS${L.nSynOut ? ` · ${fmtPts(L.nSynOut)} SYN` : ''}</text>
      ${L.inputs.length ? null : html`<text x=${L.xIn} y=${L.cy + 4} text-anchor="middle" class="gv-empty">no inputs listed</text>`}
      ${L.outputs.length ? null : html`<text x=${L.xOut} y=${L.cy + 4} text-anchor="middle" class="gv-empty">no outputs listed</text>`}
      ${parts.map((p) => html`<${PartnerEdge} key=${`e${p.side}${idx(p)}`} p=${p} i=${idx(p)} animate=${animate} />`)}
      ${parts.map((p) => html`<${PartnerNode} key=${`n${p.side}${idx(p)}`} p=${p} i=${idx(p)} animate=${animate} />`)}
      <circle cx=${L.cx} cy=${L.cy} r="9" fill="var(--data-black)"></circle>
      ${parts.map((p) => html`<${PartnerLabel} key=${`l${p.side}${idx(p)}`} p=${p} i=${idx(p)} animate=${animate} />`)}
      <text x=${L.cx} y=${L.cy + 22} text-anchor="middle" class="gv-micro">this cell</text>
    `}
    <g class="gv-key">
      <circle cx=${kx + 4} cy=${ky - 3} r="4" fill="var(--data-sky)"></circle>
      <text x=${kx + 12} y=${ky}>input</text>
      <circle cx=${kx + 52} cy=${ky - 3} r="4" fill="var(--data-orange)"></circle>
      <text x=${kx + 60} y=${ky}>output</text>
      ${L.keyTwoLines
    ? html`<text x=${w / 2} y=${keyY} text-anchor="middle" class="gv-micro">${SAME_TYPE_NOTE}</text>`
    : html`<text x=${kx + 102} y=${keyY} class="gv-micro">· ${SAME_TYPE_NOTE}</text>`}
    </g>
  </svg>`;
}

export default GraphView;
