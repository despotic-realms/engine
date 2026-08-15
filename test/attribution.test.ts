// Causality §1, Task 2 (spec: meta/docs/specs/2026-08-08-causality-design.md
// §1; plan: meta/docs/plans/2026-08-08-causality-plan.md, Task 2): computed
// attribution. T1 (test/recency.test.ts) gave the scheduler a [newly,
// standing] partition; this file exercises the further split of `newly`
// into [attributed, world-newly] -- entries whose read-set intersects the
// PLAYER's own write-set this tick deal first and carry a becauseOf label.
//
// Fixture style mirrors test/recency.test.ts: synthetic EligibleEntry
// values (mkPlaceEntry, mkBriefEntry) for exercising attribute()/
// examiner.select() directly with full control over the pattern shape, a
// thornfieldGraph()-based fixture run through REAL applyOp/economyStep
// calls for authentic ChronicleEvents (no hand-typed fake event shapes),
// and one full seasonWith()-style SeasonConfig for the end-to-end
// resolveTick test carried over from the T1 review.
import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { attribute, patternReads, playerWriteSet } from '../src/attribution.js';
import { applyOp } from '../src/ops.js';
import { economyStep } from '../src/systems.js';
import { makeEmitter } from '../src/events.js';
import { makeFortune } from '../src/fortune.js';
import { addNode, setNodeProp } from '../src/graph.js';
import { examiner } from '../src/scheduler.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import { starterSeason } from '../src/decks/starter.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { GraphPattern } from '../src/match.js';
import type { ExaminerCalendar } from '../src/scheduler.js';
import type { EligibleEntry, Storylet } from '../src/storylet.js';
import type { SeasonConfig } from '../src/tick.js';

const f = makeFortune('attribution-test-seed');

// A brief-kind entry reading (place, granary) -- mirrors the REAL
// starter.granary-low storylet's pattern shape exactly (see
// src/decks/starter.ts), but as a standalone fixture: attribute() only
// ever inspects `entry.storylet.pattern` and `entry.instanceKey`, never
// `entry.binding` or the actual current truth of the where-clause (it
// isn't re-deriving eligibility, tick.ts already did that) -- so the
// binding here is for readability only, and the comparator/value are
// irrelevant to every test below.
function mkPlaceEntry(instanceKey: string, bindingPlaceId = 'place:thornfield'): EligibleEntry {
  const storylet: Storylet = {
    id: instanceKey, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'lt', value: fx('100') }] }] },
    title: instanceKey, body: instanceKey,
    options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
    defaultOptionId: 'a',
  };
  return { storylet, binding: { p: bindingPlaceId }, instanceKey };
}

// Mirrors test/recency.test.ts's/test/scheduler.test.ts's mkBriefEntry:
// pattern-free synthetic entries for exercising examiner.select's
// stratification directly.
function mkBriefEntry(id: string): EligibleEntry {
  const storylet: Storylet = {
    id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
    pattern: { nodes: [] },
    title: id, body: id,
    options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
    defaultOptionId: 'a',
  };
  return { storylet, binding: {}, instanceKey: id };
}

describe('patternReads (pure, no graph/events)', () => {
  it('collects a (nodeType, prop) pair per node where-clause predicate', () => {
    const pattern: GraphPattern = {
      nodes: [
        { as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'lt', value: fx('100') }, { prop: 'unrest', cmp: 'gt', value: fx('30') }] },
        { as: 'c', type: 'character' }, // no where -- contributes nothing to pairs
      ],
    };
    const reads = patternReads(pattern);
    expect(reads.pairs).toEqual(new Set(['place|granary', 'place|unrest']));
    expect(reads.edges.size).toBe(0);
    expect(reads.literals.size).toBe(0);
  });

  it('collects an edge pattern\'s type coarsely, ignoring its where-clause props entirely', () => {
    const pattern: GraphPattern = {
      nodes: [{ as: 'c', type: 'character' }, { as: 'o', type: 'office' }],
      edges: [
        { type: 'interest', from: 'c', to: '#inst:crown', where: [{ prop: 'exposed', cmp: 'eq', value: false }] },
        { type: 'appointment', from: 'c', to: 'o' },
      ],
    };
    const reads = patternReads(pattern);
    expect(reads.pairs.size).toBe(0); // edge where-clause props are NOT part of the read-set formula
    expect(reads.edges).toEqual(new Set(['interest', 'appointment']));
    expect(reads.literals).toEqual(new Set(['inst:crown']));
  });

  it('collects literal ids from both from and to sides of a #-pinned edge', () => {
    const pattern: GraphPattern = { nodes: [], edges: [{ type: 'kinship', from: '#char:a', to: '#char:b' }] };
    expect(patternReads(pattern).literals).toEqual(new Set(['char:a', 'char:b']));
  });
});

