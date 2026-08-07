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
import { edgesTo, findEdge, getNode, propStr } from './graph.js';
import type { Seat } from './report.js';
import { aptOf, APT_KEYS, BANDS, type AptKey, type Band } from './spine.js';
import { bandWeights } from './bands.js';

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
// Rules 4-6 (the judge-quality-gated core, independent of any
// reporter/executor RELATIONSHIP) live in judgeFidelityBand below, shared
// verbatim with vet's own read (Task 9, spec §9) -- see that function's
// header for why 1-3 don't also apply there.
function claimedBandFor(
  g: WorldGraph,
  reporterId: string,
  reporterSeatId: string,
  executorId: string,
  trueBand: Band,
  tick: number,
  fortune: Fortune,
  eventId: string,
): Band {
  if (reporterId === executorId) return stepBand(trueBand, 1); // rule 1

  if (isKinOrLoyal(g, reporterId, executorId) && BANDS.indexOf(trueBand) < BANDS.indexOf('sound')) return 'sound'; // rule 2

  if (grudgeBpOf(g, reporterId, executorId) >= GRUDGE_THRESHOLD && trueBand === 'outstanding') return 'sound'; // rule 3

  // Draw key = event id + reporter seat id, space-joined -- the same idiom
  // replay.ts's divergence() uses to compose a Set/Map key from plain id
  // strings (`${e.id} ${e.type} ${canonJson(e.data)}`). The event id ALONE
  // would make every reporter in the same judge band draw IDENTICALLY off a
  // single op.executed event: same error/no-error verdict, same direction,
  // for every seat watching it -- one coin flip impersonating N independent
  // witnesses. Folding in the seat id makes each reporter's fallibility its
  // own draw. The join is injective because both id grammars exclude spaces
  // (events: t{tick}.{seq}; seats: seat:{name}), so no distinct (event,
  // seat) pair can collide.
  return judgeFidelityBand(g, reporterId, trueBand, tick, fortune, `${eventId} ${reporterSeatId}`); // rules 4-6
}

/** Rules 4-6 (spec §4): the judge-quality-gated core of observation
 *  fidelity, extracted so vet (Task 9, ops.ts's applyOp arm has no Fortune
 *  of its own -- the draw happens from tick.ts's step 4.5, where Fortune
 *  already lives) can reuse EXACTLY this machinery for its own read of a
 *  vetted character's aptitude, without also inheriting rules 1-3's
 *  reporter/executor RELATIONSHIP tests (self-report inflation, kin
 *  inflation, grudge deflation): those describe a REPORT's bias toward its
 *  own subject, not a vetting judge's read of someone they hold no
 *  reporting relationship to. `judgeId` is whoever's apt:judge governs this
 *  read (a reporting seat's body for claimedBandFor above; the resolved
 *  vetting authority for vetObservation below). `drawKey` is caller-built
 *  (see each call site for its own injectivity argument) rather than
 *  assembled here, since the two callers compose it from different
 *  identities. */
