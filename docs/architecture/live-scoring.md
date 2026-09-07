# Live-scoring presentation and recovery ownership

Scope: UX-04 (#135), based on the gated action-menu PR #148 at
`ce429963d4b667a67a0123e5c1ff3094aa43dc7f`. This slice changes the existing
frontend, not scoring rules, API contracts, server authority or durable storage.

## Presentation and actors

A single document-flow surface coordinates the scoreboard and server-owned
clock. Red, Blue and Yellow remain in order. Conceded is primary and Scored is
separately labelled; changing visual order or emphasis never changes arithmetic.
Goal entry is a native form with labelled team radio groups, a roster scorer
select and optional assist checkboxes. The latest log retains dot-only team
relationships with accessible names, full player names and thirds indicators.

Existing league-scoped scorers and organisers may score unfinished games.
Finished corrections still require an organiser and explicit correction entry.
Claiming a player does not grant scoring access. Both rendering and handlers
check the current capability; backend authorization remains authoritative.

## Goal mutation ownership

One unresolved operation owns its kind, method, path, serialized body,
idempotency key and event identity. Undo additionally captures the expected
latest event. A retry cannot use edited fields, a new event, a newer last goal
or a fresh key. Pending and uncertain operations block competing goal and clock
writes; read-only navigation remains available. There is no automatic retry.

A confirmed create/edit response clears the completed draft even when a
subsequent read fails. Delete/undo preserves an unrelated draft; it clears an
edit only when that same event was removed. A failed refresh must not turn a
confirmed save into an unconfirmed write.
Response loss is different: the original request remains available for explicit
retry. Unknown/idempotency conflicts cannot prove that no commit happened, and
a rejection after earlier uncertainty cannot establish the first attempt failed.

The record is local to the mounted page, not new durable or offline state.
Reloading reads the server and does not automatically replay a saved operation.
This does not introduce multi-scorekeeper editing or guarantee attribution of
another actor's concurrent actions.

## Clock recovery and reads

Start-third and finish-third are monotonic conditional transitions without an
idempotency wrapper. Do not retry a POST merely because its response was lost.
Capture the action and exact third, then reconcile through GET. Describe the
observed state without pretending a successful GET proves which request changed
it. A failed or negative read does not prove the original write failed.
Finish-game uses its existing idempotent contract with a captured stable key.
After a confirmed finish or replay, a fresh game read supplies the result. If
that read fails, the game remains confirmed finished but its result is shown as
unavailable, not replaced with an older replay snapshot.

Game reads and goal/scoreboard reads are separate snapshots. Replayed mutation
responses may contain older totals, so refresh current data rather than treating
the replay as the latest scoreboard. This slice does not add an atomic combined
read contract. Own goals still increase only conceded; assists retain unique
rostered IDs, no self-assist, any-team eligibility and a maximum of three.

Navigation revisions and logical focus ownership prevent delayed responses from
overriding a later destination or independent keyboard/pointer interaction,
including leaving and returning to the same view while a request is pending.

## Review, failure and rollback

Review INV-002 (authority), INV-003 (idempotency), INV-005 (own goals and tallies),
INV-006 (outcome), INV-008 (assists) and INV-009 (existing browser security).
Architecture/security preparation verified the existing backend contracts before
implementation; independent final reviews and executed evidence are recorded in
the PR packet and design acceptance map.

Rollback is redeployment of the validated parent frontend. No schema, API,
permission, dependency or deployment migration needs reversal. A UI rollback
does not undo a goal, correction or clock transition already committed. No
rollback deployment or physical-device approval is implied by this document.
