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

DEPLOY="${DEPLOY:-0}"
AWS_REGION="${AWS_REGION:-ap-southeast-2}"
LAMBDA_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-3fc-${ENV}-api-health}"
LAMBDA_ARTIFACT_BUCKET="${LAMBDA_ARTIFACT_BUCKET:-3fc-${ENV}-site}"
LAMBDA_ARTIFACT_KEY="${LAMBDA_ARTIFACT_KEY:-lambda/api-health.zip}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH" >&2
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

echo "[deploy] Packaging Lambda artifact"
(
  cd api/dist
  zip -qr "$ROOT_DIR/$LAMBDA_ZIP_PATH" .
)

DEPLOYED=false

if [[ "$DEPLOY" == "1" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "aws CLI is required for DEPLOY=1 but was not found in PATH" >&2
    exit 1
  fi

  echo "[deploy] Uploading Lambda artifact to s3://${LAMBDA_ARTIFACT_BUCKET}/${LAMBDA_ARTIFACT_KEY}"
  aws s3 cp \
    "$LAMBDA_ZIP_PATH" \
    "s3://${LAMBDA_ARTIFACT_BUCKET}/${LAMBDA_ARTIFACT_KEY}" \
    --region "$AWS_REGION"

  echo "[deploy] Updating Lambda function code for ${LAMBDA_FUNCTION_NAME}"
  aws lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --s3-bucket "$LAMBDA_ARTIFACT_BUCKET" \
    --s3-key "$LAMBDA_ARTIFACT_KEY" \
    --region "$AWS_REGION" \
    >/dev/null

  aws lambda wait function-updated \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --region "$AWS_REGION"

  DEPLOYED=true
fi

cat > "$MANIFEST_PATH" <<JSON
{
  "env": "$ENV",
  "generatedAtUtc": "$TIMESTAMP",
  "deployRequested": $([[ "$DEPLOY" == "1" ]] && echo "true" || echo "false"),
  "deployed": $DEPLOYED,
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
    "name": "$LAMBDA_ZIP_NAME",
    "functionName": "$LAMBDA_FUNCTION_NAME",
    "s3Bucket": "$LAMBDA_ARTIFACT_BUCKET",
    "s3Key": "$LAMBDA_ARTIFACT_KEY",
    "region": "$AWS_REGION"
  }
}
JSON

echo "[deploy] Prepared deployment bundle"
echo "[deploy] Env:       $ENV"
echo "[deploy] Artifact:  $ARTIFACT_PATH"
echo "[deploy] Lambda:    $LAMBDA_ZIP_PATH"
echo "[deploy] Manifest:  $MANIFEST_PATH"

if [[ "$DEPLOYED" == "true" ]]; then
  echo "[deploy] Lambda code deployed to ${LAMBDA_FUNCTION_NAME}"
else
  echo "[deploy] Lambda code not deployed (set DEPLOY=1 to push to AWS)"
fi
