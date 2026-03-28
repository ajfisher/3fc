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
require_command make
require_command npm

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PROJECT_NAME="${PROJECT_NAME:-3fc}"

case "$ENV" in
  qa)
    SITE_DOMAIN="${SITE_DOMAIN:-qa.3fc.football}"
    API_BASE_URL="${API_BASE_URL:-https://qa-api.3fc.football}"
    ;;
  prod)
    SITE_DOMAIN="${SITE_DOMAIN:-app.3fc.football}"
    API_BASE_URL="${API_BASE_URL:-https://api.3fc.football}"
    ;;
esac

SITE_BUCKET_NAME="${SITE_BUCKET_NAME:-${PROJECT_NAME}-${ENV}-site}"
STATIC_SITE_OUTPUT_DIR="${STATIC_SITE_OUTPUT_DIR:-out/site/${ENV}}"
ARTIFACT_DIR="out/deploy/${ENV}"
DEPLOY_MANIFEST_PATH="${ARTIFACT_DIR}/site-deploy-manifest.json"

if [[ "$STATIC_SITE_OUTPUT_DIR" != /* ]]; then
  STATIC_SITE_OUTPUT_DIR="${ROOT_DIR}/${STATIC_SITE_OUTPUT_DIR}"
fi

echo "[deploy] Building workspaces"
make build >/dev/null

echo "[deploy] Exporting static site for ${ENV}"
API_BASE_URL="$API_BASE_URL" STATIC_SITE_OUTPUT_DIR="$STATIC_SITE_OUTPUT_DIR" npm run export:static -w @3fc/app >/dev/null

if [[ ! -f "${STATIC_SITE_OUTPUT_DIR}/index.html" ]]; then
  echo "Static site export did not produce ${STATIC_SITE_OUTPUT_DIR}/index.html" >&2
  exit 1
fi

echo "[deploy] Resolving CloudFront distribution for ${SITE_DOMAIN}"
SITE_DISTRIBUTION_ID="$(
  aws cloudfront list-distributions \
    --query "DistributionList.Items[?Aliases.Quantity > \`0\` && contains(Aliases.Items, '${SITE_DOMAIN}')].Id | [0]" \
    --output text
)"

if [[ -z "$SITE_DISTRIBUTION_ID" || "$SITE_DISTRIBUTION_ID" == "None" ]]; then
  echo "Could not resolve a CloudFront distribution for ${SITE_DOMAIN}" >&2
  exit 1
fi

echo "[deploy] Uploading static assets to s3://${SITE_BUCKET_NAME}"
aws s3 sync "${STATIC_SITE_OUTPUT_DIR}/" "s3://${SITE_BUCKET_NAME}/" --delete

echo "[deploy] Re-uploading HTML with no-cache headers"
aws s3 cp "${STATIC_SITE_OUTPUT_DIR}/" "s3://${SITE_BUCKET_NAME}/" \
  --recursive \
  --exclude "*" \
  --include "*.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8"

echo "[deploy] Creating CloudFront invalidation for ${SITE_DISTRIBUTION_ID}"
INVALIDATION_ID="$(
  aws cloudfront create-invalidation \
    --distribution-id "$SITE_DISTRIBUTION_ID" \
    --paths "/*" \
    --query 'Invalidation.Id' \
    --output text
)"

if [[ -z "$INVALIDATION_ID" || "$INVALIDATION_ID" == "None" ]]; then
  echo "CloudFront invalidation did not return an ID." >&2
  exit 1
fi

echo "[deploy] Waiting for CloudFront invalidation ${INVALIDATION_ID}"
aws cloudfront wait invalidation-completed \
  --distribution-id "$SITE_DISTRIBUTION_ID" \
  --id "$INVALIDATION_ID"

COMMIT_SHA="$(git rev-parse --short HEAD)"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
SITE_URL="https://${SITE_DOMAIN}"

mkdir -p "$ARTIFACT_DIR"

cat > "$DEPLOY_MANIFEST_PATH" <<JSON
{
  "env": "$ENV",
  "service": "site",
  "deployedAtUtc": "$TIMESTAMP",
  "gitCommit": "$COMMIT_SHA",
  "siteBucketName": "$SITE_BUCKET_NAME",
  "siteDomain": "$SITE_DOMAIN",
  "siteUrl": "$SITE_URL",
  "cloudFrontDistributionId": "$SITE_DISTRIBUTION_ID",
  "cloudFrontInvalidationId": "$INVALIDATION_ID",
  "staticSiteOutputDir": "$STATIC_SITE_OUTPUT_DIR"
}
JSON

echo "[deploy] Deployment complete"
echo "[deploy] Env:          $ENV"
echo "[deploy] Site bucket:  $SITE_BUCKET_NAME"
echo "[deploy] Site domain:  $SITE_DOMAIN"
echo "[deploy] Distribution: $SITE_DISTRIBUTION_ID"
echo "[deploy] Invalidation: $INVALIDATION_ID"
echo "[deploy] Manifest:     $DEPLOY_MANIFEST_PATH"
