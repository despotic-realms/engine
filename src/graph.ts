// D14: one typed property graph as core state — an in-memory value, never an
// external database. All social state lives here. All iteration is in sorted
// -ID order; system code must use these helpers, never Object.keys directly,
// or replays lose bit-exactness.
import type { Fx } from './fx.js';

export type NodeId = string;
export type EdgeId = string;
export type NodeType = 'character' | 'faction' | 'place' | 'office' | 'institution' | 'project';
export type EdgeType = 'grudge' | 'loyalty' | 'kinship' | 'debt' | 'appointment' | 'route' | 'interest';
export type PropValue = bigint | number | string | boolean | PropValue[] | { [key: string]: PropValue };
export type Props = Record<string, PropValue>;

export interface WorldNode { readonly id: NodeId; readonly type: NodeType; readonly props: Props }
export interface WorldEdge { readonly id: EdgeId; readonly type: EdgeType; readonly src: NodeId; readonly dst: NodeId; readonly props: Props }
export interface WorldGraph { readonly nodes: Record<NodeId, WorldNode>; readonly edges: Record<EdgeId, WorldEdge> }

export const emptyGraph = (): WorldGraph => ({ nodes: {}, edges: {} });

export function edgeId(type: EdgeType, src: NodeId, dst: NodeId): EdgeId {
  return `${type}:${src}->${dst}`;
}

export function getNode(g: WorldGraph, id: NodeId): WorldNode {
  const n = g.nodes[id];
  if (!n) throw new Error(`graph: no node '${id}'`);
  return n;
}

export function addNode(g: WorldGraph, node: WorldNode): WorldGraph {
  if (g.nodes[node.id]) throw new Error(`graph: node '${node.id}' exists`);
  return { ...g, nodes: { ...g.nodes, [node.id]: node } };
}

export function setNodeProp(g: WorldGraph, id: NodeId, key: string, value: PropValue): WorldGraph {
  const n = getNode(g, id);
  return { ...g, nodes: { ...g.nodes, [id]: { ...n, props: { ...n.props, [key]: value } } } };
}

export function removeNode(g: WorldGraph, id: NodeId): WorldGraph {
  getNode(g, id);
  const nodes = { ...g.nodes };
  delete nodes[id];
  const edges: Record<EdgeId, WorldEdge> = {};
  for (const eid of Object.keys(g.edges).sort()) {
    const e = g.edges[eid];
    if (e && e.src !== id && e.dst !== id) edges[eid] = e;
  }
  return { nodes, edges };
}

export function getEdge(g: WorldGraph, id: EdgeId): WorldEdge {
  const e = g.edges[id];
  if (!e) throw new Error(`graph: no edge '${id}'`);
  return e;
}

export function addEdge(
  g: WorldGraph,
  e: { type: EdgeType; src: NodeId; dst: NodeId; props: Props },
): WorldGraph {
  getNode(g, e.src);
  getNode(g, e.dst);
  const id = edgeId(e.type, e.src, e.dst);
  if (g.edges[id]) throw new Error(`graph: edge '${id}' exists`);
  return { ...g, edges: { ...g.edges, [id]: { ...e, id } } };
}

export function findEdge(g: WorldGraph, type: EdgeType, src: NodeId, dst: NodeId): WorldEdge | undefined {
  return g.edges[edgeId(type, src, dst)];
}

export function setEdgeProp(g: WorldGraph, id: EdgeId, key: string, value: PropValue): WorldGraph {
  const e = getEdge(g, id);
  return { ...g, edges: { ...g.edges, [id]: { ...e, props: { ...e.props, [key]: value } } } };
}

export function removeEdge(g: WorldGraph, id: EdgeId): WorldGraph {
  getEdge(g, id);
  const edges = { ...g.edges };
  delete edges[id];
  return { ...g, edges };
}

export function nodeIds(g: WorldGraph): NodeId[] {
  return Object.keys(g.nodes).sort();
}

export function nodesOfType(g: WorldGraph, type: NodeType): WorldNode[] {
  return nodeIds(g).map((id) => g.nodes[id]!).filter((n) => n.type === type);
}

function edgeList(g: WorldGraph): WorldEdge[] {
  return Object.keys(g.edges).sort().map((id) => g.edges[id]!);
}

export function edgesOfType(g: WorldGraph, type: EdgeType): WorldEdge[] {
  return edgeList(g).filter((e) => e.type === type);
}

export function edgesFrom(g: WorldGraph, src: NodeId, type?: EdgeType): WorldEdge[] {
  return edgeList(g).filter((e) => e.src === src && (!type || e.type === type));
}

export function edgesTo(g: WorldGraph, dst: NodeId, type?: EdgeType): WorldEdge[] {
  return edgeList(g).filter((e) => e.dst === dst && (!type || e.type === type));
}

