// Charcoal type scale (v1.3, ARCHITECTURE.md §3.4 item 6). Player note, 5 Oct: "the font and size of font does not seem
// to follow charcoal's guidelines" → "tokens only, reading text at 18 on a laptop". A static scan of every stylesheet
// (css/*.css) and module (js/**/*.js):
//   1. the type tokens take Charcoal values only — sizes 10 / 11 / 12 / 13 / 18 / 23 / 32 px (data-figure tokens may
//      also use the figure sizes 6.67 / 8 / 9.33 / 10.67) and Charcoal's line heights; only tokens.css (:root) and the
//      laptop steps in desktop.css define them, and nothing multiplies them (no --type-k, calc(), em/rem/%, zoom);
//   2. at every width the roles resolve to the §3.4 table (phone < 1024 px, laptop ≥ 1024 px);
//   3. every font / font-size / line-height / font-weight / font-family a rule sets is a token (or inherit), sizes and
//      line heights pair by role, and every var(--fs-*) / var(--lh-*) names a defined token;
//   4. scripts set no size outside the token sizes (canvas fonts, inline styles, style objects, SVG attributes,
//      setProperty / setAttribute; nothing computed) and never write a type token or a zoom;
//   5. index.html has no type of its own (no <style> block or style attribute sets one).
// The rendered result (every visible text node's computed size, line height and weight at seven viewports) is checked
// by neuroguesser-content/e2e/charcoal-type.spec.js.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { appRoot } from './_importmap.js';

const SIZES = [10, 11, 12, 13, 18, 23, 32];                 // Charcoal token sizes (px)
const FIGURE_SIZES = [6.67, 8, 9.33, 10.67];               // Charcoal figure sizes, inside data figures only
const LINE_HEIGHTS = [1.1, 1.18, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5]; // Charcoal roles (+ 1.45 reading text, §3.4)
const WEIGHTS = ['400', '700'];                            // the Liberation faces (Regular, Bold; Italic 400)

// §3.4 item 6: [size px, line height] per role, phone (< 1024 px) and laptop (≥ 1024 px)
const ROLES = {
  micro: [[11, 1.35], [12, 1.5]],     // captions, state words, legends
  label: [[12, 1.5], [12, 1.5]],      // labels, overlines (mono uppercase)
  body: [[13, 1.3], [13, 1.3]],       // controls & body UI: option text, buttons, tabs, list rows
  card: [[13, 1.25], [13, 1.25]],     // card title / option label (bold)
  read: [[13, 1.45], [18, 1.45]],     // reading text: trivia, How-it-was-made prose, onboarding, review fact
  title: [[18, 1.25], [23, 1.25]],    // screen title
  name: [[23, 1.25], [23, 1.25]],     // the cell's name on the reveal
  display: [[32, 1.18], [32, 1.18]],  // milestone numeral
};
const PHONE_WIDTHS = [320, 375, 390, 599, 600, 768, 1023];
const LAPTOP_WIDTHS = [1024, 1280, 1512, 1920];

// size token → the line-height token it is set with (a role's own; glyph buttons and fields borrow a role's)
const PAIR = { micro: 'micro', label: 'label', body: 'body', card: 'card', read: 'read', title: 'title', name: 'name',
  display: 'display', icon: 'title', 'icon-lg': 'title', 'field-touch': 'body', graph: 'micro' };
// deliberate pairings outside PAIR (selector → [size token, line-height token])
const PAIR_EXCEPTIONS = {
  // one-line labels in the 3D viewer: the tighter box keeps close layer planes (L1 / L2/3 on a phone) apart in the
  // label collision pass (css/viewer.css)
  '.mv-label': ['micro', 'card'],
};

