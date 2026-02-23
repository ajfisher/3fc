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
- Team:
  - `pk=SEASON#{seasonId}`
  - `sk=TEAM#{teamId}`
- Session:
  - `pk=SEASON#{seasonId}`
  - `sk=SESSION#{sessionId}`
- Session lookup mirror (for ACL scope resolution):
  - `pk=SESSION#{sessionId}`
  - `sk=METADATA`
- Game metadata:
  - `pk=GAME#{gameId}`
  - `sk=METADATA`
- Goal event timeline:
  - `pk=GAME#{gameId}`
  - `sk=GOAL#{third}#{gameMinuteSortable}#{eventId}`
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
- Create/list teams for a season.
- Create/list sessions for a season.
- Create/read game metadata.
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
