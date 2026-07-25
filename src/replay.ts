// Replay is a fold; the chronicle is the log (spec §6). Rerun = same season
// + seed, different agent; divergence maps show decision-caused forks only,
// because fortune is keyed to (stream, tick, key), never to draw order.
import { canonJson } from './canon.js';
import type { ChronicleEvent } from './events.js';
import { makeFortune } from './fortune.js';
import type { ReignState, SeasonConfig, TickDecisions, TickPacket } from './tick.js';
import { initialState, resolveTick } from './tick.js';

export type AgentFn = (packet: TickPacket) => TickDecisions;

export interface ReignRun {
  chronicle: ChronicleEvent[];
  state: ReignState;
  log: TickDecisions[];
  packets: TickPacket[];
}

export function runReign(season: SeasonConfig, masterSeed: string, agent: AgentFn, ticks: number): ReignRun {
  const fortune = makeFortune(masterSeed);
  let state = initialState(season);
  const chronicle: ChronicleEvent[] = [];
  const log: TickDecisions[] = [];
  const packets: TickPacket[] = [];
  let packet: TickPacket | undefined;
  for (let t = 0; t < ticks; t++) {
    const decisions: TickDecisions = packet === undefined ? { seatId: season.throne.id, choices: [] } : agent(packet);
    log.push(decisions);
    const out = resolveTick(season, state, decisions, fortune);
    state = out.state;
    packet = out.packet;
    chronicle.push(...out.events);
    packets.push(out.packet);
  }
  return { chronicle, state, log, packets };
}

export function replay(season: SeasonConfig, masterSeed: string, log: readonly TickDecisions[]): { chronicle: ChronicleEvent[]; state: ReignState } {
  const fortune = makeFortune(masterSeed);
  let state = initialState(season);
  const chronicle: ChronicleEvent[] = [];
  for (const decisions of log) {
    const out = resolveTick(season, state, decisions, fortune);
    state = out.state;
    chronicle.push(...out.events);
  }
  return { chronicle, state };
}

export interface DivergenceMap {
  forkTick: number | null;
  ticks: Array<{ tick: number; aOnly: string[]; bOnly: string[] }>;
}

export function divergence(a: readonly ChronicleEvent[], b: readonly ChronicleEvent[]): DivergenceMap {
  const byTick = (events: readonly ChronicleEvent[]) => {
    const m = new Map<number, Set<string>>();
    for (const e of events) {
      const key = `${e.id} ${e.type} ${canonJson(e.data)}`;
      if (!m.has(e.tick)) m.set(e.tick, new Set());
      m.get(e.tick)!.add(key);
    }
    return m;
  };
  const ma = byTick(a);
  const mb = byTick(b);
  const allTicks = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y);
  const ticks: DivergenceMap['ticks'] = [];
  let forkTick: number | null = null;
  for (const t of allTicks) {
    const sa = ma.get(t) ?? new Set<string>();
    const sb = mb.get(t) ?? new Set<string>();
    const aOnly = [...sa].filter((k) => !sb.has(k)).sort();
    const bOnly = [...sb].filter((k) => !sa.has(k)).sort();
    if ((aOnly.length > 0 || bOnly.length > 0) && forkTick === null) forkTick = t;
    ticks.push({ tick: t, aOnly, bOnly });
  }
  return { forkTick, ticks };
}
