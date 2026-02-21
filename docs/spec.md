# 3FC Web App — Technical Spec (v0)

Clean, consolidated version of the technical spec. Canonical going forward.

## 1. Goals + constraints

- AWS-first, serverless where possible.
- Backend: modular Lambdas per domain/endpoint.
- Data: DynamoDB single-table.
- Auth: Cognito with Google + Facebook OAuth AND true email magic-link (no code
  entry).
- Frontend: minimal framework (Astro/Vite) with Web Components; vanilla JS
  islands.
- Tests from day one.

## 2. High-level architecture

- Static web app: S3 + CloudFront.
- API: API Gateway HTTP API → Lambda (Node.js + TypeScript).
- Auth: Cognito User Pool + Hosted UI (social) + custom passwordless (magic
  link).
- Email: SES for notifications (game finished).
- Observability: CloudWatch + structured JSON logs.

## 3. Terraform resources (minimum set)

- S3 (site + optional logs)
- CloudFront + OAC; ACM; Route53 (if custom domain)
- Cognito User Pool, clients, IdPs (Google/Facebook)
- API Gateway HTTP API + JWT authorizer
- Lambda functions + IAM
- DynamoDB PAY_PER_REQUEST + PITR
- SES verified domain/from-address (+ optional SNS bounces)
- EventBridge/SQS optional for async notifications

## 4. ID + URL strategy

- IDs: ULID.
- Public URLs: /{league}/{season}/{game} (league+season can be slug or id; game
  always accessible by gameId).

## 5. Data model (DynamoDB single table)

Season identity is (leagueId, seasonId). Game is globally addressable by
gameId.

### 5.1 PK/SK patterns

- League: PK=LEAGUE#{leagueId}  SK=METADATA
- Season: PK=LEAGUE#{leagueId}  SK=SEASON#{seasonId}
- Team: PK=SEASON#{seasonId}    SK=TEAM#{teamId}
- Session/Day: PK=SEASON#{seasonId} SK=SESSION#{yyyymmdd}
- Game (metadata): PK=GAME#{gameId} SK=METADATA (leagueId, seasonId, sessionId,
  date, location, thirdLength, status).
- GoalEvent (timeline): PK=GAME#{gameId}
  SK=GOAL#{third}#{gameMinuteSortable}#{eventId}
- Roster assignment: PK=GAME#{gameId} SK=ROSTER#{teamId}#{playerId}
- Session→Game index: PK=SESSION#{sessionId} SK=GAME#{gameStartTs}#{gameId}
- Player: PK=PLAYER#{playerId} SK=PROFILE
- Player claim: PK=USER#{cognitoSub} SK=PLAYER#{playerId}
- Admin grants: PK=ACL#{scopeType}#{scopeId} SK=ADMIN#{cognitoSub}

### 5.2 GoalEvent fields

- third (1..3), thirdMinute, stoppageMinute, displayTime
- scoringTeamId (null when ownGoal), concedingTeamId
- scorerPlayerId, assistPlayerIds[], ownGoal

## 6. Auth + identity

- Public pages show nickname + optional avatar only; no emails.
- Emails visible only to self + admins.
- Admin permissions scoped per League/Season/Game via ACL items.
- Social sign-in: Cognito Hosted UI (Google + Facebook).
- Magic-link: custom flow using SES + Dynamo TTL + Cognito CUSTOM_AUTH (click
  link → signed in).

## 7. API design

- JSON over HTTP, /v1, Zod validation.
- Idempotency-Key for write endpoints (goals, finish).

``` Public: GET /v1/public/leagues GET
/v1/public/leagues/{leagueIdOrSlug}/seasons GET /v1/public/games/{gameId} GET
/v1/public/games/{gameId}/timeline

Auth: POST /v1/auth/magic/start POST /v1/auth/magic/complete

Core (authed): POST  /v1/leagues POST  /v1/leagues/{leagueId}/seasons POST
/v1/seasons/{seasonId}/sessions POST  /v1/sessions/{sessionId}/games PATCH
/v1/games/{gameId} POST  /v1/games/{gameId}/roster POST
/v1/games/{gameId}/thirds/{third}/start POST
/v1/games/{gameId}/thirds/{third}/finish POST  /v1/games/{gameId}/goals PATCH
/v1/games/{gameId}/goals/{eventId} DELETE /v1/games/{gameId}/goals/{eventId}
POST  /v1/games/{gameId}/finish POST  /v1/join/{joinCode} POST  /v1/players
POST  /v1/players/{playerId}/claim

```

