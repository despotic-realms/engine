// Rolling wants (spec §2, T7): each named character has a current want
// (wantChain[wantIndex]); fulfilling it advances the chain and surfaces the
// next one. Two layers here: WANT_FULFILL is a pure, closed table of
// per-want done-detectors (unit-tested directly below); resolveTick wires
// evaluation in right after each op actually applies (integration-tested
// via the same directive-ops idiom test/mediate.test.ts's "wired into
// resolveTick" suite and test/tick.test.ts use).
import { describe, expect, it } from 'vitest';
import { WANT_FULFILL } from '../src/spine.js';
import { WANT_KEYS } from '../src/spine.js';
import { addEdge, addNode, emptyGraph, getNode } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import { applyDeltas } from '../src/events.js';
import { fx } from '../src/fx.js';
import { makeFortune } from '../src/fortune.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig, TierConfig } from '../src/tick.js';

// A small fixture graph with a couple of characters, an office, and two
// places (one already fortified) -- enough surface for every predicate's
// positive and negative branches without dragging in a full season.
function predicateGraph(): WorldGraph {
  let g = emptyGraph();
  g = addNode(g, { id: 'char:x', type: 'character', props: { name: 'X' } });
  g = addNode(g, { id: 'char:y', type: 'character', props: { name: 'Y' } });
  g = addNode(g, { id: 'office:o', type: 'office', props: { title: 'Office' } });
  g = addNode(g, { id: 'place:p', type: 'place', props: { name: 'P', defenseBp: 0 } });
  g = addNode(g, { id: 'place:q', type: 'place', props: { name: 'Q', defenseBp: 3000 } }); // already well-fortified
  return g;
}

