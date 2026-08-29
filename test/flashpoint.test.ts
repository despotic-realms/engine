// The claim plan (meta/docs/plans/2026-08-20-claim-plan.md), Task 3:
// press_claim, the contested flashpoint roll. visibleScale = declared
// backing bp + true asset Terms; trueScale = visibleScale minus false-stone
// bp; opposition = true opposition Terms; ratio r (per-mille) selects one of
// four band rows; one fortune draw within that row picks rout/setback/
// costly/triumph; onBand ops apply (validated); rout/setback with a false
// stone unmasks the largest (edge-id tiebreak): backing removed, grudge
// +2000, claim.betrayed. Decisive bands stamp claimPromoteTo/claimDemoteTo
// (plain tier numbers) inside claim.flashpoint's own deltas -- Task 5's
// concern is consuming/clearing them, this task's is only setting them.
//
// Mirrors test/claim.test.ts's fixture style (explicit values built at each
// call site, small local helpers rather than one heavy builder).
import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { fx } from '../src/fx.js';
import { makeFortune } from '../src/fortune.js';
import { addEdge, addNode, emptyGraph, findEdge, getNode, propFx } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import type { TierRule } from '../src/ladder.js';
import { DECLARE_LOYALTY, WAVERER_FLOOR } from '../src/loyalty.js';
import { applyOp, DEEDS, OP_KINDS, TREACHERY_BP, validateOp } from '../src/ops.js';
import type { FlashpointDef, Op, Term } from '../src/ops.js';
import { CLAIM_NUDGE_TICKS, claimNudgeDecayStep, declarationStep } from '../src/systems.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig } from '../src/tick.js';

/** Minimal claim fixture: inst:crown (rulerCharId char:ruler) + the ruler
 *  node alone -- callers add backers (and any loyalty/grudge edges,
 *  content-fact props) per scenario. `crownExtra` seeds boolean facts on
 *  inst:crown itself, the target every Term fixture below points at. */
function crownGraph(crownExtra: Record<string, boolean> = {}): WorldGraph {
  let g = emptyGraph();
  g = addNode(g, {
    id: 'inst:crown', type: 'institution',
    props: { treasury: fx('300'), legitimacy: fx('0'), arrears: fx('0'), rulerCharId: 'char:ruler', ...crownExtra },
  });
  g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'Ruler' } });
  return g;
}

/** Adds one declared backer: a `backing` edge (src charId -> dst inst:crown,
 *  props exactly per Global Constraints) plus whatever true-state the
 *  false-stone check reads -- a loyalty edge (omitted entirely to exercise
 *  the no-edge-reads-as-0 seam), a grudge edge, and/or cunning/vengeful
 *  traits. Hand-built throughout (like claim.test.ts's own backing
 *  fixtures) -- declarationStep (Task 1) is not under test here.
 *  `imprisoned` (review fix, momentum asymmetry pin): mirrors withCircle's
 *  own option -- a declared backer can be imprisoned AFTER declaring
 *  (imprisonment never retracts a standing declaration), unlike a waverer
 *  who is excluded from momentum entirely while imprisoned. */
function withBacker(
  g: WorldGraph,
  charId: string,
  bp: number,
  opts: { loyalty?: number; grudge?: boolean; cunning?: boolean; vengeful?: boolean; imprisoned?: boolean } = {},
): WorldGraph {
  const props: Record<string, boolean | string> = { name: charId };
  if (opts.cunning) props['trait:cunning'] = true;
  if (opts.vengeful) props['trait:vengeful'] = true;
  if (opts.imprisoned) props['imprisoned'] = true;
  g = addNode(g, { id: charId, type: 'character', props });
  g = addEdge(g, { type: 'backing', src: charId, dst: 'inst:crown', props: { declaredAt: 0, bp, viaPromise: '' } });
  if (opts.loyalty !== undefined) g = addEdge(g, { type: 'loyalty', src: charId, dst: 'char:ruler', props: { bp: opts.loyalty } });
  if (opts.grudge) g = addEdge(g, { type: 'grudge', src: charId, dst: 'char:ruler', props: { bp: 1000 } });
  return g;
}

/** Task 4 (momentum): adds one claim-circle character with NO backing edge
 *  -- a momentum candidate, never a declared backer (contrast with
 *  withBacker above). Sated by default (wantChain/wantIndex, T1's own
 *  "price already answered" fixture idiom) so every momentum test below
 *  isolates to the loyalty axis alone; claimBp is present only because the
 *  circle AND-definition requires it (never itself read by momentum). */
function withCircle(
  g: WorldGraph,
  charId: string,
  opts: { loyalty?: number; imprisoned?: boolean; claimBp?: number } = {},
): WorldGraph {
  const props: Record<string, boolean | number | string | string[]> = {
    name: charId, claimCircle: true, claimBp: opts.claimBp ?? 1000,
    wantChain: ['coin'], wantIndex: 1,
  };
  if (opts.imprisoned) props['imprisoned'] = true;
  g = addNode(g, { id: charId, type: 'character', props });
  if (opts.loyalty !== undefined) g = addEdge(g, { type: 'loyalty', src: charId, dst: 'char:ruler', props: { bp: opts.loyalty } });
  return g;
}

const EMPTY_ON_BAND: FlashpointDef['onBand'] = { rout: [], setback: [], costly: [], triumph: [] };

// A deliberately overwhelming opposition Term (bp 1,000,000): with any
// backing sum this suite actually uses (a few thousand at most), trueScale *
// 1000 / 1,000,000 always floors well under 600 -- the "else" band row --
// regardless of the exact backing math in a given test. Paired with
// crownGraph({ alwaysTrue: true }) so its predicate holds.
const HUGE_OPPOSITION_BP = 1_000_000;
function elseRowOpposition(): Term[] {
  return [{ label: 'Overwhelming Force', bp: HUGE_OPPOSITION_BP, when: { nodeId: 'inst:crown', prop: 'alwaysTrue', cmp: 'eq', value: true } }];
}

// Reusable fortune pins: fortune.int is a pure function of exactly
// (masterSeed, stream, tick, key) (D21 -- no sequential RNG state), so the
// SAME (seed, flashpointId, tick) triple draws the SAME roll no matter what
// graph/def a test passes it -- only the test's own r (via its backing/
// opposition choice) decides which ROW that roll is read against. Each pin
// is tied to a row family (else: r<600; r1500: r>=1500), not a specific r
// value -- callers just have to keep their own fixture's r in that family.
// Rolls found by brute-force search over small ticks for descriptively-
// named seeds (T1-causality precedent: see test/consecutive.test.ts,
// test/recency.test.ts for the same technique) -- exact search method,
// row-cumulative arithmetic, and independent verification are in this
// file's task-3 report.
const ELSE_ROUT = { seed: 'flashpoint-betrayal-rout', flashpointId: 'fp-betrayal-rout', tick: 0 }; // roll 262 -> rout (else row: rout [0,450))
const ELSE_SETBACK = { seed: 'flashpoint-no-false-stone-setback', flashpointId: 'fp-no-false-stone-setback', tick: 3 }; // roll 501 -> setback (else row: setback [450,800))
const ELSE_COSTLY = { seed: 'flashpoint-decisive-costly', flashpointId: 'fp-decisive-costly', tick: 4 }; // roll 872 -> costly (else row: costly [800,980))
const R1500_TRIUMPH = { seed: 'flashpoint-betrayal-triumph', flashpointId: 'fp-betrayal-triumph', tick: 2 }; // roll 825 -> triumph (r>=1500 row: triumph [700,1000))

// `tierRules`/`tier` (v0.5.3 review fix, C1): optional, default to `[]`/
// `-1` -- applyOp's own defaults -- so every pin above and every call site
// below that never sets them is byte-for-byte unaffected: this whole
// file's concern (Task 3) is which prop a given band sets, not whether a
// season's own ladder rules authorize it (that is farm-exploit.test.ts's
// concern). The one describe block that DOES care (the decisive-outcomes
// block below) sets both explicitly, because after the C1 fix a bare
// `decisive` field is no longer sufficient by itself to stamp anything --
// a real matching TierRule must be present, exactly as every production
// call site (tick.ts, mediate.ts) always supplies one.
interface Pin { seed: string; flashpointId: string; tick: number; tierRules?: TierRule[]; tier?: number }

/** Resolves press_claim for `def` under a fixed pin, returning the landed
 *  graph, the full event log, and the claim.flashpoint event itself. */
function pressClaim(g: WorldGraph, def: FlashpointDef, pin: Pin, parents: string[] = []) {
  const em = makeEmitter(pin.tick);
  const fortune = makeFortune(pin.seed);
  const g2 = applyOp(
    g, { kind: 'press_claim', flashpointId: pin.flashpointId }, pin.tick, em, 'seat:throne', parents,
    { [pin.flashpointId]: def }, fortune, pin.tierRules ?? [], pin.tier ?? -1,
  );
  const flashpointEvent = em.all().find((e) => e.type === 'claim.flashpoint')!;
  return { g2, em, flashpointEvent };
}

