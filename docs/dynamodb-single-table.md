# DynamoDB Single-Table Design (M1-01)

This document defines the baseline key structure and access patterns for the
3FC application table.

## Table

- Table name: environment-specific (`3fc-<env>-app`)
- Partition key: `pk` (string)
- Sort key: `sk` (string)
- Billing mode: on-demand

## Core Key Patterns

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

`gameMinuteSortable` is zero-padded to preserve lexical ordering.

Persisted join codes are bearer codes generated randomly at game creation unless
an organizer supplies a validated custom code. Deterministic join-code fallback
exists only to normalize legacy game records before repair replaces missing
lookup ownership.

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
