# DynamoDB Single-Table Design (M1-01)

This document defines the baseline key structure and access patterns for the
3FC application table.

## Table

- Table name: environment-specific (`3fc-<env>-app`)
- Partition key: `pk` (string)
- Sort key: `sk` (string)
- Billing mode: on-demand

## Core Key Patterns

Disabled-mode proof-bearing joins also write an immutable
`GAME#<gameId> / JOIN_RECEIPT#<playerId>` (`gameJoinReceipt`). It records the
request hash and the original no-proof decision atomically with registration.
It contains no bearer secret, has no TTL, and is separate from mutable roster
membership. Re-enabling linking cannot retroactively mint proof on replay.

- League metadata:
  - `pk=LEAGUE#{leagueId}`
  - `sk=METADATA`
- Season:
  - `pk=LEAGUE#{leagueId}`
  - `sk=SEASON#{seasonId}`
- Season lookup mirror (for ACL scope resolution):
  - `pk=SEASON#{seasonId}`
  - `sk=METADATA`
- Season team:
  - `pk=LEAGUE#{leagueId}`
  - `sk=SEASON#{seasonId}#TEAM#{teamId}`
  - canonical scoped season team defaults used when creating games
- Session:
  - `pk=LEAGUE#{leagueId}`
  - `sk=SEASON#{seasonId}#SESSION#{sessionId}`
  - canonical scoped season session/day owned by the league season
- Legacy season team template:
  - `pk=SEASON#{seasonId}`
  - `sk=TEAM#{teamId}`
  - compatibility read/write path during the scoped-key migration
  - scoped reads only accept templates with row-level `leagueId` provenance
    after atomically validating the requested scoped season exists
  - scoped season deletion removes owned legacy templates in the same
    conditional cleanup transaction as the season mirror
- Legacy session:
  - `pk=SEASON#{seasonId}`
  - `sk=SESSION#{sessionId}`
  - compatibility read/write path during the scoped-key migration
  - scoped reads accept row-attributed sessions, or provenance-less legacy
    sessions only while the global season mirror still belongs to the requested
    league
  - scoped session creation writes rollback-compatible legacy rows under the
    same mirror ownership rule and only when existing legacy rows are absent,
    provenance-less under that mirror, or already carry matching row-level
    `leagueId` provenance
  - row-attributed legacy session rows remain cleanup targets for that league
    even if another league later replaces the global season mirror
- Session lookup mirror (for ACL scope resolution):
  - `pk=SESSION#{sessionId}`
  - `sk=METADATA`
- Game metadata:
  - `pk=GAME#{gameId}`
  - `sk=METADATA`
  - stores generated or custom `joinCode`, game status, timer segments, `finishedAt`, and final `result`
- Join code lookup:
  - `pk=JOIN_CODE#{joinCode}`
  - `sk=METADATA`
  - maps a QR/join code to its `gameId`; finished games keep the lookup so late players can join and claim their profile
- League organiser invite:
  - `pk=LEAGUE_INVITE#{inviteCode}`
  - `sk=METADATA`
  - maps an organiser invite code to its league, `kind` (`share` or `email`), optional email restriction, creator, and acceptance state
  - `kind=share` invites are reusable league share codes and are not consumed on accept
  - `kind=email` invites are one-time, email-restricted, and are consumed on accept
  - deleting a league invalidates organiser invite records for that league
- League organiser share invite pointer:
  - `pk=LEAGUE#{leagueId}`
  - `sk=INVITE#ORGANISER_SHARE`
  - points each league at its active reusable organiser share invite code
  - deleted with the league so old share codes cannot target a replacement league id
- Goal event timeline:
  - `pk=GAME#{gameId}`
  - `sk=GOAL#{third}#{gameMinuteSortable}#{elapsedSecondsSortable}#{eventId}`
- Goal event id marker:
  - `pk=GAME#{gameId}`
  - `sk=GOAL_EVENT#{eventId}`
- Goal correction state:
  - `pk=GAME#{gameId}`
  - `sk=GOAL_STATE`
- Goal correction operation marker:
  - `pk=GAME#{gameId}`
  - `sk=GOAL_CORRECTION#{operationId}`
- Goal audit entry:
  - `pk=GAME#{gameId}`
  - `sk=AUDIT#GOAL#{createdAt}#{auditId}`
- Roster assignment:
  - `pk=GAME#{gameId}`
  - `sk=ROSTER#{teamId}#{playerId}`
- Session -> game index:
  - `pk=SESSION#{sessionId}`
  - `sk=GAME#{gameStartTs}#{gameId}`
- League ACL grants:
  - `pk=LEAGUE#{leagueId}`
  - `sk=ACL#USER#{userId}`
- Player profile:
  - `pk=PLAYER#{playerId}`
  - `sk=PROFILE`
- Private registration proof or directed profile invitation:
  - `pk=PLAYER_PROOF#{proofId}`
  - `sk=METADATA`
  - stores a SHA-256 verifier, never the bearer secret; binds exact player,
    registration/game, league and profile revision, plus the issuer's exact admin
    ACL identity for an invitation
  - pending/revoked proofs retain the persisted seven-day expiry and TTL;
    consumed receipts atomically lose TTL and retain their original owner/result
  - ownership acquisition updates profile, user-player index and consumed proof
    in one transaction with current context/authority checks
