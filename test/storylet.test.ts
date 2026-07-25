import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { thornfieldGraph, thornfieldStressedGraph } from '../src/decks/thornfield.js';
import { starterDeck } from '../src/decks/starter.js';
import { bindOps, checkDeck, eligibleStorylets, renderTpl } from '../src/storylet.js';

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
});
