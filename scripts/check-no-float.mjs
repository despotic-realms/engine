// Enforces the no-float invariant over src/. Crude by design: bans the
// tokens rather than proving types. Divides are allowed only in files whose
// divisions are bigint-only or regex delimiters (reviewed by hand).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIVIDE_ALLOW = new Set(['fx.ts', 'fortune.ts', 'storylet.ts']);
const BANNED = [
  [/\bMath\./, 'Math.* is banned in the core'],
  [/\bparseFloat\b|\bNumber\.parseFloat\b/, 'parseFloat is banned'],
  [/\btoFixed\b/, 'toFixed is banned'],
  [/\bDate\b/, 'Date is banned (nondeterministic)'],
  [/(?<![\w.])\d+\.\d+/, 'float literal'],
];

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

let failed = false;
for (const file of walk('src')) {
  const base = file.split('/').pop();
  const raw = readFileSync(file, 'utf8');
  raw.split('\n').forEach((line, i) => {
    const code = line
      .replace(/\/\/.*$/, '')            // line comments
      .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""'); // string contents
    for (const [re, msg] of BANNED) {
      if (re.test(code)) { console.error(`${file}:${i + 1}: ${msg}`); failed = true; }
    }
    if (!DIVIDE_ALLOW.has(base) && /\//.test(code.replace(/\/\*[\s\S]*?\*\//g, ''))) {
      console.error(`${file}:${i + 1}: '/' outside allowlisted files`); failed = true;
    }
  });
}
if (failed) process.exit(1);
console.log('no-float check passed');
