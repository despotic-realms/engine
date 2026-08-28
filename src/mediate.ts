// Mediated execution (spec §3): above tier 0 an op travels through an
// office. Gate -> willingness -> band -> modulation -> riders. The one RNG
// entry is the band draw; riders are pure functions of the drawn band.
// Every mutation is a GraphDelta[] applied via applyDeltas and carried on
// the emitted event (D14).
import { applyDeltas } from './events.js';
import type { Emitter, GraphDelta } from './events.js';
import type { Fortune } from './fortune.js';
import { drawBand } from './bands.js';
import type { WorldGraph } from './graph.js';
import { edgesTo, findEdge, getNode, propStr } from './graph.js';
import { fx, fxToString, mulFx, FX_ZERO } from './fx.js';
import type { Fx } from './fx.js';
import { canonJson } from './canon.js';
import { applyOp, validateOp, OP_KINDS, type FlashpointDef, type Op } from './ops.js';
import { currentWant, hasTrait, aptOf, BANDS, type AptKey, type Band } from './spine.js';

export interface MediationConfig {
  officeForDomain: Record<'econ' | 'martial' | 'social', string>;
  willingness: boolean;
}

// Task 4 (spec §3.5): the willingness verdict, and the two closed reason
// strings applyMediatedOp's op.refused event may report -- exactly the
// ones the brief names, so a caller never has to invent a third.
export type Willingness = 'complies' | 'drags' | 'refuses';
type RefusalReason = 'disloyal' | 'grudge';

// A want's domain affinity for the +500 willingness bonus. Wants absent
// from this table (pardon, marriage, safety) carry no affinity -- there is
// no op domain whose success would flatter them.
const WANT_DOMAIN_AFFINITY: Record<string, 'econ' | 'martial' | 'social'> = {
  coin: 'econ',
  holding: 'econ',
  office: 'social',
  recognition: 'social',
  revenge: 'martial',
};

// The willingness-drags op.delayed offset (spec §3.5: "untilTick: tick+2").
// Kept separate from RIDERS.slothfulDelay.delayTicks below even though both
// happen to be 2 today -- the two riders are independently specified and
// coincide in value, not by a shared concept that must move together.
const WILLINGNESS_DRAG_DELAY_TICKS = 2;

/** Scales an fx amount by multiplying against a normalized fractional fx
 *  literal (e.g. '0.6' means three-fifths) via mulFx -- no runtime division
 *  is involved anywhere in this scaling. */
const BAND_AMOUNT_SCALE: Record<Band, string> = { botched: '0', poor: '0.6', sound: '1', outstanding: '1.3' };
const SKIM_SCALE = '0.15';

const APT_KEY_FOR_DOMAIN: Record<'econ' | 'martial' | 'social', AptKey> = {
  econ: 'apt:econ',
  martial: 'apt:martial',
  social: 'apt:social',
};

// Every trait rider mediated execution can apply (spec §3), in one table
// instead of scattered through applyMediatedOp's control flow -- so Task
// 13's kit doc can cite this one place instead of re-deriving the list.
const RIDERS = {
  // A meticulous econ executor's ledgers never botch outright: a raw
  // botched draw is floored to poor BEFORE the botched branch below ever
  // sees it -- applied to the band itself, not a post-hoc graph patch.
  meticulousFloor: { trait: 'meticulous', domain: 'econ', from: 'botched', to: 'poor' },
  // A greedy econ executor skims a cut of the op's ORIGINAL (unscaled)
  // amount to their own wealth on any band below sound -- including
  // botched, where the crown gets nothing but the steward still helps
  // themselves.
  greedySkim: { trait: 'greedy', domain: 'econ', belowBand: 'sound', pct: SKIM_SCALE },
  // A slothful executor's poor-band work is chronicled as late -- purely
  // informational this wave (no queue, no deferred re-landing): the op has
  // already applied above at its poor-band scale.
  slothfulDelay: { trait: 'slothful', band: 'poor', delayTicks: 2 },
} as const;

