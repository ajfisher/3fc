<!-- review-packet-version:1 -->

## Behavioural claim

An authorised league organiser or scorer can remove an assigned or Unassigned
player from a scheduled game without deleting the reusable player identity,
claim, league/season membership or other-match history. Exact retries replay the
settled removal and cannot delete a later re-registration.

Closes #184 (PLAYER-09). Branch: `codex/player-game-removal`, base: `main`.

## Specification and acceptance evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Assigned and Unassigned removal through one player action menu | Repository removal cases; scheduled roster interaction tests | PASS focused |
| Organiser/scorer authority and scheduled-only state | ACL, repository, route and live/finished UI cases | PASS focused |
| Exact atomic game-only deletion and retained identity/history | Transaction planner plus repository retention/reverse-marker/directory-revision assertions | PASS focused |
| Replay, conflicting reuse, response loss, transfer, join/re-add and consolidation safety | Repository idempotency/CAS race cases and browser retry/reconciliation cases | PASS focused |
| Confirmation, Cancel/Escape, focus, feedback and recovery | Rendered layout and interaction tests, including Unicode Unassigned player | PASS focused |
| Local/Lambda/OpenAPI/Serverless/deployment parity | Shared-handler parity, HTTP adapter and deployment configuration tests | PASS focused |
| Full local and independent evidence | API 523/523; app 662/662; ops 14/14; review-gate 57/57; typecheck, contracts, build, backlog and disposable local M2 | PASS local |
| CI, exact-head Codex and deployed QA evidence | To be attached after publication | PENDING |

## Scope boundaries

Included: one authenticated DELETE contract, additive immutable removal receipt,
scheduled-game transaction, combined roster actions, focused confirmation and
explicit uncertain recovery. Excluded: player/profile deletion, bulk removal,
live/finished correction, score-rule changes, migration, Terraform/IAM changes,
production writes, merge and release.

## Change classification

- Declared risk: `high`
- [x] `application-behaviour`
- [x] `public-contract`
- [x] `permission-trust-boundary`
- [x] `durable-state-ownership`
- [x] `privacy-regulated-data`

## Architecture and invariants

- [x] `architecture:documented`

| Invariant | Impact and preservation | Evidence |
| --- | --- | --- |
| INV-001 | Receipt actor is a league-scoped SHA-256 reference; response omits actor/account data | Repository/HTTP privacy assertions |
| INV-002 | Global ACL and repository both require current admin/scorer league authority | ACL/negative repository tests |
| INV-003 | One frozen client attempt and immutable hashed-key receipt own replay/recovery | Retry, conflict, lost-response and re-add cases |
| INV-004 | Exact registration/assignment/reverse marker are deleted; directory revision and identity revision are fenced | Single-table docs and repository assertions |
| INV-008 | Strong scoring reads block referenced players; scheduled snapshot prevents a concurrent scoring write | Repository transaction design and regressions |
| INV-009 | Existing cookie authentication, no-store/no-referrer and local assets remain | HTTP/session/security and deployment checks |

`docs/architecture/match-roster.md` and `docs/dynamodb-single-table.md` document
the write boundary and additive receipt. No invariant definition changes.

## Failure and rollback

An initial definitive 4xx refreshes authoritative game/roster state and reports
no success. After an uncertain dispatch, only receipt-aware repository state
codes settle the attempt; pre-repository 401/403 and other ambiguous outcomes
retain the exact player/key, lock conflicting writes and expose Retry removal
plus Reload roster. Reload reports current roster truth but cannot by itself
settle an in-flight write. Confirmed success removes the local row before
authoritative refresh; refresh failure still reports the committed removal. A
later re-add is shown after same-key replay and the old receipt cannot delete it.

Rollback is a code redeploy. Existing receipts are harmless to older readers;
already committed removals are intentional durable writes and are not reversed.
No Terraform apply, IAM update or data migration is required.

## Automated and agent review disposition

Independent UX/accessibility, engineering/QA and architecture/security reviews
completed read-only without running tests. Initial findings covered dialog zoom,
status/focus ownership, concurrent replay, row-local identity completeness,
complete goal/audit pagination, authority-safe replay and uncertain client
settlement. Each was fixed and all three final re-reviews reported no remaining
material findings.

### Unresolved blocking findings

GitHub current-head review, CI and QA acceptance remain pending until
publication. Local validation and independent reviews are complete.

### Local validation

- `npm test --workspace @3fc/api`: 523 passed.
- `npm test --workspace @3fc/app`: 662 passed.
- `npm run typecheck`, `npm run contracts:check`, `npm run build`: passed.
- `npm run test:ops`: 14 passed; `npm run test:review-gate`: 57 passed.
- `make backlog-validate`, `make backlog-export`, `git diff --check`: passed.
- `node scripts/local/test-player-stack-m2.mjs`: current-stack browser run passed
  against a disposable memory-capped DynamoDB container; all owned workers,
  private email files and the container were verified removed.

### Rejected findings and evidence

- A proposed global `coverage=verified` gate was not retained: ordinary game
  deletion intentionally marks global coverage unknown. Removal instead requires
  fenced mode and verifies/conditions the exact materialised root/original,
  canonical league, original season, game marker, directory and revision rows.
  This fails closed for the target identity without introducing an undocumented
  migration prerequisite.

## Human judgement

- [x] `human-judgement:none`

## Review focus

Challenge alias/original-ID targeting, conditional absence of all team slots,
receipt replay after re-add, game-start/transfer/consolidation races, account
privacy, same-key conflict, stale UI refresh, keyboard dialog containment and
scorer-versus-player identity separation. No merge or production authority.
