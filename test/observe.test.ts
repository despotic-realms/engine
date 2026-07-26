// spec §4: execution events reach the throne only as OBSERVATIONS, and the
// observer bends them. Six claimedBand precedence rules (first match wins),
// an independent skim-visibility check, and the tier-0/no-reporters direct
// witness routing resolved into resolveTick. One describe block per rule,
// mirroring mediate.test.ts's seed-scan and fortune-instrumentation idioms.
import { describe, expect, it } from 'vitest';
import { observeExecutions } from '../src/observe.js';
import { makeFortune } from '../src/fortune.js';
import type { Fortune } from '../src/fortune.js';
import { makeEmitter } from '../src/events.js';
import { addEdge, addNode, emptyGraph, setNodeProp } from '../src/graph.js';
import type { WorldGraph } from '../src/graph.js';
import type { Seat } from '../src/report.js';
import { BANDS } from '../src/spine.js';
import type { Band } from '../src/spine.js';
import { initialState, resolveTick } from '../src/tick.js';
import type { SeasonConfig } from '../src/tick.js';
import { starterSeason } from '../src/decks/starter.js';

function baseGraph(): WorldGraph {
  let g = emptyGraph();
  g = addNode(g, { id: 'char:reporter', type: 'character', props: { name: 'Reporter' } });
  g = addNode(g, { id: 'char:executor', type: 'character', props: { name: 'Executor' } });
  return g;
}

function seatFor(bodyCharId: string): Seat {
  return { id: 'seat:test', kind: 'office', bodyCharId, attentionSlots: 1, fidelity: 'npc' };
}

/** Wraps a real Fortune to count `.int` calls -- the same spy idiom
 *  mediate.test.ts's "refusal consumes no fortune" test uses, so a
 *  no-draw/one-draw claim is proven, not merely inferred from output. */
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

describe('observeExecutions: rule 1 -- self-report inflation (reporter === executor)', () => {
  it('one band step up, and never touches fortune', () => {
    const g = baseGraph();
    const tick = 1;
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:reporter', officeId: 'office:x', domain: 'econ', band: 'poor' } });
    const { fortune, count } = countingFortune('rule1-a');
    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, fortune);
    expect(obs).toEqual([{ executorId: 'char:reporter', domain: 'econ', claimedBand: 'sound', taskRef: em.all()[0]!.id }]);
    expect(count()).toBe(0);
  });

  it('caps at outstanding -- an already-outstanding self-report cannot inflate further', () => {
    const g = baseGraph();
    const tick = 1;
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:reporter', officeId: 'office:x', domain: 'econ', band: 'outstanding' } });
    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, makeFortune('rule1-b'));
    expect(obs[0]!.claimedBand).toBe('outstanding');
  });

  it('takes precedence even over a perfectly honest (high-judge) reporter', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 9000); // would otherwise report true (rule 4)
    const tick = 1;
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:reporter', officeId: 'office:x', domain: 'econ', band: 'botched' } });
    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, makeFortune('rule1-c'));
    expect(obs[0]!.claimedBand).toBe('poor'); // botched -> poor, not the honest 'botched'
  });
});

describe('observeExecutions: rule 2 -- kin/loyalty inflation (band < sound -> sound)', () => {
  it('kinship edge reporter->executor floors a poor report at sound, even for a high-judge reporter, no draw', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 9000);
    g = addEdge(g, { type: 'kinship', src: 'char:reporter', dst: 'char:executor', props: {} });
    const tick = 2;
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'poor' } });
    const { fortune, count } = countingFortune('rule2-kin');
    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, fortune);
    expect(obs[0]!.claimedBand).toBe('sound');
    expect(count()).toBe(0);
  });

  it('loyalty >= 7000 (no kinship) also floors at sound; 6999 does not (falls through to truth)', () => {
    const tick = 2;
    let gHigh = baseGraph();
    gHigh = addEdge(gHigh, { type: 'loyalty', src: 'char:reporter', dst: 'char:executor', props: { bp: 7000 } });
    const emHigh = makeEmitter(tick);
    emHigh.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'botched' } });
    expect(observeExecutions(gHigh, emHigh.all(), seatFor('char:reporter'), tick, makeFortune('rule2-loy'))[0]!.claimedBand).toBe('sound');

    let gLow = baseGraph();
    gLow = addEdge(gLow, { type: 'loyalty', src: 'char:reporter', dst: 'char:executor', props: { bp: 6999 } });
    gLow = setNodeProp(gLow, 'char:reporter', 'apt:judge', 9000); // once rule 2 doesn't fire, rule 4 reports true
    const emLow = makeEmitter(tick);
    emLow.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'botched' } });
    expect(observeExecutions(gLow, emLow.all(), seatFor('char:reporter'), tick, makeFortune('rule2-loy-lo'))[0]!.claimedBand).toBe('botched');
  });

  it('never touches a band already >= sound -- kinship does not mute an outstanding report (falls through to rule 4)', () => {
    let g = baseGraph();
    g = addEdge(g, { type: 'kinship', src: 'char:reporter', dst: 'char:executor', props: {} });
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 9000);
    const tick = 2;
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'outstanding' } });
    expect(observeExecutions(g, em.all(), seatFor('char:reporter'), tick, makeFortune('rule2-hi'))[0]!.claimedBand).toBe('outstanding');
  });
});

