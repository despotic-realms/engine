import { describe, expect, it } from 'vitest';
import { applyMediatedOp } from '../src/mediate.js';
import { makeFortune } from '../src/fortune.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { addEdge, addNode, emptyGraph, getNode, propFx } from '../src/graph.js';
import { fx } from '../src/fx.js';
import { hashValue } from '../src/canon.js';
import { initialState, resolveTick, type SeasonConfig } from '../src/tick.js';
import { starterSeason } from '../src/decks/starter.js';

function world(stewardApt: number, traits: Record<string, true> = {}) {
  let g = emptyGraph();
  g = addNode(g, { id: 'inst:crown', type: 'institution', props: { treasury: fx('100'), legitimacy: fx('50'), arrears: fx('0'), rulerCharId: 'char:ruler' } });
  g = addNode(g, { id: 'place:ash', type: 'place', props: { name: 'Ash', population: fx('100'), granary: fx('20'), farmland: fx('10'), unrest: fx('10'), dole: fx('0'), taxRateBp: 1000, roadsBonusBp: 0, defenseBp: 0, famineStage: 0, famineEndsAt: 0, levy: fx('0') } });
  g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'R' } });
  g = addNode(g, { id: 'char:st', type: 'character', props: { name: 'S', 'apt:econ': stewardApt, ...traits } });
  g = addNode(g, { id: 'office:steward', type: 'office', props: { title: 'Steward' } });
  g = addEdge(g, { type: 'appointment', src: 'char:st', dst: 'office:steward', props: { since: 0 } });
  return g;
}
const MED = { officeForDomain: { econ: 'office:steward', martial: 'office:marshal', social: 'office:envoy' }, willingness: false };

