// Causality §1: recency casting. Briefs that just became possible deal
// before briefs that have been sitting eligible -- the foundation for "the
// world answers the player" (later tasks add computed attribution and
// booked follow-ups on top of this same [newly, standing] partition).
//
// Two levels of fixture:
//  - mkBriefEntry (mirrors test/scheduler.test.ts's helper): synthetic
//    brief-kind EligibleEntry values for exercising examiner.select's
//    partition/budget bookkeeping directly, without routing through
//    eligibleStorylets/a real deck.
//  - seasonWith: a minimal real SeasonConfig (thornfieldGraph() world,
//    starterSeason()'s throne/reporters/tierRules) carrying hand-built
//    storylets whose eligibility this file fully controls, for the
//    resolveTick-level (ReignState round-trip) tests.
import { describe, expect, it } from 'vitest';
import { makeFortune } from '../src/fortune.js';
import { setNodeProp } from '../src/graph.js';
import { examiner } from '../src/scheduler.js';
import { eligibleStorylets } from '../src/storylet.js';
import { starterSeason } from '../src/decks/starter.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import { initialState, resolveTick, type SeasonConfig } from '../src/tick.js';
import type { EligibleEntry, Storylet } from '../src/storylet.js';

function mkBriefEntry(id: string): EligibleEntry {
  const storylet: Storylet = {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [] },
    title: id, body: id,
    options: [
      { id: 'a', label: 'a', ops: [] },
      { id: 'b', label: 'b', ops: [] },
    ],
    defaultOptionId: 'a',
  };
  return { storylet, binding: {}, instanceKey: id };
}

// Unconditionally eligible against thornfieldGraph() (matches the lone
// 'place' node, no where-clause) -- stays eligible every tick regardless of
// cast history, so the pool composition across ticks is fully predictable.
function mkAlways(id: string): Storylet {
  return {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [{ as: 'p', type: 'place' }] },
    title: id, body: id,
    options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
    defaultOptionId: 'skip',
  };
}

// Ineligible until the custom 'flagged' prop (never touched by economyStep/
// socialStep/advanceArcs -- an unknown key to every systems pass) flips
// true, letting a test move a storylet from ineligible to eligible on
// command, deterministically, without routing an op through resolveTick's
// decision pipeline.
function mkGated(id: string): Storylet {
  return {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'flagged', cmp: 'eq', value: true }] }] },
    title: id, body: id,
    options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
    defaultOptionId: 'skip',
  };
}

// Reuses starterSeason()'s throne/reporters/tierRules/initialGraph (same
// trick test/tick.test.ts's custom-season fixture uses) so only what this
// file actually varies -- the deck's storylets and the tier's briefBudget --
// is overridden. calendar: [] throughout: T1 is about the casting stream,
// not probes.
function seasonWith(storylets: Storylet[], briefBudget: number): SeasonConfig {
  const base = starterSeason();
  return {
    ...base,
    decks: [{ id: 'starter', tier: 1, storylets }],
    tiers: { ...base.tiers, 1: { ...base.tiers[1]!, briefBudget } },
    calendar: [],
  };
}

const f = makeFortune('recency-test-seed');
const empty = { seatId: 'seat:throne', choices: [] };

