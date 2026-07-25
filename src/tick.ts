// The spec's core contract (§6, D12): resolveTick(season, state, decisions,
// fortune) — pure, I/O-free, deterministic. The host wraps this in exactly
// three LLM roles (NPC voice, order compiling, post-hoc analysis); nothing
// in here calls anything. TickDecisions has NO journal field: stated
// reasoning travels SDK → host → sealed store → analyst, never through the
// world (D16). Free-text directives arrive here already compiled to ops.
import { hashValue } from './canon.js';
import type { ChronicleEvent } from './events.js';
import { makeEmitter } from './events.js';
import type { Fortune } from './fortune.js';
import type { WorldGraph } from './graph.js';
import type { TierRule } from './ladder.js';
import { applyTransition, checkLadder } from './ladder.js';
import type { Binding } from './match.js';
import type { Op } from './ops.js';
import { applyOp, validateOp } from './ops.js';
import type { ReportedLedger, Seat } from './report.js';
import { compileReport } from './report.js';
import type { ExaminerCalendar } from './scheduler.js';
import { advanceArcs, examiner } from './scheduler.js';
import type { Deck, Storylet } from './storylet.js';
import { bindOps, eligibleStorylets, renderTpl } from './storylet.js';
import { economyStep, socialStep } from './systems.js';

export interface TierConfig { deckIds: string[]; briefBudget: number; attentionSlots: number }

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
  pending: PendingBrief[];
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
  return { tick: 0, tier: season.startTier, graph: season.initialGraph, cooldowns: {}, firedOnce: {}, pending: [] };
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
    const ops = choice.optionId !== undefined
      ? bindOps(findStorylet(season, pending.storyletId).options.find((o) => o.id === choice.optionId)!.ops, pending.binding)
      : choice.ops ?? [];
    for (const op of ops) {
      const r = validateOp(g, op);
      if (!r.ok) { em.emit('op.rejected', { parents: [decisionEvents.get(choice.briefId)!], data: { briefId: choice.briefId, op, error: r.error, via: 'option' } }); continue; }
      g = applyOp(g, r.op, tick, em, [decisionEvents.get(choice.briefId)!]);
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
      if (r.ok) g = applyOp(g, r.op, tick, em, [ev.id]);
      else em.emit('op.rejected', { parents: [ev.id], data: { briefId: pending.briefId, op, error: r.error, via: 'default' } });
    }
  }

  // 5-7. Systems.
  g = economyStep(g, tick, fortune, em);
  g = socialStep(g, tick, em);
  g = advanceArcs(g, tick, season.calendar, em);

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
  const eligible = eligibleStorylets(g, decks, cooldowns, nextTick, firedOnce);
  const sel = examiner.select({ tick: nextTick, briefBudget: nextCfg.briefBudget, eligible, fortune, calendar: season.calendar });
  for (const id of sel.skippedProbes) em.emit('probe.skipped', { data: { storyletId: id, tick: nextTick } });

  const pending: PendingBrief[] = [];
  const briefs: Brief[] = [];
  sel.chosen.forEach((entry, i) => {
    const briefId = `b${nextTick}.${i}`;
    const ev = em.emit('brief.presented', { data: { briefId, storyletId: entry.storylet.id, instanceKey: entry.instanceKey, binding: entry.binding, forTick: nextTick } });
    cooldowns[entry.instanceKey] = nextTick;
    if (entry.storylet.once) firedOnce[entry.instanceKey] = true;
    pending.push({ briefId, storyletId: entry.storylet.id, binding: entry.binding, defaultOptionId: entry.storylet.defaultOptionId, presentedEventId: ev.id });
    briefs.push({
      briefId, storyletId: entry.storylet.id,
      title: renderTpl(entry.storylet.title, g, entry.binding),
      body: renderTpl(entry.storylet.body, g, entry.binding),
      options: entry.storylet.options.map((o) => ({ id: o.id, label: renderTpl(o.label, g, entry.binding) })),
      directiveAllowed: true,
    });
  });

  const correspondence: Letter[] = sel.letters.map((entry) => {
    const from = entry.storylet.from ?? entry.binding[entry.storylet.fromVar ?? ''] ?? 'unknown';
    em.emit('letter.sent', { data: { storyletId: entry.storylet.id, from, forTick: nextTick } });
    cooldowns[entry.instanceKey] = nextTick;
    if (entry.storylet.once) firedOnce[entry.instanceKey] = true;
    return { from, title: renderTpl(entry.storylet.title, g, entry.binding), body: renderTpl(entry.storylet.body, g, entry.binding), storyletId: entry.storylet.id };
  });

  // 10. Reports — biased projections, per reporting seat (sorted by seat id).
  const reports: ReportedLedger[] = [...season.reporters]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((seat) => {
      const report = compileReport(g, fortune, nextTick, season.primaryPlaceId, seat);
      em.emit('report.issued', { data: { ...report } });
      return report;
    });

  return {
    state: { tick: nextTick, tier, graph: g, cooldowns, firedOnce, pending },
    events: em.all(),
    packet: { tick: nextTick, tier, attentionSlots: nextCfg.attentionSlots, briefs, reports, correspondence },
  };
}