describe('OP_KINDS: press_claim is registered as a null-domain closed-vocabulary op', () => {
  it('domain null (direct throne speech, its own banding), one flashpointId param', () => {
    expect(OP_KINDS['press_claim'].domain).toBe(null);
    expect(OP_KINDS['press_claim'].params).toEqual([{ name: 'flashpointId', type: 'flashpointId' }]);
  });
  it('excluded from DEEDS -- no fingerprint stamp (claim.flashpoint/claim.betrayed are already richer gateable facts)', () => {
    expect(Object.prototype.hasOwnProperty.call(DEEDS, 'press_claim')).toBe(false);
  });
});

describe('validateOp: press_claim (flashpointId existence against the season flashpoints table)', () => {
  const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
  it('accepts a flashpointId present in the table passed in', () => {
    // crownGraph(), not emptyGraph(): validateOp's shared referential-checks
    // switch reads treasury off inst:crown unconditionally before dispatching
    // on op kind (every op kind's own case runs after that shared read), so
    // ANY op kind needs a real inst:crown node present, not just ones whose
    // own validation touches treasury.
    expect(validateOp(crownGraph(), { kind: 'press_claim', flashpointId: 'fp-known' }, { 'fp-known': def }).ok).toBe(true);
  });
  it('rejects a flashpointId absent from the table passed in', () => {
    const r = validateOp(crownGraph(), { kind: 'press_claim', flashpointId: 'fp-unknown' }, { 'fp-known': def });
    expect(r.ok).toBe(false);
  });
  it('rejects when no flashpoints table is passed at all (the {} default)', () => {
    const r = validateOp(crownGraph(), { kind: 'press_claim', flashpointId: 'fp-known' });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (a) scale arithmetic: visible vs true with one false stone, opposition
// Terms, exact ints in event data.
// ---------------------------------------------------------------------------
describe('press_claim: (a) scale arithmetic', () => {
  it('visibleScale/trueScale/opposition are exact plain ints; a false stone is subtracted from trueScale only; untrue Terms contribute zero', () => {
    let g = crownGraph({ safeConduct: true, usurperAlert: true }); // reinforcementsArrived/foreignLevyArrived left UNSET -> their Terms read false
    g = withBacker(g, 'char:brann', 3000, { loyalty: 6000 }); // real: loyal, no grudge/traits
    g = withBacker(g, 'char:mair', 2000, { loyalty: 2000, cunning: true }); // false stone: <TREACHERY_BP and cunning

    const def: FlashpointDef = {
      assets: [
        { label: 'Safe Conduct', bp: 500, when: { nodeId: 'inst:crown', prop: 'safeConduct', cmp: 'eq', value: true } }, // true -> counts
        { label: 'Reinforcements', bp: 9999, when: { nodeId: 'inst:crown', prop: 'reinforcementsArrived', cmp: 'eq', value: true } }, // never set -> false, must NOT count
      ],
      opposition: [
        { label: 'Usurper Garrison', bp: 800, when: { nodeId: 'inst:crown', prop: 'usurperAlert', cmp: 'eq', value: true } }, // true -> counts
        { label: 'Foreign Levy', bp: 9999, when: { nodeId: 'inst:crown', prop: 'foreignLevyArrived', cmp: 'eq', value: true } }, // never set -> false
      ],
      onBand: EMPTY_ON_BAND,
    };

    const em = makeEmitter(5);
    const fortune = makeFortune('flashpoint-scale-arithmetic');
    const g2 = applyOp(g, { kind: 'press_claim', flashpointId: 'fp-a' }, 5, em, 'seat:throne', ['fake-decision-id'], { 'fp-a': def }, fortune);
    const ev = em.all().find((e) => e.type === 'claim.flashpoint')!;

    // backingSum 3000+2000=5000; falseStoneBp 2000 (Mair only); assetSum 500
    // (Reinforcements' 9999 excluded); visibleScale 5500; trueScale
    // 5500-2000=3500; opposition 800 (Foreign Levy's 9999 excluded).
    const data = ev.data as { flashpointId: string; band: string; visibleScale: number; trueScale: number; opposition: number };
    expect(data.flashpointId).toBe('fp-a');
    expect(data.visibleScale).toBe(5500);
    expect(data.trueScale).toBe(3500);
    expect(data.opposition).toBe(800);
    expect(typeof data.visibleScale).toBe('number'); // plain int, not Fx/bigint
    expect(typeof data.trueScale).toBe('number');
    expect(typeof data.opposition).toBe('number');
    expect(['rout', 'setback', 'costly', 'triumph']).toContain(data.band);
    expect(ev.parents).toEqual(['fake-decision-id']); // parents: the decision chain like any op

    // Neither backing edge is disturbed by the arithmetic pass itself
    // (betrayal, if any, is a SEPARATE later step -- this test only pins
    // the scale computation).
    expect(findEdge(g2, 'backing', 'char:brann', 'inst:crown')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (b) band bucket table pinned at each boundary: r = 1500/1000/600/599.
// One sole backer supplies trueScale directly (no false stones, no
// assets); a single opposition Term of bp 1000 makes r == backingBp exactly
// (r = floor(backingBp*1000/1000) = backingBp). Seeds/ticks brute-forced
// (T1-causality precedent) so the drawn roll falls in a window that
// DISTINGUISHES the correct row from the adjacent row an off-by-one `>` vs
// `>=` bug would select instead -- see this file's task-3 report for the
// exact window math and the search script.
// ---------------------------------------------------------------------------
describe('press_claim: (b) band bucket table pinned at each boundary', () => {
  function soleBackerGraph(backingBp: number): { g: WorldGraph; def: FlashpointDef } {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:sole', backingBp, { loyalty: 6000 });
    const def: FlashpointDef = {
      assets: [],
      opposition: [{ label: 'Opposition', bp: 1000, when: { nodeId: 'inst:crown', prop: 'alwaysTrue', cmp: 'eq', value: true } }],
      onBand: EMPTY_ON_BAND,
    };
    return { g, def };
  }

  it('r=1500 exactly uses the r>=1500 row (roll 77 -> setback there, rout under the r>=1000 row -- distinguishing)', () => {
    const { g, def } = soleBackerGraph(1500);
    const { flashpointEvent } = pressClaim(g, def, { seed: 'flashpoint-boundary-1500', flashpointId: 'the-march', tick: 32 });
    expect((flashpointEvent.data as { band: string }).band).toBe('setback');
  });

  it('r=1000 exactly uses the r>=1000 row (roll 222 -> setback there, rout under the r>=600 row -- distinguishing)', () => {
    const { g, def } = soleBackerGraph(1000);
    const { flashpointEvent } = pressClaim(g, def, { seed: 'flashpoint-boundary-1000', flashpointId: 'the-march', tick: 3 });
    expect((flashpointEvent.data as { band: string }).band).toBe('setback');
  });

  it('r=600 exactly uses the r>=600 row (roll 425 -> setback there, rout under the else row -- distinguishing)', () => {
    const { g, def } = soleBackerGraph(600);
    const { flashpointEvent } = pressClaim(g, def, { seed: 'flashpoint-boundary-600', flashpointId: 'the-march', tick: 3 });
    expect((flashpointEvent.data as { band: string }).band).toBe('setback');
  });

  it('r=599 (just under 600) falls to the else row (roll 444 -> rout there, setback under the r>=600 row -- distinguishing)', () => {
    const { g, def } = soleBackerGraph(599);
    const { flashpointEvent } = pressClaim(g, def, { seed: 'flashpoint-boundary-599', flashpointId: 'the-march', tick: 9 });
    expect((flashpointEvent.data as { band: string }).band).toBe('rout');
  });
});

// ---------------------------------------------------------------------------
// (c) onBand ops: applied and validated; a rejecting op yields op.rejected
// (skipped, not aborting the rest), others land.
// ---------------------------------------------------------------------------
describe('press_claim: (c) onBand ops applied and validated', () => {
  it('a landing op applies its full effect; a rejecting op yields op.rejected via "onBand", parented to claim.flashpoint', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:sole', 100, { loyalty: 6000 });
    g = addNode(g, { id: 'char:vane', type: 'character', props: { name: 'Vane' } });
    const bandOps: Op[] = [
      { kind: 'grant', charId: 'char:vane', amount: '10' }, // lands: treasury 300 affords it
      { kind: 'imprison', charId: 'char:ruler' }, // always rejected: "the crown cannot imprison itself"
    ];
    const def: FlashpointDef = {
      assets: [], opposition: [], // opposition [] -> whatever band lands, ALL four bands share bandOps below
      onBand: { rout: bandOps, setback: bandOps, costly: bandOps, triumph: bandOps },
    };
    const { g2, em, flashpointEvent } = pressClaim(g, def, { seed: 'flashpoint-onband-test', flashpointId: 'fp-onband', tick: 5 });

    const grantEv = em.all().find((e) => e.type === 'op.grant');
    expect(grantEv).toBeDefined();
    expect(grantEv?.parents).toEqual([flashpointEvent.id]);
    expect(propFx(getNode(g2, 'inst:crown').props, 'treasury')).toBe(fx('290')); // 300 - 10, landed

    const rejectedEv = em.all().find((e) => e.type === 'op.rejected');
    expect(rejectedEv).toBeDefined();
    expect(rejectedEv?.parents).toEqual([flashpointEvent.id]);
    expect(rejectedEv?.data).toMatchObject({ opKind: 'imprison', via: 'onBand' });
    expect(getNode(g2, 'char:ruler').props['imprisoned']).toBeUndefined(); // the rejected op never touched the graph
  });
});

// ---------------------------------------------------------------------------
// (d) betrayal: rout with false stones unmasks the LARGEST (edge-id
// tiebreak), grudge +2000, backing removed, event parented to the
// flashpoint event; triumph leaves false stones hidden.
// ---------------------------------------------------------------------------
describe('press_claim: (d) betrayal', () => {
  it('rout with two false stones of unequal bp unmasks the LARGEST only: backing removed, grudge kindled +2000 (log cause = claim.betrayed itself), the smaller false stone untouched', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:mair', 2000, { loyalty: 1000, cunning: true }); // false stone, larger
    g = withBacker(g, 'char:tam', 500, { loyalty: 1000, vengeful: true }); // false stone, smaller
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, em, flashpointEvent } = pressClaim(g, def, ELSE_ROUT);
    expect((flashpointEvent.data as { band: string }).band).toBe('rout');

    const betrayedEv = em.all().find((e) => e.type === 'claim.betrayed');
    expect(betrayedEv).toBeDefined();
    expect(betrayedEv?.data).toEqual({ charId: 'char:mair' });
    expect(betrayedEv?.parents).toEqual([flashpointEvent.id]);

    expect(findEdge(g2, 'backing', 'char:mair', 'inst:crown')).toBeUndefined(); // unmasked
    expect(findEdge(g2, 'backing', 'char:tam', 'inst:crown')).toBeDefined(); // the smaller false stone survives

    const grudge = findEdge(g2, 'grudge', 'char:mair', 'char:ruler');
    expect(grudge?.props['bp']).toBe(2000);
    expect(grudge?.props['log']).toEqual([{ tick: ELSE_ROUT.tick, deltaBp: 2000, cause: betrayedEv!.id }]);
    expect(betrayedEv?.deltas).toContainEqual({ op: 'edge.remove', id: findEdge(g, 'backing', 'char:mair', 'inst:crown')!.id });
  });

  it('rout with two false stones TIED on bp: the tiebreak picks the smaller edge id (char:aaron before char:zeke)', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:aaron', 1500, { loyalty: 1000, cunning: true });
    g = withBacker(g, 'char:zeke', 1500, { loyalty: 1000, vengeful: true });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, em } = pressClaim(g, def, ELSE_ROUT);

    const betrayedEv = em.all().find((e) => e.type === 'claim.betrayed');
    expect(betrayedEv?.data).toEqual({ charId: 'char:aaron' });
    expect(findEdge(g2, 'backing', 'char:aaron', 'inst:crown')).toBeUndefined();
    expect(findEdge(g2, 'backing', 'char:zeke', 'inst:crown')).toBeDefined();
  });

  it('triumph leaves false stones hidden entirely: no claim.betrayed, backing edge untouched', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:brann', 10000, { loyalty: 6000 }); // real, loyal, keeps trueScale large despite the false stone below
    g = withBacker(g, 'char:mair', 2000, { loyalty: 1000, cunning: true }); // false stone -- must stay hidden
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND }; // opposition [] -> oppositionSafe 1 -> r huge -> r>=1500 row
    const { g2, em, flashpointEvent } = pressClaim(g, def, R1500_TRIUMPH);
    expect((flashpointEvent.data as { band: string }).band).toBe('triumph');

    expect(em.all().find((e) => e.type === 'claim.betrayed')).toBeUndefined();
    expect(findEdge(g2, 'backing', 'char:mair', 'inst:crown')).toBeDefined();
    expect(findEdge(g2, 'grudge', 'char:mair', 'char:ruler')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (e) no false stones -> no betrayal on any band (rout and setback both
// checked -- the only two bands betrayal ever considers).
// ---------------------------------------------------------------------------
describe('press_claim: (e) no false stones -> no betrayal, on any band that would otherwise check', () => {
  it('rout, zero false stones: no claim.betrayed', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:loyal', 2500, { loyalty: 6000 }); // loyal, no grudge/traits -- never a false stone
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, em, flashpointEvent } = pressClaim(g, def, ELSE_ROUT);
    expect((flashpointEvent.data as { band: string }).band).toBe('rout');
    expect(em.all().find((e) => e.type === 'claim.betrayed')).toBeUndefined();
    expect(findEdge(g2, 'backing', 'char:loyal', 'inst:crown')).toBeDefined();
  });

  it('setback, zero false stones: no claim.betrayed', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:loyal', 2500, { loyalty: 6000 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, em, flashpointEvent } = pressClaim(g, def, ELSE_SETBACK);
    expect((flashpointEvent.data as { band: string }).band).toBe('setback');
    expect(em.all().find((e) => e.type === 'claim.betrayed')).toBeUndefined();
    expect(findEdge(g2, 'backing', 'char:loyal', 'inst:crown')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// False stone determination (controller-pinned seam #3): TREACHERY_BP
// boundary, grudge-edge-alone qualifies (no trait needed), and the
// no-loyalty-edge reading -- an ABSENT loyalty edge reads as 0 (always
// clears the "< TREACHERY_BP" leg), never the neutral-5000 default
// mediate.ts's willingnessOf-adjacent loyaltyBp() uses elsewhere.
// ---------------------------------------------------------------------------
describe('press_claim: false stone determination', () => {
  it('TREACHERY_BP is exactly 3500 (exported for cross-reference)', () => {
    expect(TREACHERY_BP).toBe(3500);
  });

  it('loyalty 3000 + a grudge edge (no trait at all) qualifies as a false stone -- grudge alone satisfies the second AND-leg', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:grudger', 800, { loyalty: 3000, grudge: true });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { em } = pressClaim(g, def, ELSE_ROUT);
    expect((em.all().find((e) => e.type === 'claim.betrayed')?.data)).toEqual({ charId: 'char:grudger' });
  });

  it('loyalty exactly 3500 (the boundary, NOT below) + a grudge edge: NOT a false stone -- the first leg is strict (<), so no betrayal', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:atboundary', 800, { loyalty: 3500, grudge: true });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { em } = pressClaim(g, def, ELSE_ROUT);
    expect(em.all().find((e) => e.type === 'claim.betrayed')).toBeUndefined();
  });

  it('loyalty 3499 (one bp under the boundary) + a grudge edge: IS a false stone', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:justunder', 800, { loyalty: 3499, grudge: true });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { em } = pressClaim(g, def, ELSE_ROUT);
    expect(em.all().find((e) => e.type === 'claim.betrayed')?.data).toEqual({ charId: 'char:justunder' });
  });

  it('NO loyalty edge at all + a grudge edge: IS a false stone (a gone edge reads as 0, always clearing "< TREACHERY_BP")', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:noedge', 800, { grudge: true }); // no `loyalty` option passed at all
    expect(findEdge(g, 'loyalty', 'char:noedge', 'char:ruler')).toBeUndefined(); // confirms the fixture really has no edge
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { em } = pressClaim(g, def, ELSE_ROUT);
    expect(em.all().find((e) => e.type === 'claim.betrayed')?.data).toEqual({ charId: 'char:noedge' });
  });

  it('NO loyalty edge at all, but NO grudge/cunning/vengeful either: NOT a false stone -- the second leg still gates it', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:noedgeclean', 800); // no loyalty, no grudge, no traits
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { em } = pressClaim(g, def, ELSE_ROUT);
    expect(em.all().find((e) => e.type === 'claim.betrayed')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Review follow-up (post-approval, additive): a negative-bp asset Term
// combined with 100%-false backing can drive trueScaleRaw negative before
// the `trueScale = trueScaleRaw > 0 ? trueScaleRaw : 0` floor applies.
// Reviewer's own probe verified this floors correctly, resolves a valid
// band with no crash, and betrayal still fires off the pre-resolution
// snapshot -- this pins that exact shape as a regression test. Honest
// GREEN-from-start: the floor was already correct and untouched by this
// addition (see this file's task-3 report appendix for the mutation check
// confirming the assertion is non-vacuous).
// ---------------------------------------------------------------------------
describe('press_claim: negative trueScale floors at 0 (reviewer-verified probe, additive regression)', () => {
  it('a negative-bp asset Term (true) + 100%-false backing drives trueScaleRaw negative; trueScale floors at 0, a valid band resolves with no throw, and betrayal still fires', () => {
    let g = crownGraph({ alwaysTrue: true });
    // The ENTIRE backing is this one false stone: bp 2000, loyalty 1000
    // (<TREACHERY_BP), cunning -- so falseStoneBp == backingSum exactly.
    g = withBacker(g, 'char:mair', 2000, { loyalty: 1000, cunning: true });
    const def: FlashpointDef = {
      // True (alwaysTrue holds) and negative: assetSum = -500.
      assets: [{ label: 'Poisoned Well', bp: -500, when: { nodeId: 'inst:crown', prop: 'alwaysTrue', cmp: 'eq', value: true } }],
      opposition: elseRowOpposition(),
      onBand: EMPTY_ON_BAND,
    };
    // visibleScale = 2000 + (-500) = 1500; falseStoneBp = 2000 (100% of
    // backing); trueScaleRaw = 1500 - 2000 = -500 -- negative before the
    // floor. r = flashpointRatio(0, opposition) = 0 regardless of
    // opposition's value once trueScale floors to 0, so this still falls in
    // the "else" row (minR 0) -- reuses ELSE_ROUT (row-family-scoped, not
    // r-value-scoped: r=0 satisfies the SAME r<600 condition every other
    // ELSE_ROUT reuse in this file relies on), landing its already-verified
    // 'rout' outcome.
    const { g2, em, flashpointEvent } = pressClaim(g, def, ELSE_ROUT);

    const data = flashpointEvent.data as { band: string; trueScale: number };
    expect(data.trueScale).toBe(0); // floored, not -500
    expect(['rout', 'setback', 'costly', 'triumph']).toContain(data.band); // a valid band resolved -- bandRowFor(0) did not throw
    expect(data.band).toBe('rout'); // this pin's own known, already-verified outcome

    const betrayedEv = em.all().find((e) => e.type === 'claim.betrayed');
    expect(betrayedEv?.data).toEqual({ charId: 'char:mair' }); // betrayal still fires off the pre-resolution snapshot
    expect(findEdge(g2, 'backing', 'char:mair', 'inst:crown')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Controller-pinned seam #1: decisive outcomes. triumph/costly with
// decisive.promoteTo stamp claimPromoteTo; rout with demoteOnRoutTo stamps
// claimDemoteTo; setback touches NEITHER, even when both fields are
// authored on the SAME FlashpointDef.
// ---------------------------------------------------------------------------
describe('press_claim: decisive outcomes stamp crown props (claimPromoteTo/claimDemoteTo), never on non-qualifying bands', () => {
  const decisive = { promoteTo: 2, demoteOnRoutTo: 0 }; // 0 is a real tier value -- exercises "!== undefined", not truthiness

  // v0.5.3 review fix (C1): applyOp's decisive-stamp step now requires a
  // REAL matching TierRule for the press's own current tier before it will
  // write claimPromoteTo/claimDemoteTo at all -- a bare `decisive` field on
  // a FlashpointDef stopped being sufficient by itself the moment this fix
  // landed (see ops.ts's own comment on this step for the full "why": a
  // stamp written with no real authorization behind it is exactly the
  // shape the whole-wave final review's C1 finding reproduced live). This
  // block predates that concept entirely (Task 3, before any ladder
  // wiring existed) and never threaded a tier context through pressClaim,
  // so its three stamp-asserting tests below were unknowingly pinning the
  // pre-fix fail-OPEN default (stamp regardless of authorization) rather
  // than their own actual concern (does band X set the right prop). They
  // are updated here to supply the same kind of real, satisfied season
  // context every production call site (tick.ts, mediate.ts) always
  // provides -- neither rule below carries a claimRequire, so once matched
  // they authorize unconditionally, isolating this block's original
  // concern (which prop, on which band) from farm-exploit.test.ts's
  // separate claimRequire-gating concern. The fourth test in this block
  // (setback) is untouched: a setback band never even attempts either
  // stamp, with or without a tier context, so it has nothing to update.
  const DECISIVE_TEST_RULES: TierRule[] = [
    { from: 0, to: 2, kind: 'promote', note: 'test fixture: matches this block\'s decisive.promoteTo' },
    { from: 0, to: 0, kind: 'demote', note: 'test fixture: matches this block\'s decisive.demoteOnRoutTo' },
  ];
  const DECISIVE_TIER = 0;

  it('triumph: claimPromoteTo lands, claimDemoteTo does not', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:sole', 800, { loyalty: 6000 });
    const def: FlashpointDef = { assets: [], opposition: [], decisive, onBand: EMPTY_ON_BAND };
    const { g2, flashpointEvent } = pressClaim(g, def, { ...R1500_TRIUMPH, tierRules: DECISIVE_TEST_RULES, tier: DECISIVE_TIER });
    expect((flashpointEvent.data as { band: string }).band).toBe('triumph');
    expect(getNode(g2, 'inst:crown').props['claimPromoteTo']).toBe(2);
    expect(getNode(g2, 'inst:crown').props['claimDemoteTo']).toBeUndefined();
    expect(flashpointEvent.deltas).toContainEqual({ op: 'node.set', id: 'inst:crown', key: 'claimPromoteTo', value: 2 });
  });

  it('costly: claimPromoteTo lands too, claimDemoteTo does not', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:sole', 800, { loyalty: 6000 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), decisive, onBand: EMPTY_ON_BAND };
    const { g2, flashpointEvent } = pressClaim(g, def, { ...ELSE_COSTLY, tierRules: DECISIVE_TEST_RULES, tier: DECISIVE_TIER });
    expect((flashpointEvent.data as { band: string }).band).toBe('costly');
    expect(getNode(g2, 'inst:crown').props['claimPromoteTo']).toBe(2);
    expect(getNode(g2, 'inst:crown').props['claimDemoteTo']).toBeUndefined();
  });

  it('rout: claimDemoteTo lands, claimPromoteTo does not', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:sole', 800, { loyalty: 6000 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), decisive, onBand: EMPTY_ON_BAND };
    const { g2, flashpointEvent } = pressClaim(g, def, { ...ELSE_ROUT, tierRules: DECISIVE_TEST_RULES, tier: DECISIVE_TIER });
    expect((flashpointEvent.data as { band: string }).band).toBe('rout');
    expect(getNode(g2, 'inst:crown').props['claimDemoteTo']).toBe(0);
    expect(getNode(g2, 'inst:crown').props['claimPromoteTo']).toBeUndefined();
    expect(flashpointEvent.deltas).toContainEqual({ op: 'node.set', id: 'inst:crown', key: 'claimDemoteTo', value: 0 });
  });

  it('setback: NEITHER prop lands, even though this FlashpointDef authors both decisive fields', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:sole', 800, { loyalty: 6000 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), decisive, onBand: EMPTY_ON_BAND };
    const { g2, flashpointEvent } = pressClaim(g, def, ELSE_SETBACK);
    expect((flashpointEvent.data as { band: string }).band).toBe('setback');
    expect(getNode(g2, 'inst:crown').props['claimPromoteTo']).toBeUndefined();
    expect(getNode(g2, 'inst:crown').props['claimDemoteTo']).toBeUndefined();
    expect(flashpointEvent.deltas).toEqual([]); // setback with no decisive qualification: zero deltas of its own
  });
});

// ---------------------------------------------------------------------------
// (f) determinism + replay.
// ---------------------------------------------------------------------------
describe('press_claim: (f) determinism + replay', () => {
  it('two independent resolutions from the same pre-state produce byte-identical graphs and event logs; replaying every landed delta reproduces the post-state exactly', () => {
    let g0 = crownGraph({ alwaysTrue: true });
    g0 = withBacker(g0, 'char:brann', 5000, { loyalty: 6000 });
    g0 = withBacker(g0, 'char:mair', 2000, { loyalty: 1000, cunning: true }); // false stone -- exercises claim.betrayed's deltas in the replay too
    g0 = addNode(g0, { id: 'char:someone', type: 'character', props: { name: 'Someone' } });

    const def: FlashpointDef = {
      assets: [{ label: 'Asset', bp: 300, when: { nodeId: 'inst:crown', prop: 'alwaysTrue', cmp: 'eq', value: true } }],
      opposition: elseRowOpposition(),
      decisive: { demoteOnRoutTo: 0 },
      onBand: { ...EMPTY_ON_BAND, rout: [{ kind: 'grant', charId: 'char:someone', amount: '10' }] },
    };
    // v0.5.3 review fix (C1): a real matching demote rule for tier 0 is now
    // required before claimDemoteTo stamps at all -- see this file's
    // "decisive outcomes" describe block above for the full reasoning; this
    // pin's own sanity check below (claimDemoteTo === 0) needs the same
    // companion tierRules/tier this fix now requires everywhere else.
    const pin = {
      seed: 'flashpoint-determinism-replay', flashpointId: 'fp-determinism', tick: 0,
      tierRules: [{ from: 0, to: 0, kind: 'demote' as const, note: 'test fixture: matches this pin\'s decisive.demoteOnRoutTo' }],
      tier: 0,
    };

    const runA = pressClaim(g0, def, pin);
    const runB = pressClaim(g0, def, pin);
    expect((runA.flashpointEvent.data as { band: string }).band).toBe('rout');

    expect(hashValue(runA.g2)).toBe(hashValue(runB.g2));
    expect(runA.em.all().map((e) => ({ type: e.type, data: e.data, deltas: e.deltas, parents: e.parents })))
      .toEqual(runB.em.all().map((e) => ({ type: e.type, data: e.data, deltas: e.deltas, parents: e.parents })));

    const replayed = applyDeltas(g0, runA.em.all().flatMap((e) => e.deltas));
    expect(hashValue(replayed)).toBe(hashValue(runA.g2));

    // Sanity: this fixture really did exercise decisive + onBand + betrayal
    // together, so the replay above is not accidentally trivial.
    expect(runA.em.all().some((e) => e.type === 'op.grant')).toBe(true);
    expect(runA.em.all().some((e) => e.type === 'claim.betrayed')).toBe(true);
    expect(getNode(runA.g2, 'inst:crown').props['claimDemoteTo']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (g) fortune draw uses stream 'flashpoint' keyed by flashpointId
// (unique-draw discipline): an independently computed reference -- calling
// fortune.int with EXACTLY these arguments, the same way a caller outside
// this module would -- matches the observed band; two different
// flashpointIds at the identical tick draw independently (proving the id is
// truly part of the key, not a constant or an ignored field).
// ---------------------------------------------------------------------------
describe("press_claim: (g) fortune draw uses stream 'flashpoint' keyed by flashpointId", () => {
  it('the observed band matches fortune.int(\'flashpoint\', tick, flashpointId, 0, 999) computed independently; two flashpointIds at the same tick draw different rolls (and here, different bands)', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:sole', 1000, { loyalty: 6000 });
    const def: FlashpointDef = {
      assets: [],
      opposition: [{ label: 'Garrison', bp: 1000, when: { nodeId: 'inst:crown', prop: 'alwaysTrue', cmp: 'eq', value: true } }], // r = 1000*1000/1000 = 1000 -> the r>=1000 row
      onBand: EMPTY_ON_BAND,
    };
    const seed = 'flashpoint-stream-key-test';
    const fortune = makeFortune(seed);
    const tick = 0;

    const emA = makeEmitter(tick);
    applyOp(g, { kind: 'press_claim', flashpointId: 'fp-alpha' }, tick, emA, 'seat:throne', [], { 'fp-alpha': def }, fortune);
    const emB = makeEmitter(tick);
    applyOp(g, { kind: 'press_claim', flashpointId: 'fp-beta' }, tick, emB, 'seat:throne', [], { 'fp-beta': def }, fortune);

    const bandA = (emA.all().find((e) => e.type === 'claim.flashpoint')!.data as { band: string }).band;
    const bandB = (emB.all().find((e) => e.type === 'claim.flashpoint')!.data as { band: string }).band;

    // Independently computed reference: the EXACT call shape production
    // code must be making, reproduced here from scratch (not by calling any
    // of ops.ts's own internals).
    expect(fortune.int('flashpoint', tick, 'fp-alpha', 0, 999)).toBe(720);
    expect(fortune.int('flashpoint', tick, 'fp-beta', 0, 999)).toBe(259);
    expect(bandA).toBe('costly'); // r1000 row: rout[0,100) setback[100,350) costly[350,800) triumph[800,1000) -- 720 -> costly
    expect(bandB).toBe('setback'); // 259 -> setback
    expect(bandA).not.toBe(bandB); // the two flashpointIds genuinely drew independently
  });
});

// ---------------------------------------------------------------------------
// Bonus: wired into resolveTick, proving the season-access seam (validateOp
// and applyOp both threading SeasonConfig.flashpoints end to end) actually
// works through the real apply chain, not just via direct applyOp calls.
// ---------------------------------------------------------------------------
describe('press_claim: wired into resolveTick (season-access seam, end to end)', () => {
  it('a directive-compiled press_claim op (choice.ops, not an option) validates and resolves through a real resolveTick call, reading SeasonConfig.flashpoints', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:sole', 1000, { loyalty: 6000 });
    g = addNode(g, {
      id: 'place:ash', type: 'place',
      props: {
        name: 'Ash', population: fx('100'), granary: fx('250'), farmland: fx('10'),
        unrest: fx('10'), dole: fx('0'), taxRateBp: 1000, roadsBonusBp: 0, defenseBp: 0,
        famineStage: 0, famineEndsAt: 0, levy: fx('0'),
      },
    });

    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const season: SeasonConfig = {
      seasonId: 'flashpoint-wiring-test',
      startTier: 1,
      initialGraph: g,
      decks: [{
        id: 'probe-deck', tier: 1,
        storylets: [{
          id: 'probe', kind: 'brief', tier: 1, cooldownTicks: 1, once: false,
          pattern: { nodes: [{ as: 'p', type: 'place' }] },
          title: 'Probe', body: 'Probe body',
          options: [{ id: 'skip', label: 'Skip', ops: [] }],
          defaultOptionId: 'skip',
        }],
      }],
      tiers: { 1: { deckIds: ['probe-deck'], briefBudget: 1, attentionSlots: 1 } },
      calendar: [],
      tierRules: [],
      throne: { id: 'seat:throne', kind: 'throne', bodyCharId: 'char:ruler', attentionSlots: 1, fidelity: 'external' },
      reporters: [],
      primaryPlaceId: 'place:ash',
      flashpoints: { 'fp-wired': def },
    };
    const fortune = makeFortune('flashpoint-wiring');

    const out1 = resolveTick(season, initialState(season), { seatId: 'seat:throne', choices: [] }, fortune);
    const pendingBrief = out1.packet.briefs[0]!;

    const out2 = resolveTick(season, out1.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: pendingBrief.briefId, ops: [{ kind: 'press_claim', flashpointId: 'fp-wired' }] }],
    }, fortune);

    const flashpointEv = out2.events.find((e) => e.type === 'claim.flashpoint');
    expect(flashpointEv).toBeDefined();
    expect((flashpointEv?.data as { flashpointId: string }).flashpointId).toBe('fp-wired');
  });

  it('a directive naming an unknown flashpointId is rejected at validateDecisions (resolveTick throws its own standard wrapped error -- same contract as any other invalid decision, e.g. a bad op or unknown briefId -- never an internal crash from applyOp reaching for a missing flashpoint)', () => {
    let g = crownGraph();
    g = addNode(g, {
      id: 'place:ash', type: 'place',
      props: {
        name: 'Ash', population: fx('100'), granary: fx('250'), farmland: fx('10'),
        unrest: fx('10'), dole: fx('0'), taxRateBp: 1000, roadsBonusBp: 0, defenseBp: 0,
        famineStage: 0, famineEndsAt: 0, levy: fx('0'),
      },
    });
    const season: SeasonConfig = {
      seasonId: 'flashpoint-unknown-test',
      startTier: 1,
      initialGraph: g,
      decks: [{
        id: 'probe-deck', tier: 1,
        storylets: [{
          id: 'probe', kind: 'brief', tier: 1, cooldownTicks: 1, once: false,
          pattern: { nodes: [{ as: 'p', type: 'place' }] },
          title: 'Probe', body: 'Probe body',
          options: [{ id: 'skip', label: 'Skip', ops: [] }],
          defaultOptionId: 'skip',
        }],
      }],
      tiers: { 1: { deckIds: ['probe-deck'], briefBudget: 1, attentionSlots: 1 } },
      calendar: [],
      tierRules: [],
      throne: { id: 'seat:throne', kind: 'throne', bodyCharId: 'char:ruler', attentionSlots: 1, fidelity: 'external' },
      reporters: [],
      primaryPlaceId: 'place:ash',
      // No flashpoints table at all -- validateDecisions must reject
      // cleanly (season.flashpoints ?? {}), never throw.
    };
    const fortune = makeFortune('flashpoint-unknown');
    const out1 = resolveTick(season, initialState(season), { seatId: 'seat:throne', choices: [] }, fortune);
    const pendingBrief = out1.packet.briefs[0]!;

    expect(() => resolveTick(season, out1.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: pendingBrief.briefId, ops: [{ kind: 'press_claim', flashpointId: 'fp-does-not-exist' }] }],
    }, fortune)).toThrow(/bad op/); // validateDecisions catches it at the wire gate; resolveTick's standard `resolveTick: ${error}` wrap
  });
});

// ---------------------------------------------------------------------------
// Task 4 (2026-08-20 claim plan, Global Constraints -- momentum): a
// flashpoint's outcome sways hearts still undecided. A "waverer" is a claim-
// circle character (declarationStep's own claimCircle===true AND
// claimBp:number AND) with NO backing edge yet, not imprisoned, holding a
// real loyalty edge to the ruler, whose EFFECTIVE loyalty (systems.ts's
// exported effectiveLoyalty -- the SAME formula/threshold declarationStep
// itself reads, reused verbatim rather than re-derived) sits in
// [WAVERER_FLOOR, DECLARE_LOYALTY) = [4000, 5500). On triumph/costly, every
// waverer's claimNudge is set to +800; on rout/setback, every waverer AND
// every character still holding a backing edge (read AFTER betrayal --
// claim §3's own unmasked false stone already lost its edge and paid its own
// harsher price, so it does not also eat this) gets claimNudge = -400.
// Always a plain node.set (never +=): a second flashpoint before decay
// clears the first OVERWRITES, never stacks. Decayed by claimNudgeDecayStep
// (systems.ts, CLAIM_NUDGE_TICKS = 4) -- fingerprintDecayStep's own
// discipline mirrored exactly: order-stable, one event carrying every fade,
// none when nothing faded, no `parents`.
//
// The nudge write rides ONE additional event, `claim.swayed`, parented to
// the flashpoint event alone -- D14 cleanliness: the chronicle separates the
// roll (claim.flashpoint) from its social aftershock (claim.swayed) rather
// than growing the roll's own data with a second, unrelated concern.
// data: { charIds: string[] (sorted), direction: 'toward' | 'away' } --
// 'toward' only ever accompanies triumph/costly's waverers-only nudge;
// 'away' accompanies rout/setback's declared-backers+waverers nudge. Never
// emitted when nobody qualifies (fingerprintDecayStep's own "no fades, no
// event" precedent).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (a) costly/triumph nudges exactly the waverer band (+800): a waverer gets
// it, a silent char (below WAVERER_FLOOR) does not, a declared backer does
// not either (the +800 leg names waverers only, never backers).
// ---------------------------------------------------------------------------
describe('press_claim: momentum (a) triumph/costly nudges exactly the waverer band', () => {
  it('triumph: a waverer (effective 4500) gets claimNudge=+800; a silent char (effective 3000) and a declared backer are untouched', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 }); // declared, loyal (never a false stone); also drives r huge -> r>=1500 row
    g = withCircle(g, 'char:waverer', { loyalty: 4500 }); // effective 4500 -- in [4000,5500)
    g = withCircle(g, 'char:silent', { loyalty: 3000 }); // effective 3000 -- below WAVERER_FLOOR
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2, em, flashpointEvent } = pressClaim(g, def, R1500_TRIUMPH);
    expect((flashpointEvent.data as { band: string }).band).toBe('triumph');

    expect(getNode(g2, 'char:waverer').props['claimNudge']).toBe(800);
    expect(getNode(g2, 'char:waverer').props['claimNudgeAt']).toBe(R1500_TRIUMPH.tick);
    expect(getNode(g2, 'char:silent').props['claimNudge']).toBeUndefined();
    expect(getNode(g2, 'char:backer').props['claimNudge']).toBeUndefined(); // declared backers never get the +800 leg

    const swayedEv = em.all().find((e) => e.type === 'claim.swayed');
    expect(swayedEv).toBeDefined();
    expect(swayedEv?.data).toEqual({ charIds: ['char:waverer'], direction: 'toward' });
    expect(swayedEv?.parents).toEqual([flashpointEvent.id]);
    expect(swayedEv?.deltas).toEqual([
      { op: 'node.set', id: 'char:waverer', key: 'claimNudge', value: 800 },
      { op: 'node.set', id: 'char:waverer', key: 'claimNudgeAt', value: R1500_TRIUMPH.tick },
    ]);

    const replayed = applyDeltas(g, em.all().flatMap((e) => e.deltas));
    expect(hashValue(replayed)).toBe(hashValue(g2));
  });

  it('waverer band boundaries: exactly WAVERER_FLOOR (4000) is nudged; one bp under DECLARE_LOYALTY (5499) is nudged; exactly DECLARE_LOYALTY (5500, already declare-eligible) is NOT -- the band is half-open [4000, 5500)', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:atfloor', { loyalty: WAVERER_FLOOR }); // exactly 4000
    g = withCircle(g, 'char:atceiling', { loyalty: DECLARE_LOYALTY - 1 }); // 5499
    g = withCircle(g, 'char:overceiling', { loyalty: DECLARE_LOYALTY }); // 5500 -- already declare-eligible, not a "waverer"
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2 } = pressClaim(g, def, R1500_TRIUMPH);

    expect(getNode(g2, 'char:atfloor').props['claimNudge']).toBe(800);
    expect(getNode(g2, 'char:atceiling').props['claimNudge']).toBe(800);
    expect(getNode(g2, 'char:overceiling').props['claimNudge']).toBeUndefined();
  });

  // Review fix, minor (2026-08-28): every other test in this block exercises
  // triumph only -- the +800 leg is `band === 'triumph' || band === 'costly'`
  // in production, so costly needs its own resolution pinned too, not just
  // inferred from the shared code path. ELSE_COSTLY exists already (T3).
  it('costly resolves through the SAME +800 leg as triumph (not triumph-only)', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withCircle(g, 'char:waverer', { loyalty: 4500 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, flashpointEvent } = pressClaim(g, def, ELSE_COSTLY);
    expect((flashpointEvent.data as { band: string }).band).toBe('costly');
    expect(getNode(g2, 'char:waverer').props['claimNudge']).toBe(800);
    expect(getNode(g2, 'char:waverer').props['claimNudgeAt']).toBe(ELSE_COSTLY.tick);
  });
});

// ---------------------------------------------------------------------------
// (b) rout/setback nudges declared backers AND waverers -400; a silent char
// stays untouched; a false stone unmasked by the SAME rout does not also eat
// the momentum penalty (betrayal already cost them their backing edge and
// paid its own, harsher, price).
// ---------------------------------------------------------------------------
describe('press_claim: momentum (b) rout/setback nudges declared backers AND waverers -400', () => {
  it('rout: a declared backer and a waverer both get claimNudge=-400; a silent char is untouched; one claim.swayed event names both, sorted, direction "away"', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:backer', 2000, { loyalty: 6000 }); // loyal -- never a false stone
    g = withCircle(g, 'char:waverer', { loyalty: 4500 });
    g = withCircle(g, 'char:silent', { loyalty: 3000 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, em, flashpointEvent } = pressClaim(g, def, ELSE_ROUT);
    expect((flashpointEvent.data as { band: string }).band).toBe('rout');

    expect(getNode(g2, 'char:backer').props['claimNudge']).toBe(-400);
    expect(getNode(g2, 'char:backer').props['claimNudgeAt']).toBe(ELSE_ROUT.tick);
    expect(getNode(g2, 'char:waverer').props['claimNudge']).toBe(-400);
    expect(getNode(g2, 'char:silent').props['claimNudge']).toBeUndefined();

    const swayedEv = em.all().find((e) => e.type === 'claim.swayed');
    expect(swayedEv?.data).toEqual({ charIds: ['char:backer', 'char:waverer'], direction: 'away' });
    expect(swayedEv?.parents).toEqual([flashpointEvent.id]);
    expect(swayedEv?.deltas).toHaveLength(4); // 2 props x 2 chars

    const replayed = applyDeltas(g, em.all().flatMap((e) => e.deltas));
    expect(hashValue(replayed)).toBe(hashValue(g2));
  });

  it('setback: the same -400 leg fires on setback too (not rout-only)', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withCircle(g, 'char:waverer', { loyalty: 4500 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, flashpointEvent } = pressClaim(g, def, ELSE_SETBACK);
    expect((flashpointEvent.data as { band: string }).band).toBe('setback');
    expect(getNode(g2, 'char:waverer').props['claimNudge']).toBe(-400);
  });

  it('a false stone unmasked by THIS SAME rout does not also eat the momentum penalty -- betrayal already cost them their backing edge; nobody else qualifies, so claim.swayed does not even fire', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:traitor', 2000, { loyalty: 1000, cunning: true }); // false stone -- unmasked on rout
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, em, flashpointEvent } = pressClaim(g, def, ELSE_ROUT);
    expect((flashpointEvent.data as { band: string }).band).toBe('rout');
    expect(em.all().find((e) => e.type === 'claim.betrayed')?.data).toEqual({ charId: 'char:traitor' });
    expect(findEdge(g2, 'backing', 'char:traitor', 'inst:crown')).toBeUndefined(); // unmasked, edge gone

    expect(getNode(g2, 'char:traitor').props['claimNudge']).toBeUndefined(); // NOT also nudged
    expect(em.all().find((e) => e.type === 'claim.swayed')).toBeUndefined(); // no-op guard: nobody qualifies
  });

  // Review fix, minor (2026-08-28): the test above proves the traitor is
  // excluded, but with nobody ELSE present to nudge, it can't distinguish a
  // SELECTIVE exclusion (only the unmasked traitor skipped) from a BLANKET
  // one (rout with any betrayal just skips momentum entirely). This one mixes
  // in a real backer and a waverer alongside the traitor to prove it's
  // selective: the -400 lands on the other two, and claim.swayed DOES fire.
  it('a false stone unmasked in the SAME resolution as other real backers/waverers: the -400 lands on the OTHERS -- selective exclusion of the unmasked traitor alone, not a blanket "skip momentum" outcome', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:traitor', 2000, { loyalty: 1000, cunning: true }); // false stone -- unmasked on rout
    g = withBacker(g, 'char:loyalbacker', 500, { loyalty: 6000 }); // real, loyal -- never a false stone
    g = withCircle(g, 'char:waverer', { loyalty: 4500 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, em, flashpointEvent } = pressClaim(g, def, ELSE_ROUT);
    expect((flashpointEvent.data as { band: string }).band).toBe('rout');
    expect(em.all().find((e) => e.type === 'claim.betrayed')?.data).toEqual({ charId: 'char:traitor' });

    // The traitor: unmasked, and NOT also nudged.
    expect(findEdge(g2, 'backing', 'char:traitor', 'inst:crown')).toBeUndefined();
    expect(getNode(g2, 'char:traitor').props['claimNudge']).toBeUndefined();

    // The others: -400 lands, exactly as it would with no betrayal at all.
    expect(getNode(g2, 'char:loyalbacker').props['claimNudge']).toBe(-400);
    expect(getNode(g2, 'char:waverer').props['claimNudge']).toBe(-400);

    const swayedEv = em.all().find((e) => e.type === 'claim.swayed');
    expect(swayedEv?.data).toEqual({ charIds: ['char:loyalbacker', 'char:waverer'], direction: 'away' });
  });
});

