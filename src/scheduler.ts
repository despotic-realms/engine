// §6.4, the RimWorld lesson: same events, same sim, swappable dramaturgy.
// The examiner is the benchmark-season policy: a seeded, FIXED probe
// schedule (static data — chance is banned from the calendar, D21), with
// leftover brief slots cast from eligible storylets via the casting stream.
// Showrunner (tension pacing) and storyteller (challenge pacing) implement
// this same SchedulerPolicy interface in later seasons.
//
// D14: chronicle events ARE graph deltas -- advanceArcs follows the same
// discipline economyStep and socialStep use (systems.ts). Every famine
// mutation below is built as a GraphDelta[], applied through applyDeltas
// (the same function a replay would use), and handed to the emitted event
// as its `deltas` -- so the graph advanceArcs returns and the graph a
// replay would reconstruct from the chronicle can never drift apart. See
// test/scheduler.test.ts's arc lifecycle test, which proves this by
// replaying each call's deltas independently and hashing the result
// against that call's actual return value. examiner.select, by contrast,
// mutates nothing and emits nothing -- pure selection over the graph and
// fortune it's handed.
import type { Emitter, GraphDelta } from './events.js';
import { applyDeltas } from './events.js';
import type { Fortune } from './fortune.js';
import type { WorldGraph } from './graph.js';
import { nodesOfType, propInt } from './graph.js';
import type { EligibleEntry } from './storylet.js';

export type ExaminerCalendar = Array<{
  tick: number;
  storyletId?: string;
  armFamine?: { placeId: string; durationTicks: number };
}>;

/** Causality §3 (T4): one booked follow-up (spec §3) -- StoryletOption.books
 *  applied at choice-application time (tick.ts, any path that lands the
 *  chosen option: attended, defaulted, neglected) appends one of these to
 *  ReignState.bookings, threaded like `arcs`/`eligibleLastTick`. `byTick` is
 *  the LAST tick (inclusive) this booking is still due -- computed once, at
 *  record time, as (the tick the option was chosen) + withinTicks; select()
 *  below never recomputes it, only compares `tick <= byTick`. `bookedAt` is
 *  informational only (content/debugging), never read here. */
export interface Booking { storyletId: string; seatId: string; byTick: number; bookedAt: number }

export interface SchedulerContext {
  tick: number;
  briefBudget: number;
  eligible: EligibleEntry[];
  fortune: Fortune;
  calendar: ExaminerCalendar;
  /** Times each instanceKey has already been presented as a brief (D13
   *  novelty casting). Read-only here; tick.ts passes the pre-increment
   *  snapshot, so selection for tick N sees counts as of N-1. */
  presented: Record<string, number>;
  /** Instance keys eligible now but NOT last tick (causality §1: recency
   *  casting -- "the world answers the player" starts here). tick.ts diffs
   *  this tick's pattern-possibility set (which instances' patterns bind,
   *  unfiltered by cooldowns/firedOnce/caps) against
   *  ReignState.eligibleLastTick (the prior possibility snapshot) and hands
   *  in the difference; select partitions its
   *  non-probe pool into [newly, standing] and runs D13's novelty lottery
   *  within each, newly first, so a brief that just became possible outranks
   *  one that has sat eligible without being shown. */
  newlyEligible: Set<string>;
  /** Causality §1 (T2): computed attribution -- instanceKey -> sorted
   *  attributing player event ids, for instance keys drawn from
   *  `newlyEligible` (attribution.ts's attribute() is only ever asked about
   *  newly-eligible entries; a standing instanceKey is never a key here).
   *  Membership alone (not the array's contents) is what select() below
   *  uses to further split `newly` into [attributed, world-newly] -- the
   *  event ids themselves are tick.ts's business (attaching Brief.becauseOf
   *  to the briefs it constructs from sel.chosen). Kept as a pre-computed
   *  Map rather than re-derived here so scheduler.ts stays free of event/
   *  ancestry logic, per the causality plan's file structure (attribution.ts
   *  owns the model). */
  becauseOf: Map<string, string[]>;
  /** Causality §3 (T4): ReignState.bookings, unfiltered -- select() reads
   *  every booking regardless of due-ness and applies the `tick <= byTick`
   *  gate itself (mirrors how it already owns the calendar-tick match for
   *  probes, just above). Read-only here: recording (choice application)
   *  and removal (dealt or lapsed, via SchedulerSelection's
   *  dealtBookings/lapsedBookings below) both live in tick.ts -- see this
   *  file's header, "examiner.select... mutates nothing and emits nothing." */
  bookings: Booking[];
}

