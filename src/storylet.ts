// Storylets (spec §6.3, Fallen London lineage): briefs/letters as discrete
// units gated on world-graph patterns. A tier is a deck. The LLM renders
// prose AROUND the fixed mechanical skeleton (host-side); the skeleton here
// is readable without any model. checkDeck is the harness every deck ships
// against (D13: every skeleton ships with its unit test).
import type { Binding, GraphPattern } from './match.js';
import { matchPattern } from './match.js';
import type { WorldGraph } from './graph.js';
import { getNode } from './graph.js';
import type { Op } from './ops.js';
import { validateOp } from './ops.js';
import { fxToString } from './fx.js';

export type TextTpl = string;

/** An Op whose nodeId-typed string params may be '$var' references into the match binding. */
export type OpTpl = Op;

export interface StoryletOption {
  id: string;
  label: TextTpl;
  ops: OpTpl[];
  /** Causality §3 (T4, spec §3): jump the casting lottery entirely. Choosing
   *  this option -- attended, defaulted, or neglected, any path that applies
   *  its ops (tick.ts) -- books `storyletId` as a force-dealt follow-up,
   *  independent of whether those ops themselves land or get rejected.
   *  `withinTicks` becomes `byTick` at record time (tick.ts's
   *  recordBooking: the resolving tick + withinTicks) -- the last tick
   *  (inclusive) examiner.select still tries to force-deal it before it
   *  lapses unfilled. See ReignState.bookings (tick.ts) and
   *  examiner.select's due-bookings block (scheduler.ts) for the full
   *  record -> hold -> deal/lapse lifecycle. */
  books?: { storyletId: string; withinTicks: number };
}

export interface Storylet {
  id: string;
  kind: 'brief' | 'letter';
  tier: number;
  cooldownTicks: number;
  once: boolean;
  pattern: GraphPattern;
  title: TextTpl;
  body: TextTpl;
  options: StoryletOption[];       // 2–5 for briefs, [] for letters
  defaultOptionId: string;          // '' for letters
  from?: string;                    // literal sender node id (letters)
  fromVar?: string;                 // or a pattern var naming the sender
  /** Generator mode (D13 systemic floor): fire one instance per pattern
   *  binding instead of only the first, each with its own cooldown. */
  perBinding?: boolean;
  /** Cap on instances offered per tick for a perBinding storylet (default 2). */
  maxInstancesPerTick?: number;
}

export interface Deck { id: string; tier: number; storylets: Storylet[] }
export interface EligibleEntry { storylet: Storylet; binding: Binding; instanceKey: string }
export interface DeckProblem { storyletId: string; problem: string }

const TPL_RE = /\{\{([a-zA-Z0-9_.:-]+)\}\}/g;

export function renderTpl(tpl: TextTpl, g: WorldGraph, binding: Binding): string {
  return tpl.replace(TPL_RE, (whole, ref: string) => {
    const dot = ref.indexOf('.');
    const varName = dot === -1 ? ref : ref.slice(0, dot);
    const prop = dot === -1 ? undefined : ref.slice(dot + 1);
    const id = binding[varName];
    if (!id) return whole;
    const node = getNode(g, id);
    if (prop === undefined) {
      const name = node.props['name'];
      return typeof name === 'string' ? name : id;
    }
    const v = node.props[prop];
    if (v === undefined) return whole;
    return typeof v === 'bigint' ? fxToString(v) : String(v);
  });
}

export function bindOps(ops: readonly OpTpl[], binding: Binding): Op[] {
  return ops.map((op) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(op)) {
      out[k] = typeof v === 'string' && v.startsWith('$') ? (binding[v.slice(1)] ?? v) : v;
    }
    return out as unknown as Op;
  });
}

export function bindingKey(binding: Binding): string {
  return Object.keys(binding).sort().map((k) => `${k}=${binding[k]}`).join(',');
}

