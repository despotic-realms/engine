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
import type { Booking, ExaminerCalendar } from '../src/scheduler.js';
import type { EligibleEntry, Storylet } from '../src/storylet.js';
import type { SeasonConfig } from '../src/tick.js';

const f = makeFortune('attribution-test-seed');
// Causality §3 (T4, bookings): this file is about attribution, not
// bookings -- an empty array makes the due-bookings block in
// examiner.select a no-op loop. See test/bookings.test.ts for the
// booking-specific cases.
const noBookings: Booking[] = [];

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
    const g2 = applyOp(g, { kind: 'imprison', charId: 'char:osric' }, 5, em, 'seat:throne', [decision.id]);
    const ws = playerWriteSet(g2, em.all(), new Set([decision.id]));
    // Causality §2 (T3): imprison is a deed-producing arm now -- its own
    // node.set stamps (recent:imprisoned, recent:imprisoned:at) ride the
    // SAME event as the 'imprisoned' flag flip, so they join the write-set too.
    expect(ws.pairs).toEqual(new Set(['character|imprisoned', 'character|recent:imprisoned', 'character|recent:imprisoned:at']));
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
    const g2 = applyOp(g, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }, 5, em, 'seat:throne', [decision.id]);
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
      const g2 = applyOp(g, { kind: 'send_envoy', charId: 'char:osric', tone: 'conciliatory' }, 5, em, 'seat:throne', [decision.id]);
      expect(em.all().some((e) => e.type === 'op.send_envoy' && e.deltas.some((d) => d.op === 'edge.set'))).toBe(true); // sanity: exercises the edge.set parse path

      const result = attribute(g2, [mkAlwynPinnedEntry()], em.all(), new Set([decision.id]));
      expect(result.has('alwyns-condition')).toBe(false);
    });

    it('a loyalty write on the PINNED character (char:alwyn) carries the id -- attributed', () => {
      const g = addNode(thornfieldGraph(), { id: 'char:alwyn', type: 'character', props: { name: 'Alwyn' } });
      const em = makeEmitter(5);
      const decision = em.emit('decision.recorded', { data: {} });
      const g2 = applyOp(g, { kind: 'send_envoy', charId: 'char:alwyn', tone: 'conciliatory' }, 5, em, 'seat:throne', [decision.id]);
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
    const g2 = applyOp(g0, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }, 5, em, 'seat:throne', [decision.id]);
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
      tick: 0, briefBudget: 4, eligible: pool, fortune: f, calendar, presented: {}, newlyEligible, becauseOf, bookings: noBookings,
    });
    expect(sel.chosen.map((e) => e.storylet.id)).toEqual(['probe', 'attributed', 'world-newly', 'standing']);

    // Determinism: the same construction, called again, deals identically.
    const again = examiner.select({
      tick: 0, briefBudget: 4, eligible: pool, fortune: f, calendar, presented: {}, newlyEligible, becauseOf, bookings: noBookings,
    });
    expect(again.chosen.map((e) => e.storylet.id)).toEqual(sel.chosen.map((e) => e.storylet.id));
  });

  it('(f) determinism: identical events/decisions produce an identical attribution map, becauseOf sorted and stable across two contributing events', () => {
    const g = thornfieldGraph();
    const em = makeEmitter(5);
    const d1 = em.emit('decision.recorded', { data: { briefId: 'b5.0' } });
    const d2 = em.emit('decision.recorded', { data: { briefId: 'b5.1' } });
    let g2 = applyOp(g, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '10' }, 5, em, 'seat:throne', [d1.id]);
    g2 = applyOp(g2, { kind: 'release_grain', placeId: 'place:thornfield', amount: '5' }, 5, em, 'seat:throne', [d2.id]);
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

  // Whole-wave final-review fix (IMPORTANT): the literal-pin gate must
  // scope to edge-channel hits only. Pre-fix, matchesRead computed one
  // shared "baseHit" (pair OR edgeType) and then, whenever the pattern
  // pinned ANY literal at all, required THAT SAME delta to carry it --
  // including for a node.set/pair hit, even though literals can only ever
  // originate from a '#'-pinned EDGE ENDPOINT (match.ts: node patterns
  // have no pinning mechanism of their own) and a node.set delta's `ids`
  // can only ever be the ONE node it wrote. Gating the pair channel on a
  // literal it structurally could never carry was a category error: any
  // reaction storylet shaped "unpinned char var, read a char prop; scoped
  // by a pinned edge for CONTEXT only" became unattributable through its
  // node-prop channel no matter what happened, so structurally identical
  // reactions to different flavors of the same deed got inconsistent
  // labels purely based on whether that flavor happened to also move a
  // relationship edge. See this file's header, "Refinement rule", for the
  // rule these tests pin.
  describe('(g) literal-pin refinement is scoped to the edge channel, not the pair channel (final-review fix)', () => {
    // Mirrors the reviewer's probe exactly: an unpinned char var ('c') with
    // its own where-clause (reads `recent:envoy-firm`, a real deed
    // fingerprint prop -- causality §2/T3), scoped by a pinned `loyalty ->
    // #char:ruler` edge that exists ONLY for context (the same "edge for
    // context, no where-clause of its own" idiom starter.audit-whisper
    // already ships). reads.pairs = {'character|recent:envoy-firm'} (from
    // c's where-clause -- NOT empty, unlike scenario (c)'s pattern), so
    // this is exactly the shape where the pre-fix global gate and the
    // post-fix scoped gate diverge.
    const reactionPattern: GraphPattern = {
      nodes: [{ as: 'c', type: 'character', where: [{ prop: 'recent:envoy-firm', cmp: 'ne', value: '' }] }],
      edges: [{ type: 'loyalty', from: 'c', to: '#char:ruler' }],
    };
    function mkFirmReactionEntry(): EligibleEntry {
      const storylet: Storylet = {
        id: 'firm-reaction', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
        pattern: reactionPattern, title: 't', body: 'b',
        options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
        defaultOptionId: 'a',
      };
      return { storylet, binding: { c: 'char:osric' }, instanceKey: 'firm-reaction' };
    }

    it("firm envoys attribute via the node.set/pair channel alone (RED against unfixed ec7372b -- 'firm' moves no relationship edge, so its deltas can never carry char:ruler's id no matter what)", () => {
      const g = thornfieldGraph();
      const em = makeEmitter(5);
      const decision = em.emit('decision.recorded', { data: {} });
      const g2 = applyOp(g, { kind: 'send_envoy', charId: 'char:osric', tone: 'firm' }, 5, em, 'seat:throne', [decision.id]);
      const opEvent = em.all().find((e) => e.type === 'op.send_envoy')!;
      // sanity: 'firm' really is node.set-only -- ops.ts's own comment,
      // "'firm' moves no relationship edge" -- so the edge channel has
      // nothing to attribute through here at all; the pair channel is the
      // ONLY possible path to attribution for this tone.
      expect(opEvent.deltas.length).toBeGreaterThan(0);
      expect(opEvent.deltas.every((d) => d.op === 'node.set')).toBe(true);

      const result = attribute(g2, [mkFirmReactionEntry()], em.all(), new Set([decision.id]));
      expect(result.get('firm-reaction')).toEqual([opEvent.id]);
    });

    it('conciliatory (warm) envoys attribute via the loyalty edge delta, which carries char:ruler (unaffected by the fix)', () => {
      const g = thornfieldGraph(); // char:osric already carries a loyalty edge to char:ruler
      const em = makeEmitter(5);
      const decision = em.emit('decision.recorded', { data: {} });
      const g2 = applyOp(g, { kind: 'send_envoy', charId: 'char:osric', tone: 'conciliatory' }, 5, em, 'seat:throne', [decision.id]);
      const opEvent = em.all().find((e) => e.type === 'op.send_envoy')!;
      expect(opEvent.deltas.some((d) => d.op === 'edge.set')).toBe(true); // sanity: moves the existing loyalty edge

      const result = attribute(g2, [mkFirmReactionEntry()], em.all(), new Set([decision.id]));
      expect(result.get('firm-reaction')).toEqual([opEvent.id]);
    });

    it('threatening envoys attribute via their grudge/loyalty edge deltas, which carry char:ruler (unaffected by the fix)', () => {
      const g = thornfieldGraph();
      const em = makeEmitter(5);
      const decision = em.emit('decision.recorded', { data: {} });
      const g2 = applyOp(g, { kind: 'send_envoy', charId: 'char:osric', tone: 'threatening' }, 5, em, 'seat:throne', [decision.id]);
      const opEvent = em.all().find((e) => e.type === 'op.send_envoy')!;
      expect(opEvent.deltas.some((d) => d.op === 'edge.add' || d.op === 'edge.set')).toBe(true); // sanity: moves grudge and/or loyalty

      const result = attribute(g2, [mkFirmReactionEntry()], em.all(), new Set([decision.id]));
      expect(result.get('firm-reaction')).toEqual([opEvent.id]);
    });
  });

  // Ride-along (carry triage #3): per-delta refusal must hold even when a
  // literal-carrying delta and a read-set-matching delta both exist within
  // the SAME event, but never on the SAME delta. Pins the invariant
  // matchesRead/attribute() already rely on (each delta is checked in
  // isolation -- see attribute()'s own loop) rather than accidentally
  // proving it only via patterns where it happens not to matter. Passes
  // both before and after the final-review fix -- this is not new
  // behavior, it's the existing per-delta discipline made explicit so a
  // future refactor (e.g. toward playerWriteSet's AGGREGATE, which this
  // file's header explicitly says attribute() must not use) cannot
  // silently reintroduce cross-delta contamination.
  it('(h) cross-delta contamination: a literal-carrying delta cannot rescue a coarse edge hit from a DIFFERENT delta in the same event', () => {
    // imprison(char:osric) lands ALL of these in one event (mirrors the
    // playerWriteSet aggregation test above): edge.remove on osric's
    // appointment edge (no literal), edge.add on a FRESH grudge edge to
    // char:ruler (carries the literal, under a DIFFERENT edge type), plus
    // three node.set stamps on osric alone.
    const pattern: GraphPattern = {
      nodes: [{ as: 'c', type: 'character' }, { as: 'o', type: 'office' }],
      edges: [
        { type: 'appointment', from: 'c', to: 'o' },       // read, but its own delta never touches char:ruler
        { type: 'loyalty', from: 'c', to: '#char:ruler' },  // pins the literal; imprison never touches a loyalty edge at all
      ],
    };
    function mkEntry(): EligibleEntry {
      const storylet: Storylet = {
        id: 'contamination-check', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
        pattern, title: 't', body: 'b',
        options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
        defaultOptionId: 'a',
      };
      return { storylet, binding: { c: 'char:osric', o: 'office:steward' }, instanceKey: 'contamination-check' };
    }

    const g = thornfieldGraph();
    const em = makeEmitter(5);
    const decision = em.emit('decision.recorded', { data: {} });
    const g2 = applyOp(g, { kind: 'imprison', charId: 'char:osric' }, 5, em, 'seat:throne', [decision.id]);
    const opEvent = em.all().find((e) => e.type === 'op.imprison')!;
    // sanity: this one event really does carry both halves of the
    // contamination hazard -- a read edge type with no literal (appointment)
    // and a literal-carrying edge of a type the pattern never reads (grudge).
    expect(opEvent.deltas.some((d) => d.op === 'edge.remove')).toBe(true);
    expect(opEvent.deltas.some((d) => d.op === 'edge.add' && d.edge.type === 'grudge' && d.edge.dst === 'char:ruler')).toBe(true);

    const result = attribute(g2, [mkEntry()], em.all(), new Set([decision.id]));
    expect(result.has('contamination-check')).toBe(false);
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

  // Whole-wave final-review fix, Fix 1's own semantics-consequences carry:
  // attribution is computed ONLY over newlyEligibleEntries (tick.ts step 9),
  // so a brief the possibility-diff correctly keeps STANDING through a
  // cooldown cycle never reaches attribute() at all -- no becauseOf, no
  // matter what the player wrote that tick. Pre-fix, a cooldown re-entry was
  // misread as newly (Fix 1's own defect), so IF a coincidental player
  // write that tick happened to intersect the recycling brief's read-set,
  // attribute() -- asked about it only because of the casting bug -- would
  // mislabel it "because of your order" for a brief that had nothing to do
  // with that write. This fixture makes the coincidence land on purpose
  // (the recycler's own where-clause reads `place|granary`, and the
  // coincident write is a real stockpile_grain op that touches granary) so
  // the test is a genuine RED against unfixed ec7372b, not a vacuous one.
  it("a pure cooldown re-entry is not attributed even when an unrelated player write coincides AND intersects its read-set (RED against unfixed ec7372b)", () => {
    const base = starterSeason();
    function mkRecycler(): Storylet {
      return {
        id: 'recycler', kind: 'brief', tier: 1, cooldownTicks: 2, once: false,
        // Threshold far above anything thornfield's granary reaches in 3
        // ticks -- always true, so the pattern is possible every tick --
        // but the where-clause still puts a real (place, granary) pair in
        // this storylet's read-set, so an unrelated granary write CAN
        // coincidentally intersect it.
        pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'lt', value: fx('999999') }] }] },
        title: 'recycler', body: 'recycler',
        options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
        defaultOptionId: 'skip',
      };
    }
    function mkAnchor(): Storylet {
      return {
        id: 'anchor', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
        pattern: { nodes: [{ as: 'p', type: 'place' }] },
        title: 'anchor', body: 'anchor',
        options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
        defaultOptionId: 'skip',
      };
    }
    const season: SeasonConfig = {
      ...base,
      decks: [{ id: 'starter', tier: 1, storylets: [mkRecycler(), mkAnchor()] }],
      tiers: { ...base.tiers, 1: { ...base.tiers[1]!, briefBudget: 2 } },
      calendar: [],
    };
    const empty = { seatId: 'seat:throne', choices: [] };
    const f5 = makeFortune('cooldown-reentry-attribution-seed');

    // Tick 1: both possible (empty prior possibility set) -- budget 2, both dealt.
    const out1 = resolveTick(season, initialState(season), empty, f5);
    expect(out1.packet.briefs.map((b) => b.storyletId).sort()).toEqual(['anchor', 'recycler']);

    // Tick 2: recycler's cooldown is active (2 - 1 = 1 < 2) -- excluded
    // from the DEALT pool. No player write this call.
    const out2 = resolveTick(season, out1.state, empty, f5);
    expect(out2.packet.briefs.map((b) => b.storyletId)).toEqual(['anchor']);
    const anchorBrief2 = out2.packet.briefs[0]!;

    // Tick 3: recycler's cooldown clears (3 - 1 = 2, not < 2) -- back in
    // the dealt pool. This call ALSO submits an unrelated player write
    // (stockpile_grain, via a directive riding anchor's tick-2 brief) that
    // touches granary -- a real intersection with recycler's read-set.
    // Under the fix, recycler's pattern was possible continuously (its
    // where-clause is trivially true throughout), so it lands STANDING
    // here, not newly -- attribute() is never even asked about it.
    const out3 = resolveTick(season, out2.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: anchorBrief2.briefId, ops: [{ kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '10' }], via: 'directive' }],
    }, f5);
    expect(out3.packet.briefs.map((b) => b.storyletId)).toContain('recycler');
    const recyclerBrief3 = out3.packet.briefs.find((b) => b.storyletId === 'recycler')!;
    expect(recyclerBrief3.becauseOf).toBeUndefined();
  });
});