const near = (v, list) => list.some((x) => Math.abs(x - v) < 0.005);
const read = (rel) => readFileSync(path.join(appRoot, rel), 'utf8');
const cssFiles = () => readdirSync(path.join(appRoot, 'css')).filter((n) => n.endsWith('.css')).sort().map((n) => `css/${n}`);
function jsFiles(dir = 'js') {
  const out = [];
  for (const n of readdirSync(path.join(appRoot, dir)).sort()) {
    const rel = `${dir}/${n}`;
    if (statSync(path.join(appRoot, rel)).isDirectory()) out.push(...jsFiles(rel));
    else if (n.endsWith('.js')) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- CSS scanning

/**
 * Declarations of a stylesheet, in source order:
 * { file, line, rule (id), selector, media: [query…], at (enclosing non-media at-rule or null), prop, value, important }.
 * Comments are blanked (line numbers kept); quoted strings are respected.
 */
export function cssDeclarations(file, text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  const out = [];
  const stack = [];
  let buf = '';
  let start = 0;
  let quote = null;
  let rules = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) { buf += ch; if (ch === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '{') {
      const head = buf.trim().replace(/\s+/g, ' ');
      if (head.startsWith('@media')) stack.push({ kind: 'media', text: head.slice(6).trim() });
      else if (head.startsWith('@')) stack.push({ kind: 'at', text: head });
      else stack.push({ kind: 'rule', text: head, id: (rules += 1) });
      buf = '';
      start = i + 1;
    } else if (ch === ';' || ch === '}') {
      const decl = buf.trim();
      const top = stack[stack.length - 1];
      if (decl && top && top.kind === 'rule') {
        const colon = decl.indexOf(':');
        if (colon > 0) {
          let value = decl.slice(colon + 1).trim();
          const important = /!\s*important$/i.test(value);
          if (important) value = value.replace(/\s*!\s*important$/i, '');
          const lead = buf.length - buf.trimStart().length;
          out.push({
            file, line: lineAt(start + lead), rule: `${file}#${top.id}`, selector: top.text,
            media: stack.filter((s) => s.kind === 'media').map((s) => s.text),
            at: (stack.find((s) => s.kind === 'at') || {}).text || null,
            prop: decl.slice(0, colon).trim().toLowerCase(), value: value.replace(/\s+/g, ' '), important,
          });
        }
      }
      buf = '';
      start = i + 1;
      if (ch === '}') stack.pop();
    } else buf += ch;
  }
  return out;
}

/** Does a media query list match a window `width` px wide? Width features only; any other feature → null. */
export function mediaMatches(query, width) {
  let unknown = false;
  const any = query.split(',').some((part) => part.split(/\band\b/).every((f) => {
    const m = /^\s*\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)\s*$/.exec(f);
    if (!m) { unknown = true; return false; }
    return m[1] === 'min' ? width >= Number(m[2]) : width <= Number(m[2]);
  }));
  if (unknown) return null;
  return any;
}

const TOKEN_SELECTORS = /^(:root(, \[data-theme="app-dark"\])?|html:root)$/;
const FONT_RE = /^(?:italic )?(\d{3}) var\(--fs-([a-z0-9-]+)\)\/var\(--lh-([a-z0-9-]+)\) var\(--font-(?:sans|mono)\)$/;

