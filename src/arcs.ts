// Character arcs (spec §5, T8): the famine-arc machinery (scheduler.ts's
// advanceArcs) generalized to people. A neglected character with an unmet
// want and thin loyalty grows RESTLESS (stage 1); left unanswered for two
// more three-tick spans, the disaffection becomes legible to a rival
// (stage 2 -- arc.poach.bid, informational only, offering the CURRENT
// want) and then irreversible (stage 3 -- arc.departed: the loyalty edge
// to the ruler is cut, the character crosses to the rival's court, but --
// spec §12 -- REMAINS IN THE GRAPH; departed characters keep paying
// narrative interest, they don't despawn). Fulfilling the want or winning
// back loyalty at any point before stage 3 RETAINS the character instead
// (arc.retained) and the arc closes clean.
//
// D14: every stage mutation is a GraphDelta[] applied through applyDeltas
// and carried on its emitted event -- the same discipline advanceArcs's
// famine lifecycle follows (see that function's own header) -- so the
// graph this function returns and the graph a replay reconstructs from
// the chronicle can never drift apart. See test/arcs.test.ts's lifecycle
// test, which proves this the same way advanceArcs's famine test does:
// replaying each call's own emitted deltas onto that call's pre-graph
// reproduces its actual return value.
//
// Determinism: no Fortune parameter anywhere in this module, even after
// Task 9's scheme arc lands below -- controller resolution confirmed:
// arming, stage advance, the telegraph gate, and the strike are ALL
// threshold checks on graph state (trait, loyalty bp, apt:judge, tick
// arithmetic), fully deterministic by construction. The apparatus's one
// Fortune-consuming step (vet's fidelity draw) lives in observe.ts /
// tick.ts instead, not here.
//
// Task 9 (spec §9): the scheme arc (kind 'scheme') generalizes the same
// arm -> stage-advance -> terminal shape restless already established,
// with two twists. (1) Arming has no OTHER subsystem's event to borrow a
// timestamp from (restless's ARM_NEGLECT_TICKS reads wantSinceTick, stamped
// by tick.ts's want-fulfillment pass) -- this module stamps and clears its
// OWN schemeSinceTick char prop as loyalty crosses the arm ceiling (see
// schemeSinceTickOf's header, and Pass 3 below). (2) The midpoint (stage 2,
// "commit") conditionally telegraphs itself to a competent spymaster
// instead of always emitting like restless's poach bid.
import type { Emitter, GraphDelta } from './events.js';
import { applyDeltas } from './events.js';
import type { WorldGraph } from './graph.js';
import { edgesFrom, edgesTo, findEdge, getNode, nodesOfType, propFx, propStr } from './graph.js';
import { aptOf, currentWant, hasTrait } from './spine.js';
import { clampFx, fx, FX_ZERO } from './fx.js';

/** Keyed in ReignState.arcs as `${kind}:${charId}`, so a character can
 *  carry a 'restless' arc and a 'scheme' arc at once: independent
 *  per-character slots, not a single arc-per-character constraint (see
 *  test/apparatus.test.ts's "independent per-character slots" pin). */
export interface CharacterArc {
  kind: 'restless' | 'scheme';
  charId: string;
  stage: number;
  sinceTick: number;
}

const LOYALTY_DEFAULT = 5000;       // neutral, absent-edge default -- same idiom report.ts/ops.ts/mediate.ts/observe.ts each repeat locally
const ARM_LOYALTY_CEILING = 4500;   // loyalty strictly below this is arm-eligible
const RETAIN_LOYALTY_FLOOR = 5500;  // loyalty at or above this retains
const ARM_NEGLECT_TICKS = 6;        // consecutive ticks the current want must sit unmet before arming
const STAGE_ADVANCE_TICKS = 3;      // ticks unarrested before stage++

