// Reveal track: screens/reveal.js, summary.js, share.js, report.js (ARCHITECTURE.md §3, §3.1, §3.3 item 2): pure helpers
// and the Facts / How it was made tab panels rendered on the minimal DOM (tests/_dom.js).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roundState, SCORING_EXAMPLE_PROGRESS } from './fixtures.js';
import { createContainer, flush } from './_dom.js';

const { h, render } = await import('preact');
const rv = await import('../js/screens/reveal.js');
const sm = await import('../js/screens/summary.js');
const sh = await import('../js/screens/share.js');
const rp = await import('../js/screens/report.js');
const { ApiError } = await import('../js/api.js');
const fixture = JSON.parse(readFileSync(new URL('../dev/reveal.fixture.json', import.meta.url), 'utf8'));

const named = roundState({ stage: 'done', type_result: 'correct', method_correct: true });
const met = roundState({ stage: 'done', type_result: 'correct', wrong: ['a'], clues_opened: ['context'], eliminated: ['b'] });
const missed = roundState({ stage: 'done', type_result: 'exhausted', wrong: ['a', 'b', 'c'], method_pick: null });

test('verdictOf: word + glyph + tone per outcome (colour is never the only signal)', () => {
  assert.deepEqual(rv.verdictOf(named), { word: 'Named', glyph: '✓', tone: 'accent', points: 1200 });
  assert.deepEqual(rv.verdictOf(met), { word: 'Met', glyph: '✓', tone: 'accent', points: 800 });
  assert.deepEqual(rv.verdictOf(missed), { word: 'Missed', glyph: '✕', tone: 'error', points: 0 });
});

test('outcomeLine: one line, no answer text', () => {
  assert.equal(rv.outcomeLine(named), 'Named on the first guess, no clues · method ✓ +200');
  assert.equal(rv.outcomeLine(met), 'Got it after 1 wrong guess and 1 clue · method ✕');
  assert.equal(rv.outcomeLine(missed), 'Not named: 3 wrong guesses · method skipped');
});

test('transmitterLine / ephysCaption / genesCaption / fmtVoxel / reviewDays', () => {
  assert.equal(rv.transmitterLine({ value: 'acetylcholine', kind: 'predicted', confidence: 0.9 }),
    'Transmitter: acetylcholine · predicted, certainty 0.90');
  assert.equal(rv.transmitterLine(null), null);
  assert.equal(rv.ephysCaption({ match_level: 'same_cell', source: 'DANDI' }), 'Recorded from this cell · DANDI');
  assert.equal(rv.ephysCaption({ match_level: 'same_subclass', reference_type: 'L5 ET', source: 'Allen' }),
    'Matched subclass (L5 ET), not this cell · Allen');
  assert.equal(rv.genesCaption({ level: 'subclass', source: 'ABC atlas' }), 'Matched subclass, not this cell · ABC atlas');
  assert.equal(rv.fmtVoxel([4, 4, 40]), '4 × 4 × 40 nm');
  assert.deepEqual(['named', 'met', 'missed'].map(rv.reviewDays), [7, 2, 2]);
});

test('typeLabelText never repeats the summary word', () => {
  assert.equal(rv.typeLabelText('putative', 'classifier'), 'putative · classifier');
  assert.equal(rv.typeLabelText('expert', 'expert'), 'expert');
  assert.equal(rv.typeLabelText('expert', 'expert_cross_matched'), 'expert, cross-matched');
  assert.equal(rv.typeLabelText('molecular label', 'molecular_label'), 'molecular label');
  assert.equal(rv.typeLabelText('matched', 'transferred'), 'matched · transferred from another dataset');
  assert.equal(rv.typeLabelText('expert', undefined), 'expert');
});

// v1.3 structured trivia (ARCHITECTURE.md §3.4 item 1)
const clone = (o) => JSON.parse(JSON.stringify(o));
const GRAPH = fixture.assets[fixture.state.clues.graph.asset];
const OPTION_LABELS = fixture.round.options.map((o) => o.label);
const factOf = (cat) => fixture.reveal.trivia.facts.find((f) => f.category === cat);

