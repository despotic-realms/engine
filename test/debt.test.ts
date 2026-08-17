// Renderer-law T2 (plan: meta/docs/plans/2026-08-16-renderer-law-plan.md,
// "Debt mechanism" preamble): loans become real. `borrow`/`repay` are new
// closed-vocabulary ops (src/ops.ts) that create/remove a `debt` edge
// (src inst:crown -> dst lender, props { principal, fee, dueTick, settled,
// overdueEmitted }) carrying an obligation on the graph; a new systems pass
// (systems.ts's debtOverdueStep) marks a debt overdue once its dueTick
// passes, deterministically and without penalty -- collection drama is
// content's job (booked scenes gated on the debt edge/fingerprints), never
// the engine's. This file covers the mechanism end to end: op validation,
// op effects, the overdue pass, and composition with T2 attribution --
// including the pre-existing liege tribute `debt` edge (thornfieldGraph,
// props { duePerYear } only) staying untouched throughout despite sharing
// the same edge TYPE as the new mechanism. Deed-stamp mechanics themselves
// (recent:borrowed/recent:repaid -- extending the closed 16-deed vocabulary
// to 18, decay coverage) are pinned in test/fingerprints.test.ts alongside
// the other 16, not duplicated here.
import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { fx } from '../src/fx.js';
import { addEdge, addNode, findEdge, getNode, propFx, setNodeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import { makeFortune } from '../src/fortune.js';
import { OP_KINDS, applyOp, validateOp } from '../src/ops.js';
import type { Storylet } from '../src/storylet.js';
import { debtOverdueStep, economyStep } from '../src/systems.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import { starterSeason } from '../src/decks/starter.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig } from '../src/tick.js';

const SEAT = 'seat:throne';

// thornfieldGraph() + a clean-slate character (no prior loyalty/grudge/debt
// history) and a clean-slate institution -- mirrors ops.test.ts's
// tier2ish()/fingerprints.test.ts's baseGraph(), extended with an
// institution node since a lender may be EITHER node type and
// thornfieldGraph() otherwise carries only one institution (inst:crown,
// the borrower itself -- not a sensible lender fixture).
function debtGraph(): WorldGraph {
  let g = thornfieldGraph();
  g = addNode(g, { id: 'char:vane', type: 'character', props: { name: 'Vane' } });
  g = addNode(g, { id: 'inst:test-bank', type: 'institution', props: { name: 'Test Bank' } });
  return g;
}

const ok = (g: WorldGraph, op: unknown) => {
  const r = validateOp(g, op);
  if (!r.ok) throw new Error(r.error);
  return r.op;
};

/** debtGraph() with char:vane already borrowed against (amount 80, fee 10,
 *  at `tick`, due `dueTicks` ticks later) -- the shared precondition for
 *  the repay and overdue-pass suites below. */
function indebted(dueTicks: number, tick = 3): WorldGraph {
  const g0 = debtGraph();
  return applyOp(g0, ok(g0, { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '10', dueTicks }), tick, makeEmitter(tick), SEAT);
}

describe('OP_KINDS: borrow/repay are registered as econ-domain closed-vocabulary ops', () => {
  it('both carry domain econ', () => {
    expect(OP_KINDS['borrow'].domain).toBe('econ');
    expect(OP_KINDS['repay'].domain).toBe('econ');
  });
});

