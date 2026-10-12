// Scale bars in µm, rounded to 1/2/5/10… (Charcoal: "scale bars in units, never a magnification").
// Pure module (tests/scalebar.test.js).

export const DEFAULT_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
/** µm steps of the 3D views' scale bars (the type round's mesh, the full view): a cell up to a whole-brain context. */
export const MESH_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

/**
 * niceScale(pxPerUm, maxPx = 120, steps) → { um, px }
 * The largest step whose length (step × pxPerUm) fits in maxPx; when even the smallest step is too long,
 * the smallest step (px may then exceed maxPx). pxPerUm ≤ 0 or not finite → { um: steps[0], px: 0 }.
 */
export function niceScale(pxPerUm, maxPx = 120, steps = DEFAULT_STEPS) {
  const list = [...(steps && steps.length ? steps : DEFAULT_STEPS)].sort((a, b) => a - b);
  if (!(pxPerUm > 0) || !Number.isFinite(pxPerUm)) return { um: list[0], px: 0 };
  let um = list[0];
  for (const s of list) if (s * pxPerUm <= maxPx) um = s;
  return { um, px: um * pxPerUm };
}

/** px per µm of an orthographic camera drawn into a viewport `heightPx` tall. */
export function orthoPxPerUm(camera, heightPx) {
  if (!camera || !(heightPx > 0)) return 0;
  const span = (camera.top - camera.bottom) / (camera.zoom || 1);
  return span > 0 ? heightPx / span : 0;
}
