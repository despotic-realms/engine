import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { addNode, emptyGraph, getNode, propFx } from '../src/graph.js';
import { applyDeltas, makeEmitter } from '../src/events.js';

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
});