// Task 9 (spec §9): the scheme arc's own thresholds. Kept as distinct named
// constants from restless's above even where a value happens to coincide
// (5500 retention appears in both) so either can move independently later
// -- the same discipline mediate.ts's WILLINGNESS_DRAG_DELAY_TICKS and
// RIDERS.slothfulDelay.delayTicks follow despite both being 2.
const SCHEME_LOYALTY_CEILING = 3500;           // (trait:cunning|vengeful) + loyalty strictly below this is scheme-eligible
const SCHEME_ARM_TICKS = 4;                    // consecutive ticks the condition must hold (via schemeSinceTick) before arming
const SCHEME_STAGE_ADVANCE_TICKS = 2;          // ticks per stage: sway(1) -> commit(2) -> strike(3)
const SCHEME_RETAIN_LOYALTY_FLOOR = 5500;      // loyalty at or above this retains an armed scheme arc
const SCHEME_SPYMASTER_JUDGE_THRESHOLD = 4000; // stage-2 telegraph gate: below this, or a vacant office, and the strike lands cold
const SCHEME_UNSET = -1;                       // schemeSinceTick sentinel ("no active tracking window") -- tick is always >= 0, so -1 never collides with a real tick
const STRIKE_LEGITIMACY_COST = fx('8');
const STRIKE_UNREST_DELTA = fx('10');

/** loyalty edge bp from `charId` to `rulerId`, defaulting to neutral
 *  (5000) when no edge exists -- the same idiom src/report.ts, src/ops.ts,
 *  src/mediate.ts, and src/observe.ts each already repeat locally rather
 *  than sharing one helper. */
function loyaltyBp(g: WorldGraph, charId: string, rulerId: string): number {
  const e = findEdge(g, 'loyalty', charId, rulerId);
  return typeof e?.props['bp'] === 'number' ? (e.props['bp'] as number) : LOYALTY_DEFAULT;
}

/** wantSinceTick node prop, defaulting to 0 when absent -- Task 7's
 *  advance stamps it on every want.fulfilled (see tick.ts's advanceWants),
 *  but a character whose CURRENT want has sat unfulfilled since before any
 *  fulfillment ever touched them never got a stamp at all; treating that
 *  absence as tick 0 makes "unmet since the graph was observed" the
 *  correct, conservative reading rather than a special case. */
function wantSinceTickOf(g: WorldGraph, charId: string): number {
  const v = getNode(g, charId).props['wantSinceTick'];
  return typeof v === 'number' ? v : 0;
}

/** schemeSinceTick node prop (Task 9, spec §9): unlike wantSinceTick above
 *  (T7), which only ever moves FORWARD (stamped once per want.fulfilled,
 *  never reset), scheme arming has no other subsystem's event to piggyback
 *  a timestamp on -- loyalty crossing the 3500 line isn't itself an event
 *  anywhere else in the engine. Pass 3 below therefore stamps AND clears
 *  this prop directly: SET to the current tick the first time
 *  (trait:cunning|vengeful && loyalty < 3500) is observed true, CLEARED
 *  back to SCHEME_UNSET the first time it's next observed false -- so a
 *  later re-drop below the ceiling restarts the 4-tick arming clock rather
 *  than inheriting a stale window from a past dip (test/apparatus.test.ts's
 *  "a recovery before arming unmarks and a later re-drop restarts the
 *  clock" pins exactly this). Both transitions are graph mutations, so
 *  (D14) each rides its own event (arc.scheme.marked / arc.scheme.unmarked)
 *  even though neither carries any OTHER consequence -- ticks where the
 *  condition merely continues (already marked, still eligible; or never
 *  marked, still ineligible) touch neither the graph nor the chronicle.
 *  Absent reads as SCHEME_UNSET, matching "never yet tracked." */
function schemeSinceTickOf(g: WorldGraph, charId: string): number {
  const v = getNode(g, charId).props['schemeSinceTick'];
  return typeof v === 'number' ? v : SCHEME_UNSET;
}

/** apt:judge of office:spymaster's appointee, or null if the office is
 *  vacant -- the stage-2 telegraph gate's own authority lookup (spec §9).
 *  Deliberately independent of vet's vettingAuthorityOf (observe.ts): the
 *  telegraph gate has NO ruler fallback -- a vacant spymaster's office
 *  means silence, full stop, unlike vet which always has someone to ask.
 *  Local lookup, the same idiom mediate.ts's executorOf / observe.ts's
 *  vettingAuthorityOf each re-derive rather than share. */
