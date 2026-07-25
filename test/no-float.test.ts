import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve relative to this test file (not process.cwd()) so the test works
// regardless of where the test runner is invoked from.
const SCRIPT = fileURLToPath(new URL('../scripts/check-no-float.mjs', import.meta.url));

function run(dir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fixture(dir: string, name: string, contents: string): void {
  writeFileSync(join(dir, name), contents, 'utf8');
}

describe('check-no-float.mjs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'no-float-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes a clean file', () => {
    fixture(dir, 'clean.ts', 'export const total = 1n + 2n;\n');

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('fails on a float literal in code', () => {
    fixture(dir, 'rate.ts', 'export const rate = 3.14;\n');

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('float literal');
  });

  it('ignores Math. mentioned only inside a multi-line block comment', () => {
    fixture(
      dir,
      'commented.ts',
      [
        '/*',
        ' * Uses Math.floor internally -- deliberately not, see below.',
        ' * (kept here as a design note, not code)',
        ' */',
        'export const y = 1n;',
        '',
      ].join('\n'),
    );

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('ignores Math. mentioned only inside a single-line block comment', () => {
    fixture(dir, 'inline-comment.ts', '/* Math.floor is banned, do not use it here. */\nexport const y = 1n;\n');

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('catches division inside a template interpolation in a non-allowlisted file', () => {
    fixture(dir, 'weird.ts', 'export const x = `${a / b}`;\n');

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('outside allowlisted files');
  });

  it('catches Math. inside a template interpolation', () => {
    fixture(dir, 'random.ts', 'export const r = `${Math.random()}`;\n');

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Math.* is banned');
  });

  it('ignores a float literal inside a plain string', () => {
    fixture(dir, 'stringy.ts', 'export const s = "value 3.14 here";\n');

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('still allows division in an allowlisted file (fx.ts)', () => {
    fixture(dir, 'fx.ts', 'export const half = (a: bigint, b: bigint): bigint => a / b;\n');

    const result = run(dir);

    expect(result.status).toBe(0);
  });

  it('reports the correct line number for a violation following a multi-line comment', () => {
    fixture(
      dir,
      'lines.ts',
      ['/*', ' * multi', ' * line', ' * comment', ' */', 'export const bad = 9.5;', ''].join('\n'),
    );

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lines.ts:6:');
  });

  it('does not desync on an apostrophe inside a regex literal, and still catches a float on the next line', () => {
    fixture(
      dir,
      'apostrophe.ts',
      [`export const APOSTROPHE_RE = /it's a test/;`, 'export const rate = 3.14;', ''].join('\n'),
    );

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apostrophe.ts:2:');
    expect(result.stderr).toContain('float literal');
  });

  it('handles a character class containing / and a quote inside a regex literal, then passes clean code', () => {
    fixture(
      dir,
      'charclass.ts',
      [`export const PATH_OR_QUOTE_RE = /[/'"]/;`, 'export const clean = 1n;', ''].join('\n'),
    );

    const result = run(dir);

    expect(result.status).toBe(0);
  });
});
