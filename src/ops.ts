// The closed op vocabulary — "the type system of power" (spec §6.6).
// Free-text directives are compiled (host-side, temperature 0) into these
// shapes; listed brief options are pre-bound to them; out-of-schema input is
// rejected here. Only applyOp mutates the graph on behalf of an actor.
// New ops land with the decks that need them, each with tests like these.
//
// D14: chronicle events ARE graph deltas. Every arm below builds a
// GraphDelta[] describing all of its mutations, applies it through
// applyDeltas (the same function a replay would use), and emits the event
// carrying those exact deltas -- so the graph that comes out of applyOp and
// the graph a replay would reconstruct from the chronicle can never drift
// apart.
import { ECON } from './constants.js';
import { applyDeltas } from './events.js';
import type { Emitter, GraphDelta } from './events.js';
import type { Fx } from './fx.js';
import { clampFx, divFx, fx, fxToString, fxWhole, mulFx, FX_ZERO } from './fx.js';
import type { NodeType, WorldGraph } from './graph.js';
import { appendAllegianceLog, edgeId, edgesFrom, edgesTo, findEdge, getNode, propFx, propStr } from './graph.js';

export type Op =
  | { kind: 'decree_tax'; placeId: string; rateBp: number }
  | { kind: 'release_grain'; placeId: string; amount: string }
  | { kind: 'stockpile_grain'; placeId: string; amount: string }
  | { kind: 'appoint'; charId: string; officeId: string }
  | { kind: 'audit'; officeId: string }
  | { kind: 'grant'; charId: string; amount: string }
  | { kind: 'invest'; placeId: string; project: 'irrigation' | 'roads' | 'walls'; amount: string }
  | { kind: 'imprison'; charId: string }
  | { kind: 'pardon'; charId: string }
  | { kind: 'raise_levy'; placeId: string; size: string }
  | { kind: 'disband_levy'; placeId: string }
  | { kind: 'send_envoy'; charId: string; tone: 'conciliatory' | 'firm' | 'threatening' }
  | { kind: 'seize'; charId: string; amount: string }
  | { kind: 'hold_festival'; placeId: string; amount: string }
  | { kind: 'record_stance'; stanceId: string; value: 'for' | 'against' }
  | { kind: 'vet'; charId: string }
  | { kind: 'obscure_records' };

export interface OpParamDesc {
  name: string;
  type: 'nodeId' | 'fx' | 'int' | 'enum' | 'stanceId';
  nodeType?: NodeType;
  min?: number;
  max?: number;
  values?: readonly string[];
}

