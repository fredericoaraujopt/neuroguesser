// v0.6.1 feedback batch (phone notes 654x… and 1ntJ…): the vibe-coded notice under the trivia and in Settings → About,
// the citation line, and the reveal decluttered (no role line above "In short", no outcome line, short legend).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContainer, flush } from './_dom.js';

const { h, render } = await import('preact');
const rv = await import('../js/screens/reveal.js');
const st = await import('../js/screens/settings.js');
const fixture = JSON.parse(readFileSync(new URL('../dev/reveal.fixture.json', import.meta.url), 'utf8'));
const loader = { json: async (p) => fixture.assets[p], buffer: async () => new ArrayBuffer(0), url: async () => '' };
const SUMMARY = {
  text: 'A short plain summary.', doi: '10.1000/s', citation: 'Summary et al. 2020, Journal', quote: 'q',
  source_url: 'https://example.org/s', category: 'summary',
  checks: { quote_match: true, numbers_in_quote: true, doi_resolves: true, no_superlatives: true },
};

test('the AI notice sits under the trivia whenever there is literature, and says to check the source', async () => {
  assert.match(rv.AI_NOTICE, /^Vibe coded with AI help/);
  assert.match(rv.AI_NOTICE, /Check the source/);
  const root = createContainer();
  render(h(rv.FactsPanel, { reveal: fixture.reveal, round: fixture.round, graphAsset: fixture.state.clues.graph.asset, loader }), root);
  await flush();
  const text = root.textContent;
  assert.ok(text.includes(rv.AI_NOTICE));
  assert.ok(text.indexOf(rv.AI_NOTICE) > text.indexOf('Did you know?'), 'under the card');
  assert.ok(!text.includes('from the literature'), 'the caption is gone (every fact cites its paper)');
  // nothing from the literature: no notice
  const bare = JSON.parse(JSON.stringify(fixture.reveal));
  bare.trivia.facts = [];
  const root2 = createContainer();
  render(h(rv.FactsPanel, { reveal: bare, round: fixture.round, graphAsset: null, loader }), root2);
  await flush();
  assert.ok(!root2.textContent.includes(rv.AI_NOTICE));
});

test('with "In short" the role line is not repeated above the card', () => {
  const withSummary = JSON.parse(JSON.stringify(fixture.reveal));
  withSummary.trivia.facts = [SUMMARY, ...withSummary.trivia.facts];
  assert.equal(rv.triviaParts(withSummary, {}).roleLine, null);
  const noFn = JSON.parse(JSON.stringify(fixture.reveal));
  noFn.trivia.facts = noFn.trivia.facts.filter((f) => f.category !== 'function');
  assert.equal(rv.triviaParts(noFn, {}).roleLine, null, 'the role is the "What it does" item instead');
});

test('citeLine: the app address only once deployed (https)', () => {
  assert.equal(st.citeLine('http://localhost:5173'), 'Araujo, F. (2026). NeuroGuesser: a daily neuron identification game.');
  assert.equal(st.citeLine('https://neuroguesser.example.org'),
    'Araujo, F. (2026). NeuroGuesser: a daily neuron identification game. https://neuroguesser.example.org/');
  assert.equal(st.citeLine(''), 'Araujo, F. (2026). NeuroGuesser: a daily neuron identification game.');
});
