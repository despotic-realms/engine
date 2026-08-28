// Deterministic systemic resolution (spec §6.1): local graph rewrites per
// tick, fortune only where D21 allows it (world outcomes). Season shape:
// tick % 4 → 0 spring, 1 summer, 2 autumn (harvest), 3 winter (tribute).
//
// D14: chronicle events ARE graph deltas -- the same discipline ops.ts
// applies to player-issued ops applies here to the systemic tick step.
// Every mutation below is built as a GraphDelta[], applied through
// applyDeltas (the same function a replay would use), and handed to the
// emitted event as its `deltas` -- so the graph economyStep returns and the
// graph a replay would reconstruct from the chronicle can never drift
// apart. See test/systems.test.ts's "delta-equivalence" suite, which proves
// this by replaying every event's deltas independently and hashing the
// result against economyStep's actual return value.
import { ECON } from './constants.js';
import { applyDeltas } from './events.js';
import type { Emitter, GraphDelta } from './events.js';
import { clampFx, divFx, fx, fxFromInt, fxToString, fxWhole, mulFx, FX_ONE, FX_ZERO } from './fx.js';
import type { Fortune } from './fortune.js';
import type { WorldGraph } from './graph.js';
import { appendAllegianceLog, edgeId, edgesFrom, edgesOfType, edgesTo, findEdge, foldAllegianceDrift, getNode, nodeIds, nodesOfType, propFx, propInt, propStr, setEdgeProp, setNodeProp } from './graph.js';
import { DEED_NAMES, FINGERPRINT_TICKS } from './ops.js';
import { currentWant } from './spine.js';

const UNREST_MAX = fx('100');