describe('observeExecutions: rule 3 -- spite deflation (grudge >= 6000 + outstanding -> sound)', () => {
  it('grudge >= 6000 denies an outstanding report, even for a high-judge reporter, no draw', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 9000);
    g = addEdge(g, { type: 'grudge', src: 'char:reporter', dst: 'char:executor', props: { bp: 6000 } });
    const tick = 3;
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'outstanding' } });
    const { fortune, count } = countingFortune('rule3-a');
    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, fortune);
    expect(obs[0]!.claimedBand).toBe('sound');
    expect(count()).toBe(0);
  });

  it('grudge below 6000 does not fire (falls through to truth)', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 9000);
    g = addEdge(g, { type: 'grudge', src: 'char:reporter', dst: 'char:executor', props: { bp: 5999 } });
    const tick = 3;
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'outstanding' } });
    expect(observeExecutions(g, em.all(), seatFor('char:reporter'), tick, makeFortune('rule3-b'))[0]!.claimedBand).toBe('outstanding');
  });

  it('does not touch bands other than outstanding, even with a well-qualified grudge', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 9000);
    g = addEdge(g, { type: 'grudge', src: 'char:reporter', dst: 'char:executor', props: { bp: 9000 } });
    const tick = 3;
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'sound' } });
    expect(observeExecutions(g, em.all(), seatFor('char:reporter'), tick, makeFortune('rule3-c'))[0]!.claimedBand).toBe('sound');
  });
});

describe('observeExecutions: rule 4 -- a sharp, disinterested judge reports the truth', () => {
  it('apt:judge >= 6000 -> claimedBand === true band, for every band, and never touches fortune', () => {
    const tick = 4;
    for (const band of BANDS) {
      let g = baseGraph();
      g = setNodeProp(g, 'char:reporter', 'apt:judge', 6000);
      const em = makeEmitter(tick);
      em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band } });
      const { fortune, count } = countingFortune(`rule4-${band}`);
      const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, fortune);
      expect(obs[0]!.claimedBand).toBe(band);
      expect(count()).toBe(0);
    }
  });
});

describe('observeExecutions: rule 5 -- apt:judge in [4000,6000) -> 25% one-step error, single draw', () => {
  it('scans seeds: no-error (true band), errs down (even roll), errs up (odd roll) all occur and match', () => {
    const tick = 5;
    const eventId = `t${tick}.0`;
    const drawKey = `${eventId} seat:test`; // Fix 1: key is now event id + reporter seat id (seatFor's 'seat:test')
    let sawNoError = false;
    let sawDown = false;
    let sawUp = false;
    for (let s = 0; s < 300 && !(sawNoError && sawDown && sawUp); s++) {
      const f = makeFortune(`rule5-${s}`);
      const roll = f.int('observation', tick, drawKey, 0, 999);
      let g = baseGraph();
      g = setNodeProp(g, 'char:reporter', 'apt:judge', 4500);
      const em = makeEmitter(tick);
      em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'sound' } });
      expect(em.all()[0]!.id).toBe(eventId); // sanity: precomputed key matches the real event id
      const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, f);
      if (roll >= 250) {
        expect(obs[0]!.claimedBand).toBe('sound');
        sawNoError = true;
      } else if (roll % 2 === 0) {
        expect(obs[0]!.claimedBand).toBe('poor');
        sawDown = true;
      } else {
        expect(obs[0]!.claimedBand).toBe('outstanding');
        sawUp = true;
      }
    }
    if (!(sawNoError && sawDown && sawUp)) throw new Error('did not observe all three rule-5 outcomes in 300 seeds — widen scan');
  });
});

