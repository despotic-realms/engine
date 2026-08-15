// Causality §2 (spec: meta/docs/specs/2026-08-08-causality-design.md §2;
// plan: meta/docs/plans/2026-08-08-causality-plan.md, Task 3): deed
// fingerprints. Every consequential op stamps `recent:<deed>` (the acting
// SEAT id -- actor-valued, multiplayer-proofed day one) and
// `recent:<deed>:at` (the tick) on its target, riding the op's OWN delta
// bundle (D14). A deterministic decay pass (systems.ts, adjacent to
// socialStep) clears both once `tick - at > FINGERPRINT_TICKS`.
//
// Table-driven over the closed 16-deed vocabulary (DEED_NAMES, src/ops.ts):
// this file imports that table directly rather than re-typing the deed
// strings, so the test suite and the production closed set can never drift
// apart silently.
import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/canon.js';
import { fx } from '../src/fx.js';
import { addNode, getNode, setNodeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { makeFortune } from '../src/fortune.js';
import { DEED_NAMES, DEEDS, ENVOY_DEED, FINGERPRINT_TICKS, applyOp, validateOp } from '../src/ops.js';
import type { Deed, Op } from '../src/ops.js';
import { applyMediatedOp } from '../src/mediate.js';
import type { MediationConfig } from '../src/mediate.js';
import { fingerprintDecayStep } from '../src/systems.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import { starterSeason } from '../src/decks/starter.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig } from '../src/tick.js';

const SEAT = 'seat:throne';

// A clean-slate character (char:vane) alongside thornfieldGraph()'s cast, so
// creation-branch fingerprint targets aren't tangled with osric/maud's
// pre-existing loyalty/grudge/interest edges -- mirrors ops.test.ts's own
// tier2ish() fixture. Carries `wealth` so `seize` validates.
function baseGraph(): WorldGraph {
  let g = thornfieldGraph();
  g = setNodeProp(g, 'char:maud', 'wealth', fx('400'));
  g = addNode(g, { id: 'char:vane', type: 'character', props: { name: 'Vane' } });
  return g;
}

// One fixture per deed: (op, targetId) against baseGraph(), EXCEPT 'pardoned'
// (needs a pre-imprisoned target -- built separately below) and the three
// envoy deeds (need op.tone bound explicitly, not derivable from DEEDS).
const DIRECT_CASES: Array<[Deed, Op, string]> = [
  ['granted', { kind: 'grant', charId: 'char:vane', amount: '10' }, 'char:vane'],
  ['seized', { kind: 'seize', charId: 'char:maud', amount: '50' }, 'char:maud'],
  ['audited', { kind: 'audit', officeId: 'office:steward' }, 'char:osric'], // the office's current holder, not the officeId itself
  ['appointed', { kind: 'appoint', charId: 'char:vane', officeId: 'office:steward' }, 'char:vane'],
  ['imprisoned', { kind: 'imprison', charId: 'char:vane' }, 'char:vane'],
  ['vetted', { kind: 'vet', charId: 'char:vane' }, 'char:vane'],
  ['festival', { kind: 'hold_festival', placeId: 'place:thornfield', amount: '40' }, 'place:thornfield'],
  ['invested', { kind: 'invest', placeId: 'place:thornfield', project: 'irrigation', amount: '80' }, 'place:thornfield'],
  ['grain-released', { kind: 'release_grain', placeId: 'place:thornfield', amount: '20' }, 'place:thornfield'],
  ['grain-bought', { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '40' }, 'place:thornfield'],
  ['levy-raised', { kind: 'raise_levy', placeId: 'place:thornfield', size: '50' }, 'place:thornfield'],
  ['taxed', { kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 }, 'place:thornfield'],
];

const ENVOY_CASES: Array<[Deed, 'conciliatory' | 'firm' | 'threatening']> = [
  ['envoy-warm', 'conciliatory'],
  ['envoy-firm', 'firm'],
  ['envoy-hard', 'threatening'],
];

