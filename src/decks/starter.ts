// The public starter deck (D20: storylet format, deck harness, and starter
// decks ship openly). Tone register: First Law — advisors run their own
// game, nobody is a hero. Live-season decks live in the private content repo
// and are sized by the probe matrix (D13); this deck exists so the OSS core
// demos, tests, and self-hosts end-to-end.
import { fx } from '../fx.js';
import type { Deck } from '../storylet.js';
import type { SeasonConfig } from '../tick.js';
import { thornfieldGraph } from './thornfield.js';

export const starterDeck: Deck = {
  id: 'starter',
  tier: 1,
  storylets: [
    {
      id: 'starter.tax-grumble', kind: 'brief', tier: 1, cooldownTicks: 4, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'unrest', cmp: 'gt', value: fx('30') }] }] },
      title: 'Grumbling in the market of {{p}}',
      body: 'The levy weighs on {{p}}. Unrest stands at {{p.unrest}}. Your bailiff waits for a word.',
      options: [
        { id: 'ease', label: 'Ease the rate to 15%', ops: [{ kind: 'decree_tax', placeId: '$p', rateBp: 1500 }] },
        { id: 'hold', label: 'Hold firm', ops: [] },
        { id: 'dole', label: 'Open the granary a crack', ops: [{ kind: 'release_grain', placeId: '$p', amount: '20' }] },
      ],
      defaultOptionId: 'hold',
    },
    {
      id: 'starter.granary-low', kind: 'brief', tier: 1, cooldownTicks: 3, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'granary', cmp: 'lt', value: fx('100') }] }] },
      title: 'The granary of {{p}} runs low',
      body: 'Stores stand at {{p.granary}} — thin for the season. Merchants will sell, at their price.',
      options: [
        { id: 'stockpile', label: 'Buy 40 measures of grain', ops: [{ kind: 'stockpile_grain', placeId: '$p', amount: '40' }] },
        { id: 'ration', label: 'Release 10 to quiet the town', ops: [{ kind: 'release_grain', placeId: '$p', amount: '10' }] },
        { id: 'ignore', label: 'The harvest will provide', ops: [] },
      ],
      defaultOptionId: 'ignore',
    },
    {
      id: 'starter.invest-pitch', kind: 'brief', tier: 1, cooldownTicks: 8, once: false,
      pattern: {
        nodes: [
          { as: 'crown', type: 'institution', where: [{ prop: 'treasury', cmp: 'gt', value: fx('200') }] },
          { as: 'p', type: 'place' },
        ],
      },
      title: 'A proposal of works',
      body: 'An engineer bows low: canals for the fields, or better roads for the tax carts. Eighty from the treasury, repaid in years, not seasons.',
      options: [
        { id: 'irrigation', label: 'Dig the canals', ops: [{ kind: 'invest', placeId: '$p', project: 'irrigation', amount: '80' }] },
        { id: 'roads', label: 'Lay the roads', ops: [{ kind: 'invest', placeId: '$p', project: 'roads', amount: '80' }] },
        { id: 'decline', label: 'The treasury stays shut', ops: [] },
      ],
      defaultOptionId: 'decline',
    },
    {
      id: 'starter.audit-whisper', kind: 'brief', tier: 1, cooldownTicks: 6, once: false,
      pattern: {
        nodes: [{ as: 'c', type: 'character' }, { as: 'o', type: 'office' }],
        edges: [
          { type: 'interest', from: 'c', to: '#inst:crown', where: [{ prop: 'exposed', cmp: 'eq', value: false }] },
          { type: 'appointment', from: 'c', to: 'o' },
          { type: 'loyalty', from: 'c', to: '#char:ruler', where: [{ prop: 'bp', cmp: 'lt', value: 5000 }] },
        ],
      },
      title: 'A whisper about {{c}}',
      body: 'A clerk, eyes down: the ledgers of {{c}} do not quite meet. It may be nothing. Audits cost coin and pride.',
      options: [
        { id: 'audit', label: 'Audit the office', ops: [{ kind: 'audit', officeId: '$o' }] },
        { id: 'ignore', label: 'Ledgers always wobble', ops: [] },
        { id: 'sweeten', label: 'A gift, and closer watch', ops: [{ kind: 'grant', charId: '$c', amount: '25' }] },
      ],
      defaultOptionId: 'ignore',
    },
    {
      id: 'starter.famine-onset', kind: 'brief', tier: 1, cooldownTicks: 2, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'famineStage', cmp: 'ge', value: 1 }] }] },
      title: 'The fields of {{p}} fail',
      body: 'Blight rides the wind. The old men say it will pass; the granary ledger says {{p.granary}}.',
      options: [
        { id: 'ration', label: 'Open the granary — 30 measures', ops: [{ kind: 'release_grain', placeId: '$p', amount: '30' }] },
        { id: 'buy', label: 'Buy 60 at famine prices', ops: [{ kind: 'stockpile_grain', placeId: '$p', amount: '60' }] },
        { id: 'pray', label: 'Endure. Harvests return', ops: [] },
      ],
      defaultOptionId: 'pray',
    },
    {
      id: 'starter.famine-peak', kind: 'brief', tier: 1, cooldownTicks: 2, once: false,
      pattern: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'famineStage', cmp: 'ge', value: 2 }] }] },
      title: 'Hunger in {{p}}',
      body: 'They are eating the seed corn. Unrest stands at {{p.unrest}} and climbing with every empty cart.',
      options: [
        { id: 'dole', label: 'Mass dole — 40 measures', ops: [{ kind: 'release_grain', placeId: '$p', amount: '40' }] },
        { id: 'stand', label: 'Stand firm; hunger passes', ops: [] },
      ],
      defaultOptionId: 'stand',
    },
    {
      id: 'starter.steward-report', kind: 'letter', tier: 1, cooldownTicks: 4, once: false,
      fromVar: 'c',
      pattern: {
        nodes: [{ as: 'c', type: 'character' }, { as: 'o', type: 'office' }],
        edges: [{ type: 'appointment', from: 'c', to: 'o' }],
      },
      title: 'From the desk of {{c}}',
      body: '{{c}} reports the accounts in order, the stores adequate, and the town quiet. All, as ever, is well.',
      options: [], defaultOptionId: '',
    },
    {
      id: 'starter.rival-letter', kind: 'letter', tier: 1, cooldownTicks: 6, once: false,
      fromVar: 'r',
      pattern: {
        nodes: [{ as: 'r', type: 'character' }],
        edges: [{ type: 'grudge', from: 'r', to: '#char:ruler', where: [{ prop: 'bp', cmp: 'gt', value: 6000 }] }],
      },
      title: 'A courteous letter from {{r}}',
      body: '{{r}} writes of weather, of horses, of nothing at all — and of how fondly the family recalls what was taken from them.',
      options: [], defaultOptionId: '',
    },
    {
      id: 'starter.liege-demand', kind: 'letter', tier: 1, cooldownTicks: 4, once: false,
      from: 'char:liege',
      pattern: {
        nodes: [{ as: 'crown', type: 'institution', where: [{ prop: 'arrears', cmp: 'gt', value: fx('0') }] }],
      },
      title: 'Under the liege’s seal',
      body: 'The tribute is in arrears — {{crown.arrears}} owed. Patience is a courtesy, not a custom.',
      options: [], defaultOptionId: '',
    },
  ],
};

