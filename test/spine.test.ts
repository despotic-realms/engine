import { describe, expect, it } from 'vitest';
import { APT_KEYS, BANDS, TRAIT_KEYS, WANT_KEYS, aptOf, currentWant, hasTrait } from '../src/spine.js';
import { OP_KINDS } from '../src/ops.js';
import { addNode, emptyGraph } from '../src/graph.js';

const g = addNode(emptyGraph(), {
  id: 'char:x', type: 'character',
  props: { name: 'X', 'trait:greedy': true, 'apt:econ': 7600, wantChain: ['coin', 'office'], wantIndex: 1 },
});

describe('spine vocabularies', () => {
  it('closed sets have the spec sizes and order', () => {
    expect(APT_KEYS).toEqual(['apt:econ', 'apt:martial', 'apt:social', 'apt:judge']);
    expect(TRAIT_KEYS).toEqual(['greedy','honest','craven','bold','meticulous','slothful','vengeful','forgiving','ambitious','content','cunning','guileless','cruel','kindly']);
    expect(BANDS).toEqual(['botched', 'poor', 'sound', 'outstanding']);
    expect(WANT_KEYS).toEqual(['holding','office','coin','pardon','marriage','revenge','recognition','safety']);
  });
  it('prop helpers read the graph', () => {
    expect(aptOf(g, 'char:x', 'apt:econ')).toBe(7600);
    expect(aptOf(g, 'char:x', 'apt:judge')).toBe(5000); // absent -> median default
    expect(hasTrait(g, 'char:x', 'greedy')).toBe(true);
    expect(hasTrait(g, 'char:x', 'craven')).toBe(false);
    expect(currentWant(g, 'char:x')).toBe('office'); // wantIndex 1
  });
  it('every op kind carries a domain tag or explicit null', () => {
    for (const [kind, desc] of Object.entries(OP_KINDS)) {
      expect(['econ', 'martial', 'social', null]).toContain((desc as { domain: string | null }).domain);
    }
  });
});
