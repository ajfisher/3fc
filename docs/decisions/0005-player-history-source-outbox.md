# ADR 0005: Atomic player history source revisions and work markers

- Status: Accepted
- Date: 2026-10-03
- Context: M3-10 delivery, following the generation foundation in PR #206

## Decision

Record required player-history recalculation inside the same DynamoDB transaction
as the authoritative source mutation. Append two constant-size actions: replace
the league's `HISTORY_SOURCE` with a fresh UUID revision, and insert an immutable
`HISTORY_WORK#{revision}` marker in that league partition. The marker includes
only version, scope identifiers, mutation reason and creation time. It carries no
name, email, owner-account data, scoring payload or portrait.

The source revision is an unconditional replacement. Existing game, goal, identity,
deletion and idempotency conditions still arbitrate the domain change. A global
league compare-and-swap would add conflicts between unrelated games without
improving correctness: DynamoDB serialises the atomic commits, every committed
change has its marker, and a generation can publish only against its captured
source revision. Transactions still share a physical source item and can conflict.
A bounded helper retries only DynamoDB's explicit no-commit transaction-conflict
errors, with three jittered backoffs and the identical transaction. Domain
condition failures, throttling, validation errors and ambiguous network failures
are not retried by this helper. Non-history transactions pass through unchanged.
Generate a new UUID on each mutation attempt; do not reuse a
previously committed token for a new mutation, even at an identical clock time.

Record work for completed-game finish/legacy repair, goal creation/correction/
deletion, final roster changes (including the direct reusable-player assignment
path), kickoff correction, identity consolidation and initial scope deletion.
Finished-team and goal-edit paths can also repair missing/stale final facts; those
repairs record work even when the goal credit is unchanged. Compare material raw
and normalised facts so normalisation cannot hide a coverage-restoring repair.
Name, colour and result calculation-time changes alone are not performance changes.
Unfinished goal changes are incorporated when their game finishes. Saved mutation
replays and no-op performance edits create no new marker. A failed transaction
changes neither the source nor the work obligation. Keep existing transaction
size checks, including consolidation preview, ahead of commit.

New goal records carry internal versioned timing provenance: live capture versus
post-completion addition. Corrections preserve that original classification and
creation time; audit snapshots and correction receipts retain the evidence. Do
not add provenance to old records by guessing from normalised timer defaults.
Existing public scoring responses omit this internal metadata.

## Coverage, freshness and processing responsibilities

A source revision is not a coverage or activation assertion. Readers stay disabled
until the new writer set has been deployed, old writers drained, complete source
coverage verified and history backfilled. Import operations bypass repository
writers and therefore require a verified activation/rebuild marker in their
operator workflow before profiles can treat imported history as complete.

The following slice installs a filtered DynamoDB Streams dispatcher and bounded
SQS worker. Successful queue delivery is not completion: retain the marker until
the obligation has been processed or durably superseded by equivalent work.
Recover missed delivery by querying pending markers, not by relying on the stream's
retention window. Scoring requests never evaluate history or wait for the worker.

Source, identity and control snapshots all fence generation publication. Generic
identity write versions and global identity epochs also change for non-performance
operations and unrelated leagues. They must not independently make an existing
profile permanently stale when no history job is due. Runtime freshness uses the
scoped history source revision and rule/coverage state; canonical resolution and
current presentation remain separate. Consolidation changes both canonical identity
and the league history revision atomically.

## Failure and rollback

If an outbox action fails, the source mutation fails under its existing retry/error
contract; never commit source first and repair a missing marker afterward. UUID
uniqueness and create-only markers prevent replacement of another obligation.
No dispatcher, queue or worker is enabled by this writer slice. Existing local
HTTP and Lambda handlers share the same repository writes and deployed API path.

Consumer failure leaves scoring available and durable pending work recoverable.
Once readers are active, rolling writers back requires disabling profile and
achievement exposure first; old writers cannot maintain the revision guarantee.
Retain markers, source data and prior generation/unlock history through rollback.

## Evidence

Helper tests assert the constant transaction shape, fresh matching revisions,
strict scope validation and private-field exclusion. Repository and consolidation
tests inspect real mutation transactions, rejected commits, no-op/replay behaviour
and retained timing provenance. Independent reviews cover the separate writers
before current-head CI, QA and review gates.
