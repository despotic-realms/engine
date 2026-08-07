// Task 9 (spec §9): the realm-intelligence apparatus -- the player's
// counter-play against the fog Task 5's observation model creates. Two new
// ops (vet buys a true-ish read of a target's own best aptitude, gated on
// the VETTING authority's judgment; obscure_records makes the crown's OWN
// records lie to a rival's next poach bid) plus a new arc kind: a scheme
// that arms in secret, optionally telegraphs itself to a competent
// spymaster at the midpoint, and either resolves peacefully (retention) or
// detonates (strike: legitimacy and unrest damage, the schemer departs).
import { describe, expect, it } from 'vitest';
import { canonJson, hashValue } from '../src/canon.js';
import { applyDeltas, makeEmitter } from '../src/events.js';
import { fx } from '../src/fx.js';
import type { Fortune } from '../src/fortune.js';
import { makeFortune } from '../src/fortune.js';
import { addEdge, addNode, edgeId, emptyGraph, findEdge, getNode, propFx, setEdgeProp, setNodeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import { applyOp, validateOp } from '../src/ops.js';
import { judgeFidelityBand, vetObservation } from '../src/observe.js';
import type { CharacterArc } from '../src/arcs.js';
import { advanceCharacterArcs } from '../src/arcs.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig } from '../src/tick.js';

// -- fixtures ----------------------------------------------------------

// A minimal world: crown (treasury 300, legitimacy 50) + ruler + one place
// (unrest 10) + one target character with no aptitudes/traits set (so
// every apt:* defaults to 5000, per spine.ts's APT_DEFAULT) -- tests layer
// on whatever aptitudes/traits/edges/props they need.
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
  g = addNode(g, { id: 'char:target', type: 'character', props: { name: 'Target' } });
  return g;
}

function withSpymaster(g: WorldGraph, judge: number): WorldGraph {
  let g2 = addNode(g, { id: 'char:spymaster', type: 'character', props: { name: 'Spymaster', 'apt:judge': judge } });
  g2 = addNode(g2, { id: 'office:spymaster', type: 'office', props: { title: 'Spymaster' } });
  g2 = addEdge(g2, { type: 'appointment', src: 'char:spymaster', dst: 'office:spymaster', props: { since: 0 } });
  return g2;
}

/** Wraps a real Fortune to count `.int` calls -- the same spy idiom
 *  observe.test.ts/mediate.test.ts use, so a no-draw/one-draw claim is
 *  proven, not merely inferred from output. */
function countingFortune(seed: string): { fortune: Fortune; count: () => number } {
  let calls = 0;
  const real = makeFortune(seed);
  const fortune: Fortune = {
    roll: real.roll,
    bp: real.bp,
    pick: real.pick,
    int: (stream, t, key, lo, hi, n) => {
      calls++;
      return real.int(stream, t, key, lo, hi, n);
    },
  };
  return { fortune, count: () => calls };
}

// ========================================================================
// vet: validateOp + applyOp
// ========================================================================

