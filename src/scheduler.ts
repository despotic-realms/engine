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
import { propInt } from './graph.js';
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

export const examiner: SchedulerPolicy = {
  name: 'examiner',
  select({ tick, briefBudget, eligible, fortune, calendar }) {
    const letters = eligible.filter((e) => e.storylet.kind === 'letter');
    const pool = eligible.filter((e) => e.storylet.kind === 'brief');
    const chosen: EligibleEntry[] = [];
    const skippedProbes: string[] = [];

    for (const entry of calendar) {
      if (entry.tick !== tick || entry.storyletId === undefined) continue;
      const hit = pool.find((e) => e.storylet.id === entry.storyletId);
      if (hit && !chosen.includes(hit) && chosen.length < briefBudget) chosen.push(hit);
      else if (!hit) skippedProbes.push(entry.storyletId);
    }
    let remaining = pool.filter((e) => !chosen.includes(e));
    for (let slot = 0; chosen.length < briefBudget && remaining.length > 0; slot++) {
      const pick = fortune.pick('casting', tick, 'slot', remaining, slot);
      chosen.push(pick);
      remaining = remaining.filter((e) => e !== pick);
    }
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
  for (const place of Object.keys(g.nodes).sort()) {
    const node = g.nodes[place];
    if (!node || node.type !== 'place' || armedNow.has(place)) continue;
    const stage = propInt(node.props, 'famineStage');
    if (stage === 0) continue;
    if (tick >= propInt(node.props, 'famineEndsAt')) {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: place, key: 'famineStage', value: 0 }];
      g = applyDeltas(g, deltas);
      em.emit('crisis.famine.ended', { deltas, data: { placeId: place } });
    } else {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: place, key: 'famineStage', value: stage + 1 }];
      g = applyDeltas(g, deltas);
      em.emit('crisis.famine.advanced', { deltas, data: { placeId: place, stage: stage + 1 } });
    }
  }
  return g;
}
