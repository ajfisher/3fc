# 3FC GitHub Backlog (M0-M4)

This folder contains the canonical implementation backlog for 3FC v0 as GitHub-ready issue metadata.

## Files

- `backlog.json`: Canonical source of truth for labels, milestones, epics, and child issues.
- `README.md`: Usage and workflow.

## What Is Encoded

- Label taxonomy:
  - Areas: `area:infra`, `area:api`, `area:app`, `area:auth`, `area:data`, `area:ops`, `area:qa`
  - Types: `type:feature`, `type:chore`, `type:test`, `type:security`
  - Milestones: `milestone:M0` through `milestone:M4`
  - Priorities: `priority:P0`, `priority:P1`, `priority:P2`
- Epic issues:
  - `EPIC-M0` through `EPIC-M4`
- Child issue backlog:
  - `M0-01` through `M4-05`
- Full issue template fields per issue:
  - Summary, scope, out of scope, acceptance criteria, test scenarios, dependencies, labels, milestone, story points.

## Validate Backlog Data

```bash
./scripts/github/validate_backlog.sh
```

## Create Issues In GitHub

1. Authenticate `gh` against the target repository.
2. Run a dry-run first.
3. Run real sync.

```bash
# Dry-run (no GitHub writes)
./scripts/github/create_backlog_issues.sh --repo <owner/repo> --dry-run

# Create/update labels, milestones, and issues
./scripts/github/create_backlog_issues.sh --repo <owner/repo>
```

Notes:
- The sync script is idempotent for issues created from this backlog by using a hidden issue body marker (`backlog-id:*`).
- Existing issues without the marker are ignored and never modified.
- Labels are upserted with `--force` to keep taxonomy definitions aligned.

## Backlog Maintenance Rules

- Edit only `backlog.json` when changing backlog definitions.
- Keep IDs stable (`EPIC-*`, `M*-*`) after issue creation to preserve idempotency.
- If acceptance criteria changes materially, update issue body manually in GitHub or recreate as needed.

## Delivery Priority

- MVP priority wave: M0 -> M1 -> M2.
- Later roadmap wave: M3 -> M4.

## Locked Product/Rules Inputs (Captured)

- Draws are explicit stats (`wins`, `draws`, `losses`)
- Standings ranking: wins DESC, draws DESC, conceded ASC, scored DESC
- Own goals tracked separately at player level and excluded from goals-scored leaderboard
- Assists allowed from any team in game, max 3, scorer excluded