describe('deed fingerprints: DEEDS/ENVOY_DEED cover the closed 16-deed set exactly (causality §2)', () => {
  it('DIRECT_CASES + ENVOY_CASES together name every DEED_NAMES entry, once each', () => {
    const covered = [...DIRECT_CASES.map((c) => c[0]), 'pardoned' as Deed, ...ENVOY_CASES.map((c) => c[0])];
    expect(covered.slice().sort()).toEqual([...DEED_NAMES].sort());
    expect(new Set(covered).size).toBe(DEED_NAMES.length); // no duplicates
  });

  it('DEEDS (non-envoy) and ENVOY_DEED together are the sole source of deed names, and both are closed', () => {
    const fromTables = [...Object.values(DEEDS), ...Object.values(ENVOY_DEED)];
    expect(fromTables.slice().sort()).toEqual([...DEED_NAMES].sort());
  });
});

describe('deed fingerprints: table-driven over all 16 deeds (causality §2)', () => {
  it.each(DIRECT_CASES)('%s: stamps recent:%s = seat, recent:%s:at = tick on the target, inside the op\'s own delta bundle', (deed, op, targetId) => {
    const g0 = baseGraph();
    const r = validateOp(g0, op);
    if (!r.ok) throw new Error(r.error);
    const tick = 5;
    const em = makeEmitter(tick);
    const g = applyOp(g0, r.op, tick, em, SEAT);

    expect(getNode(g, targetId).props[`recent:${deed}`]).toBe(SEAT);
    expect(getNode(g, targetId).props[`recent:${deed}:at`]).toBe(tick);

    // The stamp rides the op's OWN event -- not a separate event -- and that
    // event's deltas alone replay to the same post-op graph (D14).
    const ev = em.all().find((e) => e.type === `op.${op.kind}`)!;
    expect(ev).toBeDefined();
    const stampDeltas = ev.deltas.filter((d) => d.op === 'node.set' && d.id === targetId && (d.key === `recent:${deed}` || d.key === `recent:${deed}:at`));
    expect(stampDeltas).toHaveLength(2);
    const replayed = applyDeltas(g0, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(g));
  });

  it.each(ENVOY_CASES)('%s: send_envoy tone %s stamps the matching deed on the target character', (deed, tone) => {
    const g0 = baseGraph();
    const op: Op = { kind: 'send_envoy', charId: 'char:vane', tone };
    const r = validateOp(g0, op);
    if (!r.ok) throw new Error(r.error);
    const tick = 5;
    const em = makeEmitter(tick);
    const g = applyOp(g0, r.op, tick, em, SEAT);

    expect(getNode(g, 'char:vane').props[`recent:${deed}`]).toBe(SEAT);
    expect(getNode(g, 'char:vane').props[`recent:${deed}:at`]).toBe(tick);
    const ev = em.all().find((e) => e.type === 'op.send_envoy')!;
    const replayed = applyDeltas(g0, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(g));
  });

  // 'firm' used to be ops.ts's documented zero-delta contract (no state
  // change at all). It no longer is: a fingerprint stamp IS now firm's one
  // and only effect, so this deliberately pins the new shape rather than
  // leaving the old "byte-identical" assumption to bit-rot silently.
  it("send_envoy 'firm' now carries exactly the two stamp deltas -- no longer a zero-delta contract", () => {
    const g0 = baseGraph();
    const r = validateOp(g0, { kind: 'send_envoy', charId: 'char:vane', tone: 'firm' });
    if (!r.ok) throw new Error(r.error);
    const em = makeEmitter(3);
    const g = applyOp(g0, r.op, 3, em, SEAT);
    const ev = em.all()[0]!;
    expect(ev.deltas).toHaveLength(2);
    expect(hashValue(g)).not.toBe(hashValue(g0));
    expect(getNode(g, 'char:vane').props['recent:envoy-firm']).toBe(SEAT);
  });

  it("pardoned: stamps on the target, which must already be imprisoned to validate", () => {
    const g0 = baseGraph();
    const emImp = makeEmitter(3);
    const rImp = validateOp(g0, { kind: 'imprison', charId: 'char:vane' });
    if (!rImp.ok) throw new Error(rImp.error);
    const imprisoned = applyOp(g0, rImp.op, 3, emImp, SEAT);

    const tick = 5;
    const em = makeEmitter(tick);
    const r = validateOp(imprisoned, { kind: 'pardon', charId: 'char:vane' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(imprisoned, r.op, tick, em, SEAT);

    expect(getNode(g, 'char:vane').props['recent:pardoned']).toBe(SEAT);
    expect(getNode(g, 'char:vane').props['recent:pardoned:at']).toBe(tick);
    const ev = em.all().find((e) => e.type === 'op.pardon')!;
    const replayed = applyDeltas(imprisoned, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(g));
  });
});

describe('deed fingerprints: actor-valued, not hardcoded (causality §2 -- multiplayer-proofed)', () => {
  it('the stamped value is whatever seatId is actually passed, proven with two distinct seats', () => {
    const g0 = baseGraph();
    const op = { kind: 'grant', charId: 'char:vane', amount: '10' } as const;
    const r = validateOp(g0, op);
    if (!r.ok) throw new Error(r.error);

    const emA = makeEmitter(3);
    const gA = applyOp(g0, r.op, 3, emA, 'seat:alpha');
    expect(getNode(gA, 'char:vane').props['recent:granted']).toBe('seat:alpha');

    const emB = makeEmitter(3);
    const gB = applyOp(g0, r.op, 3, emB, 'seat:beta');
    expect(getNode(gB, 'char:vane').props['recent:granted']).toBe('seat:beta');
  });

  it('mediated execution stamps the DECIDING seat (the seatId param), never the executor character who actually did the work', () => {
    // office:steward's holder in baseGraph() (via thornfieldGraph()) is
    // char:osric, with no apt:econ set (defaults to 5000 -- a 12% botched
    // weight, bands.ts). Scanned for a non-botched seed (mirrors mediate.
    // test.ts's own "no sub-sound draw in N seeds" idiom) rather than
    // trusting one fixed seed never to land on the one band that skips
    // applyOp entirely -- a botched draw would leave nothing to assert.
    const cfg: MediationConfig = { officeForDomain: { econ: 'office:steward', martial: 'office:none', social: 'office:none' }, willingness: false };
    for (let s = 0; s < 20; s++) {
      const g0 = baseGraph();
      const em = makeEmitter(4);
      const g = applyMediatedOp(g0, { kind: 'stockpile_grain', placeId: 'place:thornfield', amount: '10' }, 4, makeFortune(`fp-mediated-${s}`), em, cfg, SEAT);
      const executed = em.all().find((e) => e.type === 'op.executed');
      const band = (executed!.data as { band: string }).band;
      if (band === 'botched') continue;
      expect(getNode(g, 'place:thornfield').props['recent:grain-bought']).toBe(SEAT); // the deciding seat
      expect(getNode(g, 'place:thornfield').props['recent:grain-bought']).not.toBe('char:osric'); // never the executor
      return;
    }
    throw new Error('no non-botched draw in 20 seeds — widen scan');
  });
});

describe('deed fingerprints: excluded ops never stamp (causality §2 -- closed set)', () => {
  it('record_stance stamps nothing (spec exclusion: stances are already the durable marker)', () => {
    const g0 = baseGraph();
    const r = validateOp(g0, { kind: 'record_stance', stanceId: 'granary-doctrine', value: 'for' });
    if (!r.ok) throw new Error(r.error);
    const em = makeEmitter(3);
    const g = applyOp(g0, r.op, 3, em, SEAT);
    const ev = em.all()[0]!;
    expect(ev.deltas.every((d) => d.op !== 'node.set' || !String(d.key).startsWith('recent:'))).toBe(true);
  });

  it('obscure_records stamps nothing (spec exclusion)', () => {
    const g0 = baseGraph();
    const r = validateOp(g0, { kind: 'obscure_records' });
    if (!r.ok) throw new Error(r.error);
    const em = makeEmitter(3);
    const g = applyOp(g0, r.op, 3, em, SEAT);
    const ev = em.all()[0]!;
    expect(ev.deltas.every((d) => d.op !== 'node.set' || !String(d.key).startsWith('recent:'))).toBe(true);
  });

  it('disband_levy stamps nothing (never added to the v1 deed vocabulary)', () => {
    const g0 = setNodeProp(baseGraph(), 'place:thornfield', 'levy', fx('50'));
    const r = validateOp(g0, { kind: 'disband_levy', placeId: 'place:thornfield' });
    if (!r.ok) throw new Error(r.error);
    const em = makeEmitter(3);
    const g = applyOp(g0, r.op, 3, em, SEAT);
    const ev = em.all()[0]!;
    expect(ev.deltas.every((d) => d.op !== 'node.set' || !String(d.key).startsWith('recent:'))).toBe(true);
  });
});

describe('deed fingerprint decay (causality §2: FINGERPRINT_TICKS = 3)', () => {
  it('FINGERPRINT_TICKS is exactly 3', () => {
    expect(FINGERPRINT_TICKS).toBe(3);
  });

  it('stamped at t: still present at t+3, cleared (both props) at t+4, with fingerprints.faded carrying it and replay reproducing', () => {
    const g0 = baseGraph();
    const r = validateOp(g0, { kind: 'grant', charId: 'char:vane', amount: '10' });
    if (!r.ok) throw new Error(r.error);
    const stampTick = 1;
    const emStamp = makeEmitter(stampTick);
    const stamped = applyOp(g0, r.op, stampTick, emStamp, SEAT);
    expect(getNode(stamped, 'char:vane').props['recent:granted']).toBe(SEAT);
    expect(getNode(stamped, 'char:vane').props['recent:granted:at']).toBe(stampTick);

    // t+3: 4 - 1 = 3, not > 3 -- still present, decay pass is a no-op (same graph, no event).
    const stillTick = stampTick + FINGERPRINT_TICKS;
    const emStill = makeEmitter(stillTick);
    const still = fingerprintDecayStep(stamped, stillTick, emStill);
    expect(getNode(still, 'char:vane').props['recent:granted']).toBe(SEAT);
    expect(getNode(still, 'char:vane').props['recent:granted:at']).toBe(stampTick);
    expect(emStill.all()).toHaveLength(0);
    expect(hashValue(still)).toBe(hashValue(stamped));

    // t+4: 5 - 1 = 4 > 3 -- cleared.
    const fadeTick = stampTick + FINGERPRINT_TICKS + 1;
    const emFade = makeEmitter(fadeTick);
    const faded = fingerprintDecayStep(stamped, fadeTick, emFade);
    expect(getNode(faded, 'char:vane').props['recent:granted']).toBe('');
    expect(getNode(faded, 'char:vane').props['recent:granted:at']).toBe(-1);

    const ev = emFade.all().find((e) => e.type === 'fingerprints.faded');
    expect(ev).toBeDefined();
    expect(ev!.parents).toEqual([]); // systemic pass: never player-descended (T2's ancestry invariant)
    expect(ev!.data['fades']).toEqual([{ nodeId: 'char:vane', deed: 'granted', seatId: SEAT, at: stampTick }]);

    const replayed = applyDeltas(stamped, ev!.deltas);
    expect(hashValue(replayed)).toBe(hashValue(faded));
  });

  it('multiple simultaneous fades collapse into ONE fingerprints.faded event carrying all of them, order-stable by node id', () => {
    let g = baseGraph();
    const stampTick = 1;
    // Two independent deeds on two independent nodes, same stamp tick.
    const em1 = makeEmitter(stampTick);
    const r1 = validateOp(g, { kind: 'grant', charId: 'char:vane', amount: '10' });
    if (!r1.ok) throw new Error(r1.error);
    g = applyOp(g, r1.op, stampTick, em1, SEAT);

    const em2 = makeEmitter(stampTick);
    const r2 = validateOp(g, { kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 });
    if (!r2.ok) throw new Error(r2.error);
    g = applyOp(g, r2.op, stampTick, em2, SEAT);

    const fadeTick = stampTick + FINGERPRINT_TICKS + 1;
    const em = makeEmitter(fadeTick);
    const faded = fingerprintDecayStep(g, fadeTick, em);

    const events = em.all();
    expect(events).toHaveLength(1); // ONE event, not two
    const ev = events[0]!;
    expect(ev.type).toBe('fingerprints.faded');
    const fades = ev.data['fades'] as Array<{ nodeId: string; deed: string }>;
    expect(fades).toHaveLength(2);
    // Order-stable: sorted by node id ('char:vane' < 'place:thornfield').
    expect(fades.map((f) => f.nodeId)).toEqual(['char:vane', 'place:thornfield']);
    expect(ev.deltas).toHaveLength(4); // 2 props cleared x 2 fades

    expect(getNode(faded, 'char:vane').props['recent:granted']).toBe('');
    expect(getNode(faded, 'place:thornfield').props['recent:taxed']).toBe('');

    const replayed = applyDeltas(g, ev.deltas);
    expect(hashValue(replayed)).toBe(hashValue(faded));
  });

  it('a never-stamped node is inert to decay: no fade, no event, graph unchanged', () => {
    const g0 = baseGraph();
    const em = makeEmitter(100);
    const g = fingerprintDecayStep(g0, 100, em);
    expect(em.all()).toHaveLength(0);
    expect(hashValue(g)).toBe(hashValue(g0));
  });

  it('an already-decayed fingerprint does not re-fade on a later pass (no repeat events)', () => {
    const g0 = baseGraph();
    const r = validateOp(g0, { kind: 'grant', charId: 'char:vane', amount: '10' });
    if (!r.ok) throw new Error(r.error);
    const em0 = makeEmitter(1);
    const stamped = applyOp(g0, r.op, 1, em0, SEAT);
    const em1 = makeEmitter(10);
    const oncefaded = fingerprintDecayStep(stamped, 10, em1);
    expect(em1.all()).toHaveLength(1);
    const em2 = makeEmitter(20);
    const twicefaded = fingerprintDecayStep(oncefaded, 20, em2);
    expect(em2.all()).toHaveLength(0); // '' seat value never re-qualifies -- gated on seatVal !== ''
    expect(hashValue(twicefaded)).toBe(hashValue(oncefaded));
  });

  it('determinism: decay of the same input at the same tick is bit-identical across two independent calls', () => {
    const g0 = baseGraph();
    const r = validateOp(g0, { kind: 'seize', charId: 'char:maud', amount: '50' });
    if (!r.ok) throw new Error(r.error);
    const stamped = applyOp(g0, r.op, 1, makeEmitter(1), SEAT);

    const emA = makeEmitter(10);
    const a = fingerprintDecayStep(stamped, 10, emA);
    const emB = makeEmitter(10);
    const b = fingerprintDecayStep(stamped, 10, emB);
    expect(hashValue(a)).toBe(hashValue(b));
    expect(emA.all()).toEqual(emB.all());
  });
});

describe('deed fingerprints wired end-to-end through resolveTick (verifies the seatId wiring)', () => {
  it("a directive-applied grant op stamps recent:granted with decisions.seatId (the throne's seat)", () => {
    const season = starterSeason();
    const f = makeFortune('fp-e2e-wiring');
    const state = initialState(season);
    const out = resolveTick(season, state, { seatId: 'seat:throne', choices: [] }, f);
    const brief = out.packet.briefs[0];
    if (!brief) throw new Error('expected at least one brief at tick 1');
    const next = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'grant', charId: 'char:osric', amount: '10' }], via: 'directive' }],
    }, f);
    expect(getNode(next.state.graph, 'char:osric').props['recent:granted']).toBe('seat:throne');
    expect(getNode(next.state.graph, 'char:osric').props['recent:granted:at']).toBe(next.state.tick - 1);
  });

  it('fingerprint decay is wired into the real tick pipeline: a stamp fades on schedule across real resolveTicks', () => {
    const season = starterSeason();
    const f = makeFortune('fp-e2e-decay');
    let out = resolveTick(season, initialState(season), { seatId: 'seat:throne', choices: [] }, f);
    const brief = out.packet.briefs[0];
    if (!brief) throw new Error('expected at least one brief');
    out = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'grant', charId: 'char:osric', amount: '10' }], via: 'directive' }],
    }, f);
    expect(getNode(out.state.graph, 'char:osric').props['recent:granted']).toBe('seat:throne');

    // Run enough further ticks to clear FINGERPRINT_TICKS with room to
    // spare, collecting every event along the way -- robust to exactly
    // which tick the fade lands on, rather than pinning an offset by hand.
    const collected = [...out.events];
    for (let i = 0; i < FINGERPRINT_TICKS + 3; i++) {
      out = resolveTick(season, out.state, { seatId: 'seat:throne', choices: [] }, f);
      collected.push(...out.events);
    }
    expect(getNode(out.state.graph, 'char:osric').props['recent:granted']).toBe('');
    expect(getNode(out.state.graph, 'char:osric').props['recent:granted:at']).toBe(-1);
    const fadeEvent = collected.find((e) => e.type === 'fingerprints.faded');
    expect(fadeEvent).toBeDefined();
    expect((fadeEvent!.data['fades'] as Array<{ nodeId: string; deed: string }>).some((fd) => fd.nodeId === 'char:osric' && fd.deed === 'granted')).toBe(true);
  });
});