describe('observeExecutions: rule 6 -- else (apt:judge < 4000) -> 50% one-step error, single draw', () => {
  it('scans seeds: no-error (true band), errs down (even roll), errs up (odd roll) all occur and match', () => {
    const tick = 6;
    const eventId = `t${tick}.0`;
    const drawKey = `${eventId} seat:test`; // Fix 1: key is now event id + reporter seat id (seatFor's 'seat:test')
    let sawNoError = false;
    let sawDown = false;
    let sawUp = false;
    for (let s = 0; s < 300 && !(sawNoError && sawDown && sawUp); s++) {
      const f = makeFortune(`rule6-${s}`);
      const roll = f.int('observation', tick, drawKey, 0, 999);
      let g = baseGraph();
      g = setNodeProp(g, 'char:reporter', 'apt:judge', 0);
      const em = makeEmitter(tick);
      em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'sound' } });
      const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, f);
      if (roll >= 500) {
        expect(obs[0]!.claimedBand).toBe('sound');
        sawNoError = true;
      } else if (roll % 2 === 0) {
        expect(obs[0]!.claimedBand).toBe('poor');
        sawDown = true;
      } else {
        expect(obs[0]!.claimedBand).toBe('outstanding');
        sawUp = true;
      }
    }
    if (!(sawNoError && sawDown && sawUp)) throw new Error('did not observe all three rule-6 outcomes in 300 seeds — widen scan');
  });

  it('apt:judge exactly 3999 uses the 50% branch where the default (unset, 5000) would use the 25% branch', () => {
    const tick = 6;
    const eventId = `t${tick}.0`;
    const drawKey = `${eventId} seat:test`; // Fix 1: key is now event id + reporter seat id (seatFor's 'seat:test'); both branches below use the same seat, so the key -- and thus the precomputed roll -- is identical for both
    // A seed whose roll lands strictly between the two thresholds (25%/50%
    // as roll counts 250/500 out of 1000): rule 5 reads it as "no error",
    // rule 6 reads the SAME roll as "error" -- isolating the threshold.
    let seed = '';
    for (let s = 0; s < 300; s++) {
      const candidate = `rule6-boundary-${s}`;
      const roll = makeFortune(candidate).int('observation', tick, drawKey, 0, 999);
      if (roll >= 250 && roll < 500) { seed = candidate; break; }
    }
    if (!seed) throw new Error('no seed with 250<=roll<500 in 300 tries — widen scan');
    const f = makeFortune(seed);

    const gDefault = baseGraph(); // apt:judge unset -> default 5000 -> rule 5 (25%)
    const emDefault = makeEmitter(tick);
    emDefault.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'sound' } });
    expect(observeExecutions(gDefault, emDefault.all(), seatFor('char:reporter'), tick, f)[0]!.claimedBand).toBe('sound');

    const gLow = setNodeProp(baseGraph(), 'char:reporter', 'apt:judge', 3999); // rule 6 (50%)
    const emLow = makeEmitter(tick);
    emLow.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'sound' } });
    expect(observeExecutions(gLow, emLow.all(), seatFor('char:reporter'), tick, f)[0]!.claimedBand).not.toBe('sound');
  });
});

