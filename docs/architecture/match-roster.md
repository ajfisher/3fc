# Match viewing and roster interaction boundaries

Scope: UX-03 (#134), on the reviewed organiser parent
`85454e575c45827d63a7e99c6443f2f5f86c65db`. This is frontend work using existing
authenticated endpoints. No new player identity, role, session, attendance,
pagination or public-result contract is introduced.

## Distinct, overlapping actors

Viewing a match requires the existing league access. Claiming a player does not
grant that access. A viewer can read the assigned roster without requesting the
operator-only player-management endpoint. A scorer may create/assign players and
score an unfinished match; an organiser can also edit match details. Finished
roster and goal corrections remain organiser-only and require an explicit
editing action. Opening a destination never starts a third or writes a goal.

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

## Verification and rollback

Review INV-001 (identity privacy), INV-002 (server role enforcement), INV-003
(write/retry ownership), INV-004 (scoped routes), INV-005 (unchanged match rule
semantics) and INV-009 (existing sessions, CSP and local assets). Exercise
viewer/scorer/admin/combined/claimed-only/cross-league cases, capped results,
missing enrichment, long and duplicate names, late additions, stale responses,
failed transfers, uncertain creates and explicit finished corrections.

Redeploy the reviewed parent site to roll back this frontend. The API and data
formats are unchanged; no database or permission rollback is necessary. A site
rollback does not undo player additions, assignments or corrections already
committed. Actual validation, current-head deployment and rollback evidence
belong in the versioned PR packet; no rollback deployment is implied here.
