// Playtest-3a #8a: consecutive-family suppression. Blind playtest showed
// the same storylet FAMILY dealing on up to five consecutive ticks with a
// rotating cast (fence x5, debt x4/5, riders x4/5) -- perBinding instances
// each carry their own cooldown, so a FRESH binding is always individually
// "least presented" the moment an earlier one goes on cooldown, and the
// family as a WHOLE never rests even though no single INSTANCE ever
// breaks its own cooldown. Fix: a storyletId dealt via one of the three
// LOTTERY STRATA (attributed/world-newly/standing) on the previous tick is
// excluded, family-wide, from this tick's combined candidate pool --
// unless exclusion would starve the remaining budget, in which case
// excluded families are re-admitted whole, in sorted storyletId order,
// until the shortfall is covered.
//
// Two levels of fixture, mirroring test/bookings.test.ts's own split:
// mkBriefEntry synthetic EligibleEntry values run directly through
// examiner.select() for the exclusion/starvation mechanics in isolation
// (no need for a real perBinding generator just to prove a set-membership
// exclusion), and a seasonWith()-style SeasonConfig with a REAL perBinding
// storylet run through sequential resolveTick calls for the rotating-cast
// regression itself -- that bug is specifically about the interaction
// between storylet.ts's per-instance cooldown gating and the scheduler's
// dealt pool, which a synthetic pool can't reproduce.
import { describe, expect, it } from 'vitest';
import { makeFortune } from '../src/fortune.js';
import { examiner } from '../src/scheduler.js';
import type { Booking, ExaminerCalendar } from '../src/scheduler.js';
import { starterSeason } from '../src/decks/starter.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig } from '../src/tick.js';
import type { EligibleEntry, Storylet } from '../src/storylet.js';

const f = makeFortune('consecutive-test-seed');
const empty = { seatId: 'seat:throne', choices: [] };
// This file is about dealtLastTick itself, so these three are declared
// empty/no-signal throughout (mirrors test/recency.test.ts's/
// test/bookings.test.ts's own noBecauseOf/noBookings convention) --
// collapsing recency/attribution/bookings out of the picture so every
// direct examiner.select call below isolates suppression alone.
const noNewlyEligible: Set<string> = new Set();
const noBecauseOf: Map<string, string[]> = new Map();
const noBookings: Booking[] = [];

// Mirrors test/bookings.test.ts's own mkBriefEntry: pattern-free synthetic
// entries, with an optional distinct instanceKey for multi-binding
// (perBinding-shaped) fixtures.
function mkBriefEntry(id: string, instanceKey = id): EligibleEntry {
  const storylet: Storylet = {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [] },
    title: id, body: id,
    options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
    defaultOptionId: 'a',
  };
  return { storylet, binding: {}, instanceKey };
}

