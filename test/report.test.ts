import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { makeFortune } from '../src/fortune.js';
import { addEdge, addNode, emptyGraph, removeEdge, setEdgeProp, setNodeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import { claimReport, compileReport } from '../src/report.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import type { Seat } from '../src/report.js';

const f = makeFortune('report-test-seed');
const steward: Seat = { id: 'seat:steward', kind: 'office', bodyCharId: 'char:osric', officeId: 'office:steward', attentionSlots: 1, fidelity: 'npc' };
const INTEREST = 'interest:char:osric->inst:crown';
const LOYALTY = 'loyalty:char:osric->char:ruler';

describe('compileReport', () => {
  it('an unexposed skimmer hides the theft', () => {
    const g = setEdgeProp(thornfieldGraph(), INTEREST, 'skimmed', fx('12'));
    const r = compileReport(g, f, 5, 'place:thornfield', steward);
    expect(r.treasury).toBe('312'); // true 300 + hidden 12
  });
  it('an exposed skimmer reports the truth', () => {
    let g = setEdgeProp(thornfieldGraph(), INTEREST, 'skimmed', fx('12'));
    g = setEdgeProp(g, INTEREST, 'exposed', true);
    expect(compileReport(g, f, 5, 'place:thornfield', steward).treasury).toBe('300');
  });
  it('granary noise is bounded, seeded, and repeatable', () => {
    const g = thornfieldGraph();
    const a = compileReport(g, f, 5, 'place:thornfield', steward);
    const b = compileReport(g, f, 5, 'place:thornfield', steward);
    expect(a.granary).toBe(b.granary);
    const reported = fx(a.granary);
    expect(reported >= fx('242.5')).toBe(true); // 250 * 0.97
    expect(reported <= fx('257.5')).toBe(true); // 250 * 1.03
  });
  it('a disloyal reporter understates unrest by one bucket', () => {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('55')); // restive
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('restive'); // loyalty 4200
    g = setEdgeProp(g, LOYALTY, 'bp', 2500);
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('uneasy'); // shifted down
  });

  // Regression: silence property (central epistemic guarantee)
  it('unexposed skimmer silence: only treasury differs, notes/granary/unrest identical', () => {
    let g = setEdgeProp(thornfieldGraph(), INTEREST, 'skimmed', fx('12'));
    const hidden = compileReport(g, f, 5, 'place:thornfield', steward);
    g = setEdgeProp(g, INTEREST, 'exposed', true);
    const exposed = compileReport(g, f, 5, 'place:thornfield', steward);
    expect(hidden.notes).toEqual(exposed.notes);
    expect(hidden.granary).toBe(exposed.granary);
    expect(hidden.unrest).toBe(exposed.unrest);
    expect(hidden.treasury).not.toBe(exposed.treasury);
  });

  // Regression: missing loyalty edge defaults to 5000 bp (no shift)
  it('missing loyalty edge uses default 5000 bp (no unrest shift)', () => {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('55')); // restive
    g = removeEdge(g, LOYALTY);
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('restive');
  });
  it('non-number loyalty bp treated as default 5000', () => {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('55')); // restive
    g = setEdgeProp(g, LOYALTY, 'bp', 'high');
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('restive');
  });

  // Regression: bucket boundaries (loyalty ≥3000, no shift)
  it('unrest bucket boundaries: fx(25) → uneasy, fx(50) → restive, fx(75) → boiling', () => {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('25'));
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('uneasy');
    g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('50'));
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('restive');
    g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('75'));
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('boiling');
  });
  it('unrest bucket boundary: fx(24.9999) → calm', () => {
    const g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('24.9999'));
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('calm');
  });
});

