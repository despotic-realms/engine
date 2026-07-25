// Fixed-point ledger math. All continuous world quantities are Fx = bigint
// at scale 10^4. Rounding is always floor (toward -infinity) so results are
// platform-independent and replay-stable. No `number` arithmetic on ledgers.
export type Fx = bigint;
export const FX_SCALE: Fx = 10_000n;
export const FX_ZERO: Fx = 0n;
export const FX_ONE: Fx = FX_SCALE;

const FX_RE = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

export function fx(s: string): Fx {
  const m = FX_RE.exec(s);
  if (!m) throw new Error(`fx: cannot parse '${s}'`);
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2] ?? '0');
  const frac = BigInt(((m[3] ?? '') + '0000').slice(0, 4));
  return sign * (whole * FX_SCALE + frac);
}

export function fxFromInt(n: number): Fx {
  if (!Number.isSafeInteger(n)) throw new Error(`fxFromInt: not a safe integer: ${n}`);
  return BigInt(n) * FX_SCALE;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export function mulFx(a: Fx, b: Fx): Fx {
  return floorDiv(a * b, FX_SCALE);
}

export function divFx(a: Fx, b: Fx): Fx {
  if (b === 0n) throw new Error('divFx: division by zero');
  return floorDiv(a * FX_SCALE, b);
}

// Whole-unit part of x, floor-rounded toward -infinity (so e.g. -0.0001
// whole-units to -1, not 0) -- the negative-safe complement to fxToString's
// fractional part. Callers who need an integer count of whole units (basis
// points off a fixed rate, say) use this instead of a bare `/`.
export function fxWhole(x: Fx): bigint {
  return floorDiv(x, FX_SCALE);
}

export function clampFx(x: Fx, lo: Fx, hi: Fx): Fx {
  return x < lo ? lo : x > hi ? hi : x;
}

export function fxToString(x: Fx): string {
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const whole = abs / FX_SCALE;
  const frac = (abs % FX_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