test('triviaParts: What it does / How to tell it apart / Who it talks to, one item each; the rest under the card', () => {
  const tp = rv.triviaParts(fixture.reveal, { optionLabels: OPTION_LABELS, graph: GRAPH });
  assert.equal(tp.card, true);
  assert.deepEqual(tp.parts.map((p) => [p.id, p.label]), [['does', 'What it does'], ['apart', 'How to tell it apart'], ['talks', 'Who it talks to']]);
  assert.equal(tp.parts[0].fact, factOf('function'));
  assert.equal(tp.parts[1].fact, factOf('identify'));
  assert.deepEqual(tp.parts[1].vs, ['L5 NP pyramidal neuron', 'L5 IT pyramidal neuron']);
  assert.equal(tp.parts[2].fact, factOf('connectivity'));
  assert.equal(tp.parts[2].data, 'Here, 38% of its input synapses come from L2/3 IT and 25% from L5 IT; 29% of its output synapses go to L6 IT and 20% to Basket.');
  assert.deepEqual(tp.extra, [factOf('other')], 'an `other` fact is listed under the card');
  assert.equal(tp.extraTitle, 'More facts');
  assert.equal(tp.roleLine, rv.roleLine(fixture.reveal.type.role), 'with a function fact the role line still leads');
  const how = new Set((fixture.reveal.how_typed.facts || []).map((f) => f.text));
  for (const p of tp.parts) assert.ok(!p.fact || !how.has(p.fact.text), 'never a how_typed fact');
});

test('triviaParts fallbacks: role for What it does, data line alone, v1.2 uncategorised facts, nothing at all', () => {
  // no function fact: the role line becomes the "What it does" item (and is not repeated above the card)
  const noFn = clone(fixture.reveal);
  noFn.trivia.facts = noFn.trivia.facts.filter((f) => f.category !== 'function');
  let tp = rv.triviaParts(noFn, { optionLabels: OPTION_LABELS, graph: GRAPH });
  assert.equal(tp.parts[0].id, 'does');
  assert.equal(tp.parts[0].fact, null);
  assert.equal(tp.parts[0].text, rv.roleLine(noFn.type.role));
  assert.equal(tp.roleLine, null);
  // no identify fact: that part is left out; no connectivity fact: the data line alone
  const thin = clone(fixture.reveal);
  thin.trivia.facts = thin.trivia.facts.filter((f) => f.category === 'function');
  tp = rv.triviaParts(thin, { optionLabels: OPTION_LABELS, graph: GRAPH });
  assert.deepEqual(tp.parts.map((p) => p.id), ['does', 'talks']);
  assert.equal(tp.parts[1].fact, null);
  assert.match(tp.parts[1].data, /^Here, 38% of its input synapses come from/);
  // ... and without a graph clue (a closed round never played) the part is gone
  assert.deepEqual(rv.triviaParts(thin, { graph: null }).parts.map((p) => p.id), ['does']);
  // v1.2 reveals (facts without a category, "absent = other"): role + data line in the card, the facts under it
  const v12 = clone(fixture.reveal);
  v12.trivia.facts = clone(fixture.trivia_v12_facts);
  tp = rv.triviaParts(v12, { optionLabels: OPTION_LABELS, graph: GRAPH });
  assert.equal(tp.card, true);
  assert.deepEqual(tp.parts.map((p) => p.id), ['does', 'talks']);
  assert.equal(tp.extra.length, 3);
  assert.equal(tp.extraTitle, 'From the literature');
  // ... and with no partner data: no card; the role line, then the facts as "Did you know?" (the v1.2 look)
  tp = rv.triviaParts(v12, { graph: null });
  assert.deepEqual([tp.card, tp.parts.length, tp.extra.length, tp.extraTitle], [false, 0, 3, 'Did you know?']);
  assert.equal(tp.roleLine, rv.roleLine(v12.type.role));
  // nothing: no card, no extra facts, the role line only
  const none = clone(fixture.reveal);
  delete none.trivia.facts;
  tp = rv.triviaParts(none, { graph: null });
  assert.deepEqual([tp.card, tp.parts.length, tp.extra.length], [false, 0, 0]);
  assert.equal(rv.triviaParts(null).card, false);
});

