// The character spine's closed vocabularies (spec §2). Setting packs skin
// the NOUNS at render surfaces; these canonical keys never appear in prose.
// apt:* values are engine-internal: only bands (bands.ts) leave the engine.
// Callers pass an existing charId; "absent" means a missing prop on an existing node.
// Behavior for existing nodes is unchanged (absent apt prop → 5000; absent trait → false; wantIndex past end → null).
import type { WorldGraph } from './graph.js';
import { findEdge, getNode } from './graph.js';
import type { Op } from './ops.js';
import { fx } from './fx.js';

export const APT_KEYS = ['apt:econ', 'apt:martial', 'apt:social', 'apt:judge'] as const;
export type AptKey = (typeof APT_KEYS)[number];

export const TRAIT_KEYS = ['greedy','honest','craven','bold','meticulous','slothful','vengeful','forgiving','ambitious','content','cunning','guileless','cruel','kindly'] as const;
export type TraitKey = (typeof TRAIT_KEYS)[number];

export const WANT_KEYS = ['holding','office','coin','pardon','marriage','revenge','recognition','safety'] as const;
export type WantKey = (typeof WANT_KEYS)[number];

export const BANDS = ['botched', 'poor', 'sound', 'outstanding'] as const;
export type Band = (typeof BANDS)[number];

const APT_DEFAULT = 5000; // unauthored characters are exactly median

export function aptOf(g: WorldGraph, charId: string, key: AptKey): number {
  const v = getNode(g, charId).props[key];
  return typeof v === 'number' ? v : APT_DEFAULT;
}

export function hasTrait(g: WorldGraph, charId: string, key: TraitKey): boolean {
  return getNode(g, charId).props[`trait:${key}`] === true;
}

/** The rolling focus: wantChain[wantIndex], or null past the end (sated). */
export function currentWant(g: WorldGraph, charId: string): string | null {
  const n = getNode(g, charId);
  const chain = n.props['wantChain'];
  const idx = n.props['wantIndex'];
  if (!Array.isArray(chain) || typeof idx !== 'number') return null;
  const w = chain[idx];
  return typeof w === 'string' ? w : null;
}

// Rolling wants (spec §2, T7): each want key names a done-detector, run
// against the op that just applied and the graph AFTER it applied --
// `safety`'s walls clause needs to read defenseBp off the graph, not just
// the op's own shape, which is why every predicate takes (g, op, charId)
// rather than just (op, charId). Callers (resolveTick, see tick.ts's
// applyOpWithWants) run these ONLY when the op's own deltas actually
// landed: a botched mediated execution never reaches here, so no predicate
// needs to re-derive that itself. A predicate answers "would THIS op, if it
// landed, satisfy charId's want" -- nothing here mutates or emits.
export type WantFulfillFn = (g: WorldGraph, op: Op, charId: string) => boolean;

export const WANT_FULFILL: Record<WantKey, WantFulfillFn> = {
  coin: (_g, op, charId) => {
    if (op.kind !== 'grant' || op.charId !== charId) return false;
    return fx(op.amount) >= fx('15');
  },
  office: (_g, op, charId) => op.kind === 'appoint' && op.charId === charId,
  pardon: (_g, op, charId) => op.kind === 'pardon' && op.charId === charId,
  holding: (g, op, charId) => {
    if (op.kind !== 'invest') return false;
    return findEdge(g, 'interest', charId, op.placeId) !== undefined; // any project
  },
  // Reserved (spec §2): no op in this wave's vocabulary proposes a
  // marriage, so this never fires. The key stays in WANT_KEYS so content
  // can already author it into a wantChain -- Stage-2 apparatus content
  // adds the op that lets it advance.
  marriage: () => false,
  revenge: (g, op, charId) => {
    if (op.kind !== 'imprison' && op.kind !== 'seize') return false;
    return findEdge(g, 'grudge', charId, op.charId) !== undefined; // charId's own grudge, toward the op's target
  },
  recognition: (g, op, charId) => {
    if (op.kind === 'grant') return op.charId === charId; // any amount, unlike coin's threshold
    if (op.kind === 'hold_festival') return findEdge(g, 'interest', charId, op.placeId) !== undefined;
    return false;
  },
  safety: (g, op, charId) => {
    if (op.kind === 'pardon') return op.charId === charId;
    if (op.kind !== 'invest' || op.project !== 'walls') return false;
    if (findEdge(g, 'interest', charId, op.placeId) === undefined) return false;
    const defenseBp = getNode(g, op.placeId).props['defenseBp'];
    return typeof defenseBp === 'number' && defenseBp >= 2000;
  },
};
