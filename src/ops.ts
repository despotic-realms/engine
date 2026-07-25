// The closed op vocabulary — "the type system of power" (spec §6.6).
// Free-text directives are compiled (host-side, temperature 0) into these
// shapes; listed brief options are pre-bound to them; out-of-schema input is
// rejected here. Only applyOp mutates the graph on behalf of an actor.
// New ops land with the decks that need them, each with tests like these.
import { ECON } from './constants.js';
import type { Emitter } from './events.js';
import type { Fx } from './fx.js';
import { fx, fxToString, mulFx } from './fx.js';
import type { NodeType, WorldGraph } from './graph.js';
import {
  addEdge, addNode, edgeId, edgesTo, findEdge, getNode, propFx, propStr,
  removeEdge, setEdgeProp, setNodeProp,
} from './graph.js';

export type Op =
  | { kind: 'decree_tax'; placeId: string; rateBp: number }
  | { kind: 'release_grain'; placeId: string; amount: string }
  | { kind: 'stockpile_grain'; placeId: string; amount: string }
  | { kind: 'appoint'; charId: string; officeId: string }
  | { kind: 'audit'; officeId: string }
  | { kind: 'grant'; charId: string; amount: string }
  | { kind: 'invest'; placeId: string; project: 'irrigation' | 'roads' | 'walls'; amount: string };

export interface OpParamDesc {
  name: string;
  type: 'nodeId' | 'fx' | 'int' | 'enum';
  nodeType?: NodeType;
  min?: number;
  max?: number;
  values?: readonly string[];
}

export const OP_KINDS: Record<Op['kind'], { summary: string; params: OpParamDesc[] }> = {
  decree_tax: {
    summary: 'Set the tax rate of a holding (basis points of harvest).',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'rateBp', type: 'int', min: 0, max: 10000 },
    ],
  },
  release_grain: {
    summary: 'Open the granary: move grain to the dole.',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'amount', type: 'fx' },
    ],
  },
  stockpile_grain: {
    summary: 'Buy grain into the granary at market price.',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'amount', type: 'fx' },
    ],
  },
  appoint: {
    summary: 'Appoint a character to an office, replacing any holder.',
    params: [
      { name: 'charId', type: 'nodeId', nodeType: 'character' },
      { name: 'officeId', type: 'nodeId', nodeType: 'office' },
    ],
  },
  audit: {
    summary: 'Audit an office. Costs AUDIT_COST. Exposes hidden skimming.',
    params: [{ name: 'officeId', type: 'nodeId', nodeType: 'office' }],
  },
  grant: {
    summary: 'Grant treasury to a character; buys loyalty at 2.5bp per unit.',
    params: [
      { name: 'charId', type: 'nodeId', nodeType: 'character' },
      { name: 'amount', type: 'fx' },
    ],
  },
  invest: {
    summary: 'Fund a project that matures in INVEST_MATURITY_TICKS ticks.',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'project', type: 'enum', values: ['irrigation', 'roads', 'walls'] },
      { name: 'amount', type: 'fx' },
    ],
  },
};

export type OpResult = { ok: true; op: Op } | { ok: false; error: string };

function parseAmount(v: unknown): Fx | string {
  if (typeof v !== 'string') return 'amount must be a decimal string';
  try {
    const a = fx(v);
    return a <= 0n ? 'amount must be positive' : a;
  } catch {
    return `bad amount '${v}'`;
  }
}

function treasury(g: WorldGraph): Fx {
  return propFx(getNode(g, 'inst:crown').props, 'treasury');
}

export function validateOp(g: WorldGraph, raw: unknown): OpResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'op must be an object' };
  const op = raw as Record<string, unknown>;
  const kind = op['kind'];
  if (typeof kind !== 'string' || !(kind in OP_KINDS)) return { ok: false, error: `unknown op kind '${String(kind)}'` };
  const desc = OP_KINDS[kind as Op['kind']];
  const allowed = new Set(['kind', ...desc.params.map((p) => p.name)]);
  for (const k of Object.keys(op)) if (!allowed.has(k)) return { ok: false, error: `unexpected field '${k}'` };
  for (const p of desc.params) {
    const v = op[p.name];
    if (v === undefined) return { ok: false, error: `missing '${p.name}'` };
    if (p.type === 'nodeId') {
      if (typeof v !== 'string' || !g.nodes[v]) return { ok: false, error: `no such node '${String(v)}'` };
      if (p.nodeType && g.nodes[v]?.type !== p.nodeType) return { ok: false, error: `'${v}' is not a ${p.nodeType}` };
    } else if (p.type === 'int') {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false, error: `'${p.name}' must be an integer` };
      if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))
        return { ok: false, error: `'${p.name}' out of range` };
    } else if (p.type === 'fx') {
      const a = parseAmount(v);
      if (typeof a === 'string') return { ok: false, error: a };
    } else if (p.type === 'enum') {
      if (typeof v !== 'string' || !p.values?.includes(v)) return { ok: false, error: `bad '${p.name}'` };
    }
  }
  // Referential/resource checks beyond shape:
  const t = treasury(g);
  switch (kind as Op['kind']) {
    case 'release_grain': {
      const amount = fx(op['amount'] as string);
      const granary = propFx(getNode(g, op['placeId'] as string).props, 'granary');
      if (amount > granary) return { ok: false, error: 'not enough grain in the granary' };
      break;
    }
    case 'stockpile_grain':
      if (mulFx(fx(op['amount'] as string), ECON.GRAIN_PRICE) > t) return { ok: false, error: 'treasury cannot afford it' };
      break;
    case 'audit': {
      if (edgesTo(g, op['officeId'] as string, 'appointment').length === 0)
        return { ok: false, error: 'office is vacant' };
      if (ECON.AUDIT_COST > t) return { ok: false, error: 'treasury cannot afford an audit' };
      break;
    }
    case 'grant':
      if (fx(op['amount'] as string) > t) return { ok: false, error: 'treasury cannot afford it' };
      break;
    case 'invest': {
      if (fx(op['amount'] as string) > t) return { ok: false, error: 'treasury cannot afford it' };
      const projId = `proj:${op['project'] as string}:${op['placeId'] as string}`;
      if (g.nodes[projId]) return { ok: false, error: 'that project is already underway' };
      break;
    }
  }
  return { ok: true, op: op as unknown as Op };
}

