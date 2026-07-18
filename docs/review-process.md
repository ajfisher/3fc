# Pull-request review system

3FC uses a versioned review packet and deterministic `review-gate` check to make
the evidence for a change visible without pretending that a solo maintainer can
supply an independent human approval. ADR
[`0001`](decisions/0001-risk-based-pull-request-review.md) records the trust and
rollout decision.

## Author workflow

1. Keep `<!-- review-packet-version:1 -->`, the fixed headings, and the
   backticked machine tokens in the pull-request template.
2. Replace the declared-risk chooser with exactly `low`, `medium`, or `high`.
3. Select every applicable change type, one architecture disposition, and one
   human-judgement disposition.
4. Link acceptance evidence. Medium and high risk require passing evidence;
   high risk also requires affected invariants, failure behaviour, a rollback
   approach, and rollback evidence.
5. Resolve automated findings or record rejected findings with supporting
   evidence.
6. Run `npm run test:review-gate` and the validation appropriate to the changed
   product scope.
7. Direct human and Codex review to the highest-risk assumptions.

The packet headings and tokens are a repository interface consumed by
`scripts/review-gate/packet.mjs`. Update the parser and fixtures in the same
change if that interface changes.

## Risk and evidence policy

`.github/review-policy.yml` is trusted base-branch configuration. It uses JSON
syntax, which is a valid YAML subset, so validation needs no YAML package.
`npm run review-policy:check` validates the schema.

Effective risk is the maximum of author-declared, changed-path, and selected
change-type risk. A pull request may declare higher risk but cannot reduce risk
inferred by policy.

| Effective risk | Acceptance evidence | QA | Failure and rollback evidence | Invariant declaration | Human approvals |
| --- | --- | --- | --- | --- | --- |
| Low | Optional | Optional | Optional | Optional | 0 |
| Medium | Required and passing | Required | Optional | Optional | 0 |
| High | Required and passing | Required | Required | Required, or explicit `None` | 0 |

Dependencies, authentication/authorisation, privacy, ownership, contracts,
infrastructure, workflows, review controls, `AGENTS.md`, ADRs, and the invariant
registry are high risk. Remaining application, API, script, and backlog changes
are medium risk. Documentation and unmatched paths default to low risk.

## Gate output and labels

The gate publishes one current-head check named `review-gate` and excludes that
check from its own CI inputs. Its summary uses tables for risk, current-head
evidence, and review state, followed by blockers, pending evidence, and exact
unblock actions.

In `observe` mode a pass concludes successfully and every non-passing state is
neutral. The underlying result remains visible but is not an authoritative merge
decision.

The gate replaces exactly one label in each managed family and preserves every
unrelated label:

| Family | Values |
| --- | --- |
| `risk:` | `low`, `medium`, `high` |
| `review:` | `automated`, `awaiting-evidence`, `awaiting-judgement`, `awaiting-human`, `blocked`, `ready` |
| `architecture:` | `none`, `documented`, `judgement-required` |

`review:agent-fixing` is reserved for a future explicit workflow state because
active agent work cannot be inferred reliably from GitHub metadata.

## Codex cloud review

Connect the repository in Codex settings and enable Code review and Automatic
reviews. A focused review can be requested with:

```text
@codex review for invariant impact, failure behaviour, and rollback safety
```

The configured login is `chatgpt-codex-connector[bot]`. The gate reports Codex
as:

- `current` only when a formal review references the current PR head SHA
- `stale` when the review references an older SHA
- `unknown` when Codex activity exists but GitHub exposes no reviewed SHA
- `missing` when no configured Codex signal exists

Codex is an advisory semantic challenger, not the merge authority. An unknown or
unverified review is never presented as current.

## Trusted execution and refresh

The workflow reacts to PR metadata, review events, review comments, completed
`PR checks` and `Deploy QA` workflow runs, manual dispatch, and an hourly open-PR
sweep. It checks out only the repository default branch using commit-pinned
Actions. It never checks out, imports, or executes PR-head code with write
permissions.

GitHub Actions exposes no documented event for review-thread resolution. After
resolving a thread, a repository owner, member, or collaborator can comment
exactly:

```text
/review-gate refresh
```

Manual dispatch accepts a PR number. The hourly sweep closes the remaining event
gap, while native GitHub conversation resolution remains authoritative.

## Rollout

### Phase 1: Observe

- retain the existing required `PR checks / merge-gate`
- leave `review-gate` unrequired
- preserve the existing `QA-ready` deployment behaviour
- collect false positives and confirm real check and Codex reviewer metadata
- do not add `CODEOWNERS`, auto-merge, or an API-backed review Action

### Phase 2: Enforce medium and high risk

Only after an independent reviewer is available:

- change policy mode to `enforce`
- require `review-gate` without removing existing checks
- require one independent approval for medium and high risk
- require conversation resolution, stale-approval dismissal, and approval of
  the latest reviewable push
- keep QA conditional inside `review-gate`; do not require `deploy-qa` globally

### Phase 3: Evaluate low-risk relaxation

Consider low-risk approval changes, metrics, and an optional Project dashboard
only after observation shows that classification and Codex signals are reliable.

## Manual GitHub setup

Repository administrators must connect Codex, confirm the reviewer login and
review commit metadata on a pilot, retain `PR checks / merge-gate`, and avoid
requiring `review-gate` until REV-04 is complete. Before enforcement, re-inspect
the live ruleset, check identities, QA environment, stale-approval behaviour,
latest-push approval, and bypass permissions. No existing protection may be
weakened.

## Completion report

An implementation PR reports the changed behaviour, check identities, Codex
integration and currency limitation, validation performed, trust decisions,
remaining manual setup, proposed later ruleset settings, and any invariant or
ownership detail needing confirmation.
