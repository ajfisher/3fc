import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const serverlessCoreConfig = readFileSync(resolve(process.cwd(), "../serverless.api-core.yml"), "utf8");
const applicationTerraformConfig = readFileSync(resolve(process.cwd(), "../infra/application/main.tf"), "utf8");
const productionTerraformConfig = readFileSync(resolve(process.cwd(), "../infra/prod/main.tf"), "utf8");
const siteDeployScript = readFileSync(resolve(process.cwd(), "../scripts/deploy/deploy-site.sh"), "utf8");
const apiDeployScript = readFileSync(resolve(process.cwd(), "../scripts/deploy/deploy-app.sh"), "utf8");
const qaWorkflow = readFileSync(resolve(process.cwd(), "../.github/workflows/deploy-qa.yml"), "utf8");

test("shared deployments cannot interleave or cancel the running API/site pair", () => {
  assert.doesNotMatch(qaWorkflow, /^concurrency:/m);
  const job = qaWorkflow.split("  deploy:\n")[1];
  assert.ok(job);
  assert.match(job, /^    concurrency:\n      group: deploy-qa\n      cancel-in-progress: false$/m);
  assert.match(job, /^    if: >-\n/m);
  assert.equal((qaWorkflow.match(/concurrency:/g) ?? []).length, 1);
  for (const environment of ["qa", "prod"]) {
    const workflow = readFileSync(resolve(process.cwd(), `../.github/workflows/deploy-${environment}.yml`), "utf8");
    if (environment === "prod") assert.match(workflow, /^concurrency:\n  group: deploy-prod-main\n  cancel-in-progress: false$/m);
    assert.doesNotMatch(workflow, /cancel-in-progress: true/);
    const verify = workflow.indexOf(`run: bash scripts/deploy/verify-api-core.sh ${environment} "$EXPECTED_HEAD"`);
    const routeSmoke = workflow.indexOf(`- name: Smoke test deployed ${environment === "qa" ? "QA" : "production"} site routes`);
    assert.ok(routeSmoke >= 0 && verify > routeSmoke);
    assert.ok(verify > workflow.indexOf(`smoke-player-proof.sh ${environment} site`));
    assert.ok(verify < workflow.indexOf("- name: Write deployment summary"));
    if (environment === "qa") assert.ok(verify < workflow.indexOf("- name: Preserve exact-head API deployment evidence"));
    assert.doesNotMatch(workflow.slice(workflow.lastIndexOf("      - name:", verify), verify), /continue-on-error:|if:/);
  }
});

