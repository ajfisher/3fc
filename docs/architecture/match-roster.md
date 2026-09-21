# Match viewing and roster interaction boundaries

Scope: the match roster UI, including safe scheduled-game player removal in
#184. Removal adds one authenticated write contract without changing player
identity, league roles, session semantics, attendance or public results.

## Distinct, overlapping actors

Viewing a match requires the existing league access. Claiming a player does not
grant that access. A viewer can read the assigned roster without requesting the
operator-only player-management endpoint. A scorer may create/assign players and
score an unfinished match; an organiser can also edit match details. Finished
roster and goal corrections remain organiser-only and require an explicit
editing action. Opening a destination never starts a third or writes a goal.

Organisers and scorers may remove an assigned or Unassigned player only while
the game is scheduled. The server rechecks the exact game, authority,
registration, all team slots, reverse membership and canonical identity fence in
one transaction. Live and finished games fail closed. A public player ID or an
account claim alone never grants removal authority.

The client checks the same capability at presentation and action boundaries,
remaining closed while league authority is unknown. This is usability and
defence in depth, not a substitute for the existing server checks on every
request. No match-specific scorer grant is created: promotion still applies to
all games in the named league, with the consequence confirmed before sending.

## Read ownership and privacy

`GET /v1/games/:gameId/roster` provides the assigned roster with public player
DTOs, without the `/players` 20-item cap. The existing repository query does not
paginate, so this does not promise an unlimited result. Keep that view
independently usable when operator enrichment fails.
For an organiser or scorer, the existing `/players` read supplies current-game
player candidates and is capped at 20 without pagination. There is no additional
client fan-out or invented pagination. Assigned names are searched locally; the one
bounded operator search supplies unassigned candidates. A capped response must
not imply an exhaustive list, and each assigned identity appears only once.

Roster-only DTOs do not establish claim status. On the existing admin `/players`
contract, a known returned player without an `access` object is unclaimed; the
same omission in a public roster or a scorer response is not that evidence.
Only verified admin enrichment may support the claim badge or promotion action.
Missing enrichment is not rendered as “Not claimed”, and no raw claimed user ID
is presented in the cards.

League/season names use bounded existing scoped reads. IDs remain reference
data, not a substitute for a name or a source of authority.

## Navigation and request ownership

Internal modes retain their IDs for existing controls: structure, players, run
and final. Readable Overview, Teams, Score and Results destinations map to them;
existing hashes remain compatible. Overview is the default for scheduled/live
games, Results for confirmed finished games. Results navigation must not imply
that finishing all thirds has itself finalised a game. Finish game remains an
explicit operation in the scoring journey until confirmed by the server.

Read-only destination changes preserve unfinished drafts. Browser history and
focus track the selected destination; timer ticks and late reads do not choose
a different mode. A finished score bookmark does not silently arm corrections.

Player creation uses one in-flight owner and a captured request identity.
Confirmed creation is distinct from a failed subsequent refresh. Only the
confirmed input is cleared; later typing and uncertain requests survive.
Transfers retain alternatives, one open disclosure and failed context. Response
generations reject obsolete search/roster results, and pending actions cannot
be activated again merely because their DOM row was redrawn.

Removal owns a single player and idempotency key from confirmation until the
outcome is settled. Exact retries replay an immutable receipt. Ambiguous failures
lock conflicting roster/scoring writes and offer retry with the same key or an
authoritative reload. A successful local removal is followed by a roster read;
that read may truthfully show a later re-add without replaying the delete. If a
later refresh fails after an uncertain attempt, the last observed row remains
visible but is explicitly labelled stale; presence alone does not prove re-add.

The authenticated removal route is
`DELETE /v1/games/{gameId}/player-registration?playerId={opaqueId}&registrationRevision={opaqueRevision}`.
The player identity is query data rather than a path segment because historical
opaque IDs may contain reserved path characters. It is URL-decoded exactly
once. Roster reads expose the registration revision that was rendered; the
confirmation freezes it and a stale transfer, removal/re-add or registration
replacement fails without deleting the newer row.

The transaction deletes only the game registration, any assignment and the
matching reverse game-membership row. It retains the reusable profile, claim,
aliases, league/season membership and all other matches. The receipt stores a
privacy-safe actor hash and role, not email, and public responses omit actor
data. Registration-bound claim proof remains stored to normal expiry but cannot
be redeemed after its required registration disappears. Goal creation and
correction transactions condition every selected scorer/assist registration,
so a scoring write cannot introduce a reference while that registration is
being removed. Removal brackets the complete strong history traversal with
strong goal-state reads, requires the same exact present/absent revision, then
conditions that revision in its transaction. A scoring write during or after
the history scan therefore forces removal to fail without deleting membership.

## Verification and rollback

Review INV-001 (identity privacy), INV-002 (server role enforcement), INV-003
(write/retry ownership), INV-004 (single-table ownership and scoped routes),
INV-008 (scoring references block deletion) and INV-009 (existing sessions, CSP
and local assets). Exercise
viewer/scorer/admin/combined/claimed-only/cross-league cases, capped results,
missing enrichment, long and duplicate names, late additions, stale responses,
failed transfers, uncertain creates and explicit finished corrections.

Rollback is a code redeploy and needs no schema, IAM or Terraform change.
Existing receipts are harmless to older readers, but committed removals are
intentional durable changes and are not automatically reversed. Actual
validation, current-head deployment and rollback evidence belong in the
versioned PR packet; no rollback deployment is implied here.