test('pickIdentify: the look-alike tip that names most of this round\'s options; first on a tie', () => {
  const a = { text: 'A', category: 'identify', contrast_with_labels: ['L6 IT pyramidal neuron'] };
  const b = { text: 'B', category: 'identify', contrast_with_labels: ['L5 IT pyramidal neuron', 'l5 np pyramidal neuron '] };
  const c = { text: 'C', category: 'identify', contrast_with_labels: ['L5 IT pyramidal neuron'] };
  assert.equal(rv.pickIdentify([a, c, b], OPTION_LABELS), b, 'two of the options (case and spaces ignored)');
  assert.equal(rv.pickIdentify([a, c], OPTION_LABELS), c);
  assert.equal(rv.pickIdentify([a, { ...a, text: 'A2' }], OPTION_LABELS), a, 'no overlap: the first');
  assert.equal(rv.pickIdentify([{ text: 'F', category: 'function' }], OPTION_LABELS), null);
  assert.equal(rv.pickIdentify(null, null), null);
});

test('graphDataLine: top two typed partners per side, shares first; untyped left out; nothing typed → null', () => {
  assert.equal(rv.graphDataLine(GRAPH), 'Here, 38% of its input synapses come from L2/3 IT and 25% from L5 IT; 29% of its output synapses go to L6 IT and 20% to Basket.');
  const g = { version: 1, n_syn_in: 10, n_syn_out: 10 };
  assert.equal(rv.graphDataLine({ ...g, inputs: [{ label: 'PN', n_syn: 9, share: 0.41 }], outputs: [] }), 'Here, 41% of its input synapses come from PN.');
  assert.equal(rv.graphDataLine({ ...g, inputs: [{ label: 'untyped', n_syn: 9, share: 0.6 }, { label: 'APL', n_syn: 2, share: 0.004 }],
    outputs: [{ label: 'MBON-γ1pedc', n_syn: 5, share: 0.35 }] }), 'Here, under 1% of its input synapses come from APL; 35% of its output synapses go to MBON-γ1pedc.');
  // labels that end in a parenthesis read cleanly (no "(ELL projection neuron) (43%)")
  assert.equal(rv.graphDataLine({ ...g, inputs: [], outputs: [{ label: 'Output cell (ELL projection neuron)', n_syn: 5, share: 0.31 }] }),
    'Here, 31% of its output synapses go to Output cell (ELL projection neuron).');
  assert.equal(rv.graphDataLine({ ...g, inputs: [{ label: 'PN', n_syn: 9 }, { label: 'APL', n_syn: 2 }], outputs: [] }),
    'Here, its input synapses come mainly from PN and APL.', 'no share (not in the contract): no numbers');
  assert.equal(rv.graphDataLine({ ...g, inputs: [], outputs: [{ label: 'Untyped', n_syn: 3, share: 1 }] }), null);
  assert.equal(rv.graphDataLine({ ...g, inputs: [], outputs: [], note: 'Partner data are not available for this dataset.' }), null);
  assert.equal(rv.graphDataLine(null), null);
});

test('quotesOf: the fact\'s own quote, then each support quote with its citation', () => {
  const id = factOf('identify');
  const q = rv.quotesOf(id);
  assert.equal(q.length, 2);
  assert.deepEqual(q.map((x) => [x.main, x.citation]), [[true, id.citation], [false, id.support[0].citation]]);
  assert.equal(q[1].quote, id.support[0].quote);
  assert.deepEqual(rv.quotesOf({ text: 'x' }), []);
  assert.deepEqual(rv.quotesOf(null), []);
});

