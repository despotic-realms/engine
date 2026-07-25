import { describe, expect, it } from 'vitest';
import { validateCalendar } from '../src/calendar.js';
import { starterDeck } from '../src/decks/starter.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import type { Deck } from '../src/storylet.js';

const g = thornfieldGraph();

describe('validateCalendar', () => {
  it('passes the starter season calendar shape', () => {
    expect(validateCalendar(
      [{ tick: 4, storyletId: 'starter.audit-whisper' }, { tick: 4, armFamine: { placeId: 'place:thornfield', durationTicks: 4 } }],
      [starterDeck], g,
    )).toEqual([]);
  });
  it('rejects unknown probe ids, letter probes, bad places, duplicate arms, bad ticks', () => {
    const problems = validateCalendar(
      [
        { tick: 2, storyletId: 'starter.not-a-storylet' },          // 0: unknown id
        { tick: 2, storyletId: 'starter.rival-letter' },            // 1: letters cannot be probes
        { tick: 3, armFamine: { placeId: 'char:osric', durationTicks: 2 } },   // 2: not a place
        { tick: 5, armFamine: { placeId: 'place:thornfield', durationTicks: 3 } },
        { tick: 5, armFamine: { placeId: 'place:thornfield', durationTicks: 4 } }, // 4: duplicate same-tick arm
        { tick: -1, storyletId: 'starter.tax-grumble' },            // 5: bad tick
        { tick: 6, armFamine: { placeId: 'place:thornfield', durationTicks: 0 } }, // 6: bad duration
      ],
      [starterDeck], g,
    );
    expect(problems.map((p) => p.entryIndex).sort((a, b) => a - b)).toEqual([0, 1, 2, 4, 5, 6]);
  });
  // Carried from P2 Task 2's review: byId was `new Map(decks.flatMap(...))`,
  // last-wins on a storylet id colliding across two decks -- silently
  // shadowing the earlier deck's storylet (its kind/tier never even get
  // looked at). entryIndex -1 marks this as a deck-set-level problem, not
  // tied to any one calendar entry.
  it('reports a deck-set-level problem when two decks share a storylet id', () => {
    const deckOf = (id: string): Deck => ({
      id,
      tier: 1,
      storylets: [{
        id: 'shared.id', kind: 'brief', tier: 1, cooldownTicks: 1, once: false,
        pattern: { nodes: [] },
        title: 't', body: 'b',
        options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
        defaultOptionId: 'a',
      }],
    });
    const problems = validateCalendar([], [deckOf('deckA'), deckOf('deckB')], g);
    expect(problems).toEqual([{ entryIndex: -1, problem: "duplicate storylet id 'shared.id' across decks" }]);
  });
});
