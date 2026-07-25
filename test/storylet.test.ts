import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { thornfieldGraph, thornfieldStressedGraph } from '../src/decks/thornfield.js';
import { starterDeck } from '../src/decks/starter.js';
import { bindOps, checkDeck, eligibleStorylets, renderTpl } from '../src/storylet.js';
import { validateOp } from '../src/ops.js';

const base = thornfieldGraph();
const stressed = thornfieldStressedGraph();

describe('storylet', () => {
  it('renders templates from bindings', () => {
    expect(renderTpl('{{c}} skims {{p.granary}} grain', base, { c: 'char:osric', p: 'place:thornfield' }))
      .toBe('Osric skims 180 grain');
  });
  it('binds $var op params from the match', () => {
    const ops = bindOps([{ kind: 'audit', officeId: '$o' }], { o: 'office:steward' });
    expect(ops).toEqual([{ kind: 'audit', officeId: 'office:steward' }]);
  });
  it('the starter deck passes its own harness', () => {
    expect(checkDeck(starterDeck, [base, stressed])).toEqual([]);
  });
  it('the harness catches broken decks', () => {
    const broken = {
      ...starterDeck,
      storylets: [{ ...starterDeck.storylets[0]!, id: 'x', options: [] }],
    };
    expect(checkDeck(broken, [base, stressed]).length).toBeGreaterThan(0);
  });
  it('eligibility respects cooldowns, once, and sorted order', () => {
    const all = eligibleStorylets(base, [starterDeck], {}, 10, {});
    const ids = all.map((e) => e.storylet.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain('starter.audit-whisper');
    expect(ids).not.toContain('starter.famine-onset'); // famineStage 0 on base
    const cooled = eligibleStorylets(base, [starterDeck], { 'starter.audit-whisper': 9 }, 10, {});
    expect(cooled.map((e) => e.storylet.id)).not.toContain('starter.audit-whisper');
    const spent = eligibleStorylets(base, [starterDeck], {}, 10, { 'starter.audit-whisper': true });
    expect(spent.map((e) => e.storylet.id)).not.toContain('starter.audit-whisper');
  });
  it('famine briefs unlock on the stressed world', () => {
    const ids = eligibleStorylets(stressed, [starterDeck], {}, 10, {}).map((e) => e.storylet.id);
    expect(ids).toContain('starter.famine-onset');
    expect(ids).toContain('starter.famine-peak');
    expect(ids).toContain('starter.liege-demand');
  });
  it('renderTpl bare {{p}} renders name', () => {
    expect(renderTpl('{{p}} is besieged', base, { p: 'place:thornfield' })).toBe('Thornfield is besieged');
  });
  it('checkDeck catches letter with both from+fromVar', () => {
    const brokenLetter = {
      id: 'test.bad-letter',
      kind: 'letter' as const,
      tier: 1,
      cooldownTicks: 4,
      once: false,
      from: 'char:osric',
      fromVar: 'c',
      pattern: { nodes: [{ as: 'c', type: 'character' as const }] },
      title: 'Bad letter',
      body: 'This is bad.',
      options: [],
      defaultOptionId: '',
    };
    const problems = checkDeck({ id: 'test', tier: 1, storylets: [brokenLetter] }, [base]);
    expect(problems.some((p) => p.problem.includes('both'))).toBe(true);
  });
  it('checkDeck catches letter with neither from nor fromVar', () => {
    const brokenLetter = {
      id: 'test.bad-letter-2',
      kind: 'letter' as const,
      tier: 1,
      cooldownTicks: 4,
      once: false,
      pattern: { nodes: [{ as: 'c', type: 'character' as const }] },
      title: 'Bad letter',
      body: 'This is bad.',
      options: [],
      defaultOptionId: '',
    };
    const problems = checkDeck({ id: 'test', tier: 1, storylets: [brokenLetter] }, [base]);
    expect(problems.some((p) => p.problem.includes('exactly one'))).toBe(true);
  });
  it('checkDeck catches letter with non-empty defaultOptionId', () => {
    const brokenLetter = {
      id: 'test.bad-letter-3',
      kind: 'letter' as const,
      tier: 1,
      cooldownTicks: 4,
      once: false,
      from: 'char:osric',
      pattern: { nodes: [{ as: 'c', type: 'character' as const }] },
      title: 'Bad letter',
      body: 'This is bad.',
      options: [],
      defaultOptionId: 'not-empty',
    };
    const problems = checkDeck({ id: 'test', tier: 1, storylets: [brokenLetter] }, [base]);
    expect(problems.some((p) => p.problem.includes('defaultOptionId'))).toBe(true);
  });
  it('bindOps unresolved $var fails in validateOp', () => {
    const ops = bindOps([{ kind: 'audit', officeId: '$missing' }], {});
    expect(ops[0]?.officeId).toContain('$');
    const r = validateOp(base, ops[0]!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('$missing');
  });
});
