// The canonical Tier-1 starter world: one holding, a skimming steward, a
// rival with a grudge, a liege owed taxes. Public per D20 (starter content
// ships openly); live-season worlds live in the private content repo.
import { fx } from '../fx.js';
import type { WorldGraph } from '../graph.js';
import { addEdge, addNode, emptyGraph, setNodeProp } from '../graph.js';

export function thornfieldGraph(): WorldGraph {
  let g = emptyGraph();
  g = addNode(g, {
    id: 'inst:crown', type: 'institution',
    props: { treasury: fx('300'), legitimacy: fx('50'), arrears: fx('0'), rulerCharId: 'char:ruler' },
  });
  g = addNode(g, {
    id: 'place:thornfield', type: 'place',
    props: {
      population: fx('500'), granary: fx('180'), farmland: fx('100'),
      unrest: fx('20'), dole: fx('0'), taxRateBp: 2000,
      roadsBonusBp: 0, defenseBp: 0, famineStage: 0, famineEndsAt: 0,
    },
  });
  g = addNode(g, { id: 'char:ruler', type: 'character', props: { name: 'the Ruler' } });
  g = addNode(g, { id: 'char:osric', type: 'character', props: { name: 'Osric' } });
  g = addNode(g, { id: 'char:maud', type: 'character', props: { name: 'Maud' } });
  g = addNode(g, { id: 'char:liege', type: 'character', props: { name: 'the Liege' } });
  g = addNode(g, { id: 'office:steward', type: 'office', props: { title: 'Steward of Thornfield' } });
  g = addNode(g, { id: 'faction:peasantry', type: 'faction', props: { moodBp: 5000 } });
  g = addNode(g, { id: 'faction:rival-house', type: 'faction', props: { leaderCharId: 'char:maud' } });
  g = addEdge(g, { type: 'appointment', src: 'char:osric', dst: 'office:steward', props: { since: 0 } });
  g = addEdge(g, {
    type: 'interest', src: 'char:osric', dst: 'inst:crown',
    props: { skimPerTick: fx('3'), skimmed: fx('0'), exposed: false, grudgeBumped: false },
  });
  g = addEdge(g, { type: 'loyalty', src: 'char:osric', dst: 'char:ruler', props: { bp: 4200 } });
  g = addEdge(g, { type: 'grudge', src: 'char:maud', dst: 'char:ruler', props: { bp: 6500 } });
  g = addEdge(g, { type: 'debt', src: 'inst:crown', dst: 'char:liege', props: { duePerYear: fx('120') } });
  return g;
}

/** The same holding under strain: unrest high, granary thin, famine biting, liege unpaid. */
export function thornfieldStressedGraph(): WorldGraph {
  let g = thornfieldGraph();
  g = setNodeProp(g, 'place:thornfield', 'unrest', fx('55'));
  g = setNodeProp(g, 'place:thornfield', 'granary', fx('60'));
  g = setNodeProp(g, 'place:thornfield', 'famineStage', 2);
  g = setNodeProp(g, 'inst:crown', 'arrears', fx('120'));
  return g;
}