test('roleLine: capitalised only when it starts with a plain lower-case word', () => {
  assert.equal(rv.roleLine('carries odour signals from one glomerulus to higher brain centres'), 'Carries odour signals from one glomerulus to higher brain centres');
  assert.equal(rv.roleLine('GABAergic input neuron'), 'GABAergic input neuron');
  assert.equal(rv.roleLine('mPFC-projecting cell'), 'mPFC-projecting cell');
  assert.equal(rv.roleLine('γ-lobe Kenyon cell'), 'γ-lobe Kenyon cell');
  assert.equal(rv.roleLine('  '), null);
  assert.equal(rv.roleLine(undefined), null);
});

test('revealTabs: Facts first and always there; How it was made holds typing + imaging; empty tabs hidden', () => {
  assert.deepEqual(rv.revealTabs(fixture.reveal, '/v1/asset/x.json'), ['facts', 'ephys', 'genes', 'graph', 'made', 'papers']);
  const bare = JSON.parse(JSON.stringify(fixture.reveal));
  delete bare.trivia.ephys; delete bare.trivia.same_cell_function; delete bare.trivia.genes; delete bare.trivia.facts;
  assert.deepEqual(rv.revealTabs(bare, null), ['facts', 'made', 'papers']);
  assert.deepEqual(rv.revealTabs(null, null), []);
  assert.equal(rv.TAB_LABELS.made, 'How it was made');
  assert.deepEqual(Object.keys(rv.TAB_LABELS), ['facts', 'ephys', 'genes', 'graph', 'made', 'papers']);
});

const findAll = (node, pred, out = []) => {
  if (node.nodeType === 1 && pred(node)) out.push(node);
  for (const c of node.childNodes || []) findAll(c, pred, out);
  return out;
};
const byClass = (root, cls) => findAll(root, (n) => (n.getAttribute('class') || '').split(' ').includes(cls));

const loader = { json: async (p) => fixture.assets[p], buffer: async () => new ArrayBuffer(0), url: async () => '' };
const ROLE = 'Thick-tufted layer 5 pyramidal neuron projecting outside the telencephalon';

test('Facts tab: role → "Did you know?" in three labelled parts (citation → DOI, quotes behind 44 px toggles, data line) → transmitter → more facts', async () => {
  const root = createContainer();
  render(h(rv.FactsPanel, { reveal: fixture.reveal, round: fixture.round, graphAsset: fixture.state.clues.graph.asset, loader }), root);
  await flush();
  const text = root.textContent;
  assert.ok(text.startsWith(ROLE), 'the role line leads');
  const order = ['Did you know?', 'What it does', factOf('function').text, 'How to tell it apart',
    'vs L5 NP pyramidal neuron, L5 IT pyramidal neuron', factOf('identify').text, 'Who it talks to', factOf('connectivity').text,
    'Here, 38% of its input synapses come from L2/3 IT and 25% from L5 IT; 29% of its output synapses go to L6 IT and 20% to Basket.',
    'From this dataset’s synapses · same-type partners hidden', 'Transmitter', 'More facts', factOf('other').text];
  let at = -1;
  for (const s of order) {
    const i = text.indexOf(s, at + 1);
    assert.ok(i > at, `"${s.slice(0, 40)}" in order`);
    at = i;
  }
  assert.match(text, /Transmitterglutamate · predicted, certainty 0\.97/);
  assert.match(text, /Also calledL5 PT, thick-tufted L5 cell/);
  // the part labels are headings the parts are labelled by
  const labels = findAll(root, (n) => n.localName === 'h3');
  assert.deepEqual(labels.map((n) => n.textContent), ['What it does', 'How to tell it apart', 'Who it talks to']);
  for (const p of byClass(root, 'dyk-part')) assert.ok(labels.some((l) => l.getAttribute('id') === p.getAttribute('aria-labelledby')));
  const facts = [factOf('function'), factOf('identify'), factOf('connectivity'), factOf('other')];
  const cites = byClass(root, 'dyk-cite');
  assert.deepEqual(cites.map((a) => a.textContent), facts.map((f) => `— ${f.citation} ↗`), 'the ↗ never wraps onto a line of its own');
  assert.deepEqual(cites.map((a) => a.getAttribute('href')), facts.map((f) => `https://doi.org/${f.doi}`));
  assert.equal(cites[0].getAttribute('rel'), 'noopener noreferrer');
  // quotes are hidden until asked for; the look-alike tip has two (its own + the support quote)
  assert.equal(byClass(root, 'dyk-quote').length, 0);
  const toggles = byClass(root, 'dyk-toggle');
  assert.deepEqual(toggles.map((b) => b.textContent), ['Show quote ▾', 'Show 2 quotes ▾', 'Show quote ▾', 'Show quote ▾']);
  assert.equal(toggles[1].getAttribute('aria-expanded'), 'false');
  toggles[1].dispatch('click');
  await flush();
  const quotes = byClass(root, 'dyk-quote');
  assert.equal(quotes.length, 2);
  assert.ok(quotes[0].textContent.includes(factOf('identify').quote), 'the verbatim quote, in full');
  assert.ok(quotes[1].textContent.includes(factOf('identify').support[0].quote), 'then the support quote');
  const supportCite = byClass(root, 'dyk-quote-cite');
  assert.equal(supportCite.length, 1);
  assert.equal(supportCite[0].getAttribute('href'), `https://doi.org/${factOf('identify').support[0].doi}`);
  assert.equal(byClass(root, 'dyk-quotes')[0].getAttribute('id'), byClass(root, 'dyk-toggle')[1].getAttribute('aria-controls'));
  assert.equal(byClass(root, 'dyk-toggle')[1].getAttribute('aria-expanded'), 'true');
  assert.equal(byClass(root, 'dyk-toggle')[1].textContent, 'Hide quotes ▴');
  // typing and acquisition live in "How it was made", not here
  assert.ok(!/What to notice|How this cell was typed|Voxel|Segmentation/.test(root.textContent));
  render(null, root);
});

