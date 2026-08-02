import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const serverlessCoreConfig = readFileSync(resolve(process.cwd(), "../serverless.api-core.yml"), "utf8");

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
});
