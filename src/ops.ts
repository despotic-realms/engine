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
import type { Fortune } from './fortune.js';
import type { Fx } from './fx.js';
import { clampFx, divFx, fx, fxFromInt, fxToString, fxWhole, mulFx, FX_ZERO } from './fx.js';
import type { EdgeType, NodeId, NodeType, PropValue, WorldGraph } from './graph.js';
import { appendAllegianceLog, edgeId, edgesFrom, edgesOfType, edgesTo, findEdge, getNode, nodeIds, propFx, propInt, propStr } from './graph.js';
// Claim §3 (2026-08-20 claim plan): Term's `when` clause reuses match.ts's
// existing (Cmp, evalPredicate) pair verbatim rather than redeclaring a
// second comparator vocabulary -- one-directional import (match.ts imports
// only from graph.ts), so no cycle. `Cmp` is imported as a type only and
// never re-exported from here: index.ts's `export * from './match.js'`
// already carries it, and re-exporting it a second time from ops.ts would
// collide (a barrel can't export the same name from two modules).
import type { Cmp } from './match.js';
import { evalPredicate } from './match.js';
// Claim §2's own closed vocabulary lives in spine.ts (WANT_KEYS/WantKey,
// the same source declarationStep's currentWant reads via systems.ts) --
// pulled in here rather than re-declared so pledge's enum param and
// systems.ts's price-answered check can never drift apart. Runtime-safe
// despite the reverse edge (spine.ts imports `Op` from this very file):
// that import is `import type`, erased before either module exists at
// runtime, so no real import cycle exists, only a type-level one.
import { currentWant, hasTrait, WANT_KEYS } from './spine.js';
import type { WantKey } from './spine.js';
// Claim §3/momentum (2026-08-20 claim plan, Global Constraints): press_claim's
// own nudge application (below) needs the SAME effective-loyalty formula and
// the SAME DECLARE_LOYALTY threshold declarationStep (systems.ts) already
// uses, reused verbatim rather than re-derived a second place -- see
// systems.ts's own export comment on effectiveLoyalty for why the resulting
// import cycle (systems.ts already imports DEED_NAMES/FINGERPRINT_TICKS from
// THIS file) is safe.
import { DECLARE_LOYALTY, effectiveLoyalty } from './systems.js';

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
  | { kind: 'obscure_records' }
  // Renderer-law T2 (debt-mechanism preamble): a loan is a `debt` edge src
  // inst:crown -> dst lender, distinct in SHAPE from the pre-existing liege
  // tribute `debt` edge (thornfield.ts, props { duePerYear } only -- see
  // DEEDS below and systems.ts's debtOverdueStep for how the two shapes
  // coexist without either ever reading/writing the other's props).
  | { kind: 'borrow'; lenderId: string; amount: string; fee: string; dueTicks: number }
  | { kind: 'repay'; lenderId: string }
  // Claim §2 (2026-08-20 claim plan, Global Constraints -- verbatim-binding
  // shape): a binding promise, buying a backer's declaration now against a
  // restoration the ruler doesn't have yet. Direct throne speech (domain:
  // null, like appoint/pardon) -- never mediated (mediate.ts's own
  // `domain === null` skip runs applyOp straight through); no treasury
  // cost. Deliberately excluded from DEEDS/DEED_NAMES below (see that
  // table's own comment for why): the `promise` edge this writes (graph.ts,
  // added in Task 1 as a compile necessity ahead of this op) is itself the
  // gateable fact content reads, not a fingerprint standing in for one.
  | { kind: 'pledge'; charId: string; wantKey: WantKey }
  // Claim §3 (2026-08-20 claim plan, Global Constraints -- verbatim-binding
  // shape): the contested flashpoint roll. Domain: null (direct throne
  // speech, like pledge/appoint/pardon) -- this is the campaign's own
  // climactic decision, never delegated through an office, and it already
  // runs its OWN banding system (below); routing it through mediate.ts's
  // independent willingness/execution-band gauntlet as well would be both
  // redundant and semantically confused about which roll is "the" roll.
  // Season-config access seam (controller-pinned, task-3 brief): validateOp
  // and applyOp both need the season's flashpoints TABLE to do anything
  // with this op (existence check; full resolution respectively), but
  // neither function's prior signature carried anything season-shaped.
  // Resolved the same way the fingerprints wave threaded seatId through the
  // apply chain (ops.ts/mediate.ts/tick.ts) -- see this file's own report
  // for the call-site count and the rejected alternative.
  | { kind: 'press_claim'; flashpointId: string };

export interface OpParamDesc {
  name: string;
  // 'fxNonNeg' differs from 'fx' only at the floor: 'fx' (parseAmount)
  // requires strictly positive ("amount must be positive" -- every prior Fx
  // param is a spend/grant/size that a zero value would make meaningless);
  // 'fxNonNeg' (parseNonNegAmount) allows exactly zero, rejecting only
  // negative -- borrow's `fee` is the first Fx param a legitimate zero
  // value (an interest-free loan) makes sense for.
  // 'flashpointId' parallels 'nodeId': an existence check against an
  // external registry, except the registry is the season's flashpoints
  // table (validateOp's own new parameter, below) rather than the graph.
  type: 'nodeId' | 'fx' | 'fxNonNeg' | 'int' | 'enum' | 'stanceId' | 'flashpointId';
  nodeType?: NodeType;
  min?: number;
  max?: number;
  values?: readonly string[];
}

