import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { fx } from '../src/fx.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { edgesTo, findEdge, getNode, propFx, setEdgeProp, setNodeProp } from '../src/graph.js';
import { socialStep } from '../src/systems.js';
import { applyTransition, checkLadder } from '../src/ladder.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import type { TierRule } from '../src/ladder.js';

const INTEREST = 'interest:char:osric->inst:crown';
const LOYALTY_OSRIC = 'loyalty:char:osric->char:ruler';
const GRUDGE_MAUD = 'grudge:char:maud->char:ruler';
const RULES: TierRule[] = [
  {
    from: 1, to: 0, kind: 'demote', note: 'coup',
    when: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'unrest', cmp: 'ge', value: fx('80') }] }] },
  },
  {
    from: 1, to: 2, kind: 'promote', note: 'invitation',
    when: {
      nodes: [{
        as: 'crown', type: 'institution',
        where: [{ prop: 'treasury', cmp: 'ge', value: fx('500') }, { prop: 'legitimacy', cmp: 'ge', value: fx('75') }],
      }],
    },
  },
];

describe('socialStep', () => {
  it('drifts loyalty toward 5000 and decays grudges', () => {
    const em = makeEmitter(1);
    const g = socialStep(thornfieldGraph(), 1, em);
    expect(findEdge(g, 'loyalty', 'char:osric', 'char:ruler')?.props['bp']).toBe(4300); // 4200 + 100
    expect(findEdge(g, 'grudge', 'char:maud', 'char:ruler')?.props['bp']).toBe(6450);  // 6500 - 50
  });
  it('an exposed skimmer kindles a grudge exactly once', () => {
    let g = setEdgeProp(thornfieldGraph(), INTEREST, 'exposed', true);
    const em = makeEmitter(1);
    g = socialStep(g, 1, em);
    expect(findEdge(g, 'grudge', 'char:osric', 'char:ruler')?.props['bp']).toBe(1500);
    expect(em.all().filter((e) => e.type === 'grudge.kindled')).toHaveLength(1);
    const em2 = makeEmitter(2);
    const g2 = socialStep(g, 2, em2);
    expect(em2.all().filter((e) => e.type === 'grudge.kindled')).toHaveLength(0);
    expect(findEdge(g2, 'grudge', 'char:osric', 'char:ruler')?.props['bp']).toBe(1450); // decaying normally
  });
});

describe('ladder', () => {
  it('fires only at year end and only on matching rules', () => {
    const hot = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('85'));
    expect(checkLadder(hot, 1, 2, RULES)).toBeNull();          // not year-end
    expect(checkLadder(hot, 1, 3, RULES)?.note).toBe('coup');  // year-end
    expect(checkLadder(thornfieldGraph(), 1, 3, RULES)).toBeNull();
    expect(checkLadder(hot, 2, 3, RULES)).toBeNull();          // wrong from-tier
  });
  it('promotion rule matches a flourishing crown', () => {
    let g = setNodeProp(thornfieldGraph(), 'inst:crown', 'treasury', fx('600'));
    g = setNodeProp(g, 'inst:crown', 'legitimacy', fx('80'));
    expect(checkLadder(g, 1, 7, RULES)?.kind).toBe('promote');
  });
  it('demotion to exile vacates offices', () => {
    const em = makeEmitter(3);
    const g = applyTransition(thornfieldGraph(), RULES[0]!, 3, em);
    expect(edgesTo(g, 'office:steward', 'appointment')).toHaveLength(0);
    expect(getNode(g, 'inst:crown').props['inExile']).toBe(true);
    expect(em.all()[0]?.type).toBe('tier.changed');
    expect(em.all()[0]?.data['to']).toBe(0);
  });
});

