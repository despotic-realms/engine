import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { fx } from '../src/fx.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { addEdge, addNode, edgesTo, findEdge, getNode, propFx, setEdgeProp, setNodeProp } from '../src/graph.js';
import { socialStep } from '../src/systems.js';
import { applyTransition, checkLadder } from '../src/ladder.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import type { TierRule } from '../src/ladder.js';
import type { WorldGraph } from '../src/graph.js';

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

// v0.5.1 fix (reviewer-reproduced defect, Critical): the demote-to-0 branch
// above used to vacate EVERY appointment edge in the graph, with no regard
// for who holds it or whether the crown was even falling at all. Two proven
// consequences, both fixed by this same scoping:
//  (a) a SELF-transition (rule.from === rule.to === 0 -- content's real
//      shape for a routed march, e.g. despotic-realms/content's
//      `{ from: 0, to: 0, kind: 'demote', note: 'routed' }`, reached only
//      via a decisive flashpoint's `demoteOnRoutTo: 0`) still matched
//      `rule.kind === 'demote' && rule.to === 0`, even though the crown's
//      tier never changes on a self-transition -- nothing was actually
//      "falling." A failed attempt to unseat a rival stripped the RIVAL'S
//      OWN office anyway. In content, the claim campaign's own opposition
//      weight for the next attempt reads that exact appointment edge's
//      existence (worlds/tier0.ts's CLAIM_FLASHPOINTS: `{ edgeType:
//      'appointment', src: 'char:usurper', dst: 'office:high-seat' }`), so
//      the WORST outcome (rout) silently made the rival look weaker on the
//      retry (opposition 0) instead of unchanged (opposition 700) --
//      inverted difficulty.
//  (b) even on a genuine fall (1->0, 2->0), the loop removed EVERY
//      appointment edge indiscriminately -- including a rival's own
//      appointment to their own office, never granted by the falling ruler
//      and never the falling ruler's to lose. Once removed, content cannot
//      repair it after the fact: the effects loop just below drops any
//      edge.add whose id already exists in g0 -- exactly the id this
//      branch just orphaned -- so a content-authored graft meant to
//      re-seat the rival is silently dropped, not applied, regardless of
//      ordering.
//
// INVESTIGATION FINDING (this task, both rows below prove it directly): (b)
// is not hypothetical. despotic-realms/content's real worlds seat a rival
// in their own office via a genesis or first-fall appointment edge
// (src/worlds/tier0.ts's base(): `char:usurper -> office:high-seat`) that
// SURVIVES every promotion (the vacate branch only ever fires on
// rule.kind==='demote', so no promote rule -- including "the return",
// 0->1 -- ever touches it). Once that edge is sitting in a live graph, ANY
// subsequent real demotion to tier 0 vacates it exactly like any other
// appointment, with no special-casing at all -- proven below by
// constructing that exact shape (a rival already holding their own office
// alongside the crown's own court) and running a real 1->0/2->0 transition
// against it, unmodified from how the pre-fix code actually behaved. This
// was live ever since content first seated a rival this way, not a
// self-transition-only bug.
//
// FIX: the vacate loop now skips any appointment edge whose HOLDER is
// `rivalId` (SeasonConfig.rivalId, tick.ts -- threaded through from
// resolveTick's ladder step exactly like advanceCharacterArcs already
// receives the same field), and the whole branch is scoped to
// `rule.from !== rule.to` so a self-transition can never enter it. This is
// the smallest discriminator the graph actually offers: an appointment
// edge carries no record of WHO or WHAT granted it (only `since`), so "is
// this the falling ruler's own court" cannot be read off the edge
// directly -- but "is this character the season's designated rival" is
// already a first-class (if optional) fact SeasonConfig carries for
// exactly this kind of external-actor scoping.
//
// DOCUMENTED LIMIT: this protects exactly one named character. A season
// that never sets rivalId gets the pre-fix behavior for whatever office an
// unnamed rival might hold (despotic-realms/content's src/slice0.ts
// already sets `rivalId: 'char:usurper'`; any other season config that
// seats a rival in an office and wants this protection must set it too --
// a content-side follow-up, not this engine's). A cast with several
// independent external power-holders would need a different mechanism;
// this fix covers exactly the one-rival shape every real season config
// authors today. See the last test below, which pins this limit
// deliberately rather than leaving it merely implied.
describe('applyTransition: exile vacate is scoped, not blanket (v0.5.1)', () => {
  // Mirrors despotic-realms/content's real shape closely enough to
  // reproduce the defect precisely (src/worlds/tier0.ts's base(): a rival
  // character permanently appointed to their own office, alongside the
  // crown's own court, e.g. thornfieldGraph()'s office:steward <-
  // char:osric) -- without importing content itself, which the engine must
  // never depend on.
  function graphWithRival(): WorldGraph {
    let g: WorldGraph = thornfieldGraph();
    g = addNode(g, { id: 'char:usurper', type: 'character', props: { name: 'the Usurper' } });
    g = addNode(g, { id: 'office:high-seat', type: 'office', props: { title: 'the High Seat' } });
    g = addEdge(g, { type: 'appointment', src: 'char:usurper', dst: 'office:high-seat', props: { since: 0 } });
    return g;
  }
  const ROUTED: TierRule = { from: 0, to: 0, kind: 'demote', note: 'routed' }; // content's real self-transition shape
  const COUP_1_TO_0: TierRule = { from: 1, to: 0, kind: 'demote', note: 'coup' };
  const COUP_2_TO_0: TierRule = { from: 2, to: 0, kind: 'demote', note: 'coup' };

  it('(i) a tier-0 -> tier-0 self-transition vacates NOTHING -- no court is lost in a failed march', () => {
    const em = makeEmitter(3);
    const g = applyTransition(graphWithRival(), ROUTED, 3, em, 'char:usurper');
    expect(edgesTo(g, 'office:steward', 'appointment')).toHaveLength(1); // the crown's own court: untouched
    expect(edgesTo(g, 'office:high-seat', 'appointment')).toHaveLength(1); // the rival's seat: untouched
    expect(getNode(g, 'inst:crown').props['inExile']).toBeUndefined(); // no redundant re-flag -- this was never a real fall
    expect(em.all()[0]?.deltas).toEqual([]); // zero deltas: truly nothing happened
  });

  it("(ii) a real demotion (1->0) still vacates the RULER'S OWN court -- unchanged design intent, regression guard", () => {
    const em = makeEmitter(3);
    const g = applyTransition(graphWithRival(), COUP_1_TO_0, 3, em, 'char:usurper');
    expect(edgesTo(g, 'office:steward', 'appointment')).toHaveLength(0); // Osric's stewardship: vacated, as designed
    expect(getNode(g, 'inst:crown').props['inExile']).toBe(true);
  });

  it("(iii) the rival's own appointment survives a real demotion (1->0) when rivalId names them -- this is the fix", () => {
    const em = makeEmitter(3);
    const g = applyTransition(graphWithRival(), COUP_1_TO_0, 3, em, 'char:usurper');
    expect(edgesTo(g, 'office:high-seat', 'appointment')).toHaveLength(1);
    expect(findEdge(g, 'appointment', 'char:usurper', 'office:high-seat')).toBeDefined();
  });

  it("(iii cont.) the rival's appointment survives every demote-to-0 shape, including a harsher 2->0 coup", () => {
    const em = makeEmitter(3);
    const g = applyTransition(graphWithRival(), COUP_2_TO_0, 3, em, 'char:usurper');
    expect(edgesTo(g, 'office:high-seat', 'appointment')).toHaveLength(1);
  });

  it('D14: a rival-scoped demote-to-exile still replays byte-identically from its own event deltas', () => {
    const g0 = graphWithRival();
    const em = makeEmitter(3);
    const post = applyTransition(g0, COUP_1_TO_0, 3, em, 'char:usurper');
    const deltas = em.all().flatMap((e) => e.deltas);
    expect(deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });

  // INVESTIGATION FINDING, pinned directly: with NO rivalId configured --
  // the exact shape of every OTHER season fixture in this engine today
  // (this file's own RULES, starterSeason()) -- an ordinary real demotion
  // vacates a rival-held office exactly as it always did. This is the
  // fix's documented limit, not a new defect, and it is also the direct
  // proof for this task's investigation question: the vacate-everything
  // behavior was never self-transition-only -- it hits an ordinary 1->0
  // fall identically, for exactly as long as content has been seating a
  // rival in an office already present in the graph at that moment.
  it('documented limit: with no rivalId configured, a real demotion still vacates a rival-held office exactly as before', () => {
    const em = makeEmitter(3);
    const g = applyTransition(graphWithRival(), COUP_1_TO_0, 3, em); // rivalId omitted
    expect(edgesTo(g, 'office:high-seat', 'appointment')).toHaveLength(0);
  });
});