export function economyStep(g0: WorldGraph, tick: number, fortune: Fortune, em: Emitter): WorldGraph {
  let g = g0;

  // 1. Project maturity (sorted project ids — order-stable).
  for (const proj of nodesOfType(g, 'project')) {
    if (propInt(proj.props, 'maturesAt') !== tick || proj.props['matured'] === true) continue;
    const placeId = propStr(proj.props, 'placeId');
    const kind = propStr(proj.props, 'project');
    const place = getNode(g, placeId);
    const deltas: GraphDelta[] = [];
    if (kind === 'irrigation') {
      deltas.push({ op: 'node.set', id: placeId, key: 'farmland', value: mulFx(propFx(place.props, 'farmland'), fx('1.2')) });
    }
    if (kind === 'roads') {
      deltas.push({ op: 'node.set', id: placeId, key: 'roadsBonusBp', value: propInt(place.props, 'roadsBonusBp') + 500 });
    }
    if (kind === 'walls') {
      deltas.push({ op: 'node.set', id: placeId, key: 'defenseBp', value: propInt(place.props, 'defenseBp') + 1500 });
    }
    deltas.push({ op: 'node.set', id: proj.id, key: 'matured', value: true });
    g = applyDeltas(g, deltas);
    const cause = proj.props['causeEventId'];
    em.emit('project.matured', {
      parents: typeof cause === 'string' ? [cause] : [],
      deltas,
      data: { projectId: proj.id, project: kind, placeId },
    });
  }

  for (const place of nodesOfType(g, 'place')) {
    const id = place.id;
    const p = () => getNode(g, id).props;

    // 2. Harvest + tax (autumn).
    if (tick % 4 === 2) {
      const bp = fortune.bp('harvest', tick, id);
      let mult = BigInt(5000 + bp); // 0.5x .. 1.4999x as Fx
      if (propInt(p(), 'famineStage') > 0) mult = mulFx(mult, fx('0.3'));
      const yieldFx = mulFx(mulFx(propFx(p(), 'farmland'), ECON.BASE_YIELD), mult);
      const taxGrain = mulFx(yieldFx, BigInt(propInt(p(), 'taxRateBp')));
      const income = mulFx(mulFx(taxGrain, ECON.GRAIN_PRICE), BigInt(10_000 + propInt(p(), 'roadsBonusBp')));
      const rate = propInt(p(), 'taxRateBp');
      const deltas: GraphDelta[] = [
        { op: 'node.set', id, key: 'granary', value: propFx(p(), 'granary') + yieldFx - taxGrain },
        { op: 'node.set', id: 'inst:crown', key: 'treasury', value: propFx(getNode(g, 'inst:crown').props, 'treasury') + income },
      ];
      if (rate > 2500) {
        const sting = divFx(fxFromInt(rate - 2500), fx('100'));
        deltas.push({ op: 'node.set', id, key: 'unrest', value: clampFx(propFx(p(), 'unrest') + sting, FX_ZERO, UNREST_MAX) });
      }
      g = applyDeltas(g, deltas);
      em.emit('harvest.reaped', {
        deltas,
        data: { placeId: id, stream: 'harvest', bp, yield: fxToString(yieldFx), taxGrain: fxToString(taxGrain), income: fxToString(income) },
      });
    }

    // 3. Consumption: dole feeds first, then the granary; shortfall bites.
    // Three possible events, in this order: dole.distributed (relief, only
    // if dole had anything in it), granary.consumed (the baseline drain --
    // always chronicled, since a silent mutation here would leave the
    // chronicle unable to describe a famine visually -- and the vehicle
    // for every shortfall tick's unrest reaction AND deathsCarry write,
    // whether or not this tick crosses a whole person), famine.starvation
    // (only once a shortfall's accumulated attrition crosses a whole
    // person -- see the comment at its own call site).
    const need = mulFx(propFx(p(), 'population'), ECON.CONSUME_PER_POP);
    const dole = propFx(p(), 'dole');
    const fromDole = dole > need ? need : dole;
    const remaining = need - fromDole;
    if (fromDole > 0n) {
      const doleDeltas: GraphDelta[] = [
        { op: 'node.set', id, key: 'dole', value: FX_ZERO },
        { op: 'node.set', id, key: 'unrest', value: clampFx(propFx(p(), 'unrest') - divFx(fromDole, fx('4')), FX_ZERO, UNREST_MAX) },
      ];
      g = applyDeltas(g, doleDeltas);
      em.emit('dole.distributed', { deltas: doleDeltas, data: { placeId: id, amount: fxToString(fromDole) } });
    }
    const granary = propFx(p(), 'granary');
    const newGranary = granary > remaining ? granary - remaining : FX_ZERO;
    const consumed = granary - newGranary;
    const shortfall = remaining > granary ? remaining - granary : FX_ZERO;
    const consumeDeltas: GraphDelta[] = [{ op: 'node.set', id, key: 'granary', value: newGranary }];
    // Unrest reacts to shortfall on EVERY such tick, independent of
    // whether a death crossing lands this tick -- exactly the v0.3.1
    // behavior, deliberately preserved (controller adjudication,
    // 2026-08-16: the product decision below changed death REPORTING, not
    // unrest dynamics). Formula unchanged; it now rides on
    // granary.consumed's deltas rather than famine.starvation's, since it
    // must fire every shortfall tick and famine.starvation does not.
    //
    // Deaths accumulator (product decision 2026-08-16: famine deaths are
    // reported in WHOLE PEOPLE, accumulated -- no fractional corpses
    // anywhere player/chronicle-visible, ever again). Attrition math stays
    // continuous (fx) internally, folded into a per-place `deathsCarry` fx
    // prop: created on first use (propFx would throw on the absent prop,
    // and a place that's never gone hungry is the common case, not an
    // error -- the same zero-default idiom as ops.ts's wealthOf) and
    // delta'd like any prop (D14: internal bookkeeping, but it lives on
    // the graph so replay reproduces it). Like unrest above, the write
    // rides on granary.consumed's own deltas -- the one event in this
    // consumption pass that already fires every tick attrition can be
    // nonzero, whether or not THIS tick crosses a whole person -- rather
    // than inventing a new event type for the sub-death case: a tick that
    // doesn't cross leaves no famine.starvation trace at all, by design
    // (hunger without a death is mood/shortfall texture -- carried by
    // unrest's own reaction above, not a new mechanism).
    let deaths = 0; // whole persons this tick; nonzero only if the carry below crosses FX_ONE
    if (shortfall > 0n) {
      const unrestDelta = mulFx(divFx(shortfall, need), fx('25'));
      consumeDeltas.push({ op: 'node.set', id, key: 'unrest', value: clampFx(propFx(p(), 'unrest') + unrestDelta, FX_ZERO, UNREST_MAX) });

      const carryProp = p()['deathsCarry'];
      const carryBefore = typeof carryProp === 'bigint' ? carryProp : FX_ZERO;
      const attrition = mulFx(divFx(shortfall, ECON.CONSUME_PER_POP), fx('0.05'));
      const carryAccum = carryBefore + attrition;
      deaths = carryAccum >= FX_ONE ? Number(fxWhole(carryAccum)) : 0;
      const carryAfter = deaths > 0 ? carryAccum - fxFromInt(deaths) : carryAccum;
      consumeDeltas.push({ op: 'node.set', id, key: 'deathsCarry', value: carryAfter });
    }
    g = applyDeltas(g, consumeDeltas);
    em.emit('granary.consumed', { deltas: consumeDeltas, data: { placeId: id, amount: fxToString(consumed) } });
    // Ride-along (T1 review minor): negative population is unreachable
    // today only because population has a single writer -- this block --
    // that always subtracts a whole-person count bounded by the carry
    // invariant above (carryBefore is always < FX_ONE by construction, and
    // attrition is bounded by this tick's own shortfall, itself bounded by
    // `need` = population * CONSUME_PER_POP). Any future SECOND writer
    // (migration, plague, ...) must re-examine this -- the decrement below
    // does not clamp at zero itself.
    if (deaths > 0) {
      const famineDeltas: GraphDelta[] = [
        { op: 'node.set', id, key: 'population', value: propFx(p(), 'population') - fxFromInt(deaths) },
      ];
      g = applyDeltas(g, famineDeltas);
      // `deaths` is a plain integer (never an fx-string) -- the whole
      // point of the accumulator; `shortfall` stays fx-string, as it
      // always has, since it's a ledger quantity content may still use,
      // not a person count (the renderer never prints it raw).
      em.emit('famine.starvation', { deltas: famineDeltas, data: { placeId: id, shortfall: fxToString(shortfall), deaths } });
    }
  }

  // 4. Steward skim (hidden from reports, recorded in the chronicle —
  // the agent never reads the chronicle during play).
  for (const e of edgesTo(g, 'inst:crown', 'interest')) {
    const skim = propFx(e.props, 'skimPerTick');
    if (skim <= 0n || e.props['exposed'] === true) continue;
    const deltas: GraphDelta[] = [
      { op: 'node.set', id: 'inst:crown', key: 'treasury', value: propFx(getNode(g, 'inst:crown').props, 'treasury') - skim },
      { op: 'edge.set', id: e.id, key: 'skimmed', value: propFx(e.props, 'skimmed') + skim },
    ];
    g = applyDeltas(g, deltas);
    em.emit('ledger.skimmed', { deltas, data: { holder: e.src, amount: fxToString(skim) } });
  }

  // 4b. Levy upkeep: militias eat pay every tick; an empty treasury bleeds men instead.
  for (const place of nodesOfType(g, 'place')) {
    const levy = place.props['levy'];
    if (typeof levy !== 'bigint' || levy <= 0n) continue;
    const upkeep = mulFx(levy, ECON.LEVY_UPKEEP);
    const treasury = propFx(getNode(g, 'inst:crown').props, 'treasury');
    if (treasury >= upkeep) {
      const deltas: GraphDelta[] = [{ op: 'node.set', id: 'inst:crown', key: 'treasury', value: treasury - upkeep }];
      g = applyDeltas(g, deltas);
      em.emit('levy.paid', { deltas, data: { placeId: place.id, upkeep: fxToString(upkeep) } });
    } else {
      const remaining = mulFx(levy, fx('0.9'));
      const deltas: GraphDelta[] = [{ op: 'node.set', id: place.id, key: 'levy', value: remaining }];
      g = applyDeltas(g, deltas);
      em.emit('levy.deserted', { deltas, data: { placeId: place.id, remaining: fxToString(remaining) } });
    }
  }

  // 5. Liege tribute (winter).
  if (tick % 4 === 3) {
    for (const debt of edgesFrom(g, 'inst:crown', 'debt')) {
      // Renderer-law T2 (debt mechanism, ops.ts): `debt`-typed edges from
      // inst:crown are no longer exclusively the liege tribute shape --
      // borrow/repay (ops.ts) now creates/removes `debt` edges of a
      // DIFFERENT shape (props principal/fee/dueTick/settled/
      // overdueEmitted, no `duePerYear` at all) to the same edge type, and
      // edgesFrom() selects on (src, type) alone. Skip anything that isn't
      // the liege shape -- same discriminator idiom as debtOverdueStep just
      // below (key on YOUR props) -- or an outstanding borrow surviving
      // into a winter tick throws here (propFx on a missing prop).
      if (typeof debt.props['duePerYear'] !== 'bigint') continue;
      const due = propFx(debt.props, 'duePerYear');
      const treasury = propFx(getNode(g, 'inst:crown').props, 'treasury');
      if (treasury >= due) {
        const deltas: GraphDelta[] = [{ op: 'node.set', id: 'inst:crown', key: 'treasury', value: treasury - due }];
        g = applyDeltas(g, deltas);
        em.emit('tribute.paid', { deltas, data: { to: debt.dst, amount: fxToString(due) } });
      } else {
        const crown = getNode(g, 'inst:crown').props;
        const deltas: GraphDelta[] = [
          { op: 'node.set', id: 'inst:crown', key: 'arrears', value: propFx(crown, 'arrears') + due },
          { op: 'node.set', id: 'inst:crown', key: 'legitimacy', value: clampFx(propFx(crown, 'legitimacy') - fx('10'), FX_ZERO, UNREST_MAX) },
        ];
        g = applyDeltas(g, deltas);
        em.emit('tribute.defaulted', { deltas, data: { to: debt.dst, amount: fxToString(due) } });
      }
    }
  }

  return g;
}

