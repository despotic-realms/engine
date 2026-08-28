// §4.2: the ledger as reported, never ground truth. A report is a
// deterministic biased projection of the world graph, distorted as a
// function of the reporting seat's own interest edges — asymmetry is a graph
// operation, not model improvisation. Verification (the audit op) is how the
// throne buys truth.
import type { Fx } from './fx.js';
import { fx, fxToString, mulFx } from './fx.js';
import type { Fortune } from './fortune.js';
import type { NodeId, WorldGraph } from './graph.js';
import { edgesOfType, findEdge, getNode, nodeIds, propFx, propInt, propStr } from './graph.js';
// Claim §5 (2026-08-20 claim plan, Global Constraints): declaredBackingBp
// (ladder.ts) is the SAME sum the claim tier gate itself checks
// (checkLadder's claimGateMet) -- imported rather than re-derived here so
// the projection's `gate.backingHave` and the real gating logic can never
// silently drift apart. One-directional (ladder.ts never imports from this
// file), so no cycle.
import { declaredBackingBp } from './ladder.js';
// Controller-pinned seam (task-5 brief, point 2): 'weighing' reuses the
// waverer band ops.ts's own isWaverer computes for momentum -- but
// isWaverer itself is a private, unexported function in ops.ts, and
// ops.ts is not in this task's file list to change. Reads its EXPORTED
// pieces instead (WAVERER_FLOOR/DECLARE_LOYALTY/effectiveLoyalty, all
// living in loyalty.ts since T4's review fix) and recomputes the same
// band membership locally (isWaveringBacker, below) -- byte-identical
// logic to ops.ts's isWaverer minus the claimCircle/claimBp/backing-edge
// checks, which THIS file's own caller (claimBackers) already performs
// before ever calling it.
import { DECLARE_LOYALTY, effectiveLoyalty, WAVERER_FLOOR } from './loyalty.js';
import type { Observation } from './observe.js';
import { currentWant } from './spine.js';

export interface Seat {
  id: string;
  kind: 'throne' | 'office';
  bodyCharId: string;
  officeId?: string;
  attentionSlots: number;
  fidelity: 'stub' | 'npc' | 'external';
}

export type UnrestBucket = 'calm' | 'uneasy' | 'restive' | 'boiling';

export interface ReportedLedger {
  seatId: string;
  tick: number;
  treasury: string;
  granary: string;
  unrest: UnrestBucket;
  notes: string[];
  observations: Observation[];
}

const BUCKETS: UnrestBucket[] = ['calm', 'uneasy', 'restive', 'boiling'];

function bucketOf(unrest: Fx): number {
  if (unrest < fx('25')) return 0;
  if (unrest < fx('50')) return 1;
  if (unrest < fx('75')) return 2;
  return 3;
}

export function compileReport(
  g: WorldGraph,
  fortune: Fortune,
  tick: number,
  placeId: NodeId,
  reporter: Seat,
  observations: Observation[] = [],
): ReportedLedger {
  const crown = getNode(g, 'inst:crown');
  const place = getNode(g, placeId);
  const rulerId = propStr(crown.props, 'rulerCharId');
  const notes: string[] = [];

  // Treasury: an unexposed skimmer adds back what they stole.
  let treasury = propFx(crown.props, 'treasury');
  const interest = findEdge(g, 'interest', reporter.bodyCharId, 'inst:crown');
  if (interest && interest.props['exposed'] === false) {
    treasury = treasury + propFx(interest.props, 'skimmed');
  }

  // Granary: honest error — seeded noise in ±3%.
  const noiseBp = fortune.int('report.granary', tick, reporter.id, -300, 300);
  const granary = mulFx(propFx(place.props, 'granary'), BigInt(10_000 + noiseBp));
  if (noiseBp !== 0) notes.push('the granary count is an estimate');

  // Unrest: a disloyal reporter softens the news by one bucket.
  let bucket = bucketOf(propFx(place.props, 'unrest'));
  const loyalty = findEdge(g, 'loyalty', reporter.bodyCharId, rulerId);
  const loyaltyBp = typeof loyalty?.props['bp'] === 'number' ? (loyalty.props['bp'] as number) : 5000;
  if (loyaltyBp < 3000 && bucket > 0) bucket = bucket - 1;

  return {
    seatId: reporter.id,
    tick,
    treasury: fxToString(treasury),
    granary: fxToString(granary),
    unrest: BUCKETS[bucket]!,
    notes,
    observations,
  };
}

