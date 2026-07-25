// D8: the rags-to-riches-and-back ladder, bidirectional, tier-count-
// agnostic: tiers are content modules, transitions are data-driven pattern
// rules checked at year end. Falling is a change of playing field, not a
// game-over screen.
//
// D14: chronicle events ARE graph deltas, same discipline as ops.ts and
// economyStep. applyTransition builds every mutation as a GraphDelta[],
// applies it through applyDeltas (the same function a replay would use),
// and hands it to tier.changed as its `deltas` -- so the graph
// applyTransition returns and the graph a replay would reconstruct from
// the chronicle can never drift apart. See test/ladder.test.ts's
// "applyTransition delta-equivalence" case.
import { applyDeltas } from './events.js';
import type { Emitter, GraphDelta } from './events.js';
import type { WorldGraph } from './graph.js';
import { edgesOfType } from './graph.js';
import type { GraphPattern } from './match.js';
import { matchPattern } from './match.js';

export interface TierRule {
  from: number;
  to: number;
  kind: 'promote' | 'demote';
  when: GraphPattern;
  note: string;
}

export function checkLadder(g: WorldGraph, tier: number, tick: number, rules: readonly TierRule[]): TierRule | null {
  if (tick % 4 !== 3) return null; // transitions land at year end
  for (const rule of rules) {
    if (rule.from !== tier) continue;
    if (matchPattern(g, rule.when).length > 0) return rule;
  }
  return null;
}

export function applyTransition(g0: WorldGraph, rule: TierRule, tick: number, em: Emitter): WorldGraph {
  const deltas: GraphDelta[] = [];
  // Falling to Tier 0 is exile: every office the crown held comes vacant
  // (a change of playing field, not a game-over screen), and the crown
  // itself is marked so downstream systems know it has no seat.
  if (rule.kind === 'demote' && rule.to === 0) {
    for (const e of edgesOfType(g0, 'appointment')) deltas.push({ op: 'edge.remove', id: e.id });
    deltas.push({ op: 'node.set', id: 'inst:crown', key: 'inExile', value: true });
  }
  const g = applyDeltas(g0, deltas);
  em.emit('tier.changed', { deltas, data: { from: rule.from, to: rule.to, kind: rule.kind, note: rule.note, tick } });
  return g;
}
