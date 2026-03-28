import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { buildStaticSite } from "../static-export.js";

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
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
