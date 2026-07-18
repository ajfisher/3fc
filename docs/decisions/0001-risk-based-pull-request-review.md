# ADR 0001: Risk-based pull-request review

- Status: Accepted
- Date: 2026-07-18
- Deciders: AJ Fisher

## Context

3FC needs consistent review evidence without assuming that a solo maintainer can
supply an independent human approval. Pull requests vary materially in risk:
documentation is not equivalent to authentication, DynamoDB ownership, scoring
rules, public contracts, dependencies, or production deployment controls.

A workflow with write permissions must not execute pull-request-controlled code.
GitHub also does not publish a documented event when a review thread is resolved.

## Decision

Every pull request carries a versioned, machine-readable review packet. A
deterministic `review-gate` classifies effective risk as the maximum of declared
risk, changed-path risk, and selected change-type risk. It evaluates current-head
CI and conditional QA evidence, packet completeness, Codex review currency,
unresolved threads, approvals, architecture disposition, invariants, failure
behaviour, and rollback evidence.

The initial mode is observe-only: non-passing policy results are visible but do
not block merging. Human approvals remain at zero until an independent reviewer
is available. Codex cloud review is advisory and is current only when GitHub
exposes a matching review commit SHA.

The privileged workflow checks out only the trusted default branch and uses
least-privilege repository permissions. It never checks out or executes PR-head
code. Review-thread resolution is reconciled by an authorised
`/review-gate refresh`, manual dispatch, or the hourly open-PR sweep.

## Consequences

- Review expectations are explicit, versioned, and fixture-tested.
- Medium and high-risk changes require QA without making `deploy-qa` a universal
  branch requirement.
- High-risk changes require architecture, invariant, failure, and rollback
  evidence even when a second human is unavailable.
- Default-branch policy changes take effect only after landing, so a PR cannot
  weaken its own trusted gate.
- GitHub ruleset enforcement remains a later administrative rollout step.

## Alternatives considered

- A uniform gate was rejected because it adds excessive ceremony to low-risk
  changes and insufficient scrutiny to sensitive changes.
- `CODEOWNERS` and required approval were deferred because a solo maintainer
  cannot provide an independent approval.
- An API-backed Codex Action was rejected for the initial rollout because the
  GitHub app supplies advisory review without an API key or PR-head execution.
- Immediate enforcement was deferred until real check names, reviewer metadata,
  QA transitions, and false-positive rates are observed.

## Reversal

Revert the review-system commits or remove the workflow and policy. The existing
`PR checks / merge-gate` and QA workflow remain independent, and no application
data migration is involved.

## Related material

- Invariants: INV-001 through INV-009
- Design documents: `docs/review-process.md`
- GitHub issues: REV-01 through REV-06 in the Review System Rollout milestone