describe('playerWriteSet: ancestry filter + aggregation', () => {
  it('excludes deltas from events with no parents at all (systemic passes never attribute)', () => {
    const g = thornfieldGraph();
    const em = makeEmitter(2); // tick % 4 === 2: harvest.reaped fires, touching granary
    const g2 = economyStep(g, 2, f, em);
    expect(em.all().some((e) => e.deltas.length > 0)).toBe(true); // sanity: economyStep really did write something
    const ws = playerWriteSet(g2, em.all(), new Set());
    expect(ws.pairs.size).toBe(0);
    expect(ws.edges.size).toBe(0);
    expect(ws.ids.size).toBe(0);
  });

  it('aggregates pairs/edges/ids across a player-descended event with multiple delta kinds (imprison: node.set + edge.remove + edge.add)', () => {
    const g = thornfieldGraph(); // char:osric holds office:steward via an appointment edge
    const em = makeEmitter(5);
    const decision = em.emit('decision.recorded', { data: {} });
    const g2 = applyOp(g, { kind: 'imprison', charId: 'char:osric' }, 5, em, [decision.id]);
    const ws = playerWriteSet(g2, em.all(), new Set([decision.id]));
    expect(ws.pairs).toEqual(new Set(['character|imprisoned']));
    expect(ws.edges).toEqual(new Set(['appointment', 'grudge'])); // appointment removed, grudge added
    expect(ws.ids).toContain('char:osric');
    expect(ws.ids).toContain('office:steward'); // the vacated appointment's dst, carried via edge.remove parsing
  });
});

