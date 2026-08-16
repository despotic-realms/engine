// The spec's core contract (§6, D12): resolveTick(season, state, decisions,
// fortune) — pure, I/O-free, deterministic. The host wraps this in exactly
// three LLM roles (NPC voice, order compiling, post-hoc analysis); nothing
// in here calls anything. TickDecisions has NO journal field: stated
// reasoning travels SDK → host → sealed store → analyst, never through the
// world (D16). Free-text directives arrive here already compiled to ops.
import { hashValue } from './canon.js';
import type { CharacterArc } from './arcs.js';
import { advanceCharacterArcs } from './arcs.js';
import { attribute } from './attribution.js';
import type { ChronicleEvent, Emitter, GraphDelta } from './events.js';
import { applyDeltas, makeEmitter } from './events.js';
import type { Fortune } from './fortune.js';
import type { WorldGraph } from './graph.js';
import { getNode, nodeIds } from './graph.js';
import type { TierRule } from './ladder.js';
import { applyTransition, checkLadder } from './ladder.js';
import type { Binding } from './match.js';
import type { Op } from './ops.js';
import { applyOp, validateOp } from './ops.js';
import type { MediationConfig } from './mediate.js';
import { applyMediatedOp } from './mediate.js';
import type { Observation } from './observe.js';
import { observeExecutions, vetObservation } from './observe.js';
import type { ReportedLedger, Seat } from './report.js';
import { compileReport } from './report.js';
import type { Booking, ExaminerCalendar } from './scheduler.js';
import { advanceArcs, examiner } from './scheduler.js';
import type { Band, WantKey } from './spine.js';
import { WANT_FULFILL, currentWant } from './spine.js';
import type { Deck, Storylet, StoryletOption } from './storylet.js';
import { bindOps, eligibleStorylets, possibleStorylets, renderTpl } from './storylet.js';
import { economyStep, fingerprintDecayStep, socialStep } from './systems.js';

export interface TierConfig { deckIds: string[]; briefBudget: number; attentionSlots: number; mediation?: MediationConfig }

export interface SeasonConfig {
  seasonId: string;
  startTier: number;
  initialGraph: WorldGraph;
  decks: Deck[];
  tiers: Record<number, TierConfig>;
  calendar: ExaminerCalendar;
  tierRules: TierRule[];
  throne: Seat;
  reporters: Seat[];
  primaryPlaceId: string;
  /** T8 (spec §5): the poacher -- a character node id (the slice sets
   *  'char:usurper'). No rival configured means poach bids never fire;
   *  restless arming, stage advance, retention, and departure all still
   *  run regardless -- only the informational arc.poach.bid event and
   *  arc.departed's `toId` (null instead) are affected. */
  rivalId?: string;
}

/** Deterministic content hash of the season's world-side bundle (host adds model pins per D15). */
export function seasonHash(season: SeasonConfig): string {
  return hashValue(season as unknown as Record<string, unknown>);
}

export interface PendingBrief {
  briefId: string;
  storyletId: string;
  binding: Binding;
  defaultOptionId: string;
  presentedEventId: string;
}

