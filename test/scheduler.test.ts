import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { makeFortune } from '../src/fortune.js';
import { getNode, propInt } from '../src/graph.js';
import { advanceArcs, examiner } from '../src/scheduler.js';
import { eligibleStorylets } from '../src/storylet.js';
import { starterDeck } from '../src/decks/starter.js';
import { thornfieldGraph, thornfieldStressedGraph } from '../src/decks/thornfield.js';
import type { Booking, ExaminerCalendar } from '../src/scheduler.js';
import type { EligibleEntry, Storylet } from '../src/storylet.js';

// Minimal hand-built brief-kind entries for exercising select()'s budget
// bookkeeping directly, per its contract (it takes `eligible` as input) --
// no need to route through eligibleStorylets/a real deck for this.
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

const f = makeFortune('scheduler-test-seed');
// Causality §1 (recency casting): these pre-existing tests aren't about
// recency, so they declare no newly-eligible signal at all. An empty set
// means every entry falls into select's `standing` partition, which alone
// (the `newly` partition empty) reproduces the pre-T1 single-pool
// castByNovelty loop byte-for-byte -- so this is context-plumbing, not a
// behavior change. See test/recency.test.ts for the recency-specific cases.
const noneNewlyEligible: Set<string> = new Set();
// Causality §1 (T2, attribution): same reasoning -- these tests declare no
// player-attributed signal, so becauseOf.has(...) is false for every entry
// and the [attributed, world-newly] split collapses into world-newly alone
// (empty attributed partition consumes zero slots), which is exactly T1's
// existing [newly, standing] behavior for these calls.
const noBecauseOf: Map<string, string[]> = new Map();
// Causality §3 (T4, bookings): same reasoning again -- no bookings in play
// here, so the due-bookings block in examiner.select is a no-op loop for
// every call in this file. See test/bookings.test.ts for the booking-
// specific cases.
const noBookings: Booking[] = [];
const CAL: ExaminerCalendar = [
  { tick: 4, storyletId: 'starter.audit-whisper' },
  { tick: 4, armFamine: { placeId: 'place:thornfield', durationTicks: 4 } },
  { tick: 9, storyletId: 'starter.not-in-deck' },
];

