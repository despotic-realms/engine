import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { ECON } from '../src/constants.js';
import { FX_ONE, FX_ZERO, divFx, fx, fxFromInt, mulFx } from '../src/fx.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { makeFortune } from '../src/fortune.js';
import { getNode, propFx, propInt, setNodeProp, addNode } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
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
  // Re-pinned for Task 1 of the renderer-law wave (2026-08-16 product
  // decision: famine deaths are reported in WHOLE PEOPLE, accumulated --
  // no fractional corpses anywhere player/chronicle-visible, ever again).
  // This fixture's raw attrition (22.5, see the original comment below)
  // crosses the whole-person threshold on this very first shortfall tick
  // -- carryBefore is 0 (place:thornfield has never gone hungry before),
  // so carryAfter == attrition == 22.5, well past 1.0 -- so `unrest`'s
  // FINAL VALUE is EXACTLY UNCHANGED from the pre-accumulator pin (same
  // formula, same tick, still gated on the same shortfall). Its MECHANISM
  // did move, though (controller adjudication, 2026-08-16, post-Task-1
  // review: unrest reacts to shortfall independent of the death crossing,
  // restoring exact v0.3.1 dynamics -- see src/systems.ts) -- unrest now
  // rides granary.consumed's deltas, not famine.starvation's, which this
  // test re-verifies directly below rather than only trusting the final
  // state. Only `population`/`deaths` move from the pre-accumulator pin,
  // from the fractional 22.5 to floor(22.5) = 22, with the 0.5 remainder
  // now parked in the new `deathsCarry` prop instead of silently vanishing
  // into a fractional population digit.
  it('famine: shortfall raises unrest and kills -- in whole people, accumulated; unrest decoupled from the death crossing', () => {
    let g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'granary', fx('10'));
    const em = makeEmitter(1);
    const g = economyStep(g0, 1, f, em);
    const p = getNode(g, 'place:thornfield').props;
    expect(propFx(p, 'granary')).toBe(fx('0'));
    expect(propFx(p, 'unrest')).toBe(fx('42.5'));    // 20 + 25 * 90/100 -- unchanged, see above
    expect(propFx(p, 'population')).toBe(fx('478')); // 500 - 22 (was 500 - 22.5 pre-accumulator)
    expect(propFx(p, 'deathsCarry')).toBe(fx('0.5')); // 22.5 raw attrition - 22 whole deaths
    const consumedEv = em.all().find((e) => e.type === 'granary.consumed');
    expect(consumedEv?.deltas).toContainEqual({ op: 'node.set', id: 'place:thornfield', key: 'unrest', value: fx('42.5') }); // unrest rides HERE now
    const ev = em.all().find((e) => e.type === 'famine.starvation');
    expect(ev).toBeDefined();
    expect(ev?.data['deaths']).toBe(22); // plain integer now, not an fx string (was fx('22.5'))
    expect(typeof ev?.data['deaths']).toBe('number');
    expect(ev?.data['shortfall']).toBe('90'); // shortfall itself stays fx-string, unchanged
    expect(ev?.deltas).toEqual([{ op: 'node.set', id: 'place:thornfield', key: 'population', value: fx('478') }]); // NOT unrest -- decoupled
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

// Task 1 (renderer-law wave, 2026-08-16): whole-person deaths accumulator.
// Product decision: famine deaths are reported in WHOLE PEOPLE,
// accumulated -- no fractional corpses anywhere player/chronicle-visible,
// ever again. Attrition math stays continuous (fx) internally, folded into
// a per-place `deathsCarry` fx prop; famine.starvation only fires (and
// only ever fires ONCE per tick) once the carry crosses a whole person,
// reporting `deaths` as a plain integer. See src/systems.ts's consumption
// step (point 3) for the implementation this suite pins.
describe('deaths accumulator (whole-person deaths, 2026-08-16)', () => {
  // A hand-verified staircase. population 9, granary/farmland pinned to 0
  // (so the harvest can never replenish the granary and the granary itself
  // never absorbs any of the shortfall) makes the per-tick shortfall equal
  // to `need` exactly, and with CONSUME_PER_POP=0.2 and the 0.05 attrition
  // rate, attrition = population * 0.05 -- 9 * 0.05 = 0.45/tick before any
  // death. Every value asserted below (including the population-feedback
  // effect: a whole-person death drops population, which drops next
  // tick's `need`, hence attrition, by exactly 0.05/tick from then on,
  // since population*0.05 is linear) was independently hand-derived in
  // exact fx (bigint) arithmetic, not read back from a first
  // implementation run:
  //   t1: carry 0.00->0.45                                  (no event)
  //   t2: carry 0.45->0.90                                  (no event)
  //   t3: carry 0.90->1.35 -> deaths=1, remainder 0.35; population 9->8
  //   t4: carry 0.35->0.75 (rate now 8*0.05=0.40)            (no event)
  //   t5: carry 0.75->1.15 -> deaths=1, remainder 0.15; population 8->7
  //
  // unrest is DECOUPLED from the deaths crossing (controller adjudication,
  // 2026-08-16: the product decision changed death reporting, not unrest
  // dynamics -- unrest must react on every shortfall tick exactly as
  // v0.3.1 did, whether or not a death lands). In this fixture shortfall
  // == need exactly every tick (granary/dole pinned at 0), so
  // divFx(shortfall, need) == FX_ONE exactly regardless of population,
  // making unrestDelta a CONSTANT fx('25') every single tick:
  //   t1: unrest 20->45     t2: 45->70      t3: 70->95
  //   t4: 95->120, clamped to UNREST_MAX=100   t5: 100->125, clamped to 100
  function staircaseFixture(): WorldGraph {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'population', fx('9'));
    g = setNodeProp(g, 'place:thornfield', 'granary', fx('0'));
    g = setNodeProp(g, 'place:thornfield', 'farmland', fx('0'));
    return g;
  }

  it('created on first use: a never-hungry place carries no deathsCarry prop at all', () => {
    const g = staircaseFixture();
    expect(getNode(g, 'place:thornfield').props['deathsCarry']).toBeUndefined();
  });

  it('a place that never runs a shortfall never gains a deathsCarry prop, ever', () => {
    const em = makeEmitter(1);
    const g = economyStep(thornfieldGraph(), 1, f, em); // default fixture: granary 250 comfortably covers need 100
    expect(em.all().some((e) => e.type === 'famine.starvation')).toBe(false);
    expect('deathsCarry' in getNode(g, 'place:thornfield').props).toBe(false);
  });

  it('ticks 1-2 accumulate silently (no famine.starvation even though shortfall > 0 -- but unrest still reacts, decoupled from the death crossing); tick 3 crosses into deaths=1 with pop down exactly one and the hand-derived remainder carried; tick 4 stays quiet on deaths at the population-adjusted rate (unrest keeps climbing regardless); tick 5 crosses again for a second death', () => {
    let g = staircaseFixture();

    const em1 = makeEmitter(1);
    g = economyStep(g, 1, f, em1);
    expect(em1.all().some((e) => e.type === 'famine.starvation')).toBe(false);
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.45'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'population')).toBe(fx('9'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'unrest')).toBe(fx('45')); // 20 + 25 -- moves despite NO death this tick

    const em2 = makeEmitter(2);
    g = economyStep(g, 2, f, em2);
    expect(em2.all().some((e) => e.type === 'famine.starvation')).toBe(false);
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.9'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'population')).toBe(fx('9'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'unrest')).toBe(fx('70')); // 45 + 25 -- again, still no death

    const em3 = makeEmitter(3);
    g = economyStep(g, 3, f, em3);
    const ev3 = em3.all().find((e) => e.type === 'famine.starvation');
    expect(ev3).toBeDefined();
    expect(ev3?.data['deaths']).toBe(1);
    expect(typeof ev3?.data['deaths']).toBe('number');
    expect(ev3?.data['shortfall']).toBe('1.8'); // shortfall stays fx-string, unchanged
    expect(ev3?.deltas).toEqual([{ op: 'node.set', id: 'place:thornfield', key: 'population', value: fx('8') }]); // famine.starvation's OWN deltas: population only, unrest already moved on granary.consumed
    expect(propFx(getNode(g, 'place:thornfield').props, 'population')).toBe(fx('8')); // 9 - 1
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.35')); // 1.35 - 1
    expect(propFx(getNode(g, 'place:thornfield').props, 'unrest')).toBe(fx('95')); // 70 + 25 -- same formula, a death also happens to land

    const em4 = makeEmitter(4);
    g = economyStep(g, 4, f, em4);
    expect(em4.all().some((e) => e.type === 'famine.starvation')).toBe(false);
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.75')); // 0.35 + (8*0.05=0.40)
    expect(propFx(getNode(g, 'place:thornfield').props, 'population')).toBe(fx('8'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'unrest')).toBe(fx('100')); // 95 + 25 = 120, clamped to UNREST_MAX -- still moves with NO death this tick

    const em5 = makeEmitter(5);
    g = economyStep(g, 5, f, em5);
    const ev5 = em5.all().find((e) => e.type === 'famine.starvation');
    expect(ev5).toBeDefined();
    expect(ev5?.data['deaths']).toBe(1);
    expect(propFx(getNode(g, 'place:thornfield').props, 'population')).toBe(fx('7')); // 8 - 1
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.15')); // 1.15 - 1
    expect(propFx(getNode(g, 'place:thornfield').props, 'unrest')).toBe(fx('100')); // 100 + 25 = 125, clamped -- already saturated
  });

  it('a large single-tick shortfall that pushes the carry two whole persons past its threshold still emits exactly ONE famine.starvation event, with deaths=2 -- not two events', () => {
    let g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'population', fx('45'));
    g0 = setNodeProp(g0, 'place:thornfield', 'granary', fx('0'));
    g0 = setNodeProp(g0, 'place:thornfield', 'farmland', fx('0'));
    const em = makeEmitter(1);
    const g = economyStep(g0, 1, f, em);
    const events = em.all().filter((e) => e.type === 'famine.starvation');
    expect(events).toHaveLength(1);
    expect(events[0]?.data['deaths']).toBe(2); // attrition 45*0.05 = 2.25 -> floor 2
    expect(events[0]?.data['shortfall']).toBe('9');
    expect(propFx(getNode(g, 'place:thornfield').props, 'population')).toBe(fx('43')); // 45 - 2
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.25')); // 2.25 - 2
  });

  it('conservation over a long run: deathsCarry + cumulative deaths equals cumulative raw attrition, exactly, every tick -- deaths never exceeds attrition, and the gap never reaches a whole person', () => {
    let g = staircaseFixture();
    let cumulativeDeaths = 0;
    let expectedAttrition = FX_ZERO;
    const TICKS = 20;
    for (let tick = 1; tick <= TICKS; tick++) {
      const popBefore = propFx(getNode(g, 'place:thornfield').props, 'population');
      // Shadow of src/systems.ts's own formula (granary/dole are pinned at
      // 0 throughout this fixture, so shortfall === need exactly):
      const need = mulFx(popBefore, ECON.CONSUME_PER_POP);
      const attrition = mulFx(divFx(need, ECON.CONSUME_PER_POP), fx('0.05'));
      expectedAttrition = expectedAttrition + attrition;
      const em = makeEmitter(tick);
      g = economyStep(g, tick, f, em);
      const ev = em.all().find((e) => e.type === 'famine.starvation');
      if (ev) cumulativeDeaths += ev.data['deaths'] as number;
    }
    const deathsFx = fxFromInt(cumulativeDeaths);
    const finalCarry = propFx(getNode(g, 'place:thornfield').props, 'deathsCarry');
    expect(deathsFx + finalCarry).toBe(expectedAttrition); // exact conservation, no leak, nothing invented
    expect(deathsFx <= expectedAttrition).toBe(true);
    expect(expectedAttrition < deathsFx + FX_ONE).toBe(true);
    expect(finalCarry >= FX_ZERO).toBe(true);
    expect(finalCarry < FX_ONE).toBe(true);
  });

  it('replay-equivalence: a tick where the carry accumulates but stays under one whole person still replays exactly -- the deathsCarry write travels on granary.consumed\'s own deltas, not a silent mutation', () => {
    const g0 = staircaseFixture();
    const em = makeEmitter(1);
    const post = economyStep(g0, 1, f, em);
    expect(em.all().some((e) => e.type === 'famine.starvation')).toBe(false); // this IS the non-crossing branch
    const deltas = em.all().flatMap((e) => e.deltas);
    expect(deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
    expect(propFx(getNode(replayed, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.45'));
  });

  it('replay-equivalence: a tick that crosses into a death replays exactly across BOTH events (granary.consumed + famine.starvation)', () => {
    const g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'granary', fx('10'));
    const em = makeEmitter(1);
    const post = economyStep(g0, 1, f, em);
    expect(em.all().some((e) => e.type === 'famine.starvation')).toBe(true);
    const deltas = em.all().flatMap((e) => e.deltas);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });

  it('determinism: two independent economyStep calls on identical shortfall input produce byte-identical output graphs and event data', () => {
    const g0 = setNodeProp(thornfieldGraph(), 'place:thornfield', 'granary', fx('10'));
    const emA = makeEmitter(1);
    const emB = makeEmitter(1);
    const gA = economyStep(g0, 1, f, emA);
    const gB = economyStep(g0, 1, f, emB);
    expect(hashValue(gA)).toBe(hashValue(gB));
    expect(emA.all().map((e) => ({ type: e.type, data: e.data }))).toEqual(emB.all().map((e) => ({ type: e.type, data: e.data })));
  });

  it('order-stability: two famine-affected places in the same tick get independent carries, emitted in sorted-id order, with no cross-contamination', () => {
    let g = thornfieldGraph();
    g = setNodeProp(g, 'place:thornfield', 'granary', fx('10')); // big shortfall, crosses this tick
    g = addNode(g, {
      id: 'place:aardvark', type: 'place', // sorts before 'place:thornfield'
      props: {
        name: 'Aardvark', population: fx('9'), granary: fx('0'), farmland: fx('0'),
        unrest: fx('20'), dole: fx('0'), taxRateBp: 0, roadsBonusBp: 0, defenseBp: 0,
        famineStage: 0, famineEndsAt: 0, levy: fx('0'),
      },
    });
    const em = makeEmitter(1);
    const g2 = economyStep(g, 1, f, em);

    const consumed = em.all().filter((e) => e.type === 'granary.consumed');
    expect(consumed.map((e) => e.data['placeId'])).toEqual(['place:aardvark', 'place:thornfield']); // sorted-id order

    const starved = em.all().filter((e) => e.type === 'famine.starvation');
    expect(starved).toHaveLength(1); // aardvark's shortfall never crosses a whole person this tick
    expect(starved[0]?.data['placeId']).toBe('place:thornfield');
    expect(starved[0]?.data['deaths']).toBe(22);

    expect(propFx(getNode(g2, 'place:aardvark').props, 'deathsCarry')).toBe(fx('0.45'));
    expect(propFx(getNode(g2, 'place:aardvark').props, 'population')).toBe(fx('9')); // untouched, no death
    expect(propFx(getNode(g2, 'place:thornfield').props, 'population')).toBe(fx('478')); // 500 - 22
    expect(propFx(getNode(g2, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.5')); // 22.5 - 22
  });

  it('carry persists untouched across an intervening well-fed tick -- no reset, no silent decay -- and resumes exactly where it left off', () => {
    let g = staircaseFixture();
    g = economyStep(g, 1, f, makeEmitter(1)); // carry -> 0.45
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.45'));

    // Tick 2: granary is topped up enough to fully cover this tick's need
    // (population still 9, need 1.8) -- no shortfall, so the accumulator
    // branch never runs at all this tick.
    g = setNodeProp(g, 'place:thornfield', 'granary', fx('50'));
    const em2 = makeEmitter(2);
    g = economyStep(g, 2, f, em2);
    expect(em2.all().some((e) => e.type === 'famine.starvation')).toBe(false);
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.45')); // untouched, not reset

    // Tick 3: hand-drain the granary back to 0 to resume the famine (tick
    // 2 left it at 48.2, nowhere near exhausted) and confirm the carry
    // resumes accumulating from 0.45, not from a reset 0.
    g = setNodeProp(g, 'place:thornfield', 'granary', fx('0'));
    const em3 = makeEmitter(3);
    g = economyStep(g, 3, f, em3);
    expect(em3.all().some((e) => e.type === 'famine.starvation')).toBe(false);
    expect(propFx(getNode(g, 'place:thornfield').props, 'deathsCarry')).toBe(fx('0.9')); // 0.45 + 0.45, resumed
  });
});
