# ADR 0008: Owner name changes and directory propagation

Status: accepted for implementation, 4 October 2026.

## Authority and private response

`GET/PATCH /v1/owner-player-profile?playerId=…` resolves the canonical identity and
checks its current `PROFILE.claimedByUserId` against verified session identifiers.
League roles grant no owner rights. The submitted ID is a lookup, never proof of
ownership. Reads and writes fence the identity control, canonical root, claim and
presentation snapshots. Consolidation and ownership changes therefore invalidate
an in-flight operation.

The read handler adds read-only email from the verified session after the owner
check. The repository, mutation response, durable receipt and directory job contain
no account-detail fields. All responses use `no-store` and `no-referrer`; this route
does not feed shared cards or performance responses. Existing session and origin
protection applies to PATCH. The local streaming parser and Lambda parser enforce
an 8 KiB request limit and share strict query/body/idempotency validation.

## Atomic name save

Names contain 1–80 characters after trimming and no control characters. Existing
bounded former-name history is retained; a full twenty-name history requires
organiser assistance rather than silently dropping historical search identities.
The expected revision covers presentation and ownership semantics, allowing
unrelated scoring writes without invalidating an open owner form. The final
transaction still checks the latest physical snapshots.

A changed name updates root `IDENTITY.displayName`, root `PROFILE.nickname` and
`PRESENTATION.nameRevision` together with an immutable request receipt and a name
work record. Historical player IDs, goals and game entries do not change. A no-op
save records its receipt without unnecessary directory work. Reusing a key for a
different request conflicts. A lost acknowledgement re-enters current canonical
ownership before replaying the saved response; it never reapplies an old name.
An exact committed receipt remains replayable during a processing/readiness pause;
only genuinely new saves need those gates. Current ownership is always rechecked.

## Durable propagation

The Streams dispatcher publishes hash-only references to the existing SQS worker.
Each step reads at most ten league-membership references for one canonical member.
The worker checks the current root, presentation and processing readiness, then
commits directory changes and its checkpoint atomically. It updates existing active
directories only; a tombstone proves when a deleted league may be skipped. Missing
live associations fail instead of claiming completion. Closure changes restart
the bounded traversal; superseded names and retired roots finish without writes.
New associations already copy the current canonical name under root write fences.

Directory revisions remain the existing freshness boundary. Their bridge can
schedule redundant history reconciliation after a name-only change; this is an
explicit initial throughput tradeoff rather than a second freshness mechanism.
The worker cannot write canonical `PLAYER#` records. IAM adds bounded BatchGet
reads and the `PLAYER_PROFILE_WORK#` family; it still has no Scan/Update/Delete.

`PLAYER_OWNER_EDITING_ENABLED` exposes the route. Name writes additionally require
`HISTORY_PROCESSING_ENABLED=true` and an activated, transaction-fenced history
readiness record. Reads remain available during a processing pause. Both local and
deployed paths use the same service and worker. The guarded history CLI provides
`profile-status` and bounded `profile-step` recovery; cloud runs retain exact-code,
account/table and deployment-freeze checks. Delivery failures remain retryable and
visible through the worker/DLQ monitoring already in place.
Deploy the compatible history consumer and stream filters before the API producer.
This prevents an old filter from advancing past a newly introduced work type.

## Rollback and remaining scope

Disable owner editing to stop exposure or disable processing to pause new saves
and worker advancement. Preserve canonical names, receipts and pending work;
resume from checkpoints after recovery. No destructive rollback is required.
Portrait decoding/storage and the owner screen follow in separate stacked slices.
This slice does not claim completion of the owner-editing issue.
