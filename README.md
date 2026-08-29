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
  spine.ts             character spine: aptitudes, traits, wants (closed vocabularies)
  decks/thornfield.ts  starter world graph (canonical Tier-1 fixture)
  match.ts             graph pattern DSL + deterministic matcher
  storylet.ts          storylets, decks, deck harness (checkDeck)
  decks/starter.ts     public starter deck
  bands.ts             execution-quality bands: weights + counter-based draw
  mediate.ts           mediated execution: gate, willingness, band, riders
  report.ts            seats + biased ledger projections
  observe.ts           biased observations of executed ops (six precedence rules)
  systems.ts           economy + social steps
  loyalty.ts           shared effective-loyalty formula + declaration/waverer thresholds
  ladder.ts            tier rules + transitions
  scheduler.ts         policy interface, examiner, famine arc
  arcs.ts              character arcs: restless -> poach bid -> departed/retained
  calendar.ts          examiner-calendar validation harness (checkDeck analog)
  attribution.ts       computed attribution (causality)
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

## Causality (v0.3)

The world answers the player. Four mechanisms make a reign's briefs
responsive to what the throne actually does, layered on top of the
novelty-weighted lottery the scheduler already runs within each
eligible-brief stratum below — probes and due bookings force-deal instead,
drawing nothing.

**Recency casting** — the scheduler remembers which brief instances the
world made possible as of the previous tick (`ReignState.eligibleLastTick`,
the pattern-possibility snapshot, unfiltered by cooldowns or fire caps) and
diffs it against what is possible now. Newly-eligible briefs
— ones the world only just made possible — deal ahead of standing briefs that
have sat eligible without being shown, so a reign's attention budget goes
toward what just changed before it repeats what's already on offer. A scene
family dealt last tick rests a tick when alternatives exist, so a storylet
with many bindings can't monopolize the budget by rotating through a fresh
one each time.

**Computed attribution** — within the newly-eligible set, the engine asks a
narrower question: did the player's own decisions cause this, or did the
world? Attribution is computed structurally every tick, never guessed and
never drawn — no Fortune parameter is involved anywhere in it. The engine
walks this tick's chronicle events back through their causal parents to find
which are player-descended (their ancestry reaches one of this tick's own
recorded decisions), then checks whether a candidate storylet's pattern reads
anything those player-descended events wrote — by node type and prop, by
edge type, and, wherever the pattern pins a literal node, by that exact id.
A hit makes the brief player-attributed, and player-attributed briefs deal
ahead of world-newly ones. A player-attributed `Brief` also carries
`becauseOf`: the sorted ids of the attributing events, present only on
attributed deals and absent everywhere else. It's packet-only and
informational — a surface can render a "because of your order" label off
it, but nothing in the core ever reads it back.