function spend(g: WorldGraph, amount: Fx): WorldGraph {
  return setNodeProp(g, 'inst:crown', 'treasury', treasury(g) - amount);
}

export function applyOp(g: WorldGraph, op: Op, tick: number, em: Emitter, parents: string[] = []): WorldGraph {
  const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
  switch (op.kind) {
    case 'decree_tax': {
      const g2 = setNodeProp(g, op.placeId, 'taxRateBp', op.rateBp);
      em.emit('op.decree_tax', { parents, data: { ...op }, deltas: [{ op: 'node.set', id: op.placeId, key: 'taxRateBp', value: op.rateBp }] });
      return g2;
    }
    case 'release_grain': {
      const amount = fx(op.amount);
      const p = getNode(g, op.placeId).props;
      let g2 = setNodeProp(g, op.placeId, 'granary', propFx(p, 'granary') - amount);
      g2 = setNodeProp(g2, op.placeId, 'dole', propFx(p, 'dole') + amount);
      em.emit('op.release_grain', { parents, data: { ...op } });
      return g2;
    }
    case 'stockpile_grain': {
      const amount = fx(op.amount);
      let g2 = spend(g, mulFx(amount, ECON.GRAIN_PRICE));
      g2 = setNodeProp(g2, op.placeId, 'granary', propFx(getNode(g2, op.placeId).props, 'granary') + amount);
      em.emit('op.stockpile_grain', { parents, data: { ...op } });
      return g2;
    }
    case 'appoint': {
      let g2 = g;
      for (const e of edgesTo(g2, op.officeId, 'appointment')) g2 = removeEdge(g2, e.id);
      g2 = addEdge(g2, { type: 'appointment', src: op.charId, dst: op.officeId, props: { since: tick } });
      em.emit('op.appoint', { parents, data: { ...op } });
      return g2;
    }
    case 'audit': {
      let g2 = spend(g, ECON.AUDIT_COST);
      const holder = edgesTo(g2, op.officeId, 'appointment')[0];
      if (!holder) throw new Error('applyOp: audit on vacant office (validate first)');
      let found = false;
      let skimmed = 0n;
      const interest = findEdge(g2, 'interest', holder.src, 'inst:crown');
      if (interest && propFx(interest.props, 'skimPerTick') > 0n && interest.props['exposed'] === false) {
        found = true;
        skimmed = propFx(interest.props, 'skimmed');
        g2 = setEdgeProp(g2, interest.id, 'exposed', true);
      }
      em.emit('op.audit', { parents, data: { ...op, found, skimmed: fxToString(skimmed), holder: holder.src } });
      return g2;
    }
    case 'grant': {
      const amount = fx(op.amount);
      let g2 = spend(g, amount);
      // 2.5bp of loyalty per treasury unit granted: bp += amount * 25 / (10 * FX_SCALE)
      const bpDelta = Number((amount * 25n) / (10n * 10_000n));
      const eid = edgeId('loyalty', op.charId, rulerId);
      const existing = g2.edges[eid];
      const cur = typeof existing?.props['bp'] === 'number' ? (existing.props['bp'] as number) : 5000;
      g2 = existing
        ? setEdgeProp(g2, eid, 'bp', clampBp(cur + bpDelta))
        : addEdge(g2, { type: 'loyalty', src: op.charId, dst: rulerId, props: { bp: clampBp(5000 + bpDelta) } });
      em.emit('op.grant', { parents, data: { ...op, bpDelta } });
      return g2;
    }
    case 'invest': {
      const amount = fx(op.amount);
      const g2 = spend(g, amount);
      const ev = em.emit('op.invest', { parents, data: { ...op } });
      const projId = `proj:${op.project}:${op.placeId}`;
      return addNode(g2, {
        id: projId, type: 'project',
        props: {
          placeId: op.placeId, project: op.project, amount,
          maturesAt: tick + ECON.INVEST_MATURITY_TICKS, matured: false,
          causeEventId: ev.id, // causal link consumed by the maturity event (T11)
        },
      });
    }
  }
}

// Integer clamp to [0, 10000] without Math.* (banned in core)
function clampBp(bp: number): number {
  return bp > 10000 ? 10000 : bp < 0 ? 0 : bp;
}
