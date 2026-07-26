// Mediated execution (spec §3): above tier 0 an op travels through an
// office. Gate -> (Task 4: willingness) -> band -> modulation -> riders.
// The one RNG entry is the band draw; riders are pure functions of the
// drawn band. Every mutation is a GraphDelta[] applied via applyDeltas and
// carried on the emitted event (D14).
import { applyDeltas } from './events.js';
import type { Emitter, GraphDelta } from './events.js';
import type { Fortune } from './fortune.js';
import { drawBand } from './bands.js';
import type { WorldGraph } from './graph.js';
import { edgesTo, getNode } from './graph.js';
import { fx, fxToString, mulFx, FX_ZERO } from './fx.js';
import type { Fx } from './fx.js';
import { canonJson } from './canon.js';
import { applyOp, OP_KINDS, type Op } from './ops.js';
import { hasTrait, aptOf, BANDS, type AptKey, type Band } from './spine.js';

export interface MediationConfig {
  officeForDomain: Record<'econ' | 'martial' | 'social', string>;
  willingness: boolean;
}

/** Integer percent scaling for fx amounts without division: amount * pct / 100
 *  via mulFx against a fixed-point percent literal (e.g. fx('0.6')). */
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

export function applyMediatedOp(
  g: WorldGraph,
  op: Op,
  tick: number,
  fortune: Fortune,
  em: Emitter,
  cfg: MediationConfig,
  parents: string[] = [],
): WorldGraph {
  // cfg.willingness (Task 4: a reluctant office can refuse the crown's
  // order) is intentionally unread this task -- every mediated op here is
  // gated only on "is there a live appointee", never on will.
  const domain = OP_KINDS[op.kind].domain;
  if (domain === null) return applyOp(g, op, tick, em, parents); // crown's own voice, no office involved

  const officeId = cfg.officeForDomain[domain];
  const executorId = executorOf(g, officeId);
  if (executorId === null) {
    em.emit('op.rejected', { parents, data: { reason: 'no hands', opKind: op.kind, officeId } });
    return g;
  }

  let band = drawBand(aptOf(g, executorId, APT_KEY_FOR_DOMAIN[domain]), fortune, tick, opKeyOf(op));
  const { meticulousFloor, greedySkim, slothfulDelay } = RIDERS;
  if (band === meticulousFloor.from && domain === meticulousFloor.domain && hasTrait(g, executorId, meticulousFloor.trait)) {
    band = meticulousFloor.to;
  }

  // op.executed never carries the mutation deltas itself (deltas: [], the
  // emitter default) -- those live on the underlying op's own event below,
  // exactly as a plain tier-0 applyOp would emit them. op.executed is
  // purely the banding wrapper; nextId() is read immediately before its
  // matching emit() (events.ts's contract) so the underlying op and the
  // riders below can cite it as their cause.
  const executedEventId = em.nextId();
  em.emit('op.executed', { parents, data: { opKind: op.kind, executorId, officeId, domain, band } });

  let g2 = g;
  if (band !== 'botched') {
    g2 = applyOp(g2, scaleOp(op, band), tick, em, [executedEventId]);
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

  if (band === slothfulDelay.band && hasTrait(g2, executorId, slothfulDelay.trait)) {
    em.emit('op.delayed', { parents: [executedEventId], data: { opKind: op.kind, untilTick: tick + slothfulDelay.delayTicks } });
  }

  return g2;
}
