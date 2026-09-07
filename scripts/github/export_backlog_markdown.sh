#!/usr/bin/env bash
set -euo pipefail

BACKLOG_FILE="${1:-docs/backlog/backlog.json}"
OUT_FILE="${2:-docs/backlog/backlog.md}"

if [[ ! -f "$BACKLOG_FILE" ]]; then
  echo "ERROR: backlog file not found: $BACKLOG_FILE" >&2
  exit 1
fi

jq empty "$BACKLOG_FILE" >/dev/null

{
  echo "# 3FC Backlog"
  echo
  echo "Generated from \`$BACKLOG_FILE\`."
  echo
  echo "## Epics"
  echo
  echo "| ID | Title | Milestone | Child Count |"
  echo "|---|---|---|---:|"
  jq -r '.epics[] | "| `\(.id)` | \(.title) | \(.milestone) | \(.childIssues | length) |"' "$BACKLOG_FILE"
  echo
  echo "## Child Issues"
  echo
  echo "| ID | Title | SP | Parent | Milestone | Depends On |"
  echo "|---|---|---:|---|---|---|"
  jq -r '
    .issues[]
    | "| `\(.id)` | \(.title) | \(.storyPoints) | `\(.parentEpic)` | \(.milestone) | " +
      (if (.dependsOn | length) == 0 then "-" else (.dependsOn | map("`" + . + "`") | join(", ")) end) +
      " |"
  ' "$BACKLOG_FILE"
  echo
  echo "## Delivery Tracking"
  echo
  echo 'As-of planning metadata, not fresh test results or issue-closure evidence. See [frontend redesign](../design/frontend-redesign.md).'
  echo
  echo '| ID | Wave | Status | GitHub | Branch |'
  echo '|---|---|---|---|---|'
  jq -r '.issues[] | select(.delivery) | "| `\(.id)` | \(.delivery.wave) | \(.delivery.status) | " + (if .delivery.githubIssue then "[#\(.delivery.githubIssue)](https://github.com/ajfisher/3fc/issues/\(.delivery.githubIssue))" else "Pending reconciliation" end) + " | \(.delivery.branch // "-") |"' "$BACKLOG_FILE"
  echo
  echo "## Global Test Scenarios"
  echo
  jq -r '.globalTestScenarios[] | "- " + .' "$BACKLOG_FILE"
  echo
  echo "## Assumptions"
  echo
  jq -r '.assumptions[] | "- " + .' "$BACKLOG_FILE"
} > "$OUT_FILE"

echo "Wrote $OUT_FILE"
