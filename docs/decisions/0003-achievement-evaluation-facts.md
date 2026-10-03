# ADR 0003: Bounded achievement evaluation over canonical facts

- Status: Accepted
- Date: 2026-10-03
- Context: Approved player profile build; implements the pure evaluator part of M3-11

## Decision

Evaluate one normalised completed match at a time, persisting an accumulator only
through the subsequent worker's revision fence. Bind checkpoints to canonical
player, league, rule version and season/career scope. Require strict kickoff and
game-ID order. A duplicate, corrected or earlier match cannot be applied to an
already counted state: rebuild from a checkpoint before the affected match.
The bounded cursor rejects immediate replay even if the last game's kickoff was
corrected. Detecting an older game's moved kickoff requires the worker's source/index
revision fence; the accumulator deliberately does not retain an unbounded set of
processed game IDs. A worker must never mix pages from different history revisions.
An absent final-roster player advances the processing cursor without contributing
an appearance or breaking personal streaks. Career runs may cross seasons; a
season accumulator rejects a different season.

Validate canonical facts at the evaluator boundary. Normalise ISO instants to UTC
before ordering. Credited goals carry explicit live, post-completion or unknown
timing provenance. Live timing requires a known third, nonnegative elapsed seconds,
a recorded third end and creation no later than match completion. Do not upgrade
unknown/synthetic imported timestamps into live evidence. Source adapters, durable
provenance capture, transaction fencing and replay delivery remain separate work.

Preserve original goal team context even when the scorer's final roster assignment
changes; this is existing supported correction behaviour. Personal goal/assist
credit follows the event while participation and team awards follow the final
roster. Hail Mary specifically checks the scoring team's transition and final win.
Preserve own-goal and cross-team assist semantics (INV-008); own goals add conceded
only (INV-005). Only tied-first teams draw (INV-006).

Unknown timing leaves aggregate statistics intact. Affected counts are confirmed
lower bounds with partial assessability. Unknown goals do not enter the known
third timeline. A known concession disproves a clean third; unknown opponent
concessions may improve a defensive starting margin, allowing provable clean thirds
to count. Uncertain lead transitions are withheld, including indistinguishable
same-time events. Proven once-per-match feats remain certain despite extra unknown
personal events. Earlier uncertainty remains in cumulative progress until a source
correction rebuilds the affected history.

Emit every crossed milestone with stable identity (player, league, scope/season,
class, ordinal), original match completion date, source revision and rule version.
The persistence slice must add calculation time and invalidation/reinstatement
audit history, and must not confuse this pure evaluator with a durable ledger.
No XP or levels are calculated.

## Alternatives and consequences

Mutating an old accumulator after a correction would corrupt later streaks and
milestone dates. Treating unknown times as zero would invent opening badges. Using
final-roster team for historical goal transitions could invent Hail Mary awards.
These alternatives are rejected. Conservative uncertainty can delay some temporal
unlocks until better evidence exists, while preserving assessable statistics.

## Failure and reversal

Malformed facts, mixed checkpoint context and duplicate/out-of-order input fail
before publishing any state. Evaluation does not mutate its inputs. Workers must
retain the previous published revision when derivation fails, expose stale status,
and use retry/dead-letter recovery; this slice adds no worker or live route.
Revert the unused evaluator to roll back this slice without changing source data.

## Evidence

`api/src/tests/achievement-evaluator.test.ts` covers rules, boundaries, uncertainty,
streaks and correction rebuilds. Independent rules and history/architecture reviews
are required before publishing this child PR. INV-001/002 remain unchanged: safe
unlock projections omit internal evidence and no new read/write authority is added.