// Social drift, decay, and cooling below are continuous background
// processes with no discrete cause to chronicle -- replay regenerates them
// by re-running socialStep, not by reading them back from events -- so
// they mutate the graph directly via the graph.ts helpers and emit
// nothing (convention lock's continuous-decay exemption). The one
// exception is the exposed-skimmer grudge kindle: that has a real,
// discrete cause (the audit that exposed them) worth chronicling, so it
// follows the same D14 discipline as economyStep above -- built as a
// GraphDelta[], applied through applyDeltas, and handed to grudge.kindled
// as its `deltas` (see test/ladder.test.ts's "socialStep delta-
// equivalence" case).
export function socialStep(g0: WorldGraph, tick: number, em: Emitter): WorldGraph {
  let g = g0;
  const clampBp = (bp: number): number => (bp > 10_000 ? 10_000 : bp < 0 ? 0 : bp);

  // Loyalty relaxes toward neutral (5000bp) by 100bp/tick, clamped so it
  // lands exactly on 5000 rather than overshooting and oscillating. The
  // reason log folds this drift into its single rolling 'time' entry
  // (spec §5) via the SAME setEdgeProp vehicle as the bp write itself --
  // no GraphDelta/applyDeltas/emit here, same as the bp write, per this
  // function's header comment: drift has no discrete chronicle cause, so
  // replay regenerates it by re-running socialStep, not by reading it back
  // from events.
  for (const e of edgesOfType(g, 'loyalty')) {
    const bp = typeof e.props['bp'] === 'number' ? (e.props['bp'] as number) : 5000;
    const next = bp < 5000 ? bp + 100 : bp > 5000 ? bp - 100 : bp;
    const adjusted = (bp < 5000 && next > 5000) || (bp > 5000 && next < 5000) ? 5000 : next;
    if (adjusted !== bp) {
      const clamped = clampBp(adjusted);
      g = setEdgeProp(g, e.id, 'bp', clamped);
      g = setEdgeProp(g, e.id, 'log', foldAllegianceDrift(e.props, tick, clamped - bp));
    }
  }
  // Grudges decay by 50bp/tick, floored at 0. Same rolling-log treatment.
  for (const e of edgesOfType(g, 'grudge')) {
    const bp = typeof e.props['bp'] === 'number' ? (e.props['bp'] as number) : 0;
    if (bp > 0) {
      const newBp = bp - 50 < 0 ? 0 : bp - 50;
      g = setEdgeProp(g, e.id, 'bp', newBp);
      g = setEdgeProp(g, e.id, 'log', foldAllegianceDrift(e.props, tick, newBp - bp));
    }
  }
  // Exposed skimmers resent their exposure -- once, latched by
  // grudgeBumped so a second tick of exposure doesn't re-kindle it.
  const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
  for (const e of edgesTo(g, 'inst:crown', 'interest')) {
    if (e.props['exposed'] !== true || e.props['grudgeBumped'] === true) continue;
    const eventId = em.nextId();
    const existing = findEdge(g, 'grudge', e.src, rulerId);
    const bp = typeof existing?.props['bp'] === 'number' ? (existing.props['bp'] as number) : 0;
    const newBp = clampBp(bp + 1500);
    const deltas: GraphDelta[] = existing
      ? [
          { op: 'edge.set', id: existing.id, key: 'bp', value: newBp },
          { op: 'edge.set', id: existing.id, key: 'log', value: appendAllegianceLog(existing.props, tick, newBp - bp, eventId) },
          { op: 'edge.set', id: e.id, key: 'grudgeBumped', value: true },
        ]
      : [
          { op: 'edge.add', edge: { id: edgeId('grudge', e.src, rulerId), type: 'grudge', src: e.src, dst: rulerId, props: { bp: newBp, log: [{ tick, deltaBp: newBp, cause: eventId }] } } },
          { op: 'edge.set', id: e.id, key: 'grudgeBumped', value: true },
        ];
    g = applyDeltas(g, deltas);
    em.emit('grudge.kindled', { deltas, data: { holder: e.src, against: rulerId, cause: 'exposed' } });
  }
  // Fed towns cool by 1 unrest per tick.
  for (const place of nodesOfType(g, 'place')) {
    const need = mulFx(propFx(place.props, 'population'), ECON.CONSUME_PER_POP);
    if (propFx(place.props, 'granary') >= need) {
      const unrest = propFx(getNode(g, place.id).props, 'unrest');
      g = setNodeProp(g, place.id, 'unrest', clampFx(unrest - fx('1'), FX_ZERO, UNREST_MAX));
    }
  }
  return g;
}