describe('examiner.select: recency partition (causality §1)', () => {
  it('a newly-eligible instance is dealt before a standing instance at equal presented counts; a tied newly/newly pair still resolves by the seeded lottery', () => {
    const pool = [mkBriefEntry('standing'), mkBriefEntry('newly')];
    const presented = { standing: 0, newly: 0 };

    // tick: 0 (not an arbitrary choice) -- at this fixture's seed, the flat
    // pre-T1 lottery over the tied [standing, newly] pair happens to draw
    // 'standing' at tick 0 (verified by brute-force search over ticks
    // 0..50), so this is genuine RED against the unmodified scheduler, not
    // a coincidental pass from the lottery guessing the "right" answer for
    // the wrong reason.
    const sel = examiner.select({
      tick: 0, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented,
      newlyEligible: new Set(['newly']),
    });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['newly']);

    // Same fixture, but BOTH instances are newly-eligible this time: the
    // recency partition no longer distinguishes them, so it collapses back
    // to the plain D13 seeded lottery over the tied [0,0] stratum -- fortune
    // decides, exactly as it would pre-T1.
    const bothNewly = examiner.select({
      tick: 0, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented,
      newlyEligible: new Set(['standing', 'newly']),
    });
    const expectedPick = f.pick('casting', 0, 'slot', pool, 0);
    expect(bothNewly.chosen).toEqual([expectedPick]);
  });

  it('within the newly-eligible partition, D13 novelty still governs: the least-presented instance wins', () => {
    const pool = [mkBriefEntry('newly-shown-twice'), mkBriefEntry('newly-fresh')];
    const presented = { 'newly-shown-twice': 2, 'newly-fresh': 0 };
    const sel = examiner.select({
      tick: 4, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented,
      newlyEligible: new Set(['newly-shown-twice', 'newly-fresh']),
    });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['newly-fresh']);
  });

  it('a fortune-slot collision bug: castByNovelty must thread its slot counter across partitions, not restart at 0 for each', () => {
    // Regression for a fortune-slot collision: castByNovelty used to
    // restart its `slot` counter at 0 on every call, so the newly
    // partition's k-th draw and the standing partition's k-th draw hashed
    // the identical (tick, 'slot', k) key -- fortune.pick's index is only a
    // post-hoc modulo of that shared roll onto each partition's own list, so
    // two equal-length partitions landed on the same relative index off the
    // same underlying roll. The fix threads the slot counter across both
    // castByNovelty calls so `standing` continues where `newly` left off,
    // exactly reproducing the pre-partition flat loop's draw sequence.
    const n1 = mkBriefEntry('n1');
    const n2 = mkBriefEntry('n2');
    const s1 = mkBriefEntry('s1');
    const s2 = mkBriefEntry('s2');
    const pool = [n1, n2, s1, s2];
    // All four tied at presented count 0 -- both partitions' first stratum
    // is the whole partition, so every draw is a plain seeded pick among
    // ties, same as the pre-T1 flat loop would do slot-by-slot.
    const presented = { n1: 0, n2: 0, s1: 0, s2: 0 };
    // budget 3, newly has 2 candidates: newly drains fully (consuming slots
    // 0 and 1), leaving exactly 1 slot of budget for standing's 2
    // candidates -- so standing draws too (both partitions non-empty and
    // budget-consuming, per the collision's precondition) without draining,
    // isolating a single collision draw instead of a full-partition
    // permutation where the end sets would coincide regardless.
    const briefBudget = 3;
    const newlyEligible = new Set(['n1', 'n2']);

    // tick 0 -- not an arbitrary choice: brute-forced over ticks 0..500
    // against the unfixed scheduler with this exact fixture (see the task's
    // RED evidence), and 254 of those 500 ticks already show a broken/fixed
    // divergence; tick 0 is the smallest. At tick 0 the unfixed code draws
    // 'newly' off slots 0 and 1 (picking n1 then n2), then restarts
    // 'standing' at slot 0 too -- reusing the identical roll(0,'slot',0).
    // Because both partitions have length 2 at that point, roll(0,'slot',0)
    // mod 2 lands on the same relative index (0) in `standing` as it did in
    // `newly`, drawing 's1'. The fix continues `standing` at slot 2 instead,
    // drawing off roll(0,'slot',2) mod 2, which lands on 's2' -- a
    // genuinely different selection, not merely a reordering (so this tick
    // cannot pass "by accident" the way a same-relative-index coincidence
    // could for an equal-outcome tick).
    const sel = examiner.select({
      tick: 0, briefBudget, eligible: pool, fortune: f, calendar: [], presented, newlyEligible,
    });

    // Reference: the threaded-slot draw, computed independently by hand,
    // continuing the slot counter from the newly partition into standing --
    // exactly what castByNovelty is mandated to do post-fix.
    let remainingNewly: EligibleEntry[] = [n1, n2];
    const expected: EligibleEntry[] = [];
    let slot = 0;
    while (expected.length < 2 && remainingNewly.length > 0) {
      const pick = f.pick('casting', 0, 'slot', remainingNewly, slot);
      expected.push(pick);
      remainingNewly = remainingNewly.filter((e) => e !== pick);
      slot++;
    }
    let remainingStanding: EligibleEntry[] = [s1, s2];
    while (expected.length < 3 && remainingStanding.length > 0) {
      const pick = f.pick('casting', 0, 'slot', remainingStanding, slot);
      expected.push(pick);
      remainingStanding = remainingStanding.filter((e) => e !== pick);
      slot++;
    }
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(expected.map((e) => e.storylet.id));
    // Concrete, not just "some permutation of the pool": the standing draw
    // must be 's2'. 's1' is exactly what the collision bug produces.
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['n1', 'n2', 's2']);

    // Determinism: same inputs, same cast, every time.
    const again = examiner.select({
      tick: 0, briefBudget, eligible: pool, fortune: f, calendar: [], presented, newlyEligible,
    });
    expect(again.chosen.map((e) => e.storylet.id)).toEqual(sel.chosen.map((e) => e.storylet.id));
  });
});