describe('clamp-edge coverage: stepBand cannot go below botched or above outstanding (rules 5/6)', () => {
  it('true band botched + erring roll with downward parity -> claimedBand stays botched (lower clamp)', () => {
    const tick = 9;
    const eventId = `t${tick}.0`;
    const drawKey = `${eventId} seat:test`; // Fix 1 key: event id + reporter seat id
    // rule 6 (low judge, 50% error: roll < 500), even roll -> down-step --
    // from 'botched' (index 0) that would land on index -1, which
    // clampBandIndex must pull back to 0. No seed scan for rule 5/6 in this
    // file has ever landed here: every prior scan used trueBand 'sound',
    // where a down-step (-> 'poor') or up-step (-> 'outstanding') never
    // touches either clamp.
    let seed = '';
    for (let s = 0; s < 300; s++) {
      const candidate = `clamp-lo-${s}`;
      const roll = makeFortune(candidate).int('observation', tick, drawKey, 0, 999);
      if (roll < 500 && roll % 2 === 0) { seed = candidate; break; }
    }
    if (!seed) throw new Error('no seed with err+down parity in 300 tries — widen scan');
    const f = makeFortune(seed);
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 0); // rule 6
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'botched' } });
    expect(em.all()[0]!.id).toBe(eventId); // sanity: precomputed key matches the real event id
    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, f);
    expect(obs[0]!.claimedBand).toBe('botched');
  });

  it('true band outstanding + erring roll with upward parity -> claimedBand stays outstanding (upper clamp)', () => {
    const tick = 9;
    const eventId = `t${tick}.0`;
    const drawKey = `${eventId} seat:test`; // Fix 1 key: event id + reporter seat id
    // rule 6 (low judge, 50% error: roll < 500), odd roll -> up-step -- from
    // 'outstanding' (index 3, LAST_BAND) that would land on index 4, which
    // clampBandIndex must pull back to 3. This is the random-path mirror of
    // rule 3's deterministic outstanding->sound deflation; here the clamp,
    // not a precedence rule, is what holds the band in place.
    let seed = '';
    for (let s = 0; s < 300; s++) {
      const candidate = `clamp-hi-${s}`;
      const roll = makeFortune(candidate).int('observation', tick, drawKey, 0, 999);
      if (roll < 500 && roll % 2 === 1) { seed = candidate; break; }
    }
    if (!seed) throw new Error('no seed with err+up parity in 300 tries — widen scan');
    const f = makeFortune(seed);
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 0); // rule 6
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'outstanding' } });
    expect(em.all()[0]!.id).toBe(eventId); // sanity: precomputed key matches the real event id
    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, f);
    expect(obs[0]!.claimedBand).toBe('outstanding');
  });
});

describe('skim visibility (spec §4 step 2): independent of claimedBand', () => {
  const tick = 7;

  it('visible to a high-judge stranger: both the execution and the skim are observed', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 9000);
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'grant', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'poor' } });
    const executedId = em.all()[0]!.id;
    em.emit('op.skimmed', { parents: [executedId], data: { executorId: 'char:executor', amount: '3' } });
    const skimId = em.all()[1]!.id;

    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, makeFortune('skim-visible'));
    expect(obs).toEqual([
      { executorId: 'char:executor', domain: 'econ', claimedBand: 'poor', taskRef: executedId }, // rule 4: true band
      { executorId: 'char:executor', domain: 'econ', claimedBand: 'poor', taskRef: skimId },      // the skim itself
    ]);
  });

  it('invisible to kin: judge>=6000 through a kinship edge never surfaces the skim -- only the execution is observed', () => {
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 9000);
    g = addEdge(g, { type: 'kinship', src: 'char:reporter', dst: 'char:executor', props: {} });
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'grant', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'poor' } });
    const executedId = em.all()[0]!.id;
    em.emit('op.skimmed', { parents: [executedId], data: { executorId: 'char:executor', amount: '3' } });
    const skimId = em.all()[1]!.id;

    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, makeFortune('skim-invisible-kin'));
    expect(obs).toHaveLength(1);
    expect(obs[0]!.claimedBand).toBe('sound'); // rule 2 fired on the paired execution: poor < sound, kin -> sound
    expect(obs.some((o) => o.taskRef === skimId)).toBe(false);
  });

  it('invisible to a low-judge stranger too: judge<6000 never sees the skim either', () => {
    const g = baseGraph(); // default apt:judge 5000 (rule 5), no kin/loyalty
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'grant', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'poor' } });
    const executedId = em.all()[0]!.id;
    em.emit('op.skimmed', { parents: [executedId], data: { executorId: 'char:executor', amount: '3' } });
    const skimId = em.all()[1]!.id;

    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, makeFortune('skim-invisible-lowjudge'));
    expect(obs).toHaveLength(1); // the execution only
    expect(obs.some((o) => o.taskRef === skimId)).toBe(false);
  });
});

