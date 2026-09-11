# 3FC Backlog

Generated from `docs/backlog/backlog.json`.

## Epics

| ID | Title | Milestone | Child Count |
|---|---|---|---:|
| `EPIC-M0` | Platform Foundation | M0 Platform Foundation | 6 |
| `EPIC-M1` | Auth, ACL, Core Entities | M1 Auth, ACL, Core Entities | 13 |
| `EPIC-M2` | Live Match Operations | M2 Live Match Operations | 9 |
| `EPIC-M3` | Public Results and Season Stats | M3 Public Results and Season Stats | 9 |
| `EPIC-M4` | Notifications and Product Polish | M4 Notifications and Product Polish | 5 |
| `EPIC-REV` | Risk-Based Pull Request Review System | Review System Rollout | 6 |
| `EPIC-UX` | Mobile-First Frontend Redesign | UX Mobile-First Frontend Redesign | 8 |
| `EPIC-PLAYER` | Reusable players and profile linking | Reusable Players and Profile Linking | 5 |

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
| `M1-07` | Setup UI flow for league/season/session/game creation | 5 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M1-06`, `M1-08` |
| `M1-08` | Create base UI structure and system | 5 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M0-01` |
| `M2-01` | Team defaults at season level + per-game override | 3 | `EPIC-M2` | M2 Live Match Operations | `M1-06` |
| `M2-02` | Player quick-create + QR join registration path into active game | 8 | `EPIC-M2` | M2 Live Match Operations | `M1-06`, `M2-01` |
| `M2-03` | Roster assignment endpoints + mobile setup UI (recent players + search) | 8 | `EPIC-M2` | M2 Live Match Operations | `M2-02` |
| `M2-04` | Third timer state machine (start/finish, stoppage display, server checks) | 8 | `EPIC-M2` | M2 Live Match Operations | `M1-06` |
| `M2-05` | Goal create API + scoring engine + rules validation | 8 | `EPIC-M2` | M2 Live Match Operations | `M2-03`, `M2-04` |
| `M2-06` | Goal edit/delete/undo-last + minimal admin audit entries | 5 | `EPIC-M2` | M2 Live Match Operations | `M2-05` |
| `M2-07` | Live game UI: add-goal flow, mini scoreboard, timeline editing | 5 | `EPIC-M2` | M2 Live Match Operations | `M2-05`, `M2-06` |
| `M2-08` | Finish game computation + winner resolution + status lock | 5 | `EPIC-M2` | M2 Live Match Operations | `M2-05` |
| `M2-09` | M2 quality pack (unit + contract + Playwright smoke) | 5 | `EPIC-M2` | M2 Live Match Operations | `M2-08` |
| `M3-01` | Public route resolution /{league}/{season}/{game} (slug/id support) | 5 | `EPIC-M3` | M3 Public Results and Season Stats | `M2-08`, `M3-07` |
| `M3-02` | Public game results page (totals, thirds breakdown, timeline) | 5 | `EPIC-M3` | M3 Public Results and Season Stats | `M3-01` |
| `M3-03` | Season standings aggregation + API (wins/draws/losses ranking rule) | 8 | `EPIC-M3` | M3 Public Results and Season Stats | `M2-08`, `M3-07` |
| `M3-04` | Player leaderboards (total goals, goals-per-match, own-goals separate) | 5 | `EPIC-M3` | M3 Public Results and Season Stats | `M3-03` |
| `M3-05` | Player claim flow and conflict handling | 8 | `EPIC-M3` | M3 Public Results and Season Stats | `M2-02`, `M1-04`, `M3-07` |
| `M3-06` | Personal profile page (private stats, claimed identity context) | 3 | `EPIC-M3` | M3 Public Results and Season Stats | `M3-05`, `M3-04`, `M3-08` |
| `M4-01` | Async game-finish notification pipeline (queue + worker) | 5 | `EPIC-M4` | M4 Notifications and Product Polish | `M2-08` |
| `M4-02` | SES email templates (summary + personal callouts + result link) | 5 | `EPIC-M4` | M4 Notifications and Product Polish | `M4-01` |
| `M4-03` | QR join UX polish and onboarding latency optimization | 5 | `EPIC-M4` | M4 Notifications and Product Polish | `M2-02`, `M3-09` |
| `M4-04` | Observability pack (dashboards, alerts, failure drilldowns) | 5 | `EPIC-M4` | M4 Notifications and Product Polish | `M4-01`, `M4-02` |
| `M4-05` | Final security hardening (CSP, headers, cookie flags, permission review) | 3 | `EPIC-M4` | M4 Notifications and Product Polish | `M3-06` |
| `REV-01` | Review packet, invariants, ADRs, and agent guidance | 5 | `EPIC-REV` | Review System Rollout | - |
| `REV-02` | Deterministic review policy evaluator and fixtures | 8 | `EPIC-REV` | Review System Rollout | `REV-01` |
| `REV-03` | Observe-mode GitHub review gate and Codex cloud signal | 8 | `EPIC-REV` | Review System Rollout | `REV-02` |
| `REV-04` | Observe review results and tune policy | 3 | `EPIC-REV` | Review System Rollout | `REV-03` |
| `REV-05` | Enforce medium and high-risk review requirements | 3 | `EPIC-REV` | Review System Rollout | `REV-04` |
| `REV-06` | Evaluate low-risk review relaxation and dashboard | 5 | `EPIC-REV` | Review System Rollout | `REV-05` |
| `M1-09` | Migrate app frontend runtime to Astro/Vite | 8 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M1-07` |
| `M1-10` | Deploy web app site artifacts to QA and prod | 5 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M0-06`, `M1-08` |
| `M1-11` | Add HEAD support for /v1/health | 1 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M0-05` |
| `M1-12` | Manage SES sender domain in Terraform | 3 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M0-04`, `M1-03` |
| `M1-13` | Add sign-out flow and invalidate the active session | 5 | `EPIC-M1` | M1 Auth, ACL, Core Entities | `M1-04`, `UX-01` |
| `UX-00` | Reconcile redesign specification, GitHub backlog and acceptance map | 3 | `EPIC-UX` | UX Mobile-First Frontend Redesign | - |
| `UX-01` | Establish mobile design, content and visibility foundation | 5 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-00` |
| `UX-02` | Redesign organiser shell, lists and creation forms | 5 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-01`, `M1-13` |
| `UX-03` | Redesign game overview, navigation and teams-first roster | 8 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-02` |
| `UX-07` | Replace management accordions with consistent kebab action menus | 5 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-03` |
| `UX-04` | Redesign focused live scoring and goal feedback | 8 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-07` |
| `UX-05` | Redesign authenticated results and existing entry journeys | 8 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-04` |
| `UX-08` | Polish match navigation, correction exit and match-day presentation | 5 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-05`, `UX-07` |
| `UX-09` | Identify joining players and show them directly in Unassigned | 5 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-08` |
| `UX-10` | Refresh other clients after match updates without disrupting local work | 8 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-09` |
| `UX-06` | Complete cross-stack mobile, role and release-readiness acceptance | 5 | `EPIC-UX` | UX Mobile-First Frontend Redesign | `UX-01`, `M1-13`, `UX-02`, `UX-03`, `UX-07`, `UX-04`, `UX-05` |
| `M3-07` | Harden player ownership eligibility before portal expansion | 8 | `EPIC-M3` | M3 Public Results and Season Stats | `M2-02`, `M1-04`, `PLAYER-00` |
| `M3-08` | Add bounded linked-player history and participant home | 8 | `EPIC-M3` | M3 Public Results and Season Stats | `M3-05`, `M3-01` |
| `M3-09` | Add safe join and organiser-invite context reads | 5 | `EPIC-M3` | M3 Public Results and Season Stats | `M3-07`, `M3-01` |
| `PLAYER-00` | Specify reusable-player delivery and reconcile backlog | 3 | `EPIC-PLAYER` | Reusable Players and Profile Linking | - |
| `PLAYER-01` | Add league player directory and reusable game assignment | 8 | `EPIC-PLAYER` | Reusable Players and Profile Linking | `M3-07` |
| `PLAYER-02` | Consolidate duplicate player profiles with owner approval | 8 | `EPIC-PLAYER` | Reusable Players and Profile Linking | `PLAYER-01` |
| `PLAYER-03` | Reuse linked identities when returning players join | 5 | `EPIC-PLAYER` | Reusable Players and Profile Linking | `PLAYER-02` |
| `PLAYER-04` | Complete player-identity acceptance and migration handoff | 5 | `EPIC-PLAYER` | Reusable Players and Profile Linking | `PLAYER-03` |

## Delivery Tracking

As-of planning metadata, not fresh test results or issue-closure evidence. See [frontend redesign](../design/frontend-redesign.md).

| ID | Wave | Status | GitHub | Branch |
|---|---|---|---|---|
| `M2-03` | partial-existing | partial | [#25](https://github.com/ajfisher/3fc/issues/25) | - |
| `M2-06` | partial-existing | partial | [#28](https://github.com/ajfisher/3fc/issues/28) | - |
| `M3-01` | deferred-player-portal | planned | [#32](https://github.com/ajfisher/3fc/issues/32) | - |
| `M3-02` | deferred-player-portal | planned | [#33](https://github.com/ajfisher/3fc/issues/33) | - |
| `M3-03` | deferred-player-portal | planned | [#34](https://github.com/ajfisher/3fc/issues/34) | - |
| `M3-04` | deferred-player-portal | planned | [#35](https://github.com/ajfisher/3fc/issues/35) | - |
| `M3-05` | deferred-player-portal | partial | [#36](https://github.com/ajfisher/3fc/issues/36) | - |
| `M3-06` | deferred-player-portal | planned | [#37](https://github.com/ajfisher/3fc/issues/37) | - |
| `M4-03` | partial-existing | partial | [#40](https://github.com/ajfisher/3fc/issues/40) | - |
| `M1-09` | separate | planned | [#68](https://github.com/ajfisher/3fc/issues/68) | - |
| `M1-10` | historical | merged | [#76](https://github.com/ajfisher/3fc/issues/76) | - |
| `M1-11` | separate | planned | [#78](https://github.com/ajfisher/3fc/issues/78) | - |
| `M1-12` | historical | merged | [#79](https://github.com/ajfisher/3fc/issues/79) | - |
| `M1-13` | frontend-stack | review-ready | [#114](https://github.com/ajfisher/3fc/issues/114) | codex/auth-sign-out |
| `UX-00` | frontend-stack | review-ready | [#131](https://github.com/ajfisher/3fc/issues/131) | codex/design-delivery-backlog |
| `UX-01` | frontend-stack | review-ready | [#132](https://github.com/ajfisher/3fc/issues/132) | codex/design-foundation |
| `UX-02` | frontend-stack | review-ready | [#133](https://github.com/ajfisher/3fc/issues/133) | codex/design-organiser-shell |
| `UX-03` | frontend-stack | review-ready | [#134](https://github.com/ajfisher/3fc/issues/134) | codex/design-match-roster |
| `UX-07` | frontend-stack | review-ready | [#147](https://github.com/ajfisher/3fc/issues/147) | codex/design-action-menus |
| `UX-04` | frontend-stack | review-ready | [#135](https://github.com/ajfisher/3fc/issues/135) | codex/design-live-scoring |
| `UX-05` | frontend-stack | implemented | [#136](https://github.com/ajfisher/3fc/issues/136) | codex/design-results-entry |
| `UX-08` | frontend-stack | implemented | [#151](https://github.com/ajfisher/3fc/issues/151) | codex/design-match-flow-polish |
| `UX-09` | frontend-stack | implemented | [#152](https://github.com/ajfisher/3fc/issues/152) | codex/design-join-unassigned |
| `UX-10` | frontend-stack | implemented | [#153](https://github.com/ajfisher/3fc/issues/153) | codex/design-match-refresh |
| `UX-06` | frontend-stack | partial | [#137](https://github.com/ajfisher/3fc/issues/137) | codex/design-results-entry |
| `M3-07` | reusable-players | planned | [#138](https://github.com/ajfisher/3fc/issues/138) | codex/player-claim-proof |
| `M3-08` | deferred-player-portal | planned | [#139](https://github.com/ajfisher/3fc/issues/139) | - |
| `M3-09` | deferred-player-portal | planned | [#140](https://github.com/ajfisher/3fc/issues/140) | - |
| `PLAYER-00` | reusable-players | planned | [#158](https://github.com/ajfisher/3fc/issues/158) | codex/player-identity-backlog |
| `PLAYER-01` | reusable-players | in-progress | [#159](https://github.com/ajfisher/3fc/issues/159) | codex/league-player-directory |
| `PLAYER-02` | reusable-players | in-progress | [#160](https://github.com/ajfisher/3fc/issues/160) | codex/player-consolidation |
| `PLAYER-03` | reusable-players | planned | [#161](https://github.com/ajfisher/3fc/issues/161) | codex/returning-player-join |
| `PLAYER-04` | reusable-players | planned | [#162](https://github.com/ajfisher/3fc/issues/162) | codex/player-identity-acceptance |

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
- 2026-09-07 approved delivery: frontend redesign UX-00..UX-06 plus M1-13 sign-out; new public/player portal and performance work is explicitly deferred.
- Players are added and assigned on the day, including during play; retain this workflow and add no attendance/no-show feature. Future played counts use team membership in distinct finished games.
- Delivery metadata is an as-of planning/evidence inventory, not proof that tests were rerun or a GitHub issue can be closed. Existing merged issue states remain unchanged.
- 2026-09-10 AJ activates reusable-player stack PLAYER-00..04 plus existing M3-07: league-only consolidation, private shareable claims, block overlap/competing-owner conflicts; public results/performance remain deferred.
