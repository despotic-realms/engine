import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { makeFortune } from '../src/fortune.js';
import { getNode, propInt } from '../src/graph.js';
import { advanceArcs, examiner } from '../src/scheduler.js';
import { eligibleStorylets } from '../src/storylet.js';
import { starterDeck } from '../src/decks/starter.js';
import { thornfieldGraph, thornfieldStressedGraph } from '../src/decks/thornfield.js';
import type { ExaminerCalendar } from '../src/scheduler.js';

const f = makeFortune('scheduler-test-seed');
const CAL: ExaminerCalendar = [
  { tick: 4, storyletId: 'starter.audit-whisper' },
  { tick: 4, armFamine: { placeId: 'place:thornfield', durationTicks: 4 } },
  { tick: 9, storyletId: 'starter.not-in-deck' },
];

describe('examiner', () => {
  it('forces calendar probes, fills the rest from the casting stream', () => {
    const eligible = eligibleStorylets(thornfieldGraph(), [starterDeck], {}, 4, {});
    const sel = examiner.select({ tick: 4, briefBudget: 2, eligible, fortune: f, calendar: CAL });
    expect(sel.chosen.map((e) => e.storylet.id)).toContain('starter.audit-whisper');
    expect(sel.chosen).toHaveLength(2);
    expect(sel.letters.every((e) => e.storylet.kind === 'letter')).toBe(true);
    const again = examiner.select({ tick: 4, briefBudget: 2, eligible, fortune: f, calendar: CAL });
    expect(again.chosen.map((e) => e.storylet.id)).toEqual(sel.chosen.map((e) => e.storylet.id));
  });
  it('records unfillable probes instead of inventing them', () => {
    const eligible = eligibleStorylets(thornfieldGraph(), [starterDeck], {}, 9, {});
    const sel = examiner.select({ tick: 9, briefBudget: 1, eligible, fortune: f, calendar: CAL });
    expect(sel.skippedProbes).toEqual(['starter.not-in-deck']);
  });
});

// D14: advanceArcs is delta-native -- the same discipline economyStep and
// socialStep follow (test/systems.test.ts, test/ladder.test.ts). Every
// famineStage/famineEndsAt mutation is built as a GraphDelta[], applied
// through applyDeltas, and handed to the emitted event as its `deltas`.
// advanceArcs has no continuous-decay exemption (every mutation is
// evented), so full equivalence holds on every call: replaying a call's
// concatenated event deltas onto that call's own pre-graph must hash-equal
// its actual return value. Asserted after each call in the lifecycle below
// -- arm, three advances, and the end -- not just once at the finish.
describe('advanceArcs', () => {
  it('arms, advances, and ends the famine on schedule', () => {
    let g = thornfieldGraph();

    let pre = g;
    const em = makeEmitter(4);
    g = advanceArcs(g, 4, CAL, em);
    expect(propInt(getNode(g, 'place:thornfield').props, 'famineStage')).toBe(1);
    expect(em.all()[0]?.type).toBe('crisis.famine.armed');
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    pre = g;
    const em5 = makeEmitter(5);
    g = advanceArcs(g, 5, CAL, em5);
    expect(propInt(getNode(g, 'place:thornfield').props, 'famineStage')).toBe(2);
    expect(hashValue(applyDeltas(pre, em5.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    pre = g;
    const em6 = makeEmitter(6);
    g = advanceArcs(g, 6, CAL, em6);
    expect(hashValue(applyDeltas(pre, em6.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    pre = g;
    const em7 = makeEmitter(7);
    g = advanceArcs(g, 7, CAL, em7);
    expect(propInt(getNode(g, 'place:thornfield').props, 'famineStage')).toBe(4);
    expect(hashValue(applyDeltas(pre, em7.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    pre = g;
    const emEnd = makeEmitter(8);
    g = advanceArcs(g, 8, CAL, emEnd);
    expect(propInt(getNode(g, 'place:thornfield').props, 'famineStage')).toBe(0);
    expect(emEnd.all().some((e) => e.type === 'crisis.famine.ended')).toBe(true);
    expect(hashValue(applyDeltas(pre, emEnd.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));
  });
});