export function propFx(p: Props, key: string): Fx {
  const v = p[key];
  if (typeof v !== 'bigint') throw new Error(`prop '${key}' is not Fx`);
  return v;
}
export function propInt(p: Props, key: string): number {
  const v = p[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error(`prop '${key}' is not int`);
  return v;
}
export function propStr(p: Props, key: string): string {
  const v = p[key];
  if (typeof v !== 'string') throw new Error(`prop '${key}' is not string`);
  return v;
}
export function propBool(p: Props, key: string): boolean {
  const v = p[key];
  if (typeof v !== 'boolean') throw new Error(`prop '${key}' is not boolean`);
  return v;
}

// Allegiance reason log (spec §5): loyalty/grudge edges remember WHY their
// bp moved -- consequence-visibility's data layer ("Mair: -800, your
// ruling, tick 4") and the voice layer's future raw material. Lives on the
// edge's `log` prop, an array of `{tick, deltaBp, cause}` -- legal and
// canonically serializable only because PropValue was widened recursively
// (T1) precisely for this. Capped at ALLEGIANCE_LOG_CAP entries, newest
// last, oldest dropped once the cap is exceeded. `cause` is either the id
// of the event whose deltas carried an op-driven bp change, or the literal
// 'time' for socialStep's continuous drift, which collapses into a single
// rolling entry instead of one row per tick (see foldAllegianceDrift).
export const ALLEGIANCE_LOG_CAP = 8;

export interface AllegianceLogEntry {
  readonly tick: number;
  readonly deltaBp: number;
  readonly cause: string;
  // A structural index signature, not a semantic "arbitrary extra keys are
  // welcome" -- required so this interface (closed to tick/deltaBp/cause in
  // practice) satisfies PropValue's `{ [key: string]: PropValue }` arm: a
  // named type without one isn't assignable there even when every declared
  // property already fits, which is what a plain fresh object literal gets
  // for free but a named interface reference does not.
  [key: string]: PropValue;
}

function isAllegianceLogEntry(v: PropValue): v is { tick: number; deltaBp: number; cause: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, PropValue>;
  return typeof r['tick'] === 'number' && typeof r['deltaBp'] === 'number' && typeof r['cause'] === 'string';
}

/** Reads an edge's `log` prop back as typed entries. Absent (never written)
 *  or malformed reads as empty -- the same "absent means default" contract
 *  propFx/propInt/propStr/propBool use for scalar props, extended to this
 *  structured one. */
export function allegianceLog(props: Props): AllegianceLogEntry[] {
  const raw = props['log'];
  return Array.isArray(raw) ? raw.filter(isAllegianceLogEntry) : [];
}

/** Append a fresh, discretely-caused log entry at the end (newest last),
 *  dropping the oldest once the log exceeds ALLEGIANCE_LOG_CAP entries.
 *  Used for every op-driven bp move -- `cause` is that op's own event id,
 *  including for edge CREATION, where `deltaBp` is the edge's initial bp
 *  (there is no prior entry to diff against). NOTE: the log is a PARTIAL
 *  reason-trail, not a full decomposition of current bp -- genesis-seeded
 *  edges carry no log for their starting value, and cap-8 eviction discards
 *  early entries, so consumers (portrait narration, consequence surfaces)
 *  must never assume sum(deltaBp) equals current bp. */
export function appendAllegianceLog(props: Props, tick: number, deltaBp: number, cause: string): AllegianceLogEntry[] {
  const next = [...allegianceLog(props), { tick, deltaBp, cause }];
  return next.length > ALLEGIANCE_LOG_CAP ? next.slice(next.length - ALLEGIANCE_LOG_CAP) : next;
}

/** Fold a socialStep drift tick into the log's single rolling `cause:
 *  'time'` entry: if one already exists, update it IN PLACE (summed
 *  deltaBp, refreshed tick) so it keeps its narrative position among
 *  discrete-cause entries rather than jumping to the end when it next
 *  changes; otherwise append a fresh one, subject to the same cap as any
 *  other append. In-place update preserves the narrative order of discrete
 *  causes -- a rolling drift entry re-sorting itself to "now" every tick
 *  would otherwise bury older discrete reasons under it repeatedly. */
export function foldAllegianceDrift(props: Props, tick: number, deltaBp: number): AllegianceLogEntry[] {
  const log = allegianceLog(props);
  const idx = log.findIndex((e) => e.cause === 'time');
  if (idx === -1) return appendAllegianceLog(props, tick, deltaBp, 'time');
  const next = [...log];
  next[idx] = { tick, deltaBp: next[idx]!.deltaBp + deltaBp, cause: 'time' };
  return next;
}