// Claim §5 (2026-08-20 claim plan, Global Constraints -- verbatim-binding
// shape): claimReport is the player's ENTIRE view of the campaign -- DATA
// only, prose is content's (spec §5: "people-and-obligations language").
// The fog rule is absolute (controller-pinned seam, task-5 brief): no
// true-loyalty bp, no false-stone status, no trueScale anywhere in this
// projection -- only what the plan's own shape names. `state` bands are
// computed off EFFECTIVE loyalty (which the player cannot see) but only the
// BAND crosses into the projection, never the number -- the spec's own
// panel example ("Mair is weighing it") is the disclosure level this
// mirrors exactly.
export type ClaimBackerState = 'declared' | 'weighing' | 'silent';

export interface ClaimPrice {
  wantKey: string;
  pledged: boolean;
}

export interface ClaimBacker {
  charId: string;
  state: ClaimBackerState;
  bp: number;
  price: ClaimPrice | null;
}

// Obligations (controller-pinned seam, task-5 brief, point 3): tribute is
// the PRE-EXISTING liege debt edge (thornfield.ts: inst:crown -> a
// character, props { duePerYear } only -- no `settled`, unlike a real
// borrow); debt is an unsettled borrow edge (principal/fee/dueTick); promise
// is an unbroken promise edge (wantKey/madeAt). All three read `dstId` off
// the edge's own `dst` -- every one of these edge types is src: inst:crown,
// so `dst` is uniformly "who this is owed to" across all three kinds.
export interface ClaimObligationTribute {
  kind: 'tribute';
  dstId: string;
  detail: { duePerYear: string };
}
export interface ClaimObligationDebt {
  kind: 'debt';
  dstId: string;
  detail: { principal: string; fee: string; dueTick: number };
}
export interface ClaimObligationPromise {
  kind: 'promise';
  dstId: string;
  detail: { wantKey: string; madeAt: number };
}
export type ClaimObligation = ClaimObligationTribute | ClaimObligationDebt | ClaimObligationPromise;

export interface ClaimGate {
  backingBp: number;
  backingHave: number;
  treasuryNeed: string;
  treasuryHave: string;
}

export interface ClaimReport {
  backers: ClaimBacker[];
  obligations: ClaimObligation[];
  gate: ClaimGate;
}

// Byte-identical band logic to ops.ts's own private isWaverer, minus the
// claimCircle/claimBp/backing-edge checks claimBackers (below) already
// performs at its own call site before ever reaching here -- see this
// file's import comment for why this isn't just imported instead.
function isWaveringBacker(g: WorldGraph, charId: string, rulerId: string): boolean {
  if (getNode(g, charId).props['imprisoned'] === true) return false;
  const loyaltyEdge = findEdge(g, 'loyalty', charId, rulerId);
  if (!loyaltyEdge) return false;
  const trueLoyalty = typeof loyaltyEdge.props['bp'] === 'number' ? (loyaltyEdge.props['bp'] as number) : 5000;
  const eff = effectiveLoyalty(g, charId, trueLoyalty);
  return eff >= WAVERER_FLOOR && eff < DECLARE_LOYALTY;
}

/** `backers`: every claim-circle character (node props claimCircle === true
 *  AND claimBp: number -- the same AND-definition declarationStep and
 *  isWaverer both use), sorted by charId (nodeIds(g) is already sorted --
 *  D14 order-stable iteration). `bp` is always read off the character's OWN
 *  claimBp prop, for every state alike: a static, content-authored,
 *  already-public fact (a lord weighs more than a hunter) -- not the
 *  backing edge's own `bp` copy, though the two are identical by
 *  construction once declared (declarationStep stamps the edge's bp
 *  straight off this same node prop). `price` is the character's CURRENT
 *  want (public by existing convention) plus whether an unbroken promise
 *  names it -- null when sated (no current want). */