describe('vet: validateOp', () => {
  it('accepts a well-formed op when treasury can afford it', () => {
    expect(validateOp(baseGraph(), { kind: 'vet', charId: 'char:target' }).ok).toBe(true);
  });
  it('accepts exactly at the cost boundary (treasury === 5)', () => {
    const g = setNodeProp(baseGraph(), 'inst:crown', 'treasury', fx('5'));
    expect(validateOp(g, { kind: 'vet', charId: 'char:target' }).ok).toBe(true);
  });
  it('rejects when treasury < 5', () => {
    const g = setNodeProp(baseGraph(), 'inst:crown', 'treasury', fx('4.9999'));
    const r = validateOp(g, { kind: 'vet', charId: 'char:target' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('treasury cannot afford a vetting');
  });
  it('rejects a missing charId', () => {
    expect(validateOp(baseGraph(), { kind: 'vet' }).ok).toBe(false);
  });
  it('rejects a charId that is not a character node', () => {
    expect(validateOp(baseGraph(), { kind: 'vet', charId: 'place:ash' }).ok).toBe(false);
  });
  it('rejects an unexpected extra field', () => {
    expect(validateOp(baseGraph(), { kind: 'vet', charId: 'char:target', extra: 1 }).ok).toBe(false);
  });
});

describe('vet: applyOp', () => {
  it('debits treasury by exactly 5 and chronicles op.vet', () => {
    const em = makeEmitter(3);
    const g0 = baseGraph();
    const r = validateOp(g0, { kind: 'vet', charId: 'char:target' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('295'));
    expect(em.all()[0]?.type).toBe('op.vet');
    expect(em.all()[0]?.data).toEqual({ kind: 'vet', charId: 'char:target' });
  });
});

describe('obscure_records: validateOp', () => {
  it('accepts a bare {kind} shape when treasury can afford it', () => {
    expect(validateOp(baseGraph(), { kind: 'obscure_records' }).ok).toBe(true);
  });
  it('rejects any extra field -- there are no params beyond kind', () => {
    expect(validateOp(baseGraph(), { kind: 'obscure_records', charId: 'char:target' }).ok).toBe(false);
  });
  it('rejects when treasury < 10', () => {
    const g = setNodeProp(baseGraph(), 'inst:crown', 'treasury', fx('9'));
    const r = validateOp(g, { kind: 'obscure_records' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('treasury cannot afford counter-intelligence');
  });
});

describe('obscure_records: applyOp', () => {
  it('debits treasury by exactly 10 and sets counterIntel: true, chronicling op.obscure_records', () => {
    const em = makeEmitter(3);
    const g0 = baseGraph();
    const r = validateOp(g0, { kind: 'obscure_records' });
    if (!r.ok) throw new Error(r.error);
    const g = applyOp(g0, r.op, 3, em);
    expect(propFx(getNode(g, 'inst:crown').props, 'treasury')).toBe(fx('290'));
    expect(getNode(g, 'inst:crown').props['counterIntel']).toBe(true);
    expect(em.all()[0]?.type).toBe('op.obscure_records');
  });
});

describe('vet/obscure_records: applyOp delta-equivalence (spec D14)', () => {
  const cases: Array<[string, unknown]> = [
    ['vet', { kind: 'vet', charId: 'char:target' }],
    ['obscure_records', { kind: 'obscure_records' }],
  ];
  it.each(cases)('%s: event.deltas replay to the same graph applyOp produced', (_name, op) => {
    const g0 = baseGraph();
    const r = validateOp(g0, op);
    if (!r.ok) throw new Error(r.error);
    const em = makeEmitter(3);
    const post = applyOp(g0, r.op, 3, em);
    const ev = em.all()[0]!;
    expect(ev.deltas.length).toBeGreaterThan(0);
    expect(hashValue(applyDeltas(g0, ev.deltas))).toBe(hashValue(post));
  });
});

// ========================================================================
// judgeFidelityBand: the extracted rules 4-6, shared by observeExecutions
// (unchanged behavior -- see observe.test.ts) and vetObservation (below).
// ========================================================================

describe('judgeFidelityBand (rules 4-6, extracted for reuse)', () => {
  it('judge >= 6000 returns the true band untouched and never touches fortune (rule 4)', () => {
    const g = setNodeProp(baseGraph(), 'char:ruler', 'apt:judge', 6000);
    const { fortune, count } = countingFortune('jfb-rule4');
    expect(judgeFidelityBand(g, 'char:ruler', 'poor', 3, fortune, 'any-key')).toBe('poor');
    expect(count()).toBe(0);
  });
  it('judge < 4000 draws once and matches a direct fortune.int replay with the same key (rule 6)', () => {
    const g = setNodeProp(baseGraph(), 'char:ruler', 'apt:judge', 0);
    const drawKey = 'k-jfb-rule6';
    const tick = 3;
    const roll = makeFortune('jfb-rule6').int('observation', tick, drawKey, 0, 999);
    const result = judgeFidelityBand(g, 'char:ruler', 'sound', tick, makeFortune('jfb-rule6'), drawKey);
    if (roll >= 500) expect(result).toBe('sound');
    else expect(result).toBe(roll % 2 === 0 ? 'poor' : 'outstanding');
  });
});

// ========================================================================
// vetObservation: modal band, highest-aptitude selection, vetting-authority
// resolution (spymaster else ruler), and fidelity (via judgeFidelityBand).
// ========================================================================

describe('vetObservation: modal band + highest aptitude', () => {
  it('reads the target’s highest aptitude and its modal band, true (rule 4) under a high-judge ruler (no spymaster)', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 6000);
    g = setNodeProp(g, 'char:target', 'apt:social', 9000); // bandWeights(9000) = [30,120,600,250] -> modal 'sound'
    const obs = vetObservation(g, 'char:target', 3, makeFortune('vet-modal-hi'), 't3.5');
    expect(obs).toEqual({ executorId: 'char:target', domain: 'social', claimedBand: 'sound', taskRef: 't3.5' });
  });

  it('a target whose highest aptitude sits under 4000 modally reads poor, not sound', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 6000);
    // The other three apt:* default to 5000 (APT_DEFAULT) -- all must be
    // pushed below martial's 1000 explicitly, or one of THEM (unset) would
    // still be the target's highest.
    g = setNodeProp(g, 'char:target', 'apt:econ', 0);
    g = setNodeProp(g, 'char:target', 'apt:martial', 1000); // bandWeights(1000) = [200,400,380,20] -> modal 'poor'
    g = setNodeProp(g, 'char:target', 'apt:social', 0);
    g = setNodeProp(g, 'char:target', 'apt:judge', 0);
    const obs = vetObservation(g, 'char:target', 3, makeFortune('vet-modal-lo'), 't3.5');
    expect(obs).toEqual({ executorId: 'char:target', domain: 'martial', claimedBand: 'poor', taskRef: 't3.5' });
  });

  it('a four-way tie at the default 5000 breaks toward APT_KEYS[0] (econ)', () => {
    const g = setNodeProp(baseGraph(), 'char:ruler', 'apt:judge', 6000); // target's apt:* all default to 5000
    const obs = vetObservation(g, 'char:target', 3, makeFortune('vet-tie'), 't3.5');
    expect(obs.domain).toBe('econ');
    expect(obs.claimedBand).toBe('sound'); // bandWeights(5000) = [120,350,480,50] -> modal 'sound'
  });

  it('a strictly higher later-declared aptitude DOES win the tie-break (not just first-wins)', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 6000);
    g = setNodeProp(g, 'char:target', 'apt:judge', 9000); // last in APT_KEYS, but strictly highest
    const obs = vetObservation(g, 'char:target', 3, makeFortune('vet-judge-highest'), 't3.5');
    expect(obs.domain).toBe('judge');
  });
});

