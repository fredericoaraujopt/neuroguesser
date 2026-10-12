// v0.6.0 feedback batch: the Library's neuron profile (js/screens/profile.js, note QwW2), "In short" leading the
// trivia card (reveal.js triviaParts / FactsPanel, note qshG, contracts v1.4 quoted_fact category `summary`) and the
// type round's mesh scale bar steps (note BMDG).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContainer, flush } from './_dom.js';

const { h, render } = await import('preact');
const pf = await import('../js/screens/profile.js');
const rv = await import('../js/screens/reveal.js');
const router = await import('../js/router.js');
const { MESH_STEPS, niceScale } = await import('../js/viewer/scalebar.js');
const fullview = await import('../js/screens/fullview.js');
const fixture = JSON.parse(readFileSync(new URL('../dev/reveal.fixture.json', import.meta.url), 'utf8'));

const SUMMARY = {
  text: 'Thick-tufted layer 5 cells send their axons out of the cortex, carrying its output to the brainstem and spinal cord.',
  doi: '10.1000/summary', citation: 'Summary et al. 2020, Journal', quote: 'A verbatim sentence.',
  source_url: 'https://example.org/summary', category: 'summary',
  checks: { quote_match: true, numbers_in_quote: true, doi_resolves: true, no_superlatives: true },
};
const withSummary = () => {
  const r = JSON.parse(JSON.stringify(fixture.reveal));
  r.trivia.facts = [SUMMARY, ...r.trivia.facts];
  return r;
};
const OPTION_LABELS = fixture.round.options.map((o) => o.label);
const GRAPH = fixture.assets[fixture.state.clues.graph.asset];
const loader = { json: async (p) => fixture.assets[p], buffer: async () => new ArrayBuffer(0), url: async () => '' };

test('triviaParts: "In short" leads the card when the reveal has a summary fact, and is not repeated under it', () => {
  const tp = rv.triviaParts(withSummary(), { optionLabels: OPTION_LABELS, graph: GRAPH });
  assert.deepEqual(tp.parts.map((p) => [p.id, p.label]),
    [['short', 'In short'], ['does', 'What it does'], ['apart', 'How to tell it apart'], ['talks', 'Who it talks to']]);
  assert.equal(tp.parts[0].fact.text, SUMMARY.text);
  assert.ok(!tp.extra.some((f) => f.category === 'summary'), 'the summary is not an extra');
  assert.equal(tp.literature, true);
  // without one: exactly the v1.3 parts
  assert.deepEqual(rv.triviaParts(fixture.reveal, { optionLabels: OPTION_LABELS, graph: GRAPH }).parts.map((p) => p.id),
    ['does', 'apart', 'talks']);
  // a summary alone makes a literature card
  const only = JSON.parse(JSON.stringify(fixture.reveal));
  only.trivia.facts = [SUMMARY];
  const tp2 = rv.triviaParts(only, { graph: null });
  assert.deepEqual([tp2.card, tp2.literature, tp2.parts[0].id], [true, true, 'short']);
});

test('Facts tab: "In short" is the first labelled part, with its citation and quote toggle', async () => {
  const root = createContainer();
  render(h(rv.FactsPanel, { reveal: withSummary(), round: fixture.round, graphAsset: fixture.state.clues.graph.asset, loader }), root);
  await flush();
  const text = root.textContent;
  const at = (s) => text.indexOf(s);
  assert.ok(at('Did you know?') >= 0 && at('Did you know?') < at('In short'));
  assert.ok(at('In short') < at(SUMMARY.text) && at(SUMMARY.text) < at('What it does'));
  assert.ok(text.includes('— Summary et al. 2020, Journal'));
});

test('profileTarget / profileError / reviewLine', () => {
  assert.deepEqual(pf.profileTarget({ date: '2026-10-05', n: '2' }), { date: '2026-10-05', n: 2 });
  for (const bad of [{}, { date: '2026-10-5', n: '2' }, { date: '2026-10-05', n: '6' }, { date: '2026-10-05', n: '0' }, { date: 'x', n: 'y' }]) {
    assert.equal(pf.profileTarget(bad), null, JSON.stringify(bad));
  }
  assert.equal(pf.profileError(null), null);
  assert.match(pf.profileError({ code: 'not_done', status: 403 }).text, /Finish this round/);
  assert.match(pf.profileError({ code: 'not_found', status: 404 }).title, /No such cell/);
  assert.equal(pf.profileError({ code: 'network', status: 0 }), null);      // the reveal's own retry card
  const e = (review) => ({ review });
  assert.equal(pf.reviewLine(e({ due: true, next_review_at: '2026-10-09' }), '2026-10-09'), '↻ Due for review');
  assert.equal(pf.reviewLine(e({ due: false, next_review_at: '2026-10-12' }), '2026-10-09'), '↻ Review in 3 days');
  assert.equal(pf.reviewLine(e({ due: false, next_review_at: '2026-10-10' }), '2026-10-09'), '↻ Review in 1 day');
  assert.equal(pf.reviewLine(e(null), '2026-10-09'), null);
  assert.equal(pf.reviewLine(null), null);
});

test('route #/library/cell/<date>/<n> opens the profile on the Library tab', async () => {
  const r = router.routes.find((x) => x.name === 'library-cell');
  assert.ok(r, 'route registered');
  assert.equal(r.tab, 'library');
  assert.equal(r.pattern, '/library/cell/:date/:n');
  const mod = await r.load();
  assert.equal(typeof mod.default, 'function');
});

test('mesh scale bar steps: the type round and the full view agree; a 1 mm context still fits 120 px', () => {
  assert.deepEqual(MESH_STEPS, fullview.SCALE_3D);
  assert.deepEqual(niceScale(120 / 3000, 120, MESH_STEPS), { um: 2000, px: 80 });   // ~3 mm across 120 px
  assert.deepEqual(niceScale(2, 120, MESH_STEPS), { um: 50, px: 100 });
});
