<!-- review-packet-version:1 -->

## Behavioural claim

The complete reusable-player stack has current proof-aware browser regression,
a repeatable isolated local M2 journey and an explicit operational evidence index.
Local acceptance services can be constrained to loopback without changing their
default binding or any Lambda authentication/data behavior.

Refs #162. Physical-device criteria remain tracked; this PR does not prematurely
close the issue. Base: `codex/returning-player-join` (#168).

## Specification and acceptance evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Explicit proof confirmation; no proofless claim; unknown-session/storage failure recovery | Focused5 and full71 results-entry Playwright fixtures, group31500 exit0, peak1319648KiB, remaining[] | PASS |
| Actual sign-in, setup, player creation/anonymous proof join, scoring and finished corrections | Disposable M2 group31360,4 tests, actual API/app/DynamoDB/fake email | PASS |
| Private listener and secret-safe local operation | M2 verifies127.0.0.1 actual addresses; status-only reporter; reporter regression | PASS |
| Exact owned cleanup including ambiguous Docker creation | UUID-only inventory/cleanup; M2 workers closed, database absent, private directory removed | PASS |
| Full unit/contract/security/build/backlog validation | Group31843,493 API/636 app/4 operator/57 gate, lint/typecheck, contracts, backlog/export and build; exit0, peak2262560KiB, remaining[] | PASS |
| Current-head CI/QA/Codex and review gate | PR links appended after publishing | PENDING |
| Physical iOS/Android | Explicit checklist in delivery index/#162; no emulation substituted | NOT RUN |

## Scope boundaries

Included: Current-browser fixture DTO/state repair, explicit claim confirmation
and recovery tests, real proof-generating anonymous M2 join, isolated local M2
runner, optional loopback host for local entrypoints, secret-safe test reporting,
canonical backlog and issue-to-evidence operational handoff.

Excluded: New player product features, scoring/identity/auth contract changes,
new infrastructure/resources/IAM, production migration or release, merge,
physical-device acceptance claims, cross-league import and automatic matching.

## Change classification

- Declared risk: `medium`
- [x] `tests-only`
- [x] `application-behaviour`
- [x] `backlog-maintenance`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-001 | Proof/returning fixture models private identity access | No product ACL change; unknown routes/proofless claims remain denied | Explicit recovery/preview rejection tests |
| INV-003 | Retry fixtures and real anonymous M2 registration | Original proof-bound identity/key retained; tests compare exact query and safe request fingerprint | Lost-response and explicit claim retry fixtures |
| INV-005 | Full M2 goal/correction flow exercises scoring | No event/stat computation changes; existing real smoke assertions retained | Actual disposable M2 pass |
| INV-009 | Local services carrying synthetic auth proofs gain explicit loopback binding; browser reporting | Default host unchanged; harness requires actual127.0.0.1, no raw errors/attachments emitted, private emails/output removed | M2 address assertions and private reporter regression |

### Architecture or decision record

[Player identity acceptance](player-identity-acceptance.md) records parent SHAs,
current versus inherited evidence and the operational authorization boundary.
`THREEFC_LISTEN_HOST` is an optional local Node entrypoint setting; it is not a
Serverless switch or authentication setting. Absent it, existing bind behavior
is unchanged. The M2 wrapper pins local dummy credentials and explicit generated
database endpoints, uses no existing volume and never reads an AWS profile.

## Failure and rollback

### Failure behaviour

Unknown transport fixtures fail instead of silently succeeding. Blocked proof
storage prevents dispatch; response loss preserves the same attempt; definitive
proof failures offer recovery, not unrestricted claiming. M2 exits nonzero on a
failed browser run, cleans all owned services/data and withholds credential-bearing
error messages. Safe source coordinates identify a focused diagnostic target.
An abnormal resource run must not be retried without cleanup and bounded cause.

### Rollback approach

Revert this acceptance-only child/local optional bind setting if required; retain
all parent proof, canonical/alias and revision-aware application code. Never
revert the stack to an alias-unaware binary after consolidation. Production
disablement/cutover follows the separately approved feature runbooks.

### Rollback evidence

Host is omitted by default, retaining existing local bind behavior. No deployment
configuration or persisted data model changed here. M2 creates only a new UUID
container and disposable in-memory table, verifies complete removal, and deletes
its private generated email/browser directory after actual worker close. Parent
disabled-write and alias-compatible rollback tests remain in the complete suite.

## Automated and agent review disposition

Independent engineering/QA review corrected obsolete proofless/automatic claim
expectations and strengthened exact-target retry and404/409 failure coverage.
Architecture/security review identified LAN-listening test services and ambiguous
Docker-start cleanup. Both were fixed before the actual M2 run. Raw browser output
can bypass a reporter, so the parent also forwards only bounded, validated status
records. No competing reviewer test processes were launched.
Final architecture/security review found no concrete blocker. The suggestion
that results-entry needs a running app server was checked and rejected: its
route fixture fulfills HTML/assets itself; the71-case run passed without one.
M2 group31360 exited0, peak1330512KiB plus512MiB Docker, remaining[].

Codex review5177134464 at c1dbf0c identified Docker-cleanup failure skipping
private artifact deletion. Cleanup now attempts every named owned-resource step,
withholds raw errors and reports failure only after private artifacts have also
been handled. A deterministic failure test covers this order. Its readiness
ordering concern is made explicit through a tested wait for both healthy HTTP
and confirmed loopback metadata; no reliance on stdout event order remains.
Final-head validation and remote evidence are refreshed after these changes.
Independent architecture/security re-review cleared the changes. Focused7 safety
tests passed under group37648, exit0, peak50784KiB, remaining[]. Full group37720
passed493 API/636 app/10 operator/57 gate tests, lint/typecheck, contracts,
backlog validation/export and build; exit0, peak2526272KiB, remaining[].
Corrected real M2 group42960 passed all4 tests, exit0, peak1308592KiB plus512MiB
Docker, remaining[]; actual worker, database and private-artifact cleanup verified.
Refreshed71 entry-browser tests passed under group43093, exit0,
peak1384176KiB, remaining[].

### Unresolved blocking findings

Current-head remote evidence remains pending.

### Rejected findings and evidence

Suggested app-server prerequisite for results-entry: not applicable. Its route
fixture serves HTML/assets itself; the71-test run passed with the web server
disabled and no local services. Documentation now states this explicitly.

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

Attempt to falsify proof fixture fidelity, exact retries, local-only service
binding, cleanup after ambiguous startup, credential-safe reporter output and
the distinction between inherited evidence, fresh runs and remaining physical
checks. No merge, production migration or release is authorized by this packet.
