import { describe, expect, it } from 'vitest';
import { FX_ONE, FX_SCALE, clampFx, divFx, fx, fxFromInt, fxToString, mulFx } from '../src/fx.js';

describe('fx', () => {
  it('parses decimal strings at scale 10^4', () => {
    expect(fx('2.5')).toBe(25000n);
    expect(fx('-0.0001')).toBe(-1n);
    expect(fx('3')).toBe(30000n);
    expect(FX_ONE).toBe(FX_SCALE);
  });
  it('rejects bad input', () => {
    expect(() => fx('1.23456')).toThrow(); // too many decimals
    expect(() => fx('abc')).toThrow();
    expect(() => fx('1e3')).toThrow();
    expect(() => fxFromInt(1.5)).toThrow();
  });
  it('multiplies and divides with floor rounding', () => {
    expect(mulFx(fx('2.5'), fx('4'))).toBe(fx('10'));
    expect(divFx(fx('1'), fx('3'))).toBe(3333n); // 0.3333, floored
    expect(mulFx(fx('-0.0001'), fx('0.5'))).toBe(-1n); // floor toward -inf, not trunc
    expect(() => divFx(fx('1'), 0n)).toThrow();
  });
  it('clamps and prints', () => {
    expect(clampFx(fx('120'), fx('0'), fx('100'))).toBe(fx('100'));
    expect(clampFx(fx('-3'), fx('0'), fx('100'))).toBe(fx('0'));
    expect(fxToString(fx('12.34'))).toBe('12.34');
    expect(fxToString(3333n)).toBe('0.3333');
    expect(fxToString(fx('-2.5'))).toBe('-2.5');
    expect(fxToString(fx('7'))).toBe('7');
  });
});
