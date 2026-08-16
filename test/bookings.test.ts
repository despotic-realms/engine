// Causality §3 (spec: meta/docs/specs/2026-08-08-causality-design.md §3;
// plan: meta/docs/plans/2026-08-08-causality-plan.md, Task 4): booked
// follow-ups. A storylet option can `books` a specific follow-up scene for
// a coming tick, jumping the casting lottery entirely --
// ReignState.bookings force-deal at select() when due (tick <= byTick) AND
// eligible, after probes, before the recency/attribution lottery strata
// (T1/T2). Recording happens at choice-application time (tick.ts): any path
// that applies an option's ops -- attended, defaulted, neglected -- also
// records its `books`, if any, regardless of whether those ops themselves
// landed or were rejected (booking is a property of the CHOSEN OPTION, not
// of op success).
//
// Fixture style mirrors test/recency.test.ts and test/attribution.test.ts:
// synthetic EligibleEntry values run directly through examiner.select() for
// the scheduler-level force-deal/hold/lapse mechanics (bookings never draw
// fortune, so these are fully hand-verifiable without brute-forcing a seed),
// and a seasonWith()-style SeasonConfig run through real resolveTick calls
// for the recording/threading/end-to-end order tests.
import { describe, expect, it } from 'vitest';
import { makeFortune } from '../src/fortune.js';
import { setNodeProp } from '../src/graph.js';
import { examiner } from '../src/scheduler.js';
import type { Booking, ExaminerCalendar } from '../src/scheduler.js';
import { starterSeason } from '../src/decks/starter.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig } from '../src/tick.js';
import type { EligibleEntry, Storylet } from '../src/storylet.js';

const f = makeFortune('bookings-test-seed');
const empty = { seatId: 'seat:throne', choices: [] };
const noNewlyEligible: Set<string> = new Set();
const noBecauseOf: Map<string, string[]> = new Map();
// Playtest-3a #8a (consecutive-family suppression): this file is about
// bookings, not suppression -- an empty array makes
// applyFamilySuppression's exclusion a no-op for every direct
// examiner.select call below. See test/consecutive.test.ts for the
// suppression-specific cases.
const noDealtLastTick: string[] = [];

// Mirrors test/recency.test.ts's/test/attribution.test.ts's own mkBriefEntry:
// pattern-free synthetic entries for exercising examiner.select's
// stratification directly, with an optional distinct instanceKey for the
// perBinding multi-binding tie-break case.
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