**Deed fingerprints** — every consequential op stamps a short-lived,
actor-valued marker on its target as part of its own delta bundle: a
`recent:<deed>` prop holding the deciding seat's id (a seat id, never a
character id — multiplayer-proofed from day one), and a `recent:<deed>:at`
prop holding the tick it landed. Content gates a reaction scene on
`recent:<deed>` being non-empty (the same `ne ''` exists-idiom used
elsewhere in this engine's pattern predicates), or on a specific seat's id
where the gate needs to be that precise. The deed vocabulary is closed, and
content gates on these strings verbatim: `granted`, `seized`, `envoy-warm`,
`envoy-firm`, `envoy-hard`, `audited`, `appointed`, `imprisoned`, `pardoned`,
`vetted`, `festival`, `invested`, `grain-released`, `grain-bought`,
`levy-raised`, `taxed`. A fingerprint doesn't last forever: once its window
closes, a deterministic decay pass clears both props and emits a
`fingerprints.faded` event carrying every fade that happened that tick (one
event per tick, never one per fade).

**Booked follow-ups** — a `StoryletOption` can name `books: { storyletId,
withinTicks }`. Choosing that option books the named storylet as a
follow-up in `ReignState.bookings`, due within the stated window — and this
fires on every path that lands the option's ops, not only a direct attended
choice: a brief that defaults, or is neglected past the attention cut,
still books if the option that ends up applying carries `books`. A
`TierRule` (v0.4.1) can name the same shape, so a tier transition may book
its own arrival scene — guaranteed to deal on the first post-transition
tick instead of competing against however much content the transition
just grafted in. A due,
eligible booking force-deals, skipping the novelty lottery entirely, so an
authored chain lands on schedule instead of competing with the rest of the
pool. A booking that never becomes eligible within its window lapses
unfilled rather than vanishing silently. Both outcomes are events:
`scene.booked` when a booking is recorded, `scene.booking.lapsed` when one
expires unfilled — both carry no graph deltas, the same
state-field-lifecycle discipline character arcs already use.

**Casting order** — the four mechanisms compose into one fixed order every
tick: probes first (the benchmark instrument, forced regardless of anything
else), then due bookings, then player-attributed newly-eligible briefs, then
world newly-eligible briefs, then the standing pool — with the
novelty-weighted lottery still deciding ties within whichever stratum is
being drawn from.

## Whole-person deaths and real debt (v0.4)

Two mechanisms close gaps a renderer-facing review surfaced: famine deaths
were reaching the chronicle as fractional corpses, and the treasury's only
notion of "debt" was a fixed liege tribute with no borrowing behind it.

**Deaths, in whole people** — famine attrition is still computed
continuously per place, but is no longer reported as it lands: each
place's raw attrition accumulates in a non-visible `deathsCarry`
fixed-point prop, and only once that carry crosses a whole person does
`famine.starvation` fire — `deaths` an integer, population decremented by
exactly that count, and the fractional remainder held in the carry for the
next tick. A shortfall tick that doesn't cross a person emits no
starvation event at all: hunger without a death is unrest texture, never a
death report.

**Real debt** — `borrow` opens a `debt` edge from the crown to a lender
(character or institution), carrying `principal`, `fee`, `dueTick`, and
`settled`/`overdueEmitted` bookkeeping flags, and credits the treasury at
once; `repay` debits principal plus fee in full and removes the edge
outright, so settlement is the edge's disappearance, never a flag flip —
the same lender can be borrowed from again cleanly afterward. A
deterministic, fortune-free systems pass marks a debt overdue the tick
after its due tick passes — once — emitting `debt.overdue`; the engine
charges no penalty of its own, leaving collection for content to
dramatize, typically by booking a follow-up scene off the very edge the
loan created. The deed vocabulary grows from sixteen entries to eighteen:
`borrowed` and `repaid` join the closed set, decaying on the same
fingerprint clock as the rest.

## The claim (v0.5)

The throne becomes a visible, pursuable goal. A character marked into the
claim circle declares for the ruler once their price is answered; a run of
authored flashpoints escalates the campaign under fogged scales and the
threat of betrayal; momentum sways the undecided; and the campaign's own
climax can promote or demote the reign through the same tier ladder every
other transition already uses.

**Declarations** — content marks a character into the circle with two node
props: `claimCircle: true` and `claimBp` (a per-mille weight — a lord marks
heavier than a hunter). Each tick, a deterministic, fortune-free pass checks
every circle character without a standing declaration: if their price is
answered — their current want already fulfilled, or a binding `pledge`
naming it — and their loyalty (nudged by momentum and by the crown's own
standing) clears the declare threshold, they declare. A declaration is a
`backing` edge to the crown, carrying the weight and, when a pledge was the
operative reason, which promise earned it. `pledge { charId, wantKey }` is
direct throne speech (no office in between) that binds the crown to a
want without paying it — a real obligation, visible in the claim projection
below, with promise-breaking mechanics left for a later round.

**Flashpoints** — `press_claim { flashpointId }` resolves a contested
moment: declared backing plus any true asset stones against the rival's
own opposition, drawn once against a graded table of outcomes from routed
loss through setback and costly success to outright triumph. A backer
whose true loyalty is thin and who holds a grudge or a cunning-or-vengeful
streak counts on the visible scale but not the true one — a false stone,
invisible until a bad-enough roll unmasks the single largest one and costs
it its declaration. A triumph despite hidden false stones leaves them
standing, undiscovered, worse for later. The season's flashpoint table
(opposition and asset stones, per-band consequences, and which bands
promote or demote the reign) is content's own data, named in
`SeasonConfig.flashpoints`. A demotion landing at Tier 0 (self-transitions
included) vacates only the falling ruler's own court appointments, never a
rival's — named via `SeasonConfig.rivalId`, the rival keeps the very office
this opposition weight reads, through every loss. Pressing always rolls —
even hopelessly underprepared, so a season's own "call it early" design and
its routed self-transition stay reachable below any backing threshold —
but a winning roll's promotion lands only if a tier rule matching the
flashpoint's CURRENT tier exists at all, and (when that rule declares one)
its `claimRequire` holds at press time — a decisive verdict never
authorizes itself; the same rule checkLadder would use to fire it ordinarily
must be the one found. Either way the roll's other consequences still apply
and `claim.flashpoint` carries `promotionWithheld: true` for content to
voice as a hollow victory (v0.5.3 closes a cross-tier bypass here: no
matching rule used to be read as nothing to suppress, letting a stamp made
at the wrong tier survive an unrelated later fall and fire a real rule
ungated once the reign happened to land back on a tier where the stored
number coincidentally matched one). The demote side (a rout's own
`claimDemoteTo`) is gated the same way, minus the `claimRequire` leg — a
fall has no threshold to fall short of. A flashpoint may also declare
`cooldownTicks`, a minimum gap enforced between two presses of the same
flashpoint, so pressing for free, forever, is no longer a path to the
throne (v0.5.2).

**Momentum through waverers** — a costly success or triumph sways every
circle character close to declaring but not there yet; a rout or setback
sways them and every standing backer the other way. The sway is a
temporary, decaying nudge to loyalty, never a standalone meter, and never
stacks with itself — only an authored flashpoint moves it, so pressing
the same claim repeatedly cannot manufacture momentum out of nothing.

**The claim tier gate** — a `TierRule` (ladder.ts) can name a
`claimRequire` instead of the ordinary graph-pattern `when`: a minimum
total of declared backing weight together with a minimum treasury,
checked instead of any pattern. The season's return rule switches to
this gate entirely, retiring the older legitimacy-and-treasury thresholds
it used before the claim existed. A `claimRequire` rule composes with the
existing `books` mechanism (v0.4.1) exactly like any other transition, so
a claim-gated return can still guarantee its own arrival scene deals
first. Underneath, the campaign's own decisive flashpoint bands can also
promote or demote the reign directly, through the very same tier-checking
path an ordinary threshold would use — a narrative verdict, not a second
mechanism alongside it.

**The claim projection** — `claimReport(g, gate)` is the player's entire
knowledge of the campaign, as data only; every word of prose is content's
own to write. Each circle character reports as standing declared,
weighing (near the threshold, undecided), or silent (further off, or
excluded outright — imprisoned, or with no live tie to the ruler at all)
— never as a number, and never with any hint of their true loyalty or
false-stone status, which stay exactly as hidden here as everywhere else
in this engine. Alongside each character sits their price: the want they
currently hold, and whether a promise already binds the crown to it. A
separate list carries every standing obligation — tribute owed under the
old liege debt, any live loan, any outstanding promise — and the gate
itself reports what the campaign has against what it still needs, on both
the backing and the treasury axis. The deed vocabulary that content gates
reaction scenes on is unchanged at eighteen entries: `pledge` and
`press_claim` are deliberately excluded from it, since the edges and
events they write are already the gateable facts, richer than a
fingerprint stamp would add.

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
