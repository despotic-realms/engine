import { describe, expect, it } from 'vitest';
import { canonJson, hashValue } from '../src/canon.js';
import { divergence, replay, runReign } from '../src/replay.js';
import { starterSeason } from '../src/decks/starter.js';
import type { AgentFn } from '../src/replay.js';
import { seasonHash } from '../src/tick.js';

const SEED = 'determinism-seed-1';
const season = starterSeason();
const neglectful: AgentFn = () => ({ seatId: 'seat:throne', choices: [] });
const dutiful: AgentFn = (packet) => ({
  seatId: 'seat:throne',
  choices: packet.briefs.flatMap((b) => {
    const prefer = ['ration', 'dole', 'stockpile', 'audit', 'irrigation'];
    const opt = b.options.find((o) => prefer.includes(o.id));
    return opt ? [{ briefId: b.briefId, optionId: opt.id }] : [];
  }),
});

describe('determinism', () => {
  it('the same reign runs bit-identically twice', () => {
    const a = runReign(season, SEED, dutiful, 16);
    const b = runReign(season, SEED, dutiful, 16);
    expect(hashValue(a.state)).toBe(hashValue(b.state));
    expect(canonJson(a.chronicle)).toBe(canonJson(b.chronicle));
  });
  it('replaying the recorded log reproduces the chronicle exactly', () => {
    const live = runReign(season, SEED, dutiful, 16);
    const replayed = replay(season, SEED, live.log);
    expect(canonJson(replayed.chronicle)).toBe(canonJson(live.chronicle));
    expect(hashValue(replayed.state)).toBe(hashValue(live.state));
  });
  it('adding never-eligible content perturbs no unrelated fortune (D21)', () => {
    const extra = {
      ...season,
      decks: [{
        ...season.decks[0]!,
        storylets: [...season.decks[0]!.storylets, {
          id: 'starter.zz-never', kind: 'brief' as const, tier: 1, cooldownTicks: 1, once: false,
          pattern: { nodes: [{ as: 'c', type: 'character' as const, where: [{ prop: 'name', cmp: 'eq' as const, value: 'Nobody' }] }] },
          title: 'never', body: 'never',
          options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
          defaultOptionId: 'a',
        }],
      }],
    };
    const a = runReign(season, SEED, neglectful, 16);
    const b = runReign(extra, SEED, neglectful, 16);
    const harvests = (r: typeof a) => r.chronicle.filter((e) => e.type === 'harvest.reaped').map((e) => canonJson(e.data));
    expect(harvests(b)).toEqual(harvests(a));
  });
  it('same seed, different agents → a divergence map with a decision-caused fork', () => {
    const a = runReign(season, SEED, neglectful, 16);
    const b = runReign(season, SEED, dutiful, 16);
    const map = divergence(a.chronicle, b.chronicle);
    expect(map.forkTick).not.toBeNull();
    for (const t of map.ticks) {
      if (t.tick < map.forkTick!) { expect(t.aOnly).toEqual([]); expect(t.bOnly).toEqual([]); }
    }
  });
  it('the famine calendar produces starvation under neglect', () => {
    const a = runReign(season, SEED, neglectful, 16);
    expect(a.chronicle.some((e) => e.type === 'famine.starvation')).toBe(true);
  });

  // Carried from Task 14's review: seasonHash (tick.ts) had no test pinning
  // its stability or its sensitivity to content changes. Same golden
  // procedure as fortune.test.ts's "golden: stream values are frozen" —
  // capture the real value on first run, pin it here.
  describe('seasonHash', () => {
    it('is a pure function of the season', () => {
      expect(seasonHash(starterSeason())).toBe(seasonHash(starterSeason()));
    });
    it('golden: the starter season hash is frozen', () => {
      expect(seasonHash(starterSeason())).toBe('706bec39df5b679c');
    });
    it('changes when a storylet is added', () => {
      const extra = {
        ...season,
        decks: [{
          ...season.decks[0]!,
          storylets: [...season.decks[0]!.storylets, {
            id: 'starter.zz-hash-probe', kind: 'brief' as const, tier: 1, cooldownTicks: 1, once: false,
            pattern: { nodes: [{ as: 'c', type: 'character' as const, where: [{ prop: 'name', cmp: 'eq' as const, value: 'Nobody' }] }] },
            title: 'probe', body: 'probe',
            options: [{ id: 'a', label: 'a', ops: [] }, { id: 'b', label: 'b', ops: [] }],
            defaultOptionId: 'a',
          }],
        }],
      };
      expect(seasonHash(extra)).not.toBe(seasonHash(season));
    });
  });
});
