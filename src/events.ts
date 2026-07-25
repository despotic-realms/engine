// The chronicle is event-sourced and canonical (spec §6.2): events are graph
// deltas with causal parent links, forming a DAG. The core emits; the host
// persists. Event ids are t{tick}.{seq} — pure functions of resolution order,
// so replays regenerate identical ids.
import type { EdgeId, NodeId, PropValue, WorldEdge, WorldGraph, WorldNode } from './graph.js';
import { addEdge, addNode, removeEdge, removeNode, setEdgeProp, setNodeProp } from './graph.js';

export type GraphDelta =
  | { op: 'node.add'; node: WorldNode }
  | { op: 'node.remove'; id: NodeId }
  | { op: 'node.set'; id: NodeId; key: string; value: PropValue }
  | { op: 'edge.add'; edge: WorldEdge }
  | { op: 'edge.remove'; id: EdgeId }
  | { op: 'edge.set'; id: EdgeId; key: string; value: PropValue };

export interface ChronicleEvent {
  readonly id: string;
  readonly tick: number;
  readonly seq: number;
  readonly type: string;
  readonly parents: string[];
  readonly deltas: GraphDelta[];
  readonly data: Record<string, unknown>;
}

export function applyDelta(g: WorldGraph, d: GraphDelta): WorldGraph {
  switch (d.op) {
    case 'node.add': return addNode(g, d.node);
    case 'node.remove': return removeNode(g, d.id);
    case 'node.set': return setNodeProp(g, d.id, d.key, d.value);
    case 'edge.add': return addEdge(g, d.edge);
    case 'edge.remove': return removeEdge(g, d.id);
    case 'edge.set': return setEdgeProp(g, d.id, d.key, d.value);
  }
}

export function applyDeltas(g: WorldGraph, ds: GraphDelta[]): WorldGraph {
  return ds.reduce(applyDelta, g);
}

// One emitter per tick: ids are `t{tick}.{seq}` scoped to this emitter's own
// call sequence, so two emitters used for the same tick mint colliding ids.
export interface Emitter {
  emit(type: string, e?: { parents?: string[]; deltas?: GraphDelta[]; data?: Record<string, unknown> }): ChronicleEvent;
  all(): ChronicleEvent[];
}

export function makeEmitter(tick: number): Emitter {
  const events: ChronicleEvent[] = [];
  return {
    emit(type, e = {}) {
      // Copy every caller-supplied container and freeze the record (and each
      // copy) before it enters the chronicle: the canonical history must not
      // be retroactively rewritable, either by the caller mutating what they
      // passed in or by mutating the returned event.
      const parents = [...(e.parents ?? [])];
      const deltas = [...(e.deltas ?? [])];
      const data = { ...(e.data ?? {}) };
      const ev: ChronicleEvent = {
        id: `t${tick}.${events.length}`,
        tick,
        seq: events.length,
        type,
        parents,
        deltas,
        data,
      };
      Object.freeze(parents);
      Object.freeze(deltas);
      Object.freeze(data);
      Object.freeze(ev);
      events.push(ev);
      return ev;
    },
    all: () => [...events],
  };
}
