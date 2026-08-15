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
   *  this tick's eligible brief set against ReignState.eligibleLastTick (the
   *  prior snapshot) and hands in the difference; select partitions its
   *  non-probe pool into [newly, standing] and runs D13's novelty lottery
   *  within each, newly first, so a brief that just became possible outranks
   *  one that has sat eligible without being shown. */
  newlyEligible: Set<string>;
}

export interface SchedulerSelection {
  chosen: EligibleEntry[];
  letters: EligibleEntry[];
  skippedProbes: string[];
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
// causality §1 (recency casting) so it can run once per [newly, standing]
// partition -- called on a pool as its ONLY partition (the other left empty),
// this is byte-for-byte the pre-T1 loop: same slot indices from 0, same
// stratify-then-pick shape, same fortune draws.
function castByNovelty(
  pool: readonly EligibleEntry[],
  budget: number,
  presented: Record<string, number>,
  fortune: Fortune,
  tick: number,
): EligibleEntry[] {
  const chosen: EligibleEntry[] = [];
  let remaining = pool;
  for (let slot = 0; chosen.length < budget && remaining.length > 0; slot++) {
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
  return chosen;
}

export const examiner: SchedulerPolicy = {
  name: 'examiner',
  select({ tick, briefBudget, eligible, fortune, calendar, presented, newlyEligible }) {
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
    // Causality §1: recency casting. Partition what's left into [newly,
    // standing] and run D13's novelty lottery within each, newly first --
    // briefs that just became possible outrank ones that have been sitting
    // eligible, at equal presented counts. A tick where every eligible brief
    // is newly-eligible (tick 1: ReignState.eligibleLastTick starts empty,
    // so the diff is the whole pool) leaves `standing` empty and collapses
    // to the single castByNovelty call pre-T1 select() always made.
    const remaining = pool.filter((e) => !chosen.includes(e));
    const newly = remaining.filter((e) => newlyEligible.has(e.instanceKey));
    const standing = remaining.filter((e) => !newlyEligible.has(e.instanceKey));
    chosen.push(...castByNovelty(newly, briefBudget - chosen.length, presented, fortune, tick));
    chosen.push(...castByNovelty(standing, briefBudget - chosen.length, presented, fortune, tick));
    return { chosen, letters, skippedProbes };
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