// Causality §2: deed fingerprint decay. Unlike drift/decay above (no
// discrete cause, no chronicle), a fingerprint's presence is content-gated
// state -- kit law gates reaction scenes on `recent:<deed> ne ''` -- so its
// clearing IS chronicle-worthy, the same way the exposed-skimmer
// grudge.kindled kindle above earns a real event despite living in this
// "continuous background process" function's neighborhood. `node.set` has
// no delete: "clearing" means overwriting recent:<deed> back to '' (the
// same value an untouched node already reads as absent under evalPredicate/
// the `ne ''` exists-idiom, match.ts) and recent:<deed>:at to -1 (a tick
// that can never legitimately occur, since ticks start at 0 and only climb
// -- pure hygiene: the decay CONDITION itself is gated on the seat value,
// not on :at, so a repeat pass can never re-fire regardless of this choice).
//
// Order-stable per the plan's own call-out ("the decay pass especially"):
// outer loop over nodeIds(g) (already sorted), inner loop over the closed,
// fixed-order DEED_NAMES array -- both loops are deterministic by
// construction, so the resulting fades[] order (and thus deltas[] order) is
// reproducible without an extra sort. One `fingerprints.faded` event per
// tick carries EVERY fade (never one event per fade); no event at all when
// nothing faded. A systemic pass: `parents` is never set (defaults to []),
// so this can never read as player-descended (T2's ancestry invariant).
export function fingerprintDecayStep(g0: WorldGraph, tick: number, em: Emitter): WorldGraph {
  let g = g0;
  const deltas: GraphDelta[] = [];
  const fades: Array<{ nodeId: string; deed: string; seatId: string; at: number }> = [];
  for (const id of nodeIds(g)) {
    const props = getNode(g, id).props;
    for (const deed of DEED_NAMES) {
      const seatVal = props[`recent:${deed}`];
      if (typeof seatVal !== 'string' || seatVal === '') continue; // never stamped, or already decayed
      const atVal = props[`recent:${deed}:at`];
      if (typeof atVal !== 'number' || tick - atVal <= FINGERPRINT_TICKS) continue;
      deltas.push({ op: 'node.set', id, key: `recent:${deed}`, value: '' });
      deltas.push({ op: 'node.set', id, key: `recent:${deed}:at`, value: -1 });
      fades.push({ nodeId: id, deed, seatId: seatVal, at: atVal });
    }
  }
  if (fades.length === 0) return g;
  g = applyDeltas(g, deltas);
  em.emit('fingerprints.faded', { deltas, data: { fades } });
  return g;
}