describe('vetObservation: vetting-authority resolution (spymaster else ruler)', () => {
  it('a staffed, high-judge spymaster governs fidelity even when the ruler is low-judge', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 0); // would be error-prone if it were the authority
    g = withSpymaster(g, 9000);
    g = setNodeProp(g, 'char:target', 'apt:social', 9000); // modal 'sound'
    const obs = vetObservation(g, 'char:target', 3, makeFortune('vet-spymaster-governs'), 't3.5');
    expect(obs.claimedBand).toBe('sound'); // rule 4, via the spymaster
  });

  it('a vacant spymaster office falls back to the ruler', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 6000);
    g = setNodeProp(g, 'char:target', 'apt:social', 9000);
    const obs = vetObservation(g, 'char:target', 3, makeFortune('vet-ruler-fallback'), 't3.5');
    expect(obs.claimedBand).toBe('sound');
  });

  it('a low-judge vetting authority errs (rule 6, seed-scan): no-error, err-down, err-up all occur, matching a direct replay', () => {
    const tick = 5;
    const eventId = 't5.2';
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 0); // no spymaster staffed -> ruler is the authority; rule 6
    g = setNodeProp(g, 'char:target', 'apt:social', 9000); // modal 'sound'
    const drawKey = `${eventId} vet:char:ruler`;
    let sawNoError = false, sawDown = false, sawUp = false;
    for (let s = 0; s < 300 && !(sawNoError && sawDown && sawUp); s++) {
      const seed = `vet-rule6-${s}`;
      const roll = makeFortune(seed).int('observation', tick, drawKey, 0, 999);
      const obs = vetObservation(g, 'char:target', tick, makeFortune(seed), eventId);
      if (roll >= 500) { expect(obs.claimedBand).toBe('sound'); sawNoError = true; }
      else if (roll % 2 === 0) { expect(obs.claimedBand).toBe('poor'); sawDown = true; }
      else { expect(obs.claimedBand).toBe('outstanding'); sawUp = true; }
    }
    if (!(sawNoError && sawDown && sawUp)) throw new Error('did not observe all three rule-6 outcomes in 300 seeds -- widen scan');
  });

  it('a staffed but incompetent (judge 3999) spymaster still governs (not the ruler) -- rule 5/6 boundary matters', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 9000); // would be true-band if IT were the authority
    g = withSpymaster(g, 3999); // rule 6 (50% error) -- the WORST band of the two
    g = setNodeProp(g, 'char:target', 'apt:social', 9000);
    const eventId = 't5.9';
    const drawKey = `${eventId} vet:char:spymaster`;
    const roll = makeFortune('vet-incompetent-spymaster').int('observation', 5, drawKey, 0, 999);
    const obs = vetObservation(g, 'char:target', 5, makeFortune('vet-incompetent-spymaster'), eventId);
    if (roll >= 500) expect(obs.claimedBand).toBe('sound');
    else expect(obs.claimedBand).toBe(roll % 2 === 0 ? 'poor' : 'outstanding');
  });
});

