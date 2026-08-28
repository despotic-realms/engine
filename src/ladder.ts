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
import type { Fx } from './fx.js';
import type { WorldGraph } from './graph.js';
import { edgesOfType, getNode, propFx, propInt } from './graph.js';
import type { GraphPattern } from './match.js';
import { matchPattern } from './match.js';
import type { StoryletOption } from './storylet.js';

export interface TierRule {
  from: number;
  to: number;
  kind: 'promote' | 'demote';
  /** The ordinary graph-pattern gate. Optional as of the claim tier gate
   *  (claimRequire, below): a rule authors EITHER `when` OR `claimRequire`,
   *  never both -- when claimRequire is present, checkLadder evaluates it
   *  alone and never also consults `when` on that same rule. Still the
   *  only gate shape for every non-claim rule. */
  when?: GraphPattern;
  /** Claim tier gate (2026-08-20 claim plan, Global Constraints --
   *  verbatim-binding shape): the rule fires when the graph's declared
   *  backing bp sum clears `backingBp` AND the crown's treasury clears
   *  `treasury` -- see checkLadder and declaredBackingBp below. The exile
   *  return rule switches to this (content wave, claim plan Task 7); the
   *  old legitimacy/treasury `when` thresholds and the dev-return flag are
   *  content's to delete, not this engine's. */
  claimRequire?: { backingBp: number; treasury: Fx };
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
   *  own), and the scene.booked parent-event choice.
   *
   *  Review fix (v0.4.1): this `books` and a StoryletOption's `books`
   *  (storylet.ts) are allowed to name the SAME storyletId in the same
   *  reign -- e.g. a tier-0 brief's default books the arrival scene as a
   *  fallback, and the transition books it too. No special-casing exists
   *  for this anywhere: each recording just appends its own independent
   *  Booking to ReignState.bookings, and scheduler.ts's PRE-EXISTING
   *  due-bookings tie-break (sort by storyletId, then bookedAt, then
   *  seatId -- unmodified by this feature) resolves the collision exactly
   *  like any other same-storyletId collision -- earliest bookedAt claims
   *  the one eligible instance, the other finds no candidate left and
   *  lapses (if also due that tick) or holds. Two scene.booked events land
   *  in the chronicle for one eventual arrival; both bookings still
   *  terminate dealt-or-lapsed, never stuck. See test/bookings.test.ts's
   *  "an option booking and a transition booking racing for the same
   *  storyletId" test. */
  books?: NonNullable<StoryletOption['books']>;
}

// Controller-pinned seam (T5, 2026-08-20 claim plan): press_claim's decisive
// bands (ops.ts) stamp crown props claimPromoteTo/claimDemoteTo with a PLAIN
// TIER NUMBER -- 0 is a real tier (the exile floor: applyTransition's own
// demote-to-0 branch below), so every read of either prop is
// `typeof === 'number'`, never truthiness (mirrors test/flashpoint.test.ts's
// own "exercises !== undefined, not truthiness" fixture comment). No delta
// op can remove a node prop outright -- GraphDelta's node.set (events.ts)
// can only WRITE a value, and neither graph.ts nor events.ts is in this
// task's file list to add one -- so "the transition clears the prop" (this
// task's own brief, and the plan) is implemented the same way this codebase
// already clears a decayed claimNudge: systems.ts's claimNudgeDecayStep
// writes claimNudge -> 0 and claimNudgeAt -> -1, sentinels chosen because 0
// IS a legitimate claimNudge but -1 can never be a real tick. Here,
// CLAIM_TARGET_NONE (-1) plays the same role: -1 can never be a real tier
// (tiers are non-negative by construction -- 0 is the floor), so a rule
// authored with `to: -1` is not a thing content can even do. claimTarget
// (below) is the ONLY reader of either prop anywhere in this file, and it
// folds CLAIM_TARGET_NONE back into `undefined` -- so from every caller's
// point of view in this module, a cleared prop reads as absent, exactly as
// documented, even though the graph itself still carries a live sentinel
// value rather than a deleted key.
export const CLAIM_TARGET_NONE = -1;

function claimTarget(g: WorldGraph, key: 'claimPromoteTo' | 'claimDemoteTo'): number | undefined {
  const v = g.nodes['inst:crown']?.props[key];
  return typeof v === 'number' && v !== CLAIM_TARGET_NONE ? v : undefined;
}

/** Sum of `bp` across every declared `backing` edge (claim plan, Global
 *  Constraints) -- exported so report.ts's claim projection reuses this
 *  EXACT computation for its own `gate.backingHave` field, rather than
 *  re-deriving the same sum a second place where it could silently drift
 *  from the real gating logic just below. */