describe('examiner.select: consecutive-family suppression (playtest-3a #8a)', () => {
  it('a storyletId dealt last tick is excluded FAMILY-WIDE this tick -- every instance, not just the one that dealt -- when an alternative exists', () => {
    const famA = mkBriefEntry('fam', 'fam@a');
    const famB = mkBriefEntry('fam', 'fam@b');
    const famC = mkBriefEntry('fam', 'fam@c');
    const other = mkBriefEntry('other');
    const pool = [famA, famB, famC, other];
    const sel = examiner.select({
      tick: 5, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented: {},
      newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['fam'],
    });
    // All three 'fam' instances are excluded regardless of instanceKey --
    // 'other' is the sole survivor, so it deals deterministically (a
    // singleton candidate pool needs no fortune to resolve).
    expect(sel.chosen).toEqual([other]);
    expect(sel.lotteryDealt).toEqual([other]);

    // Determinism: identical construction, called again, deals identically.
    const again = examiner.select({
      tick: 5, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented: {},
      newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['fam'],
    });
    expect(again.chosen).toEqual(sel.chosen);
  });

  it('starvation fallback: a family with no alternative at all still deals -- suppression never drops the dealt count below what the unsuppressed scheduler would deal', () => {
    const famA = mkBriefEntry('fam', 'fam@a');
    const famB = mkBriefEntry('fam', 'fam@b');
    const pool = [famA, famB]; // no non-family candidate exists this tick
    const sel = examiner.select({
      tick: 5, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented: {},
      newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['fam'],
    });
    // Naive exclusion would leave ZERO candidates for a budget of 1 --
    // the starvation fallback re-admits the family whole rather than
    // silently under-dealing.
    expect(sel.chosen).toHaveLength(1);
    expect(sel.chosen[0]?.storylet.id).toBe('fam');
    expect(sel.lotteryDealt).toHaveLength(1);
  });

  it('starvation fallback re-admits excluded families in SORTED storyletId order, stopping as soon as the shortfall is covered (does not over-readmit)', () => {
    const solo = mkBriefEntry('solo'); // never excluded -- always a survivor
    const famXa = mkBriefEntry('famX', 'famX@a');
    const famXb = mkBriefEntry('famX', 'famX@b');
    const famYa = mkBriefEntry('famY', 'famY@a');
    const famYb = mkBriefEntry('famY', 'famY@b');
    const pool = [solo, famXa, famXb, famYa, famYb];
    // Both famX and famY dealt last tick -- survivors after exclusion is
    // just [solo] (length 1), short of budget 3 by 2. Sorted order is
    // famX < famY, so famX (2 instances) is re-admitted first, bringing
    // the candidate count to 1 + 2 = 3 -- exactly covering the shortfall.
    // famY must NOT be re-admitted: re-admitting a family the fix doesn't
    // need would silently widen the pool for no reason, and specifically
    // would let a SECOND freshly-excluded family back in ahead of its own
    // rest tick.
    const sel = examiner.select({
      tick: 7, briefBudget: 3, eligible: pool, fortune: f, calendar: [], presented: {},
      newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['famX', 'famY'],
    });
    expect(sel.chosen).toHaveLength(3); // budget exactly met -- candidates were exactly [solo, famX@a, famX@b]
    expect(sel.chosen.map((e) => e.instanceKey).sort()).toEqual(['famX@a', 'famX@b', 'solo']);
    expect(sel.chosen.some((e) => e.storylet.id === 'famY')).toBe(false);
  });

  it('a storylet dealt last tick still force-deals THIS tick as a calendar probe -- probes never consult dealtLastTick, and never enter lotteryDealt', () => {
    const probed = mkBriefEntry('probed-id');
    const other = mkBriefEntry('other');
    const calendar: ExaminerCalendar = [{ tick: 5, storyletId: 'probed-id' }];
    const sel = examiner.select({
      tick: 5, briefBudget: 1, eligible: [probed, other], fortune: f, calendar, presented: {},
      newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['probed-id'],
    });
    expect(sel.chosen).toEqual([probed]);
    // The probe consumed the whole budget, so 'other' (which WOULD have
    // been a valid lottery candidate) simply doesn't get a slot this tick
    // -- unrelated to suppression, ordinary budget exhaustion.
    expect(sel.lotteryDealt).toEqual([]);
  });

  it('a storylet dealt last tick still force-deals THIS tick as a due booking -- bookings never consult dealtLastTick, and never enter lotteryDealt', () => {
    const booked = mkBriefEntry('booked-id');
    const other = mkBriefEntry('other');
    const booking: Booking = { storyletId: 'booked-id', seatId: 'seat:throne', byTick: 5, bookedAt: 1 };
    const sel = examiner.select({
      tick: 5, briefBudget: 1, eligible: [booked, other], fortune: f, calendar: [], presented: {},
      newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: [booking], dealtLastTick: ['booked-id'],
    });
    expect(sel.chosen).toEqual([booked]);
    expect(sel.dealtBookings).toEqual([booking]);
    expect(sel.lotteryDealt).toEqual([]);
  });

  it('a storylet that is ITSELF probed/booked again this tick is unaffected by having dealt last tick -- family-wide exclusion never reaches the force-deal loops', () => {
    // 'probed-id' both dealt last tick (per dealtLastTick) AND is this
    // tick's probe target -- the exclusion must never even be consulted
    // by the probe loop, which runs (and claims its entry from `pool`)
    // before suppression is applied to what's left.
    const probed = mkBriefEntry('probed-id');
    const calendar: ExaminerCalendar = [{ tick: 9, storyletId: 'probed-id' }];
    const sel = examiner.select({
      tick: 9, briefBudget: 1, eligible: [probed], fortune: f, calendar, presented: {},
      newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['probed-id'],
    });
    expect(sel.chosen).toEqual([probed]);
    expect(sel.skippedProbes).toEqual([]);
  });

  it('tick-1 equivalence: an empty dealtLastTick is a byte-identical no-op, reproducing the plain seeded lottery exactly', () => {
    const pool = [mkBriefEntry('a'), mkBriefEntry('b'), mkBriefEntry('c')];
    const sel = examiner.select({
      tick: 1, briefBudget: 2, eligible: pool, fortune: f, calendar: [], presented: {},
      newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: [],
    });
    // Independently reconstruct the pre-suppression draw (same technique
    // test/scheduler.test.ts's "all-equal counts reduce to the plain
    // seeded lottery" test uses): with nothing excluded, the three-way
    // tie at presented 0 draws straight off fortune.pick, slot by slot.
    let remaining = pool;
    const expected: string[] = [];
    for (let slot = 0; expected.length < 2; slot++) {
      const pick = f.pick('casting', 1, 'slot', remaining, slot);
      expected.push(pick.storylet.id);
      remaining = remaining.filter((e) => e !== pick);
    }
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(expected);
    expect(sel.lotteryDealt.map((e) => e.storylet.id)).toEqual(expected);
  });
});

