import { describe, expect, it } from 'vitest';
import { eligibleStorylets } from '../src/storylet.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import type { Deck } from '../src/storylet.js';

const petitionGen: Deck = {
  id: 'gen', tier: 1,
  storylets: [{
    id: 'gen.petition', kind: 'brief', tier: 1, cooldownTicks: 4, once: false,
    perBinding: true, maxInstancesPerTick: 2,
    pattern: { nodes: [{ as: 'c', type: 'character' }] },
    title: 'A petition from {{c}}', body: '{{c}} asks for a hearing.',
    options: [{ id: 'hear', label: 'Hear them', ops: [] }, { id: 'refuse', label: 'Refuse', ops: [] }],
    defaultOptionId: 'refuse',
  }],
};

describe('perBinding generators', () => {
  it('expands one instance per binding, capped, in canonical order', () => {
    const entries = eligibleStorylets(thornfieldGraph(), [petitionGen], {}, 10, {});
    expect(entries).toHaveLength(2); // 4 characters, capped at 2
    expect(entries[0]?.instanceKey).toBe('gen.petition@c=char:liege');
    expect(entries[1]?.instanceKey).toBe('gen.petition@c=char:maud');
  });
  it('cooldowns are per instance, not per generator', () => {
    const cooled = eligibleStorylets(thornfieldGraph(), [petitionGen], { 'gen.petition@c=char:liege': 9 }, 10, {});
    expect(cooled[0]?.instanceKey).toBe('gen.petition@c=char:maud');
    expect(cooled).toHaveLength(2); // maud + osric slide into the cap
  });
  it('normal storylets keep their plain id as instanceKey', () => {
    const plain: Deck = { ...petitionGen, storylets: [{ ...petitionGen.storylets[0]!, perBinding: false, id: 'gen.single' }] };
    const entries = eligibleStorylets(thornfieldGraph(), [plain], {}, 10, {});
    expect(entries).toHaveLength(1);
    expect(entries[0]?.instanceKey).toBe('gen.single');
  });
});
