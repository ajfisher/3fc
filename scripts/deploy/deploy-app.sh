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
require_command jq
require_command node

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

configure_player_claim_mode() {
  PLAYER_CLAIM_MODE="${PLAYER_CLAIM_MODE:-proof}"
  case "$PLAYER_CLAIM_MODE" in
    proof|disabled) export PLAYER_CLAIM_MODE ;;
    *) echo "PLAYER_CLAIM_MODE must be proof or disabled" >&2; return 1 ;;
  esac
  PLAYER_CONSOLIDATION_ENABLED="${PLAYER_CONSOLIDATION_ENABLED:-false}"
  case "$PLAYER_CONSOLIDATION_ENABLED" in
    true|false) export PLAYER_CONSOLIDATION_ENABLED ;;
    *) echo "PLAYER_CONSOLIDATION_ENABLED must be true or false" >&2; return 1 ;;
  esac
  PLAYER_RETURNING_JOIN_ENABLED="${PLAYER_RETURNING_JOIN_ENABLED:-false}"
  case "$PLAYER_RETURNING_JOIN_ENABLED" in
    true|false) export PLAYER_RETURNING_JOIN_ENABLED ;;
    *) echo "PLAYER_RETURNING_JOIN_ENABLED must be true or false" >&2; return 1 ;;
  esac
  PLAYER_PROFILES_ENABLED="${PLAYER_PROFILES_ENABLED:-false}"
  case "$PLAYER_PROFILES_ENABLED" in
    true|false) export PLAYER_PROFILES_ENABLED ;;
    *) echo "PLAYER_PROFILES_ENABLED must be true or false" >&2; return 1 ;;
  esac
  PLAYER_ACHIEVEMENTS_ENABLED="${PLAYER_ACHIEVEMENTS_ENABLED:-false}"
  case "$PLAYER_ACHIEVEMENTS_ENABLED" in
    true|false) export PLAYER_ACHIEVEMENTS_ENABLED ;;
    *) echo "PLAYER_ACHIEVEMENTS_ENABLED must be true or false" >&2; return 1 ;;
  esac
  PLAYER_OWNER_EDITING_ENABLED="${PLAYER_OWNER_EDITING_ENABLED:-false}"
  case "$PLAYER_OWNER_EDITING_ENABLED" in
    true|false) export PLAYER_OWNER_EDITING_ENABLED ;;
    *) echo "PLAYER_OWNER_EDITING_ENABLED must be true or false" >&2; return 1 ;;
  esac
  HISTORY_PROCESSING_ENABLED="${HISTORY_PROCESSING_ENABLED:-false}"
  case "$HISTORY_PROCESSING_ENABLED" in
    true|false) export HISTORY_PROCESSING_ENABLED ;;
    *) echo "HISTORY_PROCESSING_ENABLED must be true or false" >&2; return 1 ;;
  esac
}
if [[ "$SERVICE" == "api-core" ]]; then
  configure_player_claim_mode
fi

echo "[deploy] Building workspaces"
make build >/dev/null

# Background history transport has dedicated roles and no HTTP API dependency.
if [[ "$SERVICE" == "player-history" ]]; then
  HISTORY_PROCESSING_ENABLED="${HISTORY_PROCESSING_ENABLED:-false}"
  case "$HISTORY_PROCESSING_ENABLED" in true|false) ;; *) echo "HISTORY_PROCESSING_ENABLED must be true or false" >&2; exit 1 ;; esac
  DYNAMODB_TABLE="${DYNAMODB_TABLE:-3fc-${ENV}-app}"
  if [[ "$DYNAMODB_TABLE" != "3fc-${ENV}-app" ]]; then
    echo "Player history must target the selected environment's application table." >&2
    exit 1
  fi
  HISTORY_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  if [[ "$HISTORY_ACCOUNT_ID" != "${EXPECTED_AWS_ACCOUNT_ID:-301691475109}" ]]; then
    echo "Player history deployment account differs from the reviewed account." >&2
    exit 1
  fi
  HISTORY_STREAM_ARN="$(aws dynamodb describe-table --table-name "$DYNAMODB_TABLE" --region "$AWS_REGION" \
    --query 'Table.LatestStreamArn' --output text)"
  HISTORY_QUEUE_URL="$(aws sqs get-queue-url --queue-name "3fc-${ENV}-player-history" --region "$AWS_REGION" --query QueueUrl --output text)"
  HISTORY_QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "$HISTORY_QUEUE_URL" --attribute-names QueueArn --region "$AWS_REGION" --query Attributes.QueueArn --output text)"
  HISTORY_DEAD_QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "${HISTORY_QUEUE_URL}-dead" --attribute-names QueueArn --region "$AWS_REGION" --query Attributes.QueueArn --output text)"
  HISTORY_DISPATCH_DEAD_QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "${HISTORY_QUEUE_URL}-dispatch-dead" --attribute-names QueueArn --region "$AWS_REGION" --query Attributes.QueueArn --output text)"
  HISTORY_DISPATCH_ROLE_ARN="$(aws iam get-role --role-name "3fc-${ENV}-player-history-dispatch" --query Role.Arn --output text)"
  HISTORY_WORKER_ROLE_ARN="$(aws iam get-role --role-name "3fc-${ENV}-player-history-worker" --query Role.Arn --output text)"
  for history_input in HISTORY_STREAM_ARN HISTORY_QUEUE_URL HISTORY_QUEUE_ARN HISTORY_DEAD_QUEUE_ARN HISTORY_DISPATCH_DEAD_QUEUE_ARN HISTORY_DISPATCH_ROLE_ARN HISTORY_WORKER_ROLE_ARN; do
    if [[ -z "${!history_input}" || "${!history_input}" == "None" ]]; then
      echo "Missing $history_input. Apply the reviewed environment Terraform before deploying history." >&2
      exit 1
    fi
  done
  export AWS_REGION DYNAMODB_TABLE HISTORY_ACCOUNT_ID HISTORY_PROCESSING_ENABLED HISTORY_STREAM_ARN HISTORY_QUEUE_URL HISTORY_QUEUE_ARN
  export HISTORY_DEAD_QUEUE_ARN HISTORY_DISPATCH_DEAD_QUEUE_ARN HISTORY_DISPATCH_ROLE_ARN HISTORY_WORKER_ROLE_ARN
  echo "[deploy] Deploying player history; processing=${HISTORY_PROCESSING_ENABLED}"
  npx serverless deploy --config "$CONFIG_FILE" --stage "$ENV" --region "$AWS_REGION"
  node scripts/deploy/verify-player-history.mjs "$ENV" "$(git rev-parse HEAD)" --capture
  exit 0
