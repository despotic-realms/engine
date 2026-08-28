// The claim plan (meta/docs/plans/2026-08-20-claim-plan.md), Task 1: the
// backing edge and the declaration pass. A "claim circle" character (node
// props claimCircle === true AND claimBp: number, content-authored) DECLARES
// for the ruler's claim -- a `backing` edge src charId -> dst inst:crown,
// props { declaredAt, bp, viaPromise } -- the tick their price is answered
// (any want fulfilled so far, OR an unbroken `promise` edge naming their
// CURRENT want) AND their effective loyalty (true loyalty bp + claimNudge +
// legitimacyWholePoints * 20) clears DECLARE_LOYALTY (5500).
//
// Mirrors test/debt.test.ts's and test/arcs.test.ts's fixture style:
// explicit values built at each call site (addNode/addEdge/setNodeProp)
// rather than a heavily parameterized builder, so every pinned number is
// visible where it's asserted. Promise edges don't get a real producer
// until Task 2's `pledge` op -- this suite hand-builds them (per the task
// brief's own instruction) to prove the declaration pass's promise-branch
// check works ahead of that op existing.
import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { fx } from '../src/fx.js';
import { makeFortune } from '../src/fortune.js';
import { addEdge, addNode, edgeId, emptyGraph, findEdge, getNode } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import type { CharacterArc } from '../src/arcs.js';
import { advanceCharacterArcs } from '../src/arcs.js';
import { applyOp } from '../src/ops.js';
import { declarationStep } from '../src/systems.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig } from '../src/tick.js';

/** Minimal claim fixture: inst:crown (rulerCharId char:ruler, legitimacy as
 *  given) + the ruler node alone -- callers add circle characters (and any
 *  loyalty/promise/backing edges) per scenario. */
function crownGraph(legitimacy: string): WorldGraph {
  let g = emptyGraph();
  g = addNode(g, {
    id: 'inst:crown', type: 'institution',
    props: { treasury: fx('300'), legitimacy: fx(legitimacy), arrears: fx('0'), rulerCharId: 'char:ruler' },
  });
  g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'Ruler' } });
  return g;
}

