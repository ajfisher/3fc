# System invariants

This registry records behaviours that must remain true across implementation
changes. Pull requests should reference these identifiers when they affect an
invariant, and should provide evidence proportionate to the failure consequence.

## INV-001: Public identity privacy

Statement: Public pages and public API responses never expose player or user
email addresses. Email is visible only to the owner and authorized administrators.

Applies to: Public routes, response contracts, profiles, results, leaderboards,
logs, and generated static pages.

Evidence expected: Contract and response tests demonstrating that public shapes
contain nickname and optional avatar only.

Failure consequence: Disclosure of private identity data.

Owner: 3FC maintainers.
## INV-002: Protected mutations require authorization

Statement: Every protected write requires a valid session and the applicable
league-scoped administrative or scorekeeper permission before state changes.

Applies to: Authenticated `/v1` mutation routes, ACL resolution, session handling,
and repository writes.

Evidence expected: Positive and negative authorization tests at the route boundary,
including cross-league access attempts.

Failure consequence: Unauthorized changes or privilege escalation.

Owner: 3FC maintainers.

## INV-003: Specified writes are idempotent

Statement: Write endpoints identified by the API contract as idempotent replay the
stored result for the same key and payload, and reject reuse of the key for a
different payload.

Applies to: Goal writes, game finish, and any later endpoint marked idempotent.

Evidence expected: Tests for first use, exact replay, conflicting reuse, and
concurrent create behaviour.

Failure consequence: Duplicate or conflicting durable state.

Owner: 3FC maintainers.

## INV-004: Single-table ownership and addressing

Statement: DynamoDB entities retain the documented PK/SK ownership patterns;
games remain globally addressable by `gameId`, while season identity remains
scoped by league and season.

Applies to: Repository keys, indexes, migrations, entity ownership, and API lookup
paths.

Evidence expected: Repository access-pattern tests and an updated
`docs/dynamodb-single-table.md` when ownership changes.

Failure consequence: Orphaned, ambiguous, or inaccessible durable state.

Owner: 3FC maintainers.

## INV-005: Scored and conceded remain distinct

Statement: Team `conceded` and `scored` are separate tallies. An own goal increases
the conceding team's conceded tally and never increases another team's scored
tally or a player's goals-scored total.

Applies to: Goal creation, correction, game results, aggregates, standings, and
leaderboards.

Evidence expected: Scoring-engine and aggregation tests covering normal and own
goals, including edits and undo.

Failure consequence: Incorrect match results and season statistics.

Owner: 3FC maintainers.

## INV-006: Winner comparison is deterministic

Statement: A game winner is the team with fewest conceded, then most scored; the
result is a draw when those values remain equal.

Applies to: Game finish, results, summaries, and notifications.

Evidence expected: Comparator tests covering every tie pattern.

Failure consequence: Incorrect match outcome.

Owner: 3FC maintainers.

## INV-007: Season ordering is deterministic

Statement: Season standings sort by wins descending, draws descending, conceded
ascending, then scored descending, with a stable final tie treatment.

Applies to: Season aggregation, public tables, and exports.

Evidence expected: Comparator tests with ties at each successive field.

Failure consequence: Incorrect or unstable standings.

Owner: 3FC maintainers.

## INV-008: Assist attribution follows v0 rules

Statement: A goal has at most three unique assisters, the scorer cannot assist
their own goal, and assisters may come from any player rostered in the game.

Applies to: Goal validation, correction, timeline rendering, and player stats.

Evidence expected: Validation tests for the upper bound, duplicates, scorer
exclusion, and cross-team assists.

Failure consequence: Rejected valid events or incorrect player statistics.

Owner: 3FC maintainers.

## INV-009: Session and browser security defaults

Statement: Authentication sessions use httpOnly cookies with environment-appropriate
secure flags, and app/API responses retain CSP and security-header defaults.

Applies to: Session creation, cookie parsing, CORS, app responses, CloudFront, and
API responses.

Evidence expected: Cookie and security-header tests plus QA verification for
deployed configuration changes.

Failure consequence: Session theft or weakened browser protections.

Owner: 3FC maintainers.