// ========================================================================
// vet wired into resolveTick (tier 0, unmediated -- vet is usable from
// tier 0 per the content plan): proves the op.vet -> observation.received
// (via: 'vet') wiring end to end, not just the pure functions above.
// ========================================================================

function vetSeason(graph: WorldGraph): SeasonConfig {
  return {
    seasonId: 'apparatus-test',
    startTier: 0,
    initialGraph: graph,
    decks: [{
      id: 'apparatus-deck', tier: 0,
      storylets: [{
        id: 'apparatus.probe', kind: 'brief', tier: 0, cooldownTicks: 1, once: false,
        pattern: { nodes: [{ as: 'p', type: 'place' }] },
        title: 'Probe', body: 'Probe body',
        options: [{ id: 'skip', label: 'Skip', ops: [] }],
        defaultOptionId: 'skip',
      }],
    }],
    tiers: { 0: { deckIds: ['apparatus-deck'], briefBudget: 1, attentionSlots: 1 } },
    calendar: [],
    tierRules: [],
    throne: { id: 'seat:throne', kind: 'throne', bodyCharId: 'char:ruler', attentionSlots: 1, fidelity: 'external' },
    reporters: [],
    primaryPlaceId: 'place:ash',
  };
}

describe('vet wired into resolveTick', () => {
  it('a landed vet op emits exactly one observation.received via "vet", carrying the modal-band read', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 6000);
    g = setNodeProp(g, 'char:target', 'apt:social', 9000);
    const season = vetSeason(g);
    const f = makeFortune('vet-integration');
    const state = initialState(season);
    const out = resolveTick(season, state, { seatId: 'seat:throne', choices: [] }, f);
    const brief = out.packet.briefs[0];
    if (!brief) throw new Error('expected a brief at tick 1 -- season fixture is wrong');
    const next = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'vet', charId: 'char:target' }], via: 'directive' }],
    }, f);
    const vetEvent = next.events.find((e) => e.type === 'op.vet');
    expect(vetEvent).toBeDefined();
    const received = next.events.filter((e) => e.type === 'observation.received');
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual({
      executorId: 'char:target', domain: 'social', claimedBand: 'sound', via: 'vet', taskRef: vetEvent!.id,
    });
    expect(received[0]!.parents).toContain(vetEvent!.id);
    expect(propFx(getNode(next.state.graph, 'inst:crown').props, 'treasury')).toBe(fx('295'));
  });

  it('no vet op decided this tick: no observation.received fires', () => {
    const season = vetSeason(baseGraph());
    const f = makeFortune('vet-integration-none');
    const state = initialState(season);
    const out = resolveTick(season, state, { seatId: 'seat:throne', choices: [] }, f);
    expect(out.events.some((e) => e.type === 'observation.received')).toBe(false);
  });
});

// ========================================================================
// Poach-bid staleness under counter-intel (spec §9): same op (arc.poach.bid
// at stage 2), same world shape, differing ONLY by inst:crown's
// counterIntel prop.
// ========================================================================

function poachWorld(counterIntel: boolean): WorldGraph {
  let g = baseGraph();
  g = setNodeProp(g, 'char:target', 'wantChain', ['coin', 'office', 'recognition']);
  g = setNodeProp(g, 'char:target', 'wantIndex', 1); // current = 'office'; stale = wantChain[0] = 'coin'
  g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 4000 } });
  if (counterIntel) g = setNodeProp(g, 'inst:crown', 'counterIntel', true);
  return g;
}