// v0.3.1 review finding (Important, T1 re-review): no test above exercises
// a non-empty `newlyEligible` together with an overlapping `dealtLastTick`
// -- every direct examiner.select fixture in the describe block above uses
// noNewlyEligible (empty), so suppression was only ever pinned against
// standing candidates. The behavior is correct BY CONSTRUCTION --
// applyFamilySuppression (scheduler.ts) runs on `afterDeal`, producing
// `remaining`, and ONLY THEN does `select` derive `newly`/`standing` by
// filtering `remaining` -- so an excluded storyletId is gone before
// newlyEligible membership is ever consulted, full stop. But nothing
// pinned that ordering, so a future refactor that moved the suppression
// call to filter only the `standing` partition (a plausible misreading of
// "newly should always win, suppression is a standing-only throttle")
// would silently exempt newly-eligible families from suppression, quietly
// regressing the exact rotating-cast bug this whole file exists to fix,
// for any family that also happens to be newly-eligible. These three
// tests are PINS of the existing, already-correct behavior -- green from
// the start, not manufactured RED -- verified instead by hand-applying
// that exact refactor and confirming the first test below fails under it
// (mutation evidence in task-1-report.md).
describe('suppression x recency interaction (v0.3.1 review finding): suppression runs on the COMBINED pool, before the newly/standing split', () => {
  it('an instanceKey in newlyEligible whose family dealt last tick is still excluded -- the alternative deals in its place (suppression beats recency)', () => {
    const fam = mkBriefEntry('fam');       // newly-eligible AND its family dealt last tick
    const other = mkBriefEntry('other');   // standing, unaffected by either signal
    const pool = [fam, other];
    const sel = examiner.select({
      tick: 5, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented: {},
      newlyEligible: new Set(['fam']), becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['fam'],
    });
    // 'fam' never reaches the newly/standing split at all this tick --
    // applyFamilySuppression already dropped it from `remaining` -- so
    // being newly-eligible buys it no exemption. 'other' is the sole
    // surviving candidate, dealt deterministically (a singleton pool needs
    // no fortune to resolve).
    expect(sel.chosen).toEqual([other]);
    expect(sel.lotteryDealt).toEqual([other]);
  });

  it('a DIFFERENT newly-eligible family, not in dealtLastTick, is unaffected by suppression happening elsewhere in the same pool -- it deals first, ahead of standing (recency still works under suppression)', () => {
    const fam = mkBriefEntry('fam');           // excluded: its family dealt last tick
    const fresh = mkBriefEntry('fresh');       // newly-eligible, NOT suppressed
    const standing = mkBriefEntry('standing'); // standing, NOT suppressed
    const pool = [fam, fresh, standing];
    const sel = examiner.select({
      tick: 5, briefBudget: 2, eligible: pool, fortune: f, calendar: [], presented: {},
      newlyEligible: new Set(['fresh']), becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['fam'],
    });
    // 'fam' never appears (suppressed, and budget covers both survivors so
    // this isn't even a starvation case). 'fresh' -- newly-eligible --
    // casts in the newly partition BEFORE 'standing' reaches the standing
    // partition, so it lands first in `chosen`, exactly as it would with
    // no suppression signal present at all.
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['fresh', 'standing']);
  });

  it('starvation fallback reaches newly too: when the suppressed newly-eligible family is the ONLY candidate, it still deals', () => {
    const fam = mkBriefEntry('fam'); // newly-eligible, suppressed, AND the sole candidate
    const sel = examiner.select({
      tick: 5, briefBudget: 1, eligible: [fam], fortune: f, calendar: [], presented: {},
      newlyEligible: new Set(['fam']), becauseOf: noBecauseOf, bookings: noBookings, dealtLastTick: ['fam'],
    });
    // Naive exclusion would leave zero candidates for a budget of 1 --
    // applyFamilySuppression's starvation fallback re-admits 'fam' WHOLE
    // before the newly/standing split ever runs, so it re-enters
    // `remaining` (and from there, `newly`) like any other candidate, and
    // the single-candidate newly partition deals it without needing a
    // fortune draw to resolve.
    expect(sel.chosen).toEqual([fam]);
    expect(sel.lotteryDealt).toEqual([fam]);
  });
});