test('Facts tab fallbacks: v1.2 facts keep the old look without partner data; nothing → "More about this cell soon"', async () => {
  const root = createContainer();
  const v12 = clone(fixture.reveal);
  v12.trivia.facts = clone(fixture.trivia_v12_facts);
  render(h(rv.FactsPanel, { reveal: v12, round: fixture.round, loader }), root);
  await flush();
  assert.ok(root.textContent.startsWith(`${ROLE}Did you know?`), 'role line, then the facts card (before the transmitter)');
  assert.ok(root.textContent.indexOf('Did you know?') < root.textContent.indexOf('Transmitter'));
  assert.equal(byClass(root, 'dyk-part').length, 0);
  assert.equal(byClass(root, 'dyk-fact').length, 3);
  // with the graph clue: "What it does" = the role, "Who it talks to" = the data line, the facts "From the literature"
  render(h(rv.FactsPanel, { reveal: v12, round: fixture.round, graphAsset: fixture.state.clues.graph.asset, loader }), root);
  await flush();
  assert.deepEqual(findAll(root, (n) => n.localName === 'h3').map((n) => n.textContent), ['What it does', 'Who it talks to']);
  assert.ok(root.textContent.startsWith('Did you know?What it does'), 'the role is not repeated above the card, which does not claim "from the literature"');
  assert.ok(root.textContent.includes('From the literature'));
  const none = clone(fixture.reveal);
  delete none.trivia.facts;
  render(h(rv.FactsPanel, { reveal: none, loader }), root);
  await flush();
  assert.ok(!root.textContent.includes('Did you know?'));
  assert.ok(root.textContent.startsWith(`${ROLE}More about this cell soon.Transmitter`));
  delete none.type.role; delete none.trivia.neurotransmitter; none.type.synonyms = [];
  render(h(rv.FactsPanel, { reveal: none, loader }), root);
  await flush();
  assert.equal(root.textContent, 'More about this cell soon.');
  render(null, root);
});