describe('attribute: causality §1 test scenarios', () => {
  it('(a) a brief reading (place, granary) is attributed when the PLAYER writes granary this tick; becauseOf carries the op event id', () => {
    const g = thornfieldGraph();
    const em = makeEmitter(5);
    const decision = em.emit('decision.recorded', { data: { briefId: 'b5.0', optionId: 'stockpile', via: 'option', attended: true } });
    const g2 = applyOp(g, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }, 5, em, [decision.id]);
    const opEvent = em.all().find((e) => e.type === 'op.stockpile_grain')!;

    const result = attribute(g2, [mkPlaceEntry('granary-brief')], em.all(), new Set([decision.id]));
    expect(result.get('granary-brief')).toEqual([opEvent.id]);
  });

  it('(b) the same pattern is NOT attributed when granary changes via economyStep, with no player decision this tick', () => {
    const g = thornfieldGraph();
    const em = makeEmitter(2); // tick % 4 === 2: harvest.reaped also writes granary
    const g2 = economyStep(g, 2, f, em);

    const result = attribute(g2, [mkPlaceEntry('granary-brief')], em.all(), new Set());
    expect(result.has('granary-brief')).toBe(false);
  });

  describe('(c) literal-pin refinement', () => {
    // Mirrors the shipped starter deck's own idiom (starter.audit-whisper /
    // starter.gen.petition, src/decks/starter.ts): an edge pattern with a
    // where-clause AND a '#'-pinned endpoint. bp lives on the EDGE, so this
    // pattern's read-set carries the loyalty edge type plus the literal --
    // no (nodeType, prop) pair at all (node 'r' has no where-clause), which
    // is exactly what makes the literal channel the ONLY thing standing
    // between "any loyalty write matches" and "only a write touching
    // char:alwyn matches".
    const pinnedPattern: GraphPattern = {
      nodes: [{ as: 'r', type: 'character' }],
      edges: [{ type: 'loyalty', from: '#char:alwyn', to: 'r', where: [{ prop: 'bp', cmp: 'lt', value: 5000 }] }],
    };
    function mkAlwynPinnedEntry(): EligibleEntry {
      const storylet: Storylet = {
        id: 'alwyns-condition', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
        pattern: pinnedPattern, title: 't', body: 'b',
        options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
        defaultOptionId: 'a',
      };
      return { storylet, binding: { r: 'char:ruler' }, instanceKey: 'alwyns-condition' };
    }

    it('a loyalty write on a DIFFERENT character does not carry the pinned id -- NOT attributed', () => {
      const g = thornfieldGraph(); // char:osric already carries a loyalty edge to char:ruler (edge.set path)
      const em = makeEmitter(5);
      const decision = em.emit('decision.recorded', { data: {} });
      const g2 = applyOp(g, { kind: 'send_envoy', charId: 'char:osric', tone: 'conciliatory' }, 5, em, [decision.id]);
      expect(em.all().some((e) => e.type === 'op.send_envoy' && e.deltas.some((d) => d.op === 'edge.set'))).toBe(true); // sanity: exercises the edge.set parse path

      const result = attribute(g2, [mkAlwynPinnedEntry()], em.all(), new Set([decision.id]));
      expect(result.has('alwyns-condition')).toBe(false);
    });

    it('a loyalty write on the PINNED character (char:alwyn) carries the id -- attributed', () => {
      const g = addNode(thornfieldGraph(), { id: 'char:alwyn', type: 'character', props: { name: 'Alwyn' } });
      const em = makeEmitter(5);
      const decision = em.emit('decision.recorded', { data: {} });
      const g2 = applyOp(g, { kind: 'send_envoy', charId: 'char:alwyn', tone: 'conciliatory' }, 5, em, [decision.id]);
      const opEvent = em.all().find((e) => e.type === 'op.send_envoy')!;
      expect(opEvent.deltas.some((d) => d.op === 'edge.add')).toBe(true); // sanity: alwyn has no prior edges -- exercises the edge.add path

      const result = attribute(g2, [mkAlwynPinnedEntry()], em.all(), new Set([decision.id]));
      expect(result.get('alwyns-condition')).toEqual([opEvent.id]);
    });
  });

  it('(d) coarse case: an unpinned granary-gated brief for place B is attributed by the player writing granary on place A (over-attribution accepted, causality §1)', () => {
    const g0 = addNode(thornfieldGraph(), { id: 'place:otherhold', type: 'place', props: { name: 'Otherhold', granary: fx('50') } });
    const em = makeEmitter(5);
    const decision = em.emit('decision.recorded', { data: {} });
    const g2 = applyOp(g0, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }, 5, em, [decision.id]);
    const opEvent = em.all().find((e) => e.type === 'op.stockpile_grain')!;

    // entryForB's binding names place:otherhold -- the pattern itself names
    // no literal id at all, so attribute() cannot (and per spec must not
    // try to) tell place A's write apart from place B's read.
    const entryForB = mkPlaceEntry('granary-brief-otherhold', 'place:otherhold');
    const result = attribute(g2, [entryForB], em.all(), new Set([decision.id]));
    expect(result.get('granary-brief-otherhold')).toEqual([opEvent.id]);
  });

  it('(e) casting order: probes > attributed newly-eligible > world newly-eligible > standing, concrete order on one constructed tick', () => {
    const probe = mkBriefEntry('probe');
    const attributedEntry = mkBriefEntry('attributed');
    const worldNewly = mkBriefEntry('world-newly');
    const standing = mkBriefEntry('standing');
    const pool = [standing, worldNewly, attributedEntry, probe]; // deliberately NOT in stratum order
    // tick 0 (not an arbitrary choice, T1's own recency.test.ts convention):
    // brute-forced over ticks 0..200 against the UNMODIFIED (pre-T2)
    // scheduler.ts (which ignores an extra `becauseOf` field entirely and
    // just lottery-draws the tied [attributed, world-newly] pair as one
    // partition) -- at tick 0 that draw picks 'world-newly' before
    // 'attributed', so this is genuine RED against the two-partition
    // scheduler, not a coincidental pass (ticks 3/4/5/7/9/10/... all
    // happen to match by chance and would NOT be genuine RED).
    const calendar: ExaminerCalendar = [{ tick: 0, storyletId: 'probe' }];
    const newlyEligible = new Set(['attributed', 'world-newly']);
    const becauseOf = new Map([['attributed', ['t0.0']]]);

    const sel = examiner.select({
      tick: 0, briefBudget: 4, eligible: pool, fortune: f, calendar, presented: {}, newlyEligible, becauseOf,
    });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['probe', 'attributed', 'world-newly', 'standing']);

    // Determinism: the same construction, called again, deals identically.
    const again = examiner.select({
      tick: 0, briefBudget: 4, eligible: pool, fortune: f, calendar, presented: {}, newlyEligible, becauseOf,
    });
    expect(again.chosen.map((e) => e.storylet.id)).toEqual(sel.chosen.map((e) => e.storylet.id));
  });

  it('(f) determinism: identical events/decisions produce an identical attribution map, becauseOf sorted and stable across two contributing events', () => {
    const g = thornfieldGraph();
    const em = makeEmitter(5);
    const d1 = em.emit('decision.recorded', { data: { briefId: 'b5.0' } });
    const d2 = em.emit('decision.recorded', { data: { briefId: 'b5.1' } });
    let g2 = applyOp(g, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '10' }, 5, em, [d1.id]);
    g2 = applyOp(g2, { kind: 'release_grain', placeId: 'place:thornfield', amount: '5' }, 5, em, [d2.id]);
    const opEvents = em.all().filter((e) => e.type.startsWith('op.'));
    expect(opEvents).toHaveLength(2); // both are node.set on granary -- both should attribute

    const decisionIds = new Set([d1.id, d2.id]);
    const entry = mkPlaceEntry('granary-brief');
    const result1 = attribute(g2, [entry], em.all(), decisionIds);
    const result2 = attribute(g2, [entry], em.all(), decisionIds);
    const expected = opEvents.map((e) => e.id).sort();
    expect(result1.get('granary-brief')).toEqual(expected);
    expect(result2.get('granary-brief')).toEqual(expected);
    expect([...result1.entries()]).toEqual([...result2.entries()]);
  });
});

