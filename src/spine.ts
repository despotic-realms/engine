// The character spine's closed vocabularies (spec §2). Setting packs skin
// the NOUNS at render surfaces; these canonical keys never appear in prose.
// apt:* values are engine-internal: only bands (bands.ts) leave the engine.
import type { WorldGraph } from './graph.js';
import { getNode } from './graph.js';

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
  const v = getNode(g, charId)?.props[key];
  return typeof v === 'number' ? v : APT_DEFAULT;
}

export function hasTrait(g: WorldGraph, charId: string, key: TraitKey): boolean {
  return getNode(g, charId)?.props[`trait:${key}`] === true;
}

/** The rolling focus: wantChain[wantIndex], or null past the end (sated). */
export function currentWant(g: WorldGraph, charId: string): string | null {
  const n = getNode(g, charId);
  const chain = n?.props['wantChain'];
  const idx = n?.props['wantIndex'];
  if (!Array.isArray(chain) || typeof idx !== 'number') return null;
  const w = chain[idx];
  return typeof w === 'string' ? w : null;
}