/** Every problem with the type tokens and type declarations of `files` ({ path: css text }). */
export function cssTypeProblems(files) {
  const decls = Object.entries(files).flatMap(([f, t]) => cssDeclarations(f, t));
  const problems = [];
  const where = (d) => `${d.file}:${d.line} ${d.selector} { ${d.prop}: ${d.value} }`;
  const fs = new Set();
  const lh = new Set();

  // 1. tokens: Charcoal values only, defined only on :root (tokens.css) or html:root under a width query (desktop.css)
  for (const d of decls) {
    const m = /^--(fs|lh)-([a-z0-9-]+)$/.exec(d.prop);
    if (!m) continue;
    (m[1] === 'fs' ? fs : lh).add(m[2]);
    if (!TOKEN_SELECTORS.test(d.selector)) problems.push(`type token outside :root: ${where(d)}`);
    if (d.media.some((q) => mediaMatches(q, 0) === null)) problems.push(`type token under a non-width media query: ${where(d)}`);
    if (m[1] === 'fs') {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(d.value);
      const ok = px && (near(Number(px[1]), SIZES) || (m[2].startsWith('fig-') && near(Number(px[1]), FIGURE_SIZES)));
      if (!ok) problems.push(`size token not a Charcoal size: ${where(d)}`);
    } else if (!/^\d(\.\d+)?$/.test(d.value) || !near(Number(d.value), LINE_HEIGHTS)) {
      problems.push(`line-height token not a Charcoal line height: ${where(d)}`);
    }
  }

  // 2. declarations that set type
  const byRule = new Map();
  for (const d of decls) {
    if (d.at && /^@font-face/.test(d.at)) continue;
    const refs = [...d.value.matchAll(/var\(--(fs|lh)-([a-z0-9-]+)\)/g)];
    for (const [, kind, name] of refs) if (!(kind === 'fs' ? fs : lh).has(name)) problems.push(`unknown token --${kind}-${name}: ${where(d)}`);
    if (/--type-k/.test(d.prop + d.value)) problems.push(`type multiplier: ${where(d)}`);
    switch (d.prop) {
      case 'font-size':
        if (!/^var\(--fs-[a-z0-9-]+\)$|^inherit$/.test(d.value)) problems.push(`font-size is not a token: ${where(d)}`);
        break;
      case 'line-height':
        if (!/^var\(--lh-[a-z0-9-]+\)$|^inherit$/.test(d.value)) problems.push(`line-height is not a token: ${where(d)}`);
        break;
      case 'font': {
        if (d.value === 'inherit') break;
        const m = FONT_RE.exec(d.value);
        if (!m) { problems.push(`font is not "<400|700> var(--fs-*)/var(--lh-*) var(--font-sans|mono)": ${where(d)}`); break; }
        if (!WEIGHTS.includes(m[1])) problems.push(`font weight ${m[1]}: ${where(d)}`);
        break;
      }
      case 'font-weight':
        if (![...WEIGHTS, 'inherit'].includes(d.value)) problems.push(`font-weight not 400 / 700: ${where(d)}`);
        break;
      case 'font-family':
        if (!/^var\(--font-(sans|mono)\)$|^inherit$/.test(d.value)) problems.push(`font-family is not a token: ${where(d)}`);
        break;
      case 'zoom': case 'font-size-adjust': case 'font-stretch':
        problems.push(`${d.prop} changes the type scale: ${where(d)}`);
        break;
      case 'text-size-adjust': case '-webkit-text-size-adjust':
        if (d.value !== '100%') problems.push(`${d.prop} must keep 100%: ${where(d)}`);
        break;
      default:
    }
    if (!byRule.has(d.rule)) byRule.set(d.rule, []);
    byRule.get(d.rule).push(d);
  }

  // 3. sizes and line heights pair by role (a rule setting both)
  for (const list of byRule.values()) {
    let size = null;
    let lineH = null;
    for (const d of list) {
      const f = d.prop === 'font' ? FONT_RE.exec(d.value) : null;
      if (f) { size = f[2]; lineH = f[3]; }
      const s = d.prop === 'font-size' && /^var\(--fs-([a-z0-9-]+)\)$/.exec(d.value);
      if (s) size = s[1];
      const l = d.prop === 'line-height' && /^var\(--lh-([a-z0-9-]+)\)$/.exec(d.value);
      if (l) lineH = l[1];
    }
    if (!size || !lineH || size.startsWith('fig-')) continue; // SVG text: the figure has no line boxes
    const sel = list[0].selector;
    const exc = PAIR_EXCEPTIONS[sel];
    if (exc && exc[0] === size && exc[1] === lineH) continue;
    if (PAIR[size] !== lineH) problems.push(`${list[0].file}:${list[0].line} ${sel}: --fs-${size} with --lh-${lineH} (role line height: --lh-${PAIR[size] || '?'})`);
  }
  return { problems, decls, fs, lh };
}

/** Token values at a window `width` px wide (:root in tokens.css, overridden by html:root in desktop.css). */
export function tokensAt(decls, width) {
  const t = {};
  const rank = (d) => (d.selector === 'html:root' ? 1 : 0); // specificity, then source order
  const defs = decls.filter((d) => /^--(fs|lh)-/.test(d.prop)).map((d, i) => [d, i]);
  defs.sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j);
  for (const [d] of defs) if (d.media.every((q) => mediaMatches(q, width))) t[d.prop] = d.value;
  return t;
}

// ---------------------------------------------------------------------------------------------------- JS scanning

