// Character arcs (spec §5, T8): the famine-arc machinery (scheduler.ts's
// advanceArcs) generalized to people. A neglected character with an unmet
// want and thin loyalty grows RESTLESS (stage 1); left unanswered for two
// more three-tick spans, the disaffection becomes legible to a rival
// (stage 2 -- arc.poach.bid, informational only) and then irreversible
// (stage 3 -- arc.departed: the loyalty edge to the ruler is cut, the
// character crosses to the rival's court, but -- spec §12 -- REMAINS IN
// THE GRAPH). Fulfilling the want or winning back loyalty at any point
// before stage 3 RETAINS the character instead (arc.retained) and the arc
// closes clean.
//
// D14: every stage mutation is a GraphDelta[] applied through applyDeltas
// and carried on its emitted event, exactly like advanceArcs's famine
// lifecycle -- see test/scheduler.test.ts's "advanceArcs" describe block,
// which this file's main lifecycle test mirrors: per-call delta-replay
// (replaying each call's own emitted deltas onto that call's pre-graph
// reproduces its actual return value), asserted after every stage, not
// just once at the end.
import { describe, expect, it } from 'vitest';
import { canonJson, hashValue } from '../src/canon.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { fx } from '../src/fx.js';
import { makeFortune } from '../src/fortune.js';
import { addEdge, addNode, edgeId, emptyGraph, findEdge, getNode, setEdgeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import type { CharacterArc } from '../src/arcs.js';
import { applyMediatedOp } from '../src/mediate.js';
import { advanceCharacterArcs } from '../src/arcs.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { ReignState, SeasonConfig } from '../src/tick.js';

// A minimal fixture: crown + ruler + one place (place needed only by the
// resolveTick-driven tests below, harmless for the direct-call ones) +
// char:x carrying a one-element wantChain ('coin', unfulfilled) + a
// loyalty edge to the ruler at the given bp. char:rival exists as a real
// node too (even though advanceCharacterArcs never dereferences rivalId --
// it's carried purely as opaque event data) so nothing here depends on
// that implementation detail.
function withRestlessCandidate(loyaltyBp = 4000): WorldGraph {
  let g = emptyGraph();
  g = addNode(g, {
    id: 'inst:crown', type: 'institution',
    props: { treasury: fx('300'), legitimacy: fx('50'), arrears: fx('0'), rulerCharId: 'char:ruler' },
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
  g = addNode(g, { id: 'char:rival', type: 'character', props: { name: 'Rival' } });
  g = addNode(g, { id: 'char:x', type: 'character', props: { name: 'X', wantChain: ['coin'], wantIndex: 0 } });
  g = addEdge(g, { type: 'loyalty', src: 'char:x', dst: 'char:ruler', props: { bp: loyaltyBp } });
  return g;
}

// One trivially-matching storylet (place:ash always qualifies) so
// resolveTick-driven tests get a pending brief to attach a directive
// choice to -- the same idiom test/wants.test.ts's wantSeason/firstBrief
// use, since the storylet's own options are never exercised (every such
// test attends via directive ops instead).
function arcSeason(graph: WorldGraph, rivalId?: string): SeasonConfig {
  return {
    seasonId: 'arcs-test',
    startTier: 1,
    initialGraph: graph,
    decks: [{
      id: 'arcs-deck', tier: 1,
      storylets: [{
        id: 'arcs.probe', kind: 'brief', tier: 1, cooldownTicks: 1, once: false,
        pattern: { nodes: [{ as: 'p', type: 'place' }] },
        title: 'Probe', body: 'Probe body',
        options: [{ id: 'skip', label: 'Skip', ops: [] }],
        defaultOptionId: 'skip',
      }],
    }],
    tiers: { 1: { deckIds: ['arcs-deck'], briefBudget: 1, attentionSlots: 1 } },
    calendar: [],
    tierRules: [],
    throne: { id: 'seat:throne', kind: 'throne', bodyCharId: 'char:ruler', attentionSlots: 1, fidelity: 'external' },
    reporters: [],
    primaryPlaceId: 'place:ash',
    rivalId,
  };
}

describe('advanceCharacterArcs', () => {
  it('arms on sustained neglect, bids at stage 2, departs at stage 3 -- delta-replay after every call', () => {
    let g = withRestlessCandidate(4000);
    let arcs: Record<string, CharacterArc> = {};
    const RIVAL = 'char:rival';

    // tick 5: (5 - 0) < 6 -- not yet due. Exact-boundary pin: one tick short.
    let pre = g;
    let em = makeEmitter(5);
    let out = advanceCharacterArcs(g, 5, arcs, em, RIVAL);
    g = out.g;
    arcs = out.arcs;
    expect(em.all()).toHaveLength(0);
    expect(arcs).toEqual({});
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    // tick 6: (6 - 0) >= 6 and loyalty 4000 < 4500 -- arms at stage 1.
    pre = g;
    em = makeEmitter(6);
    out = advanceCharacterArcs(g, 6, arcs, em, RIVAL);
    g = out.g;
    arcs = out.arcs;
    expect(em.all()).toHaveLength(1);
    expect(em.all()[0]?.type).toBe('arc.restless');
    expect(em.all()[0]?.data).toEqual({ charId: 'char:x', wantKey: 'coin' });
    expect(getNode(g, 'char:x').props['arc:restless']).toBe(true);
    expect(arcs['restless:char:x']).toEqual({ kind: 'restless', charId: 'char:x', stage: 1, sinceTick: 6 });
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    // tick 8: (8 - 6) < 3 -- not yet due to advance. Exact-boundary pin.
    pre = g;
    em = makeEmitter(8);
    out = advanceCharacterArcs(g, 8, arcs, em, RIVAL);
    g = out.g;
    arcs = out.arcs;
    expect(em.all()).toHaveLength(0);
    expect(arcs['restless:char:x']?.stage).toBe(1);
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    // tick 9: (9 - 6) >= 3 -- advances to stage 2: a poach bid, targeting the CURRENT want.
    pre = g;
    em = makeEmitter(9);
    out = advanceCharacterArcs(g, 9, arcs, em, RIVAL);
    g = out.g;
    arcs = out.arcs;
    expect(em.all()).toHaveLength(1);
    expect(em.all()[0]?.type).toBe('arc.poach.bid');
    expect(em.all()[0]?.data).toEqual({ charId: 'char:x', byId: RIVAL, offeredWant: 'coin' });
    expect(em.all()[0]?.deltas).toEqual([]); // informational only -- no graph mutation
    expect(arcs['restless:char:x']).toEqual({ kind: 'restless', charId: 'char:x', stage: 2, sinceTick: 9 });
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    // tick 12: (12 - 9) >= 3 -- advances to stage 3: DEPARTURE (terminal).
    pre = g;
    em = makeEmitter(12);
    out = advanceCharacterArcs(g, 12, arcs, em, RIVAL);
    g = out.g;
    arcs = out.arcs;
    expect(em.all()).toHaveLength(1);
    expect(em.all()[0]?.type).toBe('arc.departed');
    expect(em.all()[0]?.data).toEqual({ charId: 'char:x', toId: RIVAL });
    expect(findEdge(g, 'loyalty', 'char:x', 'char:ruler')).toBeUndefined(); // loyalty edge cut
    expect(getNode(g, 'char:x').props['inRivalCourt']).toBe(true);
    expect(getNode(g, 'char:x').props['arc:restless']).toBe(false);
    expect(arcs['restless:char:x']).toBeUndefined(); // arc closed out of state
    expect(g.nodes['char:x']).toBeDefined(); // spec §12: departed characters remain in the graph
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));
  });

  it('retention by loyalty: recovering past the floor retains, preempting a stage advance that would otherwise be due', () => {
    let g = withRestlessCandidate(4000);
    let arcs: Record<string, CharacterArc> = {};
    let em = makeEmitter(6);
    let out = advanceCharacterArcs(g, 6, arcs, em); // arms, stage 1, sinceTick 6 -- no rival needed for this test
    g = out.g;
    arcs = out.arcs;
    expect(arcs['restless:char:x']?.stage).toBe(1);

    // Loyalty recovers to the retention floor via whatever mechanism (a real
    // op elsewhere in the pipeline, e.g. pardon/grant/send_envoy) -- exercised
    // directly on the fixture here since retention's own trigger doesn't care
    // HOW loyalty got there, only where it stands.
    g = setEdgeProp(g, edgeId('loyalty', 'char:x', 'char:ruler'), 'bp', 5500);

    const pre = g;
    em = makeEmitter(9); // (9 - 6) >= 3 -- stage advance WOULD fire if retention didn't preempt it
    out = advanceCharacterArcs(g, 9, arcs, em);
    g = out.g;
    arcs = out.arcs;
    expect(em.all()).toHaveLength(1);
    expect(em.all()[0]?.type).toBe('arc.retained');
    expect(em.all()[0]?.data).toEqual({ charId: 'char:x' });
    expect(getNode(g, 'char:x').props['arc:restless']).toBe(false);
    expect(arcs['restless:char:x']).toBeUndefined();
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));
  });

  // Pre-Task-9, this pinned "arcs.ts doesn't know how to process 'scheme'
  // yet, so a pre-existing scheme-kind arc is inert no matter its stage" --
  // hence the original fixture's synthetic stage: 5 (a value no real
  // lifecycle would ever reach), chosen specifically to prove indifference.
  // Task 9 now processes 'scheme' arcs for real (test/apparatus.test.ts
  // owns that machinery's own coverage), so stage: 5 would now hit the
  // terminal (stage >= 3) strike branch instead of staying untouched --
  // that was always this test's own forward-reference ("Task 9 territory").
  // Updated to a REALISTIC not-yet-due scheme arc (stage 1, sinceTick ==
  // this call's own tick -- 0 ticks elapsed, short of
  // SCHEME_STAGE_ADVANCE_TICKS) so it is untouched for the correct reason
  // (not due this tick), while still proving restless/scheme independence:
  // the SAME call arms char:x's restless slot without disturbing the
  // scheme slot at all.
  it('a pre-existing scheme-kind arc not yet due for a stage advance is left untouched -- restless and scheme are independent per-character slots', () => {
    const g = withRestlessCandidate(4000);
    const arcs: Record<string, CharacterArc> = {
      'scheme:char:x': { kind: 'scheme', charId: 'char:x', stage: 1, sinceTick: 6 },
    };
    const em = makeEmitter(6); // arm-eligible tick for the independent 'restless' slot; 0 ticks since the scheme arc's own sinceTick
    const out = advanceCharacterArcs(g, 6, arcs, em);
    expect(out.arcs['scheme:char:x']).toEqual({ kind: 'scheme', charId: 'char:x', stage: 1, sinceTick: 6 }); // untouched
    expect(out.arcs['restless:char:x']).toEqual({ kind: 'restless', charId: 'char:x', stage: 1, sinceTick: 6 }); // arms independently
    expect(em.all().map((e) => e.type)).toEqual(['arc.restless']); // the scheme arc wasn't due, so it emitted nothing this tick
  });

  describe('no-rival variant', () => {
    it('stage still advances without a poach bid; departure toId is null', () => {
      let g = withRestlessCandidate(4000);
      let arcs: Record<string, CharacterArc> = {};
      let em = makeEmitter(6);
      let out = advanceCharacterArcs(g, 6, arcs, em); // rivalId omitted throughout
      g = out.g;
      arcs = out.arcs;

      em = makeEmitter(9);
      out = advanceCharacterArcs(g, 9, arcs, em);
      g = out.g;
      arcs = out.arcs;
      expect(em.all()).toHaveLength(0); // no bid: informational event needs a rival to address
      expect(arcs['restless:char:x']?.stage).toBe(2);

      em = makeEmitter(12);
      out = advanceCharacterArcs(g, 12, arcs, em);
      g = out.g;
      arcs = out.arcs;
      expect(em.all()).toHaveLength(1);
      expect(em.all()[0]?.type).toBe('arc.departed');
      expect(em.all()[0]?.data).toEqual({ charId: 'char:x', toId: null });
    });
  });

  describe('determinism', () => {
    it('running the same inputs twice produces identical events and returned state', () => {
      const g = withRestlessCandidate(4000);
      const arcs: Record<string, CharacterArc> = {};
      const em1 = makeEmitter(6);
      const out1 = advanceCharacterArcs(g, 6, arcs, em1, 'char:rival');
      const em2 = makeEmitter(6);
      const out2 = advanceCharacterArcs(g, 6, arcs, em2, 'char:rival');
      expect(canonJson(em1.all())).toBe(canonJson(em2.all()));
      expect(hashValue(out1.g)).toBe(hashValue(out2.g));
      expect(canonJson(out1.arcs)).toBe(canonJson(out2.arcs));
    });
  });
});