// Renderer-law T2 (debt-mechanism preamble): debt overdue pass. Mirrors
// fingerprintDecayStep's discipline just above -- deterministic,
// fortune-free, order-stable iteration (edgesOfType(g, 'debt') is already
// sorted by edge id, graph.ts's edgeList()), no `parents` (systemic passes
// are never player-descended, T2's ancestry invariant) -- but DEVIATES on
// one point: it emits ONE `debt.overdue` event PER newly-overdue edge,
// not fingerprintDecayStep's single event carrying every fade. Deliberate:
// content books the collector scene off THIS debt edge specifically (the
// robust booked-chain idiom -- the borrow option's own op creates the edge
// the scene later gates on), so each edge's overdue transition needs its
// own citable event id for becauseOf attribution; bundling every overdue
// edge into one shared event would hand every gated brief the SAME
// becauseOf id regardless of which debt actually concerns it.
//
// Keys entirely on SHAPE, never on src/dst: reads `settled`/`overdueEmitted`/
// `dueTick` off each edge's own props and SKIPS any debt edge missing them,
// rather than assuming every `debt`-typed edge is one of ours. This is
// load-bearing, not defensive dressing -- thornfieldGraph() carries a
// pre-existing `debt` edge (inst:crown -> char:liege, props { duePerYear }
// only) that predates this mechanism entirely; without the guard this pass
// would throw reading `dueTick` off it. `settled` is created `false` and
// (per applyOp's 'repay' arm, ops.ts) never flipped to `true` -- repay
// REMOVES the edge instead -- so `settled !== false` is equivalent to "not
// one of ours, or already gone," never true for a live debt this mechanism
// created.
export function debtOverdueStep(g0: WorldGraph, tick: number, em: Emitter): WorldGraph {
  let g = g0;
  for (const edge of edgesOfType(g, 'debt')) {
    if (edge.props['settled'] !== false) continue; // foreign shape (liege edge), or already gone (repay removes it)
    if (edge.props['overdueEmitted'] !== false) continue; // already emitted -- emission-once
    const dueTick = edge.props['dueTick'];
    if (typeof dueTick !== 'number' || tick <= dueTick) continue;
    const deltas: GraphDelta[] = [{ op: 'edge.set', id: edge.id, key: 'overdueEmitted', value: true }];
    g = applyDeltas(g, deltas);
    em.emit('debt.overdue', {
      deltas,
      data: { lenderId: edge.dst, principal: fxToString(propFx(edge.props, 'principal')), fee: fxToString(propFx(edge.props, 'fee')) },
    });
  }
  return g;
}

