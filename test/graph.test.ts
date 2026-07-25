import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import {
  addEdge, addNode, edgeId, edgesFrom, emptyGraph, findEdge, getNode,
  nodesOfType, propFx, propStr, removeNode, setNodeProp,
} from '../src/graph.js';

const base = () => {
  let g = emptyGraph();
  g = addNode(g, { id: 'place:zeta', type: 'place', props: { granary: fx('10') } });
  g = addNode(g, { id: 'place:alpha', type: 'place', props: { granary: fx('5') } });
  g = addNode(g, { id: 'char:osric', type: 'character', props: { name: 'Osric' } });
  g = addEdge(g, { type: 'loyalty', src: 'char:osric', dst: 'place:alpha', props: { bp: 4200 } });
  return g;
};

describe('graph', () => {
  it('iterates in sorted-ID order regardless of insertion order', () => {
    expect(nodesOfType(base(), 'place').map((n) => n.id)).toEqual(['place:alpha', 'place:zeta']);
  });
  it('updates are pure — originals unchanged', () => {
    const g = base();
    const g2 = setNodeProp(g, 'place:alpha', 'granary', fx('99'));
    expect(propFx(getNode(g, 'place:alpha').props, 'granary')).toBe(fx('5'));
    expect(propFx(getNode(g2, 'place:alpha').props, 'granary')).toBe(fx('99'));
  });
  it('derives edge ids and finds edges', () => {
    expect(edgeId('loyalty', 'char:osric', 'place:alpha')).toBe('loyalty:char:osric->place:alpha');
    expect(findEdge(base(), 'loyalty', 'char:osric', 'place:alpha')?.props['bp']).toBe(4200);
    expect(edgesFrom(base(), 'char:osric', 'loyalty')).toHaveLength(1);
  });
  it('removeNode drops incident edges', () => {
    const g = removeNode(base(), 'place:alpha');
    expect(edgesFrom(g, 'char:osric')).toHaveLength(0);
  });
  it('guards: duplicate add, missing endpoints, typed prop readers', () => {
    expect(() => addNode(base(), { id: 'place:alpha', type: 'place', props: {} })).toThrow();
    expect(() => addEdge(base(), { type: 'route', src: 'place:alpha', dst: 'place:nope', props: {} })).toThrow();
    expect(propStr(getNode(base(), 'char:osric').props, 'name')).toBe('Osric');
    expect(() => propFx(getNode(base(), 'char:osric').props, 'name')).toThrow();
  });
});