describe('character arcs wired into resolveTick', () => {
  it('retention by fulfillment: a real grant op mid-arc fulfills the want and retains the character through the real pipeline', () => {
    const g = withRestlessCandidate(4000);
    const season = arcSeason(g);
    // Seed an already-armed arc (stage 1, sinceTick 6) directly into state,
    // rather than waiting six-plus ticks for natural arming -- exactly the
    // "arcs thread through ReignState" contract this wiring test cares
    // about, not re-proving arming itself (covered above).
    const seeded: ReignState = {
      ...initialState(season),
      tick: 6,
      arcs: { 'restless:char:x': { kind: 'restless', charId: 'char:x', stage: 1, sinceTick: 6 } },
    };
    const f = makeFortune('retain-fulfillment');

    // Priming call: tick 6, no ops. (6 - 6) < 3, so this call's own systems
    // step leaves the seeded arc untouched -- it exists only to present a
    // brief this test can attach a directive choice to (firstBrief idiom).
    const primed = resolveTick(season, seeded, { seatId: 'seat:throne', choices: [] }, f);
    expect(primed.state.arcs['restless:char:x']).toEqual({ kind: 'restless', charId: 'char:x', stage: 1, sinceTick: 6 });
    const brief = primed.packet.briefs[0];
    if (!brief) throw new Error('expected a brief at tick 7 -- season fixture is wrong');

    // tick 7: a grant of 20 lands unmediated, fulfilling 'coin' (>= 15) --
    // wantIndex advances past the 1-element chain, currentWant goes null.
    // The grant's own +50bp loyalty bump (2.5bp/unit * 20) lands at
    // 4000+50=4050, nowhere near the 5500 retention floor, isolating this
    // as specifically the fulfillment path, not the loyalty path.
    const next = resolveTick(season, primed.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'grant', charId: 'char:x', amount: '20' }], via: 'directive' }],
    }, f);

    expect(next.events.some((e) => e.type === 'want.fulfilled')).toBe(true);
    expect(next.events.some((e) => e.type === 'arc.retained')).toBe(true);
    expect(next.events.some((e) => e.type === 'arc.departed')).toBe(false);
    expect(next.events.some((e) => e.type === 'arc.poach.bid')).toBe(false);
    expect(getNode(next.state.graph, 'char:x').props['arc:restless']).toBe(false);
    expect(next.state.arcs['restless:char:x']).toBeUndefined();
  });

  it('arcs survive the ReignState round-trip: two sequential resolveTicks carry arc stage forward correctly', () => {
    const g = withRestlessCandidate(4000);
    const season = arcSeason(g, 'char:rival');
    const seeded: ReignState = {
      ...initialState(season),
      tick: 2,
      arcs: { 'restless:char:x': { kind: 'restless', charId: 'char:x', stage: 1, sinceTick: 0 } },
    };
    const f = makeFortune('round-trip');

    // Call 1 processes tick 2: (2 - 0) < 3, not yet due -- the seeded arc
    // must come back out of state unchanged (proves ReignState.arcs threads
    // through resolveTick like cooldowns/firedOnce/presented do).
    const out1 = resolveTick(season, seeded, { seatId: 'seat:throne', choices: [] }, f);
    expect(out1.state.tick).toBe(3);
    expect(out1.state.arcs['restless:char:x']).toEqual({ kind: 'restless', charId: 'char:x', stage: 1, sinceTick: 0 });

    // Call 2 processes tick 3: (3 - 0) >= 3 -- advances to stage 2, bid fires
    // (rival configured). Proves the round-tripped stage/sinceTick from call
    // 1 is exactly what call 2's threshold check reads.
    const out2 = resolveTick(season, out1.state, { seatId: 'seat:throne', choices: [] }, f);
    expect(out2.state.arcs['restless:char:x']).toEqual({ kind: 'restless', charId: 'char:x', stage: 2, sinceTick: 3 });
    expect(out2.events.some((e) => e.type === 'arc.poach.bid')).toBe(true);
  });
});

  it('departure vacates appointment edges: an officeholder who departs loses their office', () => {
    // Fixture: char:x holds office:steward, carries a restless arc
    let g = withRestlessCandidate(4000);
    g = addNode(g, { id: 'office:steward', type: 'office', props: { title: 'Steward' } });
    g = addEdge(g, { type: 'appointment', src: 'char:x', dst: 'office:steward', props: { since: 0 } });
    
    let arcs: Record<string, CharacterArc> = {};
    const RIVAL = 'char:rival';

    // Arm the arc at tick 6
    let em = makeEmitter(6);
    let out = advanceCharacterArcs(g, 6, arcs, em, RIVAL);
    g = out.g;
    arcs = out.arcs;
    expect(arcs['restless:char:x']?.stage).toBe(1);

    // Advance to stage 2 at tick 9
    em = makeEmitter(9);
    out = advanceCharacterArcs(g, 9, arcs, em, RIVAL);
    g = out.g;
    arcs = out.arcs;
    expect(arcs['restless:char:x']?.stage).toBe(2);

    // Depart at tick 12: stage 3 (terminal)
    const pre = g;
    em = makeEmitter(12);
    out = advanceCharacterArcs(g, 12, arcs, em, RIVAL);
    g = out.g;
    arcs = out.arcs;

    // Verify departure event and basic state
    expect(em.all()).toHaveLength(1);
    expect(em.all()[0]?.type).toBe('arc.departed');
    expect(findEdge(g, 'loyalty', 'char:x', 'char:ruler')).toBeUndefined();
    expect(getNode(g, 'char:x').props['inRivalCourt']).toBe(true);
    
    // Verify appointment edge is GONE
    expect(findEdge(g, 'appointment', 'char:x', 'office:steward')).toBeUndefined();
    
    // Verify office node still exists (spec §12 -- offices remain)
    expect(g.nodes['office:steward']).toBeDefined();
    
    // Verify delta replay
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    // Verify mediated op through vacant office rejects with 'no hands'
    const medConfig: import('../src/mediate.js').MediationConfig = {
      officeForDomain: { econ: 'office:steward', martial: 'office:marshal', social: 'office:envoy' },
      willingness: false,
    };
    const medEm = makeEmitter(13);
    const g2 = applyMediatedOp(g, { kind: 'stockpile_grain', placeId: 'place:ash', amount: '5' }, 13, makeFortune('med'), medEm, medConfig, []);
    expect(g2).toBe(g); // graph unchanged on rejection
    const rejected = medEm.all().find((e) => e.type === 'op.rejected');
    expect(rejected).toBeDefined();
    expect(rejected?.data).toMatchObject({ reason: 'no hands' });
  });
