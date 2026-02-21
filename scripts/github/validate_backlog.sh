#!/usr/bin/env bash
set -euo pipefail

BACKLOG_FILE="${1:-docs/backlog/backlog.json}"

if [[ ! -f "$BACKLOG_FILE" ]]; then
  echo "ERROR: backlog file not found: $BACKLOG_FILE" >&2
  exit 1
fi

jq empty "$BACKLOG_FILE"

jq -e '
  . as $root
  | ($root.labels | map(.name)) as $labels
  | ($root.milestones | map(.name)) as $milestones
  | ($root.epics | map(.id)) as $epic_ids
  | ($root.issues | map(.id)) as $issue_ids
  | ($epic_ids + $issue_ids) as $all_ids

  | if ($all_ids | length) == ($all_ids | unique | length) then true
    else error("Duplicate issue/epic IDs detected")
    end

  | if (($root.issues | map(.storyPoints)) | all(IN(1,2,3,5,8))) then true
    else error("Story points must be one of 1,2,3,5,8")
    end

  | if (($root.epics | map(.labels[])) | all(IN($labels[]))) then true
    else error("Epic uses unknown label")
    end

  | if (($root.issues | map(.labels[])) | all(IN($labels[]))) then true
    else error("Issue uses unknown label")
    end

  | if (($root.epics | map(.milestone)) | all(IN($milestones[]))) then true
    else error("Epic uses unknown milestone")
    end

  | if (($root.issues | map(.milestone)) | all(IN($milestones[]))) then true
    else error("Issue uses unknown milestone")
    end

  | if (($root.issues | map(.parentEpic)) | all(IN($epic_ids[]))) then true
    else error("Issue references unknown parent epic")
    end

  | if (($root.issues | map(.dependsOn[]?)) | all(IN($all_ids[]))) then true
    else error("Issue dependency references unknown ID")
    end

  | true
' "$BACKLOG_FILE" >/dev/null

echo "Backlog validation OK: $BACKLOG_FILE"
