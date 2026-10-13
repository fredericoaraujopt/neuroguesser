// Web fonts. Since v0.7.0 (App Design Guide, 12 Oct 2026) the app loads WOFF2 subsets of Figtree (UI text) and Geist
// Mono (numerals) built by fonts/build-app-fonts.py from the google/fonts variable TTFs (before: Liberation subsets,
// fonts/build-subsets.py, no longer loaded). Checks the @font-face rules, the preloads and the service-worker precache
// agree; that each subset is small, covers Latin-1 and Latin Extended-A, and keeps every glyph the app's own copy uses
// that its source font has; and that the copyright and licence records are kept.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import path from 'node:path';
import { appRoot } from './_importmap.js';

const read = (p) => readFileSync(path.join(appRoot, p), 'utf8');
const tokens = read('css/tokens.css');
const indexHtml = read('index.html');
const sw = read('sw.js');

const faces = [...tokens.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
  family: /font-family:\s*"([^"]+)"/.exec(body)[1],
  src: /src:\s*url\("\.\.\/(fonts\/[^"]+)"\)\s*format\("([^"]+)"\)/.exec(body).slice(1),
  weight: /font-weight:\s*(\d+(?: \d+)?)/.exec(body)[1],
  style: /font-style:\s*(\w+)/.exec(body)[1],
  display: (/font-display:\s*(\w+)/.exec(body) || [])[1],
}));
const preloads = [...indexHtml.matchAll(/<link rel="preload"[^>]*>/g)].map(([tag]) => tag).filter((t) => /as="font"/.test(t));
const shell = /const SHELL = \[([\s\S]*?)\];/.exec(sw)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));

// --------------------------------------------------------------------------------------------- font file parsing

/** Code points mapped by a cmap table (format 4 or 12, Windows Unicode subtable). */
function cmapCodepoints(buf, off) {
  const n = buf.readUInt16BE(off + 2);
  let best = null;
  for (let i = 0; i < n; i++) {
    const r = off + 4 + i * 8;
    const [pid, eid, sub] = [buf.readUInt16BE(r), buf.readUInt16BE(r + 2), buf.readUInt32BE(r + 4)];
    if (pid === 3 && eid === 10) best = off + sub;
    else if (pid === 3 && eid === 1 && best === null) best = off + sub;
  }
  const cps = new Set();
  const fmt = buf.readUInt16BE(best);
  if (fmt === 12) {
    const groups = buf.readUInt32BE(best + 12);
    for (let g = 0; g < groups; g++) {
      const p = best + 16 + g * 12;
      for (let c = buf.readUInt32BE(p); c <= buf.readUInt32BE(p + 4); c++) cps.add(c);
    }
    return cps;
  }
  assert.equal(fmt, 4, 'cmap subtable format');
  const segX2 = buf.readUInt16BE(best + 6);
  const ends = best + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  for (let s = 0; s < segX2; s += 2) {
    const [end, start, delta, ro] = [buf.readUInt16BE(ends + s), buf.readUInt16BE(starts + s), buf.readInt16BE(deltas + s), buf.readUInt16BE(ranges + s)];
    for (let c = start; c <= end && c !== 0xffff; c++) {
      const gid = ro === 0 ? (c + delta) & 0xffff : (() => {
        const g = buf.readUInt16BE(ranges + s + ro + (c - start) * 2);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      })();
      if (gid !== 0) cps.add(c);
    }
  }
  return cps;
}

/** Windows name records: Map nameID → string. */
function names(buf, off) {
  const count = buf.readUInt16BE(off + 2), strings = off + buf.readUInt16BE(off + 4);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    if (buf.readUInt16BE(r) !== 3) continue;
    const id = buf.readUInt16BE(r + 6), len = buf.readUInt16BE(r + 8), at = strings + buf.readUInt16BE(r + 10);
    out.set(id, Buffer.from(buf.subarray(at, at + len)).swap16().toString('utf16le')); // copy: records share strings
  }
  return out;
}

function ttfTables(buf) {
  const tables = new Map();
  for (let i = 0; i < buf.readUInt16BE(4); i++) {
    const r = 12 + i * 16;
    tables.set(buf.toString('latin1', r, r + 4), { buf, off: buf.readUInt32BE(r + 8) });
  }
  return tables;
}

// WOFF2 (W3C WOFF2 §5): header, table directory, then one Brotli stream holding the tables back to back.
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
  'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln',
  'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf',
  'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
function woff2Tables(file) {
  assert.equal(file.toString('latin1', 0, 4), 'wOF2', 'WOFF2 signature');
  const numTables = file.readUInt16BE(12);
  const compressed = file.readUInt32BE(20);
  let p = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = file[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error('UIntBase128'); };
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file[p++];
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) { tag = file.toString('latin1', p, p + 4); p += 4; }
    const version = flags >> 6;
    const orig = base128();
    const transformed = (tag === 'glyf' || tag === 'loca') ? version === 0 : version !== 0;
    dir.push({ tag, length: transformed ? base128() : orig });
  }
  const data = brotliDecompressSync(file.subarray(p, p + compressed));
  const tables = new Map();
  let off = 0;
  for (const t of dir) { tables.set(t.tag, { buf: data, off }); off += t.length; }
  return tables;
}

// ----------------------------------------------------------------------------------------------------- the CSS

