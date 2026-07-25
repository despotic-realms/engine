// D21: one master seed per reign, derived into named counter-based
// substreams. Every draw is a pure hash of (masterSeed, stream, tick, key, n)
// — no sequential RNG state, so draw-order is irrelevant: adding content
// never perturbs unrelated rolls, and same-seed reruns are parallelizable.
const M64 = 0xffff_ffff_ffff_ffffn;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;
const SEP = '';

export function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & M64;
  }
  return h;
}

export function mix64(x: bigint): bigint {
  // SplitMix64 finalizer: full-avalanche mixing of the raw hash.
  let z = (x + 0x9e3779b97f4a7c15n) & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return (z ^ (z >> 31n)) & M64;
}

export interface Fortune {
  roll(stream: string, tick: number, key: string, n?: number): bigint;
  /** Percentile in basis points, 0..9999. The luck-accounting unit (D21). */
  bp(stream: string, tick: number, key: string, n?: number): number;
  /** Uniform integer in [lo, hi], inclusive. Modulo bias is negligible at 64 bits. */
  int(stream: string, tick: number, key: string, lo: number, hi: number, n?: number): number;
  pick<T>(stream: string, tick: number, key: string, items: readonly T[], n?: number): T;
}

export function makeFortune(masterSeed: string): Fortune {
  const roll = (stream: string, tick: number, key: string, n = 0): bigint =>
    mix64(fnv1a64([masterSeed, stream, String(tick), key, String(n)].join(SEP)));
  return {
    roll,
    bp: (stream, tick, key, n = 0) => Number(roll(stream, tick, key, n) % 10_000n),
    int: (stream, tick, key, lo, hi, n = 0) => {
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo)
        throw new Error(`fortune.int: bad range [${lo}, ${hi}]`);
      return lo + Number(roll(stream, tick, key, n) % BigInt(hi - lo + 1));
    },
    pick: (stream, tick, key, items, n = 0) => {
      if (items.length === 0) throw new Error('fortune.pick: empty list');
      const i = Number(roll(stream, tick, key, n) % BigInt(items.length));
      const item = items[i];
      if (item === undefined) throw new Error('fortune.pick: unreachable');
      return item;
    },
  };
}
