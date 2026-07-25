import { describe, expect, it } from 'vitest';
import { fnv1a64, makeFortune } from '../src/fortune.js';

describe('fortune', () => {
  const f = makeFortune('season-0-test-seed');

  it('is a pure function of the tuple', () => {
    const g = makeFortune('season-0-test-seed');
    expect(f.roll('harvest', 6, 'place:thornfield')).toBe(g.roll('harvest', 6, 'place:thornfield'));
    expect(f.bp('harvest', 6, 'place:thornfield')).toBe(g.bp('harvest', 6, 'place:thornfield'));
  });
  it('changes with every tuple component', () => {
    const base = f.roll('harvest', 6, 'place:thornfield');
    expect(f.roll('weather', 6, 'place:thornfield')).not.toBe(base);
    expect(f.roll('harvest', 7, 'place:thornfield')).not.toBe(base);
    expect(f.roll('harvest', 6, 'place:elsewhere')).not.toBe(base);
    expect(f.roll('harvest', 6, 'place:thornfield', 1)).not.toBe(base);
    expect(makeFortune('other-seed').roll('harvest', 6, 'place:thornfield')).not.toBe(base);
  });
  it('bp is in [0, 9999] and int respects bounds', () => {
    for (let t = 0; t < 200; t++) {
      const bp = f.bp('harvest', t, 'k');
      expect(bp).toBeGreaterThanOrEqual(0);
      expect(bp).toBeLessThanOrEqual(9999);
      const n = f.int('casting', t, 'k', 3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
    }
  });
  it('pick selects a member and throws on empty', () => {
    expect(['a', 'b', 'c']).toContain(f.pick('casting', 1, 'slot', ['a', 'b', 'c']));
    expect(() => f.pick('casting', 1, 'slot', [])).toThrow();
  });
  it('fnv1a64 distinguishes strings', () => {
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
    expect(fnv1a64('')).toBe(0xcbf29ce484222325n);
  });
  it('golden: stream values are frozen', () => {
    expect(f.roll('harvest', 6, 'place:thornfield')).toBe(4094303520962404112n);
    expect(f.bp('harvest', 6, 'place:thornfield')).toBe(4112);
    expect(f.int('casting', 1, 'slot', 0, 99)).toBe(61);
  });
});