describe('single-draw property: the error decision and the parity come from ONE fortune.int call', () => {
  it('rule 5/6 (probabilistic) draws exactly once for one observed op.executed event', () => {
    const tick = 8;
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 3000); // rule 6
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'sound' } });
    const { fortune, count } = countingFortune('single-draw');
    observeExecutions(g, em.all(), seatFor('char:reporter'), tick, fortune);
    expect(count()).toBe(1);
  });

  it('two observed executions in the same tick draw exactly twice -- once each, never more', () => {
    const tick = 8;
    let g = baseGraph();
    g = setNodeProp(g, 'char:reporter', 'apt:judge', 4500); // rule 5
    const em = makeEmitter(tick);
    em.emit('op.executed', { data: { opKind: 'stockpile_grain', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'sound' } });
    em.emit('op.executed', { data: { opKind: 'grant', executorId: 'char:executor', officeId: 'office:x', domain: 'econ', band: 'poor' } });
    const { fortune, count } = countingFortune('single-draw-two');
    const obs = observeExecutions(g, em.all(), seatFor('char:reporter'), tick, fortune);
    expect(obs).toHaveLength(2);
    expect(count()).toBe(2);
  });
});

describe('direct witness vs per-reporter routing (spec §4 step 4, resolved reading)', () => {
  function withMediationAt1(reporters: Seat[]): SeasonConfig {
    const base = starterSeason();
    return {
      ...base,
      reporters,
      tiers: {
        ...base.tiers,
        1: { ...base.tiers[1]!, mediation: { officeForDomain: { econ: 'office:steward', martial: 'office:none', social: 'office:none' }, willingness: false } },
      },
    };
  }

  it('no reporters configured: the throne witnesses op.executed directly -- via "direct", true band, no ReportedLedger at all', () => {
    const season = withMediationAt1([]);
    const f = makeFortune('direct-routing');
    const state = initialState(season);
    const out = resolveTick(season, state, { seatId: 'seat:throne', choices: [] }, f);
    const brief = out.packet.briefs[0];
    if (!brief) throw new Error('expected a brief at tick 1');
    const next = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 }], via: 'directive' }],
    }, f);
    const executed = next.events.find((e) => e.type === 'op.executed')!;
    const trueBand = (executed.data as { band: string }).band;
    const received = next.events.filter((e) => e.type === 'observation.received');
    expect(received).toHaveLength(1); // decree_tax has no fx amount -- never skims
    const obsData = received[0]!.data as { claimedBand: string; via: string; taskRef: string };
    expect(obsData.via).toBe('direct');
    expect(obsData.claimedBand).toBe(trueBand);
    expect(obsData.taskRef).toBe(executed.id);
    expect(received[0]!.parents).toContain(executed.id);
    expect(next.packet.reports).toHaveLength(0); // no reporter seats -> no ReportedLedger at all
  });

  it('no reporters configured: op.skimmed also routes via "direct" (poor-band, econ) -- nothing hides at an unfiltered throne', () => {
    const base = starterSeason();
    let graph = base.initialGraph;
    graph = setNodeProp(graph, 'char:osric', 'apt:econ', 0); // botched/poor dominate
    graph = setNodeProp(graph, 'char:osric', 'trait:greedy', true);
    const season: SeasonConfig = { ...withMediationAt1([]), initialGraph: graph };
    for (let s = 0; s < 50; s++) {
      const f = makeFortune(`direct-skim-${s}`);
      const state = initialState(season);
      const out = resolveTick(season, state, { seatId: 'seat:throne', choices: [] }, f);
      const brief = out.packet.briefs[0];
      if (!brief) continue;
      const next = resolveTick(season, out.state, {
        seatId: 'seat:throne',
        choices: [{ briefId: brief.briefId, ops: [{ kind: 'grant', charId: 'char:ruler', amount: '20' }], via: 'directive' }],
      }, f);
      const skimmed = next.events.find((e) => e.type === 'op.skimmed');
      if (!skimmed) continue;
      const executed = next.events.find((e) => e.type === 'op.executed')!;
      const received = next.events.filter((e) => e.type === 'observation.received');
      expect(received).toHaveLength(2);
      const bySkim = received.find((e) => (e.data as { taskRef: string }).taskRef === skimmed.id)!;
      const skimData = bySkim.data as { via: string; claimedBand: string; domain: string };
      expect(skimData.via).toBe('direct');
      expect(skimData.claimedBand).toBe('poor');
      expect(skimData.domain).toBe('econ');
      const byExec = received.find((e) => (e.data as { taskRef: string }).taskRef === executed.id)!;
      const execData = byExec.data as { via: string; claimedBand: string };
      expect(execData.via).toBe('direct');
      expect(execData.claimedBand).toBe((executed.data as { band: string }).band);
      return;
    }
    throw new Error('no skim observed in 50 seeds — widen scan');
  });

  it('reporters configured: observations flow only through them, never "direct"; self-report inflates the steward\'s read of their own work', () => {
    const base = starterSeason();
    const season = withMediationAt1(base.reporters);
    const f = makeFortune('reporter-routing');
    const state = initialState(season);
    const out = resolveTick(season, state, { seatId: 'seat:throne', choices: [] }, f);
    const brief = out.packet.briefs[0];
    if (!brief) throw new Error('expected a brief at tick 1');
    const next = resolveTick(season, out.state, {
      seatId: 'seat:throne',
      choices: [{ briefId: brief.briefId, ops: [{ kind: 'decree_tax', placeId: 'place:thornfield', rateBp: 1500 }], via: 'directive' }],
    }, f);
    const executed = next.events.find((e) => e.type === 'op.executed')!;
    const trueBand = (executed.data as { band: Band }).band;
    const received = next.events.filter((e) => e.type === 'observation.received');
    expect(received).toHaveLength(1);
    const obsData = received[0]!.data as { claimedBand: string; via: string };
    expect(obsData.via).toBe('seat:steward'); // NOT 'direct'
    // char:osric is both the econ executor (office:steward) and the sole
    // reporter's body here -- rule 1 (self-report) fires: one step up, capped.
    const expectedClaim = trueBand === 'outstanding' ? 'outstanding' : BANDS[BANDS.indexOf(trueBand) + 1]!;
    expect(obsData.claimedBand).toBe(expectedClaim);
    expect(next.packet.reports).toHaveLength(1);
    expect(next.packet.reports[0]!.observations).toEqual([
      { executorId: 'char:osric', domain: 'econ', claimedBand: expectedClaim, taskRef: executed.id },
    ]);
  });

  it('no mediation configured at all: op.executed never exists, so no observations fire regardless of reporters', () => {
    const season: SeasonConfig = { ...starterSeason(), reporters: [] }; // tier 1 keeps its default: no mediation
    const f = makeFortune('no-mediation-routing');
    const state = initialState(season);
    const out = resolveTick(season, state, { seatId: 'seat:throne', choices: [] }, f);
    expect(out.events.some((e) => e.type === 'op.executed')).toBe(false);
    expect(out.events.some((e) => e.type === 'observation.received')).toBe(false);
  });
});

