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
import type { StoryletOption } from './storylet.js';

export interface TierRule {
  from: number;
  to: number;
  kind: 'promote' | 'demote';
  when: GraphPattern;
  note: string;
  /** Content-authored graft applied delta-native on transition (see the
   *  design note above applyTransition): the next tier's world swapped in,
   *  or the Tier-0 camp. */
  effects?: GraphDelta[];
  /** v0.4.1: a transition may book its own arrival scene, guaranteeing a
   *  pivotal scene deals right after a promotion/demotion instead of
   *  competing in the same tick's novelty lottery against however much
   *  content the transition just made possible (a tier flip can graft an
   *  entire tier's cast in at once -- see content review's original
   *  motivating case: ~51 storylets newly-possible in one tick against a
   *  brief budget of 3). Identical shape to StoryletOption.books
   *  (storylet.ts), reused verbatim rather than redeclared, so tick.ts's
   *  existing recordBooking -- built for an OPTION's `books` -- accepts a
   *  transition's `books` with no transition-specific branch of its own.
   *  Recorded by tick.ts's step 8 immediately after this function returns
   *  (not by applyTransition itself, which stays free of the Booking/
   *  ReignState.bookings vocabulary, exactly as before this field existed):
   *  see resolveTick's own ladder step and its comment for the recording
   *  site, the seatId choice (the transition has no deciding seat of its
   *  own), and the scene.booked parent-event choice. */
  books?: NonNullable<StoryletOption['books']>;
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
  // Content-authored graft (see the design note above): swap the next
  // tier's world (or the Tier-0 camp) into the graph. node.add/edge.add
  // whose id is already present in g0 are dropped -- re-entry idempotency
  // for repeated rise/fall cycles -- filtered from both the applied graph
  // AND the tier.changed event's own deltas, since `deltas` is the one
  // array both draw from. Checked against g0 (the graph as of this
  // transition's start), not the post-vacate graph above: the vacate step
  // only ever removes appointment edges and sets inExile, so it can't
  // create an id collision effects would need to see.
  for (const d of rule.effects ?? []) {
    if (d.op === 'node.add' && g0.nodes[d.node.id]) continue;
    if (d.op === 'edge.add' && g0.edges[d.edge.id]) continue;
    deltas.push(d);
  }
  const g = applyDeltas(g0, deltas);
  em.emit('tier.changed', { deltas, data: { from: rule.from, to: rule.to, kind: rule.kind, note: rule.note, tick } });
  return g;
}
