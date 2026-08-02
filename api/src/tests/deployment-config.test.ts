import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const serverlessCoreConfig = readFileSync(resolve(process.cwd(), "../serverless.api-core.yml"), "utf8");
const productionTerraformConfig = readFileSync(resolve(process.cwd(), "../infra/prod/main.tf"), "utf8");
const siteDeployScript = readFileSync(resolve(process.cwd(), "../scripts/deploy/deploy-site.sh"), "utf8");

function assertServerlessRoute(method: string, path: string): void {
  assert.match(
    serverlessCoreConfig,
    new RegExp(`method:\\s*${method}\\s+path:\\s*${path.replace(/[{}]/g, "\\$&")}`),
  );
}

test("api core deployment config registers claim and access routes", () => {
  assertServerlessRoute("POST", "/v1/players/{playerId}/claim");
  assertServerlessRoute("OPTIONS", "/v1/players/{playerId}/claim");
  assertServerlessRoute("POST", "/v1/leagues/{leagueId}/access");
  assertServerlessRoute("OPTIONS", "/v1/leagues/{leagueId}/access");
  assertServerlessRoute("POST", "/v1/leagues/{leagueId}/organiser-invites");
  assertServerlessRoute("OPTIONS", "/v1/leagues/{leagueId}/organiser-invites");
  assertServerlessRoute("POST", "/v1/invites/{inviteCode}/accept");
  assertServerlessRoute("OPTIONS", "/v1/invites/{inviteCode}/accept");
});

test("api core deployment config sets canonical public invite link origins", () => {
  assert.match(serverlessCoreConfig, /PUBLIC_APP_BASE_URL:/);
  assert.match(serverlessCoreConfig, /appBaseUrls:\s+qa: https:\/\/qa\.3fc\.football\s+prod: https:\/\/3fc\.football\s+default: https:\/\/3fc\.football/);
  assert.match(serverlessCoreConfig, /publicAppBaseUrls:\s+qa: https:\/\/qa\.3fc\.football\s+prod: https:\/\/3fc\.football\s+default: https:\/\/3fc\.football/);
  assert.match(serverlessCoreConfig, /prod: https:\/\/3fc\.football,https:\/\/app\.3fc\.football,https:\/\/qa\.3fc\.football/);
  assert.match(productionTerraformConfig, /site_domain\s+=\s+"3fc\.football"/);
  assert.match(siteDeployScript, /SITE_DOMAIN="\$\{SITE_DOMAIN:-3fc\.football\}"/);
});