/**
 * Blank the comments of a module (newlines kept), leaving code, strings, templates and regex literals intact.
 * A '/' starts a regex literal where an expression can begin (after ( , = : [ ! & | ? { } ; + - * % < > ~ ^ or a
 * keyword such as return), else it is a division.
 */
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  const tpl = []; // template-literal nesting: brace depth at each `${`
  let prev = '';  // previous significant code character (or keyword marker)
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const ch = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { const end = src.indexOf('\n', i); const j = end < 0 ? src.length : end; out += blank(src.slice(i, j)); i = j; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); const j = end < 0 ? src.length : end + 2; out += blank(src.slice(i, j)); i = j; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; prev = 'a'; continue;
    }
    if (ch === '`' || (ch === '}' && tpl.length && tpl[tpl.length - 1] === 0)) {
      if (ch === '}') tpl.pop();
      let j = i + 1;
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
      if (src[j] === '$') { tpl.push(0); out += src.slice(i, j + 2); i = j + 2; prev = '{'; continue; }
      out += src.slice(i, j + 1); i = j + 1; prev = 'a'; continue;
    }
    if (ch === '/') {
      const word = /([A-Za-z_$][\w$]*)\s*$/.exec(out);
      const regexStart = !prev || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || (word && /^(return|typeof|case|do|else|in|of|void|yield|await)$/.test(word[1]) && prev === 'a');
      if (regexStart) {
        let j = i + 1;
        let cls = false;
        while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) {
          if (src[j] === '\\') j += 1; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
          j += 1;
        }
        out += src.slice(i, j + 1); i = j + 1; prev = 'a'; continue;
      }
    }
    if (tpl.length && ch === '{') tpl[tpl.length - 1] += 1;
    if (tpl.length && ch === '}') tpl[tpl.length - 1] -= 1;
    if (!/\s/.test(ch)) prev = /[\w$)\].]/.test(ch) ? 'a' : ch;
    out += ch; i += 1;
  }
  return out;
}

