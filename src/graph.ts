// D14: one typed property graph as core state — an in-memory value, never an
// external database. All social state lives here. All iteration is in sorted
// -ID order; system code must use these helpers, never Object.keys directly,
// or replays lose bit-exactness.
import type { Fx } from './fx.js';

export type NodeId = string;
export type EdgeId = string;
export type NodeType = 'character' | 'faction' | 'place' | 'office' | 'institution' | 'project';
export type EdgeType = 'grudge' | 'loyalty' | 'kinship' | 'debt' | 'appointment' | 'route' | 'interest';
export type PropValue = bigint | number | string | boolean;
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
  return { ...g, edges: { ...g.edges, [id]: { id, ...e } } };
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
