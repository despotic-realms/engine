import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { fx, fxToString } from '../src/fx.js';
import { edgeId, findEdge, getNode, propFx, propInt, removeEdge, setNodeProp } from '../src/graph.js';
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
    expect(propFx(getNode(g, 'place:thornfield').props, 'granary')).toBe(fx('160'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'dole')).toBe(fx('20'));
  });
  it('stockpile_grain buys grain at GRAIN_PRICE', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }), 3, em);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('280')); // 300 - 40*0.5
    expect(propFx(getNode(g, 'place:thornfield').props, 'granary')).toBe(fx('220'));
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
