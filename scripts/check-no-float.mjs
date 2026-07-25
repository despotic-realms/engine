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
// interpolation are handled too). Regex literals are also blanked like
// strings: their contents aren't code to scan, and their delimiting `/`
// characters are not division, so they must not trip the bare-`/` check.
// Telling a regex literal apart from a division operator in general
// requires a real parser; we use a preceding-token heuristic instead (see
// isRegexContext below), which covers the common cases without pretending
// to be exact.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIVIDE_ALLOW = new Set(['fx.ts', 'fortune.ts', 'storylet.ts', 'ops.ts']);
const BANNED = [
  [/\bMath\./, 'Math.* is banned in the core'],
  [/\bparseFloat\b|\bNumber\.parseFloat\b/, 'parseFloat is banned'],
  [/\btoFixed\b/, 'toFixed is banned'],
  [/\bDate\b/, 'Date is banned (nondeterministic)'],
  [/(?<![\w.])\d+\.\d+/, 'float literal'],
];

// Keywords after which a bare '/' starts a regex literal, not division --
// all contexts where an *expression* is expected next, not contexts where
// one just ended.
// Note: 'of' is deliberately excluded even though it introduces the
// for-of clause -- unlike every other entry here, 'of' is not a reserved
// word in JS/TS, so it can be an ordinary identifier (`const of = 4`).
// Treating it as a regex-context keyword misroutes real division right
// after such a variable into scanRegex.
const REGEX_CONTEXT_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'case',
  'do',
  'else',
]);
const WORD_CHAR = /[A-Za-z0-9_$]/;

// Strips comments, blanks string-literal contents, and blanks regex
// literals from `text`, keeping `${...}` template-interpolation bodies as
// scannable code. The result is the same length as the input and preserves
// every newline position, so line numbers computed from it (by splitting on
// '\n') line up exactly with the original file.
function sanitize(text) {
  const out = text.split('');
  const n = text.length;
  const blank = (i) => {
    if (out[i] !== '\n') out[i] = ' ';
  };

  // Heuristic: does a '/' at position i start a regex literal? Looks at the
  // last non-whitespace character already scanned into `out` (so preceding
  // comments/strings -- already blanked to spaces -- are skipped over). An
  // identifier, number, ')', or ']' immediately before the slash means an
  // operand just ended, so it's division; anything else -- an operator,
  // punctuation, the start of the file, or one of a handful of keywords
  // that are always followed by an expression -- means an operand is
  // expected next, so it's a regex literal.
  function isRegexContext(i) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    const c = out[j];
    if (WORD_CHAR.test(c)) {
      let k = j;
      while (k >= 0 && WORD_CHAR.test(out[k])) k--;
      const word = out.slice(k + 1, j + 1).join('');
      return REGEX_CONTEXT_KEYWORDS.has(word);
    }
    return c !== ')' && c !== ']';
  }

  // Scans a regex literal starting at the opening '/', honoring [...]
  // character classes (where '/' doesn't close the regex) and backslash
  // escapes, then consumes trailing flags. Blanks the whole thing, same as
  // a string -- it isn't code, and its delimiters aren't division.
  function scanRegex(i) {
    blank(i); // opening '/'
    i++;
    let inClass = false;
    while (i < n && text[i] !== '\n' && (text[i] !== '/' || inClass)) {
      if (text[i] === '\\' && i + 1 < n) {
        blank(i);
        i++;
        blank(i);
        i++;
        continue;
      }
      if (text[i] === '[') inClass = true;
      else if (text[i] === ']') inClass = false;
      blank(i);
      i++;
    }
    if (i < n && text[i] === '/') {
      blank(i);
      i++;
    }
    while (i < n && /[A-Za-z]/.test(text[i])) {
      blank(i); // flags: g, i, m, s, u, y, d, ...
      i++;
    }
    return i;
  }

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
      if (c === '/' && isRegexContext(i)) {
        i = scanRegex(i);
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
