<!-- review-packet-version:1 -->

## Behavioural claim

Adding an existing player starts with a name search, not a complete directory or
team selector. Search waits300ms after typing, Enter runs immediately, empty input
never loads players, and new registrations go to Unassigned. Complete available
rosters remain visible without a local filter, with explicit loading recovery.

Fixes #178 (UX-12). Base: codex/ux-player-row-consistency (#180).
Parent gate passed at ffb6286 before child implementation. Parent exact-head
Codex no-findings completion: comment5644347918; CI34679464480, QA34679464495 PASS.
Its policy reports the last formal review as stale because no-findings completion
is a bot comment; AJ explicitly accepted verified exact-head no-findings outcomes.

## Specification and acceptance evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| No opening/empty fetch,299/300ms, Enter cancellation, scope and pagination | search-first picker manual-timer controller regression | PASS |
| Stale result cannot dispatch a write; exact null-team request survives loss and search changes | reusable player picker controller tests | PASS |
| Retry and frozen-add reopening focus | explicit activeElement assertions in picker tests | PASS |
| Complete rosters, metadata recovery, finished locks, transfers and refresh ownership | Complete507interaction tests, group20993 exit0, peak2372896KiB, remaining[] | PASS |
| Full lint/typecheck, API/app tests, contracts, build, backlog and review gate | Final fix group29584 exit0; 648 app, 14 operations and 57 review-gate tests; peak2488400KiB; remaining[] | PASS |
| Computed player/form alignment and spacing across phone/tablet/desktop and enlarged text | check-player-ui: 20 browser cases PASS, group27331; subsequent independent fixture failure fixed below | PASS |
| Two-client refresh, complete roster, picker draft/caret, transfer focus and scoring recovery | match-refresh.spec.ts: 14 browser tests PASS including 21st-player metadata recovery, group29584 exit0; remaining[] | PASS |
| Complete roster browser suite and final shared geometry | 46 match-roster tests plus 20 shared-layout cases PASS, group36450 exit0; peak829152KiB; remaining[] | PASS |
| Final affected app, lint/typecheck and review policy | Group36649 exit0; peak2438800KiB; remaining[] | PASS |
| Exact-head Codex review, CI and deployed QA | Final remote evidence will be recorded in PR body/checks after publication | PENDING |

Included acceptance work also covers in-flight abort and scoped reopen, and
updates old roster-search fixtures without deleting their draft/overlay assertions.
Physical devices are recorded separately from browser emulation.

## Scope boundaries

Included: Frontend picker/read scheduling, roster recovery controls, shared form
spacing, tests, backlog and review evidence.

Excluded: API/backend, Terraform, migration, new dependencies, account ownership,
permissions and scoring-rule changes. No real QA records are mutated for acceptance.
No automatic retry of a failed write or automatic creation based on nickname.

## Change classification

- Declared risk: `medium`
- [x] `application-behaviour`
- [x] `backlog-maintenance`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | Keeps private roster enrichment while removing its old search control | Operator-only read remains; failed enrichment clears verified authority, retaining names only; unknown status stays unknown | Role and failed-read recovery controller tests |
| INV-002 | Simplifies registration controls | Existing organiser/scorer/finished locks and server authority unchanged | Roster permissions/finished tests |
| INV-003 | Adds search cancellation around existing-player writes | Frozen player/path/body survives search changes and closure; no automatic write retry; duplicate registration preserves prior assignment | Lost-response/immutable-null-team regression |

### Architecture or decision record

The private metadata loader is explicitly loadPlayerDetails, no longer coupled to
an input element or its generation. The public complete roster remains the
authority for Unassigned. Retry loading players refreshes both independent reads;
a failed refresh retains available names, not stale permission proof.

Picker reads use AbortController plus generation checks because cancellation alone
cannot prevent late responses. Query/scope changes clear obsolete results before
debounce; close cancels reads but preserves the input draft. A frozen write has
separate ownership and its retry row cannot be discarded by read cancellation.
Pagination retains the existing100-response continuation bound and explicit
incomplete/retry feedback. Existing API contracts and idempotency are unchanged.

## Failure and rollback

### Failure behaviour

Search failure provides Retry search without a false exhaustive result. A lost
addition response keeps the exact request and manual retry. Roster refresh failure
retains usable rows and offers recovery. Focus settles only when the initiating
interaction still owns it; opening a frozen addition focuses its usable retry.

### Rollback approach

Revert this child and rebuild the app, retaining the parent shared presentation
and previously deployed alias-aware identity implementation. No migration required.

### Rollback evidence

Diff changes no API contracts, persisted fields or server writes. Registration
still uses the existing null-team contract. Parent remains independently gated.

## Automated and agent review disposition

Independent engineering/privacy and QA read-only reviews found no introduced
blocker. UX review identified lost focus after Retry search and disabled-input
focus when reopening uncertainty; both were fixed and assertion-covered. Review
agents launched no tests or browser workers.

Exact-head GitHub Codex review5185760424 on af2d91d found a valid metadata
recovery gap (comment3995549603): a remotely joined player appeared through public
polling but the loaded-state recovery button stayed hidden. Administrators now see
Refresh player details whenever a current roster ID lacks verified enrichment.
Other roles gain no private metadata or account actions. The external-join
controller and two-client browser regressions verify unknown-to-unlinked state,
restored account actions, unchanged drafts and no observer writes. Independent
privacy/engineering re-review found no introduced blocker.
The browser fixture also exposed the existing private endpoint's 20-result cap.
Explicit administrator recovery now makes at most 20 additional nickname searches
for known roster players; normal initial reads and other roles are unchanged.
Results stage before replacing verified metadata, with authority/version checks.
This is bounded best-effort enrichment: unusually large missing-name sets or more
than 20 identical nicknames may remain unresolved under the existing API. Such
rows remain neutral and feedback stays partial, never falsely complete. Guaranteed
complete private enrichment would require separately reviewed API pagination.

GitHub comment3995586590 on24435e5 identified stale removed-search assumptions in
the large-roster browser file. All such scenarios now exercise complete rosters,
explicit metadata recovery and the search-first/new-player disclosures. All46
cases pass. The geometry checks found a shared selector overriding transfer width;
the transfer component again owns its48px target. The enlarged-initial assertion
now checks actual initial text rather than the intentionally attached tick, and
asserts that initials exist instead of vacuously querying the removed avatar hook.
The full20-case shared-layout browser matrix also passes after the sizing fix.

Initial failures were stale fixtures expecting the removed Search this game input,
immediate empty directory loading, or nickname focus on normal picker reopen.
Tests now assert the approved search-first behaviour while preserving complete
roster, draft revision and uncertain-write coverage.

### Unresolved blocking findings

No unresolved local findings. Exact-head remote review, CI and deployed QA remain outstanding.

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

Challenge read/write ownership separation, late responses after closure, scope
changes, recovery focus, retained metadata and complete public-roster authority.