function bidAtStage2(g: WorldGraph): ReturnType<typeof makeEmitter> {
  const arcs: Record<string, CharacterArc> = { 'restless:char:target': { kind: 'restless', charId: 'char:target', stage: 1, sinceTick: 0 } };
  const em = makeEmitter(3); // (3-0) >= STAGE_ADVANCE_TICKS(3) -- advances to stage 2
  advanceCharacterArcs(g, 3, arcs, em, 'char:rival');
  return em;
}

describe('poach-bid staleness under counter-intel (spec §9)', () => {
  it('without counterIntel: the bid offers the CURRENT want', () => {
    const em = bidAtStage2(poachWorld(false));
    const bid = em.all().find((e) => e.type === 'arc.poach.bid');
    expect(bid?.data).toEqual({ charId: 'char:target', byId: 'char:rival', offeredWant: 'office' });
  });

  it('the SAME world shape, only counterIntel differing, offers the STALE want instead', () => {
    const em = bidAtStage2(poachWorld(true));
    const bid = em.all().find((e) => e.type === 'arc.poach.bid');
    expect(bid?.data).toEqual({ charId: 'char:target', byId: 'char:rival', offeredWant: 'coin' });
  });

  it('stale read floors at index 0: a character already on their first want offers that same want when countered', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:target', 'wantChain', ['coin', 'office']);
    g = setNodeProp(g, 'char:target', 'wantIndex', 0); // max(0, -1) = 0
    g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 4000 } });
    g = setNodeProp(g, 'inst:crown', 'counterIntel', true);
    const em = bidAtStage2(g);
    const bid = em.all().find((e) => e.type === 'arc.poach.bid');
    expect(bid?.data).toEqual({ charId: 'char:target', byId: 'char:rival', offeredWant: 'coin' });
  });
});

// ========================================================================
// Scheme arc: pre-arm tracking (schemeSinceTick mark/unmark).
// ========================================================================

describe('scheme arc: pre-arm tracking (schemeSinceTick mark/unmark)', () => {
  it('marks on first observation below 3500; a recovery before arming unmarks and a later re-drop restarts the clock', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:target', 'trait:vengeful', true);
    g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 3000 } });
    let arcs: Record<string, CharacterArc> = {};

    // tick 0: marks.
    let pre = g;
    let em = makeEmitter(0);
    let out = advanceCharacterArcs(g, 0, arcs, em);
    g = out.g; arcs = out.arcs;
    expect(em.all().map((e) => e.type)).toEqual(['arc.scheme.marked']);
    expect(getNode(g, 'char:target').props['schemeSinceTick']).toBe(0);
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    // tick 2: recovers to 4000 (>= 3500 ceiling; no active arc yet to retain) -- unmarks.
    g = setEdgeProp(g, edgeId('loyalty', 'char:target', 'char:ruler'), 'bp', 4000);
    pre = g;
    em = makeEmitter(2);
    out = advanceCharacterArcs(g, 2, arcs, em);
    g = out.g; arcs = out.arcs;
    expect(em.all().map((e) => e.type)).toEqual(['arc.scheme.unmarked']);
    expect(getNode(g, 'char:target').props['schemeSinceTick']).toBe(-1);
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(g));

    // tick 3: re-drops below 3500 -- marks again, a FRESH window.
    g = setEdgeProp(g, edgeId('loyalty', 'char:target', 'char:ruler'), 'bp', 3000);
    em = makeEmitter(3);
    out = advanceCharacterArcs(g, 3, arcs, em);
    g = out.g; arcs = out.arcs;
    expect(em.all().map((e) => e.type)).toEqual(['arc.scheme.marked']);
    expect(getNode(g, 'char:target').props['schemeSinceTick']).toBe(3);

    // tick 6: only 3 ticks since the FRESH mark (tick 3) -- (6-3)=3 < 4, not armed.
    // If the stale tick-0 window had survived uncleared, (6-0)=6 >= 4 would
    // have wrongly armed here -- this is the assertion that catches that bug.
    em = makeEmitter(6);
    out = advanceCharacterArcs(g, 6, arcs, em);
    g = out.g; arcs = out.arcs;
    expect(em.all()).toHaveLength(0);
    expect(arcs['scheme:char:target']).toBeUndefined();

    // tick 7: (7-3)=4 >= 4 -- arms now, at stage 1 (sway).
    em = makeEmitter(7);
    out = advanceCharacterArcs(g, 7, arcs, em);
    expect(em.all().map((e) => e.type)).toEqual(['arc.scheme.sway']);
    expect(em.all()[0]?.data).toEqual({ charId: 'char:target' });
    expect(getNode(out.g, 'char:target').props['arc:scheme']).toBe(true);
    expect(out.arcs['scheme:char:target']).toEqual({ kind: 'scheme', charId: 'char:target', stage: 1, sinceTick: 7 });
  });

  it('a character with neither cunning nor vengeful, even below 3500 loyalty, is never marked', () => {
    let g = baseGraph();
    g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 1000 } });
    const em = makeEmitter(0);
    advanceCharacterArcs(g, 0, {}, em);
    expect(em.all()).toHaveLength(0);
  });
});

