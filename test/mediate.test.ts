import { describe, expect, it } from 'vitest';
import { applyMediatedOp, willingnessOf } from '../src/mediate.js';
import { makeFortune } from '../src/fortune.js';
import type { Fortune } from '../src/fortune.js';
import { drawBand } from '../src/bands.js';
import { aptOf } from '../src/spine.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { addEdge, addNode, emptyGraph, getNode, propFx, setNodeProp } from '../src/graph.js';
import { fx } from '../src/fx.js';
import { canonJson, hashValue } from '../src/canon.js';
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
    const g2 = applyMediatedOp(g, { kind: 'raise_levy', placeId: 'place:ash', size: '10' }, 3, makeFortune('m'), em, MED, 'seat:throne', []);
    expect(g2).toBe(g);
    expect(em.all().some((e) => e.type === 'op.rejected')).toBe(true);
  });

  it('sound band executes the op verbatim and emits op.executed with the band', () => {
    const em = makeEmitter(4);
    const g2 = applyMediatedOp(world(9000), { kind: 'stockpile_grain', placeId: 'place:ash', amount: '10' }, 4, makeFortune('sound-seed-a'), em, MED, 'seat:throne', []);
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
      const g2 = applyMediatedOp(g0, { kind: 'grant', charId: 'char:ruler', amount: '20' }, 6, makeFortune(`g${s}`), em, MED, 'seat:throne', []);
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
    const g2 = applyMediatedOp(pre, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '10' }, 7, makeFortune('d'), em, MED, 'seat:throne', []);
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
      applyMediatedOp(g0, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '5' }, 6, makeFortune(`met${s}`), em, MED, 'seat:throne', []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      expect(band).not.toBe('botched');
    }
  });

  it('slothful + poor band emits op.delayed informationally; the op still applies', () => {
    const g0 = world(0, { 'trait:slothful': true });
    for (let s = 0; s < 80; s++) {
      const em = makeEmitter(9);
      const g2 = applyMediatedOp(g0, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '5' }, 9, makeFortune(`sl${s}`), em, MED, 'seat:throne', []);
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
      const g2 = applyMediatedOp(g0, { kind: 'grant', charId: 'char:ruler', amount: '20' }, 10, makeFortune(`hi${s}`), em, MED, 'seat:throne', []);
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
    const g2 = applyMediatedOp(g0, { kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' }, 3, makeFortune('nd'), em, MED, 'seat:throne', []);
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
      const g2 = applyMediatedOp(g0, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '200' }, 5, makeFortune(`out${s}`), em, MED, 'seat:throne', []);
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
      const g2 = applyMediatedOp(g0, { kind: 'seize', charId: 'char:target', amount: '50' }, 5, makeFortune(`sz${s}`), em, MED, 'seat:throne', []);
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
      const g2 = applyMediatedOp(g0, { kind: 'hold_festival', placeId: 'place:ash', amount: '10' }, 5, makeFortune(`hf${s}`), em, MED, 'seat:throne', []);
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

// Task 4 (spec §3.5): willingness -- fortune-free by design. Whether the
// executor TRIES is character (deterministic, no dice, no Fortune
// parameter on willingnessOf's signature at all); how it LANDS is the
// world (the band draw, covered above). These four are the brief's exact
// scoring cases, turned into real tests against real constructed worlds.
describe('willingness (spec §3.5 — deterministic, no dice)', () => {
  // score = loyalty bp (default 5000 when no edge)
  //   +500 if OP domain matches the executor's current want's domain affinity
  //   (want 'coin'|'holding' -> econ; 'office'|'recognition' -> social; 'revenge' -> martial; else none)
  //   -2000 if op is imprison/seize targeting a character the executor holds a
  //     loyalty OR kinship edge toward ("asked to strike their own")
  //   vengeful executor + any grudge edge executor->target: refuses outright
  //   craven executor + martial domain: result is capped at 'drags'
  // thresholds: >=5500 complies; >=4000 drags; else refuses
  it('loyal steward complies; disloyal refuses; middle drags', () => {
    const g0 = world(5000); // aptitude is irrelevant to willingness; econ op, no target
    const op = { kind: 'decree_tax', placeId: 'place:ash', rateBp: 1000 } as const;

    const loyal = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 6000 } });
    expect(willingnessOf(loyal, 'char:st', op, 'char:ruler')).toBe('complies'); // 6000 >= 5500

    const disloyal = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 2000 } });
    expect(willingnessOf(disloyal, 'char:st', op, 'char:ruler')).toBe('refuses'); // 2000 < 4000

    const middling = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 4500 } });
    expect(willingnessOf(middling, 'char:st', op, 'char:ruler')).toBe('drags'); // 4000 <= 4500 < 5500
  });

  it('want-alignment bonus flips a 5200 to complies', () => {
    let g0 = world(5000);
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 5200 } });
    const op = { kind: 'decree_tax', placeId: 'place:ash', rateBp: 1000 } as const; // domain econ

    expect(willingnessOf(g0, 'char:st', op, 'char:ruler')).toBe('drags'); // 5200, no want set yet

    g0 = setNodeProp(g0, 'char:st', 'wantChain', ['coin']); // coin -> econ affinity
    g0 = setNodeProp(g0, 'char:st', 'wantIndex', 0);
    expect(willingnessOf(g0, 'char:st', op, 'char:ruler')).toBe('complies'); // 5200 + 500 = 5700
  });

  it('strike-their-own penalty forces refusal and emits op.refused with reason', () => {
    let g0 = world(9000); // the econ steward is irrelevant here -- this op is martial
    g0 = addNode(g0, { id: 'char:mar', type: 'character', props: { name: 'Marshal', 'apt:martial': 9000 } });
    g0 = addNode(g0, { id: 'office:marshal', type: 'office', props: { title: 'Marshal' } });
    g0 = addEdge(g0, { type: 'appointment', src: 'char:mar', dst: 'office:marshal', props: { since: 0 } });
    g0 = addNode(g0, { id: 'char:kin', type: 'character', props: { name: 'Kin' } });
    g0 = addEdge(g0, { type: 'kinship', src: 'char:mar', dst: 'char:kin', props: {} }); // the marshal's own blood
    // No loyalty edge char:mar -> char:ruler at all: default score 5000, then
    // -2000 for "asked to strike their own" (imprison + kinship to target) = 3000 < 4000.
    const op = { kind: 'imprison', charId: 'char:kin' } as const;
    expect(willingnessOf(g0, 'char:mar', op, 'char:ruler')).toBe('refuses');

    const em = makeEmitter(6);
    const g2 = applyMediatedOp(g0, op, 6, makeFortune('strike-own'), em, { ...MED, willingness: true }, 'seat:throne', []);
    expect(g2).toBe(g0); // nothing else happens: graph unchanged
    expect(em.all().some((e) => e.type === 'op.executed')).toBe(false);
    expect(em.all().some((e) => e.type === 'op.imprison')).toBe(false);
    const refused = em.all().find((e) => e.type === 'op.refused');
    expect(refused).toBeDefined();
    expect(refused!.data).toEqual({ opKind: 'imprison', executorId: 'char:mar', reason: 'disloyal' });
    expect(refused!.deltas).toEqual([]);
  });

  it('same inputs, same verdict — twice', () => {
    let g0 = world(5000);
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 4500 } });
    const op = { kind: 'decree_tax', placeId: 'place:ash', rateBp: 1000 } as const;
    const first = willingnessOf(g0, 'char:st', op, 'char:ruler');
    const second = willingnessOf(g0, 'char:st', op, 'char:ruler');
    expect(first).toBe('drags');
    expect(second).toBe(first);
  });

  it('boundary: loyalty bp exactly 5500 → complies (>= threshold)', () => {
    let g0 = world(5000);
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 5500 } });
    const op = { kind: 'decree_tax', placeId: 'place:ash', rateBp: 1000 } as const;
    expect(willingnessOf(g0, 'char:st', op, 'char:ruler')).toBe('complies');
  });

  it('boundary: loyalty bp exactly 5499 → drags (< complies threshold)', () => {
    let g0 = world(5000);
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 5499 } });
    const op = { kind: 'decree_tax', placeId: 'place:ash', rateBp: 1000 } as const;
    expect(willingnessOf(g0, 'char:st', op, 'char:ruler')).toBe('drags');
  });

  it('boundary: loyalty bp exactly 4000 → drags (>= drags threshold)', () => {
    let g0 = world(5000);
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 4000 } });
    const op = { kind: 'decree_tax', placeId: 'place:ash', rateBp: 1000 } as const;
    expect(willingnessOf(g0, 'char:st', op, 'char:ruler')).toBe('drags');
  });

  it('boundary: loyalty bp exactly 3999 → refuses (< drags threshold)', () => {
    let g0 = world(5000);
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 3999 } });
    const op = { kind: 'decree_tax', placeId: 'place:ash', rateBp: 1000 } as const;
    expect(willingnessOf(g0, 'char:st', op, 'char:ruler')).toBe('refuses');
  });
});

