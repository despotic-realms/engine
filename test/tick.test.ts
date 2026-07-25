import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { makeFortune } from '../src/fortune.js';
import { initialState, resolveTick, validateDecisions, type SeasonConfig } from '../src/tick.js';
import { starterSeason } from '../src/decks/starter.js';
import { setNodeProp } from '../src/graph.js';

const season = starterSeason();
const f = makeFortune('tick-test-seed');
const empty = { seatId: 'seat:throne', choices: [] };

function advance(n: number) {
  let state = initialState(season);
  let out = resolveTick(season, state, empty, f);
  const packets = [out.packet];
  const events = [...out.events];
  for (let i = 1; i < n; i++) {
    out = resolveTick(season, out.state, empty, f);
    packets.push(out.packet);
    events.push(...out.events);
  }
  return { out, packets, events };
}

describe('validateDecisions', () => {
  it('rejects a journal key anywhere (D16)', () => {
    const state = initialState(season);
    const top = validateDecisions(season, state, { seatId: 'seat:throne', choices: [], journal: 'my secret plan' });
    expect(top.ok).toBe(false);
    if (!top.ok) expect(top.error).toContain('D16');
    const nested = validateDecisions(season, state, {
      seatId: 'seat:throne',
      choices: [{ briefId: 'b1.0', optionId: 'hold', journal: 'x' }],
    });
    expect(nested.ok).toBe(false);
  });
  it('rejects unknown briefs, unknown options, and op/option ambiguity', () => {
    const state = initialState(season);
    expect(validateDecisions(season, state, { seatId: 'seat:throne', choices: [{ briefId: 'b9.9', optionId: 'x' }] }).ok).toBe(false);
    expect(validateDecisions(season, state, { seatId: 'seat:throne', choices: [{ briefId: 'b1.0' }] }).ok).toBe(false);
  });
  it('rejects a non-string optionId even when ops is also present (resolveTick non-null-assertion crash repro)', () => {
    const { out } = advance(1);
    const brief = out.packet.briefs[0]!;
    const r = validateDecisions(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, optionId: 42, ops: [] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`choice '${brief.briefId}' needs exactly one of optionId | ops`);
  });
  it('rejects a non-string compileRef (canonJson non-integer-number poisoning repro)', () => {
    const { out } = advance(1);
    const brief = out.packet.briefs[0]!;
    const r = validateDecisions(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [], compileRef: 1.5 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`choice '${brief.briefId}' compileRef must be a string`);
  });
  it('rejects a non-literal via (arbitrary nested object poisoning the chronicle)', () => {
    const { out } = advance(1);
    const brief = out.packet.briefs[0]!;
    const r = validateDecisions(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [], via: { x: 1 } }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`choice '${brief.briefId}' via must be 'option' or 'directive'`);
  });
  it('accepts a well-typed directive choice (ops + via + compileRef all well-typed)', () => {
    const { out } = advance(1);
    const brief = out.packet.briefs[0]!;
    const r = validateDecisions(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [], via: 'directive', compileRef: 'compiled:abc123' }],
    });
    expect(r.ok).toBe(true);
  });
});

describe('resolveTick', () => {
  it('presents briefs, reports, and letters in the packet', () => {
    const { packets } = advance(2);
    const p = packets[1]!;
    expect(p.tick).toBe(2);
    expect(p.briefs.length).toBeGreaterThan(0);
    expect(p.briefs[0]!.options.length).toBeGreaterThanOrEqual(2);
    expect(p.reports).toHaveLength(1);
    expect(p.attentionSlots).toBe(2);
  });
  it('applies a chosen option and chronicles the causal chain', () => {
    const { out } = advance(1);
    const brief = out.packet.briefs[0]!;
    const choice = { seatId: 'seat:throne', choices: [{ briefId: brief.briefId, optionId: brief.options[0]!.id }] };
    const r = validateDecisions(season, out.state, choice);
    expect(r.ok).toBe(true);
    const next = resolveTick(season, out.state, choice, f);
    const decision = next.events.find((e) => e.type === 'decision.recorded');
    expect(decision).toBeDefined();
    const opEvents = next.events.filter((e) => e.type.startsWith('op.'));
    for (const ev of opEvents) expect(ev.parents).toContain(decision!.id);
  });
  it('defaults unattended briefs and records neglect over the attention cut', () => {
    const { out } = advance(1);
    if (out.packet.briefs.length > 0) {
      const next = resolveTick(season, out.state, empty, f);
      expect(next.events.some((e) => e.type === 'brief.defaulted')).toBe(true);
    }
  });
  it('the famine calendar bites: starvation appears within 16 ticks', () => {
    const { events } = advance(16);
    expect(events.some((e) => e.type === 'crisis.famine.armed')).toBe(true);
    expect(events.some((e) => e.type === 'famine.starvation')).toBe(true);
  });
});

describe('defaulted briefs with failing ops', () => {
  it('emits op.rejected (via: default) instead of silently skipping', () => {
    // Build a season whose only storylet's DEFAULT drains grain that an
    // attended op will already have spent this tick.
    const drainOption = { id: 'drain', label: 'Drain', ops: [{ kind: 'release_grain' as const, placeId: '$p', amount: '240' }] };
    const baseSeason = starterSeason();
    // Override granary to 350: tick-0 consumes ~100, leaving 250 for the two-drain test.
    // Attended drain of 240 succeeds, leaves 10; default drain of 240 fails.
    const modifiedGraph = setNodeProp(baseSeason.initialGraph, 'place:thornfield', 'granary', fx('350'));
    const season = { ...baseSeason, initialGraph: modifiedGraph };
    const s: SeasonConfig = {
      ...season,
      decks: [{
        id: 'starter', tier: 1,
        storylets: [
          {
            id: 'starter.a', kind: 'brief' as const, tier: 1, cooldownTicks: 1, once: false,
            pattern: { nodes: [{ as: 'p', type: 'place' as const }] },
            title: 'A', body: 'A', options: [drainOption, { id: 'skip', label: 'Skip', ops: [] }],
            defaultOptionId: 'skip',
          },
          {
            id: 'starter.b', kind: 'brief' as const, tier: 1, cooldownTicks: 1, once: false,
            pattern: { nodes: [{ as: 'p', type: 'place' as const }] },
            title: 'B', body: 'B', options: [drainOption, { id: 'skip', label: 'Skip', ops: [] }],
            defaultOptionId: 'drain',   // default that CAN fail
          },
        ],
      }],
      calendar: [],
    };
    const f = makeFortune('default-op-test');
    let out = resolveTick(s, initialState(s), { seatId: 'seat:throne', choices: [] }, f);
    // both briefs presented; attend A (drain 240 of 250), neglect B (its default drain fails)
    const a = out.packet.briefs.find((b) => b.storyletId === 'starter.a')!;
    out = resolveTick(s, out.state, { seatId: 'seat:throne', choices: [{ briefId: a.briefId, optionId: 'drain' }] }, f);
    const rejected = out.events.filter((e) => e.type === 'op.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.data['via']).toBe('default');
    expect(String(rejected[0]?.data['error'])).toContain('grain');
    // Verify the rejected event traces to brief.defaulted
    const defaultedEvent = out.events.find((e) => e.type === 'brief.defaulted');
    expect(rejected[0]?.parents).toContain(defaultedEvent?.id);
  });
});