// ========================================================================
// Scheme arc: arm -> stage 2 (commit) -> telegraph iff a competent,
// staffed spymaster is present.
// ========================================================================

function schemerGraph(): WorldGraph {
  let g = baseGraph();
  g = setNodeProp(g, 'char:target', 'trait:cunning', true);
  g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 3000 } });
  return g;
}

function armToStage2(g: WorldGraph): { g: WorldGraph; arcs: Record<string, CharacterArc>; em: ReturnType<typeof makeEmitter> } {
  let arcs: Record<string, CharacterArc> = {};
  let world = g;
  let em = makeEmitter(0); // marks
  let out = advanceCharacterArcs(world, 0, arcs, em);
  world = out.g; arcs = out.arcs;
  em = makeEmitter(4); // (4-0) >= SCHEME_ARM_TICKS(4) -- arms, stage 1 (sway)
  out = advanceCharacterArcs(world, 4, arcs, em);
  world = out.g; arcs = out.arcs;
  if (arcs['scheme:char:target']?.stage !== 1) throw new Error('fixture broken: expected stage 1 after arming');
  em = makeEmitter(6); // (6-4) >= SCHEME_STAGE_ADVANCE_TICKS(2) -- advances to stage 2 (commit)
  out = advanceCharacterArcs(world, 6, arcs, em);
  return { g: out.g, arcs: out.arcs, em };
}

describe('scheme arc: arm -> stage 2 (commit) -> telegraph gate', () => {
  it('a competent (judge >= 4000), staffed spymaster telegraphs the commit', () => {
    const g = withSpymaster(schemerGraph(), 4000);
    const { arcs, em } = armToStage2(g);
    expect(em.all().map((e) => e.type)).toEqual(['arc.scheme.telegraph']);
    expect(em.all()[0]?.data).toEqual({ charId: 'char:target' });
    expect(em.all()[0]?.deltas).toEqual([]); // informational only
    expect(arcs['scheme:char:target']?.stage).toBe(2);
  });

  it('a vacant spymaster office: the same commit advances silently -- no telegraph', () => {
    const { arcs, em } = armToStage2(schemerGraph()); // no office:spymaster node at all
    expect(em.all()).toHaveLength(0);
    expect(arcs['scheme:char:target']?.stage).toBe(2);
  });

  it('a staffed but incompetent (judge 3999) spymaster: also silent', () => {
    const g = withSpymaster(schemerGraph(), 3999);
    const { arcs, em } = armToStage2(g);
    expect(em.all()).toHaveLength(0);
    expect(arcs['scheme:char:target']?.stage).toBe(2);
  });
});

// ========================================================================
// Scheme arc: stage 3 (strike) -- exact deltas + replay.
// ========================================================================

