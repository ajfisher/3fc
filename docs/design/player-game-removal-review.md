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
| Assigned and Unassigned removal through one player action menu | Repository removal cases; scheduled roster interaction tests | PASS |
| Organiser/scorer authority and scheduled-only state | ACL, repository, route and live/finished UI cases | PASS |
| Exact atomic game-only deletion and retained identity/history | Transaction planner plus repository retention/reverse-marker/directory-revision assertions | PASS |
| Replay, conflicting reuse, response loss, transfer, join/re-add and consolidation safety | Repository idempotency/CAS race cases and browser retry/reconciliation cases | PASS |
| Confirmation, Cancel/Escape, focus, feedback and recovery | Rendered layout and interaction tests, including Unicode Unassigned player | PASS |
| Local/Lambda/OpenAPI/Serverless/deployment parity | Shared-handler parity, HTTP adapter and deployment configuration tests | PASS |
| Full local and independent evidence | API 535/535; app 672/672; ops 14/14; review-gate 57/57; typecheck, contracts, build, backlog and disposable local M2 | PASS |
| CI, exact-head Codex and deployed QA evidence | Prior head `ed0a2f1` passed CI and QA deployment; its exact-head Codex findings are resolved locally and current-head evidence must be refreshed after push | PASS |

## Scope boundaries

Included: one authenticated DELETE contract, additive immutable removal receipt,
scheduled-game transaction, combined roster actions, focused confirmation and
explicit uncertain recovery.

Excluded: player/profile deletion, bulk removal, live/finished correction,
score-rule changes, migration, Terraform/IAM changes, production writes, merge
and release.

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
| INV-002 | Adds organiser/scorer roster-removal authority | Authenticated routing delegates this receipt-aware boundary to the repository, which resolves live-game or immutable receipt league scope and requires current authority | ACL and negative repository/handler cases |
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
head. The latest exact-head review found that the confirmation was not bound to
the rendered registration version, so another client's transfer or re-add could
be deleted before confirmation. Every fresh registration now receives an opaque
revision, genuine legacy registrations receive a stable snapshot-derived
revision, roster reads project it, and removal freezes and conditionally checks
it in both the request identity and transaction. Exact receipt replay after a
re-add remains safe, while a new request carrying the old revision fails without
mutation. Architecture/security review also identified the returning-player
join writer as a missing revision source; it now assigns a fresh revision and a
remove/rejoin regression covers it. UX/accessibility review identified that a
definitive stale rejection followed by refresh failure did not expose the reload
action named by its message; the UI now enters an explicit reload-required state
and focuses **Reload roster**. Its final re-review also challenged optional
player-detail failure after roster success. Although that loader already settles
its own failure, the definitive recovery now explicitly separates authoritative
game/roster refresh from optional enrichment; a rendered regression proves that
current roster truth is retained without falsely demanding a roster reload.
The same recovery now replaces its pending live-region message with a settled
“not removed; latest roster shown” outcome and removes stale “Reload” wording
when that automatic roster refresh succeeded.
Legacy revision hashing uses ordered identity/timestamp fields rather than
DynamoDB map order, with a compatibility regression. Engineering/QA re-review
cleared the complete delta. The next exact-head review found that separate
strongly consistent roster and registration queries could still straddle a
transfer, pairing an old displayed assignment with the new deletion-authorising
revision. Roster reads now bracket the complete assignment query with complete
registration snapshots, retry at most three times, and fail closed if membership
or revisions do not stabilise. Focused tests prove a mid-read transfer returns
only the later assignment/revision pair and continual changes return no mixed
projection. Exact-head CI and QA deployment passed for `b258a12`; Codex completed
with one further accepted recovery finding: a failed authoritative roster reload
after a stale-revision rejection displayed the correct recovery action but did
not keep other writes locked. The reload-required state now disables roster,
scoring, game-edit and row-access writes and the synchronous write guard rejects
any missed control until `loadRosterSetup()` succeeds. A rendered regression
proves the lock, zero bypassed delete-game dispatches at the request boundary
and one committed dispatch after successful authoritative recovery. Final
independent review also found that finished-game correction entry did not
consume this lock, and that the strengthened test had initially stopped at a
disabled transfer control rather than exercising the request guard. Correction
entry is now hidden, disabled and defensively guarded during recovery while an
already-open correction retains its no-write Exit action. The regression now
bypasses the disabled delete-game control to prove the central guard, repeats
the same write after recovery, and covers a scheduled-to-finished transition.
Authoritative roster recovery re-renders all write capabilities immediately.
Final UX/accessibility, engineering/QA and architecture/security re-reviews are
clear. That exact-head Codex review also recovered an older replay finding:
settled removals became unreachable if their game was subsequently deleted. The
immutable removal receipt now carries its league scope, survives normal game
deletion and moves deleted-game replay authorization into the repository, where
current organiser/scorer authority is re-established and transactionally
fenced. A second strong receipt read closes the receipt-commit/game-delete
interleaving before `game_unavailable`; deterministic repository and Lambda
regressions cover replay, denial and conflicting key reuse. The same review
found that a roster recovery read could be superseded while its caller treated
completion as authoritative. `loadRosterSetup()` now reports whether it applied
its snapshot, all removal recovery paths require that positive result, and the
shared refresh stays latched until both public roster and private detail reads
settle. Superseded reads retain the reload-required write lock and truthful
recovery announcement. Fresh UX/accessibility, engineering/QA and
architecture/security re-reviews found no remaining material issues.

### Unresolved blocking findings

None.

### Local validation

- `npm test --workspace @3fc/api`: 535 passed.
- `npm test --workspace @3fc/app`: 672 passed.
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

None.

## Review focus

Challenge alias/original-ID targeting, conditional absence of all team slots,
receipt replay after re-add, game-start/transfer/consolidation races, account
privacy, same-key conflict, stale UI refresh, keyboard dialog containment and
scorer-versus-player identity separation. No merge or production authority.
