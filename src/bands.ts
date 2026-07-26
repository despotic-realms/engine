// spec §3.2. Aptitude maps to per-mille band weights; the counter-based
// execution stream picks against cumulative thresholds. One noise source per
// mediated op; everything downstream of the drawn band is deterministic.
// Integer math only (no-float guard).
import type { Fortune } from './fortune.js';
import { BANDS, type Band } from './spine.js';

// rows: [botched, poor, sound, outstanding] per-mille, by aptitude bucket.
export function bandWeights(apt: number): [number, number, number, number] {
  if (apt >= 8000) return [30, 120, 600, 250];
  if (apt >= 6000) return [60, 220, 600, 120];
  if (apt >= 4000) return [120, 350, 480, 50];
  return [200, 400, 380, 20];
}

export function drawBand(apt: number, fortune: Fortune, tick: number, opKey: string): Band {
  const w = bandWeights(apt);
  const roll = fortune.int('execution', tick, opKey, 0, 999); // [0, 1000)
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    acc += w[i]!;
    if (roll < acc) return BANDS[i]!;
  }
  return BANDS[3]!;
}
