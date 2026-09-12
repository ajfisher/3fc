<!-- review-packet-version:1 -->

## Behavioural claim

The final merged player stack can be deliberately released from a verified current
main SHA, with retained production API provenance for the separate audited
migration. Production is held during stack merging; this PR executes no release.

Fixes #175 (PLAYER-08). Base: codex/player-combine-usability (#174).

## Specification and acceptance evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Exact current-main dispatch, input sanitization, stale remote rejection | Four production-release.test.mjs tests, including real temporary local Git repositories; group92109 exit0, peak52976KiB, remaining[] | PASS |
| Guards precede credentials/deployment; manual checkout is validated | Workflow ordering and command assertions in production-release.test.mjs | PASS |
| Accepted core evidence survives later site failure; final artifact is distinct | Artifact paths, pinned action, retention and ordering tests | PASS |
| Temporary production hold and safe future flags without live API changes | Read-only verification of disabled_manually, no active runs, GitHub production proof/false/false variables; preflight in rollout runbook | PASS |
| Production cutover prerequisites, failure and authority boundaries | docs/runbooks/player-production-rollout.md, independently reviewed | PASS |
| Full repository validation | Group92411: lint/typecheck, full workspace tests,14operator/57gate tests, contracts, build and backlog; exit0, peak2861584KiB, remaining[] | PASS |
| Exact-head CI, QA and Codex review | Results attached after publication | PENDING |

## Scope boundaries

Included: manual main-only release with a required full expected SHA; pre-credential
and pre-deploy fresh remote checks; exact manual-checkout lint/tests/contracts;
early API and separate completed-release artifacts; tests, backlog and runbook.
Operational preparation includes temporary workflow disablement and safe future
GitHub Environment variables; these do not deploy configuration to the live API.

Excluded: merge, production deploy/migration, feature activation, copying QA data,
Terraform/IAM changes, permanent approval-policy change or account-index work.

## Change classification

- Declared risk: `high`
- [x] `application-behaviour`
- [x] `infrastructure-production-configuration`
- [x] `backlog-maintenance`

## Architecture and invariants

- [x] `architecture:documented`

### Affected invariants

| Invariant | How this PR affects it | Why it remains valid | Evidence |
| --- | --- | --- | --- |
| INV-004 | Prepares deployment provenance for identity/membership migration | No table writes or identity changes; runbook requires exact writer and verified cutover, retains aliases on rollback | Release guard tests and existing migration CLI tests |
| INV-009 | Adds deliberate production workflow entry and retained artifacts | Main/SHA guards precede credentials; existing API-first security/fingerprint checks stay; artifacts contain only explicit manifests, not cookies or environments | Workflow tests and existing deployment/security-header regression |

### Architecture or decision record

See docs/runbooks/player-production-rollout.md. A disabled workflow prevents
intermediate stack releases, but neither cancels queued work nor auto-replays
missed pushes when re-enabled. Manual dispatch on main with explicit SHA supplies
the final-head release path. The same non-cancelling production lock applies.
The remote check rejects stale push reruns as well as stale manual dispatches.
It is not a distributed merge lock: maintain the documented main/deployment freeze
through the complete release. Existing ordinary main push releases remain enabled
when the operator later lifts the temporary workflow hold.

An early artifact follows only a successfully verified API-core deployment. A
later failed site step cannot erase it. Final release acceptance is a distinct
artifact after site smoke and live API fingerprint verification. If core fails
before producing a valid manifest or upload fails, stop and investigate; this PR
does not invent verified provenance or publish Serverless state/bundles.

## Failure and rollback

### Failure behaviour

Malformed/missing expected SHA, foreign ref, mismatched checkout or advanced remote
main fails before credentials/deploy. Network/git failures are generic and do not
echo credentials or dispatch input. Missing artifacts fail explicitly. A core-only
artifact is not proof of completed site acceptance. Manual test failure prevents
AWS credentials/deploy. No failed-run path invokes migration automatically.

### Rollback approach

Keep production disabled if preparation fails. Reverting this child removes the
manual dispatch/evidence path but does not undo the operational workflow hold or
GitHub variables; inspect those explicitly, never automatically re-enable. After
future migration/consolidation, retain parent alias-aware application code and
use opt-in flags for containment rather than a pre-stack binary.

### Rollback evidence

Real local Git tests reject stale/missing remotes and arbitrary input with no AWS
access. Workflow assertions preserve default false opt-ins, API-first ordering and
final fingerprint checks. Production as-of backup/current-writer status was read
only. No production execution is claimed as validation or rollback proof.

## Automated and agent review disposition

Independent architecture/security and engineering/QA reviews found no material
blocker. QA noted helper tests alone would not exercise Git CLI parsing; a real
temporary-repository CLI test was added and passes. Both reviewers explicitly
qualified early evidence as covering successful core deployment, not fabricated
recovery from an unverified failed core step. The runbook documents that stop case.

### Unresolved blocking findings

Current-head remote acceptance is pending publication.

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

Challenge stale dispatches/reruns, code/ref/input agreement, timing before AWS
credentials, artifact authenticity after partial failure, queued-run exclusion,
backup/writer/drain provenance and claims about production readiness. Final merge,
release and migration still require AJ's separate authority. Parent #171's
account-discovery scalability finding is not resolved by this preparation.