function claimBackers(g: WorldGraph): ClaimBacker[] {
  const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
  const backers: ClaimBacker[] = [];
  for (const charId of nodeIds(g)) {
    const node = getNode(g, charId);
    if (node.type !== 'character') continue;
    if (node.props['claimCircle'] !== true) continue;
    if (typeof node.props['claimBp'] !== 'number') continue;
    const bp = node.props['claimBp'];

    const declared = findEdge(g, 'backing', charId, 'inst:crown') !== undefined;
    const state: ClaimBackerState = declared ? 'declared' : isWaveringBacker(g, charId, rulerId) ? 'weighing' : 'silent';

    const want = currentWant(g, charId);
    let price: ClaimPrice | null = null;
    if (want !== null) {
      const promiseEdge = findEdge(g, 'promise', 'inst:crown', charId);
      const pledged = promiseEdge !== undefined && promiseEdge.props['broken'] !== true && promiseEdge.props['wantKey'] === want;
      price = { wantKey: want, pledged };
    }

    backers.push({ charId, state, bp, price });
  }
  return backers;
}

/** `obligations`: sorted stable by (kind, dstId) -- lexicographic on both,
 *  per the Global Constraints. `debt`-typed edges are keyed on SHAPE, never
 *  src/dst (debtOverdueStep's own precedent, systems.ts): a liege tribute
 *  edge carries `duePerYear` and nothing else, a real borrow carries
 *  `settled` (and is only listed here while unsettled -- a repaid debt's
 *  edge no longer exists at all, repay removes it outright). */
function claimObligations(g: WorldGraph): ClaimObligation[] {
  const obligations: ClaimObligation[] = [];
  for (const e of edgesOfType(g, 'debt')) {
    if (typeof e.props['duePerYear'] === 'bigint') {
      obligations.push({ kind: 'tribute', dstId: e.dst, detail: { duePerYear: fxToString(e.props['duePerYear']) } });
    } else if (e.props['settled'] === false) {
      obligations.push({
        kind: 'debt',
        dstId: e.dst,
        detail: { principal: fxToString(propFx(e.props, 'principal')), fee: fxToString(propFx(e.props, 'fee')), dueTick: propInt(e.props, 'dueTick') },
      });
    }
  }
  for (const e of edgesOfType(g, 'promise')) {
    if (e.props['broken'] === true) continue;
    obligations.push({ kind: 'promise', dstId: e.dst, detail: { wantKey: propStr(e.props, 'wantKey'), madeAt: propInt(e.props, 'madeAt') } });
  }
  obligations.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.dstId < b.dstId ? -1 : a.dstId > b.dstId ? 1 : 0;
  });
  return obligations;
}

/** `gate`: `backingHave`/`treasuryHave` read live off the graph;
 *  `backingBp`/`treasuryNeed` echo the caller-supplied thresholds verbatim
 *  -- the SAME shape as TierRule.claimRequire (ladder.ts), passed in by
 *  the caller rather than looked up here, since claimReport takes only a
 *  graph and has no season/tier context of its own to find "the" active
 *  claim-gated rule from. Fx fields render as strings (fxToString), the
 *  same convention ReportedLedger's own treasury/granary fields already
 *  use -- this projection crosses the same host/SDK boundary a bigint
 *  can't cross natively. */
function claimGateProjection(g: WorldGraph, gate: { backingBp: number; treasury: Fx }): ClaimGate {
  const treasuryHave = propFx(getNode(g, 'inst:crown').props, 'treasury');
  return {
    backingBp: gate.backingBp,
    backingHave: declaredBackingBp(g),
    treasuryNeed: fxToString(gate.treasury),
    treasuryHave: fxToString(treasuryHave),
  };
}

/** The claim projection (2026-08-20 claim plan, Global Constraints;
 *  controller-pinned seam, task-5 brief): the player's complete knowledge
 *  of the campaign, and nothing more. `gate` names the SAME claimRequire
 *  threshold (ladder.ts's TierRule.claimRequire) the caller's own
 *  claim-gated tier rule enforces -- callers pass `rule.claimRequire`
 *  straight through; the two shapes are structurally identical by
 *  construction. */
export function claimReport(g: WorldGraph, gate: { backingBp: number; treasury: Fx }): ClaimReport {
  return {
    backers: claimBackers(g),
    obligations: claimObligations(g),
    gate: claimGateProjection(g, gate),
  };
}
