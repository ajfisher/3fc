#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <qa|prod>" >&2
  exit 1
fi

ENV="$1"

if [[ "$ENV" != "qa" && "$ENV" != "prod" ]]; then
  echo "ENV must be one of: qa, prod" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMMIT_SHA="$(git rev-parse --short HEAD)"
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

ARTIFACT_DIR="out/deploy/$ENV"
ARTIFACT_NAME="3fc-app-${ENV}-${COMMIT_SHA}.tar.gz"
ARTIFACT_PATH="$ARTIFACT_DIR/$ARTIFACT_NAME"
MANIFEST_PATH="$ARTIFACT_DIR/manifest.json"

mkdir -p "$ARTIFACT_DIR"

echo "[deploy] Building workspaces"
npm run build >/dev/null

echo "[deploy] Packaging application artifacts"
tar -czf "$ARTIFACT_PATH" \
  app/dist \
  api/dist \
  packages/contracts/dist \
  package.json \
  compose.yaml

cat > "$MANIFEST_PATH" <<JSON
{
  "env": "$ENV",
  "generatedAtUtc": "$TIMESTAMP",
  "git": {
    "branch": "$BRANCH_NAME",
    "commit": "$COMMIT_SHA"
  },
  "artifact": {
    "path": "$ARTIFACT_PATH",
    "name": "$ARTIFACT_NAME"
  }
}
JSON

echo "[deploy] Prepared deployment bundle"
echo "[deploy] Env:       $ENV"
echo "[deploy] Artifact:  $ARTIFACT_PATH"
echo "[deploy] Manifest:  $MANIFEST_PATH"
