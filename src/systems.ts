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
import { clampFx, divFx, fx, fxFromInt, fxToString, mulFx, FX_ZERO } from './fx.js';
import type { Fortune } from './fortune.js';
import type { WorldGraph } from './graph.js';
import { edgesFrom, edgesTo, getNode, nodesOfType, propFx, propInt, propStr } from './graph.js';

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
    // chronicle unable to describe a famine visually), famine.starvation
    // (only if the granary couldn't cover what the dole didn't).
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
    g = applyDeltas(g, consumeDeltas);
    em.emit('granary.consumed', { deltas: consumeDeltas, data: { placeId: id, amount: fxToString(consumed) } });
    if (shortfall > 0n) {
      const unrestDelta = mulFx(divFx(shortfall, need), fx('25'));
      const deaths = mulFx(divFx(shortfall, ECON.CONSUME_PER_POP), fx('0.05'));
      const famineDeltas: GraphDelta[] = [
        { op: 'node.set', id, key: 'unrest', value: clampFx(propFx(p(), 'unrest') + unrestDelta, FX_ZERO, UNREST_MAX) },
        { op: 'node.set', id, key: 'population', value: propFx(p(), 'population') - deaths },
      ];
      g = applyDeltas(g, famineDeltas);
      em.emit('famine.starvation', { deltas: famineDeltas, data: { placeId: id, shortfall: fxToString(shortfall), deaths: fxToString(deaths) } });
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

  // 5. Liege tribute (winter).
  if (tick % 4 === 3) {
    for (const debt of edgesFrom(g, 'inst:crown', 'debt')) {
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