function executorOf(g: WorldGraph, officeId: string): string | null {
  const seats = edgesTo(g, officeId).filter((e) => e.type === 'appointment');
  return seats.length > 0 ? seats[0]!.src : null;
}

/** The op's own target character, if it names one (grant/imprison/pardon/
 *  send_envoy/seize all carry `charId`; ops that target a place or office
 *  do not) -- read structurally so this stays correct as ops are added. */
function targetCharId(op: Op): string | null {
  return 'charId' in op ? op.charId : null;
}

/** loyalty edge bp from `src` to `dst`, defaulting to 5000 (neutral) when
 *  no edge exists -- the same idiom src/report.ts and src/ops.ts use. */
function loyaltyBp(g: WorldGraph, src: string, dst: string): number {
  const e = findEdge(g, 'loyalty', src, dst);
  return typeof e?.props['bp'] === 'number' ? (e.props['bp'] as number) : 5000;
}

// Task 4 (spec §3.5): willingness -- fortune-free by design. Whether the
// executor TRIES is character (this function: deterministic, no Fortune
// parameter at all); how it LANDS is the world (drawBand, called only when
// this doesn't refuse). Scoring, exactly per the brief:
//   score = loyalty bp executor->ruler (default 5000)
//     +500 if the op's domain matches the executor's current want's domain
//       affinity
//     -2000 if the op is imprison/seize targeting a character the executor
//       holds a loyalty OR kinship edge toward ("asked to strike their own")
//   vengeful executor + any grudge edge executor->target: refuses outright,
//     regardless of score -- checked before the threshold below even looks
//     at it.
//   thresholds on the (possibly adjusted) score: >=5500 complies; >=4000
//     drags; else refuses.
//   craven executor + martial domain: the threshold verdict is then capped
//     at 'drags' -- a craven never fully complies with a violent order, so
//     this can only ever pull 'complies' down (a 'refuses' stays put).
// Returns the reason a refusal fired alongside the verdict -- exactly the
// two closed strings op.refused may report -- so applyMediatedOp never has
// to re-derive which rule tripped.
function willingnessVerdict(
  g: WorldGraph,
  executorId: string,
  op: Op,
  rulerCharId: string,
): { verdict: Willingness; reason: RefusalReason | null } {
  const domain = OP_KINDS[op.kind].domain;
  const target = targetCharId(op);

  let score = loyaltyBp(g, executorId, rulerCharId);

  const want = currentWant(g, executorId);
  if (want !== null && WANT_DOMAIN_AFFINITY[want] === domain) score += 500;

  if (
    (op.kind === 'imprison' || op.kind === 'seize') &&
    target !== null &&
    (findEdge(g, 'loyalty', executorId, target) !== undefined || findEdge(g, 'kinship', executorId, target) !== undefined)
  ) {
    score -= 2000;
  }

  if (target !== null && hasTrait(g, executorId, 'vengeful') && findEdge(g, 'grudge', executorId, target) !== undefined) {
    return { verdict: 'refuses', reason: 'grudge' };
  }

  let verdict: Willingness = score >= 5500 ? 'complies' : score >= 4000 ? 'drags' : 'refuses';
  if (domain === 'martial' && hasTrait(g, executorId, 'craven') && verdict === 'complies') verdict = 'drags';

  return { verdict, reason: verdict === 'refuses' ? 'disloyal' : null };
}

/** Exported for tests and later scenario suites (spec §3.5). */
export function willingnessOf(g: WorldGraph, executorId: string, op: Op, rulerCharId: string): Willingness {
  return willingnessVerdict(g, executorId, op, rulerCharId).verdict;
}

/** Scale an op's fx `amount`/`size` param by the band. Ops without an fx
 *  amount (decree_tax, audit, send_envoy) pass through unscaled — their
 *  band consequences live in riders and (audit) observation quality. */
