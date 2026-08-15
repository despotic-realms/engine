// Causality §1 (spec: meta/docs/specs/2026-08-08-causality-design.md; plan:
// meta/docs/plans/2026-08-08-causality-plan.md, Task 2): computed
// attribution -- "the world answers the player" needs the world to be able
// to name WHICH of the player's own writes caused a brief to appear, so
// recency casting (T1, scheduler.ts's [newly, standing] partition) can
// further split `newly` into [attributed, world-newly] and Brief can carry
// a becauseOf label. Attribution is COMPUTED, never guessed and never
// drawn: no Fortune parameter appears anywhere in this file.
//
// The model (three functions):
//   patternReads(pattern)   -- what a storylet's pattern READS,
//     structurally: for each node var's where-clause, a (nodeType, prop)
//     pair; for each edge pattern, its edge type; for each '#'-pinned edge
//     endpoint, the literal node id it names. Pure -- no graph/events
//     involved, the same pattern always reads the same set.
//   playerWriteSet(g, events, thisTickDecisionIds) -- the AGGREGATE of
//     what the player's own actions wrote this tick, unioned across every
//     player-descended event's deltas. Standalone and independently useful
//     (e.g. "did the player write anything relevant at all this tick"),
//     but attribute() below does NOT build on this aggregate -- see its
//     own comment for why.
//   attribute(g, entries, events, thisTickDecisionIds) -- the
//     orchestrator: for each newly-eligible entry, which of THIS tick's
//     player-descended events individually intersect its read-set.
//     Returns instanceKey -> sorted attributing event ids; an entry absent
//     from the map is not attributed (world stratum).
//
// Player-descended (per the plan, verbatim): an event is player-descended
// if walking its `parents` chain reaches any of THIS TICK's
// `decision.recorded` ids. Every emit() in this codebase that has a real
// upstream cause cites it via `parents` (op.* cites its decision or its
// brief.defaulted/neglected; want.fulfilled cites its landed op; op.skimmed
// /op.delayed cite op.executed, which itself cites the decision under
// mediation) -- so this one structural walk, scoped to THIS tick's own
// event list, is the whole ancestry model. A parent id absent from that
// list (e.g. a previous tick's brief.presented, cited by this tick's
// brief.defaulted) makes the chain dead-end exactly where the player had no
// say this tick -- no special-casing needed. Systemic passes (economyStep,
// socialStep, advanceArcs/advanceCharacterArcs) never set `parents` at all
// (defaults to []), so they can never be player-descended.
//
// Write-set, per delta (per the plan, verbatim: "node.set -> (nodeTypeOf(id),
// key) + id; edge.* -> edgeType"): node.add/node.remove are OUTSIDE the
// write-set formula entirely (the current op vocabulary never removes a
// node, and a brand-new node's read-relevance is a coarser question the
// spec defers -- "Coarse-attribution refinement -- after playtest
// evidence"). node.set needs a graph lookup for nodeTypeOf(id) (NodeId
// carries no structural type -- 'char:ruler' is a content NAMING
// convention, not an engine guarantee), so both playerWriteSet and
// attribute take `g: WorldGraph` (the brief's terse interface list omits
// it; it's required by the formula's own "nodeTypeOf" notation). The graph
// used is the POST-tick graph tick.ts already holds at step 9 -- correct
// for every node.set delta this tick, since nothing in the current op/
// systems vocabulary removes a node.
//
// One deliberate extension beyond the plan's literal text: edge deltas'
// contribution to `ids` (not just node.set's case) is REQUIRED for the
// exact-id refinement to be satisfiable at all for an edge-typed pattern.
// Test (c) in test/attribution.test.ts -- "pattern pins #char:alwyn ...
// wrote on a DIFFERENT char -> NOT attributed" -- is exactly the
// audit-whisper/gen.petition idiom already used in the shipped starter
// deck (an edge pattern with a where-clause AND a '#'-pinned endpoint); if
// edge deltas never exposed which node ids they touch, an edgeType-only
// match could never be refined by a literal pin, and that scenario would
// be unsatisfiable by construction. So: edge.add exposes {src, dst}
// directly; edge.remove/edge.set carry only an EdgeId
// (`${type}:${src}->${dst}`, graph.ts's edgeId()), parsed rather than
// graph-looked-up -- looking up an edge that's mid-removal (or added and
// removed within the SAME tick) can't rely on either the pre- or post-tick
// graph consistently still holding it.
//
// Refinement rule (per the plan, verbatim: "where the pattern pins a
// literal id, the matching delta must carry that id"): read as a GLOBAL
// gate, not scoped to whichever pattern fragment introduced the literal --
// if a pattern's literals set is non-empty at all, EVERY delta match (via
// pairs OR edges) additionally requires that SAME delta's touched ids to
// intersect the pattern's literals. An unpinned pattern (empty literals,
// test (d)) skips the gate entirely -- coarse (nodeType, prop) matches
// stand on their own, over-attribution accepted by design ("errs toward
// 'the world answers'").
import type { ChronicleEvent, GraphDelta } from './events.js';
import type { GraphPattern } from './match.js';
import type { WorldGraph } from './graph.js';
import { getNode } from './graph.js';
import type { EligibleEntry } from './storylet.js';