// Task 5 (2026-08-20 claim plan), the claim projection: claimReport(g, gate)
// -- DATA only, the player's ENTIRE knowledge of the campaign (controller-
// pinned seam, task-5 brief: the fog rule is absolute). Mirrors test/
// claim.test.ts's own crownGraph fixture style (explicit values built at
// each call site).
describe('claimReport (claim projection, Global Constraints)', () => {
  function crownGraph(): WorldGraph {
    let g = emptyGraph();
    g = addNode(g, {
      id: 'inst:crown', type: 'institution',
      props: { treasury: fx('80'), legitimacy: fx('0'), arrears: fx('0'), rulerCharId: 'char:ruler' },
    });
    g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'Ruler' } });
    return g;
  }

  // Five circle characters, one of each state/price combination the plan's
  // shape distinguishes, plus one non-circle character who must never
  // appear at all. legitimacy 0 throughout, so effective loyalty === true
  // loyalty -- isolates every assertion to the band boundaries themselves.
  function fullClaimGraph(): WorldGraph {
    let g = crownGraph();

    // declared: already has a backing edge (hand-built -- declarationStep
    // is not under test here); a current want with a MATCHING unbroken
    // promise -- pledged true.
    g = addNode(g, {
      id: 'char:declared', type: 'character',
      props: { name: 'Declared', claimCircle: true, claimBp: 3000, wantChain: ['coin'], wantIndex: 0 },
    });
    g = addEdge(g, { type: 'backing', src: 'char:declared', dst: 'inst:crown', props: { declaredAt: 0, bp: 3000, viaPromise: '' } });
    g = addEdge(g, { type: 'promise', src: 'inst:crown', dst: 'char:declared', props: { wantKey: 'coin', madeAt: 0, dueOn: 'restoration', broken: false } });

    // weighing: no backing edge; loyalty 4200 sits in [WAVERER_FLOOR 4000,
    // DECLARE_LOYALTY 5500). A current want with NO promise -- pledged false.
    g = addNode(g, {
      id: 'char:weighing', type: 'character',
      props: { name: 'Weighing', claimCircle: true, claimBp: 1500, wantChain: ['office'], wantIndex: 0 },
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:weighing', dst: 'char:ruler', props: { bp: 4200 } });

    // silent (below the waverer floor): loyalty 2000. Sated (wantIndex past
    // the chain end) -- price null.
    g = addNode(g, {
      id: 'char:silent-low', type: 'character',
      props: { name: 'SilentLow', claimCircle: true, claimBp: 800, wantChain: ['coin'], wantIndex: 1 },
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:silent-low', dst: 'char:ruler', props: { bp: 2000 } });

    // silent (excluded: imprisoned) despite loyalty 4500, which would
    // otherwise land in the waverer band -- a cell is not a court. Carries
    // a BROKEN promise naming their current want: pledged must read false
    // regardless (a broken promise never counts).
    g = addNode(g, {
      id: 'char:silent-jailed', type: 'character',
      props: { name: 'SilentJailed', claimCircle: true, claimBp: 500, wantChain: ['revenge'], wantIndex: 0, imprisoned: true },
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:silent-jailed', dst: 'char:ruler', props: { bp: 4500 } });
    g = addEdge(g, { type: 'promise', src: 'inst:crown', dst: 'char:silent-jailed', props: { wantKey: 'revenge', madeAt: 0, dueOn: 'restoration', broken: true } });

    // silent (excluded: no loyalty edge to the ruler at all).
    g = addNode(g, {
      id: 'char:silent-noedge', type: 'character',
      props: { name: 'SilentNoEdge', claimCircle: true, claimBp: 200, wantChain: ['safety'], wantIndex: 0 },
    });

    // Not in the circle (no claimCircle mark) -- must never appear in `backers`.
    g = addNode(g, { id: 'char:outsider', type: 'character', props: { name: 'Outsider', wantChain: ['coin'], wantIndex: 0 } });
    g = addEdge(g, { type: 'loyalty', src: 'char:outsider', dst: 'char:ruler', props: { bp: 9000 } });

    return g;
  }

  it('backers: exact state banding (declared/weighing/silent) and price, sorted by charId -- not insertion order, and the non-circle outsider is absent', () => {
    const g = fullClaimGraph();
    const report = claimReport(g, { backingBp: 3000, treasury: fx('50') });

    expect(report.backers.map((b) => b.charId)).toEqual([
      'char:declared', 'char:silent-jailed', 'char:silent-low', 'char:silent-noedge', 'char:weighing',
    ]);

    expect(report.backers.find((b) => b.charId === 'char:declared')).toEqual({
      charId: 'char:declared', state: 'declared', bp: 3000, price: { wantKey: 'coin', pledged: true },
    });
    expect(report.backers.find((b) => b.charId === 'char:weighing')).toEqual({
      charId: 'char:weighing', state: 'weighing', bp: 1500, price: { wantKey: 'office', pledged: false },
    });
    expect(report.backers.find((b) => b.charId === 'char:silent-low')).toEqual({
      charId: 'char:silent-low', state: 'silent', bp: 800, price: null,
    });
    expect(report.backers.find((b) => b.charId === 'char:silent-jailed')).toEqual({
      charId: 'char:silent-jailed', state: 'silent', bp: 500, price: { wantKey: 'revenge', pledged: false },
    });
    expect(report.backers.find((b) => b.charId === 'char:silent-noedge')).toEqual({
      charId: 'char:silent-noedge', state: 'silent', bp: 200, price: { wantKey: 'safety', pledged: false },
    });
  });

  it('gate: backingHave sums only live declared backing edges; backingBp/treasuryNeed echo the caller-supplied gate verbatim', () => {
    const g = fullClaimGraph();
    const report = claimReport(g, { backingBp: 3000, treasury: fx('50') });
    expect(report.gate).toEqual({ backingBp: 3000, backingHave: 3000, treasuryNeed: '50', treasuryHave: '80' });
  });

  it('obligations: tribute/debt/promise exact shapes, sorted stable by (kind, dstId) -- not insertion order, broken promises excluded', () => {
    let g = crownGraph();
    // Inserted deliberately out of (kind, dstId) order, to prove the
    // projection sorts rather than echoing insertion/edge-id order.
    g = addNode(g, { id: 'char:zdebt', type: 'character', props: { name: 'ZDebt' } });
    g = addEdge(g, { type: 'debt', src: 'inst:crown', dst: 'char:zdebt', props: { principal: fx('10'), fee: fx('1'), dueTick: 9, settled: false, overdueEmitted: false } });
    g = addNode(g, { id: 'char:liege', type: 'character', props: { name: 'Liege' } });
    g = addEdge(g, { type: 'debt', src: 'inst:crown', dst: 'char:liege', props: { duePerYear: fx('120') } }); // the pre-existing tribute shape
    g = addNode(g, { id: 'char:promisee', type: 'character', props: { name: 'Promisee' } });
    g = addEdge(g, { type: 'promise', src: 'inst:crown', dst: 'char:promisee', props: { wantKey: 'coin', madeAt: 4, dueOn: 'restoration', broken: false } });
    g = addNode(g, { id: 'char:adebt', type: 'character', props: { name: 'ADebt' } });
    g = addEdge(g, { type: 'debt', src: 'inst:crown', dst: 'char:adebt', props: { principal: fx('20'), fee: fx('2'), dueTick: 8, settled: false, overdueEmitted: false } });
    // A broken promise -- must be excluded entirely.
    g = addNode(g, { id: 'char:broken', type: 'character', props: { name: 'Broken' } });
    g = addEdge(g, { type: 'promise', src: 'inst:crown', dst: 'char:broken', props: { wantKey: 'coin', madeAt: 1, dueOn: 'restoration', broken: true } });

    const report = claimReport(g, { backingBp: 1, treasury: fx('0') });
    expect(report.obligations).toEqual([
      { kind: 'debt', dstId: 'char:adebt', detail: { principal: '20', fee: '2', dueTick: 8 } },
      { kind: 'debt', dstId: 'char:zdebt', detail: { principal: '10', fee: '1', dueTick: 9 } },
      { kind: 'promise', dstId: 'char:promisee', detail: { wantKey: 'coin', madeAt: 4 } },
      { kind: 'tribute', dstId: 'char:liege', detail: { duePerYear: '120' } },
    ]); // alphabetical by kind (debt < promise < tribute); within 'debt', by dstId; the broken promise is absent entirely
  });

  it('fog rule: no key anywhere in the projection names true loyalty, true-scale, or false-stone data (walks the whole object)', () => {
    const g = fullClaimGraph();
    const report = claimReport(g, { backingBp: 3000, treasury: fx('50') });

    const banned = /loyalty|truescale|falsestone|false.?stone|treachery/i;
    const offenders: string[] = [];
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        v.forEach(walk);
        return;
      }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (banned.test(k)) offenders.push(k);
        walk(val);
      }
    };
    walk(report);
    expect(offenders).toEqual([]);
  });

  it('determinism: two calls over the same graph and gate produce an identical projection', () => {
    const g = fullClaimGraph();
    const a = claimReport(g, { backingBp: 3000, treasury: fx('50') });
    const b = claimReport(g, { backingBp: 3000, treasury: fx('50') });
    expect(a).toEqual(b);
  });
});
