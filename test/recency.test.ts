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
import type { Booking } from '../src/scheduler.js';
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
// Causality §1 (T2, attribution): this file is about the [newly, standing]
// partition itself, not attribution -- an empty map means becauseOf.has(...)
// is always false, so every newly-eligible entry here falls into
// scheduler.ts's world-newly sub-partition, reproducing this file's
// pre-T2 [newly, standing] behavior exactly (see scheduler.ts's comment).
const noBecauseOf: Map<string, string[]> = new Map();
// Causality §3 (T4, bookings): this file is about the [newly, standing]
// partition, not bookings -- an empty array means the due-bookings block in
// examiner.select is a no-op loop, so every call here reproduces this
// file's pre-T4 behavior exactly (see scheduler.ts's comment on the
// no-bookings path). See test/bookings.test.ts for the booking-specific
// cases.
const noBookings: Booking[] = [];
// Playtest-3a #8a (consecutive-family suppression): this file is about the
// [newly, standing] partition, not suppression -- an empty array means
// applyFamilySuppression's exclusion is a no-op for every call here. See
// test/consecutive.test.ts for the suppression-specific cases.
const noDealtLastTick: string[] = [];

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
      newlyEligible: new Set(['newly']), becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: noDealtLastTick,
    });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['newly']);

    // Same fixture, but BOTH instances are newly-eligible this time: the
    // recency partition no longer distinguishes them, so it collapses back
    // to the plain D13 seeded lottery over the tied [0,0] stratum -- fortune
    // decides, exactly as it would pre-T1.
    const bothNewly = examiner.select({
      tick: 0, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented,
      newlyEligible: new Set(['standing', 'newly']), becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: noDealtLastTick,
    });
    const expectedPick = f.pick('casting', 0, 'slot', pool, 0);
    expect(bothNewly.chosen).toEqual([expectedPick]);
  });

  it('within the newly-eligible partition, D13 novelty still governs: the least-presented instance wins', () => {
    const pool = [mkBriefEntry('newly-shown-twice'), mkBriefEntry('newly-fresh')];
    const presented = { 'newly-shown-twice': 2, 'newly-fresh': 0 };
    const sel = examiner.select({
      tick: 4, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented,
      newlyEligible: new Set(['newly-shown-twice', 'newly-fresh']), becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: noDealtLastTick,
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
      tick: 0, briefBudget, eligible: pool, fortune: f, calendar: [], presented, newlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: noDealtLastTick,
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
      tick: 0, briefBudget, eligible: pool, fortune: f, calendar: [], presented, newlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: noDealtLastTick,
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

// Whole-wave final-review fix (CRITICAL): eligibleLastTick/newlyEligible must
// diff the PATTERN-POSSIBILITY set, not the cooldown/firedOnce-FILTERED
// dealt pool. Pre-fix, tick.ts computed the diff off `eligible`
// (eligibleStorylets' filtered result) -- a brief dealt at tick T with
// cooldownTicks C leaves THAT filtered set until T+C, then re-enters it, and
// re-entering after an absence read as "just became possible" even though
// the brief's own PATTERN never stopped binding the whole time. A brief
// misclassified newly jumps straight to the front of the casting order
// (scheduler.ts casts newly before standing), bypassing D13 presented-count
// novelty entirely -- so a short-cooldown brief could re-win the recency
// stratum every single time its cooldown expired, monopolizing the budget
// against briefs that have never been shown at all. Fixed by diffing against
// storylet.ts's possibleStorylets() instead (unfiltered by cooldowns/
// firedOnce) -- see tick.ts step 9's own comment for the mechanism.
describe('possibility-set recency (final-review fix): cooldown re-entry is standing, not newly', () => {
  function mkAlwaysCooldown(id: string, cooldownTicks: number): Storylet {
    return {
      id, kind: 'brief', tier: 1, cooldownTicks, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place' }] },
      title: id, body: id,
      options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
      defaultOptionId: 'skip',
    };
  }

  it("the reviewer's probe: budget 1, one cooldown-2 brief + two never-shown cooldown-0 briefs -- the recycler does not monopolize by exploiting cooldown-churn-as-newly", () => {
    // Unfiltered-possibility semantics: 'recycler's pattern (unconditional
    // 'any place') binds every tick from tick 1 onward, so it is newly
    // ONLY at tick 1 (tied with never-a/never-b, prior possibility set
    // empty) -- every later cooldown expiry re-enters the DEALT pool as
    // STANDING, competing on presented-count novelty like the other two,
    // never jumping the queue again. Pre-fix (diffing the FILTERED pool),
    // 'recycler' drops out of `eligible` for exactly the 1 tick its
    // cooldown blocks it, then reappears "newly" -- so it deals every
    // OTHER tick regardless of its own presented count, starving whichever
    // of never-a/never-b hasn't been drawn yet.
    const season = seasonWith(
      [mkAlwaysCooldown('recycler', 2), mkAlwaysCooldown('never-a', 0), mkAlwaysCooldown('never-b', 0)],
      1,
    );
    // Seed chosen (not arbitrary) so the RED failure is unambiguous: run
    // against unfixed ec7372b, this exact fixture deals
    // never-a, recycler, never-b, recycler, never-b, recycler, never-a, recycler
    // over 8 ticks -- presented = { recycler: 4, 'never-a': 2, 'never-b': 2
    // }, the recycler dealing on every single even tick from tick 2 on,
    // exactly the "4 by tick 8 vs 2 each" pattern the whole-wave review
    // flagged. Captured empirically (scratch probe against the unfixed
    // dist build), not hand-derived.
    const f3 = makeFortune('cooldown-churn-probe-seed');
    let state = initialState(season);
    const dealt: string[] = [];
    for (let i = 0; i < 8; i++) {
      const out = resolveTick(season, state, empty, f3);
      state = out.state;
      dealt.push(...out.packet.briefs.map((b) => b.storyletId));
    }

    // Fixed behavior, captured empirically the same way (post-fix run of
    // this exact fixture/seed): no stratum-jumping means the three settle
    // into a tied rotation instead of the recycler racing ahead.
    //
    // Playtest-3a #8a re-pin: ticks 1-3 are byte-identical to the
    // possibility-set fix alone (below), but tick 4 moves --
    // consecutive-family suppression is now also live, and this is exactly
    // the "pools change draws change" case the feature accepts by design.
    // At tick 4, recycler/never-a/never-b are ALL tied at presented 1 for
    // the first time (recycler's tick-2 cooldown clears exactly here);
    // pre-suppression that's a 3-way tie ([never-a, never-b, recycler],
    // eligibleStorylets' sorted pool order) and the seed's roll happened to
    // land on 'never-a'. Suppression excludes 'never-b' from that tie (it
    // was THIS fixture's tick-3 lottery deal), narrowing the tied pool to
    // 2 ([never-a, recycler]) -- the SAME underlying fortune roll reduced
    // modulo 2 instead of modulo 3 lands on a different entry, 'recycler'.
    // Nothing downstream of tick 4 was hand-adjusted; the rest of the
    // sequence (and the final presented counts) are the actual measured
    // consequence of that one changed draw. Re-captured empirically
    // (post-suppression run of this exact fixture/seed), not hand-derived.
    expect(dealt).toEqual([
      'never-a', 'recycler', 'never-b', 'recycler', 'never-b', 'never-a', 'recycler', 'never-b',
    ]);
    expect(state.presented).toEqual({ recycler: 3, 'never-a': 2, 'never-b': 3 });

    // The general, seed-independent invariant this fixture is built to
    // prove (per the review's own framing): once the recycler's presented
    // count is caught up to (or ahead of) a never-shown brief's, the
    // never-shown brief -- tied into the SAME standing stratum, per D13
    // least-presented-first -- must not fall more than 1 presentation
    // behind. A pre-fix run breaks this immediately: recycler reaches 2
    // presentations (tick 4) while one of never-a/never-b is still at 0.
    expect(state.presented['recycler']! - state.presented['never-a']!).toBeLessThanOrEqual(1);
    expect(state.presented['recycler']! - state.presented['never-b']!).toBeLessThanOrEqual(1);
  });

  it('a cooldown-expired brief re-enters the dealt pool as STANDING: eligibleLastTick carries it across the cooldown gap unbroken', () => {
    // Single-brief, single-tick-level check of the same mechanism above,
    // isolating just the eligibleLastTick bookkeeping (no lottery/budget
    // contention): a lone cooldown-2 brief's instanceKey must remain in
    // the possibility snapshot on the very tick its cooldown excludes it
    // from the dealt pool, so it's already "known possible" the moment it
    // re-enters and therefore never flagged newly again.
    const season = seasonWith([mkAlwaysCooldown('solo', 2)], 1);
    const f4 = makeFortune('possibility-carries-through-cooldown-seed');
    let state = initialState(season);
    const snapshots: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const out = resolveTick(season, state, empty, f4);
      state = out.state;
      snapshots.push(out.state.eligibleLastTick);
    }
    // Tick 1: presented (dealt), and possible -- in the snapshot.
    // Tick 2: cooldown excludes it from `eligible` (the DEALT pool), but
    // its pattern (unconditional) still binds -- possible, still in the
    // snapshot, unbroken.
    // Tick 3: cooldown clears, back in `eligible` -- and per the fix,
    // NOT newly (it was already in the tick-2 snapshot), so this deals it
    // as standing, not a recency win.
    for (const snap of snapshots) expect(snap).toEqual(['solo']);
  });
});