// ---------------------------------------------------------------------------
// (c) claimNudgeDecayStep: mirrors fingerprintDecayStep's own test precedent
// (test/fingerprints.test.ts) almost line for line -- same shape, its own
// props (claimNudge/claimNudgeAt) and its own window (CLAIM_NUDGE_TICKS=4).
// ---------------------------------------------------------------------------
describe('press_claim: momentum (c) claimNudgeDecayStep (CLAIM_NUDGE_TICKS = 4)', () => {
  it('CLAIM_NUDGE_TICKS is exactly 4', () => {
    expect(CLAIM_NUDGE_TICKS).toBe(4);
  });

  it('nudged at t (via a real triumph): still present at t+4, cleared (both props) at t+5, with claim.nudge.faded carrying it and replay reproducing', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:wavering', { loyalty: 4500 });
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2: nudged } = pressClaim(g, def, R1500_TRIUMPH); // tick 2
    expect(getNode(nudged, 'char:wavering').props['claimNudge']).toBe(800);
    expect(getNode(nudged, 'char:wavering').props['claimNudgeAt']).toBe(R1500_TRIUMPH.tick);

    // t+4: (6-2)=4, not > 4 -- still present, decay pass is a no-op.
    const stillTick = R1500_TRIUMPH.tick + CLAIM_NUDGE_TICKS;
    const emStill = makeEmitter(stillTick);
    const still = claimNudgeDecayStep(nudged, stillTick, emStill);
    expect(getNode(still, 'char:wavering').props['claimNudge']).toBe(800);
    expect(getNode(still, 'char:wavering').props['claimNudgeAt']).toBe(R1500_TRIUMPH.tick);
    expect(emStill.all()).toHaveLength(0);
    expect(hashValue(still)).toBe(hashValue(nudged));

    // t+5: (7-2)=5 > 4 -- cleared.
    const fadeTick = R1500_TRIUMPH.tick + CLAIM_NUDGE_TICKS + 1;
    const emFade = makeEmitter(fadeTick);
    const faded = claimNudgeDecayStep(nudged, fadeTick, emFade);
    expect(getNode(faded, 'char:wavering').props['claimNudge']).toBe(0);
    expect(getNode(faded, 'char:wavering').props['claimNudgeAt']).toBe(-1);

    const ev = emFade.all().find((e) => e.type === 'claim.nudge.faded');
    expect(ev).toBeDefined();
    expect(ev!.parents).toEqual([]);
    expect(ev!.data['fades']).toEqual([{ charId: 'char:wavering', at: R1500_TRIUMPH.tick }]);

    const replayed = applyDeltas(nudged, ev!.deltas);
    expect(hashValue(replayed)).toBe(hashValue(faded));
  });

  it('multiple simultaneous fades collapse into ONE claim.nudge.faded event, order-stable by node id', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withCircle(g, 'char:bbb', { loyalty: 4500 });
    g = withCircle(g, 'char:aaa', { loyalty: 4500 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2: nudged } = pressClaim(g, def, ELSE_ROUT); // tick 0, rout -- both nudged -400 at once
    expect(getNode(nudged, 'char:aaa').props['claimNudge']).toBe(-400);
    expect(getNode(nudged, 'char:bbb').props['claimNudge']).toBe(-400);

    const fadeTick = ELSE_ROUT.tick + CLAIM_NUDGE_TICKS + 1;
    const em = makeEmitter(fadeTick);
    claimNudgeDecayStep(nudged, fadeTick, em);
    const events = em.all();
    expect(events).toHaveLength(1);
    const fades = events[0]!.data['fades'] as Array<{ charId: string; at: number }>;
    expect(fades.map((f) => f.charId)).toEqual(['char:aaa', 'char:bbb']); // sorted
    expect(events[0]!.deltas).toHaveLength(4); // 2 props x 2 fades
  });

  it('a never-nudged character is inert to decay: no fade, no event, graph unchanged', () => {
    let g = crownGraph();
    g = withCircle(g, 'char:untouched', { loyalty: 4500 });
    const em = makeEmitter(100);
    const out = claimNudgeDecayStep(g, 100, em);
    expect(em.all()).toHaveLength(0);
    expect(hashValue(out)).toBe(hashValue(g));
  });

  it('an already-decayed nudge does not re-fade on a later pass (no repeat events)', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:wavering', { loyalty: 4500 });
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2: nudged } = pressClaim(g, def, R1500_TRIUMPH);
    const fadeTick = R1500_TRIUMPH.tick + CLAIM_NUDGE_TICKS + 1;
    const oncefaded = claimNudgeDecayStep(nudged, fadeTick, makeEmitter(fadeTick));
    const laterTick = fadeTick + 20;
    const em2 = makeEmitter(laterTick);
    const twicefaded = claimNudgeDecayStep(oncefaded, laterTick, em2);
    expect(em2.all()).toHaveLength(0); // claimNudge===0 never re-qualifies -- gated on nudgeVal !== 0
    expect(hashValue(twicefaded)).toBe(hashValue(oncefaded));
  });

  it('determinism: decay of the same input at the same tick is bit-identical across two independent calls', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:wavering', { loyalty: 4500 });
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2: nudged } = pressClaim(g, def, R1500_TRIUMPH);
    const fadeTick = R1500_TRIUMPH.tick + CLAIM_NUDGE_TICKS + 1;
    const a = claimNudgeDecayStep(nudged, fadeTick, makeEmitter(fadeTick));
    const b = claimNudgeDecayStep(nudged, fadeTick, makeEmitter(fadeTick));
    expect(hashValue(a)).toBe(hashValue(b));
  });

  it('momentum is temporary: after decay, a waverer whose UN-nudged baseline sits below DECLARE_LOYALTY falls back out of reach', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:brink', { loyalty: 4999 }); // 4999+800=5799 while nudged; 4999 alone stays under 5500
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2: nudged } = pressClaim(g, def, R1500_TRIUMPH);
    expect(getNode(nudged, 'char:brink').props['claimNudge']).toBe(800);

    const fadeTick = R1500_TRIUMPH.tick + CLAIM_NUDGE_TICKS + 1;
    const faded = claimNudgeDecayStep(nudged, fadeTick, makeEmitter(fadeTick));
    expect(getNode(faded, 'char:brink').props['claimNudge']).toBe(0);

    // Confirmed via the real declaration pass: WITH the nudge still live
    // they would have declared; once it decays, they no longer do (the
    // baseline true loyalty 4999 alone never cleared DECLARE_LOYALTY).
    const post = declarationStep(faded, fadeTick + 1, makeEmitter(fadeTick + 1));
    expect(findEdge(post, 'backing', 'char:brink', 'inst:crown')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (d) overwrite, not stack: two flashpoints inside the decay window leave
// only the LATEST nudge value -- never a sum.
// ---------------------------------------------------------------------------
describe('press_claim: momentum (d) overwrite-not-stack (Global Constraints, verbatim: "never stacks with itself")', () => {
  it('triumph (+800) then setback (-400) one tick later: the second OVERWRITES the first -- claimNudge ends at -400, not +400', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 }); // r>=1500 driver for round 1
    g = withCircle(g, 'char:wavering', { loyalty: 4500 }); // stays a waverer across both: 4500, then 4500+800=5300 (<5500) while nudged

    const def1: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2: afterFirst } = pressClaim(g, def1, R1500_TRIUMPH); // tick 2, triumph
    expect(getNode(afterFirst, 'char:wavering').props['claimNudge']).toBe(800);
    expect(getNode(afterFirst, 'char:wavering').props['claimNudgeAt']).toBe(2);

    const def2: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2: afterSecond, flashpointEvent: secondEvent } = pressClaim(afterFirst, def2, ELSE_SETBACK); // tick 3, setback
    expect((secondEvent.data as { band: string }).band).toBe('setback');

    expect(getNode(afterSecond, 'char:wavering').props['claimNudge']).toBe(-400); // NOT 800 + -400 = 400
    expect(getNode(afterSecond, 'char:wavering').props['claimNudgeAt']).toBe(3); // latest tick, not the first
  });

  it('triumph then triumph again: the second +800 overwrites the first +800 -- same value, but a fresh write, not a stale one silently kept', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:wavering', { loyalty: 4500 });
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2: afterFirst, flashpointEvent: firstEvent } = pressClaim(g, def, R1500_TRIUMPH); // tick 2
    expect((firstEvent.data as { band: string }).band).toBe('triumph');
    expect(getNode(afterFirst, 'char:wavering').props['claimNudgeAt']).toBe(2);

    // Same pin reused (pure function of seed/tick/key -- draws the identical
    // roll, still triumph) to simulate a second landing without needing a
    // second brute-forced seed.
    const { g2: afterSecond, flashpointEvent: secondEvent } = pressClaim(afterFirst, def, R1500_TRIUMPH);
    expect((secondEvent.data as { band: string }).band).toBe('triumph');
    expect(getNode(afterSecond, 'char:wavering').props['claimNudge']).toBe(800);
    expect(getNode(afterSecond, 'char:wavering').props['claimNudgeAt']).toBe(2); // same tick pin, so unchanged here -- (d)'s OTHER test pins the cross-tick case
  });
});