test('@font-face: WOFF2 subsets only (no TTF), swap, Figtree 400-700 + italic 400, Geist Mono 400-500, files on disk', () => {
  assert.deepEqual(faces.map((f) => `${f.family} ${f.weight} ${f.style}`).sort(),
    ['Figtree 400 700 normal', 'Figtree 400 italic', 'Geist Mono 400 500 normal']);
  for (const f of faces) {
    assert.equal(f.src[1], 'woff2', f.src[0]);
    assert.match(f.src[0], /\.woff2$/);
    assert.ok(existsSync(path.join(appRoot, f.src[0])), f.src[0]);
    assert.equal(f.display, 'swap');
  }
  assert.doesNotMatch(tokens, /\.ttf/, 'tokens.css loads no TTF');
  assert.match(tokens, /--font-sans:\s*Figtree,/);
  assert.match(tokens, /--font-mono:\s*"Geist Mono",/);
});

test('preloads: the faces of the first paint (Figtree, Geist Mono) as font/woff2 with crossorigin, nothing else', () => {
  const hrefs = preloads.map((t) => /href="([^"]+)"/.exec(t)[1]);
  const want = faces.filter((f) => f.style === 'normal').map((f) => f.src[0]);
  assert.deepEqual(hrefs.sort(), want.sort(), 'each preload is a declared face (else it downloads twice)');
  for (const t of preloads) {
    assert.match(t, /type="font\/woff2"/);
    assert.match(t, / crossorigin[ >]/);
  }
});

test('service worker precaches every face and no TTF', () => {
  for (const f of faces) assert.ok(shell.includes(f.src[0]), `precache ${f.src[0]}`);
  assert.deepEqual(shell.filter((p) => p.endsWith('.ttf')), []);
  for (const f of ['fonts/OFL-Figtree.txt', 'fonts/OFL-GeistMono.txt']) assert.ok(existsSync(path.join(appRoot, f)), f);
});

test('no script names the old family: canvas text and document.fonts.load go through --font-sans / --font-mono', () => {
  // A literal "Liberation Sans" matches no @font-face any more: document.fonts.load() resolves at once with
  // nothing loaded, and a canvas drawn with it falls back to a system face (share.js Save image did this).
  const walk = (dir) => readdirSync(path.join(appRoot, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(path.join(appRoot, rel)).isDirectory() ? walk(rel) : [rel];
  });
  const hits = walk('js').filter((f) => f.endsWith('.js') && /["'`]Liberation (Sans|Mono)["'`]|"Liberation (Sans|Mono)"/.test(read(f)));
  assert.deepEqual(hits, []);
});

// --------------------------------------------------------------------------------------------------- the files

const SOURCE = { 'Figtree-Var': 'Figtree[wght]', 'Figtree-Italic': 'Figtree-Italic[wght]', 'GeistMono-Var': 'GeistMono[wght]' };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// Printable ASCII, Latin-1 and Latin Extended-A (Figtree has no Greek: Greek letters fall back to the next face).
const REQUIRED = [...range(0x20, 0x7e), ...range(0xa0, 0x17f)];
// Non-ASCII characters in js/ and css/ that are not text on screen (regex bounds in js/ui/html.js).
const NOT_COPY = new Set(['ἀ', '῿']);

function usedChars() {
  const walk = (dir) => readdirSync(path.join(appRoot, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(path.join(appRoot, rel)).isDirectory() ? walk(rel) : [rel];
  });
  const chars = new Set();
  for (const f of [...walk('js'), ...walk('css'), 'index.html']) {
    if (!/\.(js|css|html)$/.test(f)) continue;
    for (const ch of read(f)) if (ch.codePointAt(0) > 0x7e && !NOT_COPY.has(ch)) chars.add(ch);
  }
  return chars;
}

for (const [out, src] of Object.entries(SOURCE)) {
  test(`${out}.woff2: small, covers Latin and every app glyph its source has, licence records kept`, () => {
    const file = readFileSync(path.join(appRoot, `fonts/${out}.woff2`));
    const ttf = readFileSync(path.join(appRoot, `fonts/${src}.ttf`));
    assert.ok(file.length < 32 * 1024, `${out}.woff2 is ${file.length} B (≤ 32 KB; the TTF is ${ttf.length} B)`);
    const t = woff2Tables(file);
    const cps = cmapCodepoints(t.get('cmap').buf, t.get('cmap').off);
    const srcTables = ttfTables(ttf);
    const srcCps = cmapCodepoints(ttf, srcTables.get('cmap').off);
    const missing = REQUIRED.filter((c) => !cps.has(c) && srcCps.has(c)).map((c) => `U+${c.toString(16).toUpperCase()}`);
    assert.deepEqual(missing, [], 'Latin-1 / Latin Extended-A');
    const lost = [...usedChars()].filter((ch) => srcCps.has(ch.codePointAt(0)) && !cps.has(ch.codePointAt(0)));
    assert.deepEqual(lost, [], 'glyphs the app uses that the TTF had but the subset dropped');
    for (const c of cps) assert.ok(srcCps.has(c), `U+${c.toString(16)} not in the source font`);
    const n = names(t.get('name').buf, t.get('name').off);
    assert.match(n.get(1), out.startsWith('GeistMono') ? /^Geist Mono/ : /^Figtree/);
    assert.match(n.get(0), /Copyright/, 'copyright notice kept');
    assert.match(n.get(13) || '', /SIL Open Font License/, 'licence record kept');
    assert.ok(t.has('glyf'), 'outlines kept');
    if (out.endsWith('-Var')) assert.ok(t.has('fvar') && t.has('gvar'), 'variable weight axis kept');
  });
}