// Real perBinding fixtures for the resolveTick-level tests below: the
// rotating-cast bug is specifically about storylet.ts's eligibleStorylets
// cap-then-take loop sliding a FRESH binding into view as an earlier one
// goes on cooldown, which a synthetic pool (no real cooldown gating) can't
// reproduce -- these tests route through the real pipeline instead.
function mkFamily(): Storylet {
  return {
    id: 'family', kind: 'brief', tier: 1, cooldownTicks: 3, once: false,
    // maxInstancesPerTick: 1 mirrors the shipped starter deck's own
    // perBinding storylets (starter.gen.petition, starter.gen.rumor-letter,
    // src/decks/starter.ts) -- exactly one binding visible per tick, so a
    // dealt binding's cooldown is what slides a FRESH one into view, the
    // precise mechanism the playtest bug report describes.
    perBinding: true, maxInstancesPerTick: 1,
    pattern: { nodes: [{ as: 'c', type: 'character' }] }, // thornfieldGraph: 4 characters (liege, maud, osric, ruler)
    title: 'family {{c}}', body: 'family {{c}}',
    options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
    defaultOptionId: 'a',
  };
}
function mkOther(): Storylet {
  return {
    id: 'other', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [{ as: 'p', type: 'place' }] }, // thornfieldGraph: always eligible (1 place)
    title: 'other', body: 'other',
    options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
    defaultOptionId: 'a',
  };
}

// Mirrors test/recency.test.ts's own seasonWith(): starterSeason()'s
// throne/reporters/tierRules/initialGraph (thornfieldGraph()) carried
// through unchanged, only the deck and briefBudget overridden.
function seasonWith(storylets: Storylet[], briefBudget: number): SeasonConfig {
  const base = starterSeason();
  return {
    ...base,
    decks: [{ id: 'starter', tier: 1, storylets }],
    tiers: { ...base.tiers, 1: { ...base.tiers[1]!, briefBudget } },
    calendar: [],
  };
}