test('How it was made: provenance line, how the cell was typed (+ typing facts), imaging method, what to notice, Neuroglancer', async () => {
  const root = createContainer();
  render(h(rv.MadePanel, { reveal: fixture.reveal, state: named }), root);
  await flush();
  const text = root.textContent;
  const order = [fixture.reveal.provenance.line, 'How this cell was typed', fixture.reveal.how_typed.summary,
    'How it was imaged', fixture.reveal.method.name, '✓ +200', 'Voxel', 'What to notice', fixture.reveal.method.what_to_notice,
    'Open in Neuroglancer ↗'];
  let at = -1;
  for (const s of order) {
    const i = text.indexOf(s);
    assert.ok(i > at, `"${s}" in order`);
    at = i;
  }
  for (const f of fixture.reveal.how_typed.facts || []) assert.ok(text.includes(f.text));
  render(null, root);
});

test('voxelRows: acquired and shown voxel for EM format 2 rounds (em-v2-spec §8.7); one Voxel row otherwise', () => {
  // FlyWire / BANC / MICrONS: an 8 nm public copy of 4 nm imaging
  assert.deepEqual(rv.voxelRows({ voxel_nm: [4, 4, 45], shown_voxel_nm: [8, 8, 45] }),
    [{ k: 'Acquired', v: '4 × 4 × 45 nm' }, { k: 'Shown (finest public copy)', v: '8 × 8 × 45 nm' }]);
  // H01: the same pixels at their physical size, not a coarser copy
  assert.deepEqual(rv.voxelRows({ voxel_nm: [4, 4, 33], shown_voxel_nm: [5.55, 4, 33] }),
    [{ k: 'Acquired', v: '4 × 4 × 33 nm' }, { k: 'Shown (true pixel size)', v: '5.55 × 4 × 33 nm' }]);
  // shown as acquired (male CNS, L1, efish) and format 1 rounds
  assert.deepEqual(rv.voxelRows({ voxel_nm: [8, 8, 8], shown_voxel_nm: [8, 8, 8] }), [{ k: 'Voxel', v: '8 × 8 × 8 nm' }]);
  assert.deepEqual(rv.voxelRows({ voxel_nm: [3.8, 3.8, 50] }), [{ k: 'Voxel', v: '3.8 × 3.8 × 50 nm' }]);
});

test('How it was made, EM format 2 round: acquired + shown voxel and the Look again chips', async () => {
  const root = createContainer();
  const reveal = JSON.parse(JSON.stringify(fixture.reveal));
  reveal.method = { ...reveal.method, voxel_nm: [4, 4, 40], shown_voxel_nm: [8, 8, 40],
    look_again: [{ label: 'Sections in XZ', panel: 'xz', frame: 'section', value: 12 }, { label: 'Native pixels', panel: 'xy', frame: 'native', value: 10 }, { label: 'Whole cell', panel: 'xy', frame: 'cell' }] };
  const A = (c, ext = 'webp') => `/v1/asset/${c.repeat(64)}.${ext}`;
  const sections = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
  const em = { format: 2, px_nm: [8, 8], section_nm: 40, em_to_mesh: [[-0.001, 0, 0], [0, -0.001, 0], [0, 0, -0.001]],
    centre_nm: [0, 0], bbox_nm: [-9000, -9000, -9000, 9000, 9000, 9000], outline_source: 'segmentation',
    z: { n: 32, soma_index: 16, z0_nm: 12, missing: [] },
    stack: { size_px: 640, cols: 4, rect_nm: [-2560, -2560, 2560, 2560], chunks: [
      { asset: A('1'), bytes: 1, sections: sections(8, 24) }, { asset: A('2'), bytes: 1, sections: [...sections(0, 8), ...sections(24, 32)] }] },
    levels: [{ asset: A('3'), bytes: 1, px_nm: [8, 8], size_px: [1024, 1024], rect_nm: [-4096, -4096, 4096, 4096], section: 0 }],
    ortho: { asset: A('4'), bytes: 1, width_px: 1024, rows: 204, missing_rows: [], xz: { y_nm: 0, x0_nm: -4096, x1_nm: 4096 }, yz: { x_nm: 0, y0_nm: -4096, y1_nm: 4096 } },
    ortho_ctx: { asset: A('5'), bytes: 1, size_px: [8, 8], levels: [] }, outlines: { asset: A('6', 'json'), bytes: 1 } };
  const opened = [];
  render(h(rv.MadePanel, { reveal, state: { ...named, em: { atlas: '/a', xz: '/b', mask: '/c', field_um: 8.192, n_slices: 32, v2: em } }, onFullView: (o) => opened.push(o) }), root);
  await flush();
  const text = root.textContent;
  assert.ok(text.includes('Acquired4 × 4 × 40 nm'), text);
  assert.ok(text.includes('Shown (finest public copy)8 × 8 × 40 nm'));
  assert.ok(!text.includes('Voxel'));
  assert.ok(text.includes('Look again') && text.includes('⤢ Sections in XZ') && text.includes('⤢ Whole cell'));
  render(null, root);
});

