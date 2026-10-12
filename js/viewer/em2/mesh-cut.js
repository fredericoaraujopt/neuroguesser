// EM format 2: the public mesh cut by a plane (em-v2-spec.md §8.3 "Mesh cut"), pure (tests/em2-model.test.js).
// The cut is drawn dashed beyond the vector outlines (beyond R_2 in XY, beyond the native ortho in XZ/YZ): it is an
// approximation of the cell's cross-section (the public mesh is decimated and quantised to 50 nm).
// Each crossing edge yields one point, shared by the two triangles of that edge, so the segments chain into
// polylines (a dash pattern runs along a whole contour instead of restarting on every 100 nm segment).

/** Plane coordinates (h, v) of an EM-local point for a cut along `axis` (XY: z, XZ: y, YZ: x). */
const AXES = {
  z: { k: 2, h: 0, v: 1 },   // XY panel: (x, y)
  y: { k: 1, h: 0, v: 2 },   // XZ panel: (x, z)
  x: { k: 0, h: 2, v: 1 },   // YZ panel: (z, y)
};

/**
 * cutMesh(positions, index, axis, value) → [{ pts: number[] (h0, v0, h1, v1 …), closed }]
 * positions: EM-local nm (x, y, z per vertex); index: triangle indices (or null for a non-indexed soup).
 */
export function cutMesh(positions, index, axis, value) {
  const ax = AXES[axis];
  if (!ax || !positions) return [];
  const nTri = index ? Math.floor(index.length / 3) : Math.floor(positions.length / 9);
  const point = new Map();   // edge key → [h, v]
  const ends = new Map();    // edge key → [segment ids]
  const segs = [];           // [keyA, keyB]
  const side = (i) => { const d = positions[i * 3 + ax.k] - value; return d === 0 ? 1e-9 : d; };
  const edge = (i, j, di, dj) => {
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    const key = a * 4194304 + b;
    if (!point.has(key)) {
      const t = di / (di - dj);
      const hi = positions[i * 3 + ax.h]; const vi = positions[i * 3 + ax.v];
      point.set(key, [hi + (positions[j * 3 + ax.h] - hi) * t, vi + (positions[j * 3 + ax.v] - vi) * t]);
    }
    return key;
  };
  for (let t = 0; t < nTri; t++) {
    const i0 = index ? index[t * 3] : t * 3;
    const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
    const i2 = index ? index[t * 3 + 2] : t * 3 + 2;
    const d0 = side(i0); const d1 = side(i1); const d2 = side(i2);
    const s0 = d0 > 0; const s1 = d1 > 0; const s2 = d2 > 0;
    if (s0 === s1 && s1 === s2) continue;
    const keys = [];
    if (s0 !== s1) keys.push(edge(i0, i1, d0, d1));
    if (s1 !== s2) keys.push(edge(i1, i2, d1, d2));
    if (s2 !== s0) keys.push(edge(i2, i0, d2, d0));
    if (keys.length !== 2 || keys[0] === keys[1]) continue;
    const id = segs.length;
    segs.push(keys);
    for (const k of keys) { const l = ends.get(k); if (l) l.push(id); else ends.set(k, [id]); }
  }
  // chain
  const used = new Uint8Array(segs.length);
  const out = [];
  const next = (key, from) => {
    const l = ends.get(key);
    if (!l) return -1;
    for (const s of l) if (s !== from && !used[s]) return s;
    return -1;
  };
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const chain = [segs[s0][0], segs[s0][1]];
    // forward
    let cur = s0;
    let key = segs[s0][1];
    for (;;) {
      const n = next(key, cur);
      if (n < 0) break;
      used[n] = 1;
      key = segs[n][0] === key ? segs[n][1] : segs[n][0];
      chain.push(key);
      cur = n;
    }
    // backward
    cur = s0;
    key = segs[s0][0];
    for (;;) {
      const n = next(key, cur);
      if (n < 0) break;
      used[n] = 1;
      key = segs[n][0] === key ? segs[n][1] : segs[n][0];
      chain.unshift(key);
      cur = n;
    }
    const closed = chain.length > 2 && chain[0] === chain[chain.length - 1];
    if (closed) chain.pop();
    const pts = [];
    for (const k of chain) { const p = point.get(k); pts.push(p[0], p[1]); }
    out.push({ pts, closed });
  }
  return out;
}

/** Total vertex count of a cut (tests, stats). */
export const cutSize = (lines) => lines.reduce((n, l) => n + l.pts.length / 2, 0);

/**
 * EM-local positions of the public mesh: v_local_nm = em_to_mesh⁻¹ · v_mesh_µm, for every vertex of a position
 * attribute array (Float32Array, xyz). inv: the 3 × 3 inverse (model.js mat3Inverse).
 */
export function meshToLocal(meshPositions, inv) {
  const out = new Float32Array(meshPositions.length);
  for (let i = 0; i < meshPositions.length; i += 3) {
    const x = meshPositions[i]; const y = meshPositions[i + 1]; const z = meshPositions[i + 2];
    out[i] = inv[0][0] * x + inv[0][1] * y + inv[0][2] * z;
    out[i + 1] = inv[1][0] * x + inv[1][1] * y + inv[1][2] * z;
    out[i + 2] = inv[2][0] * x + inv[2][1] * y + inv[2][2] * z;
  }
  return out;
}

/** Bounds [x0, y0, z0, x1, y1, z1] of a position array. */
export function boundsOf(pos) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < b[k]) b[k] = v;
      if (v > b[k + 3]) b[k + 3] = v;
    }
  }
  return b;
}
