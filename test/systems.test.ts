import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { fx } from '../src/fx.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { makeFortune } from '../src/fortune.js';
import { getNode, propFx, propInt, setNodeProp, addNode } from '../src/graph.js';
import { economyStep } from '../src/systems.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';

const f = makeFortune('systems-test-seed');

describe('economyStep', () => {
  it('a quiet tick: consumption and skim only', () => {
    const em = makeEmitter(1);
    const g = economyStep(thornfieldGraph(), 1, f, em); // not autumn, not winter
    expect(propFx(getNode(g, 'place:thornfield').props, 'granary')).toBe(fx('150')); // 250 - 500*0.2
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('297'));      // 300 - skim 3
    expect(em.all().some((e) => e.type === 'ledger.skimmed')).toBe(true);
  });
  it('autumn: harvest with fortune provenance, tax, roads bonus', () => {
    const em = makeEmitter(2);
    const g = economyStep(thornfieldGraph(), 2, f, em);
    const ev = em.all().find((e) => e.type === 'harvest.reaped');
    expect(ev).toBeDefined();
    expect(ev?.data['stream']).toBe('harvest');
    expect(typeof ev?.data['bp']).toBe('number');
    // exact math cross-check using the same draw the engine used
    const bp = f.bp('harvest', 2, 'place:thornfield');
    const yieldFx = (fx('180') * fx('2.4') / 10_000n) * BigInt(5000 + bp) / 10_000n;
    const expectYield = yieldFx - (yieldFx * 2000n / 10_000n); // minus 20% tax in grain
    const granary = propFx(getNode(g, 'place:thornfield').props, 'granary');
    expect(granary).toBe(fx('250') + expectYield - fx('100'));
  });
  it('famine: shortfall raises unrest and kills', () => {
    let g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'granary', fx('10'));
    const em = makeEmitter(1);
    const g = economyStep(g0, 1, f, em);
    const p = getNode(g, 'place:thornfield').props;
    expect(propFx(p, 'granary')).toBe(fx('0'));
    expect(propFx(p, 'unrest')).toBe(fx('42.5'));      // 20 + 25 * 90/100
    expect(propFx(p, 'population')).toBe(fx('477.5')); // 500 - (90/0.2)*0.05
    expect(em.all().some((e) => e.type === 'famine.starvation')).toBe(true);
  });
  it('winter: liege tribute paid, or defaulted into arrears', () => {
    const em = makeEmitter(3);
    const paid = economyStep(thornfieldGraph(), 3, f, em);
    expect(propFx(getNode(paid, 'inst:crown').props, 'treasury')).toBe(fx('177')); // 300 - skim 3 - 120
    let poor = setNodeProp(thornfieldGraph(), 'inst:crown', 'treasury', fx('50'));
    const em2 = makeEmitter(3);
    const g2 = economyStep(poor, 3, f, em2);
    expect(propFx(getNode(g2, 'inst:crown').props, 'arrears')).toBe(fx('120'));
    expect(propFx(getNode(g2, 'inst:crown').props, 'legitimacy')).toBe(fx('40'));
    expect(em2.all().some((e) => e.type === 'tribute.defaulted')).toBe(true);
  });
  it('projects mature and carry their causal parent', () => {
    let g0 = addNode(thornfieldGraph(), {
      id: 'proj:irrigation:place:thornfield', type: 'project',
      props: { placeId: 'place:thornfield', project: 'irrigation', amount: fx('80'), maturesAt: 11, matured: false, causeEventId: 't3.0' },
    });
    const em = makeEmitter(11);
    const g = economyStep(g0, 11, f, em);
    expect(propFx(getNode(g, 'place:thornfield').props, 'farmland')).toBe(fx('216')); // 180 * 1.2
    const ev = em.all().find((e) => e.type === 'project.matured');
    expect(ev?.parents).toEqual(['t3.0']);
  });
});