export interface ReadSet {
  /** "type|prop" -- a node var's type paired with one of its where-clause props. */
  pairs: Set<string>;
  /** Edge pattern types, coarse (no per-prop granularity -- an edge's
   *  where-clause props are NOT part of the read-set formula). */
  edges: Set<string>;
  /** Literal node ids named by a '#'-pinned edge endpoint. */
  literals: Set<string>;
}

export interface WriteSet {
  pairs: Set<string>;
  edges: Set<string>;
  /** Every node id touched by a player-descended delta of any kind (a
   *  node.set target, or an edge delta's src/dst) -- powers the literal-pin
   *  refinement channel; see this file's header for why edges contribute
   *  here despite the plan's shorthand naming only node.set's "+ id". */
  ids: Set<string>;
}

/** instanceKey -> sorted attributing player event ids. An instance absent
 *  from the map was not attributed (world stratum). */
export type Attribution = Map<string, string[]>;

export function patternReads(pattern: GraphPattern): ReadSet {
  const pairs = new Set<string>();
  const edges = new Set<string>();
  const literals = new Set<string>();
  for (const node of pattern.nodes) {
    for (const pred of node.where ?? []) pairs.add(`${node.type}|${pred.prop}`);
  }
  for (const edge of pattern.edges ?? []) {
    edges.add(edge.type);
    addLiteral(literals, edge.from);
    addLiteral(literals, edge.to);
  }
  return { pairs, edges, literals };
}

// Mirrors match.ts's resolveEndpoint: a '#'-prefixed endpoint names a
// literal node id directly rather than a pattern var.
function addLiteral(literals: Set<string>, endpoint: string): void {
  if (endpoint.startsWith('#')) literals.add(endpoint.slice(1));
}

// graph.ts's edgeId() format: `${type}:${src}->${dst}`. Edge TYPES never
// contain ':' (the closed EdgeType vocabulary is plain slugs), so the
// first ':' reliably ends the type; node ids may themselves contain ':'
// (a content convention, e.g. 'char:ruler'), so this can't be a naive
// split(':').
function edgeIdParts(id: string): { type: string; src: string; dst: string } {
  const colon = id.indexOf(':');
  const type = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  const arrow = rest.indexOf('->');
  return { type, src: rest.slice(0, arrow), dst: rest.slice(arrow + 2) };
}

interface DeltaWrite { pair?: string; edgeType?: string; ids: string[] }

// Per-delta write contribution -- null for node.add/node.remove, which sit
// outside the write-set formula (see this file's header).
function deltaWrite(g: WorldGraph, d: GraphDelta): DeltaWrite | null {
  switch (d.op) {
    case 'node.set':
      return { pair: `${getNode(g, d.id).type}|${d.key}`, ids: [d.id] };
    case 'edge.add':
      return { edgeType: d.edge.type, ids: [d.edge.src, d.edge.dst] };
    case 'edge.remove':
    case 'edge.set': {
      const { type, src, dst } = edgeIdParts(d.id);
      return { edgeType: type, ids: [src, dst] };
    }
    default:
      return null;
  }
}