describe('mediated execution (spec §3)', () => {
  it('gates on a live appointee: vacant office -> op.rejected, graph unchanged', () => {
    const em = makeEmitter(3);
    let g = world(7000);
    // office:marshal never exists in this fixture -- missing office and
    // vacant office resolve identically.
    const g2 = applyMediatedOp(g, { kind: 'raise_levy', placeId: 'place:ash', size: '10' }, 3, makeFortune('m'), em, MED, []);
    expect(g2).toBe(g);
    expect(em.all().some((e) => e.type === 'op.rejected')).toBe(true);
  });

  it('sound band executes the op verbatim and emits op.executed with the band', () => {
    const em = makeEmitter(4);
    const g2 = applyMediatedOp(world(9000), { kind: 'stockpile_grain', placeId: 'place:ash', amount: '10' }, 4, makeFortune('sound-seed-a'), em, MED, []);
    const ex = em.all().find((e) => e.type === 'op.executed');
    expect(ex).toBeDefined();
    expect(['sound', 'outstanding']).toContain((ex!.data as { band: string }).band);
    expect(propFx(getNode(g2, 'place:ash').props, 'granary') > fx('20')).toBe(true);
  });

  it('greedy + econ + band below sound skims 15% to the executor', () => {
    // apt 0 -> botched/poor dominate; scan seeds for a sub-sound draw, then assert the rider
    const g0 = world(0, { 'trait:greedy': true });
    for (let s = 0; s < 50; s++) {
      const em = makeEmitter(6);
      const g2 = applyMediatedOp(g0, { kind: 'grant', charId: 'char:ruler', amount: '20' }, 6, makeFortune(`g${s}`), em, MED, []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      if (band === 'poor' || band === 'botched') {
        expect(em.all().some((e) => e.type === 'op.skimmed')).toBe(true);
        expect(propFx(getNode(g2, 'char:st').props, 'wealth') === fx('3')).toBe(true); // 15% of 20
        return;
      }
    }
    throw new Error('no sub-sound draw in 50 seeds — widen scan');
  });

  it('delta-equivalence: replaying every emitted delta reproduces the graph', () => {
    const pre = world(9000);
    const em = makeEmitter(7);
    const g2 = applyMediatedOp(pre, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '10' }, 7, makeFortune('d'), em, MED, []);
    const allDeltas = em.all().flatMap((e) => e.deltas);
    expect(allDeltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(pre, allDeltas);
    expect(hashValue(replayed)).toBe(hashValue(g2));
  });
});

describe('mediated execution riders (spec §3 riders)', () => {
  it('meticulous + econ never botches: a botched draw is floored to poor', () => {
    const g0 = world(0, { 'trait:meticulous': true }); // apt 0 -> ~20% raw-botched per draw
    for (let s = 0; s < 100; s++) {
      const em = makeEmitter(6);
      applyMediatedOp(g0, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '5' }, 6, makeFortune(`met${s}`), em, MED, []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      expect(band).not.toBe('botched');
    }
  });

  it('slothful + poor band emits op.delayed informationally; the op still applies', () => {
    const g0 = world(0, { 'trait:slothful': true });
    for (let s = 0; s < 80; s++) {
      const em = makeEmitter(9);
      const g2 = applyMediatedOp(g0, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '5' }, 9, makeFortune(`sl${s}`), em, MED, []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      if (band === 'poor') {
        const delayed = em.all().find((e) => e.type === 'op.delayed');
        expect(delayed).toBeDefined();
        expect((delayed!.data as { untilTick: number }).untilTick).toBe(11); // tick 9 + 2
        expect(em.all().some((e) => e.type === 'op.stockpile_grain')).toBe(true); // op still landed
        expect(propFx(getNode(g2, 'place:ash').props, 'granary') > fx('20')).toBe(true);
        return;
      }
    }
    throw new Error('no poor-band draw in 80 seeds — widen scan');
  });

  it('sound/outstanding bands never trigger the greedy skim (both sides of the band<sound branch)', () => {
    const g0 = world(9000, { 'trait:greedy': true });
    for (let s = 0; s < 50; s++) {
      const em = makeEmitter(10);
      const g2 = applyMediatedOp(g0, { kind: 'grant', charId: 'char:ruler', amount: '20' }, 10, makeFortune(`hi${s}`), em, MED, []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      if (band === 'sound' || band === 'outstanding') {
        expect(em.all().some((e) => e.type === 'op.skimmed')).toBe(false);
        expect(getNode(g2, 'char:st').props['wealth']).toBeUndefined();
        return;
      }
    }
    throw new Error('no sound/outstanding draw in 50 seeds — widen scan');
  });
});

describe('mediated execution: null-domain ops bypass the office entirely', () => {
  it("a null-domain op (record_stance) applies directly -- the crown's own voice, no gate, no band", () => {
    const g0 = world(9000); // office:envoy (social) is never created in this fixture at all
    const em = makeEmitter(3);
    const g2 = applyMediatedOp(g0, { kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' }, 3, makeFortune('nd'), em, MED, []);
    expect(em.all().some((e) => e.type === 'op.record_stance')).toBe(true);
    expect(em.all().some((e) => e.type === 'op.executed')).toBe(false);
    expect(getNode(g2, 'inst:crown').props['stance:granary-doctrine']).toBe('for');
  });
});

describe('wired into resolveTick (tick.ts step 4)', () => {
  it('routes a validated choice op through applyMediatedOp when the tier configures mediation; tier-0 (no mediation) stays byte-identical', () => {
    const base = starterSeason();
    const season: SeasonConfig = {
      ...base,
      tiers: {
        ...base.tiers,
        1: {
          ...base.tiers[1]!,
          mediation: { officeForDomain: { econ: 'office:steward', martial: 'office:none', social: 'office:none' }, willingness: false },
        },
      },
    };
    const f = makeFortune('wiring-test');
    const state = initialState(season);
    const out = resolveTick(season, state, { seatId: 'seat:throne', choices: [] }, f);
    const brief = out.packet.briefs[0];
    if (!brief) throw new Error('expected at least one brief at tick 1 for this wiring test');
    const next = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 }], via: 'directive' }],
    }, f);
    const executed = next.events.find((e) => e.type === 'op.executed');
    expect(executed).toBeDefined();
    expect((executed!.data as { opKind: string }).opKind).toBe('decree_tax');
    const band = (executed!.data as { band: string }).band;
    // decree_tax has no fx amount, so scaleOp is a no-op regardless of band --
    // the only branch that changes shape is botched (no application at all).
    expect(next.events.some((e) => e.type === 'op.decree_tax')).toBe(band !== 'botched');
  });
});

