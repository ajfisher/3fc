<!-- review-packet-version:1 -->

## Behavioural claim

Player search follows matching results across the authorised league or season,
not merely one physical DynamoDB page. Combining profiles is a focused selection,
review and success task which can be repeated without reloading the page.

Fixes #173 (PLAYER-07). Base: codex/player-directory-cutover-fixes (#171).

## Specification and acceptance evidence

AJ's QA feedback is the acceptance source: one checkbox table with name and game
dates; retained identity/name afterwards; no duplicate selection list or directory
under the preview; meaningful Back/Cancel; clear success and a fresh next task.

| Criterion | Evidence | Result |
| --- | --- | --- |
| Complete matching pages, physical budgets and safe cursors | player-directory-pagination.test.ts | PASS, group79401 |
| Authorised current game dates, deleted/foreign exclusion, alias targets and bounded partial context | player-directory-games.test.ts | PASS, group79374 and79401 |
| Existing repository, local HTTP and directory regressions | 197 tests, group79401, exit0, peak201840KiB, remaining[] | PASS |
| Automatic query continuation | setup-flow-e2e.test.ts focused search regression, group78915 | PASS (same run had an unrelated stale checkbox fixture failure) |
| Success/reset, selection/review, uncertainty and approval | 17 interaction tests, group82496 exit0, peak285568KiB, remaining[] | PASS |
| Full API and app validation | 506 API tests group79551; final643 app tests group83386; both exit0/remaining[], peaks1236400/2809504KiB | PASS |
| Lint/typecheck, contracts, build, operator/review-gate tests and backlog | Group82531 exit0,10operator/57gate, peak582384KiB, remaining[] | PASS |
| Browser selection/review, two sequential combinations, Back/Cancel, owner approval, current game dates, 44px targets and no overflow | Actual disposable local API/DynamoDB/Chromium,320/390/430/768/1280px light/dark; group83240 exit0, peak958464KiB plus bounded512MiB container, remaining[] and container deletion verified | PASS |
| Exact-head GitHub review/CI/QA | To be attached after publication | PENDING |

## Scope boundaries

No player or historical event is deleted by these changes. Existing QA groups
were checked read-only: one group of eight and one of seven each has exactly one
active directory entry, a consistent alias root, matching registrations/reverse
membership counts and no missing referenced games. Names and account data are
not included in public evidence. Separate test-league identities remain separate.

## Change classification

- Declared risk: `high`
- [x] `application-behaviour`
- [x] `public-contract`
- [x] `backlog-maintenance`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | Enriches private directory responses with game context | Existing league authority remains mandatory; no emails/account IDs or cross-league records are returned | Scoped API and game sample tests |
| INV-004 | Changes league-directory read pagination and adds bounded reverse-membership reads | Existing single-table keys, canonical roots and historical original IDs remain intact; no migration or new index | Planner/helper tests and repository regression |

Protected-write authorisation, idempotency and scoring rules are unchanged.
The UI retains exact uncertain requests and never interprets a failed list
refresh as failure of an already confirmed consolidation.

### Architecture or decision record

Logical matching pages traverse at most250 raw rows/10physical pages. A typed
search follows continuation automatically, retaining query/scope and rejecting
cycles; after100responses it pauses explicitly rather than running indefinitely.
An absent query remains user-paginated. Only a null cursor means exhaustion.

Optional includeGames requests use at most10returned players. Current game
metadata and original registrations are checked through request-local strong
reads. Reverse work and game-key batches are bounded; samples contain at most20
dates and explicitly flag omitted context. A scheduling budget does not cancel
an already-running AWS SDK request and is not a latency guarantee. No 'latest'
or total-game claim is made from hash-ordered membership keys. Backend deployment
uses the existing local/Lambda directory route and existing IAM capabilities;
no Terraform resources, dependency or migration changes are introduced.

## Failure and rollback

### Failure behaviour

Search changes/cursor failures do not produce false empty results. Optional game
context budget exhaustion yields incomplete context, not an empty directory.
Malformed records and authorisation failures remain fail-closed. Pending approval
is distinct from uncertain mutation recovery; an uncertain request cannot be
discarded through Back or Cancel. Success clears selection; refresh can fail
independently without enabling another commit.

### Rollback approach

Revert this child while retaining the parent alias/proof-aware stack. No stored
format or mutation semantics change. Rollback restores the known search/UX
defects, not an alias-unaware identity implementation.

### Rollback evidence

Diff is limited to read contracts/planning, presentation, tests and documentation.
No real QA records are mutated for acceptance; disposable fixtures are required
for browser mutation scenarios.

## Automated and agent review disposition

Independent UX review identified ambiguous same-name retained choices, missing
checkbox date context, concatenated name/status and overwritten approval-check
errors. All are corrected and covered with focused tests; the independent follow-up
found no remaining material UX blocker. Independent engineering/QA read-through
of the backend found no concrete privacy/correctness blocker. Extra reverse-cursor
and metadata-race tests were suggested as non-blocking coverage improvements.
Root reviewed the read budgets and fail-closed scope checks. An initial UI
fixture clicked detached checkboxes after a re-render; it is corrected to re-query
the live control as a user would. Initial API fixture errors (missing SDK metadata
and invalid alias members) were corrected; complete repository regressions pass.

### Unresolved blocking findings

Current-head remote/QA evidence is outstanding. Physical-device checks and200%
zoom are not represented by desktop emulation. Parent #171's separate account-discovery scalability finding
and human risk decision remain open; this child does not disposition them.

### Rejected findings and evidence

None.

## Human judgement

- [x] `human-judgement:none`

## Review focus

Try sequential combinations, same-name selections, uncertainty followed by
Cancel, failed approval refresh, post-commit list failure, stale async responses,
query continuation and cross-league game context. Check measured deployment
latency before accepting read-budget claims. No merge or production authority.