// Claim §3 (2026-08-20 claim plan, Global Constraints -- verbatim-binding
// shapes). A Term contributes its `bp` toward a flashpoint's scale/opposition
// sum IFF its `when` predicate holds against the CURRENT graph -- computed
// fresh at every press_claim resolution, never stored. The node arm reuses
// match.ts's (Cmp, evalPredicate) pair verbatim (see this file's import
// comment); the edge arm's predicate is bare existence (no `where`, unlike
// match.ts's own EdgePattern) -- the plan's own shape carries no prop
// predicate for it, only the four endpoint/type fields.
export interface Term {
  label: string;
  bp: number;
  when:
    | { nodeId: NodeId; prop: string; cmp: Cmp; value: PropValue }
    | { edgeType: EdgeType; src: NodeId; dst: NodeId };
}

/** The four flashpoint outcome bands, worst to best -- the plan's own listed
 *  order, and the order drawFlashpointBand's cumulative thresholds walk. */
export type FlashpointBand = 'rout' | 'setback' | 'costly' | 'triumph';

// SeasonConfig.flashpoints?: Record<string, FlashpointDef> (tick.ts) is this
// wave's one piece of season-authored data ops.ts itself needs to know the
// shape of -- defined here (not tick.ts) because onBand's Op[] would
// otherwise force tick.ts's SeasonConfig to import the Op union AND because
// applyOp's own resolution (below) is the only code that ever reads a
// FlashpointDef apart from validateOp's existence check; tick.ts imports
// this type from here instead, the same direction it already imports Op/
// applyOp/validateOp.
export interface FlashpointDef {
  opposition: Term[];
  assets: Term[];
  /** Controller-pinned seam (task-3 brief): promoteTo/demoteOnRoutTo never
   *  touch the ladder directly -- press_claim only stamps the crown props
   *  claimPromoteTo/claimDemoteTo (plain tier numbers) that a LATER task's
   *  ladder consumes and clears. Setback never reads either field. */
  decisive?: { promoteTo?: number; demoteOnRoutTo?: number };
  onBand: Record<FlashpointBand, Op[]>;
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
  borrow: {
    summary: 'Borrow from a lender: treasury gains the amount now; a debt obligation is recorded, due in dueTicks ticks.',
    params: [
      { name: 'lenderId', type: 'nodeId' },
      { name: 'amount', type: 'fx' },
      { name: 'fee', type: 'fxNonNeg' },
      { name: 'dueTicks', type: 'int', min: 1 },
    ],
    domain: 'econ',
  },
  repay: {
    summary: 'Repay an outstanding debt to a lender in full (principal + fee); the debt obligation is cleared.',
    params: [{ name: 'lenderId', type: 'nodeId' }],
    domain: 'econ',
  },
  pledge: {
    summary: 'Pledge to a character, naming their current want; honored if the ruler is restored.',
    params: [
      { name: 'charId', type: 'nodeId', nodeType: 'character' },
      { name: 'wantKey', type: 'enum', values: WANT_KEYS },
    ],
    domain: null,
  },
  press_claim: {
    summary: 'Press a campaign flashpoint to resolution: a contested roll against visible and fogged weights.',
    params: [{ name: 'flashpointId', type: 'flashpointId' }],
    domain: null,
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

// The 'fxNonNeg' counterpart to parseAmount above: same shape parse, but
// floors at zero INCLUSIVE rather than requiring strict positivity --
// borrow's `fee` may be exactly '0' (an interest-free loan).
function parseNonNegAmount(v: unknown): Fx | string {
  if (typeof v !== 'string') return 'amount must be a decimal string';
  try {
    const a = fx(v);
    return a < 0n ? 'amount must not be negative' : a;
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

// flashpoints: the season's FlashpointDef table (SeasonConfig.flashpoints,
// tick.ts), needed only by press_claim's own 'flashpointId' param check
// below. Defaults to {} (an optional trailing parameter, not a required
// one) so every EXISTING call site -- three in tick.ts, one in mediate.ts,
// one in storylet.ts's checkDeck, and ~90 across the test suite, none of
// which ever construct a press_claim op -- keeps compiling and passing
// unchanged; only tick.ts's three real call sites (validateDecisions's raw-
// ops loop, resolveTick's attended and default-option loops) pass the real
// season.flashpoints table. See this file's task-3 report for the full
// call-site audit and the rejected alternative (validating flashpointId
// existence only at validateDecisions, which never sees option-bound ops at
// all -- see that report for why this was rejected).
export function validateOp(g: WorldGraph, raw: unknown, flashpoints: Record<string, FlashpointDef> = {}): OpResult {
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
    } else if (p.type === 'fxNonNeg') {
      const a = parseNonNegAmount(v);
      if (typeof a === 'string') return { ok: false, error: a };
    } else if (p.type === 'enum') {
      if (typeof v !== 'string' || !p.values?.includes(v)) return { ok: false, error: `bad '${p.name}'` };
    } else if (p.type === 'stanceId') {
      if (!isStanceId(v)) return { ok: false, error: `bad '${p.name}'` };
    } else if (p.type === 'flashpointId') {
      if (typeof v !== 'string' || !flashpoints[v]) return { ok: false, error: `no such flashpoint '${String(v)}'` };
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
    case 'borrow': {
      const lenderId = op['lenderId'] as string;
      // Review finding (post-approval): inst:crown is type 'institution',
      // so it passes the character-or-institution check below, and no
      // self-loop debt edge exists on a fresh graph, so it passes the
      // existing-debt check too -- without this, a self-loan validated
      // cleanly and was reachable via directive input, inflating treasury
      // with no real counterparty. Mirrors imprison's own self-target
      // precedent above ('the crown cannot imprison itself').
      if (lenderId === 'inst:crown') return { ok: false, error: 'the crown cannot borrow from itself' };
      const lender = getNode(g, lenderId);
      if (lender.type !== 'character' && lender.type !== 'institution')
        return { ok: false, error: 'lender must be a character or institution' };
      // Keys on `settled` (this shape's discriminator, per the debt-
      // mechanism preamble) rather than bare existence -- but `settled` is
      // created `false` and repay REMOVES the edge rather than ever
      // flipping it to `true` (see applyOp's 'repay' arm below), so no LIVE
      // debt edge can ever read settled === true: this rejects on ANY
      // existing debt edge to this lender, ours (settled: false, an
      // outstanding loan) or the pre-existing liege tribute edge
      // (thornfield.ts -- a different shape, no `settled` prop at all, so
      // `!== true` catches it too). That second case isn't just
      // belt-and-braces: edgeId() is keyed on (type, src, dst) alone, so a
      // second addEdge to the same lender would throw a collision error in
      // applyOp regardless -- this turns that crash into an honest
      // validation rejection instead.
      const existing = findEdge(g, 'debt', 'inst:crown', lenderId);
      if (existing && existing.props['settled'] !== true) return { ok: false, error: 'already indebted to that lender' };
      break;
    }
    case 'repay': {
      const existing = findEdge(g, 'debt', 'inst:crown', op['lenderId'] as string);
      // Same settled-keyed discriminator as borrow above, from the other
      // side: a missing edge, or one lacking OUR `settled` prop entirely
      // (the liege edge), both read as "nothing of ours to repay" here --
      // never a thrown error, and never a read of `principal`/`fee` off a
      // props bag that doesn't carry them.
      if (!existing || existing.props['settled'] !== false) return { ok: false, error: 'no unsettled debt to that lender' };
      const total = propFx(existing.props, 'principal') + propFx(existing.props, 'fee');
      if (total > t) return { ok: false, error: 'treasury cannot afford to repay that debt' };
      break;
    }
    case 'pledge': {
      // Claim §2 (Global Constraints, verbatim): "wantKey is the char's
      // CURRENT want (`currentWant`)" -- not merely a real want of theirs
      // somewhere in the chain. Reads the SAME helper declarationStep
      // (systems.ts) checks against, so a pledge that validates here is
      // guaranteed to satisfy that pass's own promise-branch predicate --
      // the two checks structurally cannot drift apart.
      const charId = op['charId'] as string;
      const wantKey = op['wantKey'] as string;
      if (currentWant(g, charId) !== wantKey) return { ok: false, error: `'${wantKey}' is not ${charId}'s current want` };
      // Review finding (post-6ed72f9, controller-adjudicated): a broken
      // promise edge still occupies the (type,src,dst) edge id (graph.ts's
      // edgeId() is keyed on that triplet alone, ignoring props) --
      // applyOp's bare edge.add would collide with it and throw, the exact
      // failure class borrow's own self-loan guard above exists to head
      // off for debt edges. Redemption/replacement of a broken promise is
      // explicitly out of scope (promise-BREAKING mechanics, Global
      // Constraints): a broken promise is a permanent betrayal record,
      // never removed or overwritten here -- so ANY existing promise edge,
      // broken or not, blocks a new pledge to the same character. The two
      // cases get distinguishable errors (declarationStep's own
      // `!== true` reading of "unbroken" still names the boundary between
      // them) so a caller/analyst can tell "already promised" apart from
      // "that promise is already broken".
      const existing = findEdge(g, 'promise', 'inst:crown', charId);
      if (existing) {
        if (existing.props['broken'] === true) return { ok: false, error: "the crown's word to them is already broken" };
        return { ok: false, error: 'an unbroken promise already exists for that character' };
      }
      break;
    }
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

// Causality §2: deed fingerprints. Every consequential op stamps a
// short-lived, ACTOR-VALUED marker on its target -- `recent:<deed>` = the
// acting seat id, `recent:<deed>:at` = tick -- so content can gate reaction
// scenes on actual recent deeds instead of durable stances alone.
// Multiplayer-proofed day one: the stamped VALUE is a SEAT id (never a
// character id), so a future multi-seat world can already tell whose deed
// this was. Closed set, exact strings -- content gates read these verbatim
// (causality plan Global Constraints); DEED_NAMES is the single source of
// truth both this table and systems.ts's decay pass read from.
export const DEED_NAMES = [
  'granted', 'seized', 'envoy-warm', 'envoy-firm', 'envoy-hard', 'audited',
  'appointed', 'imprisoned', 'pardoned', 'vetted',
  'festival', 'invested', 'grain-released', 'grain-bought', 'levy-raised', 'taxed',
  // Renderer-law T2 (debt mechanism): extends the closed set from 16 to 18.
  'borrowed', 'repaid',
] as const;
export type Deed = (typeof DEED_NAMES)[number];

// A fingerprint reads as absent (decay bookkeeping, systems.ts) once
// `tick - at > FINGERPRINT_TICKS`.
export const FINGERPRINT_TICKS = 3;

// op kind -> deed name, for every deed-producing op EXCEPT send_envoy, whose
// deed depends on its own `tone` param rather than a static 1:1 mapping (see
// ENVOY_DEED below) -- the Exclude keeps a stray 'send_envoy' entry here a
// compile error, not a silent dead branch. Every op kind absent from BOTH
// tables never stamps: record_stance/obscure_records by spec exclusion
// (stances are already the durable marker); disband_levy was simply never
// added to the v1 deed vocabulary; pledge (claim §2, 2026-08-20 claim plan)
// is deliberately excluded too -- the `promise` edge it writes is itself
// the gateable fact content reads, not a fingerprint standing in for one.
// press_claim (claim §3) is excluded for the same reason: its own
// claim.flashpoint/claim.betrayed events and the claimPromoteTo/
// claimDemoteTo crown props are already richer, directly-queryable
// gateable facts than a recent:<deed> stamp would add.
export const DEEDS: Partial<Record<Exclude<Op['kind'], 'send_envoy'>, Deed>> = {
  grant: 'granted',
  seize: 'seized',
  audit: 'audited',
  appoint: 'appointed',
  imprison: 'imprisoned',
  pardon: 'pardoned',
  vet: 'vetted',
  hold_festival: 'festival',
  invest: 'invested',
  release_grain: 'grain-released',
  stockpile_grain: 'grain-bought',
  raise_levy: 'levy-raised',
  decree_tax: 'taxed',
  borrow: 'borrowed',
  repay: 'repaid',
};

export const ENVOY_DEED: Record<'conciliatory' | 'firm' | 'threatening', Deed> = {
  conciliatory: 'envoy-warm',
  firm: 'envoy-firm',
  threatening: 'envoy-hard',
};

/** The two deltas a deed-producing arm folds into its OWN delta bundle
 *  (causality §2, D14): recent:<deed> = the deciding seat (actor-valued),
 *  recent:<deed>:at = tick. Always both together, always appended to the
 *  same deltas[] the arm hands to applyDeltas/em.emit -- so replaying the
 *  op's own event alone reproduces the stamp exactly like every other
 *  mutation in this file. */
function stampDeed(targetId: string, deed: Deed, seatId: string, tick: number): GraphDelta[] {
  return [
    { op: 'node.set', id: targetId, key: `recent:${deed}`, value: seatId },
    { op: 'node.set', id: targetId, key: `recent:${deed}:at`, value: tick },
  ];
}

// Claim §3: flashpoint resolution helpers, kept as small top-level pure
// functions (mirrors bands.ts's own bandWeights/drawBand split) so applyOp's
// 'press_claim' case below reads as orchestration, not arithmetic.

/** A Term's predicate, evaluated against the CURRENT graph. A referenced
 *  node that doesn't exist yet (an asset fact no scene has set) reads as
 *  "does not hold" rather than throwing -- the same "absent means false"
 *  idiom evalPredicate itself already uses for an absent PROP, extended
 *  here to an absent NODE: a Term is a fact that may or may not exist yet,
 *  never a guaranteed-present one. */
function termHolds(g: WorldGraph, when: Term['when']): boolean {
  if ('nodeId' in when) {
    const node = g.nodes[when.nodeId];
    return node !== undefined && evalPredicate(node.props, { prop: when.prop, cmp: when.cmp, value: when.value });
  }
  return findEdge(g, when.edgeType, when.src, when.dst) !== undefined;
}

function sumTrueTerms(g: WorldGraph, terms: readonly Term[]): number {
  let total = 0;
  for (const t of terms) if (termHolds(g, t.when)) total += t.bp;
  return total;
}

// False stone (claim plan, Global Constraints): TREACHERY_BP is the
// TRUE-loyalty ceiling below which a backer becomes betrayal-eligible
// (subject to the second AND-condition leg below) -- exported so tests can
// cite it by name, mirroring systems.ts's own DECLARE_LOYALTY export.
export const TREACHERY_BP = 3500;

// Controller-pinned seam (task-3 brief): mirrors mediate.ts's loyaltyBp()
// canonical edge-read EXCEPT the missing-edge default. loyaltyBp() defaults
// an absent loyalty edge to neutral 5000 -- correct for willingness
// scoring, where "no edge yet" really can mean neutral. WRONG here: a
// backing edge (Task 1) is only ever created for a character who HELD a
// real loyalty edge to the ruler at declaration time, so a loyalty edge
// absent NOW means it was REMOVED since declaration -- the exact shape of
// the T1 bug (a departed defector's absent edge silently reading as
// neutral-or-better). Reading a gone edge as 0 here means a character with
// no live loyalty tie at all is always false-stone-eligible on this first
// AND-condition leg (0 < TREACHERY_BP unconditionally), gated only by the
// second leg (grudge/cunning/vengeful) below -- never resurrecting the old
// default-masks-defection failure mode. When the edge DOES exist, its own
// bp is read verbatim (falling back to 5000 only if that LIVE edge's own
// `bp` prop is itself malformed -- a narrower, much rarer case than "no
// edge at all").
function trueLoyaltyForBetrayal(g: WorldGraph, charId: string, rulerId: string): number {
  const e = findEdge(g, 'loyalty', charId, rulerId);
  if (!e) return 0;
  return typeof e.props['bp'] === 'number' ? (e.props['bp'] as number) : 5000;
}

function isFalseStone(g: WorldGraph, charId: string, rulerId: string): boolean {
  if (trueLoyaltyForBetrayal(g, charId, rulerId) >= TREACHERY_BP) return false;
  return findEdge(g, 'grudge', charId, rulerId) !== undefined || hasTrait(g, charId, 'cunning') || hasTrait(g, charId, 'vengeful');
}

// Momentum (claim §3, Global Constraints): the effective-loyalty floor a
// circle character's score must clear to become sway-eligible ("waverer")
// -- paired with DECLARE_LOYALTY (systems.ts) as the OTHER end of the same
// half-open band [WAVERER_FLOOR, DECLARE_LOYALTY). Exported so tests can
// cite it by name, mirroring TREACHERY_BP/DECLARE_LOYALTY's own precedent.
export const WAVERER_FLOOR = 4000;

// A "waverer" (claim §3, Global Constraints): a claim-circle character (the
// SAME claimCircle===true AND claimBp:number AND declarationStep itself
// uses) with no backing edge yet, not imprisoned (a cell is not a court --
// mirrors declarationStep's own exclusion; nudging one toward a declaration
// it could never make anyway would be inert, just untidy, to leave
// unguarded), holding a REAL loyalty edge to the ruler (mirrors
// declarationStep's other exclusion -- no edge, no default-to-neutral
// qualification, the same false-stone-from-a-rival-court hole T1 closed for
// declaring itself), whose EFFECTIVE loyalty (systems.ts's own exported
// helper, reused verbatim rather than re-derived) sits in [WAVERER_FLOOR,
// DECLARE_LOYALTY).
//
// Declared backers (a live `backing` edge) are handled separately at each
// press_claim call site below, not folded into this predicate: the two
// populations are mutually exclusive by construction (a waverer has no
// backing edge; a declared backer does), and only ONE of them is ever
// eligible for the +800 leg (waverers only) while BOTH are eligible for the
// -400 leg -- a single boolean here reused identically for both callers
// keeps that asymmetry visible at the call site instead of hidden inside a
// combined predicate.
function isWaverer(g: WorldGraph, charId: string, rulerId: string): boolean {
  const node = getNode(g, charId);
  if (node.type !== 'character') return false;
  if (node.props['claimCircle'] !== true) return false;
  if (typeof node.props['claimBp'] !== 'number') return false;
  if (node.props['imprisoned'] === true) return false;
  if (findEdge(g, 'backing', charId, 'inst:crown')) return false;
  const loyaltyEdge = findEdge(g, 'loyalty', charId, rulerId);
  if (!loyaltyEdge) return false;
  const trueLoyalty = typeof loyaltyEdge.props['bp'] === 'number' ? (loyaltyEdge.props['bp'] as number) : 5000;
  const eff = effectiveLoyalty(g, charId, trueLoyalty);
  return eff >= WAVERER_FLOOR && eff < DECLARE_LOYALTY;
}

/** Per-mille ratio r = floor(trueScale*1000 / max(opposition,1)) (Global
 *  Constraints), via the SAME hand-rolled integer idiom hold_festival's own
 *  unrest-easing calc already uses in this file (divFx on plain integers
 *  lifted into Fx space through fxFromInt) -- ops.ts carries no bare `/`
 *  anywhere (check-no-float's DIVIDE_ALLOW list excludes this file). Exact,
 *  not approximate: for non-negative integers X, D, S, floorDiv(floorDiv(X*S,
 *  D), S) == floorDiv(X, D) always (X = q*D + rem with 0<=rem<D gives
 *  floorDiv(X*S,D) = q*S + floor(rem*S/D) with the second term in [0,S), so
 *  dividing back out by S recovers q exactly) -- so lifting through Fx's
 *  scale-10000 representation never perturbs the integer result. */
function flashpointRatio(trueScale: number, opposition: number): number {
  const oppositionSafe = opposition > 0 ? opposition : 1; // max(opposition, 1)
  const trueScaleSafe = trueScale > 0 ? trueScale : 0;
  const ratioFx = divFx(fxFromInt(trueScaleSafe * 1000), fxFromInt(oppositionSafe));
  return Number(fxWhole(ratioFx));
}

// Band rows (claim plan, Global Constraints, verbatim per-mille table),
// scanned in descending minR order -- the first row r clears wins.
const FLASHPOINT_BAND_ROWS: ReadonlyArray<{ minR: number; rout: number; setback: number; costly: number; triumph: number }> = [
  { minR: 1500, rout: 50, setback: 150, costly: 500, triumph: 300 },
  { minR: 1000, rout: 100, setback: 250, costly: 450, triumph: 200 },
  { minR: 600, rout: 250, setback: 350, costly: 300, triumph: 100 },
  { minR: 0, rout: 450, setback: 350, costly: 180, triumph: 20 },
];

function bandRowFor(r: number): { rout: number; setback: number; costly: number; triumph: number } {
  for (const row of FLASHPOINT_BAND_ROWS) if (r >= row.minR) return row;
  throw new Error(`bandRowFor: unreachable for r=${r}`); // last row's minR is 0; r is never negative (flashpointRatio floors at 0)
}

// One draw -- bands.ts's own drawBand idiom (cumulative per-mille
// thresholds over a single fortune.int(0,999) roll), worst-to-best order.
// Rows sum to exactly 1000 by construction (the pinned table above), so the
// loop always returns before falling through; the trailing return exists
// only for type-safety, mirroring drawBand's own trailing `return BANDS[3]!`.
function drawFlashpointBand(
  row: { rout: number; setback: number; costly: number; triumph: number },
  fortune: Fortune,
  tick: number,
  flashpointId: string,
): FlashpointBand {
  const roll = fortune.int('flashpoint', tick, flashpointId, 0, 999); // [0, 1000)
  const order: ReadonlyArray<readonly [FlashpointBand, number]> = [
    ['rout', row.rout],
    ['setback', row.setback],
    ['costly', row.costly],
    ['triumph', row.triumph],
  ];
  let acc = 0;
  for (const [band, w] of order) {
    acc += w;
    if (roll < acc) return band;
  }
  return 'triumph';
}

// seatId: the DECIDING seat (causality §2) -- decisions carry seatId
// (tick.ts's TickDecisions), threaded here through applyOpWithWants and
// applyMediatedOp so every deed-producing arm below can stamp its target
// with WHO decided this, never with the mediated executor character (see
// mediate.ts's applyMediatedOp, which forwards its own received seatId
// unchanged). No default: a fingerprint's actor must always be a real,
// explicit value -- see this file's report for the full call-site wiring.
//
// flashpoints/fortune (claim §3, task-3 controller-pinned seam): press_claim
// is the first op whose OWN resolution needs season data and a fortune draw
// INSIDE applyOp itself -- every op before it either needs neither, or (vet)
// defers its fortune-consuming half to a later resolveTick phase entirely
// outside applyOp. Both are optional trailing parameters defaulting to
// "absent" ({} / undefined) so the ~90 existing call sites across this
// suite's tests, none of which ever construct a press_claim op, keep
// compiling and passing unchanged; only the real apply chain (mediate.ts's
// applyMediatedOp, tick.ts's applyOpWithWants) forwards the season's real
// table and the tick's real Fortune instance. A press_claim op reaching this
// function with `fortune` still undefined is a wiring bug upstream (that
// chain always has a live Fortune by construction) and throws rather than
// silently no-op'ing -- see the 'press_claim' case below.
export function applyOp(
  g: WorldGraph, op: Op, tick: number, em: Emitter, seatId: string, parents: string[] = [],
  flashpoints: Record<string, FlashpointDef> = {}, fortune?: Fortune,
): WorldGraph {
  switch (op.kind) {
    case 'decree_tax': {
      const deltas: GraphDelta[] = [
        { op: 'node.set', id: op.placeId, key: 'taxRateBp', value: op.rateBp },
        ...stampDeed(op.placeId, 'taxed', seatId, tick),
      ];
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
        ...stampDeed(op.placeId, 'grain-released', seatId, tick),
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
        ...stampDeed(op.placeId, 'grain-bought', seatId, tick),
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
      deltas.push(...stampDeed(op.charId, 'appointed', seatId, tick));
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
      // 'audited' is the fact of the audit, not its outcome -- stamps the
      // holder unconditionally, whether or not skimming was found above.
      deltas.push(...stampDeed(holder.src, 'audited', seatId, tick));
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
      deltas.push(...stampDeed(op.charId, 'granted', seatId, tick));
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
        ...stampDeed(op.placeId, 'invested', seatId, tick),
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
      deltas.push(...stampDeed(op.charId, 'imprisoned', seatId, tick));
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
      deltas.push(...stampDeed(op.charId, 'pardoned', seatId, tick));
      const g2 = applyDeltas(g, deltas);
      em.emit('op.pardon', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'raise_levy': {
      const size = fx(op.size);
      const deltas: GraphDelta[] = [
        debitTreasury(g, mulFx(size, ECON.LEVY_RAISE_COST)),
        { op: 'node.set', id: op.placeId, key: 'levy', value: propFx(getNode(g, op.placeId).props, 'levy') + size },
        ...stampDeed(op.placeId, 'levy-raised', seatId, tick),
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
      // 'firm' moves no relationship edge -- but every tone still stamps its
      // own fingerprint (envoy-warm/envoy-firm/envoy-hard, ENVOY_DEED[op.tone]),
      // so 'firm' is no longer a zero-delta contract: exactly the two stamp
      // deltas below are its entire effect.
      deltas.push(...stampDeed(op.charId, ENVOY_DEED[op.tone], seatId, tick));
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
      deltas.push(...stampDeed(op.charId, 'seized', seatId, tick));
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
        ...stampDeed(op.placeId, 'festival', seatId, tick),
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
      const deltas: GraphDelta[] = [debitTreasury(g, VET_COST), ...stampDeed(op.charId, 'vetted', seatId, tick)];
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
    case 'borrow': {
      const amount = fx(op.amount);
      const fee = fx(op.fee);
      const deltas: GraphDelta[] = [
        // Credits the crown -- mirrors seize's symmetric credit (ops.ts's
        // only other treasury INFLOW); debitTreasury exists for the
        // opposite direction only, so this writes the node.set directly.
        { op: 'node.set', id: 'inst:crown', key: 'treasury', value: treasury(g) + amount },
        {
          op: 'edge.add',
          edge: {
            id: edgeId('debt', 'inst:crown', op.lenderId),
            type: 'debt', src: 'inst:crown', dst: op.lenderId,
            props: { principal: amount, fee, dueTick: tick + op.dueTicks, settled: false, overdueEmitted: false },
          },
        },
        ...stampDeed(op.lenderId, 'borrowed', seatId, tick),
      ];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.borrow', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'repay': {
      const eid = edgeId('debt', 'inst:crown', op.lenderId);
      const existing = findEdge(g, 'debt', 'inst:crown', op.lenderId);
      if (!existing) throw new Error('applyOp: repay with no debt edge (validate first)');
      const principal = propFx(existing.props, 'principal');
      const fee = propFx(existing.props, 'fee');
      const total = principal + fee;
      const deltas: GraphDelta[] = [
        { op: 'node.set', id: 'inst:crown', key: 'treasury', value: treasury(g) - total },
        // Settlement IS the edge's removal, never a `settled: true` flip
        // (debt-mechanism preamble) -- so the same lender can be borrowed
        // from again later with a clean edgeId(), and the overdue pass
        // (systems.ts) never has to consider a "settled but still present"
        // state at all.
        { op: 'edge.remove', id: eid },
        ...stampDeed(op.lenderId, 'repaid', seatId, tick),
      ];
      const g2 = applyDeltas(g, deltas);
      // Review addition (post-approval): an edge.remove delta carries no
      // prop snapshot -- principal/fee are gone from the graph the instant
      // this event lands, so without spreading them into data they'd be
      // unrecoverable from the chronicle alone. Mirrors op.audit's own
      // computed-data precedent (found/skimmed/holder spread alongside
      // {...op} above).
      em.emit('op.repay', { parents, data: { ...op, principal: fxToString(principal), fee: fxToString(fee), total: fxToString(total) }, deltas });
      return g2;
    }
    case 'pledge': {
      // The op's ENTIRE effect is this one edge.add (D14: delta-complete) --
      // no treasury cost, no stampDeed (pledge is deliberately excluded
      // from DEEDS, see that table's own comment above): the promise edge
      // itself is the gateable fact content and declarationStep read, not a
      // fingerprint standing in for one.
      const deltas: GraphDelta[] = [{
        op: 'edge.add',
        edge: {
          id: edgeId('promise', 'inst:crown', op.charId),
          type: 'promise', src: 'inst:crown', dst: op.charId,
          props: { wantKey: op.wantKey, madeAt: tick, dueOn: 'restoration', broken: false },
        },
      }];
      const g2 = applyDeltas(g, deltas);
      em.emit('op.pledge', { parents, data: { ...op }, deltas });
      return g2;
    }
    case 'press_claim': {
      const def = flashpoints[op.flashpointId];
      if (!def) throw new Error(`applyOp: press_claim on unknown flashpoint '${op.flashpointId}' (validate first)`);
      if (!fortune) throw new Error('applyOp: press_claim requires a Fortune instance (wire it through the apply chain -- validate first)');
      const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');

      // Σ declared backing bp + the false-stone subset, in one sorted-order
      // pass (edgesOfType is already sorted by edge id) -- `falseStones`
      // below is fixed here, BEFORE the fortune draw or any onBand op can
      // touch the graph, so betrayal always unmasks off this exact
      // pre-resolution snapshot.
      let backingSum = 0;
      let falseStoneBp = 0;
      const falseStones: Array<{ edgeId: string; charId: string; bp: number }> = [];
      for (const e of edgesOfType(g, 'backing')) {
        const bp = propInt(e.props, 'bp');
        backingSum += bp;
        if (isFalseStone(g, e.src, rulerId)) {
          falseStoneBp += bp;
          falseStones.push({ edgeId: e.id, charId: e.src, bp });
        }
      }
      const assetSum = sumTrueTerms(g, def.assets);
      const visibleScale = backingSum + assetSum;
      const trueScaleRaw = visibleScale - falseStoneBp;
      const trueScale = trueScaleRaw > 0 ? trueScaleRaw : 0;
      const opposition = sumTrueTerms(g, def.opposition);
      const r = flashpointRatio(trueScale, opposition);
      const band = drawFlashpointBand(bandRowFor(r), fortune, tick, op.flashpointId);

      // Controller-pinned seam (task-3 brief): decisive outcomes stamp crown
      // props inside the flashpoint's OWN deltas -- applied and chronicled
      // on claim.flashpoint BEFORE onBand ops run below, so an onBand op
      // that (hypothetically) also touched claimPromoteTo/claimDemoteTo
      // would apply strictly afterward and win any conflict (documented,
      // not tested: no op in the current vocabulary touches either prop).
      // Setback reads neither field, on any FlashpointDef.
      const decisiveDeltas: GraphDelta[] = [];
      if ((band === 'triumph' || band === 'costly') && def.decisive?.promoteTo !== undefined) {
        decisiveDeltas.push({ op: 'node.set', id: 'inst:crown', key: 'claimPromoteTo', value: def.decisive.promoteTo });
      }
      if (band === 'rout' && def.decisive?.demoteOnRoutTo !== undefined) {
        decisiveDeltas.push({ op: 'node.set', id: 'inst:crown', key: 'claimDemoteTo', value: def.decisive.demoteOnRoutTo });
      }
      let g2 = applyDeltas(g, decisiveDeltas);
      const flashpointEvent = em.emit('claim.flashpoint', {
        parents,
        data: { flashpointId: op.flashpointId, band, visibleScale, trueScale, opposition },
        deltas: decisiveDeltas,
      });

      // onBand ops: each individually validated against the post-decisive
      // graph; a reject is skipped (op.rejected) rather than aborting the
      // rest of the band's effects. Applied via plain applyOp (not tick.ts's
      // want-advancing applyOpWithWants, which this file cannot import
      // without a cycle) -- an onBand op's own deltas land, but it does not
      // itself trigger want advancement; see this file's task-3 report.
      for (const bandOp of def.onBand[band]) {
        const check = validateOp(g2, bandOp, flashpoints);
        if (!check.ok) {
          em.emit('op.rejected', { parents: [flashpointEvent.id], data: { opKind: bandOp.kind, op: bandOp, error: check.error, via: 'onBand' } });
          continue;
        }
        g2 = applyOp(g2, check.op, tick, em, seatId, [flashpointEvent.id], flashpoints, fortune);
      }

      // Betrayal (rout/setback only, and only when a false stone exists):
      // the LARGEST-bp false stone from the pre-resolution snapshot above,
      // tie-broken by ascending edge id (this file's general sorted-
      // ascending convention for deterministic ties) -- unmasked: backing
      // edge removed, grudge kindled-or-incremented by 2000 (the exact
      // kindle-or-increment idiom imprison/seize use above, reused
      // verbatim), the reason log citing claim.betrayed's own
      // self-referential event id as cause (nextId()-then-emit, no other
      // emit() call landing in between).
      if ((band === 'rout' || band === 'setback') && falseStones.length > 0) {
        const sorted = [...falseStones].sort((a, b) => (b.bp !== a.bp ? b.bp - a.bp : a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
        const target = sorted[0]!;
        const gid = edgeId('grudge', target.charId, rulerId);
        const existingGrudge = g2.edges[gid];
        const curGrudge = typeof existingGrudge?.props['bp'] === 'number' ? (existingGrudge.props['bp'] as number) : 0;
        const betrayedEventId = em.nextId();
        const betrayalDeltas: GraphDelta[] = [{ op: 'edge.remove', id: target.edgeId }];
        if (existingGrudge) {
          const newBp = clampBp(curGrudge + 2000);
          betrayalDeltas.push({ op: 'edge.set', id: gid, key: 'bp', value: newBp });
          betrayalDeltas.push({ op: 'edge.set', id: gid, key: 'log', value: appendAllegianceLog(existingGrudge.props, tick, newBp - curGrudge, betrayedEventId) });
        } else {
          const newBp = clampBp(2000);
          betrayalDeltas.push({
            op: 'edge.add',
            edge: { id: gid, type: 'grudge', src: target.charId, dst: rulerId, props: { bp: newBp, log: [{ tick, deltaBp: newBp, cause: betrayedEventId }] } },
          });
        }
        g2 = applyDeltas(g2, betrayalDeltas);
        em.emit('claim.betrayed', { parents: [flashpointEvent.id], data: { charId: target.charId }, deltas: betrayalDeltas });
      }

      // Momentum (claim §3, Global Constraints): a flashpoint's outcome
      // sways hearts still undecided. Lives AFTER betrayal above --
      // deliberately: an unmasked false stone this same resolution already
      // lost its backing edge and paid its own, harsher, price (grudge
      // +2000); it must not ALSO eat the -400 momentum penalty a moment
      // later, so declaredBackers below is read off g2 as betrayal LEFT it,
      // never the pre-resolution snapshot betrayal itself reads. waverers is
      // likewise read off g2's final state throughout -- no onBand op in the
      // current vocabulary touches claimCircle/claimBp/loyalty/imprisoned,
      // but nothing here assumes that will always stay true.
      //
      // One additional event, `claim.swayed`, parented to the flashpoint
      // event alone (D14 cleanliness: the chronicle separates the roll
      // itself from its social aftershock, rather than growing
      // claim.flashpoint's own data with a second, unrelated concern) --
      // never emitted when nobody actually qualifies (fingerprintDecayStep's
      // own "no fades, no event" precedent, systems.ts). `direction` names
      // which way THIS batch moved: 'toward' only ever accompanies the
      // waverers-only +800 leg; 'away' accompanies the declared-backers-
      // plus-waverers -400 leg -- the two legs never fire on the same
      // resolution (a band is exactly one of triumph/costly/rout/setback),
      // so one direction per event is always exact, never a summary of a
      // mix.
      //
      // Every write here is a plain node.set (never an increment): the SAME
      // character nudged by a second flashpoint before decay clears the
      // first OVERWRITES, never stacks (Global Constraints, verbatim: "a
      // nudge never stacks with itself") -- and since a waverer (no backing
      // edge, isWaverer's own first gate) and a declared backer (has one)
      // are mutually exclusive by construction, declaredBackers and
      // waverers below can never name the same character twice either, so a
      // plain concat+sort (no dedup) is exact.
      if (band === 'triumph' || band === 'costly') {
        const waverers = nodeIds(g2).filter((id) => isWaverer(g2, id, rulerId));
        if (waverers.length > 0) {
          const nudgeDeltas: GraphDelta[] = waverers.flatMap((charId): GraphDelta[] => [
            { op: 'node.set', id: charId, key: 'claimNudge', value: 800 },
            { op: 'node.set', id: charId, key: 'claimNudgeAt', value: tick },
          ]);
          g2 = applyDeltas(g2, nudgeDeltas);
          em.emit('claim.swayed', { parents: [flashpointEvent.id], data: { charIds: waverers, direction: 'toward' }, deltas: nudgeDeltas });
        }
      } else if (band === 'rout' || band === 'setback') {
        // declaredBackers is intentionally NOT filtered by `imprisoned`, an
        // asymmetry with isWaverer's own exclusion worth naming: isWaverer
        // excludes an imprisoned character because nudging them TOWARD a
        // declaration a cell would block anyway is inert, so the exclusion
        // costs nothing. A declared backer already declared -- imprisoning
        // them afterward doesn't retract that fact (only departure's own
        // backing-edge removal does), so their momentum souring alongside
        // every other backer's is the correct read, not a case needing the
        // same guard.
        const declaredBackers = edgesOfType(g2, 'backing').map((e) => e.src);
        const waverers = nodeIds(g2).filter((id) => isWaverer(g2, id, rulerId));
        const affected = [...declaredBackers, ...waverers].sort();
        if (affected.length > 0) {
          const nudgeDeltas: GraphDelta[] = affected.flatMap((charId): GraphDelta[] => [
            { op: 'node.set', id: charId, key: 'claimNudge', value: -400 },
            { op: 'node.set', id: charId, key: 'claimNudgeAt', value: tick },
          ]);
          g2 = applyDeltas(g2, nudgeDeltas);
          em.emit('claim.swayed', { parents: [flashpointEvent.id], data: { charIds: affected, direction: 'away' }, deltas: nudgeDeltas });
        }
      }

      return g2;
    }
  }
}