export function declaredBackingBp(g: WorldGraph): number {
  let sum = 0;
  for (const e of edgesOfType(g, 'backing')) sum += propInt(e.props, 'bp');
  return sum;
}

function claimGateMet(g: WorldGraph, gate: NonNullable<TierRule['claimRequire']>): boolean {
  if (declaredBackingBp(g) < gate.backingBp) return false;
  return propFx(getNode(g, 'inst:crown').props, 'treasury') >= gate.treasury;
}

export function checkLadder(g: WorldGraph, tier: number, tick: number, rules: readonly TierRule[]): TierRule | null {
  if (tick % 4 !== 3) return null; // transitions land at year end

  // Controller-pinned seam (T5): a decisive flashpoint result outranks
  // every ordinary rule below -- narrative fiat from the campaign's own
  // climax, already proven at the flashpoint roll, is never re-litigated
  // against a threshold a second time. Checked in FIXED priority order
  // (promote before demote): a tick where content somehow leaves BOTH
  // props set at once (never authored deliberately -- the engine still
  // resolves it deterministically) has promote win. Matched by the EXACT
  // (from, kind, to) triple against the season's own authored rules --
  // never a synthetic rule built from the prop alone -- so the matched
  // rule's `effects`/`books`/`note` apply on the decisive path exactly as
  // they would on the ordinary claimRequire/when path (Global Constraint:
  // claimRequire composes with TierRule.books). A decisive prop with no
  // matching (from, kind, to) rule this tick -- e.g. the tier already
  // moved by an unrelated route -- is left untouched here; it is
  // re-considered every future year-end until it either matches or a
  // fresh press_claim overwrites it. Only applyTransition, never this
  // function, ever clears a prop -- see its own comment for why the clear
  // is re-derived there instead of threaded through this function's
  // TierRule | null return.
  const promoteTo = claimTarget(g, 'claimPromoteTo');
  if (promoteTo !== undefined) {
    const rule = rules.find((r) => r.from === tier && r.kind === 'promote' && r.to === promoteTo);
    if (rule) return rule;
  }
  const demoteTo = claimTarget(g, 'claimDemoteTo');
  if (demoteTo !== undefined) {
    const rule = rules.find((r) => r.from === tier && r.kind === 'demote' && r.to === demoteTo);
    if (rule) return rule;
  }

  for (const rule of rules) {
    if (rule.from !== tier) continue;
    if (rule.claimRequire) {
      if (claimGateMet(g, rule.claimRequire)) return rule;
      continue;
    }
    if (rule.when && matchPattern(g, rule.when).length > 0) return rule;
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

  // Controller-pinned seam (T5): clear a consumed decisive signal as part
  // of THIS transition's own deltas (D14 -- delta'd through tier.changed,
  // never a side-channel mutation). "Consumed" is re-derived here, from g0
  // and `rule` alone, rather than threaded down from checkLadder (whose
  // return type, TierRule | null, has no room to also say WHY a rule
  // matched): a decisive prop counts as consumed by THIS transition when
  // its own (kind, to) names exactly this rule's (kind, to) -- the same
  // triple checkLadder's own decisive branch matched on above. Once EITHER
  // prop is recognized as the cause, BOTH are cleared unconditionally
  // (Global Constraints' own words for the pathological both-set tick:
  // "promote wins, both cleared") -- so a stale opposite-direction signal
  // left over from an earlier, unconsumed flashpoint never lingers past
  // the transition that finally fires. Each prop is only ever written if
  // it was actually present (claimTarget !== undefined), so a crown that
  // never carried the OTHER prop at all doesn't gain a spurious cleared
  // one. See CLAIM_TARGET_NONE's own comment for why a sentinel, not real
  // key deletion.
  const promoteTo = claimTarget(g0, 'claimPromoteTo');
  const demoteTo = claimTarget(g0, 'claimDemoteTo');
  const consumesDecisive =
    (rule.kind === 'promote' && promoteTo === rule.to) || (rule.kind === 'demote' && demoteTo === rule.to);
  if (consumesDecisive) {
    if (promoteTo !== undefined) deltas.push({ op: 'node.set', id: 'inst:crown', key: 'claimPromoteTo', value: CLAIM_TARGET_NONE });
    if (demoteTo !== undefined) deltas.push({ op: 'node.set', id: 'inst:crown', key: 'claimDemoteTo', value: CLAIM_TARGET_NONE });
  }

  const g = applyDeltas(g0, deltas);
  em.emit('tier.changed', { deltas, data: { from: rule.from, to: rule.to, kind: rule.kind, note: rule.note, tick } });
  return g;
}
