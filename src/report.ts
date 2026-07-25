// §4.2: the ledger as reported, never ground truth. A report is a
// deterministic biased projection of the world graph, distorted as a
// function of the reporting seat's own interest edges — asymmetry is a graph
// operation, not model improvisation. Verification (the audit op) is how the
// throne buys truth.
import type { Fx } from './fx.js';
import { fx, fxToString, mulFx } from './fx.js';
import type { Fortune } from './fortune.js';
import type { NodeId, WorldGraph } from './graph.js';
import { findEdge, getNode, propFx, propStr } from './graph.js';

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
  };
}
