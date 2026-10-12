// Test helper: resolve bare specifiers ('preact', 'preact/hooks', 'htm', 'three', 'three/addons/…') with the
// SAME import map the browser uses (parsed from index.html), so app modules can be imported under
// `node --test`. Import this module first, then load app modules with dynamic import():
//   import './_importmap.js';
//   const game = await import('../js/game.js');
// (static imports are linked before this module runs, so they would not see the hooks.)
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import * as nodeModule from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlText = readFileSync(path.join(root, 'index.html'), 'utf8');
const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(htmlText);
if (!m) throw new Error('index.html has no import map');
export const importMap = JSON.parse(m[1]).imports;

export function mapSpecifier(spec) {
  if (Object.prototype.hasOwnProperty.call(importMap, spec)) return pathToFileURL(path.join(root, importMap[spec])).href;
  for (const [prefix, target] of Object.entries(importMap)) {
    if (prefix.endsWith('/') && spec.startsWith(prefix)) return pathToFileURL(path.join(root, target, spec.slice(prefix.length))).href;
  }
  return null;
}

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = mapSpecifier(specifier);
      return url ? { url, format: 'module', shortCircuit: true } : nextResolve(specifier, context);
    },
  });
} else {
  const code = `
    const map = ${JSON.stringify(Object.fromEntries(Object.keys(importMap).map((k) => [k, null])))};
    export async function resolve(specifier, context, next) {
      const table = ${JSON.stringify(Object.fromEntries(Object.entries(importMap).map(([k, v]) => [k, pathToFileURL(path.join(root, v)).href])))};
      if (table[specifier]) return { url: table[specifier], format: 'module', shortCircuit: true };
      for (const [p, t] of Object.entries(table)) if (p.endsWith('/') && specifier.startsWith(p)) return { url: t + specifier.slice(p.length), format: 'module', shortCircuit: true };
      return next(specifier, context);
    }`;
  nodeModule.register(`data:text/javascript,${encodeURIComponent(code)}`);
}

export const appRoot = root;
