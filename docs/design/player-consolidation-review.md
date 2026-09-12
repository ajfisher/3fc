<!-- review-packet-version:1 -->

## Behavioural claim

An organiser can combine duplicate profiles only after a complete private review,
with explicit owner approval when account-linked history expands. Future games
use the retained identity; historical game IDs and scoring targets remain intact.

Fixes #160

Base: `codex/league-player-directory` (#166). Branch: `codex/player-consolidation`.

## Specification and acceptance evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Complete alias closure, private conflicts, ownership consent, bounded atomic commit | Dedicated consolidation tests; 357 affected API tests, group22900 exit0 | PASS |
| Real maximum-size claimed transaction, overlapping commits, proof-claim staleness and recovery | Actual disposable HTTP/DynamoDB/Lambda harness group23811 exit0; 512MiB container removed | PASS |
| Canonical display and original goal/assist/correction/undo targets | Repository canonical-scoring regression; shared public-read tests; original registration/future root actual-DynamoDB checks | PASS |
| Session-bound routes, strict DTOs, no private output, cookie-switch rejection | Shared/local/Lambda route tests, auth classification and exact-account negative cases | PASS |
| Explicit owner approval, preserved uncertain requests, focus, sign-out fencing | Eleven focused JSDOM cases, group28049 exit0; independent QA findings fixed | PASS |
| Static/dynamic approval shells, safe sign-in return and local assets | Server/static/return tests; versioned-script fixture full file group27919 exit0 | PASS |
| Complete local validation | Final group34612 exit0 peak2487216KiB remaining[]; full API/app/operator/review-gate suites, lint/contracts/backlog/build PASS; final deployment/service focused35 and alias invitation focused2/full file504 also PASS | PASS |
| Mobile browser, keyboard and computed control geometry | Final group38781 exit0, peak912464KiB plus bounded512MiB Docker, remaining[]; 320/390/430/768/1280 light/dark captures, including organiser approval-link sharing; root/independent design inspection of phone editor/preview/owner approval; guarded focused group32739 passed34 | PASS |
| Exact-head remote review, CI and isolated QA | Attached to the PR before readiness | PENDING |

No physical-device or public Gateway browser acceptance is claimed from local
Chromium or private-loopback transports. No production migration is authorised.

## Scope boundaries

Included: immutable proposals, private preview and conflicts, exact owner decision,
atomic alias/directory/index/audit commit, canonical presentation and historical
target mapping, local/Lambda/Serverless/static routes, default-closed deployment
switch and rollback runbook, mobile UI and regression evidence.

Excluded: returning-player joining (#161), automatic nickname matches, profile
deletion, historical-event rewriting, cross-league imports, public results,
permission grants, generic merge undo, Terraform resources, production changes.

## Change classification

- Declared risk: `high`
- [x] `application-behaviour`
- [x] `backlog-maintenance`
- [x] `public-contract`
- [x] `permission-trust-boundary`
- [x] `durable-state-ownership`
- [x] `authentication-authorisation`
- [x] `privacy-regulated-data`
- [x] `infrastructure-production-configuration`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How affected | Why valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | Private proposals and canonical player display | Explicit authorised readers; strict DTOs omit owner IDs; cross-league conflicts reveal no foreign details | Route/public-reader tests and independent security review |
| INV-002 | Organiser preview/commit, owner approval | Current actor/ACL snapshots, ownership and expected-account checks; no role inferred from player identity | Negative authority/account-switch and boundary-race tests |
| INV-003 | Uncertain preview/approval/commit | Frozen request/proposal; atomic bounded commit and durable immutable audit/receipt replay | Unit lost-response test and real DynamoDB replay |
| INV-004 | Canonical aliases and directory/index ownership | Complete coverage/alias/membership checks, 20-member maximum, no historical row rewrites | Maximum-size/overlap/foreign/corruption tests; real DynamoDB migration and commit |
| INV-005 | Scorer/assists retain original registration | Canonical selection mapped before validation; own goals still increase conceded only | Canonical scoring/correction/undo regression and full API suite |
| INV-006 | Match outcome unchanged | Existing comparator/recomputation untouched | Full scoring/result regression suite |
| INV-008 | Assists after canonical mapping | Mapped duplicates/scorer-self inclusion use existing validation | Canonical duplicate-assist and full assist tests |
| INV-009 | Authenticated approval/return route and deployment switch | No bearer link, strict local return allowlist, no-store/no-referrer, existing cookie security | Session/HTTP/Lambda/static/deployment tests |

### Architecture or decision record

`docs/design/player-identity-delivery.md`, `docs/dynamodb-single-table.md`, and
`docs/runbooks/player-consolidation.md`. New consolidation defaults disabled.
Only a reviewed migration supplies verified coverage; the new operation does
not certify its own source completeness.

## Failure and rollback

### Failure behaviour

Ownership, membership, ACL or identity changes make a proposal stale. Different
owners, any shared game including Unassigned, foreign history, incomplete data
or excessive groups fail closed. Owner approval is not a commit. Uncertain
requests preserve their original account/proposal; explicit account switches
retire displayed context and do not silently reissue under another account.

### Rollback approach

Disable `PLAYER_CONSOLIDATION_ENABLED` and deploy the alias-aware version.
Never revert to alias-unaware readers/writers after a consolidation. Existing
committed outcomes remain recoverable; no redirect deletion or general undo.
A mistaken combination requires an explicitly reviewed compensating operation
under an authorised write pause, as documented in the runbook.

### Rollback evidence

The actual local API was restarted with the switch false: new previews rejected,
the committed receipt still replayed, and original alias-aware reads remained.
The deployment manifest and final guard require the actual enabled string to
match the requested value. No production rollback was performed.

## Automated and agent review disposition

Independent root/agent architecture, security, engineering, frontend and QA review
identified missing authenticated route classification, alias invitation targeting,
deployment-switch provenance, post-sign-out late preflight dispatch, cross-context
uncertain retry and explicit cookie-switch response display. All were fixed with
focused regressions. Additional maximum-claimed-group, overlapping-proposal,
control/ACL boundary, lost-response and corrupt-pagination cases were added.
Visual inspection caught cramped selection fields despite passing functional
browser checks. The editor now uses full-width48px/16px controls,44px checkbox
labels, and hides its retained draft during proposal review. New computed-geometry
and keyboard assertions accompany fresh screenshots. Final architecture review
also identified canonical invitation proof storage still using historical alias
IDs; the controller now freezes the canonical proof target separately from the
unchanged roster/scoring ID, with replacement/revocation regression coverage.
Review agents did not launch tests; root owned all guarded validation.

### Unresolved blocking findings

Final browser and exact-head remote review/CI/QA evidence remains pending.

### Rejected findings and evidence

None.

## Human judgement

- [x] `human-judgement:none`

### Decision requiring judgement

None.

### Options considered

None.

### Reason selected

None.

### Reversal cost

None.

## Review focus

Falsify complete membership/alias guarantees, exact owner approval, transaction
budget/CAS atomicity, historical scoring targets, privacy and retry ownership.
Verify deployment defaults closed and rollback retains alias-aware code.
