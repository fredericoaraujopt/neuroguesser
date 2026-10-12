// GraphView (js/viewer/graph-view.js): layout maths + the rendered SVG on a minimal DOM.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer, flush } from './_dom.js';

const { h, render } = await import('preact');
const gv = await import('../js/viewer/graph-view.js');

const GRAPH = {
  version: 1, n_syn_in: 1204, n_syn_out: 980,
  inputs: [{ label: 'L2/3 IT', n_syn: 373, share: 0.31 }, { label: 'L5 IT', n_syn: 265, share: 0.22 }, { label: 'L4 IT', n_syn: 217, share: 0.18 }],
  outputs: [{ label: 'L5 IT', n_syn: 300, share: 0.306 }, { label: 'L6 CT', n_syn: 120, share: 0.122 }],
};

function all(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.childNodes || []) all(c, pred, out);
  return out;
}
const byTag = (root, tag) => all(root, (n) => n.localName === tag);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≈ ${b}`);

test('edgeWidth ∝ share within 0.75–6 px; fmtShare; fitLabel', () => {
  assert.ok(gv.edgeWidth(0.31) > gv.edgeWidth(0.22) && gv.edgeWidth(0.22) > gv.edgeWidth(0.18));
  assert.equal(gv.edgeWidth(0), 0.75);
  assert.equal(gv.edgeWidth(1), 6);
  assert.equal(gv.edgeWidth(0.31), 3.1);
  assert.equal(gv.edgeWidth(NaN), 0.75);
  assert.equal(gv.fmtShare(0.31), '31%');
  assert.equal(gv.fmtShare(0.004), '<1%');
  assert.equal(gv.fmtShare(0), '0%');
  assert.equal(gv.fitLabel('short', 100), 'short');
  const long = gv.fitLabel('Mushroom body output neuron MBON-γ1pedc>α/β', 60);
  assert.ok(long.endsWith('…') && long.length <= 11);
  assert.ok(gv.textWidth(long) <= 60);
  near(gv.textWidth('Medium ganglion (MG) cell'), 119.5 * 1.03, 1, 'Liberation Sans advances (browser: 119.5 px)');
  near(gv.textWidth('γ'), 5.73, 0.01);
});

test('graphLayout: inputs left, outputs right, rows centred on the cell; edges end at the cell', () => {
  const L = gv.graphLayout(GRAPH, 343, 244);
  assert.equal(L.inputs.length, 3); assert.equal(L.outputs.length, 2);
  assert.ok(L.inputs.every((p) => p.x < L.cx) && L.outputs.every((p) => p.x > L.cx));
  assert.equal(L.inputs[1].y, L.cy, 'the middle input is level with the cell');
  assert.equal((L.outputs[0].y + L.outputs[1].y) / 2, L.cy);
  assert.ok(L.inputs.every((p) => p.d.endsWith(`${(L.cx - 9).toFixed(1)} ${L.cy.toFixed(1)}`)));
  assert.equal(L.nSynIn, 1204); assert.equal(L.note, null);
  assert.equal(gv.graphLayout({ inputs: [1, 2, 3, 4, 5].map((n) => ({ label: `t${n}`, n_syn: n, share: 0.1 })), outputs: [] }).inputs.length, 3, 'top 3 only');
});

test('GraphView renders: data-sky inputs, data-orange outputs, labels with n synapses and share, the fixed note', async () => {
  const root = createContainer();
  render(h(gv.GraphView, { graph: GRAPH, width: 343, height: 244 }), root);
  await flush();
  const text = root.textContent;
  for (const s of ['L2/3 IT', '373 syn · 31%', 'L6 CT', '120 syn · 12%', 'same-type partners hidden', 'INPUTS · 1,204 SYN', 'OUTPUTS · 980 SYN', 'input', 'output', 'this cell']) {
    assert.ok(text.includes(s), `renders "${s}"`);
  }
  const paths = byTag(root, 'path');
  assert.equal(paths.length, 5);
  const sky = paths.filter((p) => p.attributes.stroke === 'var(--data-sky)');
  const orange = paths.filter((p) => p.attributes.stroke === 'var(--data-orange)');
  assert.equal(sky.length, 3); assert.equal(orange.length, 2);
  assert.equal(Number(sky[0].attributes['stroke-width']), gv.edgeWidth(0.31));
  const svg = byTag(root, 'svg')[0];
  assert.equal(svg.attributes.role, 'img');
  assert.match(svg.attributes['aria-label'], /Inputs: L2\/3 IT, 373 synapses, 31%/);
  render(null, root);
});

test('GraphView empty states: no inputs, the generic note, and no graph at all', async () => {
  const root = createContainer();
  render(h(gv.GraphView, { graph: { ...GRAPH, inputs: [], n_syn_in: 0 } }), root);
  await flush();
  assert.ok(root.textContent.includes('no inputs listed'));
  assert.ok(root.textContent.includes('same-type partners hidden'));
  assert.equal(byTag(root, 'svg')[0].attributes.width, '100%', 'responsive without width/height');

  const note = 'Partner data are not available for this dataset.';
  render(h(gv.GraphView, { graph: { version: 1, inputs: [], outputs: [], n_syn_in: 0, n_syn_out: 0, note } }), root);
  await flush();
  assert.ok(root.textContent.includes(note));
  assert.ok(root.textContent.includes('same-type partners hidden'), 'the fixed micro note is always shown');
  assert.equal(byTag(root, 'path').length, 0);

  render(h(gv.GraphView, { graph: null }), root);
  await flush();
  assert.ok(root.textContent.includes('Graph unavailable'));
  render(null, root);
});

test('graphLayout: labels sit on the side of the node away from its edge (above for upper rows, below for lower)', () => {
  for (const [w, h] of [[343, 244], [375, 236], [300, 200], [288, 168], [600, 320]]) {
    const L = gv.graphLayout({ ...GRAPH, outputs: GRAPH.inputs }, w, h);
    for (const p of [...L.inputs, ...L.outputs]) {
      assert.equal(p.below, p.y > L.cy + 0.5, 'below ⇔ the row is under the cell');
      // edge from the node runs towards the cell (cy): the two label lines must lie on the other side
      const lines = [p.labelY, p.numY];
      if (p.y < L.cy - 0.5) assert.ok(lines.every((y) => y < p.y), 'upper row: labels above');
      if (p.below) assert.ok(lines.every((y) => y > p.y), 'lower row: labels below');
      assert.ok(Math.min(...lines) - 7.5 > L.headY + 2.5, `${w}×${h}: labels clear the column headers`);
      assert.ok(Math.max(...lines) + 2.5 < L.keyY - 7.5, `${w}×${h}: labels clear the key`);
    }
  }
});

// Text boxes at 10 px: Sans ≈ 5.4 px a character, Mono 6 px; cap 7.5 px above the baseline, descender 2.5 below.
const LONG = {
  version: 1, n_syn_in: 227, n_syn_out: 1980,
  inputs: [{ label: 'Medium ganglion (MG) cell', n_syn: 94, share: 0.41 }, { label: 'Small ganglion (SG) cell', n_syn: 66, share: 0.29 }, { label: 'Granular cell (Gr+)', n_syn: 43, share: 0.19 }],
  outputs: [{ label: 'L6 IT pyramidal neuron', n_syn: 1234, share: 0.62 }, { label: 'untyped', n_syn: 300, share: 0.15 }, { label: 'Mushroom body output neuron', n_syn: 120, share: 0.06 }],
};
function boxes(L) {
  const sans = (x, y, t, anchor = 'middle') => {
    const tw = gv.textWidth(t);
    const x0 = anchor === 'middle' ? x - tw / 2 : anchor === 'end' ? x - tw : x;
    return [x0, y - 7.5, x0 + tw, y + 2.5, t];
  };
  const mono = (x, y, t, anchor = 'middle') => {
    const tw = t.length * 6;
    const x0 = anchor === 'middle' ? x - tw / 2 : anchor === 'end' ? x - tw : x;
    return [x0, y - 7.5, x0 + tw, y + 2.5, t];
  };
  const out = [
    mono(8, L.headY, `INPUTS · ${L.nSynIn} SYN`, 'start'),
    mono(L.w - 8, L.headY, `OUTPUTS · ${L.nSynOut} SYN`, 'end'),
    [L.cx - 9, L.cy - 9, L.cx + 9, L.cy + 9, 'cell'],
    sans(L.cx, L.cy + 22, 'this cell'),
    [0, L.keyY - 7.5 - (L.keyTwoLines ? 12 : 0), L.w, L.h, 'key'],
  ];
  for (const p of [...L.inputs, ...L.outputs]) {
    out.push([p.x - 5, p.y - 5, p.x + 5, p.y + 5, `node ${p.label}`]);
    out.push(sans(p.labelX, p.labelY, p.shortLabel));
    out.push(mono(p.x, p.numY, `${p.nSyn.toLocaleString('en-US')} syn · ${Math.round(p.share * 100)}%`));
  }
  return out;
}

test('graphLayout: nothing overlaps at 320 × 640 (288 × 168 box), the design box and the reveal panel', () => {
  for (const [w, h] of [[288, 168], [343, 244], [327, 240], [240, 240], [390, 200]]) {
    const L = gv.graphLayout(LONG, w, h);
    assert.equal(L.compact, h < gv.COMPACT_H);
    const B = boxes(L);
    for (let i = 0; i < B.length; i++) {
      const a = B[i];
      if (/^(node|cell)/.test(a[4]) || a[4] === 'key') continue;
      assert.ok(a[0] >= 0 && a[2] <= w + 0.5, `${w}×${h}: "${a[4]}" inside the box`);
      for (let j = 0; j < B.length; j++) {
        if (i === j) continue;
        const b = B[j];
        const hit = a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
        assert.ok(!hit, `${w}×${h}: "${a[4]}" overlaps "${b[4]}"`);
      }
    }
  }
});

test('graphLayout: a long label slides inwards (never past the cell) instead of being cut; compact rhythm below COMPACT_H', () => {
  const L = gv.graphLayout(LONG, 288, 168);
  const mg = L.inputs[0];
  assert.equal(mg.shortLabel, 'Medium ganglion (MG) cell', 'fits whole at 288 px');
  assert.ok(mg.labelX > mg.x, 'shifted towards the cell');
  assert.ok(mg.labelX + gv.textWidth(mg.shortLabel) / 2 <= L.cx - 4 + 0.01, 'stops short of the centre line');
  const mbon = L.outputs[2];
  assert.ok(mbon.shortLabel.endsWith('…'), 'too long even with the room: cut with an ellipsis');
  assert.ok(mbon.labelX - gv.textWidth(mbon.shortLabel) / 2 >= L.cx + 4 - 0.01);
  assert.ok(mbon.labelX + gv.textWidth(mbon.shortLabel) / 2 <= 288 - 8 + 0.01);
  const R = gv.graphLayout(LONG, 343, 244);
  assert.equal(R.compact, false);
  assert.ok(L.inputs[1].y - L.inputs[0].y > 38, 'compact rows keep room for two label lines between nodes');
  assert.equal(gv.graphLayout(LONG, 240, 240).keyTwoLines, true, 'narrow: the note moves under the swatches');
  assert.equal(gv.graphLayout(LONG, 288, 168).keyTwoLines, false);
});

test('GraphView draws edges first, then nodes, then labels (no edge over a label)', async () => {
  const root = createContainer();
  render(h(gv.GraphView, { graph: LONG, width: 288, height: 168 }), root);
  await flush();
  const svg = byTag(root, 'svg')[0];
  const seq = all(svg, (n) => ['path', 'circle', 'text'].includes(n.localName) && !(n.parentNode && n.parentNode.attributes && n.parentNode.attributes.class === 'gv-key'));
  const lastPath = seq.map((n) => n.localName).lastIndexOf('path');
  const firstLabel = seq.findIndex((n) => n.attributes.class === 'gv-label');
  const lastNode = seq.map((n) => n.localName).lastIndexOf('circle');
  assert.ok(lastPath < lastNode && lastNode < firstLabel, 'edges < nodes < labels in paint order');
  render(null, root);
});

test('GraphView draws lower-row labels below their node', async () => {
  const root = createContainer();
  render(h(gv.GraphView, { graph: GRAPH, width: 343, height: 244 }), root);
  await flush();
  const L = gv.graphLayout(GRAPH, 343, 244);
  const low = L.inputs[2];
  const texts = byTag(root, 'text').filter((t) => t.attributes.class === 'gv-label' && t.textContent.includes(low.shortLabel));
  assert.equal(texts.length, 1);
  assert.ok(Number(texts[0].attributes.y) > low.y, 'label under the bottom input node');
  render(null, root);
});