describe('scheme arc: stage 3 (strike) -- exact deltas + replay', () => {
  it('legitimacy -8, unrest +10 on the primary place, full departure bundle, arc removed', () => {
    let g = schemerGraph();
    g = setNodeProp(g, 'char:target', 'trait:vengeful', true); // in addition to cunning -- either trait alone would qualify
    g = addNode(g, { id: 'office:marshal', type: 'office', props: { title: 'Marshal' } });
    g = addEdge(g, { type: 'appointment', src: 'char:target', dst: 'office:marshal', props: { since: 0 } });

    const arcs: Record<string, CharacterArc> = { 'scheme:char:target': { kind: 'scheme', charId: 'char:target', stage: 2, sinceTick: 6 } };
    const pre = g;
    const em = makeEmitter(8); // (8-6) >= 2 -- advances to stage 3, terminal
    const out = advanceCharacterArcs(g, 8, arcs, em, 'char:rival', 'place:ash');

    expect(em.all()).toHaveLength(1);
    expect(em.all()[0]?.type).toBe('arc.scheme.struck');
    expect(em.all()[0]?.data).toEqual({ charId: 'char:target' });
    expect(propFx(getNode(out.g, 'inst:crown').props, 'legitimacy')).toBe(fx('42')); // 50 - 8
    expect(propFx(getNode(out.g, 'place:ash').props, 'unrest')).toBe(fx('20')); // 10 + 10
    expect(findEdge(out.g, 'loyalty', 'char:target', 'char:ruler')).toBeUndefined();
    expect(findEdge(out.g, 'appointment', 'char:target', 'office:marshal')).toBeUndefined();
    expect(getNode(out.g, 'char:target').props['inRivalCourt']).toBe(true);
    expect(getNode(out.g, 'char:target').props['arc:scheme']).toBe(false);
    expect(getNode(out.g, 'char:target').props['schemeSinceTick']).toBe(-1);
    expect(out.g.nodes['char:target']).toBeDefined(); // remains in the graph, spec §12
    expect(out.arcs['scheme:char:target']).toBeUndefined();
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(out.g));
  });

  it('without a primaryPlaceId, the strike still lands (legitimacy + departure) but skips the unrest delta', () => {
    const g = schemerGraph();
    const arcs: Record<string, CharacterArc> = { 'scheme:char:target': { kind: 'scheme', charId: 'char:target', stage: 2, sinceTick: 6 } };
    const em = makeEmitter(8);
    const out = advanceCharacterArcs(g, 8, arcs, em); // no primaryPlaceId, no rivalId
    expect(propFx(getNode(out.g, 'inst:crown').props, 'legitimacy')).toBe(fx('42'));
    expect(propFx(getNode(out.g, 'place:ash').props, 'unrest')).toBe(fx('10')); // untouched
    expect(findEdge(out.g, 'loyalty', 'char:target', 'char:ruler')).toBeUndefined();
    expect(getNode(out.g, 'char:target').props['inRivalCourt']).toBe(true);
  });

  it('legitimacy floors at 0 rather than going negative', () => {
    let g = schemerGraph();
    g = setNodeProp(g, 'inst:crown', 'legitimacy', fx('5'));
    const arcs: Record<string, CharacterArc> = { 'scheme:char:target': { kind: 'scheme', charId: 'char:target', stage: 2, sinceTick: 6 } };
    const em = makeEmitter(8);
    const out = advanceCharacterArcs(g, 8, arcs, em);
    expect(propFx(getNode(out.g, 'inst:crown').props, 'legitimacy')).toBe(fx('0'));
  });
});

// ========================================================================
// Scheme arc: retention.
// ========================================================================

describe('scheme arc: retention (loyalty recovers to >= 5500)', () => {
  it('emits arc.retained (same event type as restless retention), clears arc:scheme and schemeSinceTick', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:target', 'trait:cunning', true);
    g = setNodeProp(g, 'char:target', 'schemeSinceTick', 2); // stale pre-arm window from before the arc armed
    g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 5500 } });
    const arcs: Record<string, CharacterArc> = { 'scheme:char:target': { kind: 'scheme', charId: 'char:target', stage: 1, sinceTick: 2 } };
    const pre = g;
    const em = makeEmitter(3);
    const out = advanceCharacterArcs(g, 3, arcs, em);
    expect(em.all()).toHaveLength(1);
    expect(em.all()[0]?.type).toBe('arc.retained');
    expect(em.all()[0]?.data).toEqual({ charId: 'char:target' });
    expect(getNode(out.g, 'char:target').props['arc:scheme']).toBe(false);
    expect(getNode(out.g, 'char:target').props['schemeSinceTick']).toBe(-1);
    expect(out.arcs['scheme:char:target']).toBeUndefined();
    expect(hashValue(applyDeltas(pre, em.all().flatMap((e) => e.deltas)))).toBe(hashValue(out.g));
  });

  it('retention preempts a stage advance that would otherwise be due the same tick', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:target', 'trait:vengeful', true);
    g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 5500 } }); // already recovered
    const arcs: Record<string, CharacterArc> = { 'scheme:char:target': { kind: 'scheme', charId: 'char:target', stage: 1, sinceTick: 0 } };
    const em = makeEmitter(5); // (5-0) >= 2 -- a stage advance WOULD fire if retention didn't preempt it
    const out = advanceCharacterArcs(g, 5, arcs, em);
    expect(em.all().map((e) => e.type)).toEqual(['arc.retained']);
    expect(out.arcs['scheme:char:target']).toBeUndefined();
  });
});

