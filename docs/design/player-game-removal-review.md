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
| Full local and independent evidence | API 528/528; app 666/666; ops 14/14; review-gate 57/57; typecheck, contracts, build, backlog and disposable local M2 | PASS local |
| CI, exact-head Codex and deployed QA evidence | Initial `c153478` CI/deploy passed; three Codex findings were accepted and fixed. Current-head refresh required after push. | REFRESH PENDING |

## Scope boundaries

Included: one authenticated DELETE contract, additive immutable removal receipt,
scheduled-game transaction, combined roster actions, focused confirmation and
explicit uncertain recovery. Excluded: player/profile deletion, bulk removal,
live/finished correction, score-rule changes, migration, Terraform/IAM changes,
production writes, merge and release.

## Change classification

- Declared risk: `high`
- [x] `application-behaviour`
- [x] `backlog-maintenance`
- [x] `public-contract`
- [x] `permission-trust-boundary`
- [x] `durable-state-ownership`
- [x] `destructive-behaviour`
- [x] `authentication-authorisation`
- [x] `privacy-regulated-data`
- [x] `infrastructure-production-configuration`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | Adds a durable removal audit receipt | Actor is a league-scoped SHA-256 reference and the public result omits actor/account data | Repository and HTTP privacy assertions |
| INV-002 | Adds organiser/scorer roster-removal authority | Both global ACL routing and the repository require current league authority | ACL and negative repository/handler cases |
| INV-003 | Adds a retriable destructive roster operation | One frozen client request and immutable hashed-key receipt own replay and recovery | Same-key, conflict, response-loss and re-add cases |
| INV-004 | Deletes one registration, assignment and game reverse marker | Canonical identity, claim, league/season membership and history remain; identity and directory revisions are fenced | Single-table docs and retention/CAS assertions |
| INV-008 | Adds a scheduled-game-only destructive transaction | Complete strong scoring reads block referenced players; the goal-state revision, scheduled snapshot and scorer/assist registration conditions fence both scoring/removal commit orders | Goal/audit pagination, scoring-revision, registration-condition and game-start race cases |
| INV-009 | Adds one authenticated DELETE route and confirmation flow | Existing cookie authentication, no-store/no-referrer, CORS and local-asset policies remain | HTTP/session/deployment and built-browser checks |

### Architecture or decision record

`docs/architecture/match-roster.md` and `docs/dynamodb-single-table.md` document
the write boundary and additive receipt. No invariant definition changes.

## Failure and rollback

### Failure behaviour

An initial definitive 4xx refreshes authoritative game/roster state and reports
no success. After an uncertain dispatch, only receipt-aware repository state
codes settle the attempt; pre-repository 401/403 and other ambiguous outcomes
retain the exact player/key, lock conflicting writes and expose Retry removal
plus Reload roster. Reload reports current roster truth but cannot by itself
settle an in-flight write. Confirmed first-attempt success removes the local row
before authoritative refresh; refresh failure still reports the committed
removal. After an uncertain attempt, a player row observed by Reload roster
remains visible when same-key success confirms removal but the following refresh
fails. The UI labels that row as last-observed state rather than claiming it is a
later re-add. The old receipt cannot delete an actual later registration.

### Rollback approach

Rollback is a code redeploy. Existing receipts are harmless to older readers;
already committed removals are intentional durable writes and are not reversed.
No Terraform apply, IAM update or data migration is required.

### Rollback evidence

Repository and browser cases prove receipt replay after response loss and re-add,
and the complete pre-existing API/app suites pass with the route present. The
additive receipt is ignored by older readers. A production rollback was not
performed because this PR is not authorised for production deployment.

## Automated and agent review disposition

Independent UX/accessibility, engineering/QA and architecture/security reviews
completed read-only without running tests. Initial findings covered dialog zoom,
status/focus ownership, concurrent replay, row-local identity completeness,
complete goal/audit pagination, authority-safe replay and uncertain client
settlement. Each was fixed and all three final re-reviews reported no remaining
material findings.

GitHub Codex reviewed exact head `c153478` and identified three material cases,
all accepted: API Gateway could reinterpret reserved characters in a path-based
player ID; an observed later re-add could be hidden if receipt replay succeeded
but its following refresh failed; and goal correction did not condition the
selected game registrations. The route now carries the opaque player ID as an
exactly-once-decoded query parameter, last-observed roster state is preserved and
labelled stale through a failed refresh, goal creation/correction fence every
scorer and assist registration, and removal brackets complete history reads
with the goal-state revision before conditioning it in the transaction. Focused
regressions cover scoring before, during and after that traversal. All three
independent local re-reviews cleared the amended diff with no remaining material
findings. Its next exact-head review identified one further valid recovery gap:
an immediate same-key retry had not yet recorded the visibly present row. The
attempt now starts from that observable truth and preserves it as explicitly
stale until a successful authoritative refresh; a response-loss, later re-add,
immediate replay and failed-refresh regression covers the boundary. A following
review found that a game-start refresh could prevent replaying the already-owned
request. Scheduled state now gates only new removals; uncertain receipt retries
remain available and settle against the backend's durable receipt after the game
starts. Independent engineering review then found that a same-session role
refresh could discard that frozen request. Authority refreshes now preserve the
exact removal owner while clearing role-specific enrichment; account changes and
sign-out still clear it, and a non-operator role cannot dispatch the retry. The
combined regression covers response loss, administrator-to-scorer refresh, game
start and exact-key receipt replay. The next exact-head review identified two
further compatibility/recovery boundaries: some legacy registration IDs fit a
game-player key but not every longer team-roster key, and optional player-detail
enrichment could delay recording an already-rendered authoritative roster row.
Removal now skips only structurally impossible roster keys while fencing every
representable slot, and both recovery paths record roster truth before optional
enrichment. Strict Dynamo-key and deferred-enrichment regressions cover both
findings; independent engineering/QA and architecture/security re-reviews are
clear. The following exact-head review found the complementary recovery order:
an earlier authoritative read could observe absence, another client could then
re-add the player, and a receipt replay followed by a failed roster refresh
could overstate that the player was still removed. Every uncertain receipt
replay now preserves the complete last-observed projection and describes it as
stale until a fresh roster read succeeds, regardless of whether that projection
was present or absent. The revealed recovery action is labelled **Reload
roster** to match its live-region instruction. The exact ordering has a rendered
regression, and independent engineering/QA and UX/accessibility re-reviews
cleared the amended behavior. GitHub evidence must be refreshed for the new
head.

### Unresolved blocking findings

None. GitHub current-head review, CI and QA acceptance are delivery evidence
pending publication, not unresolved implementation findings.

### Local validation

- `npm test --workspace @3fc/api`: 528 passed.
- `npm test --workspace @3fc/app`: 667 passed.
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

### Decision requiring judgement

None.

### Options considered

None.

### Reason selected

None.

### Reversal cost

Already committed removals remain intentional durable changes; code rollback
does not automatically re-register a player in a game.

## Review focus

Challenge alias/original-ID targeting, conditional absence of all team slots,
receipt replay after re-add, game-start/transfer/consolidation races, account
privacy, same-key conflict, stale UI refresh, keyboard dialog containment and
scorer-versus-player identity separation. No merge or production authority.