// D14: chronicle events ARE graph deltas, here too. economyStep must express
// every mutation it makes as some emitted event's deltas -- concatenating
// every event's deltas (in emission order) and replaying them onto the
// pre-step graph must reproduce exactly the graph economyStep itself
// returned. This only holds if EVERY setNodeProp/setEdgeProp economyStep
// performs flows through applyDeltas on an array some event actually
// carries -- that's the property under test, mirroring ops.test.ts's
// "applyOp delta-equivalence" suite.
describe('economyStep delta-equivalence (spec D14)', () => {
  it('tick 3, poor treasury (tribute.defaulted branch): concatenated event deltas replay to the same graph', () => {
    const g0 = setNodeProp(thornfieldGraph(), 'inst:crown', 'treasury', fx('50'));
    const em = makeEmitter(3);
    const post = economyStep(g0, 3, f, em);
    const deltas = em.all().flatMap((e) => e.deltas);
    expect(deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });
  it('tick 11, mature project: concatenated event deltas replay to the same graph', () => {
    const g0 = addNode(thornfieldGraph(), {
      id: 'proj:irrigation:place:thornfield', type: 'project',
      props: { placeId: 'place:thornfield', project: 'irrigation', amount: fx('80'), maturesAt: 11, matured: false, causeEventId: 't3.0' },
    });
    const em = makeEmitter(11);
    const post = economyStep(g0, 11, f, em);
    const deltas = em.all().flatMap((e) => e.deltas);
    expect(deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });
  // The two cases above never touch harvest.reaped, dole.distributed, or
  // famine.starvation -- the two cases below round those out, so every
  // event type economyStep can emit gets its delta-completeness checked
  // somewhere in this suite.
  it('tick 2, autumn on the default fixture (harvest.reaped branch): concatenated event deltas replay to the same graph', () => {
    const g0 = thornfieldGraph();
    const em = makeEmitter(2);
    const post = economyStep(g0, 2, f, em);
    expect(em.all().map((e) => e.type)).toContain('harvest.reaped');
    const deltas = em.all().flatMap((e) => e.deltas);
    expect(deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });
  // A non-autumn tick, so harvest can't replenish the granary mid-step:
  // dole covers part of need, the thin granary can't cover the rest, so
  // dole.distributed and famine.starvation both fire deterministically
  // (no dependence on fortune's draw) alongside granary.consumed.
  it('tick 1, dole partially covers need and granary falls short (dole.distributed + famine.starvation branch): concatenated event deltas replay to the same graph', () => {
    let g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'dole', fx('30'));
    g0 = setNodeProp(g0, 'place:thornfield', 'granary', fx('10'));
    const em = makeEmitter(1);
    const post = economyStep(g0, 1, f, em);
    const types = em.all().map((e) => e.type);
    expect(types).toContain('dole.distributed');
    expect(types).toContain('famine.starvation');
    const deltas = em.all().flatMap((e) => e.deltas);
    expect(deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });
});

// The granary decrement from baseline consumption is headline chronicle
// material (a silent mutation here would leave events unable to describe
// the famine visually) -- it gets its own event, distinct from the
// dole-relief mutation in dole.distributed.
describe('granary.consumed', () => {
  it('is emitted for baseline consumption, carrying the granary decrement as its deltas', () => {
    const em = makeEmitter(1);
    economyStep(thornfieldGraph(), 1, f, em);
    const ev = em.all().find((e) => e.type === 'granary.consumed');
    expect(ev).toBeDefined();
    expect(ev?.data['placeId']).toBe('place:thornfield');
    expect(ev?.deltas.length).toBeGreaterThan(0);
  });
});

// Regression pins for formula branches the suite above exercises only
// incidentally, or not at all: roads income scaling, the over-2500bp
// tax-rate unrest sting, the famine yield malus, and non-irrigation project
// maturity. These pin already-correct, already-reviewed behavior (values
// verified by hand below) -- there is no RED step here, since nothing in
// src/systems.ts changed for this round.
describe('economyStep formula branches (regression pins)', () => {
  it('roads bonus scales treasury harvest income by exactly 1.05x', () => {
    const g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'roadsBonusBp', 500);
    const em = makeEmitter(2);
    const g = economyStep(g0, 2, f, em);
    // exact math cross-check using the same draw the engine used (mirrors the
    // "autumn" test above, extended with the roads income factor)
    const bp = f.bp('harvest', 2, 'place:thornfield');
    const yieldFx = (fx('180') * fx('2.4') / 10_000n) * BigInt(5000 + bp) / 10_000n;
    const taxGrain = yieldFx * 2000n / 10_000n; // taxRateBp 2000 (default; unaffected by roadsBonusBp)
    const income = (taxGrain * fx('0.5') / 10_000n) * 10_500n / 10_000n; // GRAIN_PRICE 0.5, x(10_000+500bp)/10_000 = x1.05
    const treasury = propFx(getNode(g, 'inst:crown').props, 'treasury');
    expect(treasury).toBe(fx('300') + income - fx('3')); // start 300, + harvest income, - skim 3
  });

  it('tax sting: taxRateBp above 2500bp raises unrest by exactly the sting formula', () => {
    const g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'taxRateBp', 4000);
    const preUnrest = propFx(getNode(g0, 'place:thornfield').props, 'unrest'); // fx('20'), nowhere near the [0,100] clamp
    const em = makeEmitter(2);
    const g = economyStep(g0, 2, f, em);
    const unrest = propFx(getNode(g, 'place:thornfield').props, 'unrest');
    // divFx(fxFromInt(4000-2500), fx('100')) = fx('15'). Consumption doesn't touch unrest here:
    // even taxed at 40% the harvest leaves the granary far above the population's need, so no
    // dole/famine event fires to confound the sting-only delta.
    expect(unrest).toBe(preUnrest + fx('15'));
  });

  it('famine malus: famineStage >= 1 scales the harvest yield to exactly 0.3x of the unfamined draw', () => {
    // tick 6 (bp=3866, baseMult=8866) is order-sensitive: folding x0.3 into the multiplier first
    // (src/systems.ts's actual order) lands on a different floor than folding it into the finished
    // yield afterward -- tick 2's draw (bp=6310, baseMult=11310) coincidentally agrees under both
    // orders, so it wouldn't actually catch a fold-order regression. Pin on the draw that would.
    const tick = 6;
    const bp = f.bp('harvest', tick, 'place:thornfield'); // same draw feeds both scenarios below
    const baseMult = BigInt(5000 + bp);
    // Matches src/systems.ts's actual order: the malus is folded into the weather multiplier
    // BEFORE that multiplier is multiplied into the yield -- not applied to the unfamined yield
    // afterward. Floor-rounding at fixed scale is not associative across two chained
    // multiplications (folding x0.3 in early vs. late can land on different floors), so this
    // replicates the implementation's actual order to get a bit-exact expectation, not a
    // merely-close one.
    const maluseldMult = baseMult * fx('0.3') / 10_000n;
    const yieldUnfamined = (fx('180') * fx('2.4') / 10_000n) * baseMult / 10_000n;
    const yieldFamined = (fx('180') * fx('2.4') / 10_000n) * maluseldMult / 10_000n;

    const emBase = makeEmitter(tick);
    const gUnfamined = economyStep(thornfieldGraph(), tick, f, emBase);
    const evUnfamined = emBase.all().find((e) => e.type === 'harvest.reaped');
    expect(fx(evUnfamined?.data['yield'] as string)).toBe(yieldUnfamined);

    const faminedStart = setNodeProp(thornfieldGraph(), 'place:thornfield', 'famineStage', 1);
    const emFamine = makeEmitter(tick);
    const gFamined = economyStep(faminedStart, tick, f, emFamine);
    const evFamined = emFamine.all().find((e) => e.type === 'harvest.reaped');
    expect(fx(evFamined?.data['yield'] as string)).toBe(yieldFamined);

    // Granary deltas: net grain added by the harvest (yield minus 20% tax) on top of the shared
    // fx('250') starting granary and fx('100') baseline consumption -- no shortfall in either case.
    const netUnfamined = yieldUnfamined - (yieldUnfamined * 2000n / 10_000n);
    const netFamined = yieldFamined - (yieldFamined * 2000n / 10_000n);
    expect(propFx(getNode(gUnfamined, 'place:thornfield').props, 'granary')).toBe(fx('250') + netUnfamined - fx('100'));
    expect(propFx(getNode(gFamined, 'place:thornfield').props, 'granary')).toBe(fx('250') + netFamined - fx('100'));
  });

  it('roads and walls projects mature together: roadsBonusBp +500, defenseBp +1500, both matured', () => {
    let g0 = addNode(thornfieldGraph(), {
      id: 'proj:roads:place:thornfield', type: 'project',
      props: { placeId: 'place:thornfield', project: 'roads', amount: fx('80'), maturesAt: 11, matured: false, causeEventId: 't3.0' },
    });
    g0 = addNode(g0, {
      id: 'proj:walls:place:thornfield', type: 'project',
      props: { placeId: 'place:thornfield', project: 'walls', amount: fx('80'), maturesAt: 11, matured: false, causeEventId: 't3.1' },
    });
    const em = makeEmitter(11);
    const g = economyStep(g0, 11, f, em);
    expect(propInt(getNode(g, 'place:thornfield').props, 'roadsBonusBp')).toBe(500); // 0 + 500
    expect(propInt(getNode(g, 'place:thornfield').props, 'defenseBp')).toBe(1500);   // 0 + 1500
    expect(getNode(g, 'proj:roads:place:thornfield').props['matured']).toBe(true);
    expect(getNode(g, 'proj:walls:place:thornfield').props['matured']).toBe(true);
    expect(em.all().filter((e) => e.type === 'project.matured')).toHaveLength(2);
  });
});

describe('levy upkeep', () => {
  it('paid: treasury drops by levy * LEVY_UPKEEP with a delta-carrying event', () => {
    const g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'levy', fx('100'));
    const em = makeEmitter(1);
    const g = economyStep(g0, 1, f, em);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('282')); // 300 - 3 skim - 15 upkeep
    const ev = em.all().find((e) => e.type === 'levy.paid');
    expect(ev?.deltas.length).toBeGreaterThan(0);
  });
  it('unaffordable: 10% desert instead, treasury untouched by upkeep', () => {
    let g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'levy', fx('100'));
    g0 = setNodeProp(g0, 'inst:crown', 'treasury', fx('10'));
    const em = makeEmitter(1);
    const g = economyStep(g0, 1, f, em);
    expect(propFx(getNode(g, 'place:thornfield').props, 'levy')).toBe(fx('90'));
    expect(em.all().some((e) => e.type === 'levy.deserted')).toBe(true);
  });
});