// T3 critical: applyMediatedOp applied the band-scaled op via applyOp
// without re-validating it -- but validateOp (src/ops.ts:224-276) only ever
// approved the UNSCALED amount. An 'outstanding' draw (x1.3) can scale a
// just-affordable op past what the treasury/granary/target actually holds;
// a 'poor' draw (x0.6) can scale an op below a validated floor (e.g.
// hold_festival's >=10). The fix re-validates the scaled op and, on
// failure, falls back to the ORIGINAL unscaled op -- which the caller
// already validated -- in both directions.
describe('mediated execution: band-scaled ops re-validate against the unscaled ceiling (T3 critical)', () => {
  it('boundary affordability: treasury == unscaled cost, forced outstanding -> falls back to the unscaled amount, treasury never negative', () => {
    // world() treasury is exactly fx('100'). stockpile_grain amount '200' at
    // GRAIN_PRICE 0.5 costs exactly 100 -- validateOp accepts it against the
    // pre-op treasury. An 'outstanding' draw scales amount to 260 (x1.3),
    // costing 130: applied unchecked, treasury goes to -30 (the live repro).
    const g0 = world(9000); // apt 9000 -> 250/1000 outstanding weight
    for (let s = 0; s < 50; s++) {
      const em = makeEmitter(5);
      const g2 = applyMediatedOp(g0, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '200' }, 5, makeFortune(`out${s}`), em, MED, []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      if (band === 'outstanding') {
        const treasury = propFx(getNode(g2, 'inst:crown').props, 'treasury');
        expect(treasury >= fx('0')).toBe(true);
        expect(treasury).toBe(fx('0')); // 100 - (200 * 0.5) -- the unscaled cost, exactly
        expect(propFx(getNode(g2, 'place:ash').props, 'granary')).toBe(fx('220')); // 20 + 200 unscaled, not +260
        return;
      }
    }
    throw new Error('no outstanding draw in 50 seeds — widen scan');
  });

  it('seize at exact wealth: forced outstanding -> falls back to the unscaled amount, target wealth ends exactly 0, never negative', () => {
    let g0 = world(9000);
    g0 = addNode(g0, { id: 'char:target', type: 'character', props: { name: 'Target', wealth: fx('50') } });
    g0 = addNode(g0, { id: 'char:mar', type: 'character', props: { name: 'Marshal', 'apt:martial': 9000 } });
    g0 = addNode(g0, { id: 'office:marshal', type: 'office', props: { title: 'Marshal' } });
    g0 = addEdge(g0, { type: 'appointment', src: 'char:mar', dst: 'office:marshal', props: { since: 0 } });
    for (let s = 0; s < 50; s++) {
      const em = makeEmitter(5);
      const g2 = applyMediatedOp(g0, { kind: 'seize', charId: 'char:target', amount: '50' }, 5, makeFortune(`sz${s}`), em, MED, []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      if (band === 'outstanding') {
        const wealth = propFx(getNode(g2, 'char:target').props, 'wealth');
        expect(wealth >= fx('0')).toBe(true);
        expect(wealth).toBe(fx('0')); // 50 - 50 unscaled, not 50 - 65
        return;
      }
    }
    throw new Error('no outstanding draw in 50 seeds — widen scan');
  });

  it('hold_festival at the validated floor (amount 10): forced poor -> scaling would break the floor, falls back to the unscaled amount, no validation error escapes', () => {
    let g0 = world(9000);
    g0 = addNode(g0, { id: 'char:env', type: 'character', props: { name: 'Envoy', 'apt:social': 0 } }); // apt 0 -> 400/1000 poor weight
    g0 = addNode(g0, { id: 'office:envoy', type: 'office', props: { title: 'Envoy' } });
    g0 = addEdge(g0, { type: 'appointment', src: 'char:env', dst: 'office:envoy', props: { since: 0 } });
    for (let s = 0; s < 50; s++) {
      const em = makeEmitter(5);
      const g2 = applyMediatedOp(g0, { kind: 'hold_festival', placeId: 'place:ash', amount: '10' }, 5, makeFortune(`hf${s}`), em, MED, []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      if (band === 'poor') {
        // Scaled 10 * 0.6 = 6 would trip validateOp's ">= 10" floor; the
        // fallback must apply the original amount and emit its event --
        // no exception, no dropped op.
        const applied = em.all().find((e) => e.type === 'op.hold_festival');
        expect(applied).toBeDefined();
        expect((applied!.data as { amount: string }).amount).toBe('10');
        expect(propFx(getNode(g2, 'inst:crown').props, 'treasury')).toBe(fx('90')); // 100 - 10 unscaled, not 100 - 6
        return;
      }
    }
    throw new Error('no poor draw in 50 seeds — widen scan');
  });
});