// ========================================================================
// A pre-existing restless arc is untouched by scheme handling, and vice
// versa -- independent per-character slots (mirrors arcs.test.ts's own
// restless/scheme-independence pin, from the scheme side).
// ========================================================================

describe('scheme and restless arcs are independent per-character slots', () => {
  it('an active restless arc does not block a DIFFERENT character from arming a scheme arc the same tick', () => {
    let g = baseGraph();
    g = addNode(g, { id: 'char:other', type: 'character', props: { name: 'Other', wantChain: ['coin'], wantIndex: 0 } });
    g = addEdge(g, { type: 'loyalty', src: 'char:other', dst: 'char:ruler', props: { bp: 4000 } }); // restless-eligible, not scheme-eligible (no trait)
    g = setNodeProp(g, 'char:target', 'trait:cunning', true);
    g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 3000 } });
    const arcs: Record<string, CharacterArc> = {};
    const em = makeEmitter(6); // restless arms at (6-0)>=6; scheme marks (not yet armed) at tick 6
    const out = advanceCharacterArcs(g, 6, arcs, em);
    expect(out.arcs['restless:char:other']).toEqual({ kind: 'restless', charId: 'char:other', stage: 1, sinceTick: 6 });
    expect(out.arcs['scheme:char:target']).toBeUndefined(); // only just marked, not armed yet
    expect(getNode(out.g, 'char:target').props['schemeSinceTick']).toBe(6);
  });

  it('a character can carry an active restless arc and an active scheme arc at once', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:target', 'trait:cunning', true);
    // A non-null want is required or restless's OWN retention (loyalty >=
    // floor OR want === null) would fire regardless of stage/sinceTick and
    // delete the seeded arc for an unrelated reason (want-fulfilled-style
    // exit), muddying what this test is actually pinning.
    g = setNodeProp(g, 'char:target', 'wantChain', ['coin']);
    g = setNodeProp(g, 'char:target', 'wantIndex', 0);
    g = addEdge(g, { type: 'loyalty', src: 'char:target', dst: 'char:ruler', props: { bp: 3000 } });
    const arcs: Record<string, CharacterArc> = {
      'restless:char:target': { kind: 'restless', charId: 'char:target', stage: 5, sinceTick: 0 }, // out-of-band stage, proves untouched
    };
    const em = makeEmitter(0);
    const out = advanceCharacterArcs(g, 0, arcs, em);
    expect(out.arcs['restless:char:target']).toEqual({ kind: 'restless', charId: 'char:target', stage: 5, sinceTick: 0 }); // untouched
    expect(em.all().map((e) => e.type)).toEqual(['arc.scheme.marked']); // scheme tracking proceeds independently
  });
});

// ========================================================================
// Determinism.
// ========================================================================

describe('determinism', () => {
  it('advanceCharacterArcs: identical inputs (mid-lifecycle scheme arc included) produce identical events and state', () => {
    const g = schemerGraph();
    const arcs: Record<string, CharacterArc> = {};
    const em1 = makeEmitter(0);
    const out1 = advanceCharacterArcs(g, 0, arcs, em1, 'char:rival', 'place:ash');
    const em2 = makeEmitter(0);
    const out2 = advanceCharacterArcs(g, 0, arcs, em2, 'char:rival', 'place:ash');
    expect(canonJson(em1.all())).toBe(canonJson(em2.all()));
    expect(hashValue(out1.g)).toBe(hashValue(out2.g));
    expect(canonJson(out1.arcs)).toBe(canonJson(out2.arcs));
  });

  it('vetObservation: identical (graph, tick, seed, eventId) produces an identical Observation', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:ruler', 'apt:judge', 3000);
    g = setNodeProp(g, 'char:target', 'apt:econ', 7000);
    const obs1 = vetObservation(g, 'char:target', 4, makeFortune('vet-determinism'), 't4.1');
    const obs2 = vetObservation(g, 'char:target', 4, makeFortune('vet-determinism'), 't4.1');
    expect(obs1).toEqual(obs2);
  });
});