describe('WANT_FULFILL predicates (spec §2)', () => {
  it('the table is exactly the closed WANT_KEYS vocabulary, no more, no less', () => {
    expect(Object.keys(WANT_FULFILL).sort()).toEqual([...WANT_KEYS].sort());
  });

  it('coin: grant to charId with fx(amount) >= fx(\'15\')', () => {
    const g = predicateGraph();
    expect(WANT_FULFILL.coin(g, { kind: 'grant', charId: 'char:x', amount: '15' }, 'char:x')).toBe(true); // boundary
    expect(WANT_FULFILL.coin(g, { kind: 'grant', charId: 'char:x', amount: '14.9999' }, 'char:x')).toBe(false);
    expect(WANT_FULFILL.coin(g, { kind: 'grant', charId: 'char:y', amount: '100' }, 'char:x')).toBe(false); // wrong target
    expect(WANT_FULFILL.coin(g, { kind: 'pardon', charId: 'char:x' }, 'char:x')).toBe(false); // wrong op kind
  });

  it('office: appoint charId to any office', () => {
    const g = predicateGraph();
    expect(WANT_FULFILL.office(g, { kind: 'appoint', charId: 'char:x', officeId: 'office:o' }, 'char:x')).toBe(true);
    expect(WANT_FULFILL.office(g, { kind: 'appoint', charId: 'char:y', officeId: 'office:o' }, 'char:x')).toBe(false);
  });

  it('pardon: pardon targeting charId', () => {
    const g = predicateGraph();
    expect(WANT_FULFILL.pardon(g, { kind: 'pardon', charId: 'char:x' }, 'char:x')).toBe(true);
    expect(WANT_FULFILL.pardon(g, { kind: 'pardon', charId: 'char:y' }, 'char:x')).toBe(false);
  });

  it('holding: invest at a place charId holds an interest edge to, any project', () => {
    let g = predicateGraph();
    g = addEdge(g, { type: 'interest', src: 'char:x', dst: 'place:p', props: {} });
    expect(WANT_FULFILL.holding(g, { kind: 'invest', placeId: 'place:p', project: 'roads', amount: '10' }, 'char:x')).toBe(true);
    expect(WANT_FULFILL.holding(g, { kind: 'invest', placeId: 'place:p', project: 'irrigation', amount: '10' }, 'char:x')).toBe(true); // any project
    expect(WANT_FULFILL.holding(g, { kind: 'invest', placeId: 'place:q', project: 'roads', amount: '10' }, 'char:x')).toBe(false); // no edge to q
  });

  it("marriage: reserved this wave -- always false, even on plausible ops", () => {
    const g = predicateGraph();
    expect(WANT_FULFILL.marriage(g, { kind: 'grant', charId: 'char:x', amount: '1000' }, 'char:x')).toBe(false);
    expect(WANT_FULFILL.marriage(g, { kind: 'send_envoy', charId: 'char:x', tone: 'conciliatory' }, 'char:x')).toBe(false);
    expect(WANT_FULFILL.marriage(g, { kind: 'pardon', charId: 'char:x' }, 'char:x')).toBe(false);
  });

  it('revenge: imprison or seize targeting a character charId holds a grudge toward', () => {
    let g = predicateGraph();
    g = addEdge(g, { type: 'grudge', src: 'char:x', dst: 'char:y', props: { bp: 2000 } });
    expect(WANT_FULFILL.revenge(g, { kind: 'imprison', charId: 'char:y' }, 'char:x')).toBe(true);
    expect(WANT_FULFILL.revenge(g, { kind: 'seize', charId: 'char:y', amount: '5' }, 'char:x')).toBe(true);
    expect(WANT_FULFILL.revenge(g, { kind: 'pardon', charId: 'char:y' }, 'char:x')).toBe(false); // wrong op kind
    expect(WANT_FULFILL.revenge(g, { kind: 'imprison', charId: 'char:x' }, 'char:x')).toBe(false); // no grudge char:x -> char:x
  });

  it('recognition: grant of any amount, or hold_festival at an interest-held place', () => {
    let g = predicateGraph();
    g = addEdge(g, { type: 'interest', src: 'char:x', dst: 'place:p', props: {} });
    expect(WANT_FULFILL.recognition(g, { kind: 'grant', charId: 'char:x', amount: '1' }, 'char:x')).toBe(true); // ANY amount, unlike coin
    expect(WANT_FULFILL.recognition(g, { kind: 'hold_festival', placeId: 'place:p', amount: '10' }, 'char:x')).toBe(true);
    expect(WANT_FULFILL.recognition(g, { kind: 'hold_festival', placeId: 'place:q', amount: '10' }, 'char:x')).toBe(false); // no interest in q
  });

  it('safety: pardon targeting charId, or invest walls at an interest-held place with defenseBp >= 2000', () => {
    let g = predicateGraph();
    g = addEdge(g, { type: 'interest', src: 'char:x', dst: 'place:p', props: {} }); // defenseBp 0
    g = addEdge(g, { type: 'interest', src: 'char:x', dst: 'place:q', props: {} }); // defenseBp 3000
    expect(WANT_FULFILL.safety(g, { kind: 'pardon', charId: 'char:x' }, 'char:x')).toBe(true);
    expect(WANT_FULFILL.safety(g, { kind: 'invest', placeId: 'place:q', project: 'walls', amount: '10' }, 'char:x')).toBe(true); // 3000 >= 2000
    expect(WANT_FULFILL.safety(g, { kind: 'invest', placeId: 'place:p', project: 'walls', amount: '10' }, 'char:x')).toBe(false); // 0 < 2000
    expect(WANT_FULFILL.safety(g, { kind: 'invest', placeId: 'place:q', project: 'roads', amount: '10' }, 'char:x')).toBe(false); // wrong project
  });
});

// --- resolveTick wiring: integration tests below drive the real pipeline
// (a pending brief, then a directive choice carrying raw ops -- the same
// idiom test/mediate.test.ts's "wired into resolveTick" suite and
// test/tick.test.ts's "defaulted briefs with failing ops" test use) rather
// than calling WANT_FULFILL directly, so they prove the wiring itself: the
// landed-detection, the sorted-order multi-character loop, the delta
// shape, and the event parenting.

function baseGraph(): WorldGraph {
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
  return g;
}