export interface SchedulerSelection {
  chosen: EligibleEntry[];
  letters: EligibleEntry[];
  skippedProbes: string[];
  /** Causality §3 (T4): bookings force-dealt this tick -- the SAME object
   *  references as their matching entries in ctx.bookings, so tick.ts can
   *  remove them from ReignState.bookings by identity (`.includes`) without
   *  needing a synthetic booking id. The deal itself needs no event of its
   *  own: the forced entry rides the ordinary brief.presented path exactly
   *  like a probe or a lottery pick. */
  dealtBookings: Booking[];
  /** Causality §3 (T4): bookings that expired unfilled this tick (due --
   *  tick === byTick -- and still not dealt, whether never eligible or
   *  crowded out). tick.ts emits scene.booking.lapsed for each and removes
   *  them from ReignState.bookings the same way. */
  lapsedBookings: Booking[];
}

export interface SchedulerPolicy {
  name: string;
  select(ctx: SchedulerContext): SchedulerSelection;
}

// D13: draws from the least-presented stratum first, so a healthy reign
// spreads across the pool instead of looping a favorite few. Counts are per
// instanceKey, so a perBinding generator's fresh binding competes at count 0
// like any other unseen content. Ties within a stratum keep the seeded
// lottery; an all-tied pool (the common case early in a reign, or any
// single-partition call) is exactly the old unstratified draw. Extracted for
// causality §1 (recency casting) so it can run once per partition of the
// non-probe pool -- T1 introduced two ([newly, standing]), T2 splits
// `newly` further into [attributed, world-newly] (three total) -- but
// fortune.pick('casting', tick, 'slot', stratum, slot) is a pure hash of
// (tick, 'slot', slot), only reduced onto `stratum` afterward by modulo, so
// two calls that both start counting slots at 0 in the same tick collide:
// one partition's k-th draw and another's k-th draw would hash the
// identical key. `startSlot` fixes this -- each caller threads the counter
// from the previous call's `nextSlot` (attributed -> world-newly ->
// standing), so every draw in a tick gets a unique slot regardless of which
// partition it lands in. A pool called as the ONLY non-empty partition
// (every other one left empty, startSlot 0) is still byte-for-byte the
// pre-T1 loop: same slot indices from 0, same stratify-then-pick shape,
// same fortune draws -- an empty partition consumes zero slots (the loop
// body never runs), so the surviving partition draws 0,1,2,... exactly as
// before, no matter how many empty partitions it's threaded past.
function castByNovelty(
  pool: readonly EligibleEntry[],
  budget: number,
  presented: Record<string, number>,
  fortune: Fortune,
  tick: number,
  startSlot: number,
): { chosen: EligibleEntry[]; nextSlot: number } {
  const chosen: EligibleEntry[] = [];
  let remaining = pool;
  let slot = startSlot;
  for (; chosen.length < budget && remaining.length > 0; slot++) {
    // Min by hand, not Math.min (banned in core, see ops.ts's clampBp).
    let minCount = presented[remaining[0]!.instanceKey] ?? 0;
    for (const e of remaining) {
      const count = presented[e.instanceKey] ?? 0;
      if (count < minCount) minCount = count;
    }
    const stratum = remaining.filter((e) => (presented[e.instanceKey] ?? 0) === minCount);
    const pick = fortune.pick('casting', tick, 'slot', stratum, slot);
    chosen.push(pick);
    remaining = remaining.filter((e) => e !== pick);
  }
  return { chosen, nextSlot: slot };
}