export interface ReignState {
  tick: number;
  tier: number;
  graph: WorldGraph;
  cooldowns: Record<string, number>;
  firedOnce: Record<string, true>;
  presented: Record<string, number>;   // instanceKey -> times presented as a brief (D13 novelty casting)
  pending: PendingBrief[];
  arcs: Record<string, CharacterArc>;  // T8 (spec §5): key = `${kind}:${charId}` -- restless/scheme arc bookkeeping (stage, sinceTick)
  /** Causality §1 (whole-wave final-review fix): sorted instance keys of
   *  THIS state's tick's PATTERN-POSSIBILITY BRIEF set (letters excluded)
   *  -- storylet.ts's possibleStorylets(), NOT eligibleStorylets': every
   *  brief instance whose pattern binds against the graph this tick,
   *  UNFILTERED by cooldowns or firedOnce. Deliberately NOT "what
   *  examiner.select's pool sees" (that pool is the cooldown/firedOnce-
   *  filtered DEALT set, a strict subset) -- a brief instance mid-cooldown
   *  still counts as possible here, so its cooldown expiring later never
   *  reads as "newly eligible" (its pattern never stopped binding, it was
   *  simply undealable for a tick or two). Threads through resolveTick
   *  like arcs/presented/cooldowns: each call reads it as the prior
   *  snapshot to diff against the freshly computed possibility set (the
   *  difference is `newlyEligible`), then overwrites it with that fresh
   *  set for the next call to read. Empty at the start of a reign, so tick
   *  1 finds every possible brief newly eligible. */
  eligibleLastTick: string[];
  /** Causality §3 (T4): booked follow-ups -- StoryletOption.books applied at
   *  choice-application time (attended, defaulted, and neglected paths all
   *  record; mediation is an ops-application detail underneath the SAME
   *  choice and never gates recording) appends here. Threads through
   *  resolveTick like arcs/eligibleLastTick: each call starts from the
   *  prior snapshot, appends this tick's newly-recorded bookings, then
   *  removes whatever examiner.select dealt or lapsed this tick before
   *  returning. Empty at the start of a reign. Order-stable: select()
   *  processes this array in a fixed sort of its own (storyletId, bookedAt,
   *  seatId), never insertion order alone. */
  bookings: Booking[];
  /** Playtest-3a #8a (consecutive-family suppression, appendix #8a): sorted,
   *  deduped storyletIds dealt via a LOTTERY stratum (attributed/world-
   *  newly/standing) on THIS state's tick -- never probes or bookings,
   *  which force-deal outside the lottery entirely. Threads through
   *  resolveTick exactly like eligibleLastTick: each call reads the prior
   *  snapshot as scheduler.ts's ctx.dealtLastTick (the consecutive-family
   *  exclusion, family-wide -- every instance sharing an excluded
   *  storyletId, not just the one dealt), then overwrites it with what ITS
   *  OWN lottery strata dealt for the next call to read. Empty at the start
   *  of a reign, so tick 1 applies no suppression at all. */
  dealtLastTick: string[];
}

export interface DecisionChoice {
  briefId: string;
  optionId?: string;
  ops?: Op[];
  via?: 'option' | 'directive';
  compileRef?: string;
}

export interface TickDecisions { seatId: string; choices: DecisionChoice[] }

export interface Brief {
  briefId: string;
  storyletId: string;
  title: string;
  body: string;
  options: Array<{ id: string; label: string }>;
  directiveAllowed: true;
  /** Causality §1 (T2): sorted ids of THIS tick's player-descended events
   *  whose writes made this brief newly eligible -- present only on
   *  player-attributed deals (attribution.ts's attribute()), absent (never
   *  `undefined`-but-present -- see the construction site) on every other
   *  brief. Packet-only, informational: surfaces render a "because of your
   *  order" label off it; nothing in the core reads it back. */
  becauseOf?: string[];
}

export interface Letter { from: string; title: string; body: string; storyletId: string }

export interface TickPacket {
  tick: number;
  tier: number;
  attentionSlots: number;
  briefs: Brief[];
  reports: ReportedLedger[];
  correspondence: Letter[];
}

export function initialState(season: SeasonConfig): ReignState {
  return { tick: 0, tier: season.startTier, graph: season.initialGraph, cooldowns: {}, firedOnce: {}, presented: {}, pending: [], arcs: {}, eligibleLastTick: [], bookings: [], dealtLastTick: [] };
}

const CHOICE_KEYS = new Set(['briefId', 'optionId', 'ops', 'via', 'compileRef']);
const TOP_KEYS = new Set(['seatId', 'choices']);

function containsJournal(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(containsJournal);
  if (v !== null && typeof v === 'object') {
    for (const [k, w] of Object.entries(v)) {
      if (k === 'journal') return true;
      if (containsJournal(w)) return true;
    }
  }
  return false;
}

export type DecisionsResult = { ok: true; value: TickDecisions } | { ok: false; error: string };