function scaleOp(op: Op, band: Band): Op {
  const scale = BAND_AMOUNT_SCALE[band];
  if (scale === '1') return op;
  if ('amount' in op) return { ...op, amount: fxToString(mulFx(fx(op.amount), fx(scale))) };
  if ('size' in op) return { ...op, size: fxToString(mulFx(fx(op.size), fx(scale))) };
  return op;
}

/** The op's own fx amount/size, unscaled -- riders that care about the
 *  "real" stakes (the greedy skim) read this, never the band-scaled value
 *  scaleOp hands to applyOp. */
function opAmountFx(op: Op): Fx | null {
  if ('amount' in op) return fx(op.amount);
  if ('size' in op) return fx(op.size);
  return null;
}

/** Wealth defaults to zero on a character who has never held any --
 *  propFx would throw on the absent prop, and an unskimmed steward is the
 *  common case, not an error. */
function wealthOf(g: WorldGraph, charId: string): Fx {
  const v = getNode(g, charId).props['wealth'];
  return typeof v === 'bigint' ? v : FX_ZERO;
}

/** Canonical, injective, stable key for the execution-stream draw: two ops
 *  with the same kind and ids draw the same band at the same (tick, seed),
 *  and no two distinct ops collide. */
function opKeyOf(op: Op): string {
  return canonJson(op);
}

