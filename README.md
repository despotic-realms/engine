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

## Quickstart

```sh
pnpm install
pnpm test
pnpm demo
```

`pnpm demo` builds the package and runs `src/demo.ts` — the only file in this
package allowed to use `console`. It runs a scripted 16-tick Tier-1 reign
twice on the same seed and prints `replay: bit-exact ✓` when the two runs
produce an identical state hash.

## Module map

```
src/
  index.ts             public exports
  fx.ts                fixed-point bigint math
  fortune.ts           counter-based seeded streams
  graph.ts             typed property graph + sorted iteration
  canon.ts             canonical JSON + 64-bit hashing
  events.ts            chronicle events, graph deltas, emitter
  constants.ts         economy constants
  ops.ts               closed op vocabulary: validate + apply
  decks/thornfield.ts  starter world graph (canonical Tier-1 fixture)
  match.ts             graph pattern DSL + deterministic matcher
  storylet.ts          storylets, decks, deck harness (checkDeck)
  decks/starter.ts     public starter deck
  report.ts            seats + biased ledger projections
  systems.ts           economy + social steps
  ladder.ts            tier rules + transitions
  scheduler.ts         policy interface, examiner, famine arc
  tick.ts              resolveTick + packet + decisions validation
  replay.ts            runReign / replay / divergence
  demo.ts              CLI demo (only file allowed console)
test/                  one <module>.test.ts per src module, + determinism.test.ts
```

## What a host adds

This package is the pure core. LLMs hold exactly three roles in the wider
system, and **none of them live in this package** — nothing here calls a
model:

1. **NPC voice** — local, in-character decisions for non-throne seats.
2. **Order compiling** — turning free-text directives into the closed op
   vocabulary, at temperature 0.
3. **Post-hoc analysis** — portrait rendering over the closed chronicle,
   after a reign (or a tick) is already resolved.

A host is built against three contracts this package exposes:

- **`OP_KINDS`** (`src/ops.ts`) — the compiler contract. The closed,
  described vocabulary of world-mutating operations; a host's order-compiler
  targets these shapes, and `validateOp` rejects anything else.
- **`checkDeck`** (`src/storylet.ts`) — the content contract. The harness
  every storylet deck — public starter deck or private live-season deck —
  ships against; run it in CI over your fixtures before publishing a deck.
- **`TickPacket` / `TickDecisions`** (`src/tick.ts`) — the SDK contract.
  What a host hands an agent each tick (briefs, reports, correspondence) and
  what it must hand back (a seat id and a list of choices). `TickDecisions`
  carries no journal field by construction — stated reasoning travels SDK →
  host → sealed store → analyst, never through world-side code.

## Season content lifecycle

Disclosure follows the season lifecycle (D20): live-season material — seeds,
decks, examiner schedules, NPC/compiler prompts, rubric versions — is
**sealed while the season runs** and **published in full at season close**
into a public `seasons` archive. This `engine` package and the `sdk` ship
public forever, since the trust substrate — determinism, journal privacy,
and the LLM role boundary — has to be independently verifiable; the storylet
format, the deck harness, and this starter deck ship openly here for that
reason. Live-season decks themselves live in a private `content` repo while
their season is in play.