export function starterSeason(): SeasonConfig {
  return {
    seasonId: 'season-0-starter',
    startTier: 1,
    initialGraph: thornfieldGraph(),
    decks: [starterDeck],
    tiers: {
      0: { deckIds: [], briefBudget: 0, attentionSlots: 1 },
      1: { deckIds: ['starter'], briefBudget: 2, attentionSlots: 2 },
      2: { deckIds: ['starter'], briefBudget: 3, attentionSlots: 3 },
    },
    calendar: [
      { tick: 4, storyletId: 'starter.audit-whisper' },
      { tick: 4, armFamine: { placeId: 'place:thornfield', durationTicks: 4 } },
    ],
    tierRules: [
      {
        from: 1, to: 0, kind: 'demote', note: 'coup',
        when: { nodes: [{ as: 'p', type: 'place', where: [{ prop: 'unrest', cmp: 'ge', value: fx('80') }] }] },
      },
      {
        from: 1, to: 2, kind: 'promote', note: 'invitation',
        when: {
          nodes: [{
            as: 'crown', type: 'institution',
            where: [{ prop: 'treasury', cmp: 'ge', value: fx('500') }, { prop: 'legitimacy', cmp: 'ge', value: fx('75') }],
          }],
        },
      },
    ],
    throne: { id: 'seat:throne', kind: 'throne', bodyCharId: 'char:ruler', attentionSlots: 2, fidelity: 'external' },
    reporters: [{ id: 'seat:steward', kind: 'office', bodyCharId: 'char:osric', officeId: 'office:steward', attentionSlots: 1, fidelity: 'npc' }],
    primaryPlaceId: 'place:thornfield',
  };
}