// One trivially-matching storylet (pattern: any place, of which place:ash
// always qualifies) so every test can get exactly one pending brief to
// attach a directive choice to -- the storylet's own options are never
// used (every test attends with `ops` + via:'directive' instead).
function wantSeason(graph: WorldGraph, tierExtra: Partial<TierConfig> = {}): SeasonConfig {
  return {
    seasonId: 'wants-test',
    startTier: 1,
    initialGraph: graph,
    decks: [{
      id: 'wants-deck', tier: 1,
      storylets: [{
        id: 'wants.probe', kind: 'brief', tier: 1, cooldownTicks: 1, once: false,
        pattern: { nodes: [{ as: 'p', type: 'place' }] },
        title: 'Probe', body: 'Probe body',
        options: [{ id: 'skip', label: 'Skip', ops: [] }],
        defaultOptionId: 'skip',
      }],
    }],
    tiers: { 1: { deckIds: ['wants-deck'], briefBudget: 1, attentionSlots: 1, ...tierExtra } },
    calendar: [],
    tierRules: [],
    throne: { id: 'seat:throne', kind: 'throne', bodyCharId: 'char:ruler', attentionSlots: 1, fidelity: 'external' },
    reporters: [],
    primaryPlaceId: 'place:ash',
  };
}

function firstBrief(season: SeasonConfig, seed: string) {
  const f = makeFortune(seed);
  const out = resolveTick(season, initialState(season), { seatId: 'seat:throne', choices: [] }, f);
  const brief = out.packet.briefs[0];
  if (!brief) throw new Error('expected a brief at tick 1 -- season fixture is wrong');
  return { out, brief, f };
}

describe('resolveTick wiring: advance mechanics (spec §2, T7)', () => {
  it('a fulfilling op bumps wantIndex, stamps wantSinceTick, emits want.fulfilled parented to the op event, and delta-replay reproduces both props', () => {
    let g = baseGraph();
    g = addNode(g, { id: 'char:x', type: 'character', props: { name: 'X', wantChain: ['coin'], wantIndex: 0 } });
    const season = wantSeason(g);
    const { out, brief, f } = firstBrief(season, 'advance-mechanics');

    const next = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'grant', charId: 'char:x', amount: '20' }], via: 'directive' }],
    }, f);

    const wf = next.events.find((e) => e.type === 'want.fulfilled');
    expect(wf).toBeDefined();
    expect(wf!.data).toEqual({ charId: 'char:x', wantKey: 'coin' });

    const grantEvent = next.events.find((e) => e.type === 'op.grant');
    expect(grantEvent).toBeDefined();
    expect(wf!.parents).toContain(grantEvent!.id); // parents to the op's own event, per house convention

    expect(getNode(next.state.graph, 'char:x').props['wantIndex']).toBe(1);
    expect(getNode(next.state.graph, 'char:x').props['wantSinceTick']).toBe(out.state.tick);

    // Delta-replay: applying want.fulfilled's OWN deltas to the pre-event
    // graph reproduces both advanced props, matching the real post-state.
    const replayed = applyDeltas(out.state.graph, wf!.deltas);
    expect(getNode(replayed, 'char:x').props['wantIndex']).toBe(1);
    expect(getNode(replayed, 'char:x').props['wantSinceTick']).toBe(out.state.tick);
  });
});

