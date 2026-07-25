import { describe, expect, it } from 'vitest';
import { fx } from '../src/fx.js';
import { makeFortune } from '../src/fortune.js';
import { removeEdge, setEdgeProp, setNodeProp } from '../src/graph.js';
import { compileReport } from '../src/report.js';
import { thornfieldGraph } from '../src/decks/thornfield.js';
import type { Seat } from '../src/report.js';

const f = makeFortune('report-test-seed');
const steward: Seat = { id: 'seat:steward', kind: 'office', bodyCharId: 'char:osric', officeId: 'office:steward', attentionSlots: 1, fidelity: 'npc' };
const INTEREST = 'interest:char:osric->inst:crown';
const LOYALTY = 'loyalty:char:osric->char:ruler';

describe('compileReport', () => {
  it('an unexposed skimmer hides the theft', () => {
    const g = setEdgeProp(thornfieldGraph(), INTEREST, 'skimmed', fx('12'));
    const r = compileReport(g, f, 5, 'place:thornfield', steward);
    expect(r.treasury).toBe('312'); // true 300 + hidden 12
  });
  it('an exposed skimmer reports the truth', () => {
    let g = setEdgeProp(thornfieldGraph(), INTEREST, 'skimmed', fx('12'));
    g = setEdgeProp(g, INTEREST, 'exposed', true);
    expect(compileReport(g, f, 5, 'place:thornfield', steward).treasury).toBe('300');
  });
  it('granary noise is bounded, seeded, and repeatable', () => {
    const g = thornfieldGraph();
    const a = compileReport(g, f, 5, 'place:thornfield', steward);
    const b = compileReport(g, f, 5, 'place:thornfield', steward);
    expect(a.granary).toBe(b.granary);
    const reported = fx(a.granary);
    expect(reported >= fx('174.6')).toBe(true); // 180 * 0.97
    expect(reported <= fx('185.4')).toBe(true); // 180 * 1.03
  });
  it('a disloyal reporter understates unrest by one bucket', () => {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('55')); // restive
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('restive'); // loyalty 4200
    g = setEdgeProp(g, LOYALTY, 'bp', 2500);
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('uneasy'); // shifted down
  });

  // Regression: silence property (central epistemic guarantee)
  it('unexposed skimmer silence: only treasury differs, notes/granary/unrest identical', () => {
    let g = setEdgeProp(thornfieldGraph(), INTEREST, 'skimmed', fx('12'));
    const hidden = compileReport(g, f, 5, 'place:thornfield', steward);
    g = setEdgeProp(g, INTEREST, 'exposed', true);
    const exposed = compileReport(g, f, 5, 'place:thornfield', steward);
    expect(hidden.notes).toEqual(exposed.notes);
    expect(hidden.granary).toBe(exposed.granary);
    expect(hidden.unrest).toBe(exposed.unrest);
    expect(hidden.treasury).not.toBe(exposed.treasury);
  });

  // Regression: missing loyalty edge defaults to 5000 bp (no shift)
  it('missing loyalty edge uses default 5000 bp (no unrest shift)', () => {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('55')); // restive
    g = removeEdge(g, LOYALTY);
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('restive');
  });
  it('non-number loyalty bp treated as default 5000', () => {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('55')); // restive
    g = setEdgeProp(g, LOYALTY, 'bp', 'high');
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('restive');
  });

  // Regression: bucket boundaries (loyalty ≥3000, no shift)
  it('unrest bucket boundaries: fx(25) → uneasy, fx(50) → restive, fx(75) → boiling', () => {
    let g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('25'));
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('uneasy');
    g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('50'));
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('restive');
    g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('75'));
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('boiling');
  });
  it('unrest bucket boundary: fx(24.9999) → calm', () => {
    const g = setNodeProp(thornfieldGraph(), 'place:thornfield', 'unrest', fx('24.9999'));
    expect(compileReport(g, f, 5, 'place:thornfield', steward).unrest).toBe('calm');
  });
});
