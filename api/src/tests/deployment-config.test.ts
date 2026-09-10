import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const serverlessCoreConfig = readFileSync(resolve(process.cwd(), "../serverless.api-core.yml"), "utf8");
const applicationTerraformConfig = readFileSync(resolve(process.cwd(), "../infra/application/main.tf"), "utf8");
const productionTerraformConfig = readFileSync(resolve(process.cwd(), "../infra/prod/main.tf"), "utf8");
const siteDeployScript = readFileSync(resolve(process.cwd(), "../scripts/deploy/deploy-site.sh"), "utf8");
const apiDeployScript = readFileSync(resolve(process.cwd(), "../scripts/deploy/deploy-app.sh"), "utf8");
const qaWorkflow = readFileSync(resolve(process.cwd(), "../.github/workflows/deploy-qa.yml"), "utf8");

test("HTML alias upload preserves exact S3 keys and propagates failure", () => {
  const helper = siteDeployScript.slice(siteDeployScript.indexOf("upload_html_alias() {"),
    siteDeployScript.indexOf('\necho "[deploy] Uploading extensionless route aliases"'));
  for (const key of ["link-player", "link-player/"]) {
    // Stub the file predicate so this isolates argument semantics without files or AWS.
    const body = helper.replace('if [[ ! -f "$source_path" ]]; then', 'if false; then');
    const args = ["-c", `set -euo pipefail\n${body}\naws() { printf '%s\\0' "$@"; }\nSITE_BUCKET_NAME=test-bucket\nupload_html_alias '/tmp/profile shell/index.html' '${key}'`];
    const result = spawnSync("bash", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const argv = result.stdout.slice(result.stdout.indexOf("\n") + 1).split("\0").slice(0, -1);
    assert.deepEqual(argv, ["s3api", "put-object", "--bucket", "test-bucket", "--key", key,
      "--body", "/tmp/profile shell/index.html", "--cache-control", "no-cache, no-store, must-revalidate",
      "--content-type", "text/html; charset=utf-8"]);
    const failure = spawnSync("bash", ["-c", `set -euo pipefail\n${body}\naws() { return 27; }\nSITE_BUCKET_NAME=test-bucket\nupload_html_alias '/tmp/profile shell/index.html' '${key}'\necho should-not-run`], { encoding: "utf8" });
    assert.equal(failure.status, 27);
    assert.ok(!failure.stdout.includes("should-not-run"));
  }
});

test("QA and production harden the API before publishing the proof-aware site", () => {
  for (const environment of ["qa", "prod"]) {
    const workflow = readFileSync(resolve(process.cwd(), `../.github/workflows/deploy-${environment}.yml`), "utf8");
    const api = workflow.indexOf(`run: make deploy ENV=${environment} SERVICE=api-core`);
    const site = workflow.indexOf(`run: make deploy ENV=${environment} SERVICE=site`);
    const coreSmoke = workflow.indexOf(`run: bash scripts/deploy/smoke-player-proof.sh ${environment} api`);
    const siteSmoke = workflow.indexOf(`run: bash scripts/deploy/smoke-player-proof.sh ${environment} site`);
    assert.equal(workflow.split(`run: make deploy ENV=${environment} SERVICE=api-core`).length, 2);
    assert.equal(workflow.split(`run: make deploy ENV=${environment} SERVICE=site`).length, 2);
    assert.ok(api >= 0 && coreSmoke > api && site > coreSmoke && siteSmoke > site,
      `${environment}: API and proof smoke must succeed before site publication`);
    const deploySteps = workflow.slice(workflow.lastIndexOf("      - name:", api), site);
    assert.match(deploySteps, /PLAYER_CLAIM_MODE: \$\{\{ vars\.PLAYER_CLAIM_MODE \|\| 'proof' \}\}/);
    assert.doesNotMatch(deploySteps, /continue-on-error:|if:\s*always\(/);
  }
  const smoke = readFileSync(resolve(process.cwd(), "../scripts/deploy/smoke-player-proof.sh"), "utf8");
  for (const route of ["player-proofs/preview", "profile-invitation/revoke", "/link-player/", "/ui/player-proof.js"]) {
    assert.ok(smoke.includes(route));
  }
  assert.match(smoke, /test "\$CODE" = 401/);
});

function assertServerlessRoute(method: string, path: string): void {
  assert.match(
    serverlessCoreConfig,
    new RegExp(`method:\\s*${method}\\s+path:\\s*${path.replace(/[{}+]/g, "\\$&")}`),
  );
}

test("api core deployment config registers claim and access routes", () => {
  assertServerlessRoute("POST", "/v1/player-proofs/preview");
  assertServerlessRoute("OPTIONS", "/v1/player-proofs/preview");
  for (const method of ["GET", "POST", "OPTIONS"]) {
    assertServerlessRoute(method, "/v1/games/{gameId}/players/{playerId}/profile-invitation");
  }
  for (const method of ["POST", "OPTIONS"]) {
    assertServerlessRoute(method, "/v1/games/{gameId}/players/{playerId}/profile-invitation/revoke");
  }
  assert.match(serverlessCoreConfig, /PLAYER_CLAIM_MODE:.*env:PLAYER_CLAIM_MODE, 'proof'/);
  const localCompose = readFileSync(resolve(process.cwd(), "../compose.yaml"), "utf8");
  assert.match(localCompose, /PLAYER_CLAIM_MODE: "\$\{PLAYER_CLAIM_MODE:-proof\}"/);
  assertServerlessRoute("GET", "/v1/join/{joinCode}/player-context");
  assertServerlessRoute("OPTIONS", "/v1/join/{joinCode}/player-context");
  assert.doesNotMatch(serverlessCoreConfig, /\/v1\/join\/\{joinCode\}\/players\//);
  assertServerlessRoute("POST", "/v1/auth/logout");
  assertServerlessRoute("OPTIONS", "/v1/auth/logout");
  assertServerlessRoute("POST", "/v1/players/{playerId}/claim");
  assertServerlessRoute("OPTIONS", "/v1/players/{playerId}/claim");
  assertServerlessRoute("POST", "/v1/leagues/{leagueId}/access");
  assertServerlessRoute("OPTIONS", "/v1/leagues/{leagueId}/access");
  assertServerlessRoute("POST", "/v1/leagues/{leagueId}/organiser-invites");
  assertServerlessRoute("OPTIONS", "/v1/leagues/{leagueId}/organiser-invites");
  assertServerlessRoute("POST", "/v1/invites/{inviteCode}/accept");
  assertServerlessRoute("OPTIONS", "/v1/invites/{inviteCode}/accept");
  assertServerlessRoute("GET", "/v1/leagues/{leagueId}/seasons/{seasonId}");
  assertServerlessRoute("DELETE", "/v1/leagues/{leagueId}/seasons/{seasonId}");
  assertServerlessRoute("OPTIONS", "/v1/leagues/{leagueId}/seasons/{seasonId}");
  assertServerlessRoute("GET", "/v1/leagues/{leagueId}/seasons/{seasonId}/games");
  assertServerlessRoute("OPTIONS", "/v1/leagues/{leagueId}/seasons/{seasonId}/games");
  assertServerlessRoute("POST", "/v1/leagues/{leagueId}/seasons/{seasonId}/sessions");
  assertServerlessRoute("OPTIONS", "/v1/leagues/{leagueId}/seasons/{seasonId}/sessions");
  assertServerlessRoute("POST", "/v1/leagues/{leagueId}/seasons/{seasonId}/sessions/{sessionId}/games");
  assertServerlessRoute("OPTIONS", "/v1/leagues/{leagueId}/seasons/{seasonId}/sessions/{sessionId}/games");
});

test("QA deployment evidence records the full head and live API fingerprint without environment values", () => {
  assert.match(apiDeployScript, /COMMIT_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(apiDeployScript, /codeSha256:CodeSha256,revisionId:RevisionId,lastUpdateStatus:LastUpdateStatus/);
  assert.match(apiDeployScript, /readFileSync\("\.serverless\/core\.zip"\)/);
  assert.match(apiDeployScript, /createHash\("sha256"\)/);
  assert.match(apiDeployScript, /digest\("base64"\)/);
  assert.match(apiDeployScript, /\.codeSha256 == \$expected/);
  assert.match(apiDeployScript, /"packageCodeSha256": "\$PACKAGE_CODE_SHA256"/);
  assert.deepEqual(apiDeployScript.match(/Environment\.Variables[^}'\s,]*/g), ["Environment.Variables.PLAYER_CLAIM_MODE"]);
  assert.match(qaWorkflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(qaWorkflow, /name: qa-api-core-deployment/);
  assert.match(qaWorkflow, /path: out\/deploy\/qa\/api-core-deploy-manifest\.json/);
  assert.match(qaWorkflow, /if-no-files-found: error/);
});

test("core deploy validates, exports and verifies the configured claim containment mode", () => {
  const configure = apiDeployScript.slice(apiDeployScript.indexOf("configure_player_claim_mode() {"),
    apiDeployScript.indexOf('\nif [[ "$SERVICE" == "api-core" ]]; then\n  configure_player_claim_mode'));
  assert.ok(configure.includes("case"));
  for (const [input, expected] of [["", "proof"], ["proof", "proof"], ["disabled", "disabled"], ["invalid", null]]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${configure}\nconfigure_player_claim_mode\nbash -c 'printf %s "$PLAYER_CLAIM_MODE"'`],
      { encoding: "utf8", env: { ...process.env, PLAYER_CLAIM_MODE: input! } });
    assert.equal(result.status, expected === null ? 1 : 0, result.stderr);
    assert.equal(result.stdout, expected ?? "");
  }
  assert.ok(apiDeployScript.indexOf("  configure_player_claim_mode\n") < apiDeployScript.indexOf("make build"));
  const verify = apiDeployScript.slice(apiDeployScript.indexOf('  jq -e --arg expected "$PACKAGE_CODE_SHA256"'),
    apiDeployScript.indexOf('\nfi\nTIMESTAMP='));
  assert.ok(verify.includes(".playerClaimMode == $mode"));
  for (const deployed of ["proof", "disabled", null]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${verify}`], { encoding: "utf8", env: {
      ...process.env, PACKAGE_CODE_SHA256: "package", PLAYER_CLAIM_MODE: "disabled",
      FUNCTION_FINGERPRINT: JSON.stringify({ lastUpdateStatus: "Successful", codeSha256: "package", revisionId: "revision", playerClaimMode: deployed }),
    } });
    assert.equal(result.status, deployed === "disabled" ? 0 : 1, result.stderr);
  }
});

test("api core deployment config sets canonical public invite link origins", () => {
  assert.match(serverlessCoreConfig, /PUBLIC_APP_BASE_URL:/);
  assert.match(serverlessCoreConfig, /appBaseUrls:\s+qa: https:\/\/qa\.3fc\.football\s+prod: https:\/\/3fc\.football\s+default: https:\/\/3fc\.football/);
  assert.match(serverlessCoreConfig, /publicAppBaseUrls:\s+qa: https:\/\/qa\.3fc\.football\s+prod: https:\/\/3fc\.football\s+default: https:\/\/3fc\.football/);
  assert.match(serverlessCoreConfig, /prod: https:\/\/3fc\.football,https:\/\/app\.3fc\.football,https:\/\/qa\.3fc\.football/);
  assert.match(productionTerraformConfig, /site_domain\s+=\s+"3fc\.football"/);
  assert.match(siteDeployScript, /SITE_DOMAIN="\$\{SITE_DOMAIN:-3fc\.football\}"/);
});

test("api core deployment config keeps sign-in sessions active for eight days", () => {
  assert.match(serverlessCoreConfig, /MAGIC_LINK_SESSION_TTL_SECONDS:\s*691200/);
  assert.doesNotMatch(serverlessCoreConfig, /MAGIC_LINK_SESSION_TTL_SECONDS:\s*86400/);
  assert.match(applicationTerraformConfig, /ttl\s*\{\s*attribute_name\s*=\s*"ttlEpoch"\s*enabled\s*=\s*true\s*\}/);
});

test("static CloudFront distribution applies app security headers", () => {
  assert.match(applicationTerraformConfig, /resource "aws_cloudfront_response_headers_policy" "site_security"/);
  assert.match(applicationTerraformConfig, /content_security_policy\s*=\s*local\.site_content_security_policy/);
  assert.match(applicationTerraformConfig, /default\s*=\s*"strict-origin-when-cross-origin"/);
  assert.match(applicationTerraformConfig, /auth_callback\s*=\s*"no-referrer"/);
  assert.match(applicationTerraformConfig, /path_pattern\s*=\s*"\/auth\/callback\*"/);
  assert.match(applicationTerraformConfig, /response_headers_policy_id\s*=\s*aws_cloudfront_response_headers_policy\.site_security\["default"\]\.id/);
  assert.match(applicationTerraformConfig, /response_headers_policy_id\s*=\s*aws_cloudfront_response_headers_policy\.site_security\["auth_callback"\]\.id/);
  assert.match(applicationTerraformConfig, /Cross-Origin-Opener-Policy/);
  assert.match(applicationTerraformConfig, /Cross-Origin-Resource-Policy/);
  assert.match(applicationTerraformConfig, /Permissions-Policy/);
});