export function validateDecisions(season: SeasonConfig, state: ReignState, raw: unknown): DecisionsResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'decisions must be an object' };
  if (containsJournal(raw))
    return { ok: false, error: 'journal bytes must never reach the world side (D16) — send the journal on the SDK channel only' };
  const d = raw as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!TOP_KEYS.has(k)) return { ok: false, error: `unexpected field '${k}'` };
  if (d['seatId'] !== season.throne.id) return { ok: false, error: 'decisions must come from the throne seat' };
  if (!Array.isArray(d['choices'])) return { ok: false, error: 'choices must be an array' };
  const seen = new Set<string>();
  for (const c of d['choices'] as unknown[]) {
    if (typeof c !== 'object' || c === null) return { ok: false, error: 'choice must be an object' };
    const ch = c as Record<string, unknown>;
    for (const k of Object.keys(ch)) if (!CHOICE_KEYS.has(k)) return { ok: false, error: `unexpected choice field '${k}'` };
    const briefId = ch['briefId'];
    if (typeof briefId !== 'string') return { ok: false, error: 'choice.briefId must be a string' };
    if (seen.has(briefId)) return { ok: false, error: `duplicate choice for '${briefId}'` };
    seen.add(briefId);
    const pending = state.pending.find((p) => p.briefId === briefId);
    if (!pending) return { ok: false, error: `no pending brief '${briefId}'` };
    const via = ch['via'];
    if (via !== undefined && via !== 'option' && via !== 'directive')
      return { ok: false, error: `choice '${briefId}' via must be 'option' or 'directive'` };
    const compileRef = ch['compileRef'];
    if (compileRef !== undefined && typeof compileRef !== 'string')
      return { ok: false, error: `choice '${briefId}' compileRef must be a string` };
    // Presence, not type, decides which arm is "given": this must agree with
    // resolveTick's own `choice.optionId !== undefined` branch (§3) or a
    // wrongly-typed optionId slips past here and crashes the non-null
    // assertion there instead of being rejected at the wire gate.
    const optionId = ch['optionId'];
    const ops = ch['ops'];
    const hasOption = optionId !== undefined;
    const hasOps = ops !== undefined;
    if (hasOption === hasOps) return { ok: false, error: `choice '${briefId}' needs exactly one of optionId | ops` };
    if (hasOption) {
      if (typeof optionId !== 'string') return { ok: false, error: `choice '${briefId}' optionId must be a string` };
      const storylet = findStorylet(season, pending.storyletId);
      if (!storylet.options.some((o) => o.id === optionId))
        return { ok: false, error: `unknown option '${String(optionId)}' on '${briefId}'` };
    }
    if (hasOps) {
      if (!Array.isArray(ops)) return { ok: false, error: `choice '${briefId}' ops must be an array` };
      for (const op of ops as unknown[]) {
        const r = validateOp(state.graph, op);
        if (!r.ok) return { ok: false, error: `bad op on '${briefId}': ${r.error}` };
      }
    }
  }
  return { ok: true, value: raw as TickDecisions };
}

function findStorylet(season: SeasonConfig, id: string): Storylet {
  for (const deck of season.decks) {
    const s = deck.storylets.find((x) => x.id === id);
    if (s) return s;
  }
  throw new Error(`no storylet '${id}' in season decks`);
}

// Causality §3 (T4): StoryletOption.books -> a ReignState.bookings entry.
// byTick = the tick this option was chosen/defaulted (resolveTick's own
// `tick`, i.e. state.tick -- NOT nextTick) PLUS withinTicks: the earliest a
// booking can possibly deal is next tick (this same resolveTick call's own
// step 9 casts for state.tick + 1), so withinTicks counts casting
// opportunities from there -- withinTicks 1 means "must deal at next tick
// or never," mirroring how fingerprints (ops.ts's stampDeed) stamp `at` as
// the current tick and decay off `tick - at`.
function recordBooking(books: NonNullable<StoryletOption['books']>, tick: number, seatId: string): Booking {
  return { storyletId: books.storyletId, seatId, byTick: tick + books.withinTicks, bookedAt: tick };
}

