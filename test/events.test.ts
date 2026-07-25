import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { addEdge, addNode, edgeId, emptyGraph, getEdge, getNode, propFx } from '../src/graph.js';
import { applyDelta, applyDeltas, makeEmitter } from '../src/events.js';
import type { GraphDelta } from '../src/events.js';

describe('events', () => {
  it('emits deterministic sequential ids', () => {
    const em = makeEmitter(6);
    const a = em.emit('harvest.reaped', { data: { bp: 4200 } });
    const b = em.emit('op.decree_tax', { parents: [a.id] });
    expect(a.id).toBe('t6.0');
    expect(b.id).toBe('t6.1');
    expect(b.parents).toEqual(['t6.0']);
    expect(em.all()).toHaveLength(2);
  });
  it('applies deltas to the graph', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'place:a', type: 'place', props: { granary: fx('5') } });
    const g2 = applyDeltas(g, [
      { op: 'node.set', id: 'place:a', key: 'granary', value: fx('9') },
      { op: 'node.add', node: { id: 'char:x', type: 'character', props: {} } },
      { op: 'edge.add', edge: { id: 'loyalty:char:x->place:a', type: 'loyalty', src: 'char:x', dst: 'place:a', props: { bp: 5000 } } },
    ]);
    expect(propFx(getNode(g2, 'place:a').props, 'granary')).toBe(fx('9'));
    expect(propFx(getNode(g, 'place:a').props, 'granary')).toBe(fx('5'));
    expect(g2.edges['loyalty:char:x->place:a']).toBeDefined();
  });
  it('edge.add ignores a caller-supplied id — the derived key always wins', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'char:x', type: 'character', props: {} });
    g = addNode(g, { id: 'place:a', type: 'place', props: {} });
    const derived = edgeId('loyalty', 'char:x', 'place:a');
    const g2 = applyDeltas(g, [
      { op: 'edge.add', edge: { id: 'bogus', type: 'loyalty', src: 'char:x', dst: 'place:a', props: {} } },
    ]);
    expect(g2.edges[derived]?.id).toBe(derived);
    expect(getEdge(g2, derived).id).toBe(derived);
  });
  it('emit copies caller-supplied parents/deltas/data — later mutation does not leak into recorded history', () => {
    const em = makeEmitter(3);
    const parents = ['t3.parent'];
    const deltas: GraphDelta[] = [{ op: 'node.remove', id: 'char:x' }];
    const data: Record<string, unknown> = { note: 'original' };
    em.emit('some.event', { parents, deltas, data });

    parents.push('t3.injected');
    deltas.push({ op: 'node.remove', id: 'char:y' });
    data['note'] = 'mutated';

    const recorded = em.all()[0]!;
    expect(recorded.parents).toEqual(['t3.parent']);
    expect(recorded.deltas).toEqual([{ op: 'node.remove', id: 'char:x' }]);
    expect(recorded.data).toEqual({ note: 'original' });
  });
  it('recorded events are frozen — mutation attempts throw', () => {
    const em = makeEmitter(4);
    const ev = em.emit('some.event', { deltas: [{ op: 'node.remove', id: 'char:x' }] });
    expect(() => ev.deltas.push({ op: 'node.remove', id: 'char:y' })).toThrow(TypeError);
    expect(() => { (ev as unknown as { type: string }).type = 'other'; }).toThrow(TypeError);
  });
  it('dispatches node.remove — drops the node and incident edges, purely', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'char:x', type: 'character', props: {} });
    g = addNode(g, { id: 'place:a', type: 'place', props: {} });
    g = addEdge(g, { type: 'loyalty', src: 'char:x', dst: 'place:a', props: {} });
    const incident = edgeId('loyalty', 'char:x', 'place:a');
    const g2 = applyDelta(g, { op: 'node.remove', id: 'char:x' });
    expect(g2.nodes['char:x']).toBeUndefined();
    expect(g2.edges[incident]).toBeUndefined();
    expect(g.nodes['char:x']).toBeDefined();
    expect(g.edges[incident]).toBeDefined();
  });
  it('dispatches edge.remove — drops just the edge, purely', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'char:x', type: 'character', props: {} });
    g = addNode(g, { id: 'place:a', type: 'place', props: {} });
    g = addEdge(g, { type: 'loyalty', src: 'char:x', dst: 'place:a', props: {} });
    const id = edgeId('loyalty', 'char:x', 'place:a');
    const g2 = applyDelta(g, { op: 'edge.remove', id });
    expect(g2.edges[id]).toBeUndefined();
    expect(g2.nodes['char:x']).toBeDefined();
    expect(g.edges[id]).toBeDefined();
  });
  it('dispatches edge.set — updates one edge prop, purely', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'char:x', type: 'character', props: {} });
    g = addNode(g, { id: 'place:a', type: 'place', props: {} });
    g = addEdge(g, { type: 'loyalty', src: 'char:x', dst: 'place:a', props: { bp: 100 } });
    const id = edgeId('loyalty', 'char:x', 'place:a');
    const g2 = applyDelta(g, { op: 'edge.set', id, key: 'bp', value: 500 });
    expect(g2.edges[id]?.props['bp']).toBe(500);
    expect(g.edges[id]?.props['bp']).toBe(100);
  });
});
