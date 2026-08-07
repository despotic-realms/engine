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

## The character spine (v0.2)

The engine's protagonist: every agent in play is a character node on the graph,
bound by aptitudes (four canonical dimensions), traits (a binary registry), and
rolling wants (queued ambitions). Together they define a character's **hidden
aptitudes** — what the character can do — and visible record — what the court
and rivals perceive. Setting packs skin these canonical keys: translating
engine terms to domain nouns.

**Mediated execution and the band model** — Orders above Tier 0 travel through
offices, where an executor stands. The aptitude that matches the order's domain
(econ/martial/social) sets the probability distribution over execution quality
(four bands: botched, poor, sound, outstanding). A single Fortune draw per
mediated op determines the outcome; every consequence downstream is pure and
deterministic. **Willingness** — whether the executor tries at all — is
fortune-free: loyalty bp to the ruler, the executor's current want's domain
affinity, kinship and grudge vectors, and a simple threshold rule decide
refusal, reluctance, or compliance. Reluctance delays the op; refusal stops it
cold, before the Fortune draw ever fires.

**The observation model** — No court member sees the truth directly. Execution
events reach observers only as observations, bent by six deterministic
precedence rules chained in order: executor's own self-report, kinship or
loyalty, grudge, the judge's own aptitude threshold, then fallibility draws at
two tiers of judge quality. The seventh rule: skims (executor embezzlement) are
visible only to judges sharp enough to see the world clearly AND disinterested
enough to say so — kin and the loyal never surface the theft. **Truth costs.**

**Allegiance reason logs** — Each loyalty edge on the graph carries an ordered
log of reason strings: the immediate cause of each bp shift (grant, pardon,
imprison, seize, etc.). The log is a partial trail: a character seeing their
own record never walks backward into the full history, only the ledger's own
projection per the observer model above. Another character's historical record
is sealed from them entirely (the spymaster apparatus below loosens that seal,
conditionally).

**Rolling wants** — Every character chains their ambitions in a wantChain
array: a sequence of want keys from the closed vocabulary (coin, office,
pardon, revenge, marriage, recognition, holding, safety, and others). At any
tick, the character pursues wantChain[wantIndex]. Want fulfillment predicates
— one per want key — read the graph and the landed op together: a want
fulfilled advances wantIndex, the clock on that want resets, and the next want
in the chain becomes the focus. Unfulfilled wants grow stale; cumulative
staleness (checked every tick) arms a character for a restless arc when other
conditions align.

**Character arcs** — A character holding an active arc (restless or scheme)
follows a three-stage progression. **Restless:** born from unmet want +
thin loyalty + time; progresses through poach bid (rival hears of the
character's discontent) to departure (loyalty edge cut, appointments vacated,
character crosses to rival's court but stays on the graph). **Scheme:** arises
from cunning or vengeful trait + low loyalty to the ruler; progresses through
sway (marked for tracking), commit (conditionally telegraphed to spymaster),
and strike (legitimacy cost to crown, unrest to primary place). Both paths
retain at any stage if loyalty recovers or circumstances shift; only the
terminal stage (departure or strike) ends the arc and removes the character
from the ruler's books.

**The apparatus** — The spymaster office gathers intelligence: on receiving
`vet` ops, the ruler can commission a true-ish read of a target's highest
aptitude (quality gated on spymaster's judge), or remain blind. The
`obscure_records` op scrambles the crown's own internal tracking: the counter-
intelligence flag tilts what rivals learn from poach bids (stale want instead
of current). Scheme arcs telegraph conditionally: at the commit stage, a
competent spymaster (judge high enough) hears of the risk; an absent or
unskilled holder hears nothing. The apparatus is the apparatus: designed to
preserve the asymmetry between hidden and visible, between local knowledge
(the crown's own graph) and hearsay (what the court believes).

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
