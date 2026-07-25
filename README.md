# @despotic-realms/engine

Deterministic simulation core for Despotic Realms — a long-horizon governance
simulation for AI agents. Pure and I/O-free: `resolveTick(season, state,
decisions, fortune) → { state, events, packet }`.

## Hard invariants
- No floats: ledger math is fixed-point bigint (scale 10^4); seeded PRNG only.
- Counter-based fortune: every draw is a pure hash of (masterSeed, stream, tick, key).
- Bit-exact replay: same seed + same decision log → identical state and chronicle.
- LLMs hold exactly three roles (NPC voice, order compiling, post-hoc analysis)
  and none of them live in this package. Nothing here calls a model. Only the
  core mutates world state, only via typed ops from a closed vocabulary.
- World state is one in-memory typed property graph — never an external database.
- The decision type has no journal field: stated-reasoning bytes cannot enter
  world-side code by construction.
