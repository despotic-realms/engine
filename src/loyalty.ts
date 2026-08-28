// Claim §1-3 / momentum (2026-08-20 claim plan, Global Constraints): the
// shared effective-loyalty formula and its two threshold constants.
// DECLARE_LOYALTY (systems.ts's declarationStep) and WAVERER_FLOOR (ops.ts's
// press_claim momentum leg, isWaverer) are the two ends of one half-open
// band, [WAVERER_FLOOR, DECLARE_LOYALTY), read against the SAME formula.
//
// Extracted into this leaf module (2026-08-28, review fix on Task 4) so
// declarationStep and press_claim's isWaverer share ONE dependency instead
// of importing from each other. The initial Task 4 landing had ops.ts
// import effectiveLoyalty/DECLARE_LOYALTY straight from systems.ts -- which,
// since systems.ts already imports DEED_NAMES/FINGERPRINT_TICKS from ops.ts
// (for the unrelated deed-fingerprint mechanism), made the two files
// mutually import each other for the first time in this codebase. It worked
// (Node's ESM live bindings resolve a cycle correctly as long as neither
// side reads the other's binding outside a function body, which was true
// here) but review flagged it as a pattern worth dissolving rather than
// keeping, on bands.ts's own precedent one file over: shared math lives in
// its own leaf module, imported one-directionally by every mechanism module
// that needs it (bands.ts itself is imported by mediate.ts and observe.ts
// the same way, never the reverse). Pure relocation -- zero logic change
// from the code this superseded in systems.ts; WAVERER_FLOOR moved here too
// from ops.ts, since it and DECLARE_LOYALTY are the two ends of one band and
// read better side by side than split across files.
import { fxWhole } from './fx.js';
import type { WorldGraph } from './graph.js';
import { getNode, propFx } from './graph.js';

// Controller adjudication (2026-08-27, post-review, T1): takes the
// character's TRUE loyalty bp as an already-resolved number rather than
// re-deriving it from a (charId, rulerId) pair internally, so the
// loyalty-EDGE-EXISTENCE decision lives exactly once, at each CALLER's own
// site (systems.ts's declarationStep; ops.ts's isWaverer) -- this function
// is never the place a "no edge" case could quietly default to neutral
// again. See systems.ts's declarationStep header for the full "false stone
// from a rival court" narrative this contract was built to close.
export function effectiveLoyalty(g: WorldGraph, charId: string, trueLoyaltyBp: number): number {
  // claimNudge: a char prop written by momentum (claim §3); absent (never
  // nudged, or decayed back to 0 by claimNudgeDecayStep) reads as 0 -- the
  // same "absent means the neutral default" idiom aptOf/loyaltyBp/wealthOf
  // each already use for their own props.
  const nudgeVal = getNode(g, charId).props['claimNudge'];
  const claimNudge = typeof nudgeVal === 'number' ? nudgeVal : 0;
  const legitimacy = propFx(getNode(g, 'inst:crown').props, 'legitimacy');
  const legitimacyWholePoints = Number(fxWhole(legitimacy));
  return trueLoyaltyBp + claimNudge + legitimacyWholePoints * 20;
}

/** The effective-loyalty threshold a circle character's score must clear
 *  (inclusive) to declare (Global Constraints). Exported so momentum's
 *  waverer band ([WAVERER_FLOOR, DECLARE_LOYALTY)) can cite this same value
 *  instead of re-deriving the magic number 5500 a second place. */
export const DECLARE_LOYALTY = 5500;

/** Momentum (claim §3, Global Constraints): the effective-loyalty floor a
 *  circle character's score must clear to become sway-eligible ("waverer")
 *  -- paired with DECLARE_LOYALTY above as the OTHER end of the same
 *  half-open band. Exported so tests can cite it by name, mirroring
 *  DECLARE_LOYALTY's own precedent. */
export const WAVERER_FLOOR = 4000;