describe('examiner.select: due-bookings force-deal (causality §3)', () => {
  it('casting order: probes > due bookings > attributed newly-eligible > world newly-eligible > standing, concrete order on one constructed tick', () => {
    const probe = mkBriefEntry('probe');
    const booked = mkBriefEntry('booked');
    const attributedEntry = mkBriefEntry('attributed');
    const worldNewly = mkBriefEntry('world-newly');
    const standing = mkBriefEntry('standing');
    const pool = [standing, worldNewly, booked, attributedEntry, probe]; // deliberately NOT in stratum order
    const calendar: ExaminerCalendar = [{ tick: 0, storyletId: 'probe' }];
    const booking: Booking = { storyletId: 'booked', seatId: 'seat:throne', byTick: 0, bookedAt: -1 };
    const newlyEligible = new Set(['attributed', 'world-newly']);
    const becauseOf = new Map([['attributed', ['t0.0']]]);

    // budget 5 covers all five, one per stratum -- every stratum is a
    // singleton here, so each castByNovelty call has exactly one candidate
    // and picks it regardless of fortune (no brute-force tick search
    // needed, unlike T1/T2's ties-within-a-stratum tests).
    const sel = examiner.select({
      tick: 0, briefBudget: 5, eligible: pool, fortune: f, calendar, presented: {}, newlyEligible, becauseOf, bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['probe', 'booked', 'attributed', 'world-newly', 'standing']);
    expect(sel.dealtBookings).toEqual([booking]);
    expect(sel.lapsedBookings).toEqual([]);

    // Determinism: identical construction, called again, deals identically.
    const again = examiner.select({
      tick: 0, briefBudget: 5, eligible: pool, fortune: f, calendar, presented: {}, newlyEligible, becauseOf, bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(again.chosen.map((e) => e.storylet.id)).toEqual(sel.chosen.map((e) => e.storylet.id));
  });

  it('a due booking consumes budget ahead of an attributed newly-eligible entry', () => {
    const booked = mkBriefEntry('booked');
    const attributedEntry = mkBriefEntry('attributed');
    const pool = [attributedEntry, booked];
    const booking: Booking = { storyletId: 'booked', seatId: 'seat:throne', byTick: 2, bookedAt: 1 };
    const sel = examiner.select({
      tick: 2, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented: {},
      newlyEligible: new Set(['attributed']), becauseOf: new Map([['attributed', ['x']]]), bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['booked']);
    expect(sel.dealtBookings).toEqual([booking]);
  });

  it('hold semantics (causality plan tests (c)+(d)): a due-but-crowded-out booking holds until byTick, then lapses', () => {
    const probeEntry = mkBriefEntry('probe');
    const bookedEntry = mkBriefEntry('booked');
    const pool = [probeEntry, bookedEntry];
    const calendar: ExaminerCalendar = [{ tick: 5, storyletId: 'probe' }, { tick: 6, storyletId: 'probe' }];
    const booking: Booking = { storyletId: 'booked', seatId: 'seat:throne', byTick: 6, bookedAt: 4 };

    // tick 5 (< byTick 6): the probe takes the sole budget slot; the
    // booking is due and eligible but crowded out -- holds, doesn't lapse.
    const sel5 = examiner.select({
      tick: 5, briefBudget: 1, eligible: pool, fortune: f, calendar, presented: {}, newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(sel5.chosen.map((e) => e.storylet.id)).toEqual(['probe']);
    expect(sel5.dealtBookings).toEqual([]);
    expect(sel5.lapsedBookings).toEqual([]);

    // tick 6 (=== byTick): crowded out again -- this was its last due tick,
    // so it expires unfilled.
    const sel6 = examiner.select({
      tick: 6, briefBudget: 1, eligible: pool, fortune: f, calendar, presented: {}, newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(sel6.chosen.map((e) => e.storylet.id)).toEqual(['probe']);
    expect(sel6.dealtBookings).toEqual([]);
    expect(sel6.lapsedBookings).toEqual([booking]);
  });

  it('(c) an ineligible-throughout booking (never appears in the pool) lapses exactly at byTick, holds before it', () => {
    const booking: Booking = { storyletId: 'ghost', seatId: 'seat:throne', byTick: 5, bookedAt: 2 };

    const before = examiner.select({
      tick: 4, briefBudget: 1, eligible: [], fortune: f, calendar: [], presented: {}, newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(before.dealtBookings).toEqual([]);
    expect(before.lapsedBookings).toEqual([]);

    const at = examiner.select({
      tick: 5, briefBudget: 1, eligible: [], fortune: f, calendar: [], presented: {}, newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(at.dealtBookings).toEqual([]);
    expect(at.lapsedBookings).toEqual([booking]);
  });

  it('multi-binding tie-break: a perBinding storylet with more than one eligible instance force-deals the lexicographically-first instanceKey', () => {
    const bindingB = mkBriefEntry('multi', 'multi@x=b');
    const bindingA = mkBriefEntry('multi', 'multi@x=a');
    const pool = [bindingB, bindingA]; // deliberately out of order
    const booking: Booking = { storyletId: 'multi', seatId: 'seat:throne', byTick: 4, bookedAt: 0 };
    // tick 4 (not an arbitrary choice, T1/T2's own recency.test.ts/
    // attribution.test.ts convention): brute-forced over ticks 0..50 against
    // the UNMODIFIED (pre-T4) scheduler, which ignores an unknown `bookings`
    // field entirely and lottery-draws this tied pair via the plain standing
    // partition -- at tick 4 that draw picks 'multi@x=b' (the WRONG one, by
    // this test's own tie-break rule), so this is genuine RED against the
    // unfixed scheduler, not a coincidental pass (e.g. tick 0 happens to
    // match by chance and would NOT be genuine RED).
    const sel = examiner.select({
      tick: 4, briefBudget: 1, eligible: pool, fortune: f, calendar: [], presented: {}, newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(sel.chosen).toEqual([bindingA]);
    expect(sel.chosen[0]?.instanceKey).toBe('multi@x=a');
  });

  it('a booking for a LETTER-kind storylet id never force-deals -- bookings only search the brief pool', () => {
    const letterEntry: EligibleEntry = {
      storylet: {
        id: 'a-letter', kind: 'letter', tier: 1, cooldownTicks: 0, once: false,
        pattern: { nodes: [] }, title: 't', body: 'b', options: [], defaultOptionId: '', from: 'char:x',
      },
      binding: {}, instanceKey: 'a-letter',
    };
    const booking: Booking = { storyletId: 'a-letter', seatId: 'seat:throne', byTick: 3, bookedAt: 1 };
    const sel = examiner.select({
      tick: 3, briefBudget: 1, eligible: [letterEntry], fortune: f, calendar: [], presented: {}, newlyEligible: noNewlyEligible, becauseOf: noBecauseOf, bookings: [booking], dealtLastTick: noDealtLastTick,
    });
    expect(sel.chosen).toEqual([]);
    expect(sel.letters).toEqual([letterEntry]); // still delivered normally, just not via the booking mechanism
    expect(sel.dealtBookings).toEqual([]);
    expect(sel.lapsedBookings).toEqual([booking]); // due every tick, never found in the brief pool -- expires at byTick
  });
});

// Two levels of fixture below mirror test/recency.test.ts exactly: mkAlways/
// mkGated/seasonWith for hand-controlled eligibility, run through REAL
// resolveTick calls so the recording wiring (tick.ts) and the scheduling
// wiring (scheduler.ts) are both exercised end-to-end, not just select()
// directly.
function mkAlways(id: string): Storylet {
  return {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [{ as: 'p', type: 'place' }] },
    title: id, body: id,
    options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
    defaultOptionId: 'skip',
  };
}

function mkGated(id: string): Storylet {
  return {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'flagged', cmp: 'eq', value: true }] }] },
    title: id, body: id,
    options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
    defaultOptionId: 'skip',
  };
}

// The option carrying `books` is the FIRST (attended-choosable) option;
// `once: true` so a storylet used to trigger a booking never re-competes
// for budget on a later tick in the same test (keeps later assertions on
// who else casts unambiguous).
function mkBookingSource(id: string, booksId: string, withinTicks: number): Storylet {
  return {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: true,
    pattern: { nodes: [{ as: 'p', type: 'place' }] },
    title: id, body: id,
    options: [
      { id: 'book-it', label: 'Book it', ops: [], books: { storyletId: booksId, withinTicks } },
      { id: 'skip', label: 'Skip', ops: [] },
    ],
    defaultOptionId: 'skip',
  };
}

// For the DEFAULT/neglect-path tests: the option that carries `books` IS
// the storylet's own defaultOptionId, so leaving it undecided (or crowding
// it out of the attention cut) applies it automatically.
function mkDefaultBooks(id: string, booksId: string, withinTicks: number): Storylet {
  return {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: true,
    pattern: { nodes: [{ as: 'p', type: 'place' }] },
    title: id, body: id,
    options: [
      { id: 'other', label: 'Other', ops: [] },
      { id: 'auto-book', label: 'Auto-book', ops: [], books: { storyletId: booksId, withinTicks } },
    ],
    defaultOptionId: 'auto-book',
  };
}

function seasonWith(storylets: Storylet[], briefBudget: number): SeasonConfig {
  const base = starterSeason();
  return {
    ...base,
    decks: [{ id: 'starter', tier: 1, storylets }],
    tiers: { ...base.tiers, 1: { ...base.tiers[1]!, briefBudget } },
    calendar: [],
  };
}

describe('resolveTick: recording (causality plan tests (a), (e))', () => {
  it('(a) choosing an option with `books` records the booking (byTick = the resolving tick + withinTicks) and emits scene.booked with deltas: []', () => {
    // bk.target is GATED (not mkAlways): this test is about RECORDING in
    // isolation, so the target must stay ineligible through this call --
    // otherwise it force-deals (and is removed from state.bookings) in this
    // SAME resolveTick call, per the recording-and-dealing-can-coincide
    // behavior the multi-tick/casting-order tests below cover separately.
    const season = seasonWith([mkBookingSource('bk.source', 'bk.target', 3), mkGated('bk.target')], 2);
    const out0 = resolveTick(season, initialState(season), empty, f); // resolves tick 0 -> packet.tick 1
    const brief = out0.packet.briefs.find((b) => b.storyletId === 'bk.source')!;
    const decision = { seatId: 'seat:throne', choices: [{ briefId: brief.briefId, optionId: 'book-it' }] };
    const out1 = resolveTick(season, out0.state, decision, f); // resolves tick 1

    expect(out1.state.bookings).toEqual([{ storyletId: 'bk.target', seatId: 'seat:throne', byTick: 4, bookedAt: 1 }]);
    expect(out1.packet.briefs.map((b) => b.storyletId)).not.toContain('bk.target'); // held, not yet dealt
    const booked = out1.events.find((e) => e.type === 'scene.booked');
    expect(booked).toBeDefined();
    expect(booked?.data).toEqual({ storyletId: 'bk.target', byTick: 4 });
    expect(booked?.deltas).toEqual([]);
    const decisionEvent = out1.events.find((e) => e.type === 'decision.recorded');
    expect(booked?.parents).toEqual([decisionEvent!.id]);
  });

  it('(e) a DEFAULTED option (never decided) with `books` records too, parented to brief.defaulted', () => {
    const season = seasonWith([mkDefaultBooks('bk.def', 'bk.target2', 2)], 1);
    const out0 = resolveTick(season, initialState(season), empty, f);
    expect(out0.packet.briefs.map((b) => b.storyletId)).toContain('bk.def');
    const out1 = resolveTick(season, out0.state, empty, f); // no decision at all -> defaults

    const defaultedEvent = out1.events.find((e) => e.type === 'brief.defaulted');
    expect(defaultedEvent).toBeDefined();
    expect(out1.state.bookings).toEqual([{ storyletId: 'bk.target2', seatId: 'seat:throne', byTick: 3, bookedAt: 1 }]);
    const booked = out1.events.find((e) => e.type === 'scene.booked');
    expect(booked?.data).toEqual({ storyletId: 'bk.target2', byTick: 3 });
    expect(booked?.parents).toEqual([defaultedEvent!.id]);
  });

  it('the NEGLECTED path (decided but pushed over the attention cut) with `books` also records, parented to brief.neglected', () => {
    const base = seasonWith([mkAlways('bk.other'), mkDefaultBooks('bk.def2', 'bk.target3', 2)], 2);
    const season: SeasonConfig = { ...base, tiers: { ...base.tiers, 1: { ...base.tiers[1]!, attentionSlots: 1 } } };
    const out0 = resolveTick(season, initialState(season), empty, f); // budget 2 -> both presented
    const other = out0.packet.briefs.find((b) => b.storyletId === 'bk.other')!;
    const def = out0.packet.briefs.find((b) => b.storyletId === 'bk.def2')!;
    // attentionSlots 1: only the FIRST submitted choice is attended; the
    // second overflows into neglect regardless of what it asked for.
    const decisions = {
      seatId: 'seat:throne',
      choices: [{ briefId: other.briefId, optionId: 'ack' }, { briefId: def.briefId, optionId: 'other' }],
    };
    const out1 = resolveTick(season, out0.state, decisions, f);

    const neglectedEvent = out1.events.find((e) => e.type === 'brief.neglected');
    expect(neglectedEvent).toBeDefined();
    expect(neglectedEvent?.data['briefId']).toBe(def.briefId);
    const booked = out1.events.find((e) => e.type === 'scene.booked');
    expect(booked?.parents).toEqual([neglectedEvent!.id]);
    // The overflowed choice asked for 'other' -- irrelevant. Neglect always
    // applies the storylet's OWN default option (existing pre-T4 behavior),
    // which here is 'auto-book'.
    expect(out1.state.bookings.some((b) => b.storyletId === 'bk.target3')).toBe(true);
  });

  it('records the booking even when the option\'s own op is rejected -- booking is a property of the CHOICE, not of op success', () => {
    const badOption = {
      id: 'bad', label: 'Bad', ops: [{ kind: 'release_grain' as const, placeId: 'place:thornfield', amount: '999999' }],
      books: { storyletId: 'bk.target4', withinTicks: 2 },
    };
    const storylet: Storylet = {
      id: 'bk.badop', kind: 'brief', tier: 1, cooldownTicks: 0, once: true,
      pattern: { nodes: [{ as: 'p', type: 'place' }] },
      title: 't', body: 'b',
      options: [badOption, { id: 'skip', label: 'Skip', ops: [] }],
      defaultOptionId: 'skip',
    };
    const season = seasonWith([storylet], 1);
    const out0 = resolveTick(season, initialState(season), empty, f);
    const brief = out0.packet.briefs.find((b) => b.storyletId === 'bk.badop')!;
    const out1 = resolveTick(season, out0.state, { seatId: 'seat:throne', choices: [{ briefId: brief.briefId, optionId: 'bad' }] }, f);

    expect(out1.events.some((e) => e.type === 'op.rejected')).toBe(true);
    expect(out1.state.bookings.some((b) => b.storyletId === 'bk.target4')).toBe(true);
    expect(out1.events.some((e) => e.type === 'scene.booked')).toBe(true);
  });
});

describe('resolveTick: order across sequential ticks (causality plan review carry)', () => {
  it('a booking recorded at tick 1 holds while its target is ineligible, then force-deals ahead of a standing brief once eligible -- spans 3 sequential resolveTicks', () => {
    const graph = setNodeProp(starterSeason().initialGraph, 'place:thornfield', 'flagged', false);
    const season: SeasonConfig = {
      ...seasonWith([mkBookingSource('mt.source', 'mt.target', 3), mkGated('mt.target'), mkAlways('mt.standing')], 2),
      initialGraph: graph,
    };

    // Tick 0 -> packet 1: mt.source and mt.standing eligible (mt.target
    // gated off); budget 2 covers both.
    const out0 = resolveTick(season, initialState(season), empty, f);
    expect(out0.packet.briefs.map((b) => b.storyletId).sort()).toEqual(['mt.source', 'mt.standing']);
    const sourceBrief = out0.packet.briefs.find((b) => b.storyletId === 'mt.source')!;

    // Tick 1: book mt.target (withinTicks 3 -> byTick 4). mt.source is
    // `once`, so it never competes for budget again. mt.target is still
    // ineligible (flag false) -- the booking holds through this same
    // call's own cast for nextTick 2.
    const out1 = resolveTick(season, out0.state, { seatId: 'seat:throne', choices: [{ briefId: sourceBrief.briefId, optionId: 'book-it' }] }, f);
    expect(out1.state.bookings).toEqual([{ storyletId: 'mt.target', seatId: 'seat:throne', byTick: 4, bookedAt: 1 }]);
    expect(out1.packet.briefs.map((b) => b.storyletId)).toEqual(['mt.standing']); // booking holds, unseen; nothing else eligible
    expect(out1.events.some((e) => e.type === 'scene.booking.lapsed')).toBe(false);

    // Flip the flag directly on the graph (test/recency.test.ts's own
    // technique) -- mt.target becomes pattern-eligible with no event/
    // decision behind it at all.
    const flipped = setNodeProp(out1.state.graph, 'place:thornfield', 'flagged', true);
    const seeded = { ...out1.state, graph: flipped };

    // Tick 2: mt.target is now eligible AND due (nextTick 3 <= byTick 4) --
    // force-deals ahead of mt.standing (eligible since tick 1, therefore
    // standing, not newly), consuming the first of budget's two slots.
    const out2 = resolveTick(season, seeded, empty, f);
    expect(out2.packet.briefs.map((b) => b.storyletId)).toEqual(['mt.target', 'mt.standing']);
    expect(out2.state.bookings).toEqual([]); // dealt -- removed
    expect(out2.events.some((e) => e.type === 'scene.booking.lapsed')).toBe(false);
  });
});

describe('ReignState.bookings round-trip + determinism (causality plan test (f))', () => {
  it('bookings starts empty on initialState and stays empty through a reign with nothing to book', () => {
    const season = seasonWith([mkAlways('rt.filler')], 1);
    expect(initialState(season).bookings).toEqual([]);
    const out = resolveTick(season, initialState(season), empty, f);
    expect(out.state.bookings).toEqual([]);
  });

  it('same season, seed, and decisions run twice produce identical bookings and identical scene.* events', () => {
    const season = seasonWith([mkBookingSource('rt2.source', 'rt2.target', 2), mkAlways('rt2.target')], 2);
    const f2 = makeFortune('bookings-determinism-seed');

    const out0a = resolveTick(season, initialState(season), empty, f2);
    const briefA = out0a.packet.briefs.find((b) => b.storyletId === 'rt2.source')!;
    const out1a = resolveTick(season, out0a.state, { seatId: 'seat:throne', choices: [{ briefId: briefA.briefId, optionId: 'book-it' }] }, f2);

    const out0b = resolveTick(season, initialState(season), empty, f2);
    const briefB = out0b.packet.briefs.find((b) => b.storyletId === 'rt2.source')!;
    const out1b = resolveTick(season, out0b.state, { seatId: 'seat:throne', choices: [{ briefId: briefB.briefId, optionId: 'book-it' }] }, f2);

    expect(out1a.state.bookings).toEqual(out1b.state.bookings);
    expect(out1a.packet.briefs.map((b) => b.storyletId)).toEqual(out1b.packet.briefs.map((b) => b.storyletId));
    expect(out1a.events.filter((e) => e.type.startsWith('scene.')).map((e) => e.data)).toEqual(
      out1b.events.filter((e) => e.type.startsWith('scene.')).map((e) => e.data),
    );
  });
});

// Review fix (post-T4): two Important findings against 1124ce3.
//
// Finding 1 -- a withinTicks <= 0 booking was permanently stuck. recordBooking
// computes byTick at the RESOLVING tick (tick.ts's `tick`, i.e. state.tick),
// but examiner.select's first-ever look at ANY booking happens at
// nextTick = tick + 1 (this same resolveTick call's own step 9). With
// withinTicks <= 0, byTick <= tick < nextTick, so the booking is already past
// due the moment select() first sees it. The guard at scheduler.ts's due-
// bookings loop (`if (tick > booking.byTick) continue;`) silently skipped
// such a booking into NEITHER dealtBookings NOR lapsedBookings, so tick.ts's
// removal filter (`bookings.filter((b) => !dealt.includes(b) &&
// !lapsed.includes(b))`) never touched it either -- it sat in
// ReignState.bookings forever, violating "dealt or expired bookings
// removed." Fixed by lapsing instead of skipping past due, which also
// covers any OTHER future path where select's first evaluation of a booking
// lands after byTick, not just withinTicks <= 0.
//
// Finding 2 -- the lapse path (AT byTick, not past it) had no end-to-end
// test: every existing lapse case above calls examiner.select() directly and
// asserts only the returned lapsedBookings array, never exercising tick.ts's
// wiring around it (the scene.booking.lapsed emission + the
// ReignState.bookings removal filter). That wiring is untouched by the
// finding-1 fix -- it was already correct -- so this is pinning coverage,
// not a bug fix.
describe('resolveTick: total lifecycle -- every booking terminates dealt or lapsed (review fix)', () => {
  it('a withinTicks: 0 booking lapses on the very call that records it, and never resurfaces over 10 further ticks (finding 1 regression)', () => {
    const season = seasonWith([mkBookingSource('r1.source', 'r1.target', 0), mkGated('r1.target')], 1);
    const out0 = resolveTick(season, initialState(season), empty, f); // resolves tick 0 -> presents r1.source for tick 1
    const brief = out0.packet.briefs.find((b) => b.storyletId === 'r1.source')!;
    const decision = { seatId: 'seat:throne', choices: [{ briefId: brief.briefId, optionId: 'book-it' }] };

    // Resolves tick 1: records the booking (byTick = 1 + 0 = 1). This SAME
    // call's own step 9 evaluates select() at nextTick = 2 -- already past
    // byTick 1 on the booking's very first evaluation, ever. Pre-fix: stuck
    // (neither removed from state.bookings nor chronicled). Post-fix: lapses
    // right here.
    const out1 = resolveTick(season, out0.state, decision, f);
    expect(out1.state.bookings).toEqual([]); // removed, not stuck at length 1
    const lapsed = out1.events.find((e) => e.type === 'scene.booking.lapsed');
    expect(lapsed).toBeDefined();
    expect(lapsed?.data).toEqual({ storyletId: 'r1.target' });
    expect(lapsed?.deltas).toEqual([]);
    expect(lapsed?.parents).toEqual([]);

    // Advance 10 further ticks with no decisions -- mirrors the reviewer's
    // own reproduction horizon ("stuck at length 1 with no lapse event over
    // 10 ticks"), now proving the fix holds throughout: no resurrection, no
    // duplicate lapse emission.
    let state = out1.state;
    for (let i = 0; i < 10; i++) {
      const out = resolveTick(season, state, empty, f);
      expect(out.state.bookings).toEqual([]);
      expect(out.events.some((e) => e.type === 'scene.booking.lapsed')).toBe(false);
      state = out.state;
    }
  });

  it('an ineligible-throughout booking holds through resolveTick, then lapses end-to-end with the correct chronicle event and state removal (finding 2 pin)', () => {
    const season = seasonWith([mkBookingSource('r2.source', 'r2.target', 2), mkGated('r2.target')], 1);
    const out0 = resolveTick(season, initialState(season), empty, f); // resolves tick 0 -> presents r2.source
    const brief = out0.packet.briefs.find((b) => b.storyletId === 'r2.source')!;
    const decision = { seatId: 'seat:throne', choices: [{ briefId: brief.briefId, optionId: 'book-it' }] };

    // Resolves tick 1: records the booking (byTick = 1 + 2 = 3). This same
    // call's own step 9 evaluates select() at nextTick 2 -- due (2 <= 3) but
    // the target is gated off (never eligible), so it holds.
    const out1 = resolveTick(season, out0.state, decision, f);
    expect(out1.state.bookings).toEqual([{ storyletId: 'r2.target', seatId: 'seat:throne', byTick: 3, bookedAt: 1 }]);
    expect(out1.events.some((e) => e.type === 'scene.booking.lapsed')).toBe(false); // (iii) hold persisted, visible end-to-end

    // Resolves tick 2: step 9 evaluates select() at nextTick 3 === byTick --
    // still ineligible, so it expires unfilled on this call.
    const out2 = resolveTick(season, out1.state, empty, f);
    const lapsed = out2.events.find((e) => e.type === 'scene.booking.lapsed');
    expect(lapsed).toBeDefined(); // (i) scene.booking.lapsed fires
    expect(lapsed?.data).toEqual({ storyletId: 'r2.target' });
    expect(lapsed?.deltas).toEqual([]);
    expect(lapsed?.parents).toEqual([]);
    expect(out2.state.bookings).toEqual([]); // (ii) removed from the returned ReignState.bookings
  });
});
