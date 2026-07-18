# Pull request review process

3FC uses a repository-native review packet and deterministic `review-gate` check
to prepare pull requests for focused human review. The initial rollout is
observe-only: it reports the result that policy would produce without becoming a
required merge check.

## Operating model

1. State one observable behavioural claim in the pull request.
2. Map acceptance criteria to concrete test, check, or QA evidence.
3. Run the existing `PR checks` workflow and QA deployment when policy requires it.
4. Ask Codex for an independent review.
5. Resolve or rebut findings and refresh the evidence packet.
6. Use the `review-gate` summary to identify missing evidence or decisions.
7. Ask a human to review the remaining judgement and material risk.

Codex is a semantic challenger, not the merge authority. It cannot bypass a
deterministic policy rule.

## Review packet

The pull request template is versioned with
`<!-- review-packet-version:1 -->`. Its headings and table columns are a public
interface consumed by the gate. Keep prose concise, but do not rename or remove
the headings without updating the parser and tests.

Every pull request requires:

- one non-empty behavioural claim
- a declared risk of `low`, `medium`, or `high`
- exactly one architecture-impact selection

Medium and high-risk changes require at least one acceptance criterion with
evidence. High-risk changes additionally require failure behaviour, a rollback
approach, and affected invariant identifiers or the explicit value `none`.
Rejected automated findings require both a reason and evidence. A requested
human decision requires a decision statement and reversal cost.

## Risk policy

`.github/review-policy.yml` is the base-branch source of truth. It uses JSON
syntax, which is a valid YAML subset, so the gate can parse it with the Node
runtime without introducing a YAML package solely for CI.

The policy contains:

- `version` and `mode`
- named CI and QA check groups
- Codex reviewer identities
- path and change-type risk rules
- evidence and review requirements per tier
- architecture triggers
- managed label definitions

Effective risk is the maximum of author-declared, path-derived, and
change-type-derived risk. Unmatched paths are low risk. A pull request can
declare a higher risk but cannot lower the risk inferred by policy.

## Check and label states

The gate publishes one check named `review-gate`. In `observe` mode, a passing
evaluation concludes successfully and all other evaluation states conclude
neutral. The summary still shows the would-be state and every unblock action.

The gate owns labels with these prefixes and never removes unrelated labels:

- `risk:` — `low`, `medium`, or `high`
- `review:` — automated, awaiting evidence, awaiting judgement, awaiting human,
  blocked, or ready
- `architecture:` — none, documented, or judgement required

`review:agent-fixing` is reserved for a future explicit workflow state because
the gate cannot infer active agent work reliably from GitHub metadata.

## Codex cloud review

Connect this repository in Codex settings, enable Code review, and optionally
enable Automatic reviews. A focused manual review can be requested with:

```text
@codex review for invariant impact, failure behaviour, and rollback safety
```

The configured reviewer login is `chatgpt-codex-connector[bot]`. The gate reports:

- `current` when a formal Codex review references the current PR head SHA
- `stale` when its review references an older SHA
- `unknown` when Codex activity exists but GitHub does not expose a reviewed SHA
- `missing` when no Codex review signal exists

Cloud review remains advisory in observe mode. Unknown currency is never reported
as current.

## Refresh behaviour

The gate refreshes on PR edits and synchronization, reviews, review comments,
completion of `PR checks` or `Deploy QA`, and an hourly open-PR sweep.

GitHub Actions does not expose review-thread resolution as a documented workflow
trigger. For an immediate refresh after resolving a thread, comment:

```text
/review-gate refresh
```

The workflow also supports manual dispatch with a PR number. Native GitHub
conversation-resolution protection remains the authoritative merge control.

## Rollout

### Phase 1: Observe

- keep `PR checks / merge-gate` as the existing required check
- do not require `review-gate`
- collect risk escalations, missing evidence, false positives, and review timing
- confirm the real Codex reviewer identity and check names on pilot pull requests

### Phase 2: Enforce medium and high risk

Only after an independent reviewer is available:

- change policy mode to `enforce`
- require `review-gate` without removing existing required checks
- require one independent approval for medium and high risk
- require conversation resolution and stale-approval handling
- keep QA conditional inside `review-gate`; do not require `deploy-qa` globally

### Phase 3: Evaluate low-risk relaxation

Consider reducing low-risk human review only after measured evidence shows the
gate and Codex review are reliable. Auto-merge remains out of scope.

## Manual GitHub setup

Repository administrators must:

1. Restore authenticated GitHub CLI access before inspecting or changing settings.
2. Connect the repository to Codex and enable Code review/Automatic reviews.
3. Confirm the `chatgpt-codex-connector[bot]` login and review metadata in a pilot.
4. Keep the current `PR checks / merge-gate` requirement during observe mode.
5. Enable required conversation resolution if it is not already enabled.
6. Avoid requiring `review-gate` until the observe ticket is complete.
7. Before enforcement, configure stale approvals, latest-push approval, one
   independent approver, and tightly scoped bypass permissions.

This solo-safe rollout intentionally does not add `CODEOWNERS`.

## Completion report

An implementation PR should report:

- implemented behaviour and changed files
- existing workflow/check names used
- Codex integration mode and review-currency limitation
- tests and static checks run
- security decisions
- remaining GitHub/Codex setup
- proposed ruleset settings
- invariants or ownership details needing confirmation