// ---------------------------------------------------------------------------
// (e) anti-farm: a silent char (effective < WAVERER_FLOOR) can never be
// nudged into declaring. Excluded from the waverer band entirely -- not
// merely "nudged but still short" -- and the arithmetic is pinned explicitly
// per the brief's own instruction even so.
// ---------------------------------------------------------------------------
describe('press_claim: momentum (e) anti-farm -- nudges alone never bridge a silent character to declaring', () => {
  it('effective 3999 (one bp under WAVERER_FLOOR): excluded from the waverer band -- 3 consecutive triumphs (the "farm" always landing) leave claimNudge permanently absent', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:silent', { loyalty: WAVERER_FLOOR - 1 }); // 3999
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };

    let cur = g;
    for (let i = 0; i < 3; i++) {
      const { g2, flashpointEvent } = pressClaim(cur, def, R1500_TRIUMPH);
      expect((flashpointEvent.data as { band: string }).band).toBe('triumph');
      expect(getNode(g2, 'char:silent').props['claimNudge']).toBeUndefined();
      cur = g2;
    }

    // Pin the arithmetic explicitly (brief's own instruction): even in the
    // counterfactual where the band exclusion above did not exist and a
    // silent character received the +800 nudge anyway, it still could not
    // have bridged them to DECLARE_LOYALTY in one hop -- the exclusion is
    // belt, this arithmetic is suspenders.
    expect((WAVERER_FLOOR - 1) + 800).toBe(4799);
    expect(4799).toBeLessThan(DECLARE_LOYALTY);
  });

  it('CONTRAST: a waverer at 4999 (brief\'s own pinned example) + triumph -> 5799, now >= DECLARE_LOYALTY -- the designed conversion, confirmed real by actually declaring on the next declarationStep pass', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:brink', { loyalty: 4999 });
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2 } = pressClaim(g, def, R1500_TRIUMPH);
    expect(getNode(g2, 'char:brink').props['claimNudge']).toBe(800);
    expect(4999 + 800).toBe(5799);
    expect(5799).toBeGreaterThanOrEqual(DECLARE_LOYALTY);

    const post = declarationStep(g2, R1500_TRIUMPH.tick + 1, makeEmitter(R1500_TRIUMPH.tick + 1));
    expect(findEdge(post, 'backing', 'char:brink', 'inst:crown')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Exclusions (mirrors declarationStep's own, controller adjudication
// 2026-08-27): a character who could never declare is never nudged toward
// or away from doing so either -- inert either way, but untidy to leave
// unguarded.
// ---------------------------------------------------------------------------
describe('press_claim: momentum exclusions (imprisoned / no loyalty edge) -- mirrors declarationStep', () => {
  it('an imprisoned circle character in the waverer band is never nudged on triumph', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = withCircle(g, 'char:jailed', { loyalty: 4500, imprisoned: true });
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2 } = pressClaim(g, def, R1500_TRIUMPH);
    expect(getNode(g2, 'char:jailed').props['claimNudge']).toBeUndefined();
  });

  it('an imprisoned circle character in the waverer band is never nudged on rout either (holds no backing edge, so the declared-backer leg does not apply)', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withCircle(g, 'char:jailed', { loyalty: 4500, imprisoned: true });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2 } = pressClaim(g, def, ELSE_ROUT);
    expect(getNode(g2, 'char:jailed').props['claimNudge']).toBeUndefined();
  });

  it('a circle character with NO loyalty edge at all is never nudged -- cannot declare regardless, matching the declaration pass\'s own exclusion', () => {
    let g = crownGraph();
    g = withBacker(g, 'char:backer', 10000, { loyalty: 6000 });
    g = addNode(g, { id: 'char:noedge', type: 'character', props: { name: 'No Edge', claimCircle: true, claimBp: 500, wantChain: ['coin'], wantIndex: 1 } });
    const def: FlashpointDef = { assets: [], opposition: [], onBand: EMPTY_ON_BAND };
    const { g2 } = pressClaim(g, def, R1500_TRIUMPH);
    expect(getNode(g2, 'char:noedge').props['claimNudge']).toBeUndefined();
  });

  // Review fix (2026-08-28): CONTRAST to the two imprisoned-waverer cases
  // above. Behavior already correct pre-fix (upheld by review) -- this pins
  // it, honestly GREEN from the start, no RED staged first. Mirrors
  // withCircle's own `imprisoned` option, now added to withBacker too.
  it('CONTRAST: a declared backer imprisoned AFTER declaring still receives claimNudge=-400 on rout/setback -- imprisonment does not retract a standing declaration, unlike the waverer exclusion above', () => {
    let g = crownGraph({ alwaysTrue: true });
    g = withBacker(g, 'char:jailedbacker', 2000, { loyalty: 6000, imprisoned: true }); // declared, loyal (never a false stone), AND imprisoned
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };
    const { g2, flashpointEvent } = pressClaim(g, def, ELSE_ROUT);
    expect((flashpointEvent.data as { band: string }).band).toBe('rout');
    expect(getNode(g2, 'char:jailedbacker').props['claimNudge']).toBe(-400);
    expect(getNode(g2, 'char:jailedbacker').props['claimNudgeAt']).toBe(ELSE_ROUT.tick);
  });
});

