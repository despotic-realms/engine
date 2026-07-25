// Enforces the no-float invariant over src/ (or an optional directory
// argument, for fixture testing). Crude by design: bans the tokens rather
// than proving types. Divides are allowed only in files whose divisions are
// bigint-only or regex delimiters (reviewed by hand).
//
// Comments (line comments and block comments, including block comments that
// span multiple lines) are stripped from the whole file before scanning, and
// string-literal contents are blanked -- except `${...}` interpolation
// bodies inside template literals, which are kept and scanned as code (the
// scan recurses, so nested strings/templates/comments inside an
// interpolation are handled too).
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

// Strips comments and blanks string-literal contents from `text`, keeping
// `${...}` template-interpolation bodies as scannable code. The result is
// the same length as the input and preserves every newline position, so
// line numbers computed from it (by splitting on '\n') line up exactly with
// the original file.
function sanitize(text) {
  const out = text.split('');
  const n = text.length;
  const blank = (i) => {
    if (out[i] !== '\n') out[i] = ' ';
  };

  function scanString(i, quote) {
    blank(i);
    i++;
    while (i < n && text[i] !== quote) {
      if (text[i] === '\\' && i + 1 < n) {
        blank(i);
        i++;
        blank(i);
        i++;
        continue;
      }
      blank(i);
      i++;
    }
    if (i < n) {
      blank(i);
      i++;
    }
    return i;
  }

  function scanTemplate(i) {
    blank(i);
    i++;
    while (i < n && text[i] !== '`') {
      if (text[i] === '\\' && i + 1 < n) {
        blank(i);
        i++;
        blank(i);
        i++;
        continue;
      }
      if (text[i] === '$' && text[i + 1] === '{') {
        i += 2; // keep "${" as code
        i = scanCode(i, true);
        if (i < n && text[i] === '}') i++; // keep the closing brace as code
        continue;
      }
      blank(i);
      i++;
    }
    if (i < n) {
      blank(i);
      i++;
    }
    return i;
  }

  // Scans code text. When `inInterpolation` is true, stops (without
  // consuming) at the '}' that closes the enclosing `${...}`, tracking
  // brace depth so nested `{}` inside the expression don't end it early.
  function scanCode(i, inInterpolation) {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') {
          blank(i);
          i++;
        }
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        blank(i);
        blank(i + 1);
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
          blank(i);
          i++;
        }
        if (i < n) {
          blank(i);
          blank(i + 1);
          i += 2;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        i = scanString(i, c);
        continue;
      }
      if (c === '`') {
        i = scanTemplate(i);
        continue;
      }
      if (inInterpolation) {
        if (c === '{') {
          depth++;
          i++;
          continue;
        }
        if (c === '}') {
          if (depth === 0) return i;
          depth--;
          i++;
          continue;
        }
      }
      i++;
    }
    return i;
  }

  scanCode(0, false);
  return out.join('');
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

const root = process.argv[2] ?? 'src';

let failed = false;
for (const file of walk(root)) {
  const base = file.split('/').pop();
  const raw = readFileSync(file, 'utf8');
  const sanitized = sanitize(raw);
  sanitized.split('\n').forEach((line, i) => {
    for (const [re, msg] of BANNED) {
      if (re.test(line)) {
        console.error(`${file}:${i + 1}: ${msg}`);
        failed = true;
      }
    }
    if (!DIVIDE_ALLOW.has(base) && /\//.test(line)) {
      console.error(`${file}:${i + 1}: '/' outside allowlisted files`);
      failed = true;
    }
  });
}
if (failed) process.exit(1);
console.log('no-float check passed');