test('niceTicks / tracePath / fmtNum / safeUrl', () => {
  const t = rv.niceTicks(-82, 38, 3);
  assert.ok(t.lo <= -82 && t.hi >= 38);
  assert.deepEqual(t.ticks, [-100, -50, 0, 50]);
  const y = Array.from({ length: 5000 }, (_, i) => (i === 2500 ? 40 : -70));
  const d = rv.tracePath(y, { dt: 0.2, x: (v) => v, y: (v) => -v, widthPx: 100 });
  assert.ok(d.startsWith('M') && d.includes('-40.0'), 'the spike survives min/max decimation');
  assert.equal(rv.tracePath([1], { dt: 1, x: (v) => v, y: (v) => v }), '');
  assert.equal(rv.fmtNum(-0.04567), '−0.0457');
  assert.equal(rv.fmtNum(1234.5), '1,235');
  assert.equal(rv.safeUrl('javascript:alert(1)'), null);
  assert.equal(rv.safeUrl('https://ngl.example/#!x'), 'https://ngl.example/#!x');
});

test('summary: personal best needs an earlier scoring day; outcome counts', () => {
  assert.equal(sm.isPersonalBest(4300, 2100), true);
  assert.equal(sm.isPersonalBest(2100, 2100), false);
  assert.equal(sm.isPersonalBest(2100, 0), false, 'a first-ever scoring day is not a best');
  assert.equal(sm.isPersonalBest(2100, null), false);
  assert.equal(sm.outcomeCounts([named, met, missed, named, null]), '2 named · 1 met · 1 missed');
});

test('share card mirrors the scoring.md strip', () => {
  assert.deepEqual(sh.stripParts(met), { used: 1, wrong: 1, right: true, method: '·' });
  assert.deepEqual(sh.stripParts(missed), { used: 0, wrong: 3, right: false, method: '·' });
  assert.deepEqual(sh.stripParts(named), { used: 0, wrong: 0, right: true, method: 'M' });
  assert.equal(sh.doneRounds(SCORING_EXAMPLE_PROGRESS).length, 5);
  assert.equal(sh.shareCaption(SCORING_EXAMPLE_PROGRESS, 12), '2 named · 12-day streak');
  assert.equal(sh.shareCaption([met], 0), '0 named');
});

test('report: note cleaned for the Worker; error copy', () => {
  assert.equal(rp.cleanNote('  line one\nline two\ttab\u0007  '), 'line one line two tab');
  assert.equal(rp.cleanNote('   '), null);
  assert.equal(Array.from(rp.cleanNote('é'.repeat(600))).length, rp.NOTE_MAX);
  assert.deepEqual(rp.REPORT_REASONS.map((r) => r.id), ['wrong_label', 'bad_mesh', 'em_problem', 'fact_wrong', 'other']);
  assert.match(rp.reportErrorText(new ApiError(0, 'network', 'x')), /connection/);
  assert.match(rp.reportErrorText(new ApiError(403, 'not_done', 'x')), /Finish this round/);
});
