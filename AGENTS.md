# AGENTS.md

Default operating guidance for humans and AI agents working in this repository.

## Mission

Build a robust, mobile-first web app for 3FC game setup, live scoring, results, and season stats based on:

- `docs/product.md`
- `docs/spec.md`
- `docs/backlog/backlog.json`

When in doubt, prefer the backlog and specs over assumptions.

## Current Phase

- Phase: backlog-driven implementation kickoff
- Immediate delivery focus: M0 -> M1 -> M2
- Later delivery focus: M3 -> M4

## Non-Negotiable Workflow Rules

- Do not push directly to `main`.
- Use feature branches; for agent work use `codex/<topic>`.
- Use Conventional Commit messages.
- Open PRs with:
  - concise summary
  - validation steps executed
  - known risks or follow-up items

## Source-of-Truth Order

For conflicts, resolve in this order:

1. `docs/backlog/backlog.json` (locked issue scope and rules)
2. `docs/spec.md` (technical architecture and platform constraints)
3. `docs/product.md` (user and product intent)

## Implementation Defaults

### API and Contracts

- Versioned JSON API under `/v1`.
- Use explicit schema validation for inputs/outputs.
- Write endpoints that mutate state should support idempotency where specified.
- Keep error shapes stable and predictable.

### Data Model

- Use DynamoDB single-table patterns from spec.
- Preserve explicit distinction between:
  - team `conceded`
  - team `scored`
- Own goals increase conceding only and do not add to any team scored tally.

### Game Rules and Stats

- Winner comparator: fewest conceded, then most scored, else draw.
- Season table comparator: wins DESC, draws DESC, conceded ASC, scored DESC.
- Assist rules for v0:
  - max 3 assists
  - unique assister IDs
  - scorer cannot be an assister
  - assists may come from any rostered player in game

### Security and Privacy

- Public pages must not expose private email data.
- Favor httpOnly cookie-based auth/session handling.
- Apply CSP and secure header defaults.
- Use least-privilege IAM for infra and runtime roles.

### Frontend UX

- Optimize for phone usage first.
- Keep scorekeeper actions fast and low-friction.
- Avoid heavy client state dependencies unless clearly justified.

## Quality Expectations

Before opening or updating a PR:

- Run relevant validation/tests for touched scope.
- At minimum, when backlog assets change:
  - `make backlog-validate`
  - `make backlog-export`
- If commands are unavailable or unimplemented, note that explicitly in PR.

## Backlog Maintenance Rules

- Edit `docs/backlog/backlog.json` directly.
- Regenerate `docs/backlog/backlog.md` via script/Make target.
- Keep issue and epic IDs stable once synced to GitHub.

## Out-of-Scope Guardrails (v0)

- No offline-first architecture.
- No multi-scorekeeper concurrent edit support.
- No deep event metadata beyond defined scope.

## Preferred Delivery Style

- Small, reviewable PRs.
- Preserve momentum: ship vertical slices that can be tested quickly.
- Document assumptions in code comments or PR notes where behavior is non-obvious.
