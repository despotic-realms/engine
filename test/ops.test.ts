import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { fx, fxToString } from '../src/fx.js';
import { addEdge, addNode, edgeId, findEdge, getNode, propFx, propInt, propStr, removeEdge, setNodeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { applyOp, validateOp } from '../src/ops.js';
import { matchPattern } from '../src/match.js';
import type { GraphPattern } from '../src/match.js';
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
    const g = applyOp(g0, ok({ kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 }), 3, em, 'seat:throne', ['t3.dec']);
    expect(propInt(getNode(g, 'place:thornfield').props, 'taxRateBp')).toBe(1500);
    expect(em.all()[0]?.type).toBe('op.decree_tax');
    expect(em.all()[0]?.parents).toEqual(['t3.dec']);
  });
  it('release_grain moves granary to dole', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'release_grain', placeId: 'place:thornfield', amount: '20' }), 3, em, 'seat:throne');
    expect(propFx(getNode(g, 'place:thornfield').props, 'granary')).toBe(fx('230'));
    expect(propFx(getNode(g, 'place:thornfield').props, 'dole')).toBe(fx('20'));
  });
  it('stockpile_grain buys grain at GRAIN_PRICE', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }), 3, em, 'seat:throne');
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('280')); // 300 - 40*0.5
    expect(propFx(getNode(g, 'place:thornfield').props, 'granary')).toBe(fx('290'));
  });
  it('appoint replaces the office holder', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'appoint', charId: 'char:maud', officeId: 'office:steward' }), 3, em, 'seat:throne');
    expect(findEdge(g, 'appointment', 'char:maud', 'office:steward')).toBeDefined();
    expect(findEdge(g, 'appointment', 'char:osric', 'office:steward')).toBeUndefined();
  });
  it('audit exposes the skimming steward and costs AUDIT_COST', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'audit', officeId: 'office:steward' }), 3, em, 'seat:throne');
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('280')); // 300 - 20
    const interest = findEdge(g, 'interest', 'char:osric', 'inst:crown');
    expect(interest?.props['exposed']).toBe(true);
    const ev = em.all().find((e) => e.type === 'op.audit');
    expect(ev?.data['found']).toBe(true);
  });
  it('grant raises loyalty by 2.5bp per treasury unit', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'grant', charId: 'char:osric', amount: '100' }), 3, em, 'seat:throne');
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('200'));
    expect(findEdge(g, 'loyalty', 'char:osric', 'char:ruler')?.props['bp']).toBe(4450); // 4200 + 250
  });
  it('invest plants a project node carrying its cause event id', () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '80' }), 3, em, 'seat:throne');
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
    const g1 = applyOp(g0, ok({ kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '80' }), 3, em, 'seat:throne');
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
    ['record_stance', { kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' }],
  ];

  it.each(cases)('%s: event.deltas replay to the same graph applyOp produced', (_name, op) => {
    const em = makeEmitter(3);
    const post = applyOp(g0, ok(op), 3, em, 'seat:throne');
    const ev = em.all()[0]!;
    expect(ev.deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(g0, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });

  it("invest stamps the project node's causeEventId with the id emit actually mints", () => {
    const em = makeEmitter(3);
    applyOp(g0, ok({ kind: 'invest', placeId: 'place:thornfield', project: 'roads', amount: '50' }), 3, em, 'seat:throne');
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
    const g = applyOp(g0, r.op, 3, em, 'seat:throne');
    expect(getNode(g, 'char:osric').props['imprisoned']).toBe(true);
    expect(findEdge(g, 'appointment', 'char:osric', 'office:steward')).toBeUndefined();
    expect(findEdge(g, 'grudge', 'char:osric', 'char:ruler')?.props['bp']).toBe(2500);
  });
  it('pardon releases, cools the grudge, warms loyalty', () => {
    let g0 = tier2ish();
    const em0 = makeEmitter(3);
    const r0 = validateOp(g0, { kind: 'imprison', charId: 'char:osric' });
    if (!r0.ok) throw new Error(r0.error);
    g0 = applyOp(g0, r0.op, 3, em0, 'seat:throne');
    const em = makeEmitter(4);
    const r = validateOp(g0, { kind: 'pardon', charId: 'char:osric' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 4, em, 'seat:throne');
    expect(getNode(g, 'char:osric').props['imprisoned']).toBe(false);
    expect(findEdge(g, 'grudge', 'char:osric', 'char:ruler')?.props['bp']).toBe(1000); // 2500 - 1500
    expect(findEdge(g, 'loyalty', 'char:osric', 'char:ruler')?.props['bp']).toBe(4700); // 4200 + 500
  });
  it('raise_levy costs LEVY_RAISE_COST per unit; disband zeroes', () => {
    const g0 = tier2ish();
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'raise_levy', placeId: 'place:thornfield', size: '50' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em, 'seat:throne');
    expect(propFx(getNode(g, 'place:thornfield').props, 'levy')).toBe(fx('50'));
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('260')); // 300 - 50*0.8
  });
  it('send_envoy tones move edges deterministically', () => {
    const g0 = tier2ish(); // maud grudge 6500
    const em = makeEmitter(3);
    const rc = validateOp(g0, { kind: 'send_envoy', charId: 'char:maud', tone: 'conciliatory' });
    if (!rc.ok) throw new Error(rc.error);
    const gc = applyOp(g0, rc.op, 3, em, 'seat:throne');
    expect(findEdge(gc, 'grudge', 'char:maud', 'char:ruler')?.props['bp']).toBe(5700); // 6500 - 800
    const rt = validateOp(g0, { kind: 'send_envoy', charId: 'char:vane', tone: 'threatening' });
    if (!rt.ok) throw new Error(rt.error);
    const gt = applyOp(g0, rt.op, 3, em, 'seat:throne');
    expect(findEdge(gt, 'grudge', 'char:vane', 'char:ruler')?.props['bp']).toBe(600); // created
  });
  it('seize transfers wealth, kindles grudge, costs legitimacy', () => {
    const g0 = tier2ish();
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'seize', charId: 'char:maud', amount: '100' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em, 'seat:throne');
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
    const g = applyOp(g0, r.op, 3, em, 'seat:throne');
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
    return applyOp(g, r.op, 3, em, 'seat:throne');
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
    const post = applyOp(pre, r.op, 3, em, 'seat:throne');
    const ev = em.all()[0]!;
    expect(ev.deltas.length).toBeGreaterThan(0);
    const replayed = applyDeltas(pre, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });
});

