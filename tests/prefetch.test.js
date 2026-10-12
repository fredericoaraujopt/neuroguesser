// W3 perf follow-up: the round screen warmed the NEXT round's mesh at the same time as this round's EM (round.js),
// which delayed the EM by ≈ 2 s on Fast 3G. Only Today's reveal warms the next mesh now (today.js → prefetchRound,
// low priority, 1.5 s into the reveal). Source checks: the screens are not renderable under node (WebGL viewers).
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { appRoot } from './_importmap.js';

const round = readFileSync(path.join(appRoot, 'js/screens/round.js'), 'utf8');
const today = readFileSync(path.join(appRoot, 'js/screens/today.js'), 'utf8');

test('round.js: no next-round reads; the EM warm-up fetches only the EM atlas, mask and XZ', () => {
  const roundReads = [...round.matchAll(/today\.rounds\[([^\]]+)\]/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(roundReads)].filter((i) => !/^\w+ ?- ?1$/.test(i)), [], 'only the current round (index n - 1)');
  assert.doesNotMatch(round, /\bnextRound\b|prefetchRound\(|prefetchAsset\(/);
  const warm = /useEffect\(\(\) => \{\n\s+if \(!em\) return;([\s\S]*?)\}, \[em && em\.atlas\]\);/.exec(round);
  assert.ok(warm, 'the EM warm-up effect');
  const fetched = [...warm[1].matchAll(/api\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
  assert.deepEqual(fetched, ['assetBlob(em.atlas)', 'assetBlob(em.mask)', 'assetBlob(em.xz)']);
});

test('today.js: the next round\'s mesh is warmed on the reveal of this one (low priority, after a head start)', () => {
  assert.match(today, /import \{[^}]*\bprefetchRound\b[^}]*\} from '\.\.\/game\.js'/);
  assert.match(today, /view\.kind === 'reveal'[\s\S]{0,200}\? view\.index \+ 1 : null/);
  assert.match(today, /setTimeout\(\(\) => \{ prefetchRound\(warmNext\); \}, 1500\)/);
});
