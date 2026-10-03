# ADR 0007: League-visible player profiles and bounded read projections

- Status: Accepted implementation of AJ's approved player-profile plan
- Date: 2026-10-03

## Authority and privacy

A signed-in account may read a player in a league through an existing league ACL
or verified ownership of a canonical player participating in that league. Participant
access grants no management rights. A selected viewer player is only a lookup hint:
the server resolves canonical identity, verifies the canonical profile's claim against
session-derived account identifiers, and checks active directory and league membership.
League administrators, scorekeepers and viewers do not become profile owners.

Private `/v1/player-access` discovery uses bounded claim-index pages and canonical
ownership checks. Its cursor binds the account, claims revision, league directory and
identity-control snapshot. Empty filtered pages retain their continuation. Returned
players contain display identity only. Claims indexes and nickname matches never
constitute ownership proof. No caller-supplied account identifier is accepted.
Each page enumerates at most twenty raw claim rows. A bounded lookup selects one
representative claim per canonical player across the verified account identifiers:
prefer a canonical-root claim, otherwise a stable alias claim from the root's
at-most-twenty members. Only that representative emits the player, including across
page and namespace boundaries. Claims-revision and root-closure fences cover these
lookups; the cursor never grows with the number of previously returned players.

Performance, history and achievement responses are strict allowlists. Canonical
claim records, account identifiers, transaction fences and raw history staging stay
inside the repository boundary. Every response is `no-store`; private account details
will use a separate owner-only interface in the owner-editing slice. The catalogue
contains nonprivate rules/artwork and needs only sign-in and the achievements flag.

## Consistent, bounded reads

Local HTTP and Lambda use one validated route handler and the same repository
services. Opaque player identifiers use fixed routes and query parameters decoded
exactly once. A final transaction checks the authority and history snapshots together;
a concurrent correction, revocation or identity change cannot return a mixed response.

Only revision-consistent, complete publications provide totals. Missing, stale or
unavailable data is explicit and is not replaced with zero. Match and unlock history
use opaque generation-bound cursors with at most twenty entries per page. The browser
never loads the league's complete source history. All previous milestone awards remain
available through pagination even though the card shows only selected highest tiers.
First-unlock metadata is retained independently; legacy metadata without a first-unlock
map is unknown until replay reconstructs it.

The profile preserves an explicitly supplied league season, otherwise selects its latest
played season. With no appearances, it uses a worker-published latest-season record.
A bounded worker phase enumerates season metadata and records complete coverage before
publishing the fallback. Rank seasons by `startsOn`, using the creation date when absent or a legacy value is not a calendar date,
then creation timestamp and stable season ID. Nested team/session rows are not seasons.
New-season creation atomically records history work; retries do not duplicate it.
Readers fetch labels only for published played-season IDs and the selected/default season.

## Rollout and reversal

`PLAYER_PROFILES_ENABLED`, `PLAYER_ACHIEVEMENTS_ENABLED` and
`PLAYER_OWNER_EDITING_ENABLED` are independently validated deployment switches, all
false by default. API manifests and final live verification include the switches so
configuration drift cannot masquerade as the accepted deployment. This slice implements
read interfaces and season selection; it does not enable owner mutation or ship the UI.
Disable exposure to roll back without changing source records or achievement audit history.

## Invariants and evidence

INV-001/002/004/009 govern the privacy, authority, storage and session boundaries.
INV-005/006/008 remain in the shared evaluator and scoring source. Read/authority,
route parity, cursor, season coverage, first-unlock and deployment-switch tests accompany
this decision. Parent worker and writers retain responsibility for durable correction work.