- Active directed profile invitation:
  - `pk=PLAYER#{playerId}`
  - `sk=CLAIM_INVITATION`
  - retains proof ID and expiry; replacement conditionally names this predecessor
    so stale issuance/revocation cannot acquire a different identity
  - does not grant league permissions; no canonical aliases are introduced by
    this proof feature (see `docs/runbooks/player-claim-proof.md`)

`gameMinuteSortable` is zero-padded to preserve lexical ordering.

Persisted join codes are bearer codes generated randomly at game creation unless
an organizer supplies a validated custom code. Deterministic join-code fallback
exists only to normalize legacy game records before repair replaces missing
lookup ownership.

## Player identity and reusable directory (additive cutover)

`PLAYER_IDENTITY / CONTROL` owns compatible/paused/fenced writer mode, coverage
and epoch. All identity and membership writers condition on it. The operator
runbook in `docs/runbooks/player-identity-directory.md` is required before marking
coverage verified; API traffic cannot certify its own coverage.

| Partition | Sort key | Purpose |
| --- | --- | --- |
| `PLAYER#{originalId}` | `IDENTITY` | Canonical root, complete member IDs, display/former names and identity/write revisions |
| `PLAYER#{originalId}` | `GAME#{digest}`, `SEASON#{digest}`, `LEAGUE#{digest}` | Reverse membership; original identifiers remain in the payload |
| `LEAGUE#{leagueId}` | `PLAYER#{digest}` | Private reusable-player directory with verified season context |
| `LEAGUE#{leagueId}` | `DELETION` | Initiating account and bounded cleanup checkpoint; completed receipt preserves DELETE-only retry |
| `PLAYER_MIGRATION#{migrationId}` | `AUDIT`, `ATTEMPT#{epoch}` | Audited progress and archived blocked attempts |

Projection digests are SHA-256 of the JSON-encoded identifier tuple, generated
by the shared identity key helpers. Never parse a digest as an original ID.
Deletion tombstones retain scope needed to verify historical membership.
Profiles, registrations, roster entries and goal events retain original IDs;
canonical readers must resolve aliases without rewriting those historical keys.

Consolidation proposals use `PLAYER_CONSOLIDATION#{proposalId} / PROPOSAL`, with
an immutable proposal digest, exact selected roots/member snapshots, initiating
organiser, affected owner, original coverage epoch, expiry and decision state.
Only the affected owner can approve additions to a claimed identity. The commit
atomically changes identity sidecars, active directory rows and ownership indexes
and stores `AUDIT` under the same partition. The audit includes before/after
identities and index changes; the committed proposal is the retry receipt.
Neither record is a bearer credential; authenticated authority is checked on reads.
No historical PROFILE, registration, roster or goal record is rewritten.

Consolidated roots retain every underlying member (maximum20). Alias sidecars
point directly to the retained root and have no member list. The retained root's
directory entry is active; alias directory rows remain inactive. Reverse game and
season memberships remain attached to original profiles and are read as a union.
Future registrations use the root, while old-game actions resolve to that game's
unique original registration. Disabling new consolidation must retain these reads.

The existing account claim index stays `USER#{userId} / PLAYER#{playerId}` when
that sort key fits 1,024 UTF-8 bytes. An oversized but valid standalone profile
uses the disjoint `PLAYER_HASH#{sha256(playerId)}` namespace and stores the exact
original ID in its `playerClaim` payload. Returning-player enumeration and
consolidation reconciliation must read both namespaces, validate the payload and
resolve the complete canonical group. Never reconstruct an ID from an index key.

Readable profile IDs may occupy the full 2,048-byte `PLAYER#` partition-key
budget. Game registration and roster writes separately enforce their 1,024-byte
sort-key budgets and return controlled errors before any partial write. Reject
malformed Unicode rather than silently replacing it during UTF-8 encoding.

## Item Envelope

Repository-managed records are written with:

- `pk`
- `sk`
- `entityType`
- `createdAt`
- `updatedAt`
- `data` (JSON payload string)

This keeps key semantics explicit while allowing entity payload evolution
without schema rewrites at this stage.

## Supported Access Patterns (M1 Baseline)

- Create/read league metadata.
- Create/list seasons for a league.
- Create/list scoped teams for a league season, with owned legacy template
  compatibility during migration.
- Create/list scoped sessions for a league season, with global-mirror-gated
  legacy session compatibility during migration.
- Create/read game metadata.
- Resolve join code to game for player self-registration.
- Create/accept reusable share organiser invites and one-time email organiser invites, then grant league admin ACL entries.
- Finish game and store deterministic winner/draw result on game metadata.
- Link/list games for a session (`SESSION#{sessionId}` query).
- Create/read player profile.
- Grant/list league ACL entries.
- Assign/list game roster entries.
- Create/list goal events for a game in deterministic timeline order.

## Repository

Implementation lives in:

- `api/src/data/repository.ts`
- `api/src/data/keys.ts`
- `api/src/data/types.ts`

Tests live in:

- `api/src/tests/repository.test.ts`
