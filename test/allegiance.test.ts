import { describe, expect, it } from 'vitest';
import { canonJson, hashValue } from '../src/canon.js';
import { fx } from '../src/fx.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { addNode, findEdge, setEdgeProp, setNodeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import { applyOp, validateOp } from '../src/ops.js';
import { socialStep } from '../src/systems.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';

type LogEntry = { tick: number; deltaBp: number; cause: string };

// A clean-slate character: no pre-existing loyalty or grudge edge to the
// ruler at all (unlike thornfieldGraph's osric/maud, who already carry
// one each), so creation-branch log entries can be pinned unambiguously.
// Carries `wealth` so `seize` validates against it.
function withVane(wealth = '400'): WorldGraph {
  return addNode(thornfieldGraph(), { id: 'char:vane', type: 'character', props: { name: 'Vane', wealth: fx(wealth) } });
}

function apply(g: WorldGraph, tick: number, op: unknown): { g: WorldGraph; eventId: string } {
  const em = makeEmitter(tick);
  const r = validateOp(g, op);
  if (!r.ok) throw new Error(r.error);
  const g2 = applyOp(g, r.op, tick, em, []);
  return { g: g2, eventId: em.all()[0]!.id };
}

// D14: chronicle events ARE graph deltas -- so an allegiance log entry born
// from an op must be reproducible purely by replaying that op's own
// recorded deltas, exactly like every other op mutation (ops.test.ts's
// "applyOp delta-equivalence" suite). This suite adds the log dimension on
// top of that existing discipline: not just "the bp landed right" but "the
// log entry documenting why is inside the SAME deltas[]".
describe('allegiance reason logs (spec §5)', () => {
  it('a seize that mints a fresh grudge appends one log entry naming the causing event; replay reproduces it', () => {
    const g0 = withVane();
    const em = makeEmitter(4);
    const r = validateOp(g0, { kind: 'seize', charId: 'char:vane', amount: '100' });
    if (!r.ok) throw new Error(r.error);
    const post = applyOp(g0, r.op, 4, em, []);
    const ev = em.all()[0]!;

    const edge = findEdge(post, 'grudge', 'char:vane', 'char:ruler');
    expect(edge?.props['bp']).toBe(2000);
    expect(edge?.props['log']).toEqual([{ tick: 4, deltaBp: 2000, cause: ev.id }]);

    // The log append must ride in the SAME deltas[] as the bp change (D14):
    // replaying ONLY this event's own deltas reproduces the full post-state.
    const replayed = applyDeltas(g0, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(post));
  });

  it('an update (not a creation) logs the actual signed delta applied, not the raw new bp', () => {
    // thornfieldGraph's maud already carries a grudge->ruler at 6500bp.
    // seize also needs a seizable `wealth` prop, absent from the base fixture.
    const g0 = setNodeProp(thornfieldGraph(), 'char:maud', 'wealth', fx('400'));
    const { g, eventId } = apply(g0, 5, { kind: 'seize', charId: 'char:maud', amount: '10' });
    const edge = findEdge(g, 'grudge', 'char:maud', 'char:ruler');
    expect(edge?.props['bp']).toBe(8500); // 6500 + 2000
    expect(edge?.props['log']).toEqual([{ tick: 5, deltaBp: 2000, cause: eventId }]);
  });

  it('nine bp-moving ops on one edge cap the log at 8 entries, oldest dropped, newest last', () => {
    let g = withVane();
    const eventIds: string[] = [];
    for (let i = 0; i < 9; i++) {
      const out = apply(g, 10 + i, { kind: 'send_envoy', charId: 'char:vane', tone: 'threatening' });
      g = out.g;
      eventIds.push(out.eventId);
    }
    expect(eventIds).toHaveLength(9);
    const log = findEdge(g, 'grudge', 'char:vane', 'char:ruler')?.props['log'] as LogEntry[];
    expect(log).toHaveLength(8);
    expect(log.map((e) => e.cause)).toEqual(eventIds.slice(1)); // oldest (index 0) dropped
    expect(log[log.length - 1]!.cause).toBe(eventIds[8]); // newest last
  });

  describe('socialStep drift folds into a single rolling time entry', () => {
    it('loyalty drift: one tick creates the entry, a second tick sums into it and refreshes the tick', () => {
      const em1 = makeEmitter(1);
      let g = socialStep(thornfieldGraph(), 1, em1);
      let edge = findEdge(g, 'loyalty', 'char:osric', 'char:ruler');
      expect(edge?.props['bp']).toBe(4300); // 4200 + 100 drift toward 5000
      expect(edge?.props['log']).toEqual([{ tick: 1, deltaBp: 100, cause: 'time' }]);

      const em2 = makeEmitter(2);
      g = socialStep(g, 2, em2);
      edge = findEdge(g, 'loyalty', 'char:osric', 'char:ruler');
      expect(edge?.props['bp']).toBe(4400); // another +100
      expect(edge?.props['log']).toEqual([{ tick: 2, deltaBp: 200, cause: 'time' }]); // summed into ONE entry
    });

    it('grudge decay drift also folds into the rolling time entry', () => {
      const em = makeEmitter(1);
      const g = socialStep(thornfieldGraph(), 1, em);
      const edge = findEdge(g, 'grudge', 'char:maud', 'char:ruler');
      expect(edge?.props['bp']).toBe(6450); // 6500 - 50 decay
      expect(edge?.props['log']).toEqual([{ tick: 1, deltaBp: -50, cause: 'time' }]);
    });

    it('an updated time entry stays IN PLACE -- it does not jump to the end past later discrete-cause entries', () => {
      let g = thornfieldGraph();
      const a = apply(g, 1, { kind: 'grant', charId: 'char:osric', amount: '20' }); // discrete entry @ index 0
      g = a.g;
      g = socialStep(g, 2, makeEmitter(2)); // time entry created @ index 1
      const b = apply(g, 3, { kind: 'grant', charId: 'char:osric', amount: '20' }); // discrete entry @ index 2
      g = b.g;
      g = socialStep(g, 4, makeEmitter(4)); // time entry updates IN PLACE (still index 1)

      const log = findEdge(g, 'loyalty', 'char:osric', 'char:ruler')?.props['log'] as LogEntry[];
      expect(log.map((e) => e.cause)).toEqual([a.eventId, 'time', b.eventId]);
      expect(log[1]).toEqual({ tick: 4, deltaBp: 200, cause: 'time' }); // 100 (tick2) + 100 (tick4)
    });
  });

  // D14 again, extended to the mixed case a real tick actually produces
  // (resolveTick applies ops, THEN runs socialStep in the same tick --
  // src/tick.ts steps 3 and 5-7): the op's own deltas replay correctly via
  // applyDeltas (chronicled), and the drift step -- which by design carries
  // no chronicle deltas of its own (see systems.ts's header comment) -- is
  // reproduced by re-invoking socialStep, exactly as src/replay.ts's
  // replay() does by re-running resolveTick rather than reading drift back
  // from events. Both halves together must reproduce the live graph
  // bit-exactly, logs included.
  describe('delta-equivalence across a mixed op+drift sequence', () => {
    it('op deltas replay via applyDeltas; drift is reproduced by re-running socialStep; combined result matches the live graph', () => {
      const g0 = thornfieldGraph();
      const em = makeEmitter(1);
      const r = validateOp(g0, { kind: 'grant', charId: 'char:osric', amount: '20' });
      if (!r.ok) throw new Error(r.error);
      const afterOp = applyOp(g0, r.op, 1, em, []);
      const live = socialStep(afterOp, 1, em); // same tick, same emitter -- mirrors resolveTick's own order

      const opDeltas = em.all().find((e) => e.type === 'op.grant')!.deltas;
      const replayedOp = applyDeltas(g0, opDeltas);
      expect(hashValue(replayedOp)).toBe(hashValue(afterOp)); // D14: the op alone

      const replayedFinal = socialStep(replayedOp, 1, makeEmitter(1)); // drift has no deltas to replay -- rerun it
      expect(hashValue(replayedFinal)).toBe(hashValue(live)); // combined: op replay + drift rerun == live
    });
  });

  describe('determinism', () => {
    it('two identical runs of a mixed ops+drift sequence produce bit-identical logs', () => {
      function run(): WorldGraph {
        let g = setNodeProp(thornfieldGraph(), 'char:maud', 'wealth', fx('400')); // seize needs seizable wealth
        g = apply(g, 1, { kind: 'grant', charId: 'char:osric', amount: '20' }).g;
        g = socialStep(g, 1, makeEmitter(1));
        g = apply(g, 2, { kind: 'seize', charId: 'char:maud', amount: '50' }).g;
        g = socialStep(g, 2, makeEmitter(2));
        return g;
      }
      const a = run();
      const b = run();
      expect(hashValue(a)).toBe(hashValue(b));

      const logA = findEdge(a, 'grudge', 'char:maud', 'char:ruler')?.props['log'];
      const logB = findEdge(b, 'grudge', 'char:maud', 'char:ruler')?.props['log'];
      expect(logA).toEqual(logB);
      expect(canonJson(logA)).toBe(canonJson(logB)); // explicit bit-identical check on the log itself, not just the graph hash
    });



  });

  describe('exposed-skimmer grudge.kindled instrumentation (spec D14)', () => {
    it('a lone kindled grudge with fresh edge: concatenated event deltas replay to the same graph', () => {
      const INTEREST = 'interest:char:osric->inst:crown';
      const LOYALTY_OSRIC = 'loyalty:char:osric->char:ruler';
      const GRUDGE_MAUD = 'grudge:char:maud->char:ruler';
      
      // Isolate the exposed-skimmer branch by neutralizing other socialStep paths:
      // set osric loyalty to 5000 (no drift), set maud's grudge to 0 (decay is a no-op),
      // and set unrest to 0 (no cooling).
      let g0 = setEdgeProp(thornfieldGraph(), LOYALTY_OSRIC, 'bp', 5000);
      g0 = setEdgeProp(g0, GRUDGE_MAUD, 'bp', 0);
      g0 = setNodeProp(g0, 'place:thornfield', 'unrest', fx('0'));
      g0 = setEdgeProp(g0, INTEREST, 'exposed', true);

      const em = makeEmitter(1);
      const post = socialStep(g0, 1, em);

      const events = em.all();
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('grudge.kindled');

      // Check that the log entry has the correct cause
      const grudgeEdge = findEdge(post, 'grudge', 'char:osric', 'char:ruler');
      expect(grudgeEdge?.props['log']).toBeDefined();
      const log = grudgeEdge?.props['log'] as LogEntry[];
      expect(log.length).toBeGreaterThan(0);
      const lastEntry = log[log.length - 1]!;
      expect(lastEntry.cause).toBe(events[0]!.id);

      const deltas = events.flatMap((e) => e.deltas);
      expect(deltas.length).toBeGreaterThan(0);
      const replayed = applyDeltas(g0, deltas);
      expect(hashValue(replayed)).toBe(hashValue(post));
    });
  });
});