// Claim §1-2 (2026-08-20 claim plan, Global Constraints -- verbatim-binding
// shapes): the declaration pass. A "claim circle" character (node props
// claimCircle === true AND claimBp: number, content-authored) DECLARES for
// the ruler's claim -- a `backing` edge src charId -> dst inst:crown, props
// { declaredAt: tick, bp: claimBp, viaPromise } -- the tick their price is
// answered and their effective loyalty clears DECLARE_LOYALTY.
//
// Mirrors fingerprintDecayStep/debtOverdueStep's systemic-pass discipline
// just above: deterministic, fortune-free (D21 -- flashpoint resolution,
// Task 3, is the fortune-consuming world outcome; this pass is not one),
// order-stable iteration (nodeIds(g) is already sorted), no `parents`
// (systemic passes are never player-descended, T2's ancestry invariant).
// One `claim.declared` event PER declaring character -- debtOverdueStep's
// per-edge-emission precedent, not fingerprintDecayStep's single-event-
// carries-everything precedent: each declaration is its own citable fact
// (a future betrayal/report/attribution consumer needs to name THIS one),
// the same reasoning debtOverdueStep's own header gives for emitting once
// per overdue edge rather than bundling.
//
// "Price answered" is an OR across two paths (Global Constraints, and the
// task brief's own literal resolution of the plan's prose): the character
// has had ANY want fulfilled by this tick or earlier -- read as wantIndex >
// 0, since tick.ts's advanceWants only ever increments this on a real
// want.fulfilled, so a nonzero wantIndex can only exist for a character who
// carries (or carried) a real wantChain; no separate "has a wantChain at
// all" guard is needed -- OR an unbroken `promise` edge (inst:crown ->
// charId, Task 2's `pledge` op; none exists in this wave's own vocabulary
// yet, checked here per the plan's own instruction and exercised in
// test/claim.test.ts by a hand-built edge) names their CURRENT want
// specifically. A sated character (wantChain exhausted, currentWant null)
// can never match a promise via this second path -- but by construction
// they can only be sated after their wantIndex already advanced past every
// entry, so the first path (wantIndex > 0) already covers them.
//
// Placement (tick.ts): immediately after socialStep, before
// fingerprintDecayStep -- per the plan's explicit instruction. Originally
// also justified as load-bearing for a same-tick interaction with
// advanceCharacterArcs (character departure): a departing character's TRUE
// loyalty is necessarily low that tick (arcs.ts's retention check already
// ruled out >= 5500 true bp, or they'd have retained instead), but
// EFFECTIVE loyalty (this pass's own formula) can still clear
// DECLARE_LOYALTY on a large legitimacy bonus alone -- exactly the "false
// stone" shape the plan's own betrayal mechanic (Task 3) is built around,
// not a bug to design around. Running the pass AFTER advanceCharacterArcs
// used to be a real bug for exactly this reason (a just-departed
// character's loyalty edge is gone, and effectiveLoyalty would read the
// neutral 5000 DEFAULT in its place). Controller adjudication (2026-08-27,
// post-review) closed that hole a second, more robust way too -- see the
// "Exclusions" paragraph below -- so this placement choice is now
// defense-in-depth rather than the only thing standing between a defector
// and a fresh declaration; it is kept because it is still correct and still
// the plan's own instructed position. Placed before fingerprintDecayStep/
// debtOverdueStep/advanceArcs too for the same reason those three sit
// beside each other: fully disjoint prop/edge sets (claimCircle/claimBp/
// backing/promise vs. recent:<deed> vs. debt-edge props vs. famine/
// character-arc props), so ordering among THEM only affects which of this
// tick's events sort first, never the outcome.
//
// Exclusions (controller adjudication, 2026-08-27, post-review): two gates
// closed after the initial implementation was reviewed against the "false
// stone" reasoning above. (1) Declaring REQUIRES an actual `loyalty` edge to
// the ruler -- no default-5000 qualification. Without this, a departed
// character (departureDeltas, arcs.ts, cuts their loyalty edge on the way
// out) would read the neutral default and, on a high enough legitimacy
// bonus alone, could "declare" for the crown from the rival's own court --
// independent of this pass's placement relative to advanceCharacterArcs, and
// closing the same hole for any FUTURE character who simply never had a
// loyalty edge authored at all. (2) `imprisoned === true` characters never
// declare -- a cell is not a court -- gated on the character's own prop, so
// the exclusion is TEMPORARY by construction: `pardon` (ops.ts) flips
// `imprisoned` back to false with no special-casing needed here, and the
// very next tick's pass simply sees the flag cleared. Both pinned in
// test/claim.test.ts's "exclusions" suite: the departed-re-declare repro,
// and an imprisoned-then-pardoned character declaring only after the pardon.
// Controller adjudication (2026-08-27, post-review): takes the character's
// TRUE loyalty bp as an already-resolved number rather than re-deriving it
// from a (charId, rulerId) pair internally, so the loyalty-EDGE-EXISTENCE
// decision lives exactly once, at declarationStep's own call site below --
// this function is never the place a "no edge" case could quietly default
// to neutral again.
function effectiveLoyalty(g: WorldGraph, charId: string, trueLoyaltyBp: number): number {
  // claimNudge: a char prop written by momentum (Task 4); absent (this
  // task, and any character Task 4 has never touched) reads as 0 -- the
  // same "absent means the neutral default" idiom aptOf/loyaltyBp/wealthOf
  // each already use for their own props.
  const nudgeVal = getNode(g, charId).props['claimNudge'];
  const claimNudge = typeof nudgeVal === 'number' ? nudgeVal : 0;
  const legitimacy = propFx(getNode(g, 'inst:crown').props, 'legitimacy');
  const legitimacyWholePoints = Number(fxWhole(legitimacy));
  return trueLoyaltyBp + claimNudge + legitimacyWholePoints * 20;
}

