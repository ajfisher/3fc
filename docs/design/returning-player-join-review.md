<!-- review-packet-version:1 -->

## Behavioural claim

A signed-in player can explicitly reuse a linked identity in the destination
league without creating another profile. Existing registrations retain their
original IDs and assignments. Anonymous registration and private claim proof
remain separate, supported journeys.

Fixes #161

Base: `codex/player-consolidation` (#167). Branch: `codex/returning-player-join`.

## Specification and acceptance evidence

| Acceptance | Evidence | Result |
| --- | --- | --- |
| Complete private subject/legacy-email discovery, pagination and Unicode ordering | `owned-player-join.test.ts`; actual HTTP/DynamoDB group64744 | PASS |
| Atomic self-registration, original IDs, concurrent keys and lost-response recovery | Repository tests and disposable HTTP/DynamoDB group64744 | PASS |
| Session binding, strict DTOs, headers, local/Lambda/deployment parity | Owned-route, Lambda and deployment tests; affected API group61549 | PASS |
| Explicit zero/one/many, bounded pagination, storage recovery, account switching | Returning-player JSDOM tests; complete app suite | PASS |
| Anonymous proof continuity and no generic sign-in during uncertain registration | 504 interaction tests, group64260 | PASS |
| Mobile keyboard, light/dark and actual persistence | Final disposable browser group70349, 320/390/430/768/1280px | PASS |
| Lint/typecheck, full tests, contracts, backlog and build | Group65106 exit0, 467 API / 629 app / 3 operator / 57 gate tests; peak2829616KiB, remaining[] | PASS |
| Exact-head Codex, CI, isolated QA and review gate | PR evidence attached before readiness | Pending |

Browser emulation is not physical iOS/Android acceptance. No AJ fixture mutations
or production migration are authorised.

Final browser group70349 exited0, peak963568KiB plus separately bounded512MiB
Docker, remaining[]. Both actual API children exited and the disposable container
was removed. Captures are in `3fc-returning-browser-N45HFv`; root inspected
320px dark and390px light states. The named Join action has primary treatment;
creating another profile remains secondary when an existing identity is offered.

## Scope boundaries

Only owned, target-league player identities are discoverable. No account search,
nickname matching, self-claim directory, cross-league import or permission grants.
Finished-game joining retains the pre-existing registration exception; it does
not permit team assignment or scoring mutation. No new Terraform resources.

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

| Invariant | Preservation | Evidence |
| --- | --- | --- |
| INV-001 / INV-002 | Current account owns every offered identity; join code scopes the league, never grants a role | Negative route/repository cases |
| INV-003 | Receipt and membership commit atomically; retries preserve account, player and key | Response-loss and concurrent-key tests |
| INV-004 | Canonical new registration; historical alias retained; identity revision fences consolidation | Alias and race tests |
| INV-005 / INV-006 / INV-008 | No goal, assist, result or roster assignment changes | Full existing scoring regression |
| INV-009 | Existing cookie session and exact-account binding; private headers, verified sign-out cleanup | Adapter and browser-state tests |

### Architecture or decision record

`docs/design/player-identity-delivery.md` and
`docs/runbooks/returning-player-join.md`. The private account claim index gains
`USER#<account>/PLAYER_CLAIMS_REVISION`; claims and consolidation update it
atomically even while returning joins are disabled. Discovery cursors bind both
trusted account namespaces, their revisions and target-league identity epoch.
Pages are bounded to 20 source records. The frontend reads at most four pages
sequentially per action, never treating partial or failed reads as zero players.

## Failure and rollback

### Failure behaviour

Ownership, join-code, game deletion, membership and control changes are checked
before a durable receipt is replayed. Unknown responses retain the exact attempt.
An account switch retires the view. Invalid saved data requires explicit verified
cleanup followed by discovery, not a replacement write. Browser-history restore
reloads the controller rather than reviving an in-flight request.

### Rollback approach

Disable `PLAYER_RETURNING_JOIN_ENABLED`; keep alias-aware readers and all
claim-index revision writers. Deploy disabled first, drain old writers, verify
membership coverage, then explicitly enable. Production needs separate approval.
Disabling also pauses receipt retrieval; the client retains the original attempt
for recovery after re-enablement. Do not report an unavailable request as failed
or silently create a different player.

### Rollback evidence

Deployment tests require actual flag/manifest/request agreement. Disposable API
acceptance restarts with the flag false and checks private reads/writes reject
without changing existing registrations. Actual group64744 and final70349 passed
these disabled-route checks; new joins are paused, not silently replaced.

## Automated and agent review disposition

Independent reviews identified and addressed: UTF-8 versus UTF-16 pagination;
manual empty-namespace pagination; stale assignment text from immutable receipts;
invalid persisted game context; unrecoverable storage errors; BFCache restoration;
and generic sign-in navigation during an uncertain anonymous registration.
Actual persistence acceptance also caught missing directory revision on a newly
created empty league. A condition-fenced absent revision now permits truthful
empty results while rejecting a cursor after the first membership is written.
The root also added central verified returning-draft cleanup on every sign-out
surface and deployed route/asset parity. Reviewers do not launch tests.

GitHub review on `75ae2e4c3bf442a64436a6302fda9087d194c984` identified two
additional P2 findings. Comment3986293540 is addressed by validating saved retry
keys and strict body fields before exposing Retry; seven malformed-storage cases
prove explicit cleanup without a POST. Group71491 passed all19 returning-player
tests, exit0, peak390416KiB, remaining[]. Comment3986293541 is addressed by
parallelising the bounded source page, with at most20 outstanding reads and
ordered assembly after all lookups settle. Group71532 passed all15 repository
tests, exit0, peak523120KiB, remaining[]. The maximum legal20-by20 fixture proves
bounded overlap, ordered results and unchanged transaction fencing; a rejected
lookup test proves pending siblings drain before failure. These tests do not
establish a deployed latency bound; deployed performance evidence remains due.

After both fixes, group71570 passed lint/typecheck, full469 API /636 app /3
operator /57 gate tests, contracts, backlog validation/export and build; exit0,
peak2827344KiB, remaining[]. Fresh actual HTTP/DynamoDB and Chromium acceptance
group76873 passed, exit0, peak963040KiB plus512MiB Docker, remaining[]; both API
children exited and the disposable container was removed. Fresh browser captures
are `3fc-returning-browser-BrPvtN`. Read-only frontend and architecture/security
reviews found no further demonstrated P1/P2 findings in these changes.

### Unresolved blocking findings

Exact-head remote acceptance remains pending.

The isolated deployed 20-by-20 identity fanout exposed a remaining Lambda
timeout at `ae6990e`: diagnostic group3009 exited1 with an AWS function timeout
and a 10,686ms client round trip under Node20/arm64/256MiB/10 seconds. This was an
application timeout, not a local resource incident; peak147952KiB, remaining[].
The performance finding is therefore still open, despite the earlier no-findings
Codex completion. Do not treat twenty concurrent sequential lookup streams as
adequate deployed latency evidence.

The follow-up replaces discovery-only network lookups with request-local,
strongly consistent BatchGet prefetch. Batches contain at most 100 keys, with at
most 4 batches outstanding and bounded retries for unprocessed keys. Unprocessed
keys cannot be mistaken for missing rows. Existing alias, ownership, scope and
registration validators consume the same prefetched snapshots; final revision
checks remain atomic. No cache is shared between requests or used by mutation
paths. The existing application IAM already permits BatchGetItem; isolated
fixture IAM adds only that action on its own table. No Terraform change.

The fixture's deletion test correctly invalidated coverage. A separate audited
reconciliation preserved the original migration and verified 840/840 source
records with equal digests and zero issues before restoring coverage. All 20
consolidation groups were then created through preview, owner approval and
commit. They may be reused for the read-only fix, preserving seed/migration/code
provenance rather than repeating mutations or inventing a new migration result.

Independent architecture/security review found no material blocker in the batch
design. Engineering/QA review identified malformed present response containers
being treated as missing; the fix explicitly rejects those shapes. Regression
tests cover partial unprocessed exhaustion, snapshot preservation, caller/upstream
object mutation and sibling completion after failure. Focused group4015 passed
19 helper and15 owned-join tests, exit0, peak530064KiB, remaining[]. Full group4099
passed lint/typecheck,488 API/636 app/3 operator/57 gate tests, contracts, backlog
validation/export and build; exit0, peak2824032KiB, remaining[]. Real local
HTTP/DynamoDB plus Chromium group9328 passed with peak963664KiB plus512MiB Docker,
exit0, remaining[]; both API children exited and the disposable database was
removed. Fresh browser captures are `3fc-returning-browser-josx8z`. Deployed
maximum-identity-fanout acceptance and exact-head remote review remain required.

At `02b28e8`, deployed maximum identity fanout passed: all 20 canonical roots and
their original alias registrations returned in a 4072ms client round trip under
the unchanged 10-second Lambda timeout. Namespace continuation pages completed
in 686/538/524ms without duplicates or errors. This is measured fixture evidence,
not a server-duration or percentile SLA. Normal deployed acceptance also passed.

Codex review5176551765/comment3987349348 requested backoff for unprocessed reads.
The follow-up waits 50ms then100ms between bounded retries and checks a shared
eight-second read/retry scheduling budget from list entry before sleeping,
dispatching and accepting responses. This does not promise cancellation of an
already-running SDK call or a hard total Lambda deadline. Mutation paths are
unchanged. Injected-clock tests cover exact delays, processed-key exclusion,
insufficient/expired/overslept budgets, rejected late snapshots and sibling drain.
Independent architecture/security review found no blocker. Focused group13750
passed 22 helper and15 owned-join tests, exit0, peak530256KiB, remaining[].

The deployed browser harness needed explicit assertion timeouts and an enabled
Retry control before keyboard activation; no application change was inferred
from those harness failures. Previously created disposable profiles are retained
and never recreated by a blind retry. Current-head browser/cleanup evidence is
still required before readiness.

After the backoff fix, full group13786 passed lint/typecheck, 491 API/636 app/3
operator/57 gate tests, contracts, backlog validation/export and build; exit0,
peak2840384KiB, remaining[]. Refreshed real local HTTP/DynamoDB and Chromium
group19054 passed, exit0, peak991568KiB plus512MiB Docker, remaining[]; API children
and disposable database cleaned up. Captures: `3fc-returning-browser-623JbO`.

Codex review5176700138/comment3987471765 found that an already-failed batch
could leave siblings retrying unprocessed keys until the scheduling deadline.
The follow-up adds a shared failure latch: no new retry is dispatched after a
sibling fails, including a failure during response validation or backoff.
Already-started calls still drain before the operation rejects. Mixed-failure
tests use a non-expired clock so they prove cancellation of retries rather than
incidental deadline exhaustion. Current-head validation and deployed evidence
must be refreshed before readiness.

Independent architecture/security review cleared the latch and its mixed-failure
regressions. Focused group20288 passed24 helper and15 owned-join tests, exit0,
peak530896KiB, remaining[]. Full group20321 passed lint/typecheck,493 API/636
app/3 operator/57 gate tests, contracts, backlog validation/export and build;
exit0, peak1931856KiB, remaining[].
Real local HTTP/DynamoDB and Chromium group25583 passed, exit0,
peak982928KiB plus512MiB Docker, remaining[]; API children and database removed.
Fresh returning-player captures: `3fc-returning-browser-IbVboZ`.

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

Falsify ownership and complete-index guarantees, account/alias races, receipt
replay after deletion or reassignment, anonymous proof continuity, deployment
cutover and touch/keyboard recovery. No merge or production release authority.
