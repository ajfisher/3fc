#!/usr/bin/env bash
set -euo pipefail

BACKLOG_FILE="docs/backlog/backlog.json"
REPO="${REPO:-}"
DRY_RUN=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --repo <owner/repo>      GitHub repository (defaults from git remote.origin.url)
  --backlog-file <path>    Backlog JSON file (default: docs/backlog/backlog.json)
  --dry-run                Print planned actions without creating anything
  -h, --help               Show this help text

Environment:
  REPO                     Alternative way to supply owner/repo
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --backlog-file)
      BACKLOG_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

need_cmd gh
need_cmd jq

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/validate_backlog.sh" "$BACKLOG_FILE" >/dev/null

if [[ -z "$REPO" ]]; then
  origin_url="$(git config --get remote.origin.url || true)"
  if [[ "$origin_url" =~ github.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
    REPO="${BASH_REMATCH[1]}"
  fi
fi

if [[ -z "$REPO" ]]; then
  echo "ERROR: could not infer repo. Pass --repo <owner/repo>." >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  gh auth status >/dev/null
fi

MILESTONE_MAP_FILE="$(mktemp)"
ISSUE_MAP_FILE="$(mktemp)"
: > "$MILESTONE_MAP_FILE"
: > "$ISSUE_MAP_FILE"

cleanup() {
  rm -f "$MILESTONE_MAP_FILE" "$ISSUE_MAP_FILE"
}
trap cleanup EXIT

log() {
  echo "[$(date +%H:%M:%S)] $*"
}

map_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -F '\t' -v OFS='\t' -v k="$key" -v v="$value" '
    BEGIN { updated = 0 }
    $1 == k { print k, v; updated = 1; next }
    { print }
    END { if (!updated) print k, v }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

map_get() {
  local file="$1" key="$2"
  awk -F '\t' -v k="$key" '
    $1 == k { print $2; found = 1; exit }
    END { if (!found) exit 1 }
  ' "$file"
}

build_label_args() {
  local json="$1"
  while IFS= read -r label; do
    LABEL_ARGS+=(--label "$label")
  done < <(jq -r '.labels[]' <<<"$json")
}

format_id_ref() {
  local id="$1" num
  if num="$(map_get "$ISSUE_MAP_FILE" "$id" 2>/dev/null)"; then
    printf '`%s` (#%s)' "$id" "$num"
  else
    printf '`%s`' "$id"
  fi
}

build_dep_lines() {
  local issue_json="$1"
  local deps dep
  deps="$(jq -r '.dependsOn[]?' <<<"$issue_json")"
  if [[ -z "$deps" ]]; then
    printf '%s\n' "- None"
    return
  fi
  while IFS= read -r dep; do
    [[ -z "$dep" ]] && continue
    printf -- '- %s\n' "$(format_id_ref "$dep")"
  done <<<"$deps"
}

render_epic_body() {
  local epic_json="$1" outfile="$2"
  jq -r '
    "<!-- backlog-id:" + .id + " -->\n\n" +
    "## Summary\n" + .summary + "\n\n" +
    "## Milestone\n- " + .milestone + "\n\n" +
    "## Target Outcomes\n" + (.outcomes | map("- " + .) | join("\n")) + "\n\n" +
    "## Child Issues\n" + (.childIssues | map("- `" + . + "`") | join("\n")) + "\n"
  ' <<<"$epic_json" > "$outfile"
}

render_issue_body() {
  local issue_json="$1" outfile="$2" parent_epic parent_ref depends_block

  parent_epic="$(jq -r '.parentEpic' <<<"$issue_json")"
  parent_ref="$(format_id_ref "$parent_epic")"
  depends_block="$(build_dep_lines "$issue_json")"

  jq -r \
    --arg parent_ref "$parent_ref" \
    --arg depends_block "$depends_block" '
      "<!-- backlog-id:" + .id + " -->\n\n" +
      "## Summary\n" + .summary + "\n\n" +
      "## Story Points\n- " + (.storyPoints | tostring) + "\n\n" +
      "## Parent Epic\n- " + $parent_ref + "\n\n" +
      "## Milestone\n- " + .milestone + "\n\n" +
      "## Labels\n" + (.labels | map("- `" + . + "`") | join("\n")) + "\n\n" +
      "## Depends On\n" + $depends_block + "\n\n" +
      "## Scope\n" + (.scope | map("- " + .) | join("\n")) + "\n\n" +
      "## Out of Scope\n" + (.outOfScope | map("- " + .) | join("\n")) + "\n\n" +
      "## Acceptance Criteria\n" + (.acceptanceCriteria | map("- [ ] " + .) | join("\n")) + "\n\n" +
      "## Test Scenarios\n" + (.testScenarios | map("- " + .) | join("\n")) + "\n"
    ' <<<"$issue_json" > "$outfile"
}

create_labels() {
  log "Ensuring labels"
  while IFS= read -r label_json; do
    local name color description
    name="$(jq -r '.name' <<<"$label_json")"
    color="$(jq -r '.color' <<<"$label_json")"
    description="$(jq -r '.description' <<<"$label_json")"

    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "[dry-run] gh label create '$name' --repo '$REPO' --color '$color' --description '$description' --force"
    else
      gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force >/dev/null
      log "Label ready: $name"
    fi
  done < <(jq -c '.labels[]' "$BACKLOG_FILE")
}

load_existing_milestones() {
  local existing
  existing="$(gh api "repos/$REPO/milestones?state=all&per_page=100")"
  while IFS=$'\t' read -r title number; do
    [[ -z "$title" ]] && continue
    map_set "$MILESTONE_MAP_FILE" "$title" "$number"
  done < <(jq -r '.[] | "\(.title)\t\(.number)"' <<<"$existing")
}

ensure_milestones() {
  log "Ensuring milestones"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    load_existing_milestones
  fi

  while IFS= read -r milestone_json; do
    local name description number response
    name="$(jq -r '.name' <<<"$milestone_json")"
    description="$(jq -r '.description' <<<"$milestone_json")"

    if number="$(map_get "$MILESTONE_MAP_FILE" "$name" 2>/dev/null)"; then
      log "Milestone exists: $name (#$number)"
      continue
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "[dry-run] gh api repos/$REPO/milestones --method POST -f title='$name' -f description='<omitted>'"
      continue
    fi

    response="$(gh api "repos/$REPO/milestones" --method POST -f title="$name" -f description="$description")"
    number="$(jq -r '.number' <<<"$response")"
    map_set "$MILESTONE_MAP_FILE" "$name" "$number"
    log "Created milestone: $name (#$number)"
  done < <(jq -c '.milestones[]' "$BACKLOG_FILE")
}

load_existing_issue_id_map() {
  local existing
  existing="$(gh issue list --repo "$REPO" --state all --limit 1000 --json number,body)"
  while IFS=$'\t' read -r id number; do
    [[ -z "$id" ]] && continue
    map_set "$ISSUE_MAP_FILE" "$id" "$number"
  done < <(
    jq -r '
      .[]
      | (try ((.body // "") | capture("backlog-id:(?<id>[A-Z0-9-]+)").id) catch "") as $id
      | select($id != "")
      | "\($id)\t\(.number)"
    ' <<<"$existing"
  )
}

create_issue_from_json() {
  local json="$1"
  local id title milestone full_title existing_num tmp_body issue_url issue_num

  id="$(jq -r '.id' <<<"$json")"
  title="$(jq -r '.title' <<<"$json")"
  milestone="$(jq -r '.milestone' <<<"$json")"
  full_title="[$id] $title"

  if existing_num="$(map_get "$ISSUE_MAP_FILE" "$id" 2>/dev/null)"; then
    log "Issue exists: $full_title (#$existing_num)"
    return
  fi

  tmp_body="$(mktemp)"
  if [[ "$(jq -r 'has("storyPoints")' <<<"$json")" == "true" ]]; then
    render_issue_body "$json" "$tmp_body"
  else
    render_epic_body "$json" "$tmp_body"
  fi

  LABEL_ARGS=()
  build_label_args "$json"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] gh issue create --repo '$REPO' --title '$full_title' --milestone '$milestone' --label ... --body-file '$tmp_body'"
    cat "$tmp_body"
    rm -f "$tmp_body"
    return
  fi

  issue_url="$(gh issue create --repo "$REPO" --title "$full_title" --body-file "$tmp_body" --milestone "$milestone" "${LABEL_ARGS[@]}")"
  issue_num="${issue_url##*/}"
  map_set "$ISSUE_MAP_FILE" "$id" "$issue_num"
  rm -f "$tmp_body"
  log "Created issue: $full_title (#$issue_num)"
}

log "Using repository: $REPO"
log "Using backlog file: $BACKLOG_FILE"

create_labels
ensure_milestones
if [[ "$DRY_RUN" -eq 0 ]]; then
  load_existing_issue_id_map
fi

log "Creating epic issues"
while IFS= read -r epic_json; do
  create_issue_from_json "$epic_json"
done < <(jq -c '.epics[]' "$BACKLOG_FILE")

log "Creating child issues"
while IFS= read -r issue_json; do
  create_issue_from_json "$issue_json"
done < <(jq -c '.issues[]' "$BACKLOG_FILE")

if [[ "$DRY_RUN" -eq 0 ]]; then
  log "Backlog sync complete"
  log "Issue map:"
  sort "$ISSUE_MAP_FILE" | awk -F '\t' '{ printf "%s\t#%s\n", $1, $2 }'
else
  log "Dry-run complete"
fi