describe('resolveTick: the rotating-cast regression (playtest-3a #8a, the heart of this fix)', () => {
  it('a perBinding family never deals twice running while an alternative exists, even though each binding it rotates through has its own individually-fresh cooldown', () => {
    const season = seasonWith([mkFamily(), mkOther()], 1);
    // Seed chosen (not arbitrary): brute-forced by scanning descriptively-
    // named candidate seeds against UNFIXED f24998c (git stash of this
    // fix, then `pnpm vitest run`), scoring each by its longest run of
    // consecutive 'family' deals over 10 ticks. This seed's unfixed run:
    //   other, family, family, family, family, family, other, family, family, family
    // -- five 'family' deals running (ticks 2-6), 'other' available and
    // eligible throughout (its pattern is unconditional) every single one
    // of those ticks. Verified genuine RED, not a coincidental read: with
    // the fix stashed out, this exact assertion below fails on this exact
    // fixture/seed. Captured empirically, not hand-derived.
    const f2 = makeFortune('consecutive-suppression-regression-seed-1');
    let state = initialState(season);
    const dealt: string[] = [];
    for (let i = 0; i < 10; i++) {
      const out = resolveTick(season, state, empty, f2);
      state = out.state;
      dealt.push(out.packet.briefs[0]?.storyletId ?? 'NONE');
    }

    // The general, seed-shape-independent contract this whole task exists
    // to satisfy: 'family' never occupies two consecutive ticks while
    // 'other' -- eligible every single tick -- was a live alternative.
    for (let i = 0; i < dealt.length - 1; i++) {
      if (dealt[i] === 'family') expect(dealt[i + 1], `tick ${i + 1}->${i + 2}: family dealt twice running`).not.toBe('family');
    }

    // Fixed behavior, captured empirically the same way: suppression turns
    // this seed's five-in-a-row monopoly into a strict alternation --
    // 'family' rests exactly one tick (dealing 'other') every time it
    // deals, for the entire 10-tick run.
    expect(dealt).toEqual([
      'other', 'family', 'other', 'family', 'other', 'family', 'other', 'family', 'other', 'family',
    ]);

    // Fairness carried alongside suppression: 'other' -- the only
    // non-suppressed candidate on every 'family' rest tick -- ends up
    // dealt 5 times: no candidate starves as a side effect of the fix.
    expect(state.presented['other']).toBe(5);
  });

  it('two always-eligible, non-perBinding storylets with budget 1 alternate rather than either monopolizing (multi-tick alternation)', () => {
    function mkAltA(): Storylet {
      return {
        id: 'alt-a', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
        pattern: { nodes: [{ as: 'p', type: 'place' }] },
        title: 'a', body: 'a',
        options: [{ id: 'x', label: 'x', ops: [] }, { id: 'y', label: 'y', ops: [] }],
        defaultOptionId: 'x',
      };
    }
    function mkAltB(): Storylet {
      return {
        id: 'alt-b', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
        pattern: { nodes: [{ as: 'crown', type: 'institution' }] }, // thornfieldGraph: always eligible (1 institution)
        title: 'b', body: 'b',
        options: [{ id: 'x', label: 'x', ops: [] }, { id: 'y', label: 'y', ops: [] }],
        defaultOptionId: 'x',
      };
    }
    const season = seasonWith([mkAltA(), mkAltB()], 1);
    // Tied at presented 0 forever if either ever wins twice running (both
    // are single-instance, so once one deals it is FULLY excluded next
    // tick -- the other is the sole survivor, forced, no fortune needed);
    // only the tick-1 opening draw is a genuine coin flip. This seed's
    // fixed sequence: strict alternation from the very first tick.
    // Captured empirically (this file's own probe technique); several
    // other candidate seeds probed the same way showed the identical
    // qualitative shape (alternation from tick 1), so this is the general
    // case for a tied two-candidate pool under suppression, not a fluke.
    const f2 = makeFortune('alternation-seed-2');
    let state = initialState(season);
    const dealt: string[] = [];
    for (let i = 0; i < 8; i++) {
      const out = resolveTick(season, state, empty, f2);
      state = out.state;
      dealt.push(out.packet.briefs[0]?.storyletId ?? 'NONE');
    }
    expect(dealt).toEqual(['alt-a', 'alt-b', 'alt-a', 'alt-b', 'alt-a', 'alt-b', 'alt-a', 'alt-b']);
    for (let i = 0; i < dealt.length - 1; i++) expect(dealt[i]).not.toBe(dealt[i + 1]);
    expect(state.presented).toEqual({ 'alt-a': 4, 'alt-b': 4 });
  });

  it('determinism: same season, seed, and decisions run twice produce identical dealt sequences and identical dealtLastTick snapshots', () => {
    const season = seasonWith([mkFamily(), mkOther()], 1);
    const f3 = makeFortune('consecutive-determinism-seed');
    const runOnce = () => {
      let state = initialState(season);
      const dealt: string[] = [];
      const dlt: string[][] = [];
      for (let i = 0; i < 8; i++) {
        const out = resolveTick(season, state, empty, f3);
        state = out.state;
        dealt.push(out.packet.briefs[0]?.storyletId ?? 'NONE');
        dlt.push(out.state.dealtLastTick);
      }
      return { dealt, dlt };
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.dealt).toEqual(b.dealt);
    expect(a.dlt).toEqual(b.dlt);
  });
});

describe('ReignState.dealtLastTick (playtest-3a #8a)', () => {
  it('starts empty, and after one resolveTick carries exactly what the lottery dealt -- sorted, deduped, excluding probes and bookings', () => {
    const season = seasonWith([mkFamily(), mkOther()], 2); // budget 2: both deal tick 1, nothing to suppress yet
    expect(initialState(season).dealtLastTick).toEqual([]);
    const f4 = makeFortune('dealt-last-tick-roundtrip-seed');
    const out1 = resolveTick(season, initialState(season), empty, f4);
    expect(out1.packet.briefs.map((b) => b.storyletId).sort()).toEqual(['family', 'other']);
    expect(out1.state.dealtLastTick).toEqual(['family', 'other']); // sorted, both lottery-dealt (calendar is [] -- no probes/bookings exist in this fixture)
  });

  it('a probe-forced deal does NOT enter dealtLastTick -- next tick applies no suppression on its account', () => {
    const base = seasonWith([mkOther()], 1);
    const season: SeasonConfig = { ...base, calendar: [{ tick: 1, storyletId: 'other' }] };
    const f5 = makeFortune('dealt-last-tick-probe-seed');
    const out1 = resolveTick(season, initialState(season), empty, f5);
    expect(out1.packet.briefs.map((b) => b.storyletId)).toEqual(['other']); // forced by the probe, not the lottery
    expect(out1.state.dealtLastTick).toEqual([]); // probes are exempt from ever entering it
  });
});