// Fix 3 (T5 review): the two describes above only ever exercise starterSeason()
// with its reporters or mediation deliberately overridden ([] or added). The
// actual shipped shape -- a non-empty reporters array (the steward seat)
// paired with NO tier configuring mediation -- was previously exercised only
// by `pnpm demo`, never pinned in the automated gate. It happens to be a
// no-op (op.executed can only ever come from applyMediatedOp, so an
// unmediated tier starves observeExecutions of anything to select), but that
// "happens to be" is exactly the kind of fact that should be a receipt, not
// folklore.
describe('real-default shape (T5 review): unmodified starterSeason() ships non-empty reporters + no mediation on any tier', () => {
  it('one resolveTick on the untouched default config runs clean -- no observation.received, no error', () => {
    const season = starterSeason();
    // Sanity on the premise itself: if starterSeason() ever changes shape,
    // this test should fail loudly here rather than quietly stop covering
    // what it claims to.
    expect(season.reporters.length).toBeGreaterThan(0);
    for (const tier of Object.values(season.tiers)) expect(tier.mediation).toBeUndefined();

    const f = makeFortune('real-default-shape');
    const state = initialState(season);
    const out = resolveTick(season, state, { seatId: season.throne.id, choices: [] }, f);
    expect(out.events.some((e) => e.type === 'observation.received')).toBe(false);
  });
});