// Rolling wants (spec §2, T7): after an op's own deltas land, every
// character with a wantChain gets one chance to advance -- sorted by node
// id so two characters satisfied by the same op (a festival pleasing two
// interest-holders) chronicle in a stable order. At most one want per
// character per op: their CURRENT want only, never re-checked after it
// advances. `parentEventId` cites the event that carried the op's own
// deltas, mirroring how every other resolveTick emission parents to its
// cause (e.g. op.skimmed -> executedEventId in mediate.ts). `op` here is
// whatever applyOpWithWants passes in below -- since the T7 review, that's
// the LANDED op (landedOp()'s reconstruction), not necessarily the DECIDED
// one.
function advanceWants(g: WorldGraph, op: Op, tick: number, em: Emitter, parentEventId: string): WorldGraph {
  let g2 = g;
  for (const charId of nodeIds(g2)) {
    const node = getNode(g2, charId);
    const want = currentWant(g2, charId); // null both when wantChain isn't an array and past its end
    if (want === null) continue;
    const predicate = WANT_FULFILL[want as WantKey];
    if (!predicate(g2, op, charId)) continue;
    const idx = node.props['wantIndex'];
    const nextIndex = (typeof idx === 'number' ? idx : 0) + 1;
    const deltas: GraphDelta[] = [
      { op: 'node.set', id: charId, key: 'wantIndex', value: nextIndex },
      { op: 'node.set', id: charId, key: 'wantSinceTick', value: tick },
    ];
    g2 = applyDeltas(g2, deltas);
    em.emit('want.fulfilled', { parents: [parentEventId], data: { charId, wantKey: want }, deltas });
  }
  return g2;
}

// T7 review fix: want predicates must see the REALIZED op, not the DECIDED
// one. A mediated op can land band-scaled below what the throne originally
// proposed (mediate.ts's scaleOp) -- `coin`'s >= fx('15') threshold has to
// read what actually arrived, not what was asked for, or a skimmed-down
// grant landing under the threshold would still satisfy it. Every applyOp
// arm spreads the op it was actually called with into its own landed
// event's data (e.g. op.grant's `data: { ...op, bpDelta }` carries the
// band-scaled amount when mediation scaled it), so this rebuilds the
// evaluated op from the DECIDED op with only its amount/size overridden by
// what the landed event recorded. Deliberately minimal rather than
// `{ kind: op.kind, ...landedEvent.data }`: several arms' data carries
// extra kind-specific fields (op.grant's bpDelta, op.audit's
// found/skimmed/holder, ...) that don't belong on the Op union and would
// fight its discriminated shape if spread in wholesale.
function landedOp(op: Op, data: Record<string, unknown>): Op {
  const amount = data['amount'];
  if ('amount' in op && typeof amount === 'string') return { ...op, amount };
  const size = data['size'];
  if ('size' in op && typeof size === 'string') return { ...op, size };
  return op;
}

// Applies one op (plain or mediated per the tier's config), then -- ONLY if
// the op's own deltas actually landed -- runs the want-advance pass above.
// "Landed" is read off the chronicle itself rather than off
// applyMediatedOp's return value (just a WorldGraph): a botched mediated
// draw emits op.executed but never calls applyOp for the underlying op
// (mediate.ts's `if (band !== 'botched')` guard), so no `op.<kind>` event
// appears for it -- even though a greedy executor's skim rider CAN still
// touch the graph on a botched draw, which rules out a cheaper "did g
// change" check. A refused/rejected op never reaches this function at all
// (the caller's validateOp/willingness gate already `continue`d or
// returned before calling it), so those cases need no special handling
// here: botched is the only "applied a mediated op, nothing landed" case
// this function has to distinguish.
function applyOpWithWants(
  g: WorldGraph,
  tierCfg: TierConfig,
  op: Op,
  tick: number,
  fortune: Fortune,
  em: Emitter,
  seatId: string,
  parents: string[],
): WorldGraph {
  const before = em.all().length;
  let g2 = tierCfg.mediation
    ? applyMediatedOp(g, op, tick, fortune, em, tierCfg.mediation, seatId, parents)
    : applyOp(g, op, tick, em, seatId, parents);
  const landedEvent = em.all().slice(before).find((e) => e.type === `op.${op.kind}`);
  if (landedEvent) g2 = advanceWants(g2, landedOp(op, landedEvent.data), tick, em, landedEvent.id);
  return g2;
}