export const OP_KINDS: Record<Op['kind'], { summary: string; params: OpParamDesc[]; domain: 'econ' | 'martial' | 'social' | null }> = {
  decree_tax: {
    summary: 'Set the tax rate of a holding (basis points of harvest).',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'rateBp', type: 'int', min: 0, max: 10000 },
    ],
    domain: 'econ',
  },
  release_grain: {
    summary: 'Open the granary: move grain to the dole.',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'amount', type: 'fx' },
    ],
    domain: 'econ',
  },
  stockpile_grain: {
    summary: 'Buy grain into the granary at market price.',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'amount', type: 'fx' },
    ],
    domain: 'econ',
  },
  appoint: {
    summary: 'Appoint a character to an office, replacing any holder.',
    params: [
      { name: 'charId', type: 'nodeId', nodeType: 'character' },
      { name: 'officeId', type: 'nodeId', nodeType: 'office' },
    ],
    domain: null,
  },
  audit: {
    summary: 'Audit an office. Costs AUDIT_COST. Exposes hidden skimming.',
    params: [{ name: 'officeId', type: 'nodeId', nodeType: 'office' }],
    domain: 'econ',
  },
  grant: {
    summary: 'Grant treasury to a character; buys loyalty at 2.5bp per unit.',
    params: [
      { name: 'charId', type: 'nodeId', nodeType: 'character' },
      { name: 'amount', type: 'fx' },
    ],
    domain: 'econ',
  },
  invest: {
    summary: 'Fund a project that matures in INVEST_MATURITY_TICKS ticks.',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'project', type: 'enum', values: ['irrigation', 'roads', 'walls'] },
      { name: 'amount', type: 'fx' },
    ],
    domain: 'econ',
  },
  imprison: {
    summary: 'Imprison a character: offices vacated, a grudge kindled.',
    params: [{ name: 'charId', type: 'nodeId', nodeType: 'character' }],
    domain: 'martial',
  },
  pardon: {
    summary: 'Release an imprisoned character; cools their grudge, warms loyalty.',
    params: [{ name: 'charId', type: 'nodeId', nodeType: 'character' }],
    domain: null,
  },
  raise_levy: {
    summary: 'Raise militia at a holding (LEVY_RAISE_COST per unit; upkeep accrues).',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'size', type: 'fx' },
    ],
    domain: 'martial',
  },
  disband_levy: {
    summary: 'Disband a holding’s levy entirely.',
    params: [{ name: 'placeId', type: 'nodeId', nodeType: 'place' }],
    domain: 'martial',
  },
  send_envoy: {
    summary: 'Send an envoy to a character; tone moves grudge/loyalty deterministically.',
    params: [
      { name: 'charId', type: 'nodeId', nodeType: 'character' },
      { name: 'tone', type: 'enum', values: ['conciliatory', 'firm', 'threatening'] },
    ],
    domain: 'social',
  },
  seize: {
    summary: 'Seize part of a character’s wealth; kindles a grudge, costs legitimacy.',
    params: [
      { name: 'charId', type: 'nodeId', nodeType: 'character' },
      { name: 'amount', type: 'fx' },
    ],
    domain: 'martial',
  },
  hold_festival: {
    summary: 'Spend treasury on public festivity; unrest eases by amount/8.',
    params: [
      { name: 'placeId', type: 'nodeId', nodeType: 'place' },
      { name: 'amount', type: 'fx' },
    ],
    domain: 'social',
  },
  record_stance: {
    summary: 'Record the throne’s stance on a named question; the chronicle and later storylets read it.',
    params: [
      { name: 'stanceId', type: 'stanceId' },
      { name: 'value', type: 'enum', values: ['for', 'against'] },
    ],
    domain: null,
  },
  vet: {
    summary: 'Vet a character: a true-ish read of their strongest aptitude, through the vetting authority (the spymaster if staffed, else the ruler).',
    params: [{ name: 'charId', type: 'nodeId', nodeType: 'character' }],
    domain: 'social',
  },
  obscure_records: {
    summary: 'Obscure the court’s records: a rival’s next poach bid targets a stale want instead of the current one.',
    params: [],
    domain: 'social',
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

// Task 9 (spec §9): vet's and obscure_records's fixed treasury costs. Named
// (rather than inlined like hold_festival's bare fx('10') floor) because
// each is read from TWO places -- validateOp's affordability gate and
// applyOp's own debit -- and must be the exact same value at both.
const VET_COST = fx('5');
const OBSCURE_RECORDS_COST = fx('10');

// Stance ids name a consistency-probe question ('granary-doctrine', not a
// node): lowercase kebab-case, 1-40 chars, never starting with a hyphen.
// Char-by-char rather than a regex literal -- ops.ts is not in
// check-no-float's DIVIDE_ALLOW, and this sidesteps the question of whether
// a regex literal's delimiters would trip the bare-'/' scan entirely.
function isStanceId(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 40) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57; // '0'-'9'
    const isLower = c >= 97 && c <= 122; // 'a'-'z'
    const isHyphen = c === 45; // '-'
    if (!isDigit && !isLower && !(isHyphen && i > 0)) return false;
  }
  return true;
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
    } else if (p.type === 'stanceId') {
      if (!isStanceId(v)) return { ok: false, error: `bad '${p.name}'` };
    }
  }
  // Referential/resource checks beyond shape. Each branch reads only the
  // graph state its own check needs (treasury, granary, office roster) --
  // decree_tax and appoint need none of it, so they touch nothing here.
  const t = treasury(g);
  switch (kind as Op['kind']) {
    case 'release_grain': {
      const amount = fx(op['amount'] as string);
      const granary = propFx(getNode(g, op['placeId'] as string).props, 'granary');
      if (amount > granary) return { ok: false, error: 'not enough grain in the granary' };
      break;
    }
    case 'stockpile_grain':
      if (mulFx(fx(op['amount'] as string), ECON.GRAIN_PRICE) > treasury(g)) return { ok: false, error: 'treasury cannot afford it' };
      break;
    case 'audit': {
      if (edgesTo(g, op['officeId'] as string, 'appointment').length === 0)
        return { ok: false, error: 'office is vacant' };
      if (ECON.AUDIT_COST > treasury(g)) return { ok: false, error: 'treasury cannot afford an audit' };
      break;
    }
    case 'grant':
      if (fx(op['amount'] as string) > treasury(g)) return { ok: false, error: 'treasury cannot afford it' };
      break;
    case 'invest': {
      if (fx(op['amount'] as string) > treasury(g)) return { ok: false, error: 'treasury cannot afford it' };
      const projId = `proj:${op['project'] as string}:${op['placeId'] as string}`;
      if (g.nodes[projId]) return { ok: false, error: 'that project is already underway' };
      break;
    }
    case 'imprison': {
      const c = getNode(g, op['charId'] as string);
      if ((op['charId'] as string) === propStr(getNode(g, 'inst:crown').props, 'rulerCharId'))
        return { ok: false, error: 'the crown cannot imprison itself' };
      if (c.props['imprisoned'] === true) return { ok: false, error: 'already imprisoned' };
      break;
    }
    case 'pardon':
      if (getNode(g, op['charId'] as string).props['imprisoned'] !== true)
        return { ok: false, error: 'that character is not imprisoned' };
      break;
    case 'raise_levy':
      if (mulFx(fx(op['size'] as string), ECON.LEVY_RAISE_COST) > t)
        return { ok: false, error: 'treasury cannot afford that levy' };
      break;
    case 'disband_levy':
      if (propFx(getNode(g, op['placeId'] as string).props, 'levy') <= 0n)
        return { ok: false, error: 'no levy raised there' };
      break;
    case 'seize': {
      const w = getNode(g, op['charId'] as string).props['wealth'];
      if (typeof w !== 'bigint') return { ok: false, error: 'that character has no seizable wealth' };
      if (fx(op['amount'] as string) > w) return { ok: false, error: 'they do not hold that much' };
      break;
    }
    case 'hold_festival':
      if (fx(op['amount'] as string) < fx('10')) return { ok: false, error: 'a festival needs at least 10' };
      if (fx(op['amount'] as string) > t) return { ok: false, error: 'treasury cannot afford it' };
      break;
    case 'vet':
      if (VET_COST > t) return { ok: false, error: 'treasury cannot afford a vetting' };
      break;
    case 'obscure_records':
      if (OBSCURE_RECORDS_COST > t) return { ok: false, error: 'treasury cannot afford counter-intelligence' };
      break;
  }
  return { ok: true, op: op as unknown as Op };
}