function spymasterJudgeOf(g: WorldGraph): number | null {
  const holder = edgesTo(g, 'office:spymaster').find((e) => e.type === 'appointment');
  return holder ? aptOf(g, holder.src, 'apt:judge') : null;
}

/** The STALE want one step behind wantIndex, floored at the chain's start
 *  (Task 9, spec §9: `wantChain[max(0, wantIndex - 1)]`) -- counter-intel's
 *  own read of "what a rival sees" once obscure_records has scrambled the
 *  crown's records. Mirrors currentWant's (spine.ts) prop-reading shape
 *  rather than importing it, since it needs the INDEX arithmetic
 *  currentWant intentionally hides. `fallback` is the CURRENT want the
 *  caller already computed this tick -- used only if wantChain/wantIndex
 *  somehow don't validate the same way currentWant just validated them
 *  moments ago (defensive; not expected to trigger in practice). */
function staleWantOf(g: WorldGraph, charId: string, fallback: string): string {
  const n = getNode(g, charId);
  const chain = n.props['wantChain'];
  const idx = n.props['wantIndex'];
  if (!Array.isArray(chain) || typeof idx !== 'number') return fallback;
  const staleIdx = idx - 1 < 0 ? 0 : idx - 1;
  const w = chain[staleIdx];
  return typeof w === 'string' ? w : fallback;
}

/** The departure delta bundle shared by every arc kind's terminal "leaves
 *  the court" stage (spec §5/§12, T8; reused by scheme's stage-3 strike,
 *  T9 -- extracted from T8's original inline version rather than
 *  duplicated): appointment edges vacated (so a defector can't remain the
 *  crown's hands -- mediate.ts's executorOf would otherwise still resolve
 *  them), the loyalty edge to the ruler cut, inRivalCourt flagged. Each
 *  caller appends its OWN arc-kind flag reset (arc:restless=false /
 *  arc:scheme=false) on top -- that part is kind-specific, this part
 *  isn't. Edge removes first, then the node.set, following ladder.ts's
 *  demote-to-exile convention. */
function departureDeltas(g: WorldGraph, charId: string, rulerId: string): GraphDelta[] {
  const deltas: GraphDelta[] = [];
  for (const edge of edgesFrom(g, charId, 'appointment')) {
    deltas.push({ op: 'edge.remove', id: edge.id });
  }
  const loyaltyEdge = findEdge(g, 'loyalty', charId, rulerId);
  if (loyaltyEdge) deltas.push({ op: 'edge.remove', id: loyaltyEdge.id });
  deltas.push({ op: 'node.set', id: charId, key: 'inRivalCourt', value: true });
  return deltas;
}