/** Every font size or line height a module sets outside the Charcoal set (and every write of a type token). */
export function jsTypeProblems(file, text) {
  const src = stripJsComments(text);
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  const problems = [];
  const check = (re, what, verdict) => {
    for (const m of src.matchAll(re)) {
      const bad = verdict(m[1]);
      if (bad) problems.push(`${file}:${lineAt(m.index)} ${what}: ${m[0].trim().slice(0, 80)} (${bad})`);
    }
  };
  /** px sizes inside a value that are not Charcoal sizes (or are computed: `${k * 13}px`), or null */
  const badPx = (v) => {
    if (/\$\{[^}]*\}\s*px/.test(String(v))) return 'a computed px size is not a token';
    const bad = [...String(v).matchAll(/(\d+(?:\.\d+)?)px/g)].map((x) => Number(x[1])).filter((x) => !near(x, SIZES));
    return bad.length ? `${bad.join(', ')} px is not a Charcoal size` : null;
  };
  // a size or line height is a token, inherit, or literal Charcoal values (a ternary of literals is fine); anything
  // computed (`${…}`, k * 13) cannot be checked here, so it is not allowed
  const sizeValue = (v) => {
    if (/var\(--fs-[a-z0-9-]+\)/.test(v) || /^\s*inherit\b/.test(v)) return null;
    if (/\d+(?:\.\d+)?px/.test(v) && !/\$\{/.test(v)) return badPx(v);
    const n = /^\s*[`'"]?\s*(\d+(?:\.\d+)?)\s*[`'"]?\s*$/.exec(v); // a unitless number (Preact style → px)
    if (n) return near(Number(n[1]), SIZES) ? null : `${n[1]} is not a Charcoal size`;
    return `"${v.trim()}" is not a token`;
  };
  const lineValue = (v) => {
    if (/var\(--lh-[a-z0-9-]+\)/.test(v) || /^\s*(inherit|normal)\b/.test(v)) return null;
    const n = /^\s*[`'"]?\s*(\d+(?:\.\d+)?)(px)?\s*[`'"]?\s*$/.exec(v);
    if (!n) return `"${v.trim()}" is not a Charcoal line height`;
    return !n[2] && near(Number(n[1]), LINE_HEIGHTS) ? null : `"${v.trim()}" is not a Charcoal line height`;
  };
  const svgSize = (v) => {
    const n = /(\d+(?:\.\d+)?)/.exec(v);
    if (!n || /^\$\{[^}]*[A-Za-z]/.test(v)) return null; // ${expression}: its literals are scanned too
    return near(Number(n[1]), SIZES) || near(Number(n[1]), FIGURE_SIZES) ? null : `${n[1]} is not a Charcoal size`;
  };
  // canvas / element font shorthands and font loads: `700 13px ${sans}`
  check(/\.font\s*=(?!=)\s*([`'"][^`'"]*[`'"])/g, 'font', badPx);
  check(/fonts\.load\(\s*([`'"][^`'"]*[`'"])/g, 'fonts.load', badPx);
  // inline CSS text (style strings, cssText)
  check(/font-size\s*:\s*([^;`'"}]+)/g, 'inline font-size', sizeValue);
  check(/line-height\s*:\s*([^;`'"}]+)/g, 'inline line-height', lineValue);
  check(/[^-]\bfont\s*:\s*([^;`'"}]*\d[^;`'"}]*)/g, 'inline font', badPx);
  // style objects / properties (reads such as getComputedStyle(el).fontSize are not matched)
  check(/\bfontSize\s*(?:=(?!=)|:)\s*([^,;}\n)]+)/g, 'fontSize', sizeValue);
  check(/\blineHeight\s*(?:=(?!=)|:)\s*([^,;}\n)]+)/g, 'lineHeight', lineValue);
  // SVG presentation attributes in html`` templates: font-size="9" (user units; the figure sizes are fine in a figure)
  check(/font-size=\s*(["'{$][^\s>]*)/g, 'SVG font-size', svgSize);
  // DOM calls: el.style.setProperty('font-size', …), el.setAttribute('font-size', …)
  const ARG = '([`\'"][^`\'"]*[`\'"]|[^,)]+)'; // the value argument: a whole string literal, or an expression
  check(new RegExp(`setProperty\\(\\s*[\`'"]font-size[\`'"]\\s*,\\s*${ARG}`, 'g'), 'setProperty font-size', sizeValue);
  check(new RegExp(`setProperty\\(\\s*[\`'"]line-height[\`'"]\\s*,\\s*${ARG}`, 'g'), 'setProperty line-height', lineValue);
  check(new RegExp(`setProperty\\(\\s*[\`'"]font[\`'"]\\s*,\\s*${ARG}`, 'g'), 'setProperty font', badPx);
  check(new RegExp(`setAttribute\\(\\s*[\`'"]font-size[\`'"]\\s*,\\s*${ARG}`, 'g'), 'setAttribute font-size', svgSize);
  // scripts never write a type token, nor any multiplier (zoom included: a camera's .zoom is not a style)
  for (const m of src.matchAll(/setProperty\(\s*[`'"]--(?:fs|lh)-|[`'"]--(?:fs|lh)-[a-z0-9-]+[`'"]\s*:|--type-k|\.style\.zoom\s*=(?!=)|setProperty\(\s*[`'"]zoom[`'"]|[;`'"]\s*zoom\s*:\s*[\d.]/g)) {
    problems.push(`${file}:${lineAt(m.index)} writes a type token or multiplier: ${m[0].trim()}`);
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------------- the tests

const files = Object.fromEntries(cssFiles().map((f) => [f, read(f)]));
const scan = cssTypeProblems(files);

test('type tokens: Charcoal sizes and line heights only, on :root (tokens.css) and the laptop steps (desktop.css)', () => {
  const defs = scan.decls.filter((d) => /^--(fs|lh)-/.test(d.prop));
  assert.ok(defs.length >= 20, 'tokens found');
  assert.deepEqual([...new Set(defs.map((d) => d.file))].sort(), ['css/desktop.css', 'css/tokens.css'], 'defined only in tokens.css and desktop.css');
  for (const d of defs.filter((x) => x.file === 'css/desktop.css')) assert.ok(d.media.length && d.media.every((q) => /min-width/.test(q)), `${d.prop} in desktop.css only under min-width`);
  assert.deepEqual(scan.problems.filter((p) => /token/.test(p)), []);
  for (const f of [...cssFiles(), ...jsFiles()]) assert.doesNotMatch(read(f), /--type-k/, `${f}: no type multiplier`);
});

test('roles resolve to the §3.4 table at every width (phone < 1024 px, laptop >= 1024 px); no other token moves', () => {
  for (const [widths, col] of [[PHONE_WIDTHS, 0], [LAPTOP_WIDTHS, 1]]) {
    for (const w of widths) {
      const t = tokensAt(scan.decls, w);
      for (const [role, cols] of Object.entries(ROLES)) {
        const [px, lh] = cols[col];
        assert.equal(t[`--fs-${role}`], `${px}px`, `${w} px: --fs-${role}`);
        assert.equal(Number(t[`--lh-${role}`]), lh, `${w} px: --lh-${role}`);
      }
    }
  }
  // what changes at 1024 px: micro 12/1.5, reading 18, title 23, and the graph clue's on-screen text (13)
  const phone = tokensAt(scan.decls, 1023);
  const laptop = tokensAt(scan.decls, 1024);
  const changed = Object.keys(laptop).filter((k) => laptop[k] !== phone[k]).sort();
  assert.deepEqual(changed, ['--fs-graph', '--fs-micro', '--fs-read', '--fs-title', '--lh-micro']);
  assert.equal(phone['--fs-graph'], '10px');
  assert.equal(laptop['--fs-graph'], '13px', 'graph clue labels read at 13 px (Charcoal diagram label) on a laptop');
  for (const k of Object.keys(laptop).filter((x) => x.startsWith('--fs-fig-'))) {
    assert.ok(near(parseFloat(laptop[k]), [...FIGURE_SIZES, ...SIZES]), `${k} is a figure size`);
  }
});

test('every font, font-size, line-height, font-weight and font-family in the app CSS is a token; sizes pair by role', () => {
  assert.deepEqual(scan.problems, []);
  // the scan saw the whole app: every stylesheet, and plenty of type declarations
  const typed = scan.decls.filter((d) => ['font', 'font-size', 'line-height'].includes(d.prop));
  assert.ok(typed.length > 150, `${typed.length} type declarations scanned`);
  for (const f of cssFiles()) assert.ok(scan.decls.some((d) => d.file === f), `${f} scanned`);
});

test('scripts: canvas fonts, font loads, inline styles and SVG attributes use Charcoal sizes; no script writes a type token', () => {
  const problems = jsFiles().flatMap((f) => jsTypeProblems(f, read(f)));
  assert.deepEqual(problems, []);
  // the share card draws at the token sizes 11 / 13 / 18 (its canvas mirrors the summary rows)
  const share = read('js/screens/share.js');
  const sizes = [...share.matchAll(/ctx\.font = `\d{3} (\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length >= 4 && sizes.every((s) => [11, 13, 18].includes(s)), `share card sizes ${sizes}`);
});

test('the scanners flag what they are meant to (not a vacuous pass)', () => {
  const base = read('css/tokens.css');
  const bad = (css) => cssTypeProblems({ 'css/tokens.css': base, 'css/x.css': css }).problems;
  assert.equal(bad('.a { font: 400 var(--fs-body)/var(--lh-body) var(--font-sans); }').length, 0);
  assert.match(bad('.a { font-size: 14px; }').join(), /font-size is not a token/);
  assert.match(bad('.a { font-size: calc(var(--fs-body) * 1.15); }').join(), /font-size is not a token/);
  assert.match(bad('.a { font-size: 0.9em; }').join(), /font-size is not a token/);
  assert.match(bad('.a { font: 400 14px/1.4 var(--font-sans); }').join(), /font is not/);
  assert.match(bad('.a { font: 600 var(--fs-body)/var(--lh-body) var(--font-sans); }').join(), /font weight 600/);
  assert.match(bad('.a { font: 400 var(--fs-body)/var(--lh-micro) var(--font-sans); }').join(), /--fs-body with --lh-micro/);
  assert.match(bad('.a { line-height: 1.6; }').join(), /line-height is not a token/);
  assert.match(bad('.a { font-size: var(--fs-caption); }').join(), /unknown token --fs-caption/);
  assert.match(bad('.a { font-family: Arial; }').join(), /font-family is not a token/);
  assert.match(bad('.a { zoom: 1.15; }').join(), /zoom changes the type scale/);
  assert.match(bad(':root { --fs-body: 14px; }').join(), /size token not a Charcoal size/);
  assert.match(bad(':root { --lh-body: 1.6; }').join(), /line-height token not a Charcoal line height/);
  assert.match(bad('.screen { --fs-read: 18px; }').join(), /type token outside :root/);
  assert.match(bad('@media (min-width: 1024px) { html:root { --type-k: 1.15; --fs-body: calc(13px * var(--type-k)); } }').join(), /type multiplier|not a Charcoal size/);
  // role resolution sees the laptop override only from 1024 px
  const d = cssTypeProblems({ 'css/tokens.css': base, 'css/desktop.css': '@media (min-width: 1024px) { html:root { --fs-read: 18px; } }' }).decls;
  assert.equal(tokensAt(d, 1023)['--fs-read'], '13px');
  assert.equal(tokensAt(d, 1024)['--fs-read'], '18px');
  assert.equal(mediaMatches('(min-width: 600px) and (max-width: 641px)', 640), true);
  assert.equal(mediaMatches('(min-width: 600px) and (max-width: 641px)', 700), false);
  assert.equal(mediaMatches('(prefers-reduced-motion: reduce)', 700), null);

  const js = (src) => jsTypeProblems('js/x.js', src);
  assert.deepEqual(js('ctx.font = `700 13px ${t.sans}`; const px = parseFloat(getComputedStyle(el).fontSize);'), []);
  assert.match(js('ctx.font = `400 14px ${t.mono}`;').join(), /14 px is not a Charcoal size/);
  assert.match(js("document.fonts.load('400 15px NG Sans');").join(), /15 px/);
  assert.match(js("el.style.cssText = 'font-size: 16px; color: red';").join(), /inline font-size/);
  assert.match(js("el.style.fontSize = '17px';").join(), /fontSize/);
  assert.match(js('const s = { fontSize: 14 };').join(), /fontSize/);
  assert.match(js("el.style.lineHeight = '1.6';").join(), /lineHeight/);
  assert.match(js('html`<text font-size="9">x</text>`').join(), /SVG font-size: .*9 is not a Charcoal size/);
  assert.deepEqual(js('html`<text font-size="8">x</text>`'), [], 'figure sizes are fine in SVG');
  assert.match(js("root.style.setProperty('--fs-body', '14px');").join(), /writes a type token/);
  assert.deepEqual(js('// font-size: 14px was too small (a comment)\nconst url = "https://example.org/x";'), []);
  // DOM calls, computed sizes and zoom (a 14 px planted any way a script can set it)
  assert.match(js("el.style.setProperty('font-size', '14px');").join(), /setProperty font-size: .*14 px/);
  assert.match(js("el.style.setProperty('line-height', '1.6');").join(), /setProperty line-height/);
  assert.match(js("label.setAttribute('font-size', '14');").join(), /setAttribute font-size: .*14 is not a Charcoal size/);
  assert.deepEqual(js("label.setAttribute('font-size', '8'); el.style.setProperty('font-size', 'var(--fs-body)');"), []);
  assert.match(js('el.style.cssText = `font-size:${14}px`;').join(), /inline font-size/);
  assert.match(js('html`<span style=${`font-size:${n * 1.1}px`}>x</span>`').join(), /inline font-size/);
  assert.match(js('const s = { fontSize: k * 13 };').join(), /fontSize: .*not a token/);
  assert.match(js('ctx.font = `700 ${13 * k}px ${t.sans}`;').join(), /computed px size/);
  assert.match(js('document.body.style.zoom = 1.15;').join(), /type token or multiplier/);
  assert.match(js("el.style.cssText = 'zoom: 1.15';").join(), /type token or multiplier/);
  assert.deepEqual(js('camera.zoom = 1; const v = { yaw: 0, zoom: clamp(z, 0.5, 8) };'), [], 'a camera zoom is not a style');
});

test('index.html: no type of its own (no <style> or style="" sets a size, line height or type token)', () => {
  const html = read('index.html');
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const inline = [...html.matchAll(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi)].map((m) => m[1].slice(1, -1)).join(';\n');
  const css = `${styles}\n.inline-style-attributes { ${inline} }`;
  const problems = cssTypeProblems({ 'css/tokens.css': read('css/tokens.css'), 'index.html': css }).problems;
  assert.deepEqual(problems.filter((p) => p.includes('index.html:')), []);
  assert.doesNotMatch(css, /--(fs|lh)-[a-z0-9-]+\s*:|zoom\s*:/, 'index.html defines no type token or zoom');
  // the check itself: a planted 14 px in a <style> block or a style attribute is caught
  const planted = (h) => {
    const s = [...h.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    const i = [...h.matchAll(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi)].map((m) => m[1].slice(1, -1)).join(';\n');
    return cssTypeProblems({ 'css/tokens.css': read('css/tokens.css'), 'index.html': `${s}\n.inline-style-attributes { ${i} }` }).problems;
  };
  assert.match(planted(html.replace('</head>', '<style>body { font-size: 14px; }</style></head>')).join(), /font-size is not a token/);
  assert.match(planted(html.replace('<body>', '<body style="font: 400 14px/1.4 Arial">')).join(), /font is not/);
});
