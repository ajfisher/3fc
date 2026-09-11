<!-- review-packet-version:1 -->

## Behavioural claim

Home discovers every authorised league across all DynamoDB scan pages, including
empty intermediate pages, without changing ACL filtering, deduplication or sort.
The QA directory backfill exposed the existing single-page omission: a direct
scan had1390 rows and a continuation, no Melbourne ACLs; complete pagination had
2057 rows and five Melbourne ACLs. The league and season were never deleted.

Refs #162. Refs #170 (policy backlog only, not resolved).
Base: codex/player-identity-acceptance (#169).

## Specification and acceptance evidence

| Criterion | Evidence | Result |
| --- | --- | --- |
| Later-page ACL discovery, empty pages, duplicate/malformed/other-user ACL handling | Focused4 regressions, group65639 exit0; complete repository185 tests group65669 exit0 | PASS |
| Cursor cycles fail instead of looping or returning a partial list | Same focused regression, including reordered physical cursor properties | PASS |
| Missing, numeric or empty physical cursor fields fail before a second request | Final focused5 and complete repository186 tests, group71086 exit0, peak516016KiB, remaining[] | PASS |
| Full application regression | Group65741 exit0,495 API/636 app/10 operator/57 gate, lint, contracts, build and backlog/export; peak2031728KiB, remaining[] | PASS |
| Player retention is explicitly deferred | PLAYER-05/#170, actual milestone8, canonical backlog and generated export | PASS |
| Current-head CI, Codex, QA browser acceptance | To be attached after publication and controlled cutover | PENDING |

## Scope boundaries

Included: Read-only league discovery pagination and falsifying regressions;
canonical player-retention policy backlog. Operational QA cleanup is separately
authorised and reviewed; no cleanup logic is shipped by this PR.

Excluded: New account indexes, automatic profile deletion, permission changes,
scoring changes, production migration/release, merging or weakening review policy.

## Change classification

- Declared risk: `medium`
- [x] `application-behaviour`
- [x] `backlog-maintenance`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | League ACL discovery includes later database pages | Existing exact-user ACL predicate remains; no account data returned | Other-user and malformed-record regression |
| INV-003 | Read-only scan traversal rejects cursor cycles | No mutation or retry identity changes | Cycle regression and existing complete API suite |
| INV-009 | No authentication/session changes | Only repository read completeness changes | Full API/app regression |

### Architecture or decision record

This fixes completeness at the existing repository boundary. DynamoDB pages are
bounded by1MiB before client-side ACL selection, not a league count. The method
still scans the shared table per user identity; latency grows with table size.
An account-keyed ACL query is the longer-term optimisation, not a scalability
claim for this patch. Current deployed latency must be observed at acceptance.

## Failure and rollback

### Failure behaviour

Malformed/repeated continuation keys reject the read rather than return an
incomplete list. No source writes occur. Existing UI recovery handles failures.

### Rollback approach

Revert this child only if needed; preserve all parent proof/alias-aware writers
and migration control. Reverting recreates the known incomplete Home list;
direct league routes remain usable. Do not restore alias-unaware parent code.

### Rollback evidence

Diff changes only a repository read, tests and backlog/docs. No stored schema,
dependency, infrastructure or configuration changes. The original failure was
verified against QA and direct Melbourne league/season access still worked.

## Automated and agent review disposition

Independent architecture/security review found no introduced ACL/privacy blocker
and requested malformed-cursor coverage, now passing in the final test-file run.
The full-suite run preceded that test-only addition; runtime code is unchanged.
Design review confirmed no partial-list
or false-empty-state regression; filtering, names and navigation remain unchanged.
Reviewers did not launch tests. Full validation was serialized under4GiB.

### Unresolved blocking findings

Current-head remote evidence and deployed QA acceptance remain pending. Shared QA
is frozen during the separately authorised migration; it must not be redeployed
mid-migration solely to pass this PR.

### Rejected findings and evidence

None.

## Human judgement

- [x] `human-judgement:none`

### Decision requiring judgement

None for this code change. QA data-removal scope is separately recorded in the
cutover task and is not authorised by this packet.

### Options considered

None.

### Reason selected

None.

### Reversal cost

None.

## Review focus

Falsify pagination completeness, cross-user ACL exclusion, cursor termination and
test fidelity. Check that policy backlog work is not represented as automatic
deletion and that no QA migration or production authority is inferred from CI.
