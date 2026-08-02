import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";

import { buildStaticSite } from "../static-export.js";

function runCloudFrontRouter(uri: string): string {
  const source = readFileSync(resolve(process.cwd(), "../infra/application/cloudfront-site-router.js"), "utf8");
  const context = createContext({
    event: {
      request: { uri },
    },
    result: null,
  });
  new Script(`${source}\nresult = handler(event);`).runInContext(context);

  const result = context.result as { uri?: string } | null;
  if (!result?.uri) {
    throw new Error(`CloudFront router did not return a request for ${uri}.`);
  }
  return result.uri;
}

test("buildStaticSite exports static route shells and ui assets", () => {
  const outputDir = mkdtempSync(resolve(tmpdir(), "3fc-static-site-"));

  try {
    const builtDir = buildStaticSite({
      apiBaseUrl: "https://qa-api.3fc.football",
      outputDir,
    });

    assert.equal(builtDir, resolve(outputDir));
    assert.equal(existsSync(resolve(outputDir, "index.html")), true);
    assert.equal(existsSync(resolve(outputDir, "setup/index.html")), true);
    assert.equal(existsSync(resolve(outputDir, "sign-in/index.html")), true);
    assert.equal(existsSync(resolve(outputDir, "auth/callback/index.html")), true);
    assert.equal(existsSync(resolve(outputDir, "leagues/index.html")), true);
    assert.equal(existsSync(resolve(outputDir, "seasons/index.html")), true);
    assert.equal(existsSync(resolve(outputDir, "games/index.html")), true);
    assert.equal(existsSync(resolve(outputDir, "join/index.html")), true);
    assert.equal(existsSync(resolve(outputDir, "ui/styles.css")), true);
    assert.equal(existsSync(resolve(outputDir, "ui/setup-flow.js")), true);
    assert.equal(existsSync(resolve(outputDir, "ui/auth-flow.js")), true);

    const rootHtml = readFileSync(resolve(outputDir, "index.html"), "utf8");
    assert.match(rootHtml, /data-page="dashboard"/);

    const signInHtml = readFileSync(resolve(outputDir, "sign-in/index.html"), "utf8");
    assert.match(signInHtml, /id="auth-magic-form"/);

    const leagueHtml = readFileSync(resolve(outputDir, "leagues/index.html"), "utf8");
    assert.match(leagueHtml, /data-page="league"/);
    assert.match(leagueHtml, /data-league-id=""/);

    const joinHtml = readFileSync(resolve(outputDir, "join/index.html"), "utf8");
    assert.match(joinHtml, /data-page="join"/);
    assert.match(joinHtml, /data-join-code=""/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("CloudFront router maps deployed join deep links to the exported shell", () => {
  assert.equal(runCloudFrontRouter("/join"), "/join/index.html");
  assert.equal(runCloudFrontRouter("/join/ABCD2345"), "/join/index.html");
  assert.equal(runCloudFrontRouter("/ui/setup-flow.js"), "/ui/setup-flow.js");
});