export function resolveTick(
  season: SeasonConfig,
  state: ReignState,
  decisions: TickDecisions,
  fortune: Fortune,
): { state: ReignState; events: ChronicleEvent[]; packet: TickPacket } {
  const valid = validateDecisions(season, state, decisions);
  if (!valid.ok) throw new Error(`resolveTick: ${valid.error}`);
  const tick = state.tick;
  const em = makeEmitter(tick);
  let g = state.graph;
  let arcs = state.arcs;
  let bookings = state.bookings;
  const tierCfg = season.tiers[state.tier];
  if (!tierCfg) throw new Error(`no tier config for tier ${state.tier}`);

  // 1-2. Record decisions; the attention cut is the agent's own ordering.
  const attended = decisions.choices.slice(0, tierCfg.attentionSlots);
  const overflow = decisions.choices.slice(tierCfg.attentionSlots);
  const decisionEvents = new Map<string, string>();
  for (const choice of decisions.choices) {
    const ev = em.emit('decision.recorded', {
      data: { briefId: choice.briefId, optionId: choice.optionId ?? null, ops: choice.ops ?? null, via: choice.via ?? 'option', compileRef: choice.compileRef ?? null, attended: attended.includes(choice) },
    });
    decisionEvents.set(choice.briefId, ev.id);
  }

  // 3. Apply attended ops in the agent's priority order.
  for (const choice of attended) {
    const pending = state.pending.find((p) => p.briefId === choice.briefId)!;
    const chosenOption = choice.optionId !== undefined
      ? findStorylet(season, pending.storyletId).options.find((o) => o.id === choice.optionId)
      : undefined;
    const ops = chosenOption ? bindOps(chosenOption.ops, pending.binding) : choice.ops ?? [];
    for (const op of ops) {
      const r = validateOp(g, op);
      if (!r.ok) { em.emit('op.rejected', { parents: [decisionEvents.get(choice.briefId)!], data: { briefId: choice.briefId, op, error: r.error, via: 'option' } }); continue; }
      g = applyOpWithWants(g, tierCfg, r.op, tick, fortune, em, decisions.seatId, [decisionEvents.get(choice.briefId)!]);
    }
    // Causality §3 (T4): booking is a property of the CHOSEN OPTION, not of
    // any individual op's success -- records once per attended choice whose
    // option carries `books`, regardless of whether the ops above landed or
    // were rejected (an option can also book with no ops at all). A raw
    // directive choice (choice.optionId === undefined, chosenOption
    // undefined) never books: `books` lives on a STORYLET OPTION, and a
    // directive bypasses options entirely.
    if (chosenOption?.books) {
      const booking = recordBooking(chosenOption.books, tick, decisions.seatId);
      bookings = [...bookings, booking];
      em.emit('scene.booked', { parents: [decisionEvents.get(choice.briefId)!], data: { storyletId: booking.storyletId, byTick: booking.byTick } });
    }
  }

  // 4. Everything else defaults: over-slot choices and undecided briefs alike.
  for (const pending of state.pending) {
    const wasAttended = attended.some((c) => c.briefId === pending.briefId);
    if (wasAttended) continue;
    const neglected = overflow.some((c) => c.briefId === pending.briefId);
    const storylet = findStorylet(season, pending.storyletId);
    const defaultOption = storylet.options.find((o) => o.id === pending.defaultOptionId);
    const ev = em.emit(neglected ? 'brief.neglected' : 'brief.defaulted', {
      parents: [pending.presentedEventId],
      data: { briefId: pending.briefId, storyletId: pending.storyletId, defaultOptionId: pending.defaultOptionId },
    });
    for (const op of defaultOption ? bindOps(defaultOption.ops, pending.binding) : []) {
      const r = validateOp(g, op);
      if (r.ok) {
        g = applyOpWithWants(g, tierCfg, r.op, tick, fortune, em, decisions.seatId, [ev.id]);
      } else em.emit('op.rejected', { parents: [ev.id], data: { briefId: pending.briefId, op, error: r.error, via: 'default' } });
    }
    // Causality §3 (T4): the default path books too (plan test (e)) --
    // covers BOTH brief.defaulted (never decided) and brief.neglected
    // (decided but over the attention cut) since they share this one loop;
    // parent is whichever of those two events this pending brief actually
    // got emitted above.
    if (defaultOption?.books) {
      const booking = recordBooking(defaultOption.books, tick, decisions.seatId);
      bookings = [...bookings, booking];
      em.emit('scene.booked', { parents: [ev.id], data: { storyletId: booking.storyletId, byTick: booking.byTick } });
    }
  }

  // 4.5. Observations (spec §4): execution events reach the throne only as
  // OBSERVATIONS, bent by the observer's own interests -- computed here,
  // right after ops apply and before step 5-7's systems can drift the very
  // loyalty/grudge edges the precedence rules read (socialStep relaxes
  // loyalty and decays grudge every tick; an observation should read the
  // relationship as of the report, not after a further tick of decay
  // already landed on top of it). When reporter seats are configured, each
  // compiles a biased read of this tick's op.executed/op.skimmed events
  // (observeExecutions -- pure selection, mirrors examiner.select), and
  // those observations ride along on that seat's report at step 10. When no
  // reporter seat exists at all, the throne watches directly and
  // unfiltered: true band, via 'direct' -- there is no report to attach
  // this to, so the chronicle carries it alone. At an unmediated tier
  // op.executed never fires in the first place (mediate.ts only emits it
  // from applyMediatedOp), so the direct branch is a natural no-op there;
  // it exists for a mediated tier with no reporting office configured.
  const executionEvents = em.all();
  const sortedReporters = [...season.reporters].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const observationsBySeat = new Map<string, Observation[]>();
  if (sortedReporters.length === 0) {
    if (tierCfg.mediation) {
      for (const ev of executionEvents) {
        if (ev.type === 'op.executed') {
          const data = ev.data as { executorId: string; domain: string; band: Band };
          const obs: Observation = { executorId: data.executorId, domain: data.domain, claimedBand: data.band, taskRef: ev.id };
          em.emit('observation.received', { parents: [obs.taskRef], data: { ...obs, via: 'direct' } });
        } else if (ev.type === 'op.skimmed') {
          const data = ev.data as { executorId: string };
          const obs: Observation = { executorId: data.executorId, domain: 'econ', claimedBand: 'poor', taskRef: ev.id };
          em.emit('observation.received', { parents: [obs.taskRef], data: { ...obs, via: 'direct' } });
        }
      }
    }
  } else {
    for (const seat of sortedReporters) {
      const obs = observeExecutions(g, executionEvents, seat, tick, fortune);
      observationsBySeat.set(seat.id, obs);
      for (const o of obs) {
        em.emit('observation.received', { parents: [o.taskRef], data: { ...o, via: seat.id } });
      }
    }
  }

  // 4.5b. Vet's direct effect (Task 9, spec §9): unlike the reporter-
  // mediated observations above, a landed vet op IS its own act of
  // intelligence-gathering -- it always produces exactly one
  // observation.received (via: 'vet'), regardless of whether any reporter
  // seats or mediation are configured (vet is usable from tier 0 onward,
  // unlike op.executed/op.skimmed above which only ever exist under
  // mediation). Read off the SAME executionEvents snapshot as step 4.5,
  // before systems steps 5-7 can drift the graph.
  for (const ev of executionEvents) {
    if (ev.type !== 'op.vet') continue;
    const data = ev.data as { charId: string };
    const obs = vetObservation(g, data.charId, tick, fortune, ev.id);
    em.emit('observation.received', { parents: [ev.id], data: { ...obs, via: 'vet' } });
  }

  // 5-7. Systems.
  g = economyStep(g, tick, fortune, em);
  g = socialStep(g, tick, em);
  // Causality §2: deed fingerprint decay, adjacent to socialStep (systems.ts)
  // -- placed here for the same "no dependency either way" reason advanceArcs
  // and character arcs sit next to each other below: fingerprint props are
  // disjoint from everything economyStep/socialStep/advanceArcs touch, so
  // ordering only affects which of this tick's events sort first, never the
  // outcome.
  g = fingerprintDecayStep(g, tick, em);
  g = advanceArcs(g, tick, season.calendar, em);
  // T8 (spec §5): character arcs generalize the famine machinery just
  // above to people -- same tick-driven systems step, same delta-native
  // discipline, placed immediately after advanceArcs so the parallel is
  // visible at the call site. Ordering vs. advanceArcs is a no-op choice,
  // not a dependency: famine arms/advances read only place nodes off the
  // calendar, character arcs read only character nodes off the graph (plus
  // wantSinceTick) -- the two passes are disjoint over the graph, so which
  // runs first can't change either one's outcome, only which of their
  // events would sort first within this tick's chronicle.
  const arcResult = advanceCharacterArcs(g, tick, arcs, em, season.rivalId, season.primaryPlaceId);
  g = arcResult.g;
  arcs = arcResult.arcs;

  // 8. Ladder.
  let tier = state.tier;
  const rule = checkLadder(g, tier, tick, season.tierRules);
  if (rule) { g = applyTransition(g, rule, tick, em); tier = rule.to; }

  // 9. Present the next tick.
  const nextTick = tick + 1;
  const nextCfg = season.tiers[tier] ?? tierCfg;
  const decks = season.decks.filter((d) => nextCfg.deckIds.includes(d.id));
  const cooldowns = { ...state.cooldowns };
  const firedOnce = { ...state.firedOnce };
  const presented = { ...state.presented };
  const eligible = eligibleStorylets(g, decks, cooldowns, nextTick, firedOnce);
  // Causality §1 (whole-wave final-review fix): recency casting keys off
  // the PATTERN-POSSIBILITY set (possibleStorylets, storylet.ts) instead
  // of the cooldown/firedOnce-FILTERED `eligible` pool just above --
  // `eligible` itself is untouched by this fix and remains exactly the
  // DEALT pool examiner.select draws from below. Why the split: a brief
  // dealt at tick T with cooldownTicks C leaves `eligible` until T+C, then
  // re-enters it -- but its PATTERN never stopped binding in between, so
  // diffing against the filtered pool (the pre-fix behavior) misread every
  // cooldown expiry as "just became possible," handing the recycling brief
  // a recency boost over standing briefs regardless of how many times it
  // had already been shown. Diffing against the unfiltered possibility set
  // fixes this: a cooldown-expired brief was already possible last tick
  // (present in the snapshot below), so it re-enters `eligible` as
  // STANDING, competing on presented-count novelty like everything else --
  // while a genuine world-change unlock (a pattern that could NOT bind
  // last tick, cooldown aside) still lands newly, exactly as before.
  const possible = possibleStorylets(g, decks);
  const priorPossible = new Set(state.eligibleLastTick);
  const possibleBriefKeys = possible.filter((e) => e.storylet.kind === 'brief').map((e) => e.instanceKey);
  const newlyEligible = new Set(possibleBriefKeys.filter((k) => !priorPossible.has(k)));
  const eligibleLastTick = [...new Set(possibleBriefKeys)].sort();
  // Causality §1 (T2): computed attribution over the newly-eligible brief
  // entries only (attribute() is never asked about standing ones -- a
  // standing instanceKey can never be a becauseOf map key). `em.all()` here
  // is everything chronicled THIS tick through step 8 (decisions, ops,
  // observations, systems, ladder) -- nothing from step 9 itself has been
  // emitted yet, so this can't self-referentially attribute a brief to its
  // own presentation. `decisionEvents.values()` is every decision.recorded
  // id minted THIS tick (step 1-2, one per submitted choice, attended or
  // not) -- the ancestry walk's root set.
  const newlyEligibleEntries = eligible.filter((e) => e.storylet.kind === 'brief' && newlyEligible.has(e.instanceKey));
  const becauseOf = attribute(g, newlyEligibleEntries, em.all(), new Set(decisionEvents.values()));
  // presented (pre-increment below) is the N-1 snapshot: this tick's own
  // presentations don't count toward its own selection.
  const sel = examiner.select({ tick: nextTick, briefBudget: nextCfg.briefBudget, eligible, fortune, calendar: season.calendar, presented, newlyEligible, becauseOf, bookings, dealtLastTick: state.dealtLastTick });
  // Playtest-3a #8a: this tick's lottery deals become NEXT tick's exclusion
  // set -- deduped (a perBinding family can land more than one instance of
  // the same storyletId in `lotteryDealt` when budget allows) and sorted
  // (order-stable, matching eligibleLastTick's own convention just above).
  const dealtLastTick = [...new Set(sel.lotteryDealt.map((e) => e.storylet.id))].sort();
  for (const id of sel.skippedProbes) em.emit('probe.skipped', { data: { storyletId: id, tick: nextTick } });
  // Causality §3 (T4): a dealt booking needs no event of its own -- the
  // forced entry rides the ordinary brief.presented emission below (sel.
  // chosen doesn't distinguish HOW an entry was chosen), so this only has
  // work to do for lapses. deltas: [] (the emitter default, omitted below)
  // -- a booking's existence lives in ReignState.bookings alone, never the
  // WorldGraph, so there is nothing to delta (state-field lifecycle, the
  // same "informational only" shape arcs.ts's arc.poach.bid/
  // arc.scheme.telegraph already use). No `parents` either, matching how
  // EVERY arcs.ts lifecycle event (arc.retained, arc.departed, arc.restless,
  // ...) omits it: a lapse is a scheduler-side systemic determination made
  // at select() time, not descended from any one of this tick's decisions.
  for (const b of sel.lapsedBookings) em.emit('scene.booking.lapsed', { data: { storyletId: b.storyletId } });
  bookings = bookings.filter((b) => !sel.dealtBookings.includes(b) && !sel.lapsedBookings.includes(b));

  const pending: PendingBrief[] = [];
  const briefs: Brief[] = [];
  sel.chosen.forEach((entry, i) => {
    const briefId = `b${nextTick}.${i}`;
    const ev = em.emit('brief.presented', { data: { briefId, storyletId: entry.storylet.id, instanceKey: entry.instanceKey, binding: entry.binding, forTick: nextTick } });
    cooldowns[entry.instanceKey] = nextTick;
    presented[entry.instanceKey] = (presented[entry.instanceKey] ?? 0) + 1;
    if (entry.storylet.once) firedOnce[entry.instanceKey] = true;
    pending.push({ briefId, storyletId: entry.storylet.id, binding: entry.binding, defaultOptionId: entry.storylet.defaultOptionId, presentedEventId: ev.id });
    // becauseOf is spread in conditionally (never a present-but-undefined
    // key): canonJson (canon.ts) throws on `typeof undefined`, and a Brief
    // can end up inside a hashed/canonicalized value down the line -- an
    // absent key is also just the correct reading of the optional field.
    const becauseOfIds = becauseOf.get(entry.instanceKey);
    briefs.push({
      briefId, storyletId: entry.storylet.id,
      title: renderTpl(entry.storylet.title, g, entry.binding),
      body: renderTpl(entry.storylet.body, g, entry.binding),
      options: entry.storylet.options.map((o) => ({ id: o.id, label: renderTpl(o.label, g, entry.binding) })),
      directiveAllowed: true,
      ...(becauseOfIds !== undefined ? { becauseOf: becauseOfIds } : {}),
    });
  });

  const correspondence: Letter[] = sel.letters.map((entry) => {
    const from = entry.storylet.from ?? entry.binding[entry.storylet.fromVar ?? ''] ?? 'unknown';
    em.emit('letter.sent', { data: { storyletId: entry.storylet.id, from, forTick: nextTick } });
    cooldowns[entry.instanceKey] = nextTick;
    if (entry.storylet.once) firedOnce[entry.instanceKey] = true;
    return { from, title: renderTpl(entry.storylet.title, g, entry.binding), body: renderTpl(entry.storylet.body, g, entry.binding), storyletId: entry.storylet.id };
  });

  // 10. Reports — biased projections, per reporting seat (sorted by seat id;
  // sortedReporters and this tick's compiled observations are shared with
  // step 4.5 above so both loops walk the same seats in the same order).
  const reports: ReportedLedger[] = sortedReporters.map((seat) => {
    const report = compileReport(g, fortune, nextTick, season.primaryPlaceId, seat, observationsBySeat.get(seat.id) ?? []);
    em.emit('report.issued', { data: { ...report } });
    return report;
  });

  return {
    state: { tick: nextTick, tier, graph: g, cooldowns, firedOnce, presented, pending, arcs, eligibleLastTick, bookings, dealtLastTick },
    events: em.all(),
    packet: { tick: nextTick, tier, attentionSlots: nextCfg.attentionSlots, briefs, reports, correspondence },
  };
}
