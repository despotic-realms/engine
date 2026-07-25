import { describe, expect, it } from 'vitest';
import { canonJson, fromCanon, hashValue } from '../src/canon.js';

describe('canon', () => {
  it('is key-order independent', () => {
    expect(canonJson({ b: 1, a: 2 })).toBe(canonJson({ a: 2, b: 1 }));
    expect(canonJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });
  it('round-trips bigint', () => {
    const v = { treasury: 300_0000n, tags: ['x'], deep: { n: -1n } };
    expect(fromCanon(canonJson(v))).toEqual(v);
    expect(canonJson(1n)).toBe('{"$n":"1"}');
  });
  it('rejects non-canonical values', () => {
    expect(() => canonJson({ x: 1.5 })).toThrow();      // float
    expect(() => canonJson({ x: undefined })).toThrow();
    expect(() => canonJson({ $n: 'sneaky' })).toThrow(); // reserved key
  });
  it('hashes stably', () => {
    expect(hashValue({ a: 1n })).toBe(hashValue({ a: 1n }));
    expect(hashValue({ a: 1n })).not.toBe(hashValue({ a: 2n }));
    expect(hashValue({ a: 1n })).toMatch(/^[0-9a-f]{16}$/);
  });
  it('sorts keys lexicographically, not by numeric value', () => {
    const s = canonJson({ '10': 1, '2': 2, x: 3 });
    expect(s).toBe('{"10":1,"2":2,"x":3}'); // '10' < '2' < 'x' as strings
    expect(fromCanon(s)).toEqual({ '10': 1, '2': 2, x: 3 });
  });
  it('rejects Map/Set/class instances instead of silently encoding them as {}', () => {
    class NotPlain {} // stands in for Date/Error/any other class instance
    expect(() => canonJson(new Map())).toThrow();
    expect(() => canonJson(new Set())).toThrow();
    expect(() => canonJson(new NotPlain())).toThrow();
  });
  it('still accepts a null-prototype object', () => {
    const o: Record<string, unknown> = Object.create(null);
    o.a = 1;
    expect(canonJson(o)).toBe('{"a":1}');
  });
  it('rejects a reserved key at nested depth, not just top level', () => {
    expect(() => canonJson({ outer: { $n: 'sneaky' } })).toThrow();
  });
});
