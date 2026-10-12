// Contract-shaped fixtures for the unit tests (round_public / round_state, contracts v1.1).

const ID = (n) => `r7Qm2xK9pLs4Tz8${'ABCDE'[n - 1]}`;

export function roundState(over = {}) {
  const st = {
    round_id: ID(over.round_index || 1), round_index: 1, stage: 'type', score: 1000,
    wrong: [], eliminated: [], clues_opened: [], clues: {}, ...over,
  };
  if (st.stage !== 'type') {
    st.type_score = over.type_score ?? (st.type_result === 'exhausted' ? 0 : 1000 - 100 * (st.wrong.length + st.clues_opened.length));
    st.correct_option = over.correct_option || 'd';
    st.em = over.em || {
      atlas: `/v1/asset/${'a'.repeat(64)}.webp`, xz: `/v1/asset/${'b'.repeat(64)}.webp`,
      mask: `/v1/asset/${'c'.repeat(64)}.png`, field_um: 8.192, n_slices: 32,
    };
    st.outcome = over.outcome || (st.type_result === 'exhausted' ? 'missed' : st.wrong.length + st.clues_opened.length === 0 ? 'named' : 'met');
  }
  if (st.stage === 'done') {
    st.method_pick = over.method_pick !== undefined ? over.method_pick : 'sstem';
    st.method_correct = !!over.method_correct;
    st.method_answer = over.method_answer || 'sstem';
    st.method_score = st.method_correct ? 200 : 0;
    st.score = over.score ?? st.type_score + st.method_score;
  } else if (st.stage === 'method') {
    st.score = over.score ?? st.type_score;
  }
  return st;
}

export function roundPublic(index = 1, over = {}) {
  return {
    schema_version: '1.0', round_id: ID(index), date: '2026-10-03', day_number: 33, round_index: index,
    options: [
      { id: 'a', label: 'Olfactory projection neuron', sub: 'Drosophila · antennal lobe · relay' },
      { id: 'b', label: 'L3 pyramidal', sub: 'Human · temporal cortex · intracortical' },
      { id: 'c', label: 'Mushroom body output neuron', sub: 'Drosophila · mushroom body · output' },
      { id: 'd', label: 'Kenyon cell', sub: 'Drosophila · mushroom body · memory' },
      { id: 'e', label: 'Lateral horn neuron', sub: 'Drosophila · lateral horn · innate odour' },
      { id: 'f', label: 'L2/3 IT pyramidal', sub: 'Mouse · V1 · intratelencephalic' },
    ],
    mesh: { asset: `/v1/asset/${'d'.repeat(64)}.glb`, units: 'um', bbox_um: [-40, -35, -20, 60, 45, 30], n_triangles: 32000, colour_mode: 'single' },
    paid_clues: [{ kind: 'context', cost: 100 }, { kind: 'graph', cost: 100 }],
    method_options: ['sstem', 'fib_sem', 'atum_msem', 'sbem'],
    ...over,
  };
}

// scoring.md "Share text" example: 1,200 + 1,000 + 800 + 200 + 1,000 = 4,200
export const SCORING_EXAMPLE_PROGRESS = [
  roundState({ round_index: 1, stage: 'done', type_result: 'correct', method_correct: true }),
  roundState({ round_index: 2, stage: 'done', type_result: 'correct', wrong: ['b'], clues_opened: ['context'], eliminated: ['f'], method_correct: true }),
  roundState({ round_index: 3, stage: 'done', type_result: 'correct', wrong: ['a', 'c'], method_correct: false, method_pick: 'fib_sem' }),
  roundState({ round_index: 4, stage: 'done', type_result: 'exhausted', wrong: ['a', 'c', 'e'], clues_opened: ['context', 'graph'], eliminated: ['b', 'f'], method_correct: true }),
  roundState({ round_index: 5, stage: 'done', type_result: 'correct', method_correct: false, method_pick: null }),
];

export const SCORING_EXAMPLE = [
  'NeuroGuesser #214 · 4,200',
  '1 □□ ✓ M',
  '2 ■□ ✕✓ M',
  '3 □□ ✕✕✓ ·',
  '4 ■■ ✕✕✕ M',
  '5 □□ ✓ ·',
  '12-day streak',
].join('\n');

export function todaySlice(over = {}) {
  return {
    status: 'ready', date: '2026-10-03', todayDate: '2026-10-03', dayNumber: 33,
    now: '2026-10-03T12:00:00Z', nextRolloverAt: '2026-10-04T00:00:00Z', grace: null, graceActive: false,
    rounds: [1, 2, 3, 4, 5].map((i) => roundPublic(i)),
    progress: [null, null, null, null, null], total: 0, roundsDone: 0, streak: 0,
    revealAck: [false, false, false, false, false], error: null, fromCache: false, loadedAt: 0,
    ...over,
  };
}
