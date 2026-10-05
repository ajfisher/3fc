# ADR 0006: Bounded history processing and explicit activation

- Status: Accepted
- Date: 2026-10-03
- Context: M3-10/M3-11, following the atomic source outbox in PR #207

## Decision

Terraform owns DynamoDB Streams, encrypted SQS queues, dead-letter queues,
dedicated least-privilege roles and operational alarms. Serverless owns the two
Lambda functions and disabled-by-default event mappings. The dispatcher accepts
three stream event classes: work inserts, job inserts/updates, and league directory
revision inserts/updates. The directory filter requires `LEAGUE#*` / `PLAYER_DIRECTORY`
keys and the `playerDirectoryRevision` entity type. It schedules reconciliation when
eligible players change after a prior sweep. The dispatcher sends validated
identifiers, never stored player facts, account information or checkpoints. The SQS
worker re-reads authority from the table. HTTP scoring never waits for derivation.

A league sweep enumerates the complete active canonical directory in bounded
pages and creates durable player jobs. A second verification pass proves every
publication matches the captured league source/readiness revisions before the
sweep can acknowledge work. Old markers can be satisfied by a newer complete
sweep; queue delivery alone cannot acknowledge a durable obligation. Directory
changes fence enumeration. Deleted leagues terminate work only with a valid
scope tombstone. Pending markers and failed jobs remain recoverable by keyed
queries independently of the stream retention period.

Collection persists immutable receipts and raw source pages, then resolves up to
25 consecutive rows with at most four uncached identities per step. Canonical
mapping caches bind the generation, member and full source context. Resolved
rows, mappings and the continuation receipt commit atomically under the same
fences. Every source partition must be exhausted before constructing a match.
Oversized or malformed history fails explicitly: collection budgets are 10,000
rows and 8 MiB per match, including resolved identity data. No truncation is
reported as complete history.

Each invocation advances up to eight durable steps or five seconds, retaining
15 seconds of Lambda time for completion. A step settles before another starts.
Unfinished work sends one continuation before acknowledging its SQS message;
failed sends preserve the original retry. All publication paths compare the
captured source, identity, readiness and previous publication. Failed source
jobs require explicit recovery after repair. Stale work cannot publish or revive
an invalid award. Prior generations and publication transitions retain the audit.

## Activation and operational authority

`PLAYER_HISTORY / CONTROL` is a separate global readiness record, not inferred
from a source token. Activation requires a validated writer/rule manifest and
verified identity coverage. Cloud operations require the exact clean reviewed
checkout, account, table, region, deployed API and worker fingerprints, drained
old writers, and a frozen deployment workflow with no queued deployment by default.
The incident-specific [stuck-run procedure](../player-history-operations.md#temporary-production-stuck-run-recovery)
permits only run 37241624452, after a newer accepted production main makes its
pinned pre-credential guard reject deployment. This explicit operator exception
changes deployment-exclusion evidence, not AWS authority or data ownership. Full
fingerprints are checked at start/end; API provenance and deployment exclusion are rechecked between
bounded steps at least every 30 seconds. The CLI shares the worker coordinator;
it introduces no public activation or repair endpoint. Local operations use the
same service against explicit local DynamoDB.

Identity migration atomically disables history readiness before changing source
coverage. Empty-destination season imports preserve a disabled readiness record
and reject an active one. Re-activation and a new league rebuild are required
after such source maintenance. Runtime freshness uses source/readiness/rule
revisions; generic identity epochs still fence in-flight work but do not alone
invalidate an already published unchanged league history.

Dry-run derivation writes an isolated resumable generation and compares career
totals, progress, assessability, streaks and highest milestones without moving
the active pointer. It explicitly reports `career-summary` scope; it does not
claim an exhaustive comparison of every season or earlier milestone. Comparison
ignores calculation/source bookkeeping while retaining semantic award changes.

## Failure, rollout and rollback

Provision QA resources, deploy disabled consumers and revision-aware writers,
drain older writers, then activate/backfill using reviewed deployment evidence.
Readers and feature flags follow in later slices. Monitor queue age, both dead
letter queues, Lambda errors, dispatcher iterator age, failed jobs and coverage.
Recovery replays persisted checkpoints; it never edits authoritative scoring
records. Disable feature exposure and consumers to roll back, preserving source
records, pending obligations and unlock audit history. AJ retains merge and
production release authority.

## Evidence

Collector, coordinator and transport tests exercise every bounded phase, alias
resolution, zero appearances, lost acknowledgements, concurrent deliveries,
source/directory changes, failed jobs, deleted scopes, recovery and non-publishing
comparisons. Deployment tests falsify mismatched roles, queues, hashes and mapping
configuration. Import tests preserve disabled readiness and reject active history.
Independent reviewers remain read-only; the primary serialises validation under
the 4 GiB process-tree ceiling.
