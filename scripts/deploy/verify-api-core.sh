#!/usr/bin/env bash
# Read-only final guard: never repair or overwrite an unexpected deployment.
set -euo pipefail

DEPLOY_ENV="${1:-}"
EXPECTED_HEAD="${2:-}"
case "$DEPLOY_ENV" in qa|prod) ;; *) exit 1 ;; esac
[[ "$EXPECTED_HEAD" =~ ^[0-9a-f]{40}$ ]] || exit 1
MANIFEST_PATH="out/deploy/$DEPLOY_ENV/api-core-deploy-manifest.json"

# Validate provenance before querying AWS. Missing fields must not compare equal.
jq -e --arg head "$EXPECTED_HEAD" --arg environment "$DEPLOY_ENV" '
  def nonempty: type == "string" and length > 0;
  .gitCommit == $head and .env == $environment and .service == "api-core" and
  (.region | nonempty) and (.packageCodeSha256 | nonempty) and
  .functionFingerprint.functionName == ("3fc-" + $environment + "-api-core") and
  .functionFingerprint.lastUpdateStatus == "Successful" and
  .functionFingerprint.apiWriterSha == $head and
  .functionFingerprint.codeSha256 == .packageCodeSha256 and
  (.functionFingerprint.revisionId | nonempty) and
  (.functionFingerprint.playerClaimMode == "proof" or .functionFingerprint.playerClaimMode == "disabled") and
  (.functionFingerprint.consolidationEnabled == "true" or .functionFingerprint.consolidationEnabled == "false") and
  (.functionFingerprint.returningJoinEnabled == "true" or .functionFingerprint.returningJoinEnabled == "false") and
  (.functionFingerprint.profilesEnabled == "true" or .functionFingerprint.profilesEnabled == "false") and
  (.functionFingerprint.achievementsEnabled == "true" or .functionFingerprint.achievementsEnabled == "false") and
  (.functionFingerprint.ownerEditingEnabled == "true" or .functionFingerprint.ownerEditingEnabled == "false") and
  .functionFingerprint.runtime == "nodejs22.x" and .functionFingerprint.architectures == ["arm64"] and .functionFingerprint.timeout == 28 and
  (.functionFingerprint.portraitBucket | test("^3fc-" + $environment + "-portraits-[0-9]{12}$")) and
  (.functionFingerprint.historyProcessingEnabled == "true" or .functionFingerprint.historyProcessingEnabled == "false")
' "$MANIFEST_PATH" >/dev/null

DEPLOY_REGION="$(jq -r '.region' "$MANIFEST_PATH")"
# Select only provenance and nonsecret switches, never the full Lambda environment.
LIVE_FINGERPRINT="$(aws lambda get-function-configuration \
  --function-name "3fc-${DEPLOY_ENV}-api-core" --region "$DEPLOY_REGION" \
  --query '{functionName:FunctionName,codeSha256:CodeSha256,revisionId:RevisionId,lastUpdateStatus:LastUpdateStatus,playerClaimMode:Environment.Variables.PLAYER_CLAIM_MODE,consolidationEnabled:Environment.Variables.PLAYER_CONSOLIDATION_ENABLED,returningJoinEnabled:Environment.Variables.PLAYER_RETURNING_JOIN_ENABLED,profilesEnabled:Environment.Variables.PLAYER_PROFILES_ENABLED,achievementsEnabled:Environment.Variables.PLAYER_ACHIEVEMENTS_ENABLED,ownerEditingEnabled:Environment.Variables.PLAYER_OWNER_EDITING_ENABLED,historyProcessingEnabled:Environment.Variables.HISTORY_PROCESSING_ENABLED,portraitBucket:Environment.Variables.PORTRAIT_BUCKET,apiWriterSha:Environment.Variables.API_WRITER_SHA,runtime:Runtime,architectures:Architectures,timeout:Timeout}' \
  --output json)"
jq -e --argjson live "$LIVE_FINGERPRINT" '
  .functionFingerprint as $expected |
  $live.lastUpdateStatus == "Successful" and
  $live.functionName == $expected.functionName and
  $live.codeSha256 == $expected.codeSha256 and
  $live.revisionId == $expected.revisionId and
  $live.playerClaimMode == $expected.playerClaimMode and
  $live.consolidationEnabled == $expected.consolidationEnabled and
  $live.returningJoinEnabled == $expected.returningJoinEnabled and
  $live.profilesEnabled == $expected.profilesEnabled and
  $live.achievementsEnabled == $expected.achievementsEnabled and
  $live.ownerEditingEnabled == $expected.ownerEditingEnabled and
  $live.historyProcessingEnabled == $expected.historyProcessingEnabled and
  $live.portraitBucket == $expected.portraitBucket and
  $live.apiWriterSha == $expected.apiWriterSha and
  $live.runtime == $expected.runtime and
  $live.architectures == $expected.architectures and
  $live.timeout == $expected.timeout
' "$MANIFEST_PATH" >/dev/null
echo "[deploy] Final API fingerprint matches the accepted deployment."
