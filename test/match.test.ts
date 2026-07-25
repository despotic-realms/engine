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
});