// Fast-follow from review: the suites above pin one side of several
// create-vs-update branch pairs (e.g. imprison's grudge kindle only ever
// hit the "no prior edge, create" path; pardon's loyalty warmth only ever
// hit the "prior edge, update" path). These pin the other side of each
// pair, plus the two branches that had no apply-behavior test at all
// ('firm' and disband_levy's actual post-value). Regression pins on
// already-shipped, already-verified behavior -- src is untouched by this
// addition; every value below was hand-traced against src/ops.ts before
// being written, not discovered by a failing run.
describe('tier-2 op pack: both sides of every branch (regression pins)', () => {
  it('imprison updates an existing grudge via clampBp(cur+2500), not a fresh edge', () => {
    const g0 = tier2ish(); // maud already carries a grudge->ruler at 6500
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'imprison', charId: 'char:maud' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em, 'seat:throne');
    expect(findEdge(g, 'grudge', 'char:maud', 'char:ruler')?.props['bp']).toBe(9000); // 6500 + 2500, edge.set
  });
  it('pardon creates a loyalty edge from scratch when none exists (clampBp(5500))', () => {
    let g0 = tier2ish(); // maud has no loyalty edge to ruler at all
    const em0 = makeEmitter(3);
    const r0 = validateOp(g0, { kind: 'imprison', charId: 'char:maud' });
    if (!r0.ok) throw new Error(r0.error);
    g0 = applyOp(g0, r0.op, 3, em0, 'seat:throne');
    const em = makeEmitter(4);
    const r = validateOp(g0, { kind: 'pardon', charId: 'char:maud' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 4, em, 'seat:throne');
    expect(findEdge(g, 'loyalty', 'char:maud', 'char:ruler')?.props['bp']).toBe(5500); // created
    expect(findEdge(g, 'grudge', 'char:maud', 'char:ruler')?.props['bp']).toBe(7500); // 9000 - 1500, bonus check
  });
  it('send_envoy conciliatory with no grudge: warms existing loyalty, or creates it at 5300 if none', () => {
    const g0 = tier2ish();
    const em = makeEmitter(3);
    // osric: no grudge to ruler, but a pre-existing loyalty edge (4200) -> update
    const ro = validateOp(g0, { kind: 'send_envoy', charId: 'char:osric', tone: 'conciliatory' });
    if (!ro.ok) throw new Error(ro.error);
    const go = applyOp(g0, ro.op, 3, em, 'seat:throne');
    expect(findEdge(go, 'loyalty', 'char:osric', 'char:ruler')?.props['bp']).toBe(4500); // 4200 + 300
    // vane: no grudge, no loyalty at all -> created at 5300
    const rv = validateOp(g0, { kind: 'send_envoy', charId: 'char:vane', tone: 'conciliatory' });
    if (!rv.ok) throw new Error(rv.error);
    const gv = applyOp(g0, rv.op, 3, em, 'seat:throne');
    expect(findEdge(gv, 'loyalty', 'char:vane', 'char:ruler')?.props['bp']).toBe(5300);
  });
  it('send_envoy threatening touches both an existing grudge (+600) and an existing loyalty (-300) from one fixture', () => {
    let g0 = tier2ish();
    g0 = addEdge(g0, { type: 'grudge', src: 'char:osric', dst: 'char:ruler', props: { bp: 1000 } }); // osric already has loyalty 4200
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'send_envoy', charId: 'char:osric', tone: 'threatening' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em, 'seat:throne');
    expect(findEdge(g, 'grudge', 'char:osric', 'char:ruler')?.props['bp']).toBe(1600); // 1000 + 600, edge.set
    expect(findEdge(g, 'loyalty', 'char:osric', 'char:ruler')?.props['bp']).toBe(3900); // 4200 - 300
  });
  // Causality §2 (T3): 'firm' used to be a documented zero-delta, byte-
  // identical contract (no state change at all). It no longer is -- every
  // send_envoy tone, firm included, now stamps its own fingerprint
  // (envoy-firm) on the target -- so this pins the NEW contract instead:
  // firm still moves no RELATIONSHIP edge (maud's pre-existing grudge is
  // untouched, no loyalty edge appears), but it is no longer a no-op.
  it("send_envoy 'firm' moves no relationship edge, but now carries exactly its fingerprint stamp (no longer zero-delta)", () => {
    const g0 = tier2ish(); // maud carries a pre-existing grudge edge -- firm must still touch it not at all
    expect(validateOp(g0, { kind: 'send_envoy', charId: 'char:maud', tone: 'firm' }).ok).toBe(true);
    const em = makeEmitter(3);
    const r = validateOp(g0, { kind: 'send_envoy', charId: 'char:maud', tone: 'firm' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em, 'seat:throne');
    const ev = em.all()[0]!;
    expect(ev.deltas).toHaveLength(2); // exactly the fingerprint stamp: recent:envoy-firm + recent:envoy-firm:at
    expect(hashValue(g)).not.toBe(hashValue(g0));
    expect(findEdge(g, 'grudge', 'char:maud', 'char:ruler')?.props['bp']).toBe(6500); // untouched
    expect(findEdge(g, 'loyalty', 'char:maud', 'char:ruler')).toBeUndefined(); // no loyalty edge created
    expect(getNode(g, 'char:maud').props['recent:envoy-firm']).toBe('seat:throne');
    expect(getNode(g, 'char:maud').props['recent:envoy-firm:at']).toBe(3);
  });
  it("disband_levy zeroes the levy prop exactly (fx('0')) after a raise", () => {
    const g0 = tier2ish();
    const em1 = makeEmitter(3);
    const r1 = validateOp(g0, { kind: 'raise_levy', placeId: 'place:thornfield', size: '50' });
    if (!r1.ok) throw new Error(r1.error);
    const g1 = applyOp(g0, r1.op, 3, em1, 'seat:throne');
    const em2 = makeEmitter(4);
    const r2 = validateOp(g1, { kind: 'disband_levy', placeId: 'place:thornfield' });
    if (!r2.ok) throw new Error(r2.error);
    const g2 = applyOp(g1, r2.op, 4, em2, 'seat:throne');
    expect(propFx(getNode(g2, 'place:thornfield').props, 'levy')).toBe(fx('0'));
  });
  it('hold_festival rejects when treasury cannot afford it', () => {
    const g0 = tier2ish(); // treasury 300
    const r = validateOp(g0, { kind: 'hold_festival', placeId: 'place:thornfield', amount: '350' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('treasury cannot afford it');
  });
});

// record_stance (v0.1.1): a drift-immune commitment marker for consistency
// probes. Unlike loyalty/grudge bp gates (which drift ±100/tick from
// socialStep unconditionally) or taxRateBp gates (satisfiable by sibling
// storylets' side effects), a stance is only ever written by this one op,
// so a setter/callback storylet pair gated on it can only be unlocked by
// the setter actually firing -- never by ambient drift or an unrelated op.
describe('record_stance: validate', () => {
  it('accepts both stance values and a hyphenated 40-char id', () => {
    expect(validateOp(g0, { kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' }).ok).toBe(true);
    expect(validateOp(g0, { kind: 'record_stance', stanceId: 'granary-doctrine', value: 'against' }).ok).toBe(true);
    const forty = 'a'.repeat(20) + '-' + 'b'.repeat(19); // 20 + 1 + 19 = 40 chars, hyphenated
    expect(forty.length).toBe(40);
    expect(validateOp(g0, { kind: 'record_stance', stanceId: forty, value: 'for' }).ok).toBe(true);
  });
  it('rejects malformed stance ids', () => {
    expect(validateOp(g0, { kind: 'record_stance', stanceId: '', value: 'for' }).ok).toBe(false); // empty
    expect(validateOp(g0, { kind: 'record_stance', stanceId: 'Granary-Doctrine', value: 'for' }).ok).toBe(false); // uppercase
    expect(validateOp(g0, { kind: 'record_stance', stanceId: 'a'.repeat(41), value: 'for' }).ok).toBe(false); // 41 chars
    expect(validateOp(g0, { kind: 'record_stance', stanceId: 'granary doctrine', value: 'for' }).ok).toBe(false); // space
    expect(validateOp(g0, { kind: 'record_stance', stanceId: '-granary', value: 'for' }).ok).toBe(false); // leading hyphen
  });
  it('rejects a value outside the for/against enum', () => {
    expect(validateOp(g0, { kind: 'record_stance', stanceId: 'granary-doctrine', value: 'maybe' }).ok).toBe(false);
  });
});

describe('record_stance: apply', () => {
  it("sets stance:<id> on the crown and chronicles it", () => {
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' }), 3, em, 'seat:throne');
    expect(propStr(getNode(g, 'inst:crown').props, 'stance:granary-doctrine')).toBe('for');
    expect(em.all()[0]?.type).toBe('op.record_stance');
    expect(em.all()[0]?.data['stanceId']).toBe('granary-doctrine');
  });
  it('re-recording the same stanceId overwrites -- the reversal is the chronicle-visible probe', () => {
    const em1 = makeEmitter(3);
    const g1 = applyOp(g0, ok({ kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' }), 3, em1, 'seat:throne');
    expect(propStr(getNode(g1, 'inst:crown').props, 'stance:granary-doctrine')).toBe('for');
    const em2 = makeEmitter(4);
    const g2 = applyOp(g1, ok({ kind: 'record_stance', stanceId: 'granary-doctrine', value: 'against' }), 4, em2, 'seat:throne');
    expect(propStr(getNode(g2, 'inst:crown').props, 'stance:granary-doctrine')).toBe('against');
  });
});

describe('record_stance: storylet gate mechanism (matchPattern integration)', () => {
  it('a stance-gated pattern matches only after the op records the matching stance', () => {
    const pattern: GraphPattern = {
      nodes: [{ as: 'crown', type: 'institution', where: [{ prop: 'stance:granary-doctrine', cmp: 'eq', value: 'for' }] }],
    };
    expect(matchPattern(g0, pattern)).toEqual([]); // no stance recorded yet
    const em = makeEmitter(3);
    const g = applyOp(g0, ok({ kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' }), 3, em, 'seat:throne');
    expect(matchPattern(g, pattern)).toEqual([{ crown: 'inst:crown' }]);
  });
});
