import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const serverlessCoreConfig = readFileSync(resolve(process.cwd(), "../serverless.api-core.yml"), "utf8");
const applicationTerraformConfig = readFileSync(resolve(process.cwd(), "../infra/application/main.tf"), "utf8");
const productionTerraformConfig = readFileSync(resolve(process.cwd(), "../infra/prod/main.tf"), "utf8");
const siteDeployScript = readFileSync(resolve(process.cwd(), "../scripts/deploy/deploy-site.sh"), "utf8");
const apiDeployScript = readFileSync(resolve(process.cwd(), "../scripts/deploy/deploy-app.sh"), "utf8");
const qaWorkflow = readFileSync(resolve(process.cwd(), "../.github/workflows/deploy-qa.yml"), "utf8");

function assertServerlessRoute(method: string, path: string): void {
  assert.match(
    serverlessCoreConfig,
    new RegExp(`method:\\s*${method}\\s+path:\\s*${path.replace(/[{}]/g, "\\$&")}`),
  );
}

test("api core deployment config registers claim and access routes", () => {
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
  assert.doesNotMatch(apiDeployScript, /Environment\.Variables/);
  assert.match(qaWorkflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(qaWorkflow, /name: qa-api-core-deployment/);
  assert.match(qaWorkflow, /path: out\/deploy\/qa\/api-core-deploy-manifest\.json/);
  assert.match(qaWorkflow, /if-no-files-found: error/);
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
