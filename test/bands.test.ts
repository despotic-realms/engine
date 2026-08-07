import { describe, expect, it } from 'vitest';
import { bandWeights, drawBand } from '../src/bands.js';
import { makeFortune } from '../src/fortune.js';

describe('band weights (spec §3.2 — loaded die, never a script)', () => {
  it('per-mille rows sum to 1000 at every threshold', () => {
    for (const apt of [0, 3999, 4000, 5999, 6000, 7999, 8000, 10000]) {
      const w = bandWeights(apt);
      expect(w.reduce((a, b) => a + b, 0)).toBe(1000);
    }
  });
  it('higher aptitude strictly dominates on outstanding and botched', () => {
    const lo = bandWeights(3000); const hi = bandWeights(8500);
    expect(hi[3]).toBeGreaterThan(lo[3]); // outstanding
    expect(hi[0]).toBeLessThan(lo[0]);    // botched
  });
  it('draw is deterministic per (seed, tick, opKey) and covers all bands over many keys', () => {
    const f = makeFortune('band-test');
    expect(drawBand(8000, f, 5, 'op-1')).toBe(drawBand(8000, makeFortune('band-test'), 5, 'op-1'));
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(drawBand(5000, f, i, `k${i}`));
    expect(seen.size).toBe(4);
  });
});
