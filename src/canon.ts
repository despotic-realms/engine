// Canonical encoding for snapshots, wire fixtures, season IDs, and replay
// fingerprints: sorted keys, bigint tagged as {"$n":"..."}, floats rejected.
// Object keys starting with '$' are reserved for encoding tags.
// canonJson builds the output string directly by recursion instead of
// rebuilding a plain object for JSON.stringify to serialize, because
// JSON.stringify reads an object's keys back in [[OwnPropertyKeys]] order --
// which always places integer-like keys ("2", "10") in ascending numeric
// order ahead of string keys, regardless of insertion order -- silently
// defeating the lexicographic sort this format promises.
import { fnv1a64, mix64 } from './fortune.js';

export function canonJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`canon: non-integer number ${v}`);
    return String(v);
  }
  if (typeof v === 'bigint') return '{"$n":"' + v.toString() + '"}';
  if (Array.isArray(v)) return '[' + v.map(canonJson).join(',') + ']';
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v as object);
    if (proto !== Object.prototype && proto !== null)
      throw new Error('canon: cannot encode non-plain object');
    const parts: string[] = [];
    for (const k of Object.keys(v as object).sort()) {
      if (k.startsWith('$')) throw new Error(`canon: reserved key '${k}'`);
      parts.push(JSON.stringify(k) + ':' + canonJson((v as Record<string, unknown>)[k]));
    }
    return '{' + parts.join(',') + '}';
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