describe('examiner', () => {
  it('forces calendar probes, fills the rest from the casting stream', () => {
    const eligible = eligibleStorylets(thornfieldGraph(), [starterDeck], {}, 4, {});
    const sel = examiner.select({ tick: 4, briefBudget: 2, eligible, fortune: f, calendar: CAL, presented: {}, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(sel.chosen.map((e) => e.storylet.id)).toContain('starter.audit-whisper');
    expect(sel.chosen).toHaveLength(2);
    expect(sel.letters.every((e) => e.storylet.kind === 'letter')).toBe(true);
    const again = examiner.select({ tick: 4, briefBudget: 2, eligible, fortune: f, calendar: CAL, presented: {}, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(again.chosen.map((e) => e.storylet.id)).toEqual(sel.chosen.map((e) => e.storylet.id));
  });
  it('records unfillable probes instead of inventing them', () => {
    const eligible = eligibleStorylets(thornfieldGraph(), [starterDeck], {}, 9, {});
    const sel = examiner.select({ tick: 9, briefBudget: 1, eligible, fortune: f, calendar: CAL, presented: {}, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(sel.skippedProbes).toEqual(['starter.not-in-deck']);
  });
  it('records a budget-blocked forced probe in skippedProbes, not just an absent one', () => {
    const eligible = [mkBriefEntry('probe.one'), mkBriefEntry('probe.two'), mkBriefEntry('probe.three')];
    const calendar: ExaminerCalendar = [
      { tick: 4, storyletId: 'probe.one' },
      { tick: 4, storyletId: 'probe.two' },
      { tick: 4, storyletId: 'probe.three' },
    ];
    const sel = examiner.select({ tick: 4, briefBudget: 2, eligible, fortune: f, calendar, presented: {}, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['probe.one', 'probe.two']);
    expect(sel.skippedProbes).toEqual(['probe.three']);
  });
  it('does not record a true dedup (same probe forced twice) as skipped', () => {
    const eligible = [mkBriefEntry('probe.one'), mkBriefEntry('probe.two')];
    const calendar: ExaminerCalendar = [
      { tick: 4, storyletId: 'probe.one' },
      { tick: 4, storyletId: 'probe.one' },
    ];
    const sel = examiner.select({ tick: 4, briefBudget: 1, eligible, fortune: f, calendar, presented: {}, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['probe.one']);
    expect(sel.skippedProbes).toEqual([]);
  });
});

// D13 fix (meta#1): the casting stream that fills leftover brief slots used
// to be a flat seeded draw over the whole eligible pool, with no memory of
// what had already been shown -- a 40-tick reign repeated the same handful
// of storylets while others sat at zero. It now deterministically prefers
// the least-presented instances: the pool is stratified by `presented`
// count and each slot draws from the lowest non-empty stratum.
describe('novelty-stratified casting (D13)', () => {
  it('fills the budget from the least-presented stratum before touching a more-presented entry', () => {
    const pool = [mkBriefEntry('a'), mkBriefEntry('b'), mkBriefEntry('c')];
    const presented = { a: 0, b: 1, c: 0 };
    const sel = examiner.select({ tick: 4, briefBudget: 2, eligible: pool, fortune: f, calendar: [], presented, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(sel.chosen).toHaveLength(2);
    expect(sel.chosen.map((e) => e.storylet.id).sort()).toEqual(['a', 'c']); // b (count 1) excluded
  });
  it('reaches into the next stratum only once the lower one is exhausted', () => {
    const pool = [mkBriefEntry('a'), mkBriefEntry('b'), mkBriefEntry('c')];
    const presented = { a: 0, b: 1, c: 0 };
    const sel = examiner.select({ tick: 4, briefBudget: 3, eligible: pool, fortune: f, calendar: [], presented, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(sel.chosen.map((e) => e.storylet.id)).toHaveLength(3);
    expect(sel.chosen[2]?.storylet.id).toBe('b'); // the sole count-1 entry, cast last regardless of a/c order
  });
  it('all-equal counts reduce to the plain seeded lottery over the whole pool', () => {
    const pool = [mkBriefEntry('a'), mkBriefEntry('b'), mkBriefEntry('c'), mkBriefEntry('d')];
    const presented = { a: 3, b: 3, c: 3, d: 3 };
    const sel = examiner.select({ tick: 4, briefBudget: 2, eligible: pool, fortune: f, calendar: [], presented, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(sel.chosen).toHaveLength(2);
    for (const e of sel.chosen) expect(pool).toContain(e);
    // A tied stratum equals the full remaining pool at every slot, so the
    // pre-D13 unstratified draw must be reproducible slot-by-slot from the
    // same raw fortune.pick sequence.
    let remaining = pool;
    const expected: string[] = [];
    for (let slot = 0; expected.length < 2; slot++) {
      const pick = f.pick('casting', 4, 'slot', remaining, slot);
      expected.push(pick.storylet.id);
      remaining = remaining.filter((e) => e !== pick);
    }
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(expected);
    const again = examiner.select({ tick: 4, briefBudget: 2, eligible: pool, fortune: f, calendar: [], presented, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(again.chosen.map((e) => e.storylet.id)).toEqual(sel.chosen.map((e) => e.storylet.id));
  });
  it('a calendar-forced probe fires at a high presented count -- probes bypass stratification', () => {
    const pool = [mkBriefEntry('probe.one'), mkBriefEntry('fresh')];
    const presented = { 'probe.one': 50, fresh: 0 };
    const calendar: ExaminerCalendar = [{ tick: 4, storyletId: 'probe.one' }];
    const sel = examiner.select({ tick: 4, briefBudget: 1, eligible: pool, fortune: f, calendar, presented, newlyEligible: noneNewlyEligible, becauseOf: noBecauseOf, bookings: noBookings });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['probe.one']);
  });
});

// D14: advanceArcs is delta-native -- the same discipline economyStep and
// socialStep follow (test/systems.test.ts, test/ladder.test.ts). Every
// famineStage/famineEndsAt mutation is built as a GraphDelta[], applied
// through applyDeltas, and handed to the emitted event as its `deltas`.
// advanceArcs has no continuous-decay exemption (every mutation is
// evented), so full equivalence holds on every call: replaying a call's
// concatenated event deltas onto that call's own pre-graph must hash-equal
// its actual return value. Asserted after each call in the lifecycle below
// -- arm, three advances, and the end -- not just once at the finish.
describe('advanceArcs', () => {
  it('arms, advances, and ends the famine on schedule', () => {
    let g = thornfieldGraph();

    let pre = g;
    const em = makeEmitter(4);
    g = advanceArcs(g, 4, CAL, em);
    expect(propInt(getNode(g, 'place:thornfield').props, 'famineStage')).toBe(1);
    expect(em.all()[0]?.type).toBe('crisis.famine.armed');
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    pre = g;
    const em5 = makeEmitter(5);
    g = advanceArcs(g, 5, CAL, em5);
    expect(propInt(getNode(g, 'place:thornfield').props, 'famineStage')).toBe(2);
    expect(hashValue(applyDeltas(pre, em5.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    pre = g;
    const em6 = makeEmitter(6);
    g = advanceArcs(g, 6, CAL, em6);
    expect(hashValue(applyDeltas(pre, em6.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    pre = g;
    const em7 = makeEmitter(7);
    g = advanceArcs(g, 7, CAL, em7);
    expect(propInt(getNode(g, 'place:thornfield').props, 'famineStage')).toBe(4);
    expect(hashValue(applyDeltas(pre, em7.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    pre = g;
    const emEnd = makeEmitter(8);
    g = advanceArcs(g, 8, CAL, emEnd);
    expect(propInt(getNode(g, 'place:thornfield').props, 'famineStage')).toBe(0);
    expect(emEnd.all().some((e) => e.type === 'crisis.famine.ended')).toBe(true);
    expect(hashValue(applyDeltas(pre, emEnd.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));
  });
});