export function eligibleStorylets(
  g: WorldGraph,
  decks: readonly Deck[],
  cooldowns: Record<string, number>,
  tick: number,
  firedOnce: Record<string, true>,
): EligibleEntry[] {
  const out: EligibleEntry[] = [];
  const sortedDecks = [...decks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const deck of sortedDecks) {
    for (const s of [...deck.storylets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const bindings = matchPattern(g, s.pattern);
      if (bindings.length === 0) continue;
      if (s.perBinding === true) {
        const cap = s.maxInstancesPerTick ?? 2;
        let taken = 0;
        for (const binding of bindings) {
          if (taken >= cap) break;
          const instanceKey = `${s.id}@${bindingKey(binding)}`;
          if (firedOnce[instanceKey]) continue;
          const last = cooldowns[instanceKey];
          if (last !== undefined && tick - last < s.cooldownTicks) continue;
          out.push({ storylet: s, binding, instanceKey });
          taken += 1;
        }
      } else {
        const instanceKey = s.id;
        if (firedOnce[instanceKey]) continue;
        const last = cooldowns[instanceKey];
        if (last !== undefined && tick - last < s.cooldownTicks) continue;
        out.push({ storylet: s, binding: bindings[0]!, instanceKey });
      }
    }
  }
  return out;
}

// Causality §1 (whole-wave final-review fix): the PATTERN-POSSIBILITY set --
// every instance whose pattern binds against `g` right now, structurally
// UNFILTERED by cooldowns or firedOnce (contrast eligibleStorylets just
// above, which applies both gates before admitting an instance -- that
// filtered result remains the DEALT pool tick.ts hands to
// examiner.select, unchanged by this function's existence). Tick-
// independent by construction: with no cooldown/firedOnce gate to
// evaluate, there is no tick-shaped input left to take, so unlike
// eligibleStorylets this never needs one.
//
// Deliberately re-walks decks/storylets/patterns rather than threading a
// second return value through eligibleStorylets itself ("one extra match
// sweep," not "a dual return"): eligibleStorylets' existing (g, decks,
// cooldowns, tick, firedOnce) -> EligibleEntry[] signature and return shape
// are their own public surface, exercised directly by several tests
// (test/storylet.test.ts, test/generator.test.ts) and by
// test/recency.test.ts's own tick-1 cross-check -- changing its contract
// to also carry an unfiltered set would ripple well past tick.ts's step 9,
// where this fix is scoped. A sibling function costs one extra
// matchPattern pass per storylet per tick; storylet/deck counts are small
// (content-authored, not procedurally generated at scale), so the
// allocation is a non-issue next to the correctness this buys: a brief
// whose cooldown merely expired was ALSO possible last tick (its pattern
// never stopped binding), so it can never again be misread as newly
// eligible just because cooldown/firedOnce happened to hide it from the
// DEALT pool for a tick or two.
//
// perBinding generators: EVERY binding satisfying the raw pattern counts
// as possible here -- this function does NOT apply maxInstancesPerTick's
// cap. The cap is a DEALING throttle (how many of a generator's
// currently-satisfying bindings get offered this tick), not a fact about
// any one instanceKey's own pattern -- and capping here would reintroduce
// a subtler version of the exact bug this function exists to fix:
// eligibleStorylets' cap-then-take loop lets a LATER binding "slide into"
// the cap window purely because an EARLIER one is mid-cooldown (see
// test/generator.test.ts's "cooldowns are per instance, not per
// generator"), which would make that later binding's possibility-set
// membership depend on cooldown timing once more, one level up. Skipping
// the cap here means a perBinding storylet's possibility set is exactly
// "every binding whose own pattern currently matches," full stop --
// stable across ticks for a static graph, and correct even for a binding
// that would never survive into the top-`cap` window (it still gets
// flagged newly the one tick its own pattern starts matching, which the
// capped alternative could miss entirely for a binding sorting outside
// the window).
export function possibleStorylets(g: WorldGraph, decks: readonly Deck[]): EligibleEntry[] {
  const out: EligibleEntry[] = [];
  const sortedDecks = [...decks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const deck of sortedDecks) {
    for (const s of [...deck.storylets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const bindings = matchPattern(g, s.pattern);
      if (bindings.length === 0) continue;
      if (s.perBinding === true) {
        for (const binding of bindings) out.push({ storylet: s, binding, instanceKey: `${s.id}@${bindingKey(binding)}` });
      } else {
        out.push({ storylet: s, binding: bindings[0]!, instanceKey: s.id });
      }
    }
  }
  return out;
}

export function checkDeck(deck: Deck, fixtures: readonly WorldGraph[]): DeckProblem[] {
  const problems: DeckProblem[] = [];
  const seen = new Set<string>();
  for (const s of deck.storylets) {
    const bad = (problem: string) => problems.push({ storyletId: s.id, problem });
    if (seen.has(s.id)) bad('duplicate storylet id');
    seen.add(s.id);
    if (s.tier !== deck.tier) bad(`storylet tier ${s.tier} does not match deck tier ${deck.tier}`);
    if (s.kind === 'brief') {
      if (s.options.length < 2 || s.options.length > 5) bad(`briefs need 2-5 options, has ${s.options.length}`);
      if (!s.options.some((o) => o.id === s.defaultOptionId)) bad(`defaultOptionId '${s.defaultOptionId}' not among options`);
    } else {
      if (s.options.length !== 0) bad('letters carry no options');
      if (s.defaultOptionId !== '') bad(`letters need defaultOptionId === '', has '${s.defaultOptionId}'`);
      const hasFrom = !!s.from;
      const hasFromVar = !!s.fromVar;
      if (hasFrom && hasFromVar) bad('letters cannot have both from and fromVar');
      if (!hasFrom && !hasFromVar) bad('letters need exactly one of from or fromVar');
      if (s.fromVar && !s.pattern.nodes.some((n) => n.as === s.fromVar)) bad(`fromVar '${s.fromVar}' is not a pattern var`);
    }
    const optIds = new Set(s.options.map((o) => o.id));
    if (optIds.size !== s.options.length) bad('duplicate option ids');
    const fixture = fixtures.find((f) => matchPattern(f, s.pattern).length > 0);
    if (!fixture) {
      bad('pattern matches no fixture');
      continue;
    }
    const binding = matchPattern(fixture, s.pattern)[0]!;
    for (const o of s.options) {
      for (const op of bindOps(o.ops, binding)) {
        const r = validateOp(fixture, op);
        if (!r.ok) bad(`option '${o.id}' op invalid: ${r.error}`);
      }
    }
  }
  return problems;
}
