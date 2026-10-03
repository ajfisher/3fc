# ADR 0004: Revision-fenced player history generations

- Status: Accepted
- Date: 2026-10-03
- Context: M3-08 history foundation, M3-10 projections and M3-11 unlock persistence

## Decision

Build complete league-scoped player history into an immutable generation before
publishing a pointer to it. Resolve the canonical identity and its complete alias
closure first. Capture strongly consistent league, source-revision, identity and
identity-control snapshots; publication checks those snapshots transactionally.
Source records remain authoritative. Generations are derived data, never a new
source of scoring truth.

Enumerate every original member's reverse game references with bounded queries.
Read the complete roster, goals, audit evidence and team partitions for each match;
the existing bounded directory sample and non-paginated convenience queries cannot
establish career coverage. Reconcile goal-derived totals against stored team totals
and final results. Invalid aggregate data fails derivation; uncertain timing retains
valid aggregate statistics and makes affected temporal achievements unassessable.

Collection and evaluation have persisted checkpoints. Evaluate staged facts in UTC
kickoff order, using the SHA-256 digest of the opaque game ID as a deterministic
tie-breaker. Both the evaluator and storage use the same ordering helper. Hashing
keeps sort keys bounded even for long or non-ASCII identifiers. Each bounded step
is retryable; the completion state follows exhausted collection and evaluation,
not a caller assertion that history is complete.

Keep season and career summaries, a chronological appearance index and every
milestone, including earlier tiers hidden by a higher achievement. Publication is
an atomic pointer change after completion. Readers use a single published generation
and bind continuations to its scope; a newer generation invalidates old continuation
tokens rather than silently mixing revisions. A failed or stale worker leaves the
previous publication untouched.

Retain previous generations and append-only publication records. The active pointer
determines which awards are displayed. Retained milestone evidence and publication
transitions preserve invalidation and reinstatement history, calculation time,
original achievement date and stable unlock identity. Do not delete or TTL these
records as temporary work. Future storage compaction must preserve this audit trail.

## Source and delivery boundary

This foundation does not enable a runtime endpoint or claim that source writers
already maintain the new revision. It requires a versioned league `HISTORY_SOURCE`
record and verified identity coverage. The following slice must atomically change
that revision and a durable work marker on every relevant source mutation, then
deliver work through DynamoDB Streams and SQS. Deploy writers and readers before
backfilling or enabling profiles. No request-time table scans or browser fan-out
are permitted.

Historical timing is proven from original creation audit evidence, matching raw
timing fields and recorded third intervals. New writers will record explicit
versioned live/post-completion provenance and preserve it on correction/import.
Missing, contradictory or synthetic timing cannot become a timed unlock. An event
inserted after completion remains excluded even if its aggregate credit is valid.

## Alternatives and consequences

Appending corrections into an existing accumulator corrupts later streaks and
milestone dates. Publishing pages independently exposes mixed totals. Treating an
asynchronously maintained index as complete without a matching revision fence can
publish stale facts under a current revision. These alternatives are rejected.

Immutable full generations trade extra storage and rebuild work for simple,
auditable correction semantics. Query and transaction batches are bounded. Explicit
storage limits fail as unavailable rather than truncating totals. Optimising rebuild
checkpoints or retained storage is follow-up work and must keep the same guarantees.

## Failure, privacy and reversal

Source changes, consolidation, deletion or competing publication invalidate stale
work. Retries may complete immutable staging, but cannot restore a superseded
publication. Malformed or incomplete source history cannot publish complete totals.
The future read layer must compare freshness and enforce league visibility; this
internal store grants no authorisation and contains no private account fields.

Disable workers and feature exposure to roll back. Keep source data, prior
generations and publication history. This foundation has no active worker or route;
its introduction requires no production migration or feature activation.

## Evidence

Source and store tests exercise pagination, canonical context, timing evidence,
aggregate consistency, checkpoint retries and publication conditions. Independent
reviews challenge source completeness and concurrent/stale-worker safety. The
delivery record carries exact validation and current-head review evidence.
