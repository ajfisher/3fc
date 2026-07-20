# Review invariants

These identifiers turn 3FC's durable product and system rules into reviewable
constraints. Pull requests explain every invariant they affect and provide
evidence proportionate to the failure consequence.

| ID | Invariant and failure consequence | Evidence expected | Canonical source |
| --- | --- | --- | --- |
| INV-001 | Public pages, public API responses, telemetry, logs, and generated pages never expose player or user email addresses. A breach discloses private identity data. | Contract and response tests showing that public shapes contain nickname and optional avatar only. | `docs/product.md`, `docs/spec.md`, `AGENTS.md` |
| INV-002 | Every protected write requires a valid session and the applicable league-scoped administrator or scorekeeper permission. A breach permits unauthorised changes or privilege escalation. | Positive and negative route-boundary tests, including cross-league access attempts. | `docs/spec.md`, `docs/openapi/v1-core-write.yaml`, `AGENTS.md` |
| INV-003 | Writes identified as idempotent replay the stored result for the same key and payload and reject conflicting key reuse. A breach creates duplicate or conflicting durable state. | Tests for first use, exact replay, conflicting reuse, and concurrent creation. | `docs/spec.md`, `docs/openapi/v1-core-write.yaml`, `AGENTS.md` |
| INV-004 | DynamoDB entities retain the documented single-table ownership and PK/SK addressing; games remain globally addressable by `gameId`, while seasons remain league-scoped. A breach creates orphaned, ambiguous, or inaccessible state. | Repository access-pattern tests and an updated ownership design when keys or indexes change. | `docs/spec.md`, `docs/dynamodb-single-table.md`, `AGENTS.md` |
| INV-005 | Team `conceded` and `scored` are distinct. An own goal increases only the conceding team's conceded tally and never a team scored tally or player goal tally. A breach corrupts match and season statistics. | Scoring and aggregation tests for normal goals, own goals, corrections, and undo. | `docs/product.md`, `docs/spec.md`, `AGENTS.md` |
| INV-006 | A game winner is the team with fewest conceded, then most scored; equal values produce a draw. A breach produces the wrong match result. | Comparator tests covering every tie pattern. | `docs/product.md`, `docs/spec.md`, `AGENTS.md` |
| INV-007 | Season standings sort by wins descending, draws descending, conceded ascending, then scored descending, with stable final tie treatment. A breach produces incorrect or unstable standings. | Comparator tests with ties at each successive field. | `docs/product.md`, `docs/spec.md`, `AGENTS.md` |
| INV-008 | A goal has at most three unique assisters, the scorer cannot assist their own goal, and assisters may be any player rostered in the game. A breach rejects valid events or corrupts player statistics. | Validation tests for the upper bound, duplicates, scorer exclusion, and cross-team assists. | `docs/product.md`, `docs/spec.md`, `AGENTS.md` |
| INV-009 | Sessions use httpOnly cookies with environment-appropriate secure flags, and app/API responses retain CSP and security-header defaults. A breach weakens session or browser security. | Cookie and security-header tests plus QA evidence for deployed configuration changes. | `docs/spec.md`, `AGENTS.md` |

Adding, changing, or removing an invariant is a high-risk architecture change.
Update the canonical source, record the decision in `docs/decisions/`, and cite
the invariant ID in the pull-request packet.

For every affected invariant, the pull-request packet must state:

- how the PR affects the invariant
- why the invariant remains valid after the change
- the evidence reviewers should use to verify that claim
