#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <qa|prod> [service]" >&2
  exit 1
fi

ENV="$1"
SERVICE="${2:-api-health}"

if [[ "$ENV" != "qa" && "$ENV" != "prod" ]]; then
  echo "ENV must be one of: qa, prod" >&2
  exit 1
fi

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required but was not found in PATH" >&2
    exit 1
  fi
}

require_command make
require_command terraform
require_command npx

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FILE="serverless.${SERVICE}.yml"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Unknown service '$SERVICE'. Expected config file $CONFIG_FILE" >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-ap-southeast-2}"
TF_DIR="infra/$ENV"

echo "[deploy] Building workspaces"
make build >/dev/null

echo "[deploy] Reading Terraform infra outputs from ${TF_DIR}"
HTTP_API_ID="$(terraform -chdir="$TF_DIR" output -raw api_id)"
LAMBDA_EXECUTION_ROLE_ARN="$(terraform -chdir="$TF_DIR" output -raw lambda_execution_role_arn)"

export HTTP_API_ID
export LAMBDA_EXECUTION_ROLE_ARN

echo "[deploy] Deploying ${SERVICE} with Serverless Framework"
npx serverless deploy --config "$CONFIG_FILE" --stage "$ENV" --region "$AWS_REGION"

COMMIT_SHA="$(git rev-parse --short HEAD)"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
ARTIFACT_DIR="out/deploy/$ENV"
DEPLOY_MANIFEST_PATH="$ARTIFACT_DIR/${SERVICE}-deploy-manifest.json"

mkdir -p "$ARTIFACT_DIR"

cat > "$DEPLOY_MANIFEST_PATH" <<JSON
{
  "env": "$ENV",
  "service": "$SERVICE",
  "deployedAtUtc": "$TIMESTAMP",
  "gitCommit": "$COMMIT_SHA",
  "region": "$AWS_REGION",
  "serverlessConfig": "$CONFIG_FILE",
  "httpApiId": "$HTTP_API_ID",
  "lambdaExecutionRoleArn": "$LAMBDA_EXECUTION_ROLE_ARN"
}
JSON

echo "[deploy] Deployment complete"
echo "[deploy] Env:      $ENV"
echo "[deploy] Service:  $SERVICE"
echo "[deploy] API ID:   $HTTP_API_ID"
echo "[deploy] Manifest: $DEPLOY_MANIFEST_PATH"
