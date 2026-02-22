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

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required but was not found in PATH" >&2
    exit 1
  fi
}

require_command aws
require_command terraform

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

AWS_REGION="${AWS_REGION:-ap-southeast-2}"
LAMBDA_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-3fc-${ENV}-api-health}"
LAMBDA_ARTIFACT_BUCKET="${LAMBDA_ARTIFACT_BUCKET:-3fc-${ENV}-site}"
LAMBDA_ARTIFACT_KEY="${LAMBDA_ARTIFACT_KEY:-lambda/api-health.zip}"
LAMBDA_HANDLER="${LAMBDA_HANDLER:-lambda.handler}"
LAMBDA_RUNTIME="${LAMBDA_RUNTIME:-nodejs22.x}"
LAMBDA_MEMORY_SIZE="${LAMBDA_MEMORY_SIZE:-128}"
LAMBDA_TIMEOUT_SECONDS="${LAMBDA_TIMEOUT_SECONDS:-3}"
ROUTE_KEY="${ROUTE_KEY:-GET /v1/health}"

COMMIT_SHA="$(git rev-parse --short HEAD)"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
ARTIFACT_DIR="out/deploy/$ENV"
LAMBDA_ZIP_NAME="3fc-api-${ENV}-${COMMIT_SHA}.zip"
LAMBDA_ZIP_PATH="$ARTIFACT_DIR/$LAMBDA_ZIP_NAME"
DEPLOY_MANIFEST_PATH="$ARTIFACT_DIR/deploy-manifest.json"

"$ROOT_DIR/scripts/deploy/build-artifacts.sh" "$ENV"

TF_DIR="infra/$ENV"
API_ID="$(terraform -chdir="$TF_DIR" output -raw api_id)"
API_EXECUTION_ARN="$(terraform -chdir="$TF_DIR" output -raw api_execution_arn)"
API_INVOKE_URL="$(terraform -chdir="$TF_DIR" output -raw api_invoke_url)"
LAMBDA_ROLE_ARN="$(terraform -chdir="$TF_DIR" output -raw lambda_execution_role_arn)"

echo "[deploy] Uploading Lambda artifact to s3://${LAMBDA_ARTIFACT_BUCKET}/${LAMBDA_ARTIFACT_KEY}"
aws s3 cp \
  "$LAMBDA_ZIP_PATH" \
  "s3://${LAMBDA_ARTIFACT_BUCKET}/${LAMBDA_ARTIFACT_KEY}" \
  --region "$AWS_REGION"

if aws lambda get-function \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --region "$AWS_REGION" \
  >/dev/null 2>&1; then
  echo "[deploy] Updating Lambda function code for ${LAMBDA_FUNCTION_NAME}"
  aws lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --s3-bucket "$LAMBDA_ARTIFACT_BUCKET" \
    --s3-key "$LAMBDA_ARTIFACT_KEY" \
    --region "$AWS_REGION" \
    >/dev/null

  aws lambda update-function-configuration \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --handler "$LAMBDA_HANDLER" \
    --runtime "$LAMBDA_RUNTIME" \
    --role "$LAMBDA_ROLE_ARN" \
    --memory-size "$LAMBDA_MEMORY_SIZE" \
    --timeout "$LAMBDA_TIMEOUT_SECONDS" \
    --region "$AWS_REGION" \
    >/dev/null
else
  echo "[deploy] Creating Lambda function ${LAMBDA_FUNCTION_NAME}"
  aws lambda create-function \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --runtime "$LAMBDA_RUNTIME" \
    --role "$LAMBDA_ROLE_ARN" \
    --handler "$LAMBDA_HANDLER" \
    --code "S3Bucket=${LAMBDA_ARTIFACT_BUCKET},S3Key=${LAMBDA_ARTIFACT_KEY}" \
    --memory-size "$LAMBDA_MEMORY_SIZE" \
    --timeout "$LAMBDA_TIMEOUT_SECONDS" \
    --region "$AWS_REGION" \
    >/dev/null
fi

LAMBDA_ARN="$(aws lambda get-function \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --query 'Configuration.FunctionArn' \
  --output text)"

INTEGRATION_ID="$(aws apigatewayv2 get-integrations \
  --api-id "$API_ID" \
  --region "$AWS_REGION" \
  --query "Items[?IntegrationUri=='${LAMBDA_ARN}'].IntegrationId | [0]" \
  --output text)"

