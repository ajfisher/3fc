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

### Unresolved blocking findings

Exact-head remote acceptance remains pending.

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