/** The effective-loyalty threshold a circle character's score must clear
 *  (inclusive) to declare (Global Constraints). Exported so Task 4's
 *  waverer band ([4000, DECLARE_LOYALTY)) can cite this same value instead
 *  of re-deriving the magic number 5500 a second place. */
export const DECLARE_LOYALTY = 5500;

export function declarationStep(g0: WorldGraph, tick: number, em: Emitter): WorldGraph {
  let g = g0;
  const rulerId = propStr(getNode(g, 'inst:crown').props, 'rulerCharId');
  for (const charId of nodeIds(g)) {
    const node = getNode(g, charId);
    if (node.type !== 'character') continue;
    if (node.props['claimCircle'] !== true) continue; // circle definition is an AND -- both marks required
    if (typeof node.props['claimBp'] !== 'number') continue;
    // Controller adjudication (2026-08-27, post-review): a cell is not a
    // court. Gated on the character's OWN `imprisoned` prop, so this is
    // temporary by construction -- ops.ts's `pardon` flips it back to false
    // with no special-casing needed here; the very next tick's pass simply
    // sees the flag cleared and proceeds normally (test/claim.test.ts's
    // "imprisoned then pardoned" pin).
    if (node.props['imprisoned'] === true) continue;
    if (findEdge(g, 'backing', charId, 'inst:crown')) continue; // already declared -- never re-processed, never retracted here

    const wantIndexVal = node.props['wantIndex'];
    const wantIndex = typeof wantIndexVal === 'number' ? wantIndexVal : 0;
    const anyWantFulfilled = wantIndex > 0;
    const want = currentWant(g, charId);
    const promiseEdge = want !== null ? findEdge(g, 'promise', 'inst:crown', charId) : undefined;
    const pledged = promiseEdge !== undefined && promiseEdge.props['broken'] !== true && promiseEdge.props['wantKey'] === want;
    if (!anyWantFulfilled && !pledged) continue; // price unanswered -- neither path holds

    // Controller adjudication (2026-08-27, post-review): declaring requires
    // an ACTUAL loyalty edge to the ruler -- no default-5000 qualification.
    // Without this, a departed defector (departureDeltas, arcs.ts, cuts
    // their loyalty edge on the way out) would read the neutral default
    // here and, on a high enough legitimacy bonus alone, could "declare"
    // for the crown from the rival's own court -- a deserter backing the
    // very claim they just deserted. An absent edge is ineligible, full
    // stop; only an edge that actually EXISTS gets its bp read (defensively
    // defaulted to 5000 ONLY if that edge's own `bp` prop is somehow
    // malformed -- a structurally different, much narrower fallback than
    // "no edge exists at all").
    const loyaltyEdge = findEdge(g, 'loyalty', charId, rulerId);
    if (!loyaltyEdge) continue;
    const trueLoyalty = typeof loyaltyEdge.props['bp'] === 'number' ? (loyaltyEdge.props['bp'] as number) : 5000;
    if (effectiveLoyalty(g, charId, trueLoyalty) < DECLARE_LOYALTY) continue;

    const bp = node.props['claimBp'];
    const viaPromise = pledged && promiseEdge ? promiseEdge.id : '';
    const deltas: GraphDelta[] = [{
      op: 'edge.add',
      edge: { id: edgeId('backing', charId, 'inst:crown'), type: 'backing', src: charId, dst: 'inst:crown', props: { declaredAt: tick, bp, viaPromise } },
    }];
    g = applyDeltas(g, deltas);
    em.emit('claim.declared', { data: { charId, bp, viaPromise }, deltas });
  }
  return g;
}