export const examiner: SchedulerPolicy = {
  name: 'examiner',
  select({ tick, briefBudget, eligible, fortune, calendar, presented, newlyEligible, becauseOf, bookings }) {
    const letters = eligible.filter((e) => e.storylet.kind === 'letter');
    const pool = eligible.filter((e) => e.storylet.kind === 'brief');
    const chosen: EligibleEntry[] = [];
    const skippedProbes: string[] = [];

    // Probes are the instrument: forced regardless of presentation count.
    for (const entry of calendar) {
      if (entry.tick !== tick || entry.storyletId === undefined) continue;
      const hit = pool.find((e) => e.storylet.id === entry.storyletId);
      if (hit && chosen.includes(hit)) continue; // true dedup: already forced this tick, not a failure
      if (hit && chosen.length < briefBudget) chosen.push(hit);
      else skippedProbes.push(entry.storyletId); // absent from the pool, or budget already spent -- either way, unobserved
    }

    // Causality §3 (T4): due bookings force-deal next -- after probes,
    // before the recency/attribution lottery strata below -- consuming NO
    // fortune draws (an authored booking is a certainty, not a lottery
    // entry), so the slot counter castByNovelty threads below always starts
    // at 0 regardless of how many bookings just dealt. An empty `bookings`
    // array (every pre-T4 call site) makes this whole loop a no-op, so the
    // no-bookings path reproduces T2's exact behavior byte-for-byte,
    // including its fortune draw sequence. Sorted by (storyletId, bookedAt,
    // seatId) for fully order-stable processing regardless of
    // ReignState.bookings' own insertion order (Global Constraints:
    // "bookings processed in sorted stable order") -- the tuple ties only
    // when the SAME storyletId was booked more than once, which has no
    // other natural tiebreak once threaded through plain-object state.
    const dealtBookings: Booking[] = [];
    const lapsedBookings: Booking[] = [];
    const sortedBookings = [...bookings].sort((a, b) =>
      a.storyletId !== b.storyletId ? (a.storyletId < b.storyletId ? -1 : 1) :
      a.bookedAt !== b.bookedAt ? a.bookedAt - b.bookedAt :
      a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0,
    );
    for (const booking of sortedBookings) {
      // Past due (tick > byTick, not just ===): the booking's window closed
      // before select() ever got to look at it -- e.g. a withinTicks <= 0
      // booking has byTick <= the tick it was recorded on, already behind
      // nextTick (this same resolveTick call's own step 9) the very first
      // time any select() call evaluates it at all. Lapsing here (rather
      // than the old silent `continue`, which skipped it into neither
      // dealtBookings nor lapsedBookings and left it stuck in
      // ReignState.bookings forever -- tick.ts's removal filter only
      // subtracts what's in one of those two arrays) keeps the lifecycle
      // TOTAL: every booking this loop sees terminates dealt or lapsed, on
      // this pass or a later one, never neither. Also covers any other
      // future path where select's first look at a booking lands past
      // byTick, not just withinTicks <= 0.
      if (tick > booking.byTick) { lapsedBookings.push(booking); continue; }
      // Multi-binding tie-break (causality plan T4): a perBinding storylet
      // can produce more than one currently-eligible EligibleEntry sharing
      // this storyletId -- sorted first by instanceKey, deterministic and
      // independent of fortune (bookings never draw). Also excludes
      // whatever a probe (or an earlier booking this same pass) already
      // claimed, the same dedup probes apply to themselves above.
      const candidates = pool
        .filter((e) => e.storylet.id === booking.storyletId && !chosen.includes(e))
        .sort((a, b) => (a.instanceKey < b.instanceKey ? -1 : a.instanceKey > b.instanceKey ? 1 : 0));
      const hit = candidates[0];
      if (hit !== undefined && chosen.length < briefBudget) {
        chosen.push(hit);
        dealtBookings.push(booking);
      } else if (tick === booking.byTick) {
        lapsedBookings.push(booking); // last due tick, still not dealt (ineligible, or crowded out) -- expires unfilled
      } // else: holds -- still within window (tick < byTick), tries again next tick
    }

    // Causality §1: recency + attribution casting. Partition what's left
    // into [newly, standing] (T1), then split `newly` further into
    // [attributed, world-newly] (T2, via `becauseOf` membership) and run
    // D13's novelty lottery within each of the three, attributed first --
    // a brief the PLAYER's own writes just made possible outranks one the
    // world made possible, which outranks one that's been sitting eligible.
    // A tick with no attribution at all (becauseOf empty -- e.g. a reign's
    // opening moves, or a tick with no decisions) leaves `attributedNewly`
    // empty and collapses to T1's exact two-partition behavior; a tick
    // where every eligible brief is ALSO newly-eligible with nothing
    // world-newly (tick 1: ReignState.eligibleLastTick starts empty)
    // further collapses toward the single castByNovelty call pre-T1
    // select() always made. The slot counter threads across all three
    // calls in casting order (attributed -> world-newly -> standing) so no
    // two partitions' draws ever hash the same fortune key -- see
    // castByNovelty's comment.
    const remaining = pool.filter((e) => !chosen.includes(e));
    const newly = remaining.filter((e) => newlyEligible.has(e.instanceKey));
    const standing = remaining.filter((e) => !newlyEligible.has(e.instanceKey));
    const attributedNewly = newly.filter((e) => becauseOf.has(e.instanceKey));
    const worldNewly = newly.filter((e) => !becauseOf.has(e.instanceKey));
    const attributedCast = castByNovelty(attributedNewly, briefBudget - chosen.length, presented, fortune, tick, 0);
    chosen.push(...attributedCast.chosen);
    const worldCast = castByNovelty(worldNewly, briefBudget - chosen.length, presented, fortune, tick, attributedCast.nextSlot);
    chosen.push(...worldCast.chosen);
    const standingCast = castByNovelty(standing, briefBudget - chosen.length, presented, fortune, tick, worldCast.nextSlot);
    chosen.push(...standingCast.chosen);
    return { chosen, letters, skippedProbes, dealtBookings, lapsedBookings };
  },
};