// seatId: threaded straight through to applyOp unchanged, in BOTH branches
// below (crown's own voice, and the post-band execution) -- mediated ops
// execute on the throne's (or whichever seat's) BEHALF, so the fingerprint
// a landed op stamps must credit the DECIDING seat, never `executorId` (the
// office holder who mechanically did the work, scored by willingness/band
// above). See src/ops.ts's applyOp for the stamp itself.
// flashpoints (claim §3, task-3 controller-pinned seam): forwarded straight
// through to BOTH applyOp call sites below, unchanged, the same way seatId
// already is -- this function has no use for the table itself (it never
// inspects flashpointId or resolves a flashpoint), only applyOp's own
// 'press_claim' case does. Optional, defaulting to {}, so every existing
// call site (this file has none of its own; the test suite's ~20) keeps
// compiling: none of them ever construct a press_claim op, and domain: null
// ops (press_claim included) return at the line just below before `fortune`
// -- already a required parameter here, unlike at applyOp -- would matter
// for anything but this same pass-through.
export function applyMediatedOp(
  g: WorldGraph,
  op: Op,
  tick: number,
  fortune: Fortune,
  em: Emitter,
  cfg: MediationConfig,
  seatId: string,
  parents: string[] = [],
  flashpoints: Record<string, FlashpointDef> = {},
): WorldGraph {
  const domain = OP_KINDS[op.kind].domain;
  if (domain === null) return applyOp(g, op, tick, em, seatId, parents, flashpoints, fortune); // crown's own voice, no office involved

  const officeId = cfg.officeForDomain[domain];
  const executorId = executorOf(g, officeId);
  if (executorId === null) {
    em.emit('op.rejected', { parents, data: { reason: 'no hands', opKind: op.kind, officeId, source: 'mediation' } });
    return g;
  }

  // Task 4 (spec §3.5): willingness runs only when this tier configures it
  // (tier 1 stays gate+band only -- this branch then never touches
  // inst:crown or the scorer, leaving that config byte-identical to before
  // Task 4 existed). When it does run, it resolves right here: AFTER the
  // gate above finds a live executor, and strictly BEFORE the band draw
  // below -- so a refusal never touches the execution stream at all (D21
  // stream discipline: nothing downstream of a refusal may call `fortune`).
  let willingness: Willingness = 'complies';
  if (cfg.willingness) {
    const rulerCharId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
    const verdict = willingnessVerdict(g, executorId, op, rulerCharId);
    willingness = verdict.verdict;
    if (willingness === 'refuses') {
      em.emit('op.refused', { parents, data: { opKind: op.kind, executorId, reason: verdict.reason } });
      return g; // no band draw, no op.executed, graph unchanged
    }
  }

  let band = drawBand(aptOf(g, executorId, APT_KEY_FOR_DOMAIN[domain]), fortune, tick, opKeyOf(op));
  const { meticulousFloor, greedySkim, slothfulDelay } = RIDERS;
  if (band === meticulousFloor.from && domain === meticulousFloor.domain && hasTrait(g, executorId, meticulousFloor.trait)) {
    band = meticulousFloor.to;
  }
  // Task 4: a 'drags' verdict caps the outcome at 'poor' -- a reluctant
  // executor's best case is mediocre. This only pulls DOWN (sound/
  // outstanding -> poor); a 'botched' draw is already worse than the cap
  // and stays botched -- dragging your feet doesn't rescue a disaster.
  if (willingness === 'drags' && BANDS.indexOf(band) > BANDS.indexOf('poor')) {
    band = 'poor';
  }

  // op.executed never carries the mutation deltas itself (deltas: [], the
  // emitter default) -- those live on the underlying op's own event below,
  // exactly as a plain tier-0 applyOp would emit them. op.executed is
  // purely the banding wrapper; nextId() is read immediately before its
  // matching emit() (events.ts's contract) so the underlying op and the
  // riders below can cite it as their cause.
  const executedEventId = em.nextId();
  em.emit('op.executed', { parents, data: { opKind: op.kind, executorId, officeId, domain, band } });

  // Scaling may never exceed what validateOp already approved for the
  // unscaled op (src/ops.ts:224-276): re-validate the band-scaled op against
  // the same sufficiency/floor checks before applying it. The outstanding
  // bonus materializes only when slack exists; if scaling breaks a check the
  // unscaled amount already cleared -- an outstanding draw outrunning
  // treasury/granary/wealth, or a poor draw undercutting a floor like
  // hold_festival's minimum -- fall back to the ORIGINAL unscaled op, which
  // the caller already validated. Either way op.executed (emitted above)
  // keeps the drawn band: the fallback only caps the material effect, never
  // the demonstrated skill on record.
  let g2 = g;
  if (band !== 'botched') {
    const scaled = scaleOp(op, band);
    const scaledCheck = validateOp(g2, scaled);
    g2 = applyOp(g2, scaledCheck.ok ? scaled : op, tick, em, seatId, [executedEventId], flashpoints, fortune);
  }

  if (domain === greedySkim.domain && BANDS.indexOf(band) < BANDS.indexOf(greedySkim.belowBand) && hasTrait(g2, executorId, greedySkim.trait)) {
    const original = opAmountFx(op);
    if (original !== null) {
      const skim = mulFx(original, fx(greedySkim.pct));
      const deltas: GraphDelta[] = [{ op: 'node.set', id: executorId, key: 'wealth', value: wealthOf(g2, executorId) + skim }];
      g2 = applyDeltas(g2, deltas);
      em.emit('op.skimmed', { parents: [executedEventId], deltas, data: { executorId, amount: fxToString(skim) } });
    }
  }

  // op.delayed can be triggered by two independent causes -- a naturally
  // poor draw from a slothful executor (the existing rider, unchanged from
  // before Task 4), or an unwilling executor dragging their feet (Task 4)
  // -- and both can hold at once (a slothful executor who also resents this
  // order). D14 chronicle hygiene wants at most one op.delayed per op: the
  // slothful rider is checked first and wins the collision; the
  // willingness-drags emission below only fires when the rider didn't
  // already cover it. Both carry the same untilTick (tick+2 either way), so
  // which one "wins" is not externally observable in the event's data --
  // only in which rider gets causal credit for it.
  let delayed = false;
  if (band === slothfulDelay.band && hasTrait(g2, executorId, slothfulDelay.trait)) {
    em.emit('op.delayed', { parents: [executedEventId], data: { opKind: op.kind, untilTick: tick + slothfulDelay.delayTicks } });
    delayed = true;
  }
  if (!delayed && willingness === 'drags') {
    em.emit('op.delayed', { parents: [executedEventId], data: { opKind: op.kind, untilTick: tick + WILLINGNESS_DRAG_DELAY_TICKS } });
  }

  return g2;
}
