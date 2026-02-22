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
require_command aws
require_command npx

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FILE="serverless.${SERVICE}.yml"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Unknown service '$SERVICE'. Expected config file $CONFIG_FILE" >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-ap-southeast-2}"
PROJECT_NAME="${PROJECT_NAME:-3fc}"

API_NAME="${PROJECT_NAME}-${ENV}-http-api"
LAMBDA_EXEC_ROLE_NAME="${PROJECT_NAME}-${ENV}-lambda-exec"

echo "[deploy] Building workspaces"
make build >/dev/null

HTTP_API_ID="${HTTP_API_ID:-}"
LAMBDA_EXECUTION_ROLE_ARN="${LAMBDA_EXECUTION_ROLE_ARN:-}"

if [[ -z "$HTTP_API_ID" ]]; then
  echo "[deploy] Resolving API ID for ${API_NAME}"
  HTTP_API_ID="$(aws apigatewayv2 get-apis \
    --region "$AWS_REGION" \
    --query "Items[?Name=='${API_NAME}'].ApiId | [0]" \
    --output text 2>/dev/null || true)"
fi

if [[ "$HTTP_API_ID" == "None" ]]; then
  HTTP_API_ID=""
fi

if [[ -z "$LAMBDA_EXECUTION_ROLE_ARN" ]]; then
  echo "[deploy] Resolving Lambda execution role ARN for ${LAMBDA_EXEC_ROLE_NAME}"
  LAMBDA_EXECUTION_ROLE_ARN="$(aws iam get-role \
    --role-name "$LAMBDA_EXEC_ROLE_NAME" \
    --query 'Role.Arn' \
    --output text 2>/dev/null || true)"
fi

if [[ "$LAMBDA_EXECUTION_ROLE_ARN" == "None" ]]; then
  LAMBDA_EXECUTION_ROLE_ARN=""
fi

if [[ -z "$HTTP_API_ID" || -z "$LAMBDA_EXECUTION_ROLE_ARN" ]]; then
  echo "Missing required deploy inputs." >&2
  echo "Expected HTTP_API_ID and LAMBDA_EXECUTION_ROLE_ARN (provided via env or discoverable in AWS)." >&2
  exit 1
fi

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