// Beyond the brief's four: the rest of the scoring spec (the vengeful/grudge
// override and the craven/martial cap) and applyMediatedOp's own behavior
// contract (drags capping the band + op.delayed, refuses touching neither
// the graph nor fortune, complies leaving the pre-Task-4 pipeline untouched).
describe('willingness integration: applyMediatedOp (spec §3.5)', () => {
  it('vengeful executor with a grudge against the op target refuses outright, regardless of score (reason "grudge")', () => {
    let g0 = world(9000, { 'trait:vengeful': true });
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 9000 } }); // would comply on score alone
    g0 = addNode(g0, { id: 'char:foe', type: 'character', props: { name: 'Foe' } });
    g0 = addEdge(g0, { type: 'grudge', src: 'char:st', dst: 'char:foe', props: { bp: 3000 } });
    const op = { kind: 'grant', charId: 'char:foe', amount: '5' } as const;
    expect(willingnessOf(g0, 'char:st', op, 'char:ruler')).toBe('refuses');

    const em = makeEmitter(6);
    const g2 = applyMediatedOp(g0, op, 6, makeFortune('venge'), em, { ...MED, willingness: true }, 'seat:throne', []);
    expect(g2).toBe(g0);
    expect(em.all().some((e) => e.type === 'op.executed')).toBe(false);
    const refused = em.all().find((e) => e.type === 'op.refused');
    expect(refused).toBeDefined();
    expect(refused!.data).toEqual({ opKind: 'grant', executorId: 'char:st', reason: 'grudge' });
    expect(refused!.deltas).toEqual([]);
  });

  it('craven executor + martial domain: complies caps down to drags; other domains are unaffected', () => {
    let g0 = world(5000);
    g0 = addNode(g0, { id: 'char:mar', type: 'character', props: { name: 'Marshal', 'trait:craven': true } });
    g0 = addNode(g0, { id: 'char:target', type: 'character', props: { name: 'Target' } });
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:mar', dst: 'char:ruler', props: { bp: 9000 } }); // score 9000 -> complies on paper
    const martialOp = { kind: 'imprison', charId: 'char:target' } as const; // no strike-own edge to char:target
    expect(willingnessOf(g0, 'char:mar', martialOp, 'char:ruler')).toBe('drags'); // capped -- never fully complies

    const econOp = { kind: 'decree_tax', placeId: 'place:ash', rateBp: 500 } as const;
    expect(willingnessOf(g0, 'char:mar', econOp, 'char:ruler')).toBe('complies'); // cap is martial-only
  });

  it('willingness "complies": identical outcome to willingness disabled, for the same seed', () => {
    let g0 = world(9000);
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 6000 } }); // complies
    const op = { kind: 'stockpile_grain', placeId: 'place:ash', amount: '10' } as const;

    const emOff = makeEmitter(4);
    const gOff = applyMediatedOp(g0, op, 4, makeFortune('cmp-eq'), emOff, MED, 'seat:throne', []);
    const emOn = makeEmitter(4);
    const gOn = applyMediatedOp(g0, op, 4, makeFortune('cmp-eq'), emOn, { ...MED, willingness: true }, 'seat:throne', []);

    expect(hashValue(gOn)).toBe(hashValue(gOff));
    expect(emOn.all()).toEqual(emOff.all());
  });

  it('willingness "drags": band never exceeds poor, and op.delayed fires exactly once at tick+2', () => {
    let g0 = world(9000); // high aptitude -- most raw draws would be sound/outstanding
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 4500 } }); // drags
    const op = { kind: 'stockpile_grain', placeId: 'place:ash', amount: '10' } as const;
    for (let s = 0; s < 20; s++) {
      const em = makeEmitter(6);
      applyMediatedOp(g0, op, 6, makeFortune(`drag${s}`), em, { ...MED, willingness: true }, 'seat:throne', []);
      const ex = em.all().find((e) => e.type === 'op.executed');
      const band = (ex!.data as { band: string }).band;
      expect(['botched', 'poor']).toContain(band); // capped: never sound/outstanding
      const delayed = em.all().filter((e) => e.type === 'op.delayed');
      expect(delayed).toHaveLength(1);
      expect((delayed[0]!.data as { untilTick: number }).untilTick).toBe(8); // tick 6 + 2
    }
  });

  it('willingness "drags" + slothful trait: still exactly one op.delayed (no double-emit)', () => {
    let g0 = world(9000, { 'trait:slothful': true });
    g0 = addEdge(g0, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 4500 } }); // drags
    const op = { kind: 'stockpile_grain', placeId: 'place:ash', amount: '10' } as const;
    for (let s = 0; s < 20; s++) {
      const em = makeEmitter(6);
      applyMediatedOp(g0, op, 6, makeFortune(`sldrag${s}`), em, { ...MED, willingness: true }, 'seat:throne', []);
      const delayed = em.all().filter((e) => e.type === 'op.delayed');
      expect(delayed).toHaveLength(1); // slothfulDelay and the willingness cap would both qualify -- only one fires
      expect((delayed[0]!.data as { untilTick: number }).untilTick).toBe(8);
    }
  });

  it('refusal consumes no fortune: the execution stream is never drawn, and a later draw on the same (tick, opKey) is unaffected', () => {
    const tick = 5;
    const op = { kind: 'stockpile_grain', placeId: 'place:ash', amount: '10' } as const;

    // Wrap a real Fortune so we can PROVE the execution-stream draw
    // (`.int`, the only thing drawBand calls) is never invoked on the
    // refusal path -- not merely infer it from the chronicle's silence.
    let intCalls = 0;
    const real = makeFortune('willingness-no-fortune');
    const spy: Fortune = {
      roll: real.roll,
      bp: real.bp,
      pick: real.pick,
      int: (stream, t, key, lo, hi, n) => {
        intCalls++;
        return real.int(stream, t, key, lo, hi, n);
      },
    };

    let gRefuse = world(9000);
    gRefuse = addEdge(gRefuse, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 2000 } }); // refuses

    const emR = makeEmitter(tick);
    const g2 = applyMediatedOp(gRefuse, op, tick, spy, emR, { ...MED, willingness: true }, 'seat:throne', []);
    expect(g2).toBe(gRefuse); // unchanged
    expect(emR.all().some((e) => e.type === 'op.executed')).toBe(false);
    expect(emR.all().some((e) => e.type === 'op.refused')).toBe(true);
    expect(intCalls).toBe(0); // the execution stream was never touched by the refusal

    let gComply = world(9000);
    gComply = addEdge(gComply, { type: 'loyalty', src: 'char:st', dst: 'char:ruler', props: { bp: 6000 } }); // complies

    // Independent, out-of-band reference draw for the exact same (tick,
    // opKey) the pipeline below is about to use. Fortune is a pure hash of
    // (stream, tick, key, n) -- never a sequential/counter-advancing RNG
    // (D21 stream discipline) -- so if the refusal above had secretly
    // consumed or perturbed anything, it would show up here as a mismatch
    // against the pipeline's own draw.
    const expectedBand = drawBand(aptOf(gComply, 'char:st', 'apt:econ'), spy, tick, canonJson(op));

    const emC = makeEmitter(tick);
    applyMediatedOp(gComply, op, tick, spy, emC, { ...MED, willingness: true }, 'seat:throne', []);
    const ex = emC.all().find((e) => e.type === 'op.executed');
    expect(ex).toBeDefined();
    expect((ex!.data as { band: string }).band).toBe(expectedBand);
  });
});