fi

HTTP_API_ID="${HTTP_API_ID:-}"
LAMBDA_EXECUTION_ROLE_ARN="${LAMBDA_EXECUTION_ROLE_ARN:-}"

if [[ -z "$HTTP_API_ID" ]]; then
  echo "[deploy] Resolving API ID for ${API_NAME}"
  HTTP_API_ID="$(aws apigatewayv2 get-apis \
    --region "$AWS_REGION" \
    --query "Items[?Name=='${API_NAME}'].ApiId | [0]" \
    --output text || true)"
fi

if [[ "$HTTP_API_ID" == "None" ]]; then
  HTTP_API_ID=""
fi

if [[ -z "$LAMBDA_EXECUTION_ROLE_ARN" ]]; then
  echo "[deploy] Resolving Lambda execution role ARN for ${LAMBDA_EXEC_ROLE_NAME}"
  LAMBDA_EXECUTION_ROLE_ARN="$(aws iam get-role \
    --role-name "$LAMBDA_EXEC_ROLE_NAME" \
    --query 'Role.Arn' \
    --output text || true)"
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

COMMIT_SHA="$(git rev-parse HEAD)"
FUNCTION_FINGERPRINT="null"
PACKAGE_CODE_SHA256=""
if [[ "$SERVICE" == "api-core" ]]; then
  # Bind the live revision to this invocation's individually packaged core ZIP.
  # Another PR can deploy to shared QA between Serverless returning and this read.
  PACKAGE_CODE_SHA256="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(".serverless/core.zip")).digest("base64"))')"
  # Record code provenance and these nonsecret switches only, never the full environment.
  FUNCTION_FINGERPRINT="$(aws lambda get-function-configuration \
    --function-name "3fc-${ENV}-api-core" --region "$AWS_REGION" \
    --query '{functionName:FunctionName,codeSha256:CodeSha256,revisionId:RevisionId,lastUpdateStatus:LastUpdateStatus,playerClaimMode:Environment.Variables.PLAYER_CLAIM_MODE,consolidationEnabled:Environment.Variables.PLAYER_CONSOLIDATION_ENABLED,returningJoinEnabled:Environment.Variables.PLAYER_RETURNING_JOIN_ENABLED,profilesEnabled:Environment.Variables.PLAYER_PROFILES_ENABLED,achievementsEnabled:Environment.Variables.PLAYER_ACHIEVEMENTS_ENABLED,ownerEditingEnabled:Environment.Variables.PLAYER_OWNER_EDITING_ENABLED,historyProcessingEnabled:Environment.Variables.HISTORY_PROCESSING_ENABLED}' \
    --output json)"
  jq -e --arg expected "$PACKAGE_CODE_SHA256" --arg mode "$PLAYER_CLAIM_MODE" --arg consolidation "$PLAYER_CONSOLIDATION_ENABLED" --arg returning "$PLAYER_RETURNING_JOIN_ENABLED" --arg profiles "$PLAYER_PROFILES_ENABLED" --arg achievements "$PLAYER_ACHIEVEMENTS_ENABLED" --arg ownerEditing "$PLAYER_OWNER_EDITING_ENABLED" --arg historyProcessing "$HISTORY_PROCESSING_ENABLED" '.lastUpdateStatus == "Successful" and .codeSha256 == $expected and (.revisionId | length > 0) and .playerClaimMode == $mode and .consolidationEnabled == $consolidation and .returningJoinEnabled == $returning and .profilesEnabled == $profiles and .achievementsEnabled == $achievements and .ownerEditingEnabled == $ownerEditing and .historyProcessingEnabled == $historyProcessing' \
    <<< "$FUNCTION_FINGERPRINT" >/dev/null
fi
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
  "packageCodeSha256": "$PACKAGE_CODE_SHA256",
  "functionFingerprint": $FUNCTION_FINGERPRINT,
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
