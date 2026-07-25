import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { addNode } from '../src/graph.js';
import { matchPattern } from '../src/match.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';

const g = thornfieldGraph();

describe('matchPattern', () => {
  it('matches a node pattern with an Fx predicate', () => {
    const m = matchPattern(g, {
      nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'gt', value: fx('100') }] }],
    });
    expect(m).toEqual([{ p: 'place:thornfield' }]);
  });
  it('matches node+edge patterns (the grudge-holder shape)', () => {
    const m = matchPattern(g, {
      nodes: [{ as: 'noble', type: 'character' }],
      edges: [{ type: 'grudge', from: 'noble', to: '#char:ruler', where: [{ prop: 'bp', cmp: 'gt', value: 6000 }] }],
    });
    expect(m).toEqual([{ noble: 'char:maud' }]);
  });
  it('supports literal endpoints and returns [] when nothing matches', () => {
    expect(matchPattern(g, {
      nodes: [{ as: 'c', type: 'character' }],
      edges: [{ type: 'interest', from: 'c', to: '#inst:crown', where: [{ prop: 'exposed', cmp: 'eq', value: true }] }],
    })).toEqual([]);
  });
  it('bindings are injective and deterministically ordered', () => {
    let g2 = addNode(g, { id: 'char:aldric', type: 'character', props: { name: 'Aldric' } });
    const m = matchPattern(g2, {
      nodes: [{ as: 'a', type: 'character' }, { as: 'b', type: 'character' }],
    });
    // 5 characters → 5*4 ordered injective pairs, sorted by (a, b)
    expect(m).toHaveLength(20);
    expect(m[0]).toEqual({ a: 'char:aldric', b: 'char:liege' });
    expect(m.every((b) => b['a'] !== b['b'])).toBe(true);
  });
  it('type-mismatched predicates are false, not errors', () => {
    expect(matchPattern(g, {
      nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'gt', value: 'oops' }] }],
    })).toEqual([]);
  });
  it('comparator matrix: all six operators on numeric props', () => {
    // granary is fx('180'); test boundaries and inclusive/exclusive semantics
    const equal = fx('180');
    const below = fx('100');
    const above = fx('200');
    expect(matchPattern(g, { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'eq', value: equal }] }] })).toHaveLength(1); // granary == 180
    expect(matchPattern(g, { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'ne', value: equal }] }] })).toHaveLength(0); // granary != 180
    expect(matchPattern(g, { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'lt', value: equal }] }] })).toHaveLength(0); // granary < 180
    expect(matchPattern(g, { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'le', value: equal }] }] })).toHaveLength(1); // granary <= 180
    expect(matchPattern(g, { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'gt', value: equal }] }] })).toHaveLength(0); // granary > 180
    expect(matchPattern(g, { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'ge', value: equal }] }] })).toHaveLength(1); // granary >= 180
    expect(matchPattern(g, { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'lt', value: above }] }] })).toHaveLength(1); // granary < 200
    expect(matchPattern(g, { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'gt', value: below }] }] })).toHaveLength(1); // granary > 100
  });
  it('string predicates work with eq/ne', () => {
    // name is 'Osric'; test string equality
    expect(matchPattern(g, { nodes: [{ as: 'c', type: 'character', where: [{ prop: 'name', cmp: 'eq', value: 'Osric' }] }] })).toHaveLength(1);
    expect(matchPattern(g, { nodes: [{ as: 'c', type: 'character', where: [{ prop: 'name', cmp: 'ne', value: 'Osric' }] }] })).toHaveLength(3); // 4 chars - 1 = 3
  });
  it('edge-predicate rejection: edge exists but where-clause fails', () => {
    // maud has grudge to ruler with bp=6500; filter for bp > 9000 → edge exists but predicate fails
    const m = matchPattern(g, {
      nodes: [{ as: 'noble', type: 'character' }],
      edges: [{ type: 'grudge', from: 'noble', to: '#char:ruler', where: [{ prop: 'bp', cmp: 'gt', value: 9000 }] }],
    });
    expect(m).toEqual([]);
  });
});