// This-tick event ids reachable from a decision.recorded emitted this
// tick, via `parents`. Memoized across the batch (each event visited at
// most once); the `seen` cycle guard is defensive only -- event ids are
// minted in strictly increasing per-tick sequence and `parents` only ever
// cites an already-emitted (so strictly earlier) id, so no cycle can
// actually exist.
function playerDescendedIds(events: readonly ChronicleEvent[], thisTickDecisionIds: ReadonlySet<string>): Set<string> {
  const byId = new Map<string, ChronicleEvent>();
  for (const e of events) byId.set(e.id, e);
  const memo = new Map<string, boolean>();
  const reaches = (id: string, seen: Set<string>): boolean => {
    if (thisTickDecisionIds.has(id)) return true;
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return false;
    seen.add(id);
    const ev = byId.get(id);
    const result = ev !== undefined && ev.parents.some((p) => reaches(p, seen));
    memo.set(id, result);
    return result;
  };
  const out = new Set<string>();
  for (const e of events) if (reaches(e.id, new Set())) out.add(e.id);
  return out;
}

/** Aggregate of every player-descended delta this tick. Standalone (see
 *  header) -- attribute() below does its own per-delta pass rather than
 *  building on this, for event-level precision. */
export function playerWriteSet(
  g: WorldGraph,
  events: readonly ChronicleEvent[],
  thisTickDecisionIds: ReadonlySet<string>,
): WriteSet {
  const descended = playerDescendedIds(events, thisTickDecisionIds);
  const pairs = new Set<string>();
  const edges = new Set<string>();
  const ids = new Set<string>();
  for (const e of events) {
    if (!descended.has(e.id)) continue;
    for (const d of e.deltas) {
      const w = deltaWrite(g, d);
      if (w === null) continue;
      if (w.pair !== undefined) pairs.add(w.pair);
      if (w.edgeType !== undefined) edges.add(w.edgeType);
      for (const id of w.ids) ids.add(id);
    }
  }
  return { pairs, edges, ids };
}

/** A single delta's write matches a read-set: a base hit via pairs or
 *  edges, refined (per this file's header) by literal-carry whenever the
 *  pattern pins any literal id at all. */
function matchesRead(reads: ReadSet, w: DeltaWrite): boolean {
  const baseHit = (w.pair !== undefined && reads.pairs.has(w.pair)) || (w.edgeType !== undefined && reads.edges.has(w.edgeType));
  if (!baseHit) return false;
  if (reads.literals.size === 0) return true;
  return w.ids.some((id) => reads.literals.has(id));
}

/** For each newly-eligible entry, which of this tick's player-descended
 *  events individually intersect its pattern's read-set (per-delta, per
 *  this file's header on why not via playerWriteSet's aggregate). Returns
 *  instanceKey -> sorted attributing event ids; an entry with no
 *  intersecting event is simply absent (not attributed -- world stratum). */
export function attribute(
  g: WorldGraph,
  entries: readonly EligibleEntry[],
  events: readonly ChronicleEvent[],
  thisTickDecisionIds: ReadonlySet<string>,
): Attribution {
  const descendedIds = playerDescendedIds(events, thisTickDecisionIds);
  const descendedEvents = events.filter((e) => descendedIds.has(e.id));
  const out: Attribution = new Map();
  for (const entry of entries) {
    const reads = patternReads(entry.storylet.pattern);
    const hits = new Set<string>();
    for (const event of descendedEvents) {
      for (const d of event.deltas) {
        const w = deltaWrite(g, d);
        if (w !== null && matchesRead(reads, w)) { hits.add(event.id); break; }
      }
    }
    if (hits.size > 0) out.set(entry.instanceKey, [...hits].sort());
  }
  return out;
}