// D14: chronicle events ARE graph deltas, same discipline as ops.ts and
// economyStep -- but socialStep's silent drift/decay/cooling are a
// deliberate exemption (convention lock: continuous background processes
// with no discrete cause to chronicle; replay regenerates them by
// re-running socialStep, not by reading them back from events). The
// kindled-grudge path is the one part of socialStep with a real discrete
// cause, so it alone must be delta-complete. To prove that in isolation,
// this fixture neutralizes every silent path to a true no-op -- loyalty
// already at 5000 (drift has nothing to do), the pre-existing grudge
// already at 0 (decay floors at 0, so it's already floored), unrest
// already at 0 (fed, so cooling clamps 0 to 0) -- leaving the exposed,
// unbumped skimmer as the ONLY thing socialStep actually changes. If
// grudge.kindled's own deltas, replayed onto the pre-step graph, hash
// identically to socialStep's actual return value, the event is proven
// delta-complete rather than merely "close enough".
describe('socialStep delta-equivalence (spec D14)', () => {
  it('a lone kindled grudge: concatenated event deltas replay to the same graph', () => {
    let g0 = setEdgeProp(thornfieldGraph(), LOYALTY_OSRIC, 'bp', 5000);
    g0 = setEdgeProp(g0, GRUDGE_MAUD, 'bp', 0);
    g0 = setNodeProp(g0, 'place:thornfield', 'unrest', fx('0'));
    g0 = setEdgeProp(g0, INTEREST, 'exposed', true);

    const em = makeEmitter(1);
    const post = socialStep(g0, 1, em);

    const events = em.all();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('grudge.kindled');

    const deltas = events.flatMap((e) => e.deltas);
    expect(deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });
});

// applyTransition routes every mutation through applyDeltas unconditionally
// (there's no silent-drift exemption for tier transitions), so full
// equivalence holds on every branch -- asserted here on the demote-to-exile
// case, which is the one with the most to get wrong (N appointment
// edge.removes plus the inExile node.set, all bundled into one event).
describe('applyTransition delta-equivalence (spec D14)', () => {
  it('demote-to-exile: concatenated event deltas replay to the same graph', () => {
    const g0 = thornfieldGraph();
    const em = makeEmitter(3);
    const post = applyTransition(g0, RULES[0]!, 3, em);
    const deltas = em.all().flatMap((e) => e.deltas);
    expect(deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });
});

describe('TierRule.effects (graft on transition)', () => {
  it('applies effect deltas on the tier.changed event, skipping already-present adds', () => {
    const rule: TierRule = {
      from: 1, to: 2, kind: 'promote', note: 'invitation',
      when: { nodes: [{ as: 'crown', type: 'institution' }] },
      effects: [
        { op: 'node.add', node: { id: 'place:newmarch', type: 'place', props: { name: 'Newmarch' } } },
        { op: 'node.add', node: { id: 'char:osric', type: 'character', props: { name: 'DUPLICATE' } } }, // exists — skipped
        { op: 'node.set', id: 'inst:crown', key: 'legitimacy', value: fx('60') },
      ],
    };
    const em = makeEmitter(3);
    const g = applyTransition(thornfieldGraph(), rule, 3, em);
    expect(getNode(g, 'place:newmarch').props['name']).toBe('Newmarch');
    expect(getNode(g, 'char:osric').props['name']).toBe('Osric'); // untouched
    expect(propFx(getNode(g, 'inst:crown').props, 'legitimacy')).toBe(fx('60'));
    const ev = em.all().find((e) => e.type === 'tier.changed');
    expect(ev?.deltas.some((d) => d.op === 'node.add' && d.node.id === 'place:newmarch')).toBe(true);
    expect(ev?.deltas.some((d) => d.op === 'node.add' && d.node.id === 'char:osric')).toBe(false); // filtered from the event too
  });

  // Fast-follow from review: the test above only exercises effects on a
  // 'promote' rule, which never runs the demote-to-0 vacate branch --
  // leaving the compose-after-demote path (vacate/inExile deltas, then
  // effects appended) unpinned. src is untouched here: applyTransition's
  // effects loop already runs unconditionally after the demote-to-0 `if`,
  // regardless of which branch fired -- confirmed by reading src/ladder.ts,
  // not discovered by a failing run.
  it('composes after a demote-to-0 vacate: vacate/inExile deltas and the graft node.add all land on one tier.changed event, in append order', () => {
    const rule: TierRule = {
      from: 1, to: 0, kind: 'demote', note: 'coup',
      when: { nodes: [{ as: 'crown', type: 'institution' }] },
      effects: [
        { op: 'node.add', node: { id: 'place:exile-camp', type: 'place', props: { name: 'Exile Camp' } } },
      ],
    };
    const em = makeEmitter(3);
    const g = applyTransition(thornfieldGraph(), rule, 3, em);
    expect(edgesTo(g, 'office:steward', 'appointment')).toHaveLength(0);
    expect(getNode(g, 'inst:crown').props['inExile']).toBe(true);
    expect(getNode(g, 'place:exile-camp').props['name']).toBe('Exile Camp');
    const events = em.all();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('tier.changed');
    const removeIdx = ev.deltas.findIndex((d) => d.op === 'edge.remove');
    const inExileIdx = ev.deltas.findIndex((d) => d.op === 'node.set' && d.id === 'inst:crown' && d.key === 'inExile');
    const graftIdx = ev.deltas.findIndex((d) => d.op === 'node.add' && d.node.id === 'place:exile-camp');
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(inExileIdx).toBeGreaterThan(removeIdx);
    expect(graftIdx).toBeGreaterThan(inExileIdx); // effects compose AFTER the demote-vacate logic, observable in delta order
  });
});