export function judgeFidelityBand(
  g: WorldGraph,
  judgeId: string,
  trueBand: Band,
  tick: number,
  fortune: Fortune,
  drawKey: string,
): Band {
  const judge = aptOf(g, judgeId, 'apt:judge');
  if (judge >= JUDGE_TRUTH_THRESHOLD) return trueBand; // rule 4

  const errorRate = judge >= JUDGE_ERROR_THRESHOLD ? MID_JUDGE_ERROR_RATE : LOW_JUDGE_ERROR_RATE; // rule 5 vs 6
  const roll = fortune.int('observation', tick, drawKey, 0, 999);
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
      const claimedBand = claimedBandFor(g, reporterId, reporterSeat.id, data.executorId, data.band, tick, fortune, ev.id);
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

// Op `vet` (Task 9, spec §9): the crown's own act of intelligence-gathering
// on a character, distinct from the reporter-mediated observations above --
// it always produces exactly one true-ish read, gated on the VETTING
// authority's own apt:judge (rules 4-6 only, via judgeFidelityBand above),
// never the target's kinship/loyalty/grudge toward THEM (rules 1-3 don't
// apply -- vetting isn't a report the target could bias). Wired from
// tick.ts's step 4.5, which owns Fortune; ops.ts's applyOp arm (no Fortune
// parameter, like every other op) only builds the op.vet event this reads
// off of.

/** The crown's spymaster if office:spymaster is staffed, else the ruler --
 *  vet's own vetting authority (spec §9). A local "who holds this office"
 *  lookup, the same idiom mediate.ts's (private) executorOf makes for
 *  mediated execution -- re-derived here per this module's existing
 *  loyaltyBpOf/grudgeBpOf precedent (local repetition over a shared
 *  helper) rather than importing across modules for a two-line lookup. */
function vettingAuthorityOf(g: WorldGraph): string {
  const holder = edgesTo(g, 'office:spymaster').find((e) => e.type === 'appointment');
  if (holder) return holder.src;
  return propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
}

/** The band a `sound` execution at aptitude `apt` would most likely produce
 *  -- the highest-weighted row of bandWeights(apt) (spec §9: vet's
 *  claimedBand baseline before fidelity is applied). Ties break toward the
 *  HIGHER band (ascending BANDS index): unreachable under today's four
 *  fixed weight rows (no row in bands.ts's table ties), but implemented
 *  per spec rather than left to iteration order, since bandWeights isn't
 *  this function's to assume stable forever. */
function modalBand(apt: number): Band {
  const w = bandWeights(apt);
  let best = 0;
  for (let i = 1; i < w.length; i++) {
    if (w[i]! >= w[best]!) best = i; // >= : a tie moves to the higher (later) band
  }
  return BANDS[best]!;
}

/** The character's highest apt:* value; ties break by APT_KEYS' own
 *  declared order (econ, martial, social, judge) -- only a STRICTLY
 *  greater value displaces the running best, so the first (lowest-index)
 *  key at the max value wins. */
function highestAptOf(g: WorldGraph, charId: string): AptKey {
  let best: AptKey = APT_KEYS[0];
  let bestVal = aptOf(g, charId, best);
  for (let i = 1; i < APT_KEYS.length; i++) {
    const key = APT_KEYS[i]!;
    const v = aptOf(g, charId, key);
    if (v > bestVal) {
      best = key;
      bestVal = v;
    }
  }
  return best;
}

/** vet's distinctive effect (spec §9): a true-ish read of the TARGET's own
 *  highest aptitude -- the modal band a sound execution there would most
 *  likely produce, passed through the vetting authority's fidelity (rules
 *  4-6 only, via judgeFidelityBand). `eventId` is the vet op's own landed
 *  event id: it doubles as the returned Observation's taskRef and as half
 *  the fortune draw key, joined with `vet:` + the vetting character's id
 *  (mirroring claimedBandFor's own event-id-plus-identity idiom above).
 *  The join is injective for the same reason claimedBandFor's is: node ids
 *  never contain spaces anywhere in this codebase's grammar (colon-
 *  namespaced, e.g. `char:x`), and event ids don't either (`t{tick}.
 *  {seq}`), so no distinct (event, vetting-authority) pair can collide --
 *  and `vet:` as a literal prefix can never be mistaken for a bare node id
 *  since no node id in this engine's grammar contains a colon-separated
 *  `vet` segment on its own. Exported for tick.ts's step 4.5 (which owns
 *  Fortune) and for direct unit tests of the modal-band/fidelity
 *  computation. */
export function vetObservation(
  g: WorldGraph,
  targetCharId: string,
  tick: number,
  fortune: Fortune,
  eventId: string,
): Observation {
  const aptKey = highestAptOf(g, targetCharId);
  const trueBand = modalBand(aptOf(g, targetCharId, aptKey));
  const domain = aptKey.slice(4); // strip the 'apt:' prefix -- APT_KEYS' own grammar
  const vettingJudgeId = vettingAuthorityOf(g);
  const claimedBand = judgeFidelityBand(g, vettingJudgeId, trueBand, tick, fortune, `${eventId} vet:${vettingJudgeId}`);
  return { executorId: targetCharId, domain, claimedBand, taskRef: eventId };
}
