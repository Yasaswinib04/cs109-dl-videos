/**
 * build.mjs - inline the ES modules into one self-contained page.
 *
 * The modules are the single source of truth: node runs them directly for the
 * tests, and this flattens them into the published artifact, which has to be
 * one file. Import/export lines are stripped because everything ends up sharing
 * one scope inside the bundle.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ORDER = ['src/parse.js', 'src/categorize.js', 'src/statement.js', 'src/normalize.js', 'src/ui.js'];

const stripped = ORDER.map(f => {
  const src = readFileSync(new URL(f, import.meta.url), 'utf8');
  const body = src
    .split('\n')
    .filter(line => !/^\s*import\s.+from\s.+;?\s*$/.test(line))
    .filter(line => !/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line))
    .map(line => line.replace(/^(\s*)export\s+(const|function|class|let|async)\b/, '$1$2'))
    .join('\n');
  return `/* ---- ${f} ---- */\n${body}`;
}).join('\n\n');

const page = readFileSync(new URL('src/page.html', import.meta.url), 'utf8');
if (!page.includes('/*__BUNDLE__*/')) throw new Error('page.html is missing the bundle placeholder');

mkdirSync(new URL('dist/', import.meta.url), { recursive: true });
const out = page.replace('/*__BUNDLE__*/', () => stripped);
writeFileSync(new URL('dist/tracker.html', import.meta.url), out);

// A stray export/import keyword in the bundle would break the page silently.
const bundle = out.slice(out.indexOf('<script>'));
for (const bad of [/^\s*export\s/m, /^\s*import\s.*from/m]) {
  if (bad.test(bundle)) throw new Error(`bundle still contains a module keyword: ${bad}`);
}
console.log(`dist/tracker.html  ${(out.length / 1024).toFixed(1)} KB`);
