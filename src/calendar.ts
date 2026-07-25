// The checkDeck-analog for examiner calendars (carry-over from the Phase 1
// final review): calendars are authored season data (D21: static, no
// chance) — this harness catches authoring errors before a season freezes.
import type { Deck, Storylet } from './storylet.js';
import type { ExaminerCalendar } from './scheduler.js';
import type { WorldGraph } from './graph.js';

/** entryIndex is -1 for deck-set-level problems not tied to any one
 *  calendar entry -- currently just a storylet id colliding across decks. */
export interface CalendarProblem { entryIndex: number; problem: string }

export function validateCalendar(
  calendar: ExaminerCalendar,
  decks: readonly Deck[],
  world: WorldGraph,
): CalendarProblem[] {
  const problems: CalendarProblem[] = [];
  // Built by hand, not `new Map(decks.flatMap(...))`: that shortcut is
  // last-wins on a storylet id colliding across decks, silently shadowing
  // the earlier deck's storylet (its kind/tier never even get checked). A
  // duplicate here is reported once per repeat encounter, entryIndex -1
  // since it isn't tied to any one calendar entry.
  const byId = new Map<string, Storylet>();
  for (const deck of decks) {
    for (const s of deck.storylets) {
      if (byId.has(s.id)) problems.push({ entryIndex: -1, problem: `duplicate storylet id '${s.id}' across decks` });
      byId.set(s.id, s);
    }
  }
  const armed = new Set<string>();
  calendar.forEach((entry, entryIndex) => {
    const bad = (problem: string) => problems.push({ entryIndex, problem });
    if (!Number.isSafeInteger(entry.tick) || entry.tick < 0) bad(`bad tick ${entry.tick}`);
    if (entry.storyletId !== undefined) {
      const s = byId.get(entry.storyletId);
      if (!s) bad(`unknown storylet '${entry.storyletId}'`);
      else if (s.kind !== 'brief') bad(`probe '${entry.storyletId}' is a ${s.kind}, not a brief`);
    }
    if (entry.armFamine) {
      const { placeId, durationTicks } = entry.armFamine;
      const node = world.nodes[placeId];
      if (!node || node.type !== 'place') bad(`armFamine target '${placeId}' is not a place`);
      if (!Number.isSafeInteger(durationTicks) || durationTicks < 1) bad(`bad durationTicks ${durationTicks}`);
      const key = `${entry.tick}:${placeId}`;
      if (armed.has(key)) bad(`duplicate armFamine for '${placeId}' at tick ${entry.tick}`);
      armed.add(key);
    }
  });
  return problems;
}