export function advanceArcs(g0: WorldGraph, tick: number, calendar: ExaminerCalendar, em: Emitter): WorldGraph {
  let g = g0;
  const armedNow = new Set<string>();
  for (const entry of calendar) {
    if (entry.tick !== tick || !entry.armFamine) continue;
    const { placeId, durationTicks } = entry.armFamine;
    const deltas: GraphDelta[] = [
      { op: 'node.set', id: placeId, key: 'famineStage', value: 1 },
      { op: 'node.set', id: placeId, key: 'famineEndsAt', value: tick + durationTicks },
    ];
    g = applyDeltas(g, deltas);
    armedNow.add(placeId);
    em.emit('crisis.famine.armed', { deltas, data: { placeId, durationTicks } });
  }
  for (const node of nodesOfType(g, 'place')) {
    if (armedNow.has(node.id)) continue;
    const stage = propInt(node.props, 'famineStage');
    if (stage === 0) continue;
    if (tick >= propInt(node.props, 'famineEndsAt')) {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: node.id, key: 'famineStage', value: 0 }];
      g = applyDeltas(g, deltas);
      em.emit('crisis.famine.ended', { deltas, data: { placeId: node.id } });
    } else {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: node.id, key: 'famineStage', value: stage + 1 }];
      g = applyDeltas(g, deltas);
      em.emit('crisis.famine.advanced', { deltas, data: { placeId: node.id, stage: stage + 1 } });
    }
  }
  return g;
}
