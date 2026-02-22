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

if ! command -v make >/dev/null 2>&1; then
  echo "make is required but was not found in PATH" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required but was not found in PATH" >&2
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
LAMBDA_ZIP_NAME="3fc-api-${ENV}-${COMMIT_SHA}.zip"
LAMBDA_ZIP_PATH="$ARTIFACT_DIR/$LAMBDA_ZIP_NAME"
BUILD_MANIFEST_PATH="$ARTIFACT_DIR/build-manifest.json"

mkdir -p "$ARTIFACT_DIR"

echo "[build] Building workspaces"
make build >/dev/null

echo "[build] Packaging application artifact"
tar -czf "$ARTIFACT_PATH" \
  app/dist \
  api/dist \
  packages/contracts/dist \
  package.json \
  compose.yaml

echo "[build] Packaging Lambda artifact"
(
  cd api/dist
  zip -qr "$ROOT_DIR/$LAMBDA_ZIP_PATH" .
)

cat > "$BUILD_MANIFEST_PATH" <<JSON
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
  },
  "lambdaArtifact": {
    "path": "$LAMBDA_ZIP_PATH",
    "name": "$LAMBDA_ZIP_NAME"
  }
}
JSON

echo "[build] Build artifacts ready"
echo "[build] Env:       $ENV"
echo "[build] Artifact:  $ARTIFACT_PATH"
echo "[build] Lambda:    $LAMBDA_ZIP_PATH"
echo "[build] Manifest:  $BUILD_MANIFEST_PATH"
