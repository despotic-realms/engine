import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('toolchain', () => {
  it('imports the package', () => {
    expect(VERSION).toBe('0.0.1');
  });
});
