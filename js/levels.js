// XP and levels (ARCHITECTURE.md §3.4 item 2; contracts api.md GET /v1/me `xp_total`, v1.3).
//
// XP is the player's all-time points: me.xp_total = Σ of every round score, from the Worker. Levels are computed here,
// in the app, on a gentle power curve. Everyone starts at level 1 with 0 XP, and level n + 1 needs
//
//     xpForLevel(n + 1) = 1,500 · n^1.4 cumulative XP, rounded to the nearest 10
//
//   level      2      3      4       5       6       7       8       10      20       50       100
//   XP     1,500  3,960  6,980  10,450  14,280  18,430  22,870  32,510  92,540  348,630  933,210
//
// A good day is 3,000–4,500 points (6,000 at most). At about 4,000 a day a new player levels up roughly once a day in
// the first week (level 7 on day 5), every other day after a month (level ~23 on day 30), and every 2–3 days after
// 100 days (level ~55); the gap to the next level never shrinks. Pure (no I/O); tests/levels.test.js.

export const LEVEL_BASE = 1500;   // XP for level 2
export const LEVEL_EXP = 1.4;     // curve exponent: 1 would be linear (a level every 1,500 XP), 2 a steep quadratic
export const MAX_LEVEL = 999;     // a ceiling for the arithmetic only (23.7 million XP, over 15 years of daily play)

/** Cumulative XP needed to reach level n (xpForLevel(1) = 0). n is clamped to 1 … MAX_LEVEL. */
export function xpForLevel(n) {
  const k = Math.min(MAX_LEVEL, Math.max(1, Math.floor(Number(n) || 1)));
  if (k === 1) return 0;
  return Math.round((LEVEL_BASE * (k - 1) ** LEVEL_EXP) / 10) * 10;
}

const cleanXp = (xp) => (Number.isFinite(Number(xp)) && Number(xp) > 0 ? Math.floor(Number(xp)) : 0);

/** The level reached with `xp` points (≥ 1; anything that is not a positive number counts as 0 XP). */
export function levelOf(xp) {
  const x = cleanXp(xp);
  let n = Math.min(MAX_LEVEL, Math.max(1, Math.floor((x / LEVEL_BASE) ** (1 / LEVEL_EXP)) + 1)); // estimate, then fix
  while (n < MAX_LEVEL && xpForLevel(n + 1) <= x) n += 1;
  while (n > 1 && xpForLevel(n) > x) n -= 1;
  return n;
}

/**
 * Where `xp` sits on the curve:
 *   { xp, level, floor: XP where this level starts, next: XP where the next one starts (null at MAX_LEVEL),
 *     into: XP earned inside this level, span: next − floor, frac: 0 … 1 through this level, toNext: XP still needed }
 */
export function levelInfo(xp) {
  const x = cleanXp(xp);
  const level = levelOf(x);
  const floor = xpForLevel(level);
  if (level >= MAX_LEVEL) return { xp: x, level, floor, next: null, into: x - floor, span: 0, frac: 1, toNext: 0 };
  const next = xpForLevel(level + 1);
  const span = next - floor;
  return { xp: x, level, floor, next, into: x - floor, span, frac: Math.max(0, Math.min(1, (x - floor) / span)), toNext: next - x };
}

/** The levels reached on the way from `fromXp` to `toXp` ([] when no level is crossed, e.g. [4, 5] for two). */
export function levelsCrossed(fromXp, toXp) {
  const a = levelOf(fromXp);
  const b = levelOf(toXp);
  const out = [];
  for (let n = a + 1; n <= b; n += 1) out.push(n);
  return out;
}
