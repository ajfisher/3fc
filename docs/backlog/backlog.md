# 3FC v0 Backlog (M0-M4)

Generated from `docs/backlog/backlog.json`.

## Epics

| ID | Title | Milestone | Child Count |
|---|---|---|---:|
| `EPIC-M0` | Platform Foundation | M0 Platform Foundation | 6 |
| `EPIC-M1` | Auth, ACL, Core Entities | M1 Auth, ACL, Core Entities | 7 |
| `EPIC-M2` | Live Match Operations | M2 Live Match Operations | 9 |
| `EPIC-M3` | Public Results and Season Stats | M3 Public Results and Season Stats | 6 |
| `EPIC-M4` | Notifications and Product Polish | M4 Notifications and Product Polish | 5 |

## Child Issues

| ID | Title | SP | Parent | Milestone | Depends On |
|---|---|---:|---|---|---|
| `M0-01` | Monorepo runtime/tooling bootstrap (app, api, shared contracts) | 3 | `EPIC-M0` | M0 Platform Foundation | - |
| `M0-02` | Docker Compose local stack (DynamoDB Local + fake SES + app + api) | 5 | `EPIC-M0` | M0 Platform Foundation | `M0-01` |
| `M0-03` | Makefile implementation (install/build/test/dev/deploy, ENV guard) | 3 | `EPIC-M0` | M0 Platform Foundation | `M0-01` |
| `M0-04` | Terraform application module skeleton for required AWS resources | 5 | `EPIC-M0` | M0 Platform Foundation | - |
| `M0-05` | Hello API lambda + API Gateway /v1/health + JSON structured logging | 3 | `EPIC-M0` | M0 Platform Foundation | `M0-01`, `M0-04` |
| `M0-06` | CI/CD workflows (PR checks, QA-ready deploy, main->prod deploy) | 5 | `EPIC-M0` | M0 Platform Foundation | `M0-03`, `M0-05` |
| `M1-01` | DynamoDB single-table schema + access pattern doc + repository layer | 8 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M0-05` |
| `M1-02` | Cognito User Pool + Hosted UI + Google/Facebook provider setup | 5 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M0-04` |
| `M1-03` | Magic-link auth flow (start/complete) with TTL tokens and SES | 8 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M1-01`, `M0-02` |
| `M1-04` | httpOnly cookie session integration across app+api | 5 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M1-02`, `M1-03` |
| `M1-05` | ACL model + middleware + creator-is-league-admin bootstrap | 5 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M1-01`, `M1-04` |
| `M1-06` | Core write endpoints: leagues, seasons, sessions, games | 8 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M1-01`, `M1-05` |
| `M1-07` | Setup UI flow for league/season/session/game creation | 5 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M1-06` |
| `M2-01` | Team defaults at season level + per-game override | 3 | `EPIC-M2` | M2 Live Match Operations | `M1-06` |
| `M2-02` | Player quick-create + QR join registration path into active game | 8 | `EPIC-M2` | M2 Live Match Operations | `M1-06`, `M2-01` |
| `M2-03` | Roster assignment endpoints + mobile setup UI (recent players + search) | 8 | `EPIC-M2` | M2 Live Match Operations | `M2-02` |
| `M2-04` | Third timer state machine (start/finish, stoppage display, server checks) | 8 | `EPIC-M2` | M2 Live Match Operations | `M1-06` |
| `M2-05` | Goal create API + scoring engine + rules validation | 8 | `EPIC-M2` | M2 Live Match Operations | `M2-03`, `M2-04` |
| `M2-06` | Goal edit/delete/undo-last + minimal admin audit entries | 5 | `EPIC-M2` | M2 Live Match Operations | `M2-05` |
| `M2-07` | Live game UI: add-goal flow, mini scoreboard, timeline editing | 5 | `EPIC-M2` | M2 Live Match Operations | `M2-05`, `M2-06` |
| `M2-08` | Finish game computation + winner resolution + status lock | 5 | `EPIC-M2` | M2 Live Match Operations | `M2-05` |
| `M2-09` | M2 quality pack (unit + contract + Playwright smoke) | 5 | `EPIC-M2` | M2 Live Match Operations | `M2-08` |
| `M3-01` | Public route resolution /{league}/{season}/{game} (slug/id support) | 5 | `EPIC-M3` | M3 Public Results and Season Stats | `M2-08` |
| `M3-02` | Public game results page (totals, thirds breakdown, timeline) | 5 | `EPIC-M3` | M3 Public Results and Season Stats | `M3-01` |
| `M3-03` | Season standings aggregation + API (wins/draws/losses ranking rule) | 8 | `EPIC-M3` | M3 Public Results and Season Stats | `M2-08` |
| `M3-04` | Player leaderboards (total goals, goals-per-match, own-goals separate) | 5 | `EPIC-M3` | M3 Public Results and Season Stats | `M3-03` |
| `M3-05` | Player claim flow and conflict handling | 8 | `EPIC-M3` | M3 Public Results and Season Stats | `M2-02`, `M1-04` |
| `M3-06` | Personal profile page (private stats, claimed identity context) | 3 | `EPIC-M3` | M3 Public Results and Season Stats | `M3-05`, `M3-04` |
| `M4-01` | Async game-finish notification pipeline (queue + worker) | 5 | `EPIC-M4` | M4 Notifications and Product Polish | `M2-08` |
| `M4-02` | SES email templates (summary + personal callouts + result link) | 5 | `EPIC-M4` | M4 Notifications and Product Polish | `M4-01` |
| `M4-03` | QR join UX polish and onboarding latency optimization | 5 | `EPIC-M4` | M4 Notifications and Product Polish | `M2-02` |
| `M4-04` | Observability pack (dashboards, alerts, failure drilldowns) | 5 | `EPIC-M4` | M4 Notifications and Product Polish | `M4-01`, `M4-02` |
| `M4-05` | Final security hardening (CSP, headers, cookie flags, permission review) | 3 | `EPIC-M4` | M4 Notifications and Product Polish | `M3-06` |

## Global Test Scenarios

- Winner computation across all tie patterns, including full draw.
- Own goal behavior increments conceding only and never any team scored.
- Assist validation enforces max 3, unique IDs, scorer excluded, any-team allowed.
- Undo last goal removes only latest event and preserves audit record.
- Timer transitions enforce start/finish semantics and stoppage formatting.
- Idempotency key behavior on goal writes and finish endpoint.
- ACL blocks non-admin mutation attempts.
- Magic-link lifecycle covers valid/expired/replayed/tampered links.
- QR join registration makes player immediately selectable in roster flow.
- Standings comparator ordering is deterministic for tied records.

## Assumptions

- Runtime defaults to current Node LTS + npm workspace tooling.
- AWS primary region remains ap-southeast-2.
- Single scorekeeper editing model in v0 (no multi-editor conflict support).
- Offline support remains out of scope for v0.
- Terraform state continues in existing S3+Dynamo locking backend.
- E2E tests are implemented during MVP but not required merge-gate checks initially.