test("final deployment guard fails closed for missing, changed or updating API provenance", () => {
  const script = resolve(process.cwd(), "../scripts/deploy/verify-api-core.sh");
  const source = readFileSync(script, "utf8");
  assert.deepEqual(source.match(/Environment\.Variables[^}'\s,]*/g), ["Environment.Variables.PLAYER_CLAIM_MODE", "Environment.Variables.PLAYER_CONSOLIDATION_ENABLED", "Environment.Variables.PLAYER_RETURNING_JOIN_ENABLED"]);
  const directory = mkdtempSync(resolve(tmpdir(), "3fc-deploy-guard-"));
  const head = "a".repeat(40);
  const fingerprint = { functionName: "3fc-qa-api-core", codeSha256: "package", revisionId: "revision", lastUpdateStatus: "Successful", playerClaimMode: "proof", consolidationEnabled: "false", returningJoinEnabled: "false" };
  const manifest = { gitCommit: head, env: "qa", service: "api-core", region: "ap-southeast-2", packageCodeSha256: "package", functionFingerprint: fingerprint };
  const manifestPath = resolve(directory, "out/deploy/qa/api-core-deploy-manifest.json");
  mkdirSync(resolve(directory, "out/deploy/qa"), { recursive: true });
  const run = (live: unknown, record: unknown = manifest, awsStatus = 0, expected = head) => {
    writeFileSync(manifestPath, JSON.stringify(record));
    return spawnSync("bash", ["-c", 'aws() { test "$1 $2" = "lambda get-function-configuration" || return 99; printf %s "$TEST_LIVE"; return "$TEST_AWS_STATUS"; }; export -f aws; bash "$TEST_SCRIPT" qa "$TEST_HEAD"'], {
      cwd: directory, encoding: "utf8", env: { ...process.env, TEST_LIVE: JSON.stringify(live), TEST_AWS_STATUS: String(awsStatus), TEST_SCRIPT: script, TEST_HEAD: expected },
    });
  };
  try {
    assert.equal(run(fingerprint).status, 0);
    for (const key of Object.keys(fingerprint)) {
      const missing = { ...fingerprint } as Record<string, unknown>;
      delete missing[key];
      for (const live of [missing, { ...fingerprint, [key]: "changed" }]) {
        const result = run(live);
        assert.notEqual(result.status, 0, key);
        assert.doesNotMatch(result.stdout, /matches the accepted deployment/);
      }
      assert.notEqual(run(missing, { ...manifest, functionFingerprint: missing }).status, 0, `both missing ${key}`);
    }
    for (const key of Object.keys(manifest)) {
      const missing = { ...manifest } as Record<string, unknown>;
      delete missing[key];
      assert.notEqual(run(fingerprint, missing).status, 0, key);
    }
    assert.notEqual(run(fingerprint, manifest, 7).status, 0);
    assert.notEqual(run(fingerprint, manifest, 0, "b".repeat(40)).status, 0);
    assert.notEqual(run(fingerprint, manifest, 0, "short").status, 0);
    assert.notEqual(run(null).status, 0);
    const disabled = { ...fingerprint, playerClaimMode: "disabled" };
    assert.equal(run(disabled, { ...manifest, functionFingerprint: disabled }).status, 0);
    const enabled = { ...fingerprint, consolidationEnabled: "true" };
    assert.equal(run(enabled, { ...manifest, functionFingerprint: enabled }).status, 0);
    assert.notEqual(run(enabled).status, 0, "live consolidation switch differs from accepted manifest");
    for (const value of [true, false, null, "invalid", ""]) {
      const invalid = { ...fingerprint, consolidationEnabled: value };
      assert.notEqual(run(invalid, { ...manifest, functionFingerprint: invalid }).status, 0, "matching invalid switches must not pass");
    }
    const returning = { ...fingerprint, returningJoinEnabled: "true" };
    assert.equal(run(returning, { ...manifest, functionFingerprint: returning }).status, 0);
    assert.notEqual(run(returning).status, 0, "returning join drift fails");
    for (const value of [true, false, null, "invalid", ""]) {
      const invalid = { ...fingerprint, returningJoinEnabled: value };
      assert.notEqual(run(invalid, { ...manifest, functionFingerprint: invalid }).status, 0, "invalid returning flag cannot match itself");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("league player directory and invitation operations have deployed routes and recovery contracts", () => {
  const contract = readFileSync(resolve(process.cwd(), "../docs/openapi/v1-core-write.yaml"), "utf8");
  const smoke = readFileSync(resolve(process.cwd(), "../scripts/deploy/smoke-player-proof.sh"), "utf8");
  const operations = [
    ["/v1/league-players", ["get", "post"]],
    ["/v1/game-player-registrations", ["post"]],
    ["/v1/player-proofs/league-invitation", ["get", "post"]],
    ["/v1/player-proofs/league-invitation/revoke", ["post"]],
  ] as const;
  for (const [path, methods] of operations) {
    assertServerlessRoute("OPTIONS", path);
    assert.ok(smoke.includes(path.slice(4)), `unsigned deployment smoke includes ${path}`);
    const section = contract.split(`  ${path}:\n`)[1]?.split(/\n  \/v1\//)[0];
    assert.ok(section, path);
    for (const method of methods) {
      assertServerlessRoute(method.toUpperCase(), path);
      const operation = section.split(`    ${method}:\n`)[1]?.split(/\n    (?:get|post):\n/)[0];
      assert.ok(operation, `${method} ${path}`);
      assert.match(operation, /no-store and no-referrer/);
      for (const status of [400, 401, 403, 404, 409, 500, 503]) {
        assert.match(operation, new RegExp(`"${status}":\\s+\\$ref: "#/components/responses/`));
      }
    }
  }
  const page = contract.split("    LeaguePlayerPage:\n")[1].split(/\n    \w+:\n/)[0];
  assert.match(page, /required: \[playerId, nickname, claimed, seasons, hasMoreSeasons\]/);
  assert.doesNotMatch(page, /claimedByUserId|email|gameCount|lastGameAt/);
});

test("profile-link contracts cover recovery errors and expose only public player identities", () => {
  const contract = readFileSync(resolve(process.cwd(), "../docs/openapi/v1-core-write.yaml"), "utf8");
  const operations = [
    ["/v1/join/{joinCode}", "post", [400, 403, 404, 409, 500]],
    ["/v1/players/{playerId}/claim", "post", [400, 401, 403, 404, 409, 500, 503]],
    ["/v1/player-proofs/preview", "post", [400, 401, 403, 404, 409, 500, 503]],
    ["/v1/player-proofs/claim", "post", [400, 401, 403, 404, 409, 500, 503]],
    ["/v1/player-proofs/invitation", "get", [400, 401, 403, 404, 500]],
    ["/v1/player-proofs/invitation", "post", [400, 401, 403, 404, 409, 500, 503]],
    ["/v1/player-proofs/invitation/revoke", "post", [400, 401, 403, 404, 409, 500]],
    ["/v1/games/{gameId}/players/{playerId}/profile-invitation", "get", [400, 401, 403, 404, 500]],
    ["/v1/games/{gameId}/players/{playerId}/profile-invitation", "post", [400, 401, 403, 404, 409, 500, 503]],
    ["/v1/games/{gameId}/players/{playerId}/profile-invitation/revoke", "post", [400, 401, 403, 404, 409, 500]],
  ] as const;
  for (const [path, method, statuses] of operations) {
    const section = contract.split(`  ${path}:\n`)[1]?.split(/\n  \/v1\//)[0];
    assert.ok(section, path);
    const operation = section.split(`    ${method}:\n`)[1]?.split(/\n    (?:get|post):\n/)[0];
    assert.ok(operation, `${method} ${path}`);
    for (const status of statuses) {
      const response = operation.match(new RegExp(`"${status}":\\s+\\$ref: "#/components/responses/([^"\\n]+)"`));
      assert.ok(response, `${method} ${path}: schema-backed ${status}`);
      const component = contract.split(`    ${response[1]}:\n`)[1]?.split(/\n    \w+:\n/)[0];
      assert.match(component ?? "", /\$ref: "#\/components\/schemas\/ErrorResponse"/);
    }
    if (method === "get" || path.endsWith("/revoke")) assert.doesNotMatch(operation, /"503":/);
  }
  for (const name of ["ClaimPlayerResponse", "JoinGameResponse"]) {
    const schema = contract.split(`    ${name}:\n`)[1].split(/\n    \w+:\n/)[0];
    assert.match(schema, /player:\s+\$ref: "#\/components\/schemas\/PublicPlayer"/);
    assert.doesNotMatch(schema, /schemas\/Player"/);
  }
});

test("api core deployment config registers consolidation routes and opt-in switches", () => {
  for (const method of ["GET", "POST", "OPTIONS"]) assertServerlessRoute(method, "/v1/player-consolidations");
  for (const path of ["/v1/player-consolidations/approve", "/v1/player-consolidations/commit"]) {
    for (const method of ["POST", "OPTIONS"]) assertServerlessRoute(method, path);
  }
  assert.match(serverlessCoreConfig, /PLAYER_CONSOLIDATION_ENABLED:.*env:PLAYER_CONSOLIDATION_ENABLED, 'false'/);
  assert.match(serverlessCoreConfig, /PLAYER_RETURNING_JOIN_ENABLED:.*env:PLAYER_RETURNING_JOIN_ENABLED, 'false'/);
  const localCompose = readFileSync(resolve(process.cwd(), "../compose.yaml"), "utf8");
  assert.match(localCompose, /PLAYER_CONSOLIDATION_ENABLED: "\$\{PLAYER_CONSOLIDATION_ENABLED:-false\}"/);
  assert.match(localCompose, /PLAYER_RETURNING_JOIN_ENABLED: "\$\{PLAYER_RETURNING_JOIN_ENABLED:-false\}"/);
  for (const environment of ["qa", "prod"]) {
    const workflow = readFileSync(resolve(process.cwd(), `../.github/workflows/deploy-${environment}.yml`), "utf8");
    assert.match(workflow, /PLAYER_CONSOLIDATION_ENABLED: \$\{\{ vars\.PLAYER_CONSOLIDATION_ENABLED \|\| 'false' \}\}/);
    assert.match(workflow, /PLAYER_RETURNING_JOIN_ENABLED: \$\{\{ vars\.PLAYER_RETURNING_JOIN_ENABLED \|\| 'false' \}\}/);
  }
});

test("api core deployment config registers claim and access routes", () => {
  const contract = readFileSync(resolve(process.cwd(), "../docs/openapi/v1-core-write.yaml"), "utf8");
  const previewContract = contract.slice(contract.indexOf("  /v1/player-proofs/preview:"),
    contract.indexOf("  /v1/games/{gameId}/players/{playerId}/profile-invitation:"));
  assert.match(previewContract, /"404":\s+\$ref: "#\/components\/responses\/NotFound"/);
  assertServerlessRoute("POST", "/v1/player-proofs/preview");
  assertServerlessRoute("OPTIONS", "/v1/player-proofs/preview");
  for (const method of ["GET", "POST", "OPTIONS"]) assertServerlessRoute(method, "/v1/player-proofs/invitation");
  for (const route of ["/v1/player-proofs/claim", "/v1/player-proofs/invitation/revoke"]) {
    for (const method of ["POST", "OPTIONS"]) assertServerlessRoute(method, route);
  }
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
  assertServerlessRoute("GET", "/v1/join/{joinCode}/linked-players");
  assertServerlessRoute("OPTIONS", "/v1/join/{joinCode}/linked-players");
  assertServerlessRoute("POST", "/v1/join/{joinCode}/linked-player");
  assertServerlessRoute("OPTIONS", "/v1/join/{joinCode}/linked-player");
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
  assert.deepEqual(apiDeployScript.match(/Environment\.Variables[^}'\s,]*/g), ["Environment.Variables.PLAYER_CLAIM_MODE", "Environment.Variables.PLAYER_CONSOLIDATION_ENABLED", "Environment.Variables.PLAYER_RETURNING_JOIN_ENABLED"]);
  assert.match(qaWorkflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(qaWorkflow, /name: qa-api-core-deployment/);
  assert.match(qaWorkflow, /path: out\/deploy\/qa\/api-core-deploy-manifest\.json/);
  assert.match(qaWorkflow, /if-no-files-found: error/);
});

test("core deploy validates, exports and verifies the configured claim and consolidation switches", () => {
  const configure = apiDeployScript.slice(apiDeployScript.indexOf("configure_player_claim_mode() {"),
    apiDeployScript.indexOf('\nif [[ "$SERVICE" == "api-core" ]]; then\n  configure_player_claim_mode'));
  assert.ok(configure.includes("case"));
  for (const [input, expected] of [["", "proof"], ["proof", "proof"], ["disabled", "disabled"], ["invalid", null]]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${configure}\nconfigure_player_claim_mode\nbash -c 'printf %s "$PLAYER_CLAIM_MODE"'`],
      { encoding: "utf8", env: { ...process.env, PLAYER_CLAIM_MODE: input!, PLAYER_CONSOLIDATION_ENABLED: "false", PLAYER_RETURNING_JOIN_ENABLED: "false" } });
    assert.equal(result.status, expected === null ? 1 : 0, result.stderr);
    assert.equal(result.stdout, expected ?? "");
  }
  for (const [input, expected] of [["", "false"], ["false", "false"], ["true", "true"], ["invalid", null], ["TRUE", null], ["1", null]]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${configure}\nconfigure_player_claim_mode\nbash -c 'printf %s "$PLAYER_CONSOLIDATION_ENABLED"'`],
      { encoding: "utf8", env: { ...process.env, PLAYER_CLAIM_MODE: "proof", PLAYER_CONSOLIDATION_ENABLED: input!, PLAYER_RETURNING_JOIN_ENABLED: "false" } });
    assert.equal(result.status, expected === null ? 1 : 0, result.stderr);
    assert.equal(result.stdout, expected ?? "");
  }
  for (const [input, expected] of [["", "false"], ["false", "false"], ["true", "true"], ["invalid", null], ["TRUE", null], ["1", null]]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${configure}\nconfigure_player_claim_mode\nbash -c 'printf %s "$PLAYER_RETURNING_JOIN_ENABLED"'`],
      { encoding: "utf8", env: { ...process.env, PLAYER_CLAIM_MODE: "proof", PLAYER_CONSOLIDATION_ENABLED: "false", PLAYER_RETURNING_JOIN_ENABLED: input! } });
    assert.equal(result.status, expected === null ? 1 : 0, result.stderr);
    assert.equal(result.stdout, expected ?? "");
  }
  assert.ok(apiDeployScript.indexOf("  configure_player_claim_mode\n") < apiDeployScript.indexOf("make build"));
  const verify = apiDeployScript.slice(apiDeployScript.indexOf('  jq -e --arg expected "$PACKAGE_CODE_SHA256"'),
    apiDeployScript.indexOf('\nfi\nTIMESTAMP='));
  assert.ok(verify.includes(".playerClaimMode == $mode"));
  assert.ok(verify.includes(".consolidationEnabled == $consolidation"));
  assert.ok(verify.includes(".returningJoinEnabled == $returning"));
  for (const deployed of ["proof", "disabled", null]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${verify}`], { encoding: "utf8", env: {
      ...process.env, PACKAGE_CODE_SHA256: "package", PLAYER_CLAIM_MODE: "disabled", PLAYER_CONSOLIDATION_ENABLED: "false", PLAYER_RETURNING_JOIN_ENABLED: "false",
      FUNCTION_FINGERPRINT: JSON.stringify({ lastUpdateStatus: "Successful", codeSha256: "package", revisionId: "revision", playerClaimMode: deployed, consolidationEnabled: "false", returningJoinEnabled: "false" }),
    } });
    assert.equal(result.status, deployed === "disabled" ? 0 : 1, result.stderr);
  }
  for (const expected of ["true", "false"]) {
    for (const deployed of ["true", "false", null, undefined, true, false, "invalid"]) {
      const result = spawnSync("bash", ["-c", `set -euo pipefail\n${verify}`], { encoding: "utf8", env: {
        ...process.env, PACKAGE_CODE_SHA256: "package", PLAYER_CLAIM_MODE: "proof", PLAYER_CONSOLIDATION_ENABLED: expected, PLAYER_RETURNING_JOIN_ENABLED: "false",
        FUNCTION_FINGERPRINT: JSON.stringify({ lastUpdateStatus: "Successful", codeSha256: "package", revisionId: "revision", playerClaimMode: "proof", consolidationEnabled: deployed, returningJoinEnabled: "false" }),
      } });
      assert.equal(result.status, deployed === expected ? 0 : 1, result.stderr);
    }
  }
  for (const expected of ["true", "false"]) {
    for (const deployed of ["true", "false", null, undefined, true, false, "invalid"]) {
      const result = spawnSync("bash", ["-c", `set -euo pipefail\n${verify}`], { encoding: "utf8", env: {
        ...process.env, PACKAGE_CODE_SHA256: "package", PLAYER_CLAIM_MODE: "proof", PLAYER_CONSOLIDATION_ENABLED: "false", PLAYER_RETURNING_JOIN_ENABLED: expected,
        FUNCTION_FINGERPRINT: JSON.stringify({ lastUpdateStatus: "Successful", codeSha256: "package", revisionId: "revision", playerClaimMode: "proof", consolidationEnabled: "false", returningJoinEnabled: deployed }),
      } });
      assert.equal(result.status, deployed === expected ? 0 : 1, result.stderr);
    }
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