export function advanceCharacterArcs(
  g0: WorldGraph,
  tick: number,
  arcs: Record<string, CharacterArc>,
  em: Emitter,
  rivalId?: string,
  primaryPlaceId?: string,
): { g: WorldGraph; arcs: Record<string, CharacterArc> } {
  let g = g0;
  const next: Record<string, CharacterArc> = { ...arcs };
  const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');

  // Pass 1 -- RETENTION (checked before stage advance, every tick, per
  // spec) and STAGE ADVANCE, over arcs that already existed coming into
  // this call. Sorted by arc key (not just charId, though today's only
  // producer is 'restless:${charId}') so two characters crossing a
  // threshold the same tick chronicle in a stable order. Iterates the
  // ORIGINAL `arcs` snapshot, not `next`: nothing this pass itself retires
  // or advances can be re-examined by the same call.
  for (const key of Object.keys(arcs).sort()) {
    const arc = arcs[key]!;
    const { charId } = arc;
    const loyalty = loyaltyBp(g, charId, rulerId);

    if (arc.kind === 'restless') {
      const want = currentWant(g, charId);

      if (loyalty >= RETAIN_LOYALTY_FLOOR || want === null) {
        const deltas: GraphDelta[] = [{ op: 'node.set', id: charId, key: 'arc:restless', value: false }];
        g = applyDeltas(g, deltas);
        em.emit('arc.retained', { data: { charId }, deltas });
        delete next[key];
        continue;
      }

      if (tick - arc.sinceTick < STAGE_ADVANCE_TICKS) continue; // not yet due

      const stage = arc.stage + 1;
      if (stage === 2) {
        next[key] = { ...arc, stage, sinceTick: tick };
        if (rivalId !== undefined) {
          // Informational only (no deltas) -- normally offers the CURRENT
          // want. Counter-intel (obscure_records, Task 9, spec §9) starves
          // the rival's read of the bench: with counterIntel set on the
          // crown, the bid targets the STALE want instead (one step behind
          // wantIndex, floored at the chain's start, via staleWantOf) --
          // the rival's intelligence on this character is a step out of
          // date. Read the crown's prop at bid time, not arm time.
          const counterIntel = getNode(g, 'inst:crown').props['counterIntel'] === true;
          const offeredWant = counterIntel ? staleWantOf(g, charId, want) : want;
          em.emit('arc.poach.bid', { data: { charId, byId: rivalId, offeredWant } });
        }
      } else {
        // stage 3: DEPARTURE, terminal. Spec §12: departed characters
        // REMAIN IN THE GRAPH -- departureDeltas (shared with scheme's
        // stage-3 strike below) vacates appointments and cuts the loyalty
        // edge; this arm appends its own arc:restless=false reset on top.
        const deltas: GraphDelta[] = [...departureDeltas(g, charId, rulerId), { op: 'node.set', id: charId, key: 'arc:restless', value: false }];
        g = applyDeltas(g, deltas);
        em.emit('arc.departed', { data: { charId, toId: rivalId ?? null }, deltas });
        delete next[key];
      }
      continue;
    }

    // arc.kind === 'scheme' (Task 9, spec §9): same retention-then-
    // stage-advance shape as restless above, but retention has no
    // want-null exit (schemes aren't want-driven), and the terminal stage
    // (strike) hits the crown's legitimacy and the primary place's unrest
    // before departing.
    if (loyalty >= SCHEME_RETAIN_LOYALTY_FLOOR) {
      const deltas: GraphDelta[] = [
        { op: 'node.set', id: charId, key: 'arc:scheme', value: false },
        { op: 'node.set', id: charId, key: 'schemeSinceTick', value: SCHEME_UNSET }, // clears the tracking window (spec §9)
      ];
      g = applyDeltas(g, deltas);
      em.emit('arc.retained', { data: { charId }, deltas }); // same event type as restless's retention (spec §9: "same event")
      delete next[key];
      continue;
    }

    if (tick - arc.sinceTick < SCHEME_STAGE_ADVANCE_TICKS) continue; // not yet due

    const schemeStage = arc.stage + 1;
    if (schemeStage === 2) {
      next[key] = { ...arc, stage: schemeStage, sinceTick: tick };
      const spymasterJudge = spymasterJudgeOf(g);
      if (spymasterJudge !== null && spymasterJudge >= SCHEME_SPYMASTER_JUDGE_THRESHOLD) {
        em.emit('arc.scheme.telegraph', { data: { charId } }); // whisper-domain observation -- informational, no deltas
      } // else: silence -- a vacant office, or an incompetent (judge < 4000) spymaster, never hears it in time
    } else {
      // stage 3: STRIKE, terminal.
      const legitimacy = propFx(getNode(g, 'inst:crown').props, 'legitimacy');
      const deltas: GraphDelta[] = [
        { op: 'node.set', id: 'inst:crown', key: 'legitimacy', value: clampFx(legitimacy - STRIKE_LEGITIMACY_COST, FX_ZERO, fx('100')) },
      ];
      if (primaryPlaceId !== undefined) {
        const unrest = propFx(getNode(g, primaryPlaceId).props, 'unrest');
        deltas.push({ op: 'node.set', id: primaryPlaceId, key: 'unrest', value: clampFx(unrest + STRIKE_UNREST_DELTA, FX_ZERO, fx('100')) });
      } // else: no primary place configured -- the strike still lands, just without a place to unsettle
      deltas.push(...departureDeltas(g, charId, rulerId));
      deltas.push({ op: 'node.set', id: charId, key: 'arc:scheme', value: false });
      deltas.push({ op: 'node.set', id: charId, key: 'schemeSinceTick', value: SCHEME_UNSET });
      g = applyDeltas(g, deltas);
      em.emit('arc.scheme.struck', { data: { charId }, deltas });
      delete next[key];
    }
  }

  // Pass 2 -- ARMING: any character not already carrying an active
  // 'restless' arc (checked against `next`, i.e. after pass 1's
  // retentions/departures freed their slot). By construction a character
  // retained or departed THIS tick can never also satisfy arming this same
  // tick: retention requires loyalty >= 5500 or a null want, and departure
  // deletes the loyalty edge outright (loyaltyBp then reads the neutral
  // 5000 default) -- either way arming's loyalty < 4500 check fails, so
  // the pass order here doesn't change the outcome, only the chronicle's
  // event order. Sorted by character node id, mirroring advanceWants
  // (tick.ts) and every other per-character pass in this codebase.
  for (const char of nodesOfType(g, 'character')) {
    const charId = char.id;
    const key = `restless:${charId}`;
    if (next[key]) continue;
    const want = currentWant(g, charId);
    if (want === null) continue;
    if (loyaltyBp(g, charId, rulerId) >= ARM_LOYALTY_CEILING) continue;
    if (tick - wantSinceTickOf(g, charId) < ARM_NEGLECT_TICKS) continue;
    const deltas: GraphDelta[] = [{ op: 'node.set', id: charId, key: 'arc:restless', value: true }];
    g = applyDeltas(g, deltas);
    em.emit('arc.restless', { data: { charId, wantKey: want }, deltas });
    next[key] = { kind: 'restless', charId, stage: 1, sinceTick: tick };
  }

  // Pass 3 -- SCHEME TRACKING + ARMING (Task 9, spec §9): mirrors Pass 2's
  // shape (every character not already carrying an active 'scheme' arc,
  // sorted by node id) but the eligibility clock is this pass's OWN
  // responsibility rather than borrowed from another subsystem's event
  // (see schemeSinceTickOf's header). Per character, per tick, exactly one
  // of three things happens: (a) INELIGIBLE now, but was tracked -> clear
  // schemeSinceTick, emit arc.scheme.unmarked (a recovery before arming);
  // (b) ELIGIBLE, not yet tracked -> stamp schemeSinceTick = this tick,
  // emit arc.scheme.marked (0 ticks elapsed so far -- never also arms the
  // same tick it's first marked, since SCHEME_ARM_TICKS > 0); (c)
  // ELIGIBLE, already tracked for >= SCHEME_ARM_TICKS ticks -> arm at
  // stage 1 (arc:scheme=true, arc.scheme.sway). Everything else (still
  // ineligible and never was tracked; eligible but not yet at the arm
  // threshold) touches neither the graph nor the chronicle -- most ticks,
  // for most characters, are silent no-ops here, exactly like Pass 2.
  for (const char of nodesOfType(g, 'character')) {
    const charId = char.id;
    const key = `scheme:${charId}`;
    if (next[key]) continue; // already an active scheme arc -- Pass 1 owns it now
    const eligible = (hasTrait(g, charId, 'cunning') || hasTrait(g, charId, 'vengeful')) && loyaltyBp(g, charId, rulerId) < SCHEME_LOYALTY_CEILING;
    const since = schemeSinceTickOf(g, charId);

    if (!eligible) {
      if (since !== SCHEME_UNSET) {
        const deltas: GraphDelta[] = [{ op: 'node.set', id: charId, key: 'schemeSinceTick', value: SCHEME_UNSET }];
        g = applyDeltas(g, deltas);
        em.emit('arc.scheme.unmarked', { data: { charId }, deltas });
      }
      continue;
    }

    let markedTick = since;
    if (since === SCHEME_UNSET) {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: charId, key: 'schemeSinceTick', value: tick }];
      g = applyDeltas(g, deltas);
      em.emit('arc.scheme.marked', { data: { charId }, deltas });
      markedTick = tick;
    }
    if (tick - markedTick >= SCHEME_ARM_TICKS) {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: charId, key: 'arc:scheme', value: true }];
      g = applyDeltas(g, deltas);
      em.emit('arc.scheme.sway', { data: { charId }, deltas });
      next[key] = { kind: 'scheme', charId, stage: 1, sinceTick: tick };
    }
  }

  return { g, arcs: next };
}
