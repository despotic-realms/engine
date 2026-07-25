// Canonical encoding for snapshots, wire fixtures, season IDs, and replay
// fingerprints: sorted keys, bigint tagged as {"$n":"..."}, floats rejected.
// Object keys starting with '$' are reserved for encoding tags.
import { fnv1a64, mix64 } from './fortune.js';

export function canonJson(v: unknown): string {
  return JSON.stringify(enc(v));
}

function enc(v: unknown): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return { $n: v.toString() };
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`canon: non-integer number ${v}`);
    return v;
  }
  if (Array.isArray(v)) return v.map(enc);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      if (k.startsWith('$')) throw new Error(`canon: reserved key '${k}'`);
      out[k] = enc((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  throw new Error(`canon: cannot encode ${typeof v}`);
}

export function fromCanon(s: string): unknown {
  return JSON.parse(s, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) && typeof v.$n === 'string' && Object.keys(v).length === 1
      ? BigInt(v.$n)
      : v,
  );
}

export function hash64Hex(s: string): string {
  return mix64(fnv1a64(s)).toString(16).padStart(16, '0');
}

export function hashValue(v: unknown): string {
  return hash64Hex(canonJson(v));
}