describe('validateOp: borrow', () => {
  it('accepts a character lender and an institution lender alike', () => {
    const g = debtGraph();
    expect(validateOp(g, { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '10', dueTicks: 5 }).ok).toBe(true);
    expect(validateOp(g, { kind: 'borrow', lenderId: 'inst:test-bank', amount: '80', fee: '10', dueTicks: 5 }).ok).toBe(true);
  });
  it('rejects a lender node that does not exist', () => {
    const r = validateOp(debtGraph(), { kind: 'borrow', lenderId: 'char:nobody', amount: '80', fee: '10', dueTicks: 5 });
    expect(r.ok).toBe(false);
  });
  it('rejects a lender of the wrong node type (a place, here)', () => {
    const r = validateOp(debtGraph(), { kind: 'borrow', lenderId: 'place:thornfield', amount: '80', fee: '10', dueTicks: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('lender must be a character or institution');
  });
  it('rejects amount <= 0', () => {
    expect(validateOp(debtGraph(), { kind: 'borrow', lenderId: 'char:vane', amount: '0', fee: '10', dueTicks: 5 }).ok).toBe(false);
    expect(validateOp(debtGraph(), { kind: 'borrow', lenderId: 'char:vane', amount: '-5', fee: '10', dueTicks: 5 }).ok).toBe(false);
  });
  it('accepts fee == 0 (an interest-free loan) but rejects fee < 0', () => {
    expect(validateOp(debtGraph(), { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '0', dueTicks: 5 }).ok).toBe(true);
    expect(validateOp(debtGraph(), { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '-1', dueTicks: 5 }).ok).toBe(false);
  });
  it('rejects dueTicks < 1', () => {
    expect(validateOp(debtGraph(), { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '10', dueTicks: 0 }).ok).toBe(false);
  });
  it('rejects a second borrow from a lender already carrying an unsettled debt', () => {
    const g1 = indebted(5);
    const r = validateOp(g1, { kind: 'borrow', lenderId: 'char:vane', amount: '20', fee: '2', dueTicks: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('already indebted to that lender');
  });
  // The pre-existing liege tribute `debt` edge (thornfieldGraph, props
  // { duePerYear } only) collides on edgeId() (keyed on type+src+dst alone)
  // with what a borrow-from-the-liege would try to create -- validateOp
  // must catch this as an honest rejection, not let applyOp's addEdge throw
  // a collision error later.
  it('rejects borrowing from char:liege -- a debt edge already exists there, in a different shape', () => {
    const r = validateOp(debtGraph(), { kind: 'borrow', lenderId: 'char:liege', amount: '80', fee: '10', dueTicks: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('already indebted to that lender');
  });
  // Review finding (post-approval, before release): inst:crown is type
  // 'institution', so it passed the character-or-institution check, and no
  // debt edge from the crown to itself exists on a fresh graph, so it
  // passed the existing-debt check too -- a self-loan validated cleanly and
  // was reachable via directive input, inflating treasury with no real
  // counterparty. Mirrors imprison's self-target precedent (ops.ts,
  // 'the crown cannot imprison itself').
  it('rejects lenderId === inst:crown -- the crown cannot borrow from itself', () => {
    const r = validateOp(debtGraph(), { kind: 'borrow', lenderId: 'inst:crown', amount: '80', fee: '10', dueTicks: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('the crown cannot borrow from itself');
  });
});

describe('validateOp: repay', () => {
  it('rejects when no debt edge exists to that lender', () => {
    const r = validateOp(debtGraph(), { kind: 'repay', lenderId: 'char:vane' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no unsettled debt to that lender');
  });
  // Same collision-avoidance concern as borrow's liege test, from the other
  // side: repay must not try to read `principal`/`fee` off an edge that
  // doesn't carry them.
  it('rejects repaying char:liege -- its debt edge is a foreign shape, not ours', () => {
    const r = validateOp(debtGraph(), { kind: 'repay', lenderId: 'char:liege' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no unsettled debt to that lender');
  });
  it('rejects repay when treasury cannot cover principal + fee', () => {
    let g1 = indebted(5); // treasury 380 after borrowing 80
    g1 = setNodeProp(g1, 'inst:crown', 'treasury', fx('50')); // < 90 (principal 80 + fee 10)
    const r = validateOp(g1, { kind: 'repay', lenderId: 'char:vane' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('treasury cannot afford to repay that debt');
  });
  it('accepts repay when treasury covers principal + fee exactly (boundary, not just comfortably above)', () => {
    let g1 = indebted(5);
    g1 = setNodeProp(g1, 'inst:crown', 'treasury', fx('90')); // == 90 exactly
    expect(validateOp(g1, { kind: 'repay', lenderId: 'char:vane' }).ok).toBe(true);
  });
});

describe('applyOp: borrow', () => {
  it('credits treasury by the exact amount and plants a debt edge with the exact shape', () => {
    const g0 = debtGraph();
    const em = makeEmitter(3);
    const g = applyOp(g0, ok(g0, { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '10', dueTicks: 5 }), 3, em, SEAT);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('380')); // 300 + 80
    const edge = findEdge(g, 'debt', 'inst:crown', 'char:vane');
    expect(edge).toBeDefined();
    expect(edge?.props).toEqual({ principal: fx('80'), fee: fx('10'), dueTick: 8, settled: false, overdueEmitted: false }); // dueTick = 3 + 5
  });
  it('stamps recent:borrowed on the lender and chronicles op.borrow with exactly 4 deltas', () => {
    const g0 = debtGraph();
    const em = makeEmitter(3);
    const g = applyOp(g0, ok(g0, { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '10', dueTicks: 5 }), 3, em, SEAT);
    expect(getNode(g, 'char:vane').props['recent:borrowed']).toBe(SEAT);
    expect(getNode(g, 'char:vane').props['recent:borrowed:at']).toBe(3);
    const ev = em.all().find((e) => e.type === 'op.borrow')!;
    expect(ev).toBeDefined();
    expect(ev.data['lenderId']).toBe('char:vane');
    expect(ev.deltas).toHaveLength(4); // treasury credit + edge.add + 2 stamp deltas
  });
  it('lends from an institution just as well as from a character', () => {
    const g0 = debtGraph();
    const em = makeEmitter(3);
    const g = applyOp(g0, ok(g0, { kind: 'borrow', lenderId: 'inst:test-bank', amount: '50', fee: '5', dueTicks: 2 }), 3, em, SEAT);
    expect(findEdge(g, 'debt', 'inst:crown', 'inst:test-bank')).toBeDefined();
    expect(getNode(g, 'inst:test-bank').props['recent:borrowed']).toBe(SEAT);
  });
  it("replay-equivalence: op.borrow's deltas replay to the same graph applyOp produced (D14)", () => {
    const g0 = debtGraph();
    const em = makeEmitter(3);
    const g = applyOp(g0, ok(g0, { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '10', dueTicks: 5 }), 3, em, SEAT);
    const ev = em.all()[0]!;
    const replayed = applyDeltas(g0, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(g));
  });
});

describe('applyOp: repay', () => {
  it('debits treasury by exactly principal + fee and REMOVES the debt edge', () => {
    const g1 = indebted(5); // treasury 380
    const em = makeEmitter(6);
    const g = applyOp(g1, ok(g1, { kind: 'repay', lenderId: 'char:vane' }), 6, em, SEAT);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('290')); // 380 - 90
    expect(findEdge(g, 'debt', 'inst:crown', 'char:vane')).toBeUndefined();
  });
  it('stamps recent:repaid on the lender and chronicles op.repay with exactly 4 deltas', () => {
    const g1 = indebted(5);
    const em = makeEmitter(6);
    const g = applyOp(g1, ok(g1, { kind: 'repay', lenderId: 'char:vane' }), 6, em, SEAT);
    expect(getNode(g, 'char:vane').props['recent:repaid']).toBe(SEAT);
    expect(getNode(g, 'char:vane').props['recent:repaid:at']).toBe(6);
    const ev = em.all().find((e) => e.type === 'op.repay')!;
    expect(ev.deltas).toHaveLength(4); // treasury debit + edge.remove + 2 stamp deltas
  });
  // Review addition (post-approval, before release): edge.remove deltas
  // carry no prop snapshot -- the debt edge's principal/fee are gone from
  // the graph the instant this event lands, so without this the figures
  // are unrecoverable from the chronicle alone. Mirrors op.audit's
  // computed-data precedent (found/skimmed/holder spread alongside {...op}).
  it("chronicles principal, fee, and total as fx strings on op.repay's data (the edge.remove delta itself carries no prop snapshot)", () => {
    const g1 = indebted(5); // borrowed amount '80', fee '10'
    const em = makeEmitter(6);
    applyOp(g1, ok(g1, { kind: 'repay', lenderId: 'char:vane' }), 6, em, SEAT);
    const ev = em.all().find((e) => e.type === 'op.repay')!;
    expect(ev.data['principal']).toBe('80');
    expect(ev.data['fee']).toBe('10');
    expect(ev.data['total']).toBe('90');
  });
  it("replay-equivalence: op.repay's deltas replay to the same graph applyOp produced (D14)", () => {
    const g1 = indebted(5);
    const em = makeEmitter(6);
    const g = applyOp(g1, ok(g1, { kind: 'repay', lenderId: 'char:vane' }), 6, em, SEAT);
    const ev = em.all()[0]!;
    const replayed = applyDeltas(g1, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(g));
  });
  it('a lender can be borrowed from again after their debt is repaid -- the edge is truly gone, no edgeId collision', () => {
    const g1 = indebted(5);
    const g2 = applyOp(g1, ok(g1, { kind: 'repay', lenderId: 'char:vane' }), 6, makeEmitter(6), SEAT);
    expect(validateOp(g2, { kind: 'borrow', lenderId: 'char:vane', amount: '30', fee: '3', dueTicks: 2 }).ok).toBe(true);
    const g3 = applyOp(g2, ok(g2, { kind: 'borrow', lenderId: 'char:vane', amount: '30', fee: '3', dueTicks: 2 }), 7, makeEmitter(7), SEAT);
    expect(findEdge(g3, 'debt', 'inst:crown', 'char:vane')?.props['principal']).toBe(fx('30'));
  });
});

describe('debtOverdueStep', () => {
  it('not yet overdue at tick == dueTick: no event, graph byte-identical', () => {
    const g1 = indebted(2); // borrowed at tick 3, dueTick = 5
    const em = makeEmitter(5);
    const g2 = debtOverdueStep(g1, 5, em);
    expect(em.all()).toHaveLength(0);
    expect(hashValue(g2)).toBe(hashValue(g1));
  });

  it('overdue the tick after dueTick: emits debt.overdue exactly once, sets overdueEmitted, no parents', () => {
    const g1 = indebted(2); // dueTick = 5
    const em = makeEmitter(6);
    const g2 = debtOverdueStep(g1, 6, em);
    const edge = findEdge(g2, 'debt', 'inst:crown', 'char:vane')!;
    expect(edge.props['overdueEmitted']).toBe(true);
    const events = em.all();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('debt.overdue');
    expect(ev.parents).toEqual([]); // systemic pass: never player-descended (T2's ancestry invariant)
    expect(ev.data).toEqual({ lenderId: 'char:vane', principal: '80', fee: '10' });
    expect(ev.deltas).toEqual([{ op: 'edge.set', id: edge.id, key: 'overdueEmitted', value: true }]);
    const replayed = applyDeltas(g1, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(g2));
  });

  it('emission-once: a second pass on an already-overdue debt emits nothing further', () => {
    const g1 = indebted(2);
    const g2 = debtOverdueStep(g1, 6, makeEmitter(6));
    const em2 = makeEmitter(9);
    const g3 = debtOverdueStep(g2, 9, em2);
    expect(em2.all()).toHaveLength(0);
    expect(hashValue(g3)).toBe(hashValue(g2));
  });

  it('never for repaid: a repaid debt (edge removed) never goes overdue, even well past its original dueTick', () => {
    const g1 = indebted(2); // dueTick = 5
    const g2 = applyOp(g1, ok(g1, { kind: 'repay', lenderId: 'char:vane' }), 4, makeEmitter(4), SEAT);
    const em = makeEmitter(9); // well past the original dueTick
    const g3 = debtOverdueStep(g2, 9, em);
    expect(em.all()).toHaveLength(0);
    expect(hashValue(g3)).toBe(hashValue(g2));
  });

  // `settled` never actually reads `true` in production -- repay REMOVES
  // the edge rather than flipping it (applyOp's 'repay' arm) -- so this
  // proves the pass's own shape-guard is defensively correct regardless,
  // not merely "happens to work because production never generates that
  // state."
  it('never for settled: a synthetic settled:true edge is skipped even though nothing in production ever creates one', () => {
    const g = addEdge(debtGraph(), {
      type: 'debt', src: 'inst:crown', dst: 'char:vane',
      props: { principal: fx('80'), fee: fx('10'), dueTick: 2, settled: true, overdueEmitted: false },
    });
    const em = makeEmitter(9);
    const g2 = debtOverdueStep(g, 9, em);
    expect(em.all()).toHaveLength(0);
    expect(hashValue(g2)).toBe(hashValue(g));
  });

  // The pre-existing liege tribute edge (thornfieldGraph, props
  // { duePerYear } only) must survive this pass byte-for-byte, whether or
  // not anything else in the graph is overdue -- proves both "doesn't
  // crash reading dueTick/settled off it" and "doesn't touch it."
  it('the liege tribute edge is untouched by this pass, alongside a genuinely overdue debt in the same graph', () => {
    const g1 = indebted(2); // dueTick = 5; the liege edge is already present via thornfieldGraph()
    const liegeBefore = findEdge(g1, 'debt', 'inst:crown', 'char:liege');
    expect(liegeBefore).toBeDefined();
    const em = makeEmitter(6);
    const g2 = debtOverdueStep(g1, 6, em);
    const liegeAfter = findEdge(g2, 'debt', 'inst:crown', 'char:liege');
    expect(liegeAfter).toEqual(liegeBefore);
    // Exactly one debt.overdue event, for char:vane -- the liege edge never
    // triggers its own (it carries no dueTick/settled to trigger on).
    const events = em.all().filter((e) => e.type === 'debt.overdue');
    expect(events).toHaveLength(1);
    expect((events[0]!.data as { lenderId: string }).lenderId).toBe('char:vane');
  });

  it('order-stable + deterministic: two simultaneously-overdue debts emit in sorted edge-id order, byte-identical across two independent calls', () => {
    const g0 = debtGraph();
    let g = applyOp(g0, ok(g0, { kind: 'borrow', lenderId: 'char:vane', amount: '80', fee: '10', dueTicks: 2 }), 3, makeEmitter(3), SEAT); // dueTick 5
    g = applyOp(g, ok(g, { kind: 'borrow', lenderId: 'inst:test-bank', amount: '40', fee: '4', dueTicks: 2 }), 3, makeEmitter(3), SEAT); // dueTick 5

    const emA = makeEmitter(6);
    const gA = debtOverdueStep(g, 6, emA);
    const emB = makeEmitter(6);
    const gB = debtOverdueStep(g, 6, emB);

    expect(hashValue(gA)).toBe(hashValue(gB));
    expect(emA.all()).toEqual(emB.all());
    const lenders = emA.all().map((e) => (e.data as { lenderId: string }).lenderId);
    // sorted by edge id: 'debt:inst:crown->char:vane' < 'debt:inst:crown->inst:test-bank'
    expect(lenders).toEqual(['char:vane', 'inst:test-bank']);
  });
});

// Regression: economyStep's pre-existing winter tribute loop (systems.ts,
// "5. Liege tribute") reads `edgesFrom(g, 'inst:crown', 'debt')` -- the
// SAME (src, type) selector borrow/repay's debt edges now also match,
// since edgesFrom() has no notion of prop shape. That loop reads
// `duePerYear` unconditionally; a borrow-created edge doesn't carry it, so
// this pins the fix (systems.ts's tribute loop now skips any debt edge
// lacking `duePerYear`) against the exact scenario that used to throw:
// borrow, then let a winter tick land before repaying.
describe("economyStep's tribute loop coexists with an outstanding borrowed debt (regression)", () => {
  it('a winter tick with an unsettled borrow still processes the liege tribute correctly and leaves the borrowed edge untouched', () => {
    const g0 = debtGraph();
    const g1 = applyOp(g0, ok(g0, { kind: 'borrow', lenderId: 'char:vane', amount: '50', fee: '5', dueTicks: 10 }), 1, makeEmitter(1), SEAT);
    const vaneEdgeBefore = findEdge(g1, 'debt', 'inst:crown', 'char:vane');
    expect(vaneEdgeBefore).toBeDefined();

    const em = makeEmitter(3); // tick % 4 === 3 -- winter, the tribute-loop tick
    const g2 = economyStep(g1, 3, makeFortune('economy-debt-coexist'), em); // must not throw

    // The liege tribute still processes normally, for char:liege only.
    const tributeEvents = em.all().filter((e) => e.type === 'tribute.paid' || e.type === 'tribute.defaulted');
    expect(tributeEvents).toHaveLength(1);
    expect((tributeEvents[0]!.data as { to: string }).to).toBe('char:liege');

    // The borrowed debt edge is completely untouched by economyStep.
    expect(findEdge(g2, 'debt', 'inst:crown', 'char:vane')).toEqual(vaneEdgeBefore);
  });
});

// Context note (T2 composition, kept lean per the task brief): a stamp is
// just another node.set delta inside a player-descended op event -- T2's
// attribution reads write-sets off deltas generically, with no
// special-casing for fingerprints or for debt. This proves the composition
// holds for the new mechanism exactly like it does for the 16 existing
// deeds (test/fingerprints.test.ts's own envoy-warm case): a brief gated on
// `recent:borrowed ne ''` becomes newly-eligible the tick a player op
// stamps it, and that op's own event id shows up in becauseOf.
describe('debt mechanism composes with T2 attribution (causality §1, no special-casing)', () => {
  it('a borrow op stamping recent:borrowed makes a recent:borrowed-gated brief newly-eligible next tick, attributed to that op', () => {
    const carrier: Storylet = {
      id: 'debt.carrier', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place' }] },
      title: 'Carrier', body: 'Carrier',
      options: [
        { id: 'borrow', label: 'Borrow from Osric', ops: [{ kind: 'borrow', lenderId: 'char:osric', amount: '20', fee: '2', dueTicks: 3 }] },
        { id: 'skip', label: 'Skip', ops: [] },
      ],
      defaultOptionId: 'skip',
    };
    const reaction: Storylet = {
      id: 'debt.reaction', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
      pattern: { nodes: [{ as: 'c', type: 'character', where: [{ prop: 'recent:borrowed', cmp: 'ne', value: '' }] }] },
      title: 'Reaction', body: 'Reaction',
      options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
      defaultOptionId: 'skip',
    };
    const base = starterSeason();
    const season: SeasonConfig = {
      ...base,
      decks: [{ id: 'starter', tier: 1, storylets: [carrier, reaction] }],
      tiers: { ...base.tiers, 1: { ...base.tiers[1]!, briefBudget: 2 } },
      calendar: [],
    };
    const f = makeFortune('debt-attribution-compose');

    // Tick 1: only the carrier is eligible -- nobody has recent:borrowed yet.
    const out1 = resolveTick(season, initialState(season), { seatId: 'seat:throne', choices: [] }, f);
    expect(out1.packet.briefs.map((b) => b.storyletId)).toEqual(['debt.carrier']);
    const carrierBrief = out1.packet.briefs[0]!;

    // Tick 2: choosing 'borrow' stamps recent:borrowed on char:osric as PART
    // of resolving this tick -- debt.reaction becomes newly-eligible off
    // that very write and must be attributed to the op's own event.
    const out2 = resolveTick(season, out1.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: carrierBrief.briefId, optionId: 'borrow' }],
    }, f);
    expect(out2.packet.briefs.map((b) => b.storyletId)).toContain('debt.reaction');

    const opEvent = out2.events.find((e) => e.type === 'op.borrow')!;
    expect(opEvent).toBeDefined();
    expect(getNode(out2.state.graph, 'char:osric').props['recent:borrowed']).toBe('seat:throne');
    const reactionBrief = out2.packet.briefs.find((b) => b.storyletId === 'debt.reaction')!;
    expect(reactionBrief.becauseOf).toEqual([opEvent.id]);
  });
});