describe('ReignState.eligibleLastTick (causality §1)', () => {
  it('round-trips through sequential resolveTicks: sorted, exact, and drives casting order once consumed as newlyEligible', () => {
    const graph = setNodeProp(thornfieldGraph(), 'place:thornfield', 'flagged', false);
    const season = { ...seasonWith([mkAlways('rt.always'), mkGated('rt.gated')], 2), initialGraph: graph };

    // Tick 1: 'rt.gated' doesn't match yet (flagged is false) -- only
    // 'rt.always' is eligible, so it alone is 'this tick's eligible brief
    // set'.
    const out1 = resolveTick(season, initialState(season), empty, f);
    expect(out1.state.eligibleLastTick).toEqual(['rt.always']);

    // Flip the flag directly on the returned graph -- simulating an op
    // having landed, without needing a real op/decision round-trip (that's
    // T2's attribution machinery, out of scope here).
    const flipped = setNodeProp(out1.state.graph, 'place:thornfield', 'flagged', true);
    const seeded = { ...out1.state, graph: flipped };

    // Tick 2: both are now eligible. 'rt.gated' is newly-eligible (absent
    // from the eligibleLastTick this call reads back); 'rt.always' is
    // standing (present in it already). Round-trip must be exact and
    // sorted...
    const out2 = resolveTick(season, seeded, empty, f);
    expect(out2.state.eligibleLastTick).toEqual(['rt.always', 'rt.gated']);
    // ...and the wiring from tick.ts's newlyEligible computation through to
    // select's partition must actually be live end-to-end: with budget for
    // both, the newly-eligible one casts first regardless of presented
    // counts ('rt.always' was already presented once, at tick 1).
    expect(out2.packet.briefs.map((b) => b.storyletId)).toEqual(['rt.gated', 'rt.always']);
  });

  it('tick 1: an empty prior set makes everything newly-eligible, so casting equals the pre-T1 single-pool draw exactly', () => {
    const season = seasonWith([mkAlways('rt.x'), mkAlways('rt.y'), mkAlways('rt.z')], 2);

    // Independently reconstruct what a flat, recency-unaware draw would
    // pick: eligibleStorylets is invariant to the systems steps resolveTick
    // runs first (these storylets' patterns don't reference any prop those
    // steps touch), so calling it directly on season.initialGraph at tick 1
    // with the same empty cooldowns/firedOnce initialState carries yields
    // exactly the pool resolveTick's own step 9 computes.
    const pool = eligibleStorylets(season.initialGraph, season.decks, {}, 1, {});
    expect(pool.map((e) => e.storylet.id)).toEqual(['rt.x', 'rt.y', 'rt.z']);
    let remaining = pool;
    const expected: string[] = [];
    for (let slot = 0; expected.length < 2; slot++) {
      const pick = f.pick('casting', 1, 'slot', remaining, slot);
      expected.push(pick.storylet.id);
      remaining = remaining.filter((e) => e !== pick);
    }

    const out = resolveTick(season, initialState(season), empty, f);
    expect(out.state.eligibleLastTick).toEqual(['rt.x', 'rt.y', 'rt.z']);
    expect(out.packet.briefs.map((b) => b.storyletId)).toEqual(expected);
  });

  it('determinism: same season, seed, and decisions twice produces identical eligibleLastTick and casting', () => {
    const season = seasonWith([mkAlways('rt.x'), mkAlways('rt.y'), mkAlways('rt.z')], 2);
    const f2 = makeFortune('recency-determinism-seed');
    const out1 = resolveTick(season, initialState(season), empty, f2);
    const out2 = resolveTick(season, initialState(season), empty, f2);
    expect(out1.state.eligibleLastTick).toEqual(out2.state.eligibleLastTick);
    expect(out1.packet.briefs.map((b) => b.storyletId)).toEqual(out2.packet.briefs.map((b) => b.storyletId));
  });
});