describe('declarationStep', () => {
  // (a) circle char with a want already fulfilled + loyalty 6000 declares.
  it('(a) circle char with a want already fulfilled + loyalty 6000 declares -- exact edge props, event shape, no parents, replay-equivalent', () => {
    let g = crownGraph('0');
    g = addNode(g, {
      id: 'char:alwyn', type: 'character',
      // wantIndex 1 on a 1-element chain: sated (currentWant null) --
      // ANY want fulfilled, the "wantIndex > 0" reading pinned by the task.
      props: { name: 'Alwyn', claimCircle: true, claimBp: 3000, wantChain: ['coin'], wantIndex: 1 },
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:alwyn', dst: 'char:ruler', props: { bp: 6000 } });

    const pre = g;
    const em = makeEmitter(10);
    const post = declarationStep(g, 10, em);

    const edge = findEdge(post, 'backing', 'char:alwyn', 'inst:crown');
    expect(edge).toBeDefined();
    expect(edge?.props).toEqual({ declaredAt: 10, bp: 3000, viaPromise: '' });

    const events = em.all();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('claim.declared');
    expect(ev.data).toEqual({ charId: 'char:alwyn', bp: 3000, viaPromise: '' });
    expect(ev.parents).toEqual([]); // systemic pass: never player-descended (T2's ancestry invariant)
    expect(ev.deltas).toEqual([
      {
        op: 'edge.add',
        edge: {
          id: edgeId('backing', 'char:alwyn', 'inst:crown'),
          type: 'backing', src: 'char:alwyn', dst: 'inst:crown',
          props: { declaredAt: 10, bp: 3000, viaPromise: '' },
        },
      },
    ]);

    const replayed = applyDeltas(pre, events.flatMap((e) => e.deltas));
    expect(hashValue(replayed)).toBe(hashValue(post));
  });

  // (b) exact boundary math on the effective-loyalty formula:
  // loyaltyBp + claimNudge + legitimacyWholePoints * 20, threshold
  // DECLARE_LOYALTY = 5500.
  describe('(b) effective-loyalty boundary math (loyaltyBp + claimNudge + legitimacyWholePoints * 20 >= 5500)', () => {
    function readyCharGraph(legitimacy: string): WorldGraph {
      let g = crownGraph(legitimacy);
      g = addNode(g, {
        id: 'char:mair', type: 'character',
        // sated (wantIndex 1 on a 1-element chain) -- price already answered,
        // isolating this suite to the loyalty-formula boundary alone.
        props: { name: 'Mair', claimCircle: true, claimBp: 2000, wantChain: ['office'], wantIndex: 1 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:mair', dst: 'char:ruler', props: { bp: 5000 } });
      return g;
    }

    it('legitimacy 30 whole points: 5000 + 30*20 = 5600 >= 5500 -- declares', () => {
      const g = readyCharGraph('30');
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:mair', 'inst:crown')).toBeDefined();
      expect(em.all()).toHaveLength(1);
    });

    it('legitimacy 25 whole points: 5000 + 25*20 = 5500 exactly -- at the boundary, declares (>= is inclusive)', () => {
      const g = readyCharGraph('25');
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:mair', 'inst:crown')).toBeDefined();
      expect(em.all()).toHaveLength(1);
    });

    it('legitimacy 24 whole points: 5000 + 24*20 = 5480 -- just below the boundary, does not declare', () => {
      const g = readyCharGraph('24');
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:mair', 'inst:crown')).toBeUndefined();
      expect(em.all()).toHaveLength(0);
      expect(hashValue(post)).toBe(hashValue(g)); // untouched
    });

    it('claimNudge (T4 prop; read defensively -- 0 when absent) adds directly into the effective score: 4700 + 800 = 5500 exactly', () => {
      let g = crownGraph('0');
      g = addNode(g, {
        id: 'char:nudged', type: 'character',
        props: { name: 'Nudged', claimCircle: true, claimBp: 1000, wantChain: ['pardon'], wantIndex: 1, claimNudge: 800 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:nudged', dst: 'char:ruler', props: { bp: 4700 } });
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:nudged', 'inst:crown')).toBeDefined();
    });

    // Controller adjudication (2026-08-27, post-review): declaring requires
    // an ACTUAL loyalty edge -- no default-5000 qualification. This
    // supersedes an earlier version of this test that pinned the opposite
    // (a no-edge character defaulting to neutral 5000 and declaring); that
    // reading was the exact bug the controller's fix closes (see the
    // "the departed-re-declare repro" test below for the real-mechanism
    // version of this same concern).
    it('no loyalty edge at all: ineligible regardless of legitimacy -- the absent-edge default no longer qualifies a declaration', () => {
      let g = crownGraph('25'); // 25*20=500 -- would have bridged a 5000 default to exactly 5500 under the old (buggy) behavior
      g = addNode(g, {
        id: 'char:noedge', type: 'character',
        props: { name: 'No Edge', claimCircle: true, claimBp: 500, wantChain: ['coin'], wantIndex: 1 },
      });
      // No loyalty edge added at all -- not even a low-bp one.
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:noedge', 'inst:crown')).toBeUndefined();
      expect(em.all()).toHaveLength(0);
      expect(hashValue(post)).toBe(hashValue(g));
    });
  });

  // Controller adjudication (2026-08-27, post-review): two exclusions closed
  // after the initial implementation was reviewed. (1) Declaring requires an
  // ACTUAL loyalty edge to the ruler -- a departed character (departureDeltas
  // cuts their loyalty edge) must never re-declare via the absent-edge
  // default. (2) An imprisoned circle character never declares -- a cell is
  // not a court -- but the exclusion is TEMPORARY: pardoning clears it.
  describe('exclusions: no loyalty edge, and imprisonment (controller adjudication, 2026-08-27)', () => {
    it('the departed-re-declare repro: a character who departs (real departureDeltas removal, via advanceCharacterArcs) never freshly declares afterward, even with legitimacy high enough to have bridged the old neutral-default bug', () => {
      // legitimacy 30 -- 30*20=600; 5000 (the old buggy default) + 600 =
      // 5600 >= 5500 would have wrongly declared this character under the
      // pre-fix code. wantChain has a SECOND, still-outstanding want
      // ('office') so the restless arc doesn't auto-retain on a null
      // currentWant (arcs.ts retains immediately once a character is fully
      // sated) -- 'coin' is already fulfilled (wantIndex 1), satisfying
      // declarationStep's price-answered condition on its own.
      let g = crownGraph('30');
      g = addNode(g, { id: 'char:rival', type: 'character', props: { name: 'Rival' } });
      g = addNode(g, {
        id: 'char:deserter', type: 'character',
        props: { name: 'Deserter', claimCircle: true, claimBp: 1800, wantChain: ['coin', 'office'], wantIndex: 1 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:deserter', dst: 'char:ruler', props: { bp: 4000 } }); // low true loyalty -- restless-eligible

      // Drive a REAL departure through advanceCharacterArcs -- the actual
      // mechanism that cuts the loyalty edge, not a hand-waved "no edge"
      // fixture -- confirming the repro end to end.
      const arcs: Record<string, CharacterArc> = { 'restless:char:deserter': { kind: 'restless', charId: 'char:deserter', stage: 2, sinceTick: 6 } };
      const departResult = advanceCharacterArcs(g, 9, arcs, makeEmitter(9), 'char:rival'); // (9-6)>=3 -- stage 3, terminal
      expect(departResult.g.nodes['char:deserter']?.props['inRivalCourt']).toBe(true); // confirms departure actually fired
      expect(findEdge(departResult.g, 'loyalty', 'char:deserter', 'char:ruler')).toBeUndefined(); // confirms the edge really is gone

      const em = makeEmitter(10);
      const post = declarationStep(departResult.g, 10, em);
      expect(findEdge(post, 'backing', 'char:deserter', 'inst:crown')).toBeUndefined();
      expect(em.all()).toHaveLength(0);
      expect(hashValue(post)).toBe(hashValue(departResult.g));
    });

    it('an imprisoned circle character does not declare even with a fulfilled want and ample loyalty; pardoning (the real op) lifts the exclusion and they declare on a later tick -- proving it is temporary, not permanent', () => {
      let g = crownGraph('0');
      g = addNode(g, {
        id: 'char:cell', type: 'character',
        props: { name: 'In the Cell', claimCircle: true, claimBp: 900, wantChain: ['coin'], wantIndex: 1, imprisoned: true },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:cell', dst: 'char:ruler', props: { bp: 6000 } });

      const em1 = makeEmitter(1);
      const stillImprisoned = declarationStep(g, 1, em1);
      expect(findEdge(stillImprisoned, 'backing', 'char:cell', 'inst:crown')).toBeUndefined();
      expect(em1.all()).toHaveLength(0);
      expect(hashValue(stillImprisoned)).toBe(hashValue(g));

      // Pardon via the real 'pardon' op (ops.ts), not a hand-set prop --
      // exercises the actual mechanism a player would use to lift this.
      const pardoned = applyOp(stillImprisoned, { kind: 'pardon', charId: 'char:cell' }, 2, makeEmitter(2), 'seat:throne');
      expect(getNode(pardoned, 'char:cell').props['imprisoned']).toBe(false);

      const em2 = makeEmitter(3);
      const post = declarationStep(pardoned, 3, em2);
      expect(findEdge(post, 'backing', 'char:cell', 'inst:crown')).toBeDefined();
      expect(em2.all()).toHaveLength(1);
      expect(em2.all()[0]?.type).toBe('claim.declared');
    });
  });

  // (c) unfulfilled want + no pledge -> no declaration, regardless of loyalty.
  it('(c) unfulfilled want, no pledge: no declaration despite loyalty far above threshold', () => {
    let g = crownGraph('0');
    g = addNode(g, {
      id: 'char:brann', type: 'character',
      props: { name: 'Brann', claimCircle: true, claimBp: 1500, wantChain: ['holding'], wantIndex: 0 }, // never fulfilled anything yet
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:brann', dst: 'char:ruler', props: { bp: 9000 } }); // far above DECLARE_LOYALTY
    const em = makeEmitter(1);
    const post = declarationStep(g, 1, em);
    expect(findEdge(post, 'backing', 'char:brann', 'inst:crown')).toBeUndefined();
    expect(em.all()).toHaveLength(0);
    expect(hashValue(post)).toBe(hashValue(g));
  });

  // The promise-edge OR-branch, hand-built per the task brief's instruction
  // (Task 2's `pledge` op is the only real producer; not built yet).
  describe('the promise-edge OR-branch (hand-built edges -- Task 2 mints these for real)', () => {
    it('unfulfilled want BUT an unbroken promise names the CURRENT want: declares, viaPromise = the promise edge id', () => {
      let g = crownGraph('0');
      g = addNode(g, {
        id: 'char:tam', type: 'character',
        props: { name: 'Old Tam', claimCircle: true, claimBp: 1200, wantChain: ['holding'], wantIndex: 0 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:tam', dst: 'char:ruler', props: { bp: 6000 } });
      g = addEdge(g, {
        type: 'promise', src: 'inst:crown', dst: 'char:tam',
        props: { wantKey: 'holding', madeAt: 0, dueOn: 'restoration', broken: false },
      });
      const promiseId = edgeId('promise', 'inst:crown', 'char:tam');

      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      const edge = findEdge(post, 'backing', 'char:tam', 'inst:crown');
      expect(edge?.props).toEqual({ declaredAt: 1, bp: 1200, viaPromise: promiseId });
      expect(em.all()[0]?.data).toEqual({ charId: 'char:tam', bp: 1200, viaPromise: promiseId });
    });

    // Controller adjudication (2026-08-27, second review pass), overruling
    // the first pass's "stamp viaPromise whenever a valid promise exists"
    // choice: per the project's attribution-honesty precedent (a cause
    // named must be TRUE -- viaPromise is read downstream as "the promise
    // is WHY they declared," and Stage 2 will collect on it as an
    // obligation), viaPromise is stamped ONLY when the promise is the
    // OPERATIVE qualifier -- pledged AND NOT already want-fulfilled. A
    // character whose want is genuinely fulfilled declares via THAT path,
    // full stop, even if an unrelated live promise also happens to name
    // their current want -- the fulfillment, not the promise, is why they
    // declared, so viaPromise must read '' (contrast with the pure-promise
    // companion test just above, where wantIndex is 0 and the promise
    // really is the only reason).
    it('overlap: wantIndex > 0 (a want already fulfilled) AND a valid live promise for the CURRENT want -- declares via the fulfilled-want path; viaPromise stays "" because the promise was not the operative qualifier', () => {
      let g = crownGraph('0');
      g = addNode(g, {
        id: 'char:both', type: 'character',
        // 'coin' already fulfilled (wantIndex 1 -- anyWantFulfilled true on
        // its own); 'office' is the current want, still outstanding.
        props: { name: 'Both Paths', claimCircle: true, claimBp: 1400, wantChain: ['coin', 'office'], wantIndex: 1 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:both', dst: 'char:ruler', props: { bp: 6000 } });
      // A live, valid, unbroken promise naming the CURRENT want -- would
      // satisfy the promise branch on its own, but is not needed here and
      // must not be credited.
      g = addEdge(g, {
        type: 'promise', src: 'inst:crown', dst: 'char:both',
        props: { wantKey: 'office', madeAt: 0, dueOn: 'restoration', broken: false },
      });

      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      const edge = findEdge(post, 'backing', 'char:both', 'inst:crown');
      expect(edge).toBeDefined(); // still declares -- the fulfilled-want path alone qualifies
      expect(edge?.props).toEqual({ declaredAt: 1, bp: 1400, viaPromise: '' });
      expect(em.all()[0]?.data).toEqual({ charId: 'char:both', bp: 1400, viaPromise: '' });
    });

    it('a BROKEN promise (broken: true) does not satisfy the price-answered condition', () => {
      let g = crownGraph('0');
      g = addNode(g, {
        id: 'char:tam2', type: 'character',
        props: { name: 'Old Tam II', claimCircle: true, claimBp: 1200, wantChain: ['holding'], wantIndex: 0 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:tam2', dst: 'char:ruler', props: { bp: 6000 } });
      g = addEdge(g, {
        type: 'promise', src: 'inst:crown', dst: 'char:tam2',
        props: { wantKey: 'holding', madeAt: 0, dueOn: 'restoration', broken: true },
      });
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:tam2', 'inst:crown')).toBeUndefined();
    });

    it('a promise naming a want OTHER than the current one does not satisfy the condition', () => {
      let g = crownGraph('0');
      g = addNode(g, {
        id: 'char:tam3', type: 'character',
        props: { name: 'Old Tam III', claimCircle: true, claimBp: 1200, wantChain: ['holding'], wantIndex: 0 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:tam3', dst: 'char:ruler', props: { bp: 6000 } });
      g = addEdge(g, {
        type: 'promise', src: 'inst:crown', dst: 'char:tam3',
        props: { wantKey: 'coin', madeAt: 0, dueOn: 'restoration', broken: false }, // current want is 'holding', not 'coin'
      });
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:tam3', 'inst:crown')).toBeUndefined();
    });

    it('a promise edge pointing the wrong direction (char -> inst:crown, not inst:crown -> char) is not recognized', () => {
      let g = crownGraph('0');
      g = addNode(g, {
        id: 'char:tam4', type: 'character',
        props: { name: 'Old Tam IV', claimCircle: true, claimBp: 1200, wantChain: ['holding'], wantIndex: 0 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:tam4', dst: 'char:ruler', props: { bp: 6000 } });
      g = addEdge(g, {
        type: 'promise', src: 'char:tam4', dst: 'inst:crown', // reversed src/dst
        props: { wantKey: 'holding', madeAt: 0, dueOn: 'restoration', broken: false },
      });
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:tam4', 'inst:crown')).toBeUndefined();
    });
  });

  // (d) non-circle characters never declare, in every combination of a
  // missing claimCircle/claimBp mark -- the circle definition is an AND of
  // both, not either alone.
  describe('(d) non-circle characters never declare', () => {
    it('no claimCircle/claimBp at all: untouched even with a fulfilled want and generous legitimacy + loyalty', () => {
      let g = crownGraph('50');
      g = addNode(g, { id: 'char:outsider', type: 'character', props: { name: 'Outsider', wantChain: ['coin'], wantIndex: 1 } });
      g = addEdge(g, { type: 'loyalty', src: 'char:outsider', dst: 'char:ruler', props: { bp: 9000 } });
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:outsider', 'inst:crown')).toBeUndefined();
      expect(em.all()).toHaveLength(0);
      expect(hashValue(post)).toBe(hashValue(g));
    });

    it('claimCircle true but claimBp missing: the AND requires both -- never declares', () => {
      let g = crownGraph('50');
      g = addNode(g, {
        id: 'char:half', type: 'character',
        props: { name: 'Half-Marked', claimCircle: true, wantChain: ['coin'], wantIndex: 1 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:half', dst: 'char:ruler', props: { bp: 9000 } });
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:half', 'inst:crown')).toBeUndefined();
    });

    it('claimBp present but claimCircle is false: never declares', () => {
      let g = crownGraph('50');
      g = addNode(g, {
        id: 'char:half2', type: 'character',
        props: { name: 'Half-Marked II', claimCircle: false, claimBp: 1000, wantChain: ['coin'], wantIndex: 1 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:half2', dst: 'char:ruler', props: { bp: 9000 } });
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:half2', 'inst:crown')).toBeUndefined();
    });

    it('claimBp present as a non-number (a content-authoring slip): never declares', () => {
      let g = crownGraph('50');
      g = addNode(g, {
        id: 'char:half3', type: 'character',
        props: { name: 'Half-Marked III', claimCircle: true, claimBp: 'a lot' as unknown as number, wantChain: ['coin'], wantIndex: 1 },
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:half3', dst: 'char:ruler', props: { bp: 9000 } });
      const em = makeEmitter(1);
      const post = declarationStep(g, 1, em);
      expect(findEdge(post, 'backing', 'char:half3', 'inst:crown')).toBeUndefined();
    });
  });

  // (e) an already-declared character is never re-processed.
  it('(e) an already-declared character is never re-processed -- byte-identical graph, no new event', () => {
    let g = crownGraph('0');
    g = addNode(g, {
      id: 'char:done', type: 'character',
      props: { name: 'Already Declared', claimCircle: true, claimBp: 4000, wantChain: ['coin'], wantIndex: 1 },
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:done', dst: 'char:ruler', props: { bp: 6000 } });
    // Hand-built backing edge from an earlier tick, isolating this test to
    // the re-processing guard alone (not to whether declarationStep itself
    // would have produced this edge).
    g = addEdge(g, { type: 'backing', src: 'char:done', dst: 'inst:crown', props: { declaredAt: 3, bp: 4000, viaPromise: '' } });
    const before = g;

    const em = makeEmitter(10);
    const post = declarationStep(g, 10, em);
    expect(em.all()).toHaveLength(0);
    expect(hashValue(post)).toBe(hashValue(before)); // not even re-stamped
  });

  // (g) determinism + order-stable multi-char processing.
  it('(g) order-stable + deterministic: two eligible circle characters emit claim.declared in sorted charId order, byte-identical across two independent calls', () => {
    let g = crownGraph('0');
    g = addNode(g, {
      id: 'char:zed', type: 'character', // sorts AFTER char:anna
      props: { name: 'Zed', claimCircle: true, claimBp: 1000, wantChain: ['coin'], wantIndex: 1 },
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:zed', dst: 'char:ruler', props: { bp: 6000 } });
    g = addNode(g, {
      id: 'char:anna', type: 'character', // sorts BEFORE char:zed
      props: { name: 'Anna', claimCircle: true, claimBp: 2000, wantChain: ['office'], wantIndex: 1 },
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:anna', dst: 'char:ruler', props: { bp: 6000 } });

    const emA = makeEmitter(5);
    const gA = declarationStep(g, 5, emA);
    const emB = makeEmitter(5);
    const gB = declarationStep(g, 5, emB);

    expect(hashValue(gA)).toBe(hashValue(gB));
    expect(emA.all().map((e) => ({ type: e.type, data: e.data }))).toEqual(emB.all().map((e) => ({ type: e.type, data: e.data })));

    const declaredIds = emA.all().map((e) => (e.data as { charId: string }).charId);
    expect(declaredIds).toEqual(['char:anna', 'char:zed']); // sorted node-id order, not insertion order

    const replayed = applyDeltas(g, emA.all().flatMap((e) => e.deltas));
    expect(hashValue(replayed)).toBe(hashValue(gA));
  });

  // Wiring: declarationStep is actually invoked as part of resolveTick.
  describe('wired into resolveTick', () => {
    it('a circle character whose price is already answered declares on the very first tick processed', () => {
      let g = emptyGraph();
      g = addNode(g, {
        id: 'inst:crown', type: 'institution',
        props: { treasury: fx('300'), legitimacy: fx('30'), arrears: fx('0'), rulerCharId: 'char:ruler' },
      });
      g = addNode(g, {
        id: 'place:ash', type: 'place',
        props: {
          name: 'Ash', population: fx('100'), granary: fx('250'), farmland: fx('10'),
          unrest: fx('10'), dole: fx('0'), taxRateBp: 1000, roadsBonusBp: 0, defenseBp: 0,
          famineStage: 0, famineEndsAt: 0, levy: fx('0'),
        },
      });
      g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'Ruler' } });
      g = addNode(g, {
        id: 'char:x', type: 'character',
        props: { name: 'X', claimCircle: true, claimBp: 3000, wantChain: ['coin'], wantIndex: 1 }, // sated -- price already answered
      });
      g = addEdge(g, { type: 'loyalty', src: 'char:x', dst: 'char:ruler', props: { bp: 5300 } }); // 5300 + 30*20(600) = 5900 >= 5500

      const season: SeasonConfig = {
        seasonId: 'claim-wiring-test',
        startTier: 1,
        initialGraph: g,
        decks: [{
          id: 'claim-deck', tier: 1,
          storylets: [{
            id: 'claim.probe', kind: 'brief', tier: 1, cooldownTicks: 1, once: false,
            pattern: { nodes: [{ as: 'p', type: 'place' }] },
            title: 'Probe', body: 'Probe body',
            options: [{ id: 'skip', label: 'Skip', ops: [] }],
            defaultOptionId: 'skip',
          }],
        }],
        tiers: { 1: { deckIds: ['claim-deck'], briefBudget: 1, attentionSlots: 1 } },
        calendar: [],
        tierRules: [],
        throne: { id: 'seat:throne', kind: 'throne', bodyCharId: 'char:ruler', attentionSlots: 1, fidelity: 'external' },
        reporters: [],
        primaryPlaceId: 'place:ash',
      };
      const f = makeFortune('claim-wiring');
      const out = resolveTick(season, initialState(season), { seatId: 'seat:throne', choices: [] }, f);
      expect(out.events.some((e) => e.type === 'claim.declared')).toBe(true);
      expect(findEdge(out.state.graph, 'backing', 'char:x', 'inst:crown')).toBeDefined();
    });

    it('a plain reign with no claimCircle marks anywhere is completely untouched by declarationStep (zero behavior moves for existing content)', () => {
      let g = emptyGraph();
      g = addNode(g, {
        id: 'inst:crown', type: 'institution',
        props: { treasury: fx('300'), legitimacy: fx('80'), arrears: fx('0'), rulerCharId: 'char:ruler' },
      });
      g = addNode(g, {
        id: 'place:ash', type: 'place',
        props: {
          name: 'Ash', population: fx('100'), granary: fx('250'), farmland: fx('10'),
          unrest: fx('10'), dole: fx('0'), taxRateBp: 1000, roadsBonusBp: 0, defenseBp: 0,
          famineStage: 0, famineEndsAt: 0, levy: fx('0'),
        },
      });
      g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'Ruler' } });
      g = addNode(g, { id: 'char:plain', type: 'character', props: { name: 'Plain', wantChain: ['coin'], wantIndex: 1 } });
      g = addEdge(g, { type: 'loyalty', src: 'char:plain', dst: 'char:ruler', props: { bp: 9000 } }); // huge loyalty, no circle mark

      const season: SeasonConfig = {
        seasonId: 'claim-no-circle-test',
        startTier: 1,
        initialGraph: g,
        decks: [],
        tiers: { 1: { deckIds: [], briefBudget: 1, attentionSlots: 1 } },
        calendar: [],
        tierRules: [],
        throne: { id: 'seat:throne', kind: 'throne', bodyCharId: 'char:ruler', attentionSlots: 1, fidelity: 'external' },
        reporters: [],
        primaryPlaceId: 'place:ash',
      };
      const f = makeFortune('claim-no-circle');
      const out = resolveTick(season, initialState(season), { seatId: 'seat:throne', choices: [] }, f);
      expect(out.events.some((e) => e.type === 'claim.declared')).toBe(false);
      expect(findEdge(out.state.graph, 'backing', 'char:plain', 'inst:crown')).toBeUndefined();
    });
  });
});

// (f) arc departure withdraws an existing backing edge (extends the same
// departure lifecycle test/arcs.test.ts's own suite covers, with a claim-
// circle character carrying a pre-existing backing edge).
describe('arc departure withdraws an existing backing edge (claim §1)', () => {
  function departingCircleGraph(loyaltyBp: number): WorldGraph {
    let g = emptyGraph();
    g = addNode(g, {
      id: 'inst:crown', type: 'institution',
      props: { treasury: fx('300'), legitimacy: fx('50'), arrears: fx('0'), rulerCharId: 'char:ruler' },
    });
    g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'Ruler' } });
    g = addNode(g, { id: 'char:rival', type: 'character', props: { name: 'Rival' } });
    g = addNode(g, {
      id: 'char:x', type: 'character',
      props: { name: 'X', claimCircle: true, claimBp: 2500, wantChain: ['coin'], wantIndex: 0 },
    });
    g = addEdge(g, { type: 'loyalty', src: 'char:x', dst: 'char:ruler', props: { bp: loyaltyBp } });
    // Already declared, by whatever means (hand-built -- isolates this test
    // to departure's own removal logic, not to declarationStep itself).
    g = addEdge(g, { type: 'backing', src: 'char:x', dst: 'inst:crown', props: { declaredAt: 1, bp: 2500, viaPromise: '' } });
    return g;
  }

  it('stage-3 departure removes the backing edge alongside the loyalty edge, delta-carried on arc.departed, replay-equivalent', () => {
    const g = departingCircleGraph(4000); // low true loyalty -- restless-arc eligible
    const arcs: Record<string, CharacterArc> = { 'restless:char:x': { kind: 'restless', charId: 'char:x', stage: 2, sinceTick: 6 } };
    const pre = g;
    const em = makeEmitter(9); // (9 - 6) >= STAGE_ADVANCE_TICKS(3) -- stage 3, terminal
    const out = advanceCharacterArcs(g, 9, arcs, em, 'char:rival');

    expect(findEdge(out.g, 'backing', 'char:x', 'inst:crown')).toBeUndefined();
    expect(findEdge(out.g, 'loyalty', 'char:x', 'char:ruler')).toBeUndefined();
    const ev = em.all().find((e) => e.type === 'arc.departed');
    expect(ev).toBeDefined();
    expect(ev?.data).toEqual({ charId: 'char:x', toId: 'char:rival' });
    expect(ev?.deltas).toContainEqual({ op: 'edge.remove', id: edgeId('backing', 'char:x', 'inst:crown') });
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(out.g));
  });

  it('departureDeltas is existence-guarded: a departing character with no backing edge emits no edge.remove for one', () => {
    let g = emptyGraph();
    g = addNode(g, {
      id: 'inst:crown', type: 'institution',
      props: { treasury: fx('300'), legitimacy: fx('50'), arrears: fx('0'), rulerCharId: 'char:ruler' },
    });
    g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'Ruler' } });
    g = addNode(g, { id: 'char:rival', type: 'character', props: { name: 'Rival' } });
    g = addNode(g, { id: 'char:y', type: 'character', props: { name: 'Y', wantChain: ['coin'], wantIndex: 0 } }); // not a circle char, no backing edge
    g = addEdge(g, { type: 'loyalty', src: 'char:y', dst: 'char:ruler', props: { bp: 4000 } });
    const arcs: Record<string, CharacterArc> = { 'restless:char:y': { kind: 'restless', charId: 'char:y', stage: 2, sinceTick: 6 } };
    const em = makeEmitter(9);
    const out = advanceCharacterArcs(g, 9, arcs, em, 'char:rival');
    const departedEv = em.all().find((e) => e.type === 'arc.departed');
    expect(departedEv).toBeDefined();
    expect(departedEv?.deltas.some((d) => d.op === 'edge.remove' && d.id.startsWith('backing:'))).toBe(false);
  });

  it('a declared character can still be marked restless (true loyalty and effective loyalty diverge) and later departs, withdrawing the declaration', () => {
    // A backer whose TRUE loyalty (used by arcs.ts) is low but whose
    // EFFECTIVE loyalty (declarationStep's own formula, boosted by
    // legitimacy) cleared DECLARE_LOYALTY -- the exact shape the plan's
    // "false stone" mechanic (Task 3) is built around. Proves the two
    // mechanisms coexist without contradiction: declared now, gone later.
    let g = departingCircleGraph(3000);
    let arcs: Record<string, CharacterArc> = {};
    let em = makeEmitter(6);
    let out = advanceCharacterArcs(g, 6, arcs, em, 'char:rival'); // arms restless (loyalty 3000 < 4500 ceiling)
    g = out.g;
    arcs = out.arcs;
    expect(arcs['restless:char:x']?.stage).toBe(1);
    expect(findEdge(g, 'backing', 'char:x', 'inst:crown')).toBeDefined(); // still declared -- backing is untouched by arming/stage-1/2

    em = makeEmitter(9);
    out = advanceCharacterArcs(g, 9, arcs, em, 'char:rival'); // stage 2
    g = out.g;
    arcs = out.arcs;
    expect(findEdge(g, 'backing', 'char:x', 'inst:crown')).toBeDefined(); // still declared through stage 2

    em = makeEmitter(12);
    out = advanceCharacterArcs(g, 12, arcs, em, 'char:rival'); // stage 3: departs
    g = out.g;
    expect(findEdge(g, 'backing', 'char:x', 'inst:crown')).toBeUndefined(); // withdrawn on departure
  });
});