describe('resolveTick wiring: multi-character fulfillment (spec §2, T7)', () => {
  it('one hold_festival op fulfills recognition for every interest-holding character at once, in sorted node-id order', () => {
    let g = baseGraph();
    g = addNode(g, { id: 'char:a', type: 'character', props: { name: 'A', wantChain: ['recognition'], wantIndex: 0 } });
    g = addNode(g, { id: 'char:b', type: 'character', props: { name: 'B', wantChain: ['recognition'], wantIndex: 0 } });
    g = addNode(g, { id: 'char:c', type: 'character', props: { name: 'C', wantChain: ['recognition'], wantIndex: 0 } }); // no interest edge
    g = addEdge(g, { type: 'interest', src: 'char:a', dst: 'place:ash', props: {} });
    g = addEdge(g, { type: 'interest', src: 'char:b', dst: 'place:ash', props: {} });
    const season = wantSeason(g);
    const { out, brief, f } = firstBrief(season, 'festival-multi');

    const next = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'hold_festival', placeId: 'place:ash', amount: '20' }], via: 'directive' }],
    }, f);

    const fulfilled = next.events.filter((e) => e.type === 'want.fulfilled');
    expect(fulfilled.map((e) => (e.data as { charId: string }).charId)).toEqual(['char:a', 'char:b']); // sorted; c excluded
    expect(fulfilled.every((e) => (e.data as { wantKey: string }).wantKey === 'recognition')).toBe(true);
    expect(getNode(next.state.graph, 'char:a').props['wantIndex']).toBe(1);
    expect(getNode(next.state.graph, 'char:b').props['wantIndex']).toBe(1);
    expect(getNode(next.state.graph, 'char:c').props['wantIndex']).toBe(0); // untouched: their current want didn't match
  });
});

describe('resolveTick wiring: chain end (spec §2, T7)', () => {
  it('wantIndex already past the chain end: currentWant is null, so no evaluation, no want.fulfilled, no crash', () => {
    let g = baseGraph();
    g = addNode(g, { id: 'char:x', type: 'character', props: { name: 'X', wantChain: ['coin'], wantIndex: 1 } }); // past the 1-element chain
    const season = wantSeason(g);
    const { out, brief, f } = firstBrief(season, 'chain-end');

    const next = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'grant', charId: 'char:x', amount: '20' }], via: 'directive' }],
    }, f);

    expect(next.events.some((e) => e.type === 'want.fulfilled')).toBe(false);
    expect(getNode(next.state.graph, 'char:x').props['wantIndex']).toBe(1); // unchanged
  });
});

describe('resolveTick wiring: botched mediated ops fulfill nothing (spec §2, T7)', () => {
  it('want.fulfilled tracks exactly whether the underlying op landed -- a botched band draw applies nothing, so nothing is "done"', () => {
    let g = baseGraph();
    g = addNode(g, { id: 'char:x', type: 'character', props: { name: 'X', wantChain: ['coin'], wantIndex: 0 } });
    g = addNode(g, { id: 'char:steward', type: 'character', props: { name: 'Steward', 'apt:econ': 0 } }); // apt 0 -> ~20% botched
    g = addNode(g, { id: 'office:steward', type: 'office', props: { title: 'Steward' } });
    g = addEdge(g, { type: 'appointment', src: 'char:steward', dst: 'office:steward', props: { since: 0 } });
    const season = wantSeason(g, {
      mediation: { officeForDomain: { econ: 'office:steward', martial: 'office:none', social: 'office:none' }, willingness: false },
    });
    const { out, brief } = firstBrief(season, 'botched-setup');

    let sawBotched = false;
    let sawLanded = false;
    for (let s = 0; s < 100; s++) {
      const next = resolveTick(season, out.state, {
        seatId: 'seat:throne',
        choices: [{ briefId: brief.briefId, ops: [{ kind: 'grant', charId: 'char:x', amount: '20' }], via: 'directive' }],
      }, makeFortune(`botched-scan-${s}`));

      const executed = next.events.find((e) => e.type === 'op.executed');
      expect(executed).toBeDefined();
      const band = (executed!.data as { band: string }).band;
      const landed = band !== 'botched';
      if (landed) sawLanded = true; else sawBotched = true;

      expect(next.events.some((e) => e.type === 'op.grant')).toBe(landed);
      expect(next.events.some((e) => e.type === 'want.fulfilled')).toBe(landed);
      expect(getNode(next.state.graph, 'char:x').props['wantIndex']).toBe(landed ? 1 : 0);
    }
    // Sanity on the scan itself, not the feature: fail loudly (not silently
    // "pass" on a lucky draw) if 100 seeds never touched one side.
    expect(sawBotched).toBe(true);
    expect(sawLanded).toBe(true);
  });
});