## 8. Timer + thirds

- Thirds reset each period; timer runs into stoppage; explicit Finish Third.
- Client timer drives UX; server validates state/bounds.

## 9. Undo/delete + audit (minimal)

- Undo last goal = immediate delete of most recent event.
- Edit/remove supported.
- Audit: minimal admin-only audit entries (who/when/what).

## 10. Token storage + CSP

- Decision: httpOnly secure cookies for tokens.
- Backstop: strong CSP + security headers.

## 11. Email notifications

- On game finish: send summary + personal callouts + link.

## 12. Frontend

- Astro + Web Components islands (timer, roster, goal entry).
- Keep JS minimal; no heavy state libs.

## 13. Testing + CI

- Unit: scoring rules + own-goal behavior + stoppage formatting.
- Contract: OpenAPI + validation.
- E2E: Playwright incl. magic-link flow (SES stub).

## 14. Local development

- As much as possible, local development should be made possible to test front
  end / API etc by writing to a “stubbed” data model locally. This will enable
  rapid human and agent development cycles without having to deploy everything
  to AWS for testing.
- Stubbed approaches to include:
    - DynamoDB Local for data
    - “fake SES” will capture to a local file log to be able to retrieve magic
      links etc.
- Any local scaffolding must be available via make recipes, backed by
  appropriate NPM, shell or other scripts or commands (eg `make install`, `make
  build`, `make dev` , `make deploy` etc.

## 15. Environments

- A local development environment can be spun up locally with appropriate data
  structure and service “stubbing” as needed to replicate effects of AWS
  service behaviour (actual behaviour doesn’t need to replicated, just enough
  to be able to create local feedback loops without deployment)
- The `qa` environment application will be deployed to via github workflows and
  will reside in AWS. It will be automatically deployed to when a PR is labeled
  `QA-ready` and will be fully automated.
- The `production` environment application will be deployed to via github
  workflows and will reside in AWS. It will be automatically deployed to when a
  branch is merged to the `main` branch and will be fully automated.
- Infrastructure will be deployed via terraform from local shells to apply
  updates using AWS Developer accounts. State will be managed using S3 based
  state management in a bucket that will be used explicitly for this purpose
  along with a Dynamo table for locking information (standard AWS pattern)

## 16. CI/CD

- Test runners will be established using github workflows and will surface
  events that will need to pass in order for merging to occur.
- On merge to `main` the deployment will run and deploy to the `production`
  environment. The gate will be deciding to merge to `main`
- To deploy to the `qa` environment, a label will be added to the PR called
  `QA-ready` and then that will be used to trigger deployment.
- `make deploy` script must check an explicit `ENV=[qa|prod]` value or return a
  failure.
- Github will only push application code changes - all infrastructure will be
  managed via local terraform updates.
- Feedback on success should occur in the github deploy process.
- Keys for access to deploy application code will be provided in github
  secrets.

## 17. Milestones

1. M0 Terraform skeleton + hello API
2. M1 Auth (social+magic-link) + ACL + create league/season/session/game
3. M2 Roster + timer + goals CRUD + undo + timeline
4. M3 Results + public game page + season leaderboards
5. M4 SES notifications + QR join polish

---

## Change log

- 2026-02-21 - Revision to include infra elements; CI/CD process included.
- 2026-02-21 — Clean copy created; ULID IDs confirmed; minimal
  undo/delete/audit; token storage httpOnly cookies + CSP; game global
  addressing + session index.
- 2026-02-20 — Added Cognito true magic-link flow + modular lambda
  decomposition.