// Delta that debits the crown treasury by `amount`, valued against `g`'s
// current balance. Callers fold this into the same deltas[] array they hand
// to applyDeltas and emit -- there is no separate mutating "spend" step for
// the applied graph and the chronicled record to disagree about.
function debitTreasury(g: WorldGraph, amount: Fx): GraphDelta {
  return { op: 'node.set', id: 'inst:crown', key: 'treasury', value: treasury(g) - amount };
}

// Integer clamp to [0, 10000] without Math.* (banned in core)
function clampBp(bp: number): number {
  return bp > 10000 ? 10000 : bp < 0 ? 0 : bp;
}

export function applyOp(g: WorldGraph, op: Op, tick: number, em: Emitter, parents: string[] = []): WorldGraph {
  switch (op.kind) {
    case 'decree_tax': {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: op.placeId, key: 'taxRateBp', value: op.rateBp }];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.decree_tax', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'release_grain': {
      const amount = fx(op.amount);
      const p = getNode(g, op.placeId).props;
      const deltas: GraphDelta[] = [
        { op: 'node.set', id: op.placeId, key: 'granary', value: propFx(p, 'granary') - amount },
        { op: 'node.set', id: op.placeId, key: 'dole', value: propFx(p, 'dole') + amount },
      ];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.release_grain', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'stockpile_grain': {
      const amount = fx(op.amount);
      const deltas: GraphDelta[] = [
        debitTreasury(g, mulFx(amount, ECON.GRAIN_PRICE)),
        { op: 'node.set', id: op.placeId, key: 'granary', value: propFx(getNode(g, op.placeId).props, 'granary') + amount },
      ];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.stockpile_grain', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'appoint': {
      const deltas: GraphDelta[] = edgesTo(g, op.officeId, 'appointment').map(
        (e): GraphDelta => ({ op: 'edge.remove', id: e.id }),
      );
      deltas.push({
        op: 'edge.add',
        edge: {
          id: edgeId('appointment', op.charId, op.officeId),
          type: 'appointment', src: op.charId, dst: op.officeId, props: { since: tick },
        },
      });
      const g2 = applyDeltas(g, deltas);
      em.emit('op.appoint', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'audit': {
      const holder = edgesTo(g, op.officeId, 'appointment')[0];
      if (!holder) throw new Error('applyOp: audit on vacant office (validate first)');
      const deltas: GraphDelta[] = [debitTreasury(g, ECON.AUDIT_COST)];
      let found = false;
      let skimmed = 0n;
      const interest = findEdge(g, 'interest', holder.src, 'inst:crown');
      if (interest && propFx(interest.props, 'skimPerTick') > 0n && interest.props['exposed'] === false) {
        found = true;
        skimmed = propFx(interest.props, 'skimmed');
        deltas.push({ op: 'edge.set', id: interest.id, key: 'exposed', value: true });
      }
      const g2 = applyDeltas(g, deltas);
      em.emit('op.audit', { parents, data: { ...op, found, skimmed: fxToString(skimmed), holder: holder.src }, deltas });
      return g2;
    }
    case 'grant': {
      const amount = fx(op.amount);
      const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
      // 2.5bp of loyalty per treasury unit granted, via the fx helpers
      // (no bare `/`): mulFx(amount, 2.5) is the bp value at fx scale;
      // fxWhole takes its floor-rounded whole-unit part.
      const bpDelta = Number(fxWhole(mulFx(amount, fx('2.5'))));
      const eid = edgeId('loyalty', op.charId, rulerId);
      const existing = g.edges[eid];
      const cur = typeof existing?.props['bp'] === 'number' ? (existing.props['bp'] as number) : 5000;
      // nextId()-then-emit (events.ts's contract, mirrored from invest
      // below): the log's `cause` must cite this arm's own event id, which
      // isn't known until em.emit() runs at the bottom of the arm -- so it's
      // pre-allocated here and the only emit() call for this arm is the one
      // at the end, with nothing else emitted in between.
      const eventId = em.nextId();
      const deltas: GraphDelta[] = [debitTreasury(g, amount)];
      if (existing) {
        const newBp = clampBp(cur + bpDelta);
        deltas.push({ op: 'edge.set', id: eid, key: 'bp', value: newBp });
        deltas.push({ op: 'edge.set', id: eid, key: 'log', value: appendAllegianceLog(existing.props, tick, newBp - cur, eventId) });
      } else {
        const newBp = clampBp(5000 + bpDelta);
        deltas.push({
          op: 'edge.add',
          edge: { id: eid, type: 'loyalty', src: op.charId, dst: rulerId, props: { bp: newBp, log: [{ tick, deltaBp: newBp, cause: eventId }] } },
        });
      }
      const g2 = applyDeltas(g, deltas);
      em.emit('op.grant', { parents, data: { ...op, bpDelta }, deltas });
      return g2;
    }
    case 'invest': {
      const amount = fx(op.amount);
      const projId = `proj:${op.project}:${op.placeId}`;
      // The project node's causeEventId must point at this very op.invest
      // event. nextId() mints the same id emit() is about to assign, read
      // immediately beforehand with no other emit() call in between.
      const causeEventId = em.nextId();
      const deltas: GraphDelta[] = [
        debitTreasury(g, amount),
        {
          op: 'node.add',
          node: {
            id: projId, type: 'project',
            props: {
              placeId: op.placeId, project: op.project, amount,
              maturesAt: tick + ECON.INVEST_MATURITY_TICKS, matured: false,
              causeEventId, // causal link consumed by the maturity event (T11)
            },
          },
        },
      ];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.invest', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'imprison': {
      const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
      const gid = edgeId('grudge', op.charId, rulerId);
      const existingGrudge = g.edges[gid];
      const curGrudge = typeof existingGrudge?.props['bp'] === 'number' ? (existingGrudge.props['bp'] as number) : 0;
      const eventId = em.nextId();
      const deltas: GraphDelta[] = [{ op: 'node.set', id: op.charId, key: 'imprisoned', value: true }];
      for (const e of edgesFrom(g, op.charId, 'appointment')) deltas.push({ op: 'edge.remove', id: e.id });
      if (existingGrudge) {
        const newBp = clampBp(curGrudge + 2500);
        deltas.push({ op: 'edge.set', id: gid, key: 'bp', value: newBp });
        deltas.push({ op: 'edge.set', id: gid, key: 'log', value: appendAllegianceLog(existingGrudge.props, tick, newBp - curGrudge, eventId) });
      } else {
        const newBp = clampBp(2500);
        deltas.push({
          op: 'edge.add',
          edge: { id: gid, type: 'grudge', src: op.charId, dst: rulerId, props: { bp: newBp, log: [{ tick, deltaBp: newBp, cause: eventId }] } },
        });
      }
      const g2 = applyDeltas(g, deltas);
      em.emit('op.imprison', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'pardon': {
      const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
      const gid = edgeId('grudge', op.charId, rulerId);
      const lid = edgeId('loyalty', op.charId, rulerId);
      const existingGrudge = g.edges[gid];
      const existingLoyalty = g.edges[lid];
      const curGrudge = typeof existingGrudge?.props['bp'] === 'number' ? (existingGrudge.props['bp'] as number) : 0;
      const curLoyalty = typeof existingLoyalty?.props['bp'] === 'number' ? (existingLoyalty.props['bp'] as number) : 5000;
      const eventId = em.nextId();
      const deltas: GraphDelta[] = [{ op: 'node.set', id: op.charId, key: 'imprisoned', value: false }];
      if (existingGrudge) {
        const newBp = clampBp(curGrudge - 1500);
        deltas.push({ op: 'edge.set', id: gid, key: 'bp', value: newBp });
        deltas.push({ op: 'edge.set', id: gid, key: 'log', value: appendAllegianceLog(existingGrudge.props, tick, newBp - curGrudge, eventId) });
      }
      if (existingLoyalty) {
        const newBp = clampBp(curLoyalty + 500);
        deltas.push({ op: 'edge.set', id: lid, key: 'bp', value: newBp });
        deltas.push({ op: 'edge.set', id: lid, key: 'log', value: appendAllegianceLog(existingLoyalty.props, tick, newBp - curLoyalty, eventId) });
      } else {
        const newBp = clampBp(5500);
        deltas.push({
          op: 'edge.add',
          edge: { id: lid, type: 'loyalty', src: op.charId, dst: rulerId, props: { bp: newBp, log: [{ tick, deltaBp: newBp, cause: eventId }] } },
        });
      }
      const g2 = applyDeltas(g, deltas);
      em.emit('op.pardon', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'raise_levy': {
      const size = fx(op.size);
      const deltas: GraphDelta[] = [
        debitTreasury(g, mulFx(size, ECON.LEVY_RAISE_COST)),
        { op: 'node.set', id: op.placeId, key: 'levy', value: propFx(getNode(g, op.placeId).props, 'levy') + size },
      ];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.raise_levy', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'disband_levy': {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: op.placeId, key: 'levy', value: FX_ZERO }];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.disband_levy', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'send_envoy': {
      const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
      const gid = edgeId('grudge', op.charId, rulerId);
      const lid = edgeId('loyalty', op.charId, rulerId);
      const existingGrudge = g.edges[gid];
      const existingLoyalty = g.edges[lid];
      const curGrudge = typeof existingGrudge?.props['bp'] === 'number' ? (existingGrudge.props['bp'] as number) : 0;
      const curLoyalty = typeof existingLoyalty?.props['bp'] === 'number' ? (existingLoyalty.props['bp'] as number) : 5000;
      const eventId = em.nextId();
      const deltas: GraphDelta[] = [];
      if (op.tone === 'conciliatory') {
        if (existingGrudge) {
          const newBp = clampBp(curGrudge - 800);
          deltas.push({ op: 'edge.set', id: gid, key: 'bp', value: newBp });
          deltas.push({ op: 'edge.set', id: gid, key: 'log', value: appendAllegianceLog(existingGrudge.props, tick, newBp - curGrudge, eventId) });
        } else if (existingLoyalty) {
          const newBp = clampBp(curLoyalty + 300);
          deltas.push({ op: 'edge.set', id: lid, key: 'bp', value: newBp });
          deltas.push({ op: 'edge.set', id: lid, key: 'log', value: appendAllegianceLog(existingLoyalty.props, tick, newBp - curLoyalty, eventId) });
        } else {
          const newBp = clampBp(5300);
          deltas.push({
            op: 'edge.add',
            edge: { id: lid, type: 'loyalty', src: op.charId, dst: rulerId, props: { bp: newBp, log: [{ tick, deltaBp: newBp, cause: eventId }] } },
          });
        }
      } else if (op.tone === 'threatening') {
        if (existingGrudge) {
          const newBp = clampBp(curGrudge + 600);
          deltas.push({ op: 'edge.set', id: gid, key: 'bp', value: newBp });
          deltas.push({ op: 'edge.set', id: gid, key: 'log', value: appendAllegianceLog(existingGrudge.props, tick, newBp - curGrudge, eventId) });
        } else {
          const newBp = clampBp(600);
          deltas.push({
            op: 'edge.add',
            edge: { id: gid, type: 'grudge', src: op.charId, dst: rulerId, props: { bp: newBp, log: [{ tick, deltaBp: newBp, cause: eventId }] } },
          });
        }
        if (existingLoyalty) {
          const newBp = clampBp(curLoyalty - 300);
          deltas.push({ op: 'edge.set', id: lid, key: 'bp', value: newBp });
          deltas.push({ op: 'edge.set', id: lid, key: 'log', value: appendAllegianceLog(existingLoyalty.props, tick, newBp - curLoyalty, eventId) });
        }
      }
      // 'firm' changes posture, not state: no deltas, event only.
      const g2 = applyDeltas(g, deltas);
      em.emit('op.send_envoy', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'seize': {
      const amount = fx(op.amount);
      const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
      const gid = edgeId('grudge', op.charId, rulerId);
      const existingGrudge = g.edges[gid];
      const curGrudge = typeof existingGrudge?.props['bp'] === 'number' ? (existingGrudge.props['bp'] as number) : 0;
      const legitimacy = propFx(getNode(g, 'inst:crown').props, 'legitimacy');
      const eventId = em.nextId();
      const deltas: GraphDelta[] = [
        { op: 'node.set', id: op.charId, key: 'wealth', value: propFx(getNode(g, op.charId).props, 'wealth') - amount },
        { op: 'node.set', id: 'inst:crown', key: 'treasury', value: treasury(g) + amount },
      ];
      if (existingGrudge) {
        const newBp = clampBp(curGrudge + 2000);
        deltas.push({ op: 'edge.set', id: gid, key: 'bp', value: newBp });
        deltas.push({ op: 'edge.set', id: gid, key: 'log', value: appendAllegianceLog(existingGrudge.props, tick, newBp - curGrudge, eventId) });
      } else {
        const newBp = clampBp(2000);
        deltas.push({
          op: 'edge.add',
          edge: { id: gid, type: 'grudge', src: op.charId, dst: rulerId, props: { bp: newBp, log: [{ tick, deltaBp: newBp, cause: eventId }] } },
        });
      }
      deltas.push({ op: 'node.set', id: 'inst:crown', key: 'legitimacy', value: clampFx(legitimacy - fx('3'), FX_ZERO, fx('100')) });
      const g2 = applyDeltas(g, deltas);
      em.emit('op.seize', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'hold_festival': {
      const amount = fx(op.amount);
      const unrest = propFx(getNode(g, op.placeId).props, 'unrest');
      const deltas: GraphDelta[] = [
        debitTreasury(g, amount),
        { op: 'node.set', id: op.placeId, key: 'unrest', value: clampFx(unrest - divFx(amount, fx('8')), FX_ZERO, fx('100')) },
      ];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.hold_festival', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'record_stance': {
      // No prior read: the value is written unconditionally, and
      // re-recording the same stanceId is meant to overwrite -- that
      // reversal, visible in the chronicle, IS the consistency probe.
      const deltas: GraphDelta[] = [{ op: 'node.set', id: 'inst:crown', key: 'stance:' + op.stanceId, value: op.value }];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.record_stance', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'vet': {
      // The debit is this op's own effect (spec §9: "applyOp: debit
      // treasury, standard delta+event"). vet's DISTINCTIVE effect -- a
      // fidelity-modulated read of the target's aptitude -- needs Fortune,
      // which applyOp doesn't have (like every op here); it's derived from
      // this landed op.vet event by tick.ts's step 4.5 (see observe.ts's
      // vetObservation), never here.
      const deltas: GraphDelta[] = [debitTreasury(g, VET_COST)];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.vet', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'obscure_records': {
      const deltas: GraphDelta[] = [
        debitTreasury(g, OBSCURE_RECORDS_COST),
        { op: 'node.set', id: 'inst:crown', key: 'counterIntel', value: true },
      ];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.obscure_records', { parents, data: { ...op }, deltas });
      return g2;
    }
  }
}
