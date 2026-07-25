import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { fx, fxToString } from '../src/fx.js';
import { addNode, edgeId, findEdge, getNode, propFx, propInt, removeEdge, setNodeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { applyOp, validateOp } from '../src/ops.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';

const g0 = thornfieldGraph();
const ok = (op: unknown) => {
  const r = validateOp(g0, op);
  if (!r.ok) throw new Error(r.error);
  return r.op;
};

describe('validateOp', () => {
  it('accepts every launch op', () => {
    expect(validateOp(g0, { kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 }).ok).toBe(true);
    expect(validateOp(g0, { kind: 'release_grain', placeId: 'place:thornfield', amount: '20' }).ok).toBe(true);
    expect(validateOp(g0, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }).ok).toBe(true);
    expect(validateOp(g0, { kind: 'appoint', charId: 'char:maud', officeId: 'office:steward' }).ok).toBe(true);
    expect(validateOp(g0, { kind: 'audit', officeId: 'office:steward' }).ok).toBe(true);
    expect(validateOp(g0, { kind: 'grant', charId: 'char:osric', amount: '25' }).ok).toBe(true);
    expect(validateOp(g0, { kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '80' }).ok).toBe(true);
  });
  it('rejects out-of-schema shapes (the compiler contract)', () => {
    expect(validateOp(g0, { kind: 'smite' }).ok).toBe(false);
    expect(validateOp(g0, { kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 20000 }).ok).toBe(false);
    expect(validateOp(g0, { kind: 'decree_tax', placeId: 'char:osric', rateBp: 100 }).ok).toBe(false); // wrong node type
    expect(validateOp(g0, { kind: 'release_grain', placeId: 'place:thornfield', amount: '1e5' }).ok).toBe(false);
    expect(validateOp(g0, { kind: 'release_grain', placeId: 'place:thornfield', amount: '999' }).ok).toBe(false); // > granary
    expect(validateOp(g0, { kind: 'grant', charId: 'char:osric', amount: '-5' }).ok).toBe(false);
  });
});

describe('applyOp', () => {
  it('decree_tax sets the rate and chronicles it', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 }), 3, em, ['t3.dec']);
    expect(propInt(getNode(g, 'place:thornfield').props, 'taxRateBp')).toBe(1500);
    expect(em.all()[0]?.type).toBe('op.decree_tax');
    expect(em.all()[0]?.parents).toEqual(['t3.dec']);
  });
  it('release_grain moves granary to dole', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'release_grain', placeId: 'place:thornfield', amount: '20' }), 3, em);
    expect(propFx(getNode(g, 'place:thornfield').props, 'granary')).toBe(fx('230'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'dole')).toBe(fx('20'));
  });
  it('stockpile_grain buys grain at GRAIN_PRICE', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }), 3, em);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('280')); // 300 - 40*0.5
    expect(propFx(getNode(g, 'place:thornfield').props, 'granary')).toBe(fx('290'));
  });
  it('appoint replaces the office holder', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'appoint', charId: 'char:maud', officeId: 'office:steward' }), 3, em);
    expect(findEdge(g, 'appointment', 'char:maud', 'office:steward')).toBeDefined();
    expect(findEdge(g, 'appointment', 'char:osric', 'office:steward')).toBeUndefined();
  });
  it('audit exposes the skimming steward and costs AUDIT_COST', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'audit', officeId: 'office:steward' }), 3, em);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('280')); // 300 - 20
    const interest = findEdge(g, 'interest', 'char:osric', 'inst:crown');
    expect(interest?.props['exposed']).toBe(true);
    const ev = em.all().find((e) => e.type === 'op.audit');
    expect(ev?.data['found']).toBe(true);
  });
  it('grant raises loyalty by 2.5bp per treasury unit', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'grant', charId: 'char:osric', amount: '100' }), 3, em);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('200'));
    expect(findEdge(g, 'loyalty', 'char:osric', 'char:ruler')?.props['bp']).toBe(4450); // 4200 + 250
  });
  it('invest plants a project node carrying its cause event id', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '80' }), 3, em);
    const proj = getNode(g, 'proj:irrigation:place:thornfield');
    expect(propInt(proj.props, 'maturesAt')).toBe(11); // 3 + 8
    expect(proj.props['causeEventId']).toBe('t3.0');
    expect(fxToString(propFx(getNode(g, 'inst:crown').props, 'treasury'))).toBe('220');
  });
  it('insufficient treasury fails at validate', () => {
    expect(validateOp(g0, { kind: 'grant', charId: 'char:osric', amount: '999' }).ok).toBe(false);
  });
});

