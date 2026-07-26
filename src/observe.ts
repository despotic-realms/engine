// spec §4: execution events reach the throne only as OBSERVATIONS, and the
// observer bends them. What a report CLAIMS about an executed op diverges
// from what HAPPENED -- deterministically, by the reporting seat's own
// judgment and interests, exactly as compileReport's ledger is a biased
// projection rather than ground truth (report.ts). Six claimedBand
// precedence rules (first match wins) turn a true band into a claimed one;
// a seventh, independent check decides whether a skim is visible to this
// reporter at all. observeExecutions is pure selection over the graph and
// this tick's chronicle events -- like examiner.select (scheduler.ts), it
// mutates and emits nothing; resolveTick is the one that turns its output
// into observation.received events.
import type { ChronicleEvent } from './events.js';
import type { Fortune } from './fortune.js';
import type { WorldGraph } from './graph.js';
import { findEdge } from './graph.js';
import type { Seat } from './report.js';
import { aptOf, BANDS, type Band } from './spine.js';

export interface Observation {
  executorId: string;
  domain: string;
  claimedBand: Band;
  taskRef: string;
}

const LAST_BAND = BANDS.length - 1; // index of 'outstanding'

function clampBandIndex(i: number): number {
  return i < 0 ? 0 : i > LAST_BAND ? LAST_BAND : i;
}

/** Move a band `delta` steps along the botched<poor<sound<outstanding
 *  ladder, clamped at either end -- the shared mechanic behind rule 1's
 *  inflation and rules 5/6's one-step error. */
function stepBand(b: Band, delta: number): Band {
  return BANDS[clampBandIndex(BANDS.indexOf(b) + delta)]!;
}

/** loyalty edge bp `src` -> `dst`, defaulting to 5000 (neutral) when absent
 *  -- the same idiom report.ts and mediate.ts use. */
function loyaltyBpOf(g: WorldGraph, src: string, dst: string): number {
  const e = findEdge(g, 'loyalty', src, dst);
  return typeof e?.props['bp'] === 'number' ? (e.props['bp'] as number) : 5000;
}

/** grudge edge bp `src` -> `dst`, defaulting to 0 (none) when absent -- the
 *  same idiom ops.ts uses. */
function grudgeBpOf(g: WorldGraph, src: string, dst: string): number {
  const e = findEdge(g, 'grudge', src, dst);
  return typeof e?.props['bp'] === 'number' ? (e.props['bp'] as number) : 0;
}

const KIN_LOYALTY_THRESHOLD = 7000;
const GRUDGE_THRESHOLD = 6000;
const JUDGE_TRUTH_THRESHOLD = 6000;
const JUDGE_ERROR_THRESHOLD = 4000;
const MID_JUDGE_ERROR_RATE = 250; // per mille (rule 5)
const LOW_JUDGE_ERROR_RATE = 500; // per mille (rule 6)

/** Rule 2's relationship test (kinship OR loyalty >= 7000, reporter ->
 *  executor), shared verbatim by skim visibility below -- both name it as
 *  the same "close enough to protect" line. */
function isKinOrLoyal(g: WorldGraph, reporterId: string, executorId: string): boolean {
  return findEdge(g, 'kinship', reporterId, executorId) !== undefined || loyaltyBpOf(g, reporterId, executorId) >= KIN_LOYALTY_THRESHOLD;
}

// The six claimedBand precedence rules (spec §4, first match wins):
//   1. reporter === executor                                     -> band + 1 step (cap outstanding)  [self-report inflation]
//   2. kinship OR loyalty>=7000 reporter->executor, band < sound  -> 'sound'                          [kin inflation]
//   3. grudge>=6000 reporter->executor, band === 'outstanding'    -> 'sound'                          [spite deflation]
//   4. apt:judge >= 6000                                          -> true band
//   5. apt:judge >= 4000                                          -> 25% one-step error (roll parity)
//   6. else                                                       -> 50% one-step error (roll parity)
// Rules 1-4 are fully deterministic and never touch `fortune`; rules 5/6
// draw exactly once each -- the SAME roll decides both whether an error
// occurs and, when it does, which direction (even -> down, odd -> up).
// `eventId` is the observed op.executed event's own id, the fortune key
// the brief specifies for rules 5/6.
function claimedBandFor(
  g: WorldGraph,
  reporterId: string,
  executorId: string,
  trueBand: Band,
  tick: number,
  fortune: Fortune,
  eventId: string,
): Band {
  if (reporterId === executorId) return stepBand(trueBand, 1); // rule 1

  if (isKinOrLoyal(g, reporterId, executorId) && BANDS.indexOf(trueBand) < BANDS.indexOf('sound')) return 'sound'; // rule 2

  if (grudgeBpOf(g, reporterId, executorId) >= GRUDGE_THRESHOLD && trueBand === 'outstanding') return 'sound'; // rule 3

  const judge = aptOf(g, reporterId, 'apt:judge');
  if (judge >= JUDGE_TRUTH_THRESHOLD) return trueBand; // rule 4

  const errorRate = judge >= JUDGE_ERROR_THRESHOLD ? MID_JUDGE_ERROR_RATE : LOW_JUDGE_ERROR_RATE; // rule 5 vs 6
  const roll = fortune.int('observation', tick, eventId, 0, 999);
  if (roll >= errorRate) return trueBand;
  return stepBand(trueBand, roll % 2 === 0 ? -1 : 1);
}

/** Skim visibility (spec §4 step 2): independent of claimedBand above -- a
 *  skim reaches a reporter's observations only through an eye both sharp
 *  (apt:judge >= 6000) AND disinterested (no rule-2 relationship). Kin or
 *  loyal-enough reporters never surface it no matter how sharp; a low
 *  judge never catches it either way. "Truth costs." */
function skimVisibleTo(g: WorldGraph, reporterId: string, executorId: string): boolean {
  return aptOf(g, reporterId, 'apt:judge') >= JUDGE_TRUTH_THRESHOLD && !isKinOrLoyal(g, reporterId, executorId);
}

interface ExecutedData { executorId: string; domain: string; band: Band }
interface SkimmedData { executorId: string }

/** This tick's op.executed/op.skimmed events, filtered and biased through
 *  one reporter's own interests (spec §4). Pure selection -- like
 *  examiner.select, it reads `g`, `events`, and `fortune` and returns data;
 *  resolveTick is the one that emits observation.received from the result. */
export function observeExecutions(
  g: WorldGraph,
  events: readonly ChronicleEvent[],
  reporterSeat: Seat,
  tick: number,
  fortune: Fortune,
): Observation[] {
  const reporterId = reporterSeat.bodyCharId;
  const observations: Observation[] = [];

  for (const ev of events) {
    if (ev.type === 'op.executed') {
      const data = ev.data as unknown as ExecutedData;
      const claimedBand = claimedBandFor(g, reporterId, data.executorId, data.band, tick, fortune, ev.id);
      observations.push({ executorId: data.executorId, domain: data.domain, claimedBand, taskRef: ev.id });
    } else if (ev.type === 'op.skimmed') {
      const data = ev.data as unknown as SkimmedData;
      if (skimVisibleTo(g, reporterId, data.executorId)) {
        observations.push({ executorId: data.executorId, domain: 'econ', claimedBand: 'poor', taskRef: ev.id });
      }
    }
  }

  return observations;
}