// T1 review carry: the wider suite never asserted multi-tick cast ORDER.
// This drives the full tick.ts -> attribution.ts -> scheduler.ts pipeline
// through two REAL sequential resolveTicks (not a direct examiner.select
// call) and asserts order-sensitive expectations on the LATER tick's
// packet, mirroring test/recency.test.ts's own "round-trips through
// sequential resolveTicks" test for T1.
describe('end-to-end via resolveTick: attribution survives real casting (T1 review carry)', () => {
  function mkAlwaysPlace(id: string): Storylet {
    return {
      id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place' }] },
      title: id, body: id,
      options: [
        { id: 'trigger', label: 'Record the doctrine', ops: [{ kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' }] },
        { id: 'skip', label: 'Skip', ops: [] },
      ],
      defaultOptionId: 'skip',
    };
  }
  function mkStanceGated(id: string): Storylet {
    return {
      id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
      pattern: { nodes: [{ as: 'crown', type: 'institution', where: [{ prop: 'stance:granary-doctrine', cmp: 'eq', value: 'for' }] }] },
      title: id, body: id,
      options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
      defaultOptionId: 'skip',
    };
  }
  function mkFlagGated(id: string): Storylet {
    return {
      id, kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'flagged', cmp: 'eq', value: true }] }] },
      title: id, body: id,
      options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
      defaultOptionId: 'skip',
    };
  }

  it('an attributed brief deals before a world-newly brief, which deals before a standing brief, on tick 2', () => {
    const base = starterSeason();
    // deck id 'starter' matches base.tiers[1].deckIds unchanged -- the same
    // minimal-override trick test/recency.test.ts's seasonWith() uses.
    const graph = setNodeProp(base.initialGraph, 'place:thornfield', 'flagged', false);
    const season: SeasonConfig = {
      ...base,
      initialGraph: graph,
      decks: [{ id: 'starter', tier: 1, storylets: [mkAlwaysPlace('et.standing'), mkStanceGated('et.player'), mkFlagGated('et.world')] }],
      tiers: { ...base.tiers, 1: { ...base.tiers[1]!, briefBudget: 3 } },
      calendar: [],
    };
    const f2 = makeFortune('attribution-e2e-seed');
    const empty = { seatId: 'seat:throne', choices: [] };

    // Tick 1: only et.standing is eligible (et.player's stance is unset,
    // et.world's flag is false).
    const out1 = resolveTick(season, initialState(season), empty, f2);
    expect(out1.packet.briefs.map((b) => b.storyletId)).toEqual(['et.standing']);
    const standingBrief = out1.packet.briefs[0]!;

    // Between ticks: flip et.world's flag directly on the graph -- exactly
    // test/recency.test.ts's own technique for a change with NO event/
    // decision behind it at all, guaranteeing it can never be
    // player-descended.
    const flipped = setNodeProp(out1.state.graph, 'place:thornfield', 'flagged', true);
    const seeded = { ...out1.state, graph: flipped };

    // Tick 2: answering et.standing's brief with 'trigger' records the
    // stance as PART OF resolving tick 1 (this call) -- et.player becomes
    // newly-eligible AND attributed to that op's own event; et.world is
    // newly-eligible via the direct graph flip above (world-caused, no
    // event at all); et.standing was already eligible at tick 1, so it's
    // standing, not newly.
    const out2 = resolveTick(season, seeded, { seatId: 'seat:throne', choices: [{ briefId: standingBrief.briefId, optionId: 'trigger' }] }, f2);
    expect(out2.packet.briefs.map((b) => b.storyletId)).toEqual(['et.player', 'et.world', 'et.standing']);

    const opEvent = out2.events.find((e) => e.type === 'op.record_stance')!;
    expect(out2.packet.briefs.find((b) => b.storyletId === 'et.player')?.becauseOf).toEqual([opEvent.id]);
    expect(out2.packet.briefs.find((b) => b.storyletId === 'et.world')?.becauseOf).toBeUndefined();
    expect(out2.packet.briefs.find((b) => b.storyletId === 'et.standing')?.becauseOf).toBeUndefined();
  });
});