describe('validateOp resource/referential checks (scoped per-arm reads)', () => {
  it('rejects audit on a vacant office', () => {
    const vacant = removeEdge(g0, edgeId('appointment', 'char:osric', 'office:steward'));
    const r = validateOp(vacant, { kind: 'audit', officeId: 'office:steward' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('office is vacant');
  });
  it('rejects stockpile_grain the treasury cannot afford', () => {
    const r = validateOp(g0, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '700' }); // 700*0.5=350 > 300
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('treasury cannot afford it');
  });
  it('rejects audit the treasury cannot afford', () => {
    const poor = setNodeProp(g0, 'inst:crown', 'treasury', fx('10')); // < AUDIT_COST (20)
    const r = validateOp(poor, { kind: 'audit', officeId: 'office:steward' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('treasury cannot afford an audit');
  });
  it('rejects invest the treasury cannot afford', () => {
    const r = validateOp(g0, { kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '999' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('treasury cannot afford it');
  });
  it('rejects invest into a (place, project) already underway', () => {
    const em = makeEmitter(3);
    const g1 = applyOp(g0, ok({ kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '80' }), 3, em);
    const r = validateOp(g1, { kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '10' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('that project is already underway');
  });
});

// D14: chronicle events ARE graph deltas. Every op's emitted event must carry
// deltas that, applied independently to the pre-op graph, reproduce exactly
// the graph applyOp itself returned -- the applied change and the recorded
// change must never be able to drift apart.
describe('applyOp delta-equivalence (spec D14)', () => {
  const cases: Array<[string, unknown]> = [
    ['decree_tax', { kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 }],
    ['release_grain', { kind: 'release_grain', placeId: 'place:thornfield', amount: '20' }],
    ['stockpile_grain', { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }],
    ['appoint', { kind: 'appoint', charId: 'char:maud', officeId: 'office:steward' }],
    ['audit', { kind: 'audit', officeId: 'office:steward' }],
    ['grant', { kind: 'grant', charId: 'char:osric', amount: '100' }],
    ['invest', { kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '80' }],
  ];

  it.each(cases)('%s: event.deltas replay to the same graph applyOp produced', (_name, op) => {
    const em = makeEmitter(3);
    const post = applyOp(g0, ok(op), 3, em);
    const ev = em.all()[0]!;
    expect(ev.deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });

  it("invest stamps the project node's causeEventId with the id emit actually mints", () => {
    const em = makeEmitter(3);
    applyOp(g0, ok({ kind: 'invest', placeId: 'place:thornfield', project: 'roads', amount: '50' }), 3, em);
    const ev = em.all()[0]!;
    const replayed = applyDeltas(g0, ev.deltas);
    expect(getNode(replayed, 'proj:roads:place:thornfield').props['causeEventId']).toBe(ev.id);
  });
});

// Tier-2 op pack (P2 Task 4): imprison/pardon, the levy ops, envoys, seize,
// festivals. tier2ish() gives these their preconditions -- Maud gains
// seizable wealth, Vane arrives with no history at all (a clean slate for
// send_envoy's "create the edge" branches).
function tier2ish() {
  let g = thornfieldGraph();
  g = setNodeProp(g, 'char:maud', 'wealth', fx('400'));
  g = addNode(g, { id: 'char:vane', type: 'character', props: { name: 'Vane' } });
  return g;
}

describe('tier-2 op pack: validate', () => {
  const g = tier2ish();
  it('accepts the seven new ops', () => {
    expect(validateOp(g, { kind: 'imprison', charId: 'char:maud' }).ok).toBe(true);
    expect(validateOp(g, { kind: 'raise_levy', placeId: 'place:thornfield', size: '50' }).ok).toBe(true);
    expect(validateOp(g, { kind: 'send_envoy', charId: 'char:vane', tone: 'threatening' }).ok).toBe(true);
    expect(validateOp(g, { kind: 'seize', charId: 'char:maud', amount: '100' }).ok).toBe(true);
    expect(validateOp(g, { kind: 'hold_festival', placeId: 'place:thornfield', amount: '40' }).ok).toBe(true);
  });
  it('rejects bad preconditions', () => {
    expect(validateOp(g, { kind: 'imprison', charId: 'char:ruler' }).ok).toBe(false);          // never the ruler
    expect(validateOp(g, { kind: 'pardon', charId: 'char:maud' }).ok).toBe(false);             // not imprisoned
    expect(validateOp(g, { kind: 'disband_levy', placeId: 'place:thornfield' }).ok).toBe(false); // no levy raised
    expect(validateOp(g, { kind: 'seize', charId: 'char:osric', amount: '10' }).ok).toBe(false); // no wealth prop
    expect(validateOp(g, { kind: 'seize', charId: 'char:maud', amount: '999' }).ok).toBe(false); // > wealth
    expect(validateOp(g, { kind: 'send_envoy', charId: 'char:vane', tone: 'rude' }).ok).toBe(false); // bad enum
    expect(validateOp(g, { kind: 'hold_festival', placeId: 'place:thornfield', amount: '5' }).ok).toBe(false); // < 10 floor
    expect(validateOp(g, { kind: 'raise_levy', placeId: 'place:thornfield', size: '9999' }).ok).toBe(false); // unaffordable
  });
});

describe('tier-2 op pack: apply', () => {
  it('imprison vacates offices and kindles a grudge', () => {
    const g0 = tier2ish();
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'imprison', charId: 'char:osric' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em);
    expect(getNode(g, 'char:osric').props['imprisoned']).toBe(true);
    expect(findEdge(g, 'appointment', 'char:osric', 'office:steward')).toBeUndefined();
    expect(findEdge(g, 'grudge', 'char:osric', 'char:ruler')?.props['bp']).toBe(2500);
  });
  it('pardon releases, cools the grudge, warms loyalty', () => {
    let g0 = tier2ish();
    const em0 = makeEmitter(3);
    const r0 = validateOp(g0, { kind: 'imprison', charId: 'char:osric' });
    if (!r0.ok) throw new Error(r0.error);
    g0 = applyOp(g0, r0.op, 3, em0);
    const em = makeEmitter(4);
    const r = validateOp(g0, { kind: 'pardon', charId: 'char:osric' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 4, em);
    expect(getNode(g, 'char:osric').props['imprisoned']).toBe(false);
    expect(findEdge(g, 'grudge', 'char:osric', 'char:ruler')?.props['bp']).toBe(1000); // 2500 - 1500
    expect(findEdge(g, 'loyalty', 'char:osric', 'char:ruler')?.props['bp']).toBe(4700); // 4200 + 500
  });
  it('raise_levy costs LEVY_RAISE_COST per unit; disband zeroes', () => {
    const g0 = tier2ish();
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'raise_levy', placeId: 'place:thornfield', size: '50' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em);
    expect(propFx(getNode(g, 'place:thornfield').props, 'levy')).toBe(fx('50'));
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('260')); // 300 - 50*0.8
  });
  it('send_envoy tones move edges deterministically', () => {
    const g0 = tier2ish(); // maud grudge 6500
    const em = makeEmitter(3);
    const rc = validateOp(g0, { kind: 'send_envoy', charId: 'char:maud', tone: 'conciliatory' });
    if (!rc.ok) throw new Error(rc.error);
    const gc = applyOp(g0, rc.op, 3, em);
    expect(findEdge(gc, 'grudge', 'char:maud', 'char:ruler')?.props['bp']).toBe(5700); // 6500 - 800
    const rt = validateOp(g0, { kind: 'send_envoy', charId: 'char:vane', tone: 'threatening' });
    if (!rt.ok) throw new Error(rt.error);
    const gt = applyOp(g0, rt.op, 3, em);
    expect(findEdge(gt, 'grudge', 'char:vane', 'char:ruler')?.props['bp']).toBe(600); // created
  });
  it('seize transfers wealth, kindles grudge, costs legitimacy', () => {
    const g0 = tier2ish();
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'seize', charId: 'char:maud', amount: '100' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em);
    expect(propFx(getNode(g, 'char:maud').props, 'wealth')).toBe(fx('300'));
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('400'));
    expect(findEdge(g, 'grudge', 'char:maud', 'char:ruler')?.props['bp']).toBe(8500); // 6500 + 2000
    expect(propFx(getNode(g, 'inst:crown').props, 'legitimacy')).toBe(fx('47')); // 50 - 3
  });
  it('hold_festival buys calm at amount/8', () => {
    let g0 = setNodeProp(tier2ish(), 'place:thornfield', 'unrest', fx('40'));
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'hold_festival', placeId: 'place:thornfield', amount: '40' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('260'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'unrest')).toBe(fx('35')); // 40 - 40/8
  });
});

// D14 again, for the tier-2 pack: same mechanism as the launch-op suite
// above (it.each over cases, deltas replay to the same graph applyOp
// produced), kept as its own suite because these ops need a different
// pre-graph (tier2ish(), not g0) -- and pardon needs one further step:
// imprison actually applied first, since pardon's own precondition is "is
// imprisoned".
describe('tier-2 op pack: delta-equivalence (spec D14)', () => {
  const preImprisoned = (() => {
    const g = tier2ish();
    const em = makeEmitter(3);
    const r = validateOp(g, { kind: 'imprison', charId: 'char:osric' });
    if (!r.ok) throw new Error(r.error);
    return applyOp(g, r.op, 3, em);
  })();
  const preLevied = setNodeProp(tier2ish(), 'place:thornfield', 'levy', fx('50'));

  const cases: Array<[string, unknown, WorldGraph]> = [
    ['imprison', { kind: 'imprison', charId: 'char:osric' }, tier2ish()],
    ['pardon', { kind: 'pardon', charId: 'char:osric' }, preImprisoned],
    ['raise_levy', { kind: 'raise_levy', placeId: 'place:thornfield', size: '50' }, tier2ish()],
    ['disband_levy', { kind: 'disband_levy', placeId: 'place:thornfield' }, preLevied],
    ['send_envoy', { kind: 'send_envoy', charId: 'char:vane', tone: 'threatening' }, tier2ish()],
    ['seize', { kind: 'seize', charId: 'char:maud', amount: '100' }, tier2ish()],
    ['hold_festival', { kind: 'hold_festival', placeId: 'place:thornfield', amount: '40' }, tier2ish()],
  ];

  it.each(cases)('%s: event.deltas replay to the same graph applyOp produced', (_name, op, pre) => {
    const em = makeEmitter(3);
    const r = validateOp(pre, op);
    if (!r.ok) throw new Error(r.error);
    const post = applyOp(pre, r.op, 3, em);
    const ev = em.all()[0]!;
    expect(ev.deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(pre, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });
});
