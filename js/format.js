// Formatting helpers (ARCHITECTURE.md §4.6) and the spoiler-free strip/share text (contracts/scoring.md).
// Pure module: no DOM, no imports (unit-tested in tests/format.test.js).

export const GLYPH = Object.freeze({
  clueUsed: '■',   // ■
  clueUnused: '□', // □
  wrong: '✕',      // ✕
  right: '✓',      // ✓
  methodRight: 'M',
  methodWrong: '·', // ·
  minus: '−',      // −
  dot: '·',
});

/** 1200 → "1,200" (locale-independent, so share text is identical everywhere). */
export function fmtPts(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return v < 0 ? GLYPH.minus + s : s;
}

/** −100 / +200 with a true minus sign. */
export function fmtSigned(n) {
  const v = Math.round(Number(n) || 0);
  if (v === 0) return '0';
  return (v > 0 ? '+' : GLYPH.minus) + fmtPts(Math.abs(v));
}

/** "#2" / "#1,284" */
export function fmtRank(n) { return `#${fmtPts(n)}`; }

/** Same rule as the Worker: upper-cased first letters of the first two words (one letter for one word). */
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => Array.from(w)[0].toUpperCase()).join('');
}

/** ms → "HH:MM:SS" (clamped at 0; hours not wrapped). */
export function countdown(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

export function plural(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

/** Identical to pool.yaml methods.<id>.name (and round_reveal.method.name). */
export const METHOD_NAMES = Object.freeze({
  sstem: 'Serial-section TEM',
  fib_sem: 'FIB-SEM',
  sssem: 'Serial-section SEM',
  atum_msem: 'ATUM-multiSEM',
  ibeam_msem: 'IBEAM-mSEM',
  sbem: 'Serial block-face SEM',
});

/** One plain sentence each, no numbers (shown under the method chips; nothing that names a dataset). */
export const METHOD_BLURBS = Object.freeze({
  sstem: 'Thin sections are cut on an ultramicrotome and each one is imaged by transmission EM.',
  fib_sem: 'A focused ion beam mills the block face away layer by layer, and an SEM images every new surface.',
  sssem: 'Sections are cut and collected first, then each one is imaged by a single-beam scanning EM.',
  atum_msem: 'Sections are collected on tape automatically and imaged by a scanning EM with many beams at once.',
  ibeam_msem: 'Thick slabs are thinned by ion-beam milling and imaged by a multibeam scanning EM.',
  sbem: 'A diamond knife inside the SEM shaves the block, and the freshly exposed face is imaged each time.',
});

export const methodName = (id) => METHOD_NAMES[id] || String(id || '');

/** "10 µm", "1 mm" for scale bars. */
export function fmtUm(um) {
  if (um >= 1000 && um % 1000 === 0) return `${um / 1000} mm`;
  return `${um} µm`;
}

// ---- strip / share text (scoring.md) ----

/**
 * Spoiler-free strip of one round_state, without the round index:
 *   "■□ ✕✓ M"  clue boxes (used first), one ✕ per wrong guess then ✓ (three ✕ and no ✓ = cap),
 *              M = method right, · = method wrong or skipped (only once the round is done).
 * A round still in the type stage shows the boxes and the ✕s so far. null → "".
 */
export function strip(state) {
  if (!state) return '';
  const used = Math.min(2, (state.clues_opened || []).length);
  const boxes = GLYPH.clueUsed.repeat(used) + GLYPH.clueUnused.repeat(2 - used);
  const wrong = (state.wrong || []).length;
  let guesses = GLYPH.wrong.repeat(wrong);
  if (state.stage !== 'type' && state.type_result === 'correct') guesses += GLYPH.right;
  const parts = [boxes];
  if (guesses) parts.push(guesses);
  if (state.stage === 'done') parts.push(state.method_correct ? GLYPH.methodRight : GLYPH.methodWrong);
  return parts.join(' ');
}

/** Σ score of done rounds. */
export function doneTotal(progress) {
  return (progress || []).reduce((sum, st) => sum + (st && st.stage === 'done' ? st.score : 0), 0);
}

/**
 * Share text, exactly the scoring.md format:
 *   NeuroGuesser #214 · 4,200
 *   1 □□ ✓ M
 *   …
 *   12-day streak
 * Only done rounds get a line (like the rank strips); the streak line is omitted when streak is 0.
 */
export function shareText(dayNumber, progress, streak) {
  const lines = [`NeuroGuesser #${dayNumber} ${GLYPH.dot} ${fmtPts(doneTotal(progress))}`];
  (progress || []).forEach((st, i) => {
    if (st && st.stage === 'done') lines.push(`${st.round_index || i + 1} ${strip(st)}`);
  });
  if (streak > 0) lines.push(`${streak}-day streak`);
  return lines.join('\n');
}