// ---------------------------------------------------------------------------
// (f) determinism + replay, exercising the momentum path specifically (both
// nudge groups active on the same resolution).
// ---------------------------------------------------------------------------
describe('press_claim: momentum (f) determinism + replay', () => {
  it('two independent resolutions from the same pre-state, exercising both nudge groups on a setback, produce byte-identical graphs and event logs; replaying every landed delta reproduces the post-state exactly', () => {
    let g0 = crownGraph({ alwaysTrue: true });
    g0 = withBacker(g0, 'char:backer', 2000, { loyalty: 6000 });
    g0 = withCircle(g0, 'char:waverer', { loyalty: 4500 });
    g0 = withCircle(g0, 'char:silent', { loyalty: 2000 });
    const def: FlashpointDef = { assets: [], opposition: elseRowOpposition(), onBand: EMPTY_ON_BAND };

    const runA = pressClaim(g0, def, ELSE_SETBACK);
    const runB = pressClaim(g0, def, ELSE_SETBACK);
    expect((runA.flashpointEvent.data as { band: string }).band).toBe('setback');

    expect(hashValue(runA.g2)).toBe(hashValue(runB.g2));
    expect(runA.em.all().map((e) => ({ type: e.type, data: e.data, deltas: e.deltas, parents: e.parents })))
      .toEqual(runB.em.all().map((e) => ({ type: e.type, data: e.data, deltas: e.deltas, parents: e.parents })));

    const replayed = applyDeltas(g0, runA.em.all().flatMap((e) => e.deltas));
    expect(hashValue(replayed)).toBe(hashValue(runA.g2));

    const swayedEv = runA.em.all().find((e) => e.type === 'claim.swayed');
    expect(swayedEv?.data).toEqual({ charIds: ['char:backer', 'char:waverer'], direction: 'away' });
    expect(getNode(runA.g2, 'char:silent').props['claimNudge']).toBeUndefined();
  });
});
