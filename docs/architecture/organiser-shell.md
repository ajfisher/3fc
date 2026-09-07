# Organiser shell and mutation ownership

Scope: UX-02 (#133), frontend and deployment smoke-copy changes only. Parent:
`a048602ee1f0730ccdc8325fd323183c656125c6` (reviewed sign-out). No new endpoint,
dependency, identity model, database addressing or role is introduced.

## Reads and authority

Home uses the existing authorised league list. It does not infer administrator
access from a creator ID, player claim or email, and does not request every
league's details. League rows are navigation, not an administrative control.

The league response's existing `access.role` controls management presentation.
Season loading reads its resolved parent league once for the real breadcrumb
name and the same authority. Missing, failed or non-administrator access leaves
management controls unavailable while permitted season/game reads remain usable.
This UI gate is not security enforcement: existing server session and league
checks still authorise every write, including when access changes after loading.

Scoped and legacy reads retain their existing ownership checks. Season deletion
uses the known league-scoped route, with no legacy mutation fallback. IDs and
stored values are unchanged. Date-only ranges use calendar dates; kickoff
timestamps are displayed in the browser's local timezone.

## Creation and retry

Native form submission has one synchronous request latch. Each creation attempt
captures its route, IDs, complete payload and idempotency key before the first
request. Repeated activation cannot start another in-flight operation. Uncertain
outcomes keep that attempt and explain that retry sends the original details,
not later edits. A confirmed rejection can release an attempt that was never
uncertain, allowing the user to correct the draft.

Game creation retains the existing session-then-game workflow. Both requests
are captured before awaiting either. A confirmed session response advances the
attempt; retry then sends only the game request. This is client request ownership
using the existing idempotency contract, not a new atomic backend transaction or
a claim that every possible server-side response-loss window is eliminated.
Closing a disclosure preserves the in-page draft and attempt; this slice does
not add durable browser storage or cross-reload recovery.

## Deletion and feedback

HTTP 204 confirms deletion even if a following list read fails. Remove that row
and report deletion plus refresh failure; never label it a failed deletion.
Page-local confirmed-deleted IDs filter stale list results, and render versions
prevent older responses replacing a newer view. Keyboard focus moves to the
next/previous remaining link or the list heading only while the deletion still
owns focus; external focus or pointer movement relinquishes that ownership.
Synchronous row redraw captures the currently focused surviving row/control at
the moment of replacement and restores its equivalent node and More state.
This does not restore an earlier request-time focus over a later user choice.
Uncertain DELETE outcomes do not trigger automatic mutation retries. Existing
confirmation and finished-game locks remain. Rare destructive actions live in
More, with a visible reason when a finished game cannot be deleted.

## Deployment, failure and rollback

Static and dynamic nested season shells use equivalent controls and forms.
The Home title change updates QA and production smoke assertions in this slice;
route, asset, sign-out and security checks remain. No QA or production deployment
policy or credential change is introduced.

Rollback redeploys the parent site together with its matching smoke assertions.
The API is unchanged by this slice and remains compatible with the parent UI.
No data rollback or migration is needed; completed creations/deletions are not
undone by a UI rollback. Actual rollback deployment is not claimed without an
executed run. Sign-out revocation remains in the parent.

Review explicitly covers INV-001 (no new public identity exposure), INV-002
(server authority retained), INV-003 (same key/payload retry ownership), INV-004
(league-scoped seasons) and INV-009 (unchanged session/CSP/security checks).
Acceptance tests and current-head CI/QA/Codex evidence belong in the PR packet.