if [[ "$INTEGRATION_ID" == "None" || -z "$INTEGRATION_ID" ]]; then
  echo "[deploy] Creating API integration for ${LAMBDA_FUNCTION_NAME}"
  INTEGRATION_ID="$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --region "$AWS_REGION" \
    --integration-type AWS_PROXY \
    --integration-method POST \
    --integration-uri "$LAMBDA_ARN" \
    --payload-format-version 2.0 \
    --timeout-in-millis 30000 \
    --query 'IntegrationId' \
    --output text)"
else
  echo "[deploy] Updating API integration ${INTEGRATION_ID}"
  aws apigatewayv2 update-integration \
    --api-id "$API_ID" \
    --integration-id "$INTEGRATION_ID" \
    --region "$AWS_REGION" \
    --integration-type AWS_PROXY \
    --integration-method POST \
    --integration-uri "$LAMBDA_ARN" \
    --payload-format-version 2.0 \
    --timeout-in-millis 30000 \
    >/dev/null
fi

ROUTE_ID="$(aws apigatewayv2 get-routes \
  --api-id "$API_ID" \
  --region "$AWS_REGION" \
  --query "Items[?RouteKey=='${ROUTE_KEY}'].RouteId | [0]" \
  --output text)"

ROUTE_TARGET="integrations/${INTEGRATION_ID}"
if [[ "$ROUTE_ID" == "None" || -z "$ROUTE_ID" ]]; then
  echo "[deploy] Creating route ${ROUTE_KEY}"
  ROUTE_ID="$(aws apigatewayv2 create-route \
    --api-id "$API_ID" \
    --region "$AWS_REGION" \
    --route-key "$ROUTE_KEY" \
    --target "$ROUTE_TARGET" \
    --query 'RouteId' \
    --output text)"
else
  echo "[deploy] Updating route ${ROUTE_KEY}"
  aws apigatewayv2 update-route \
    --api-id "$API_ID" \
    --route-id "$ROUTE_ID" \
    --region "$AWS_REGION" \
    --route-key "$ROUTE_KEY" \
    --target "$ROUTE_TARGET" \
    >/dev/null
fi

ROUTE_PATH="${ROUTE_KEY#* }"
SOURCE_ARN="${API_EXECUTION_ARN}/*/*${ROUTE_PATH}"
STATEMENT_ID="AllowApiGatewayInvokeHealth"

aws lambda remove-permission \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --statement-id "$STATEMENT_ID" \
  --region "$AWS_REGION" \
  >/dev/null 2>&1 || true

aws lambda add-permission \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --statement-id "$STATEMENT_ID" \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "$SOURCE_ARN" \
  --region "$AWS_REGION" \
  >/dev/null

HEALTH_ENDPOINT_URL="${API_INVOKE_URL}/v1/health"

cat > "$DEPLOY_MANIFEST_PATH" <<JSON
{
  "env": "$ENV",
  "deployedAtUtc": "$TIMESTAMP",
  "gitCommit": "$COMMIT_SHA",
  "apiId": "$API_ID",
  "apiInvokeUrl": "$API_INVOKE_URL",
  "healthEndpointUrl": "$HEALTH_ENDPOINT_URL",
  "lambda": {
    "functionName": "$LAMBDA_FUNCTION_NAME",
    "functionArn": "$LAMBDA_ARN",
    "roleArn": "$LAMBDA_ROLE_ARN",
    "s3Bucket": "$LAMBDA_ARTIFACT_BUCKET",
    "s3Key": "$LAMBDA_ARTIFACT_KEY"
  },
  "route": {
    "routeKey": "$ROUTE_KEY",
    "routeId": "$ROUTE_ID",
    "integrationId": "$INTEGRATION_ID"
  }
}
JSON

echo "[deploy] Deployment complete"
echo "[deploy] Env:        $ENV"
echo "[deploy] API ID:     $API_ID"
echo "[deploy] Lambda:     $LAMBDA_FUNCTION_NAME"
echo "[deploy] Route:      $ROUTE_KEY"
echo "[deploy] Health URL: $HEALTH_ENDPOINT_URL"
echo "[deploy] Manifest:   $DEPLOY_MANIFEST_PATH"
