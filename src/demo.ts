// The CLI proof that the OSS core runs unchanged outside any host (D12).
// Deterministic stub agent, two identical runs, printed fingerprints.
import { hashValue } from './canon.js';
import { starterSeason } from './decks/starter.js';
import type { AgentFn } from './replay.js';
import { runReign } from './replay.js';

const agent: AgentFn = (packet) => ({
  seatId: 'seat:throne',
  choices: packet.briefs.flatMap((b) => {
    const prefer = ['ration', 'dole', 'stockpile', 'audit', 'irrigation'];
    const opt = b.options.find((o) => prefer.includes(o.id));
    return opt ? [{ briefId: b.briefId, optionId: opt.id }] : [];
  }),
});

const season = starterSeason();
const seed = 'demo-seed';
const a = runReign(season, seed, agent, 16);
const b = runReign(season, seed, agent, 16);

for (const p of a.packets) {
  const titles = p.briefs.map((x) => x.title).join(' | ');
  const letters = p.correspondence.map((l) => l.from).join(', ');
  console.log(`tick ${String(p.tick).padStart(2)}  briefs: ${titles || '—'}${letters ? `  letters from: ${letters}` : ''}`);
}
const headline = (t: string) => a.chronicle.filter((e) => e.type === t).length;
console.log(`\nevents: ${a.chronicle.length}  harvests: ${headline('harvest.reaped')}  starvation: ${headline('famine.starvation')}  audits: ${headline('op.audit')}`);
console.log(`state hash: ${hashValue(a.state)}`);
console.log(`replay:     ${hashValue(a.state) === hashValue(b.state) ? 'bit-exact ✓' : 'DIVERGED ✗'}`);
