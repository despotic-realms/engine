// Storylet eligibility is bounded subgraph matching: small typed patterns
// over a small graph (spec §6.3). Deterministic: candidates come from the
// sorted graph helpers, DFS binds pattern variables in declaration order, and
// the result list is therefore canonical. Patterns are pure data — decks and
// tier rules are authored as these shapes.
import type { NodeId, NodeType, EdgeType, Props, PropValue, WorldGraph } from './graph.js';
import { findEdge, nodesOfType } from './graph.js';

export type Cmp = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';
export interface Predicate { prop: string; cmp: Cmp; value: PropValue }
export interface NodePattern { as: string; type: NodeType; where?: Predicate[] }
export interface EdgePattern { type: EdgeType; from: string; to: string; where?: Predicate[] }
export interface GraphPattern { nodes: NodePattern[]; edges?: EdgePattern[] }
export type Binding = Record<string, NodeId>;

export function evalPredicate(props: Props, pred: Predicate): boolean {
  const v = props[pred.prop];
  if (v === undefined || typeof v !== typeof pred.value) return false;
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'string') {
    const w = pred.value as bigint | number | string;
    switch (pred.cmp) {
      case 'lt': return v < w;
      case 'le': return v <= w;
      case 'gt': return v > w;
      case 'ge': return v >= w;
      case 'eq': return v === w;
      case 'ne': return v !== w;
    }
  }
  // booleans: only eq/ne are meaningful
  return pred.cmp === 'eq' ? v === pred.value : pred.cmp === 'ne' ? v !== pred.value : false;
}

function resolveEndpoint(binding: Binding, ref: string): NodeId | undefined {
  return ref.startsWith('#') ? ref.slice(1) : binding[ref];
}

function edgesSatisfied(g: WorldGraph, edges: EdgePattern[], binding: Binding): boolean {
  for (const ep of edges) {
    const src = resolveEndpoint(binding, ep.from);
    const dst = resolveEndpoint(binding, ep.to);
    if (src === undefined || dst === undefined) continue; // both vars not yet bound
    const e = findEdge(g, ep.type, src, dst);
    if (!e) return false;
    for (const pred of ep.where ?? []) if (!evalPredicate(e.props, pred)) return false;
  }
  return true;
}

export function matchPattern(g: WorldGraph, pat: GraphPattern): Binding[] {
  const out: Binding[] = [];
  const edges = pat.edges ?? [];
  const walk = (i: number, binding: Binding): void => {
    if (i === pat.nodes.length) {
      // final check: every edge pattern must now be fully resolvable and satisfied
      for (const ep of edges) {
        if (resolveEndpoint(binding, ep.from) === undefined || resolveEndpoint(binding, ep.to) === undefined) return;
      }
      if (edgesSatisfied(g, edges, binding)) out.push({ ...binding });
      return;
    }
    const np = pat.nodes[i]!;
    for (const node of nodesOfType(g, np.type)) {
      if (Object.values(binding).includes(node.id)) continue; // injective
      if ((np.where ?? []).some((p) => !evalPredicate(node.props, p))) continue;
      const next = { ...binding, [np.as]: node.id };
      if (!edgesSatisfied(g, edges, next)) continue; // prune early on bound endpoints
      walk(i + 1, next);
    }
  };
  walk(0, {});
  return out;
}