// Context note (T2 composition, kept lean per the task brief): a stamp is
// just another node.set delta inside a player-descended op event -- T2's
// attribution reads write-sets off deltas generically, with no
// special-casing for fingerprints. This proves the composition holds: a
// brief gated on `recent:<deed>` becomes newly-eligible the tick a player op
// stamps it, and that op's own event id shows up in becauseOf. Structure
// mirrors test/attribution.test.ts's own "end-to-end via resolveTick" case:
// a minimal-override SeasonConfig on top of starterSeason()'s throne/
// reporters/tierRules/initialGraph.
describe('deed fingerprints compose with T2 attribution (causality §1+§2, no special-casing)', () => {
  it('an op stamping recent:envoy-warm makes a recent:envoy-warm-gated brief newly-eligible next tick, attributed to that op', () => {
    const carrier: import('../src/storylet.js').Storylet = {
      id: 'fp.carrier', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place' }] },
      title: 'Carrier', body: 'Carrier',
      options: [
        { id: 'warm', label: 'Send a warm envoy', ops: [{ kind: 'send_envoy', charId: 'char:osric', tone: 'conciliatory' }] },
        { id: 'skip', label: 'Skip', ops: [] },
      ],
      defaultOptionId: 'skip',
    };
    const reaction: import('../src/storylet.js').Storylet = {
      id: 'fp.reaction', kind: 'brief', tier: 1, cooldownTicks: 0, once: false,
      pattern: { nodes: [{ as: 'c', type: 'character', where: [{ prop: 'recent:envoy-warm', cmp: 'ne', value: '' }] }] },
      title: 'Reaction', body: 'Reaction',
      options: [{ id: 'ack', label: 'Acknowledge', ops: [] }, { id: 'skip', label: 'Skip', ops: [] }],
      defaultOptionId: 'skip',
    };
    const base = starterSeason();
    const season: SeasonConfig = {
      ...base,
      decks: [{ id: 'starter', tier: 1, storylets: [carrier, reaction] }],
      tiers: { ...base.tiers, 1: { ...base.tiers[1]!, briefBudget: 2 } },
      calendar: [],
    };
    const f = makeFortune('fp-attribution-compose');

    // Tick 1: only the carrier is eligible -- nobody has recent:envoy-warm yet.
    const out1 = resolveTick(season, initialState(season), { seatId: 'seat:throne', choices: [] }, f);
    expect(out1.packet.briefs.map((b) => b.storyletId)).toEqual(['fp.carrier']);
    const carrierBrief = out1.packet.briefs[0]!;

    // Tick 2: choosing 'warm' stamps recent:envoy-warm on char:osric as PART
    // of resolving this tick -- fp.reaction becomes newly-eligible off that
    // very write and must be attributed to the op's own event.
    const out2 = resolveTick(season, out1.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: carrierBrief.briefId, optionId: 'warm' }],
    }, f);
    expect(out2.packet.briefs.map((b) => b.storyletId)).toContain('fp.reaction');

    const opEvent = out2.events.find((e) => e.type === 'op.send_envoy')!;
    expect(opEvent).toBeDefined();
    expect(getNode(out2.state.graph, 'char:osric').props['recent:envoy-warm']).toBe('seat:throne');
    const reactionBrief = out2.packet.briefs.find((b) => b.storyletId === 'fp.reaction')!;
    expect(reactionBrief.becauseOf).toEqual([opEvent.id]);
  });
});
