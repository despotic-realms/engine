import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import {
  addEdge, addNode, edgeId, edgesFrom, edgesOfType, edgesTo, emptyGraph, findEdge, getEdge, getNode,
  nodeIds, nodesOfType, propBool, propFx, propInt, propStr, removeEdge, removeNode, setEdgeProp, setNodeProp,
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
  it('nodeIds returns sorted regardless of insertion order', () => {
    expect(nodeIds(base())).toEqual(['char:osric', 'place:alpha', 'place:zeta']);
  });
  it('getEdge returns edge or throws on missing', () => {
    const g = base();
    const id = edgeId('loyalty', 'char:osric', 'place:alpha');
    expect(getEdge(g, id).props['bp']).toBe(4200);
    expect(() => getEdge(g, edgeId('loyalty', 'char:osric', 'place:zeta'))).toThrow();
  });
  it('setEdgeProp is pure — originals unchanged', () => {
    const g = base();
    const id = edgeId('loyalty', 'char:osric', 'place:alpha');
    const g2 = setEdgeProp(g, id, 'bp', 9999);
    expect(getEdge(g, id).props['bp']).toBe(4200);
    expect(getEdge(g2, id).props['bp']).toBe(9999);
  });
  it('removeEdge removes edge and throws on missing', () => {
    const g = base();
    const id = edgeId('loyalty', 'char:osric', 'place:alpha');
    const g2 = removeEdge(g, id);
    expect(edgesFrom(g2, 'char:osric')).toHaveLength(0);
    expect(() => removeEdge(g2, id)).toThrow();
  });
  it('edgesOfType returns sorted type-filtered results', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'c:foo', type: 'character', props: {} });
    g = addNode(g, { id: 'c:bar', type: 'character', props: {} });
    g = addNode(g, { id: 'p:x', type: 'place', props: {} });
    g = addEdge(g, { type: 'loyalty', src: 'c:foo', dst: 'p:x', props: {} });
    g = addEdge(g, { type: 'kinship', src: 'c:foo', dst: 'c:bar', props: {} });
    g = addEdge(g, { type: 'loyalty', src: 'c:bar', dst: 'p:x', props: {} });
    const loyalties = edgesOfType(g, 'loyalty').map((e) => e.id);
    expect(loyalties).toEqual(['loyalty:c:bar->p:x', 'loyalty:c:foo->p:x']);
  });
  it('edgesTo covers type filter and sortedness together', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'c:alice', type: 'character', props: {} });
    g = addNode(g, { id: 'c:bob', type: 'character', props: {} });
    g = addNode(g, { id: 'c:charlie', type: 'character', props: {} });
    g = addNode(g, { id: 'p:home', type: 'place', props: {} });
    g = addEdge(g, { type: 'route', src: 'c:charlie', dst: 'p:home', props: {} });
    g = addEdge(g, { type: 'loyalty', src: 'c:bob', dst: 'p:home', props: {} });
    g = addEdge(g, { type: 'loyalty', src: 'c:alice', dst: 'p:home', props: {} });
    const toLoyalty = edgesTo(g, 'p:home', 'loyalty');
    expect(toLoyalty.map((e) => e.id)).toEqual(['loyalty:c:alice->p:home', 'loyalty:c:bob->p:home']);
    const toHome = edgesTo(g, 'p:home');
    expect(toHome.map((e) => e.id)).toEqual(['loyalty:c:alice->p:home', 'loyalty:c:bob->p:home', 'route:c:charlie->p:home']);
  });
  it('propInt accepts safe integers, throws on others', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'n:test', type: 'character', props: { count: 42, frac: 3.5, debt: fx('1000'), flag: true } });
    expect(propInt(getNode(g, 'n:test').props, 'count')).toBe(42);
    expect(() => propInt(getNode(g, 'n:test').props, 'frac')).toThrow();
    expect(() => propInt(getNode(g, 'n:test').props, 'debt')).toThrow();
    expect(() => propInt(getNode(g, 'n:test').props, 'flag')).toThrow();
  });
  it('propBool accepts booleans, throws on others', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'n:test', type: 'character', props: { active: true, count: 42, label: 'yes' } });
    expect(propBool(getNode(g, 'n:test').props, 'active')).toBe(true);
    expect(() => propBool(getNode(g, 'n:test').props, 'count')).toThrow();
    expect(() => propBool(getNode(g, 'n:test').props, 'label')).toThrow();
  });
  it('addEdge duplicate throws', () => {
    const g = base();
    expect(() => addEdge(g, { type: 'loyalty', src: 'char:osric', dst: 'place:alpha', props: { bp: 1 } })).toThrow();
  });
});
