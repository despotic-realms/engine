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

export interface StoryletOption { id: string; label: TextTpl; ops: OpTpl[] }

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
}

export interface Deck { id: string; tier: number; storylets: Storylet[] }
export interface EligibleEntry { storylet: Storylet; binding: Binding }
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
      if (firedOnce[s.id]) continue;
      const last = cooldowns[s.id];
      if (last !== undefined && tick - last < s.cooldownTicks) continue;
      const bindings = matchPattern(g, s.pattern);
      const first = bindings[0];
      if (first) out.push({ storylet: s, binding: first }); // canonical first binding
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
