import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { verifyProductionHead } from "../deploy/verify-production-head.mjs";

const head = "a".repeat(40), other = "b".repeat(40);
const valid = { event: "workflow_dispatch", ref: "refs/heads/main", eventSha: head, expectedSha: head, checkoutSha: head, remoteMain: head };

test("production CLI checks real git HEAD and remote main and sanitizes failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "3fc-release-guard-"));
  const remote = join(directory, "remote.git"), checkout = join(directory, "checkout");
  const git = args => execFileSync("git", args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const script = fileURLToPath(new URL("../deploy/verify-production-head.mjs", import.meta.url));
  try {
    git(["init", "--bare", remote]); git(["init", "-b", "main", checkout]);
    const local = args => git(["-C", checkout, ...args]);
    const commit = () => local(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    commit(); local(["remote", "add", "origin", remote]); local(["push", "origin", "main"]);
    const sha = local(["rev-parse", "HEAD"]);
    const run = overrides => spawnSync(process.execPath, [script], { cwd: checkout, encoding: "utf8", timeout: 10000,
      env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, EXPECTED_SHA: sha, ...overrides } });
    assert.equal(run({}).status, 0);
    const unsafe = "do-not-echo-$(input)";
    const invalid = run({ EXPECTED_SHA: unsafe }); assert.equal(invalid.status, 1);
    assert(!`${invalid.stdout}${invalid.stderr}`.includes(unsafe));
    commit(); local(["push", "origin", "main"]); local(["checkout", "--detach", sha]);
    assert.equal(run({}).status, 1, "Even matching event/checkout SHA must reject a now-newer remote main");
    local(["remote", "remove", "origin"]);
    const failed = run({}); assert.equal(failed.status, 1);
    assert.doesNotMatch(failed.stderr, /fatal:|remote\.git|could not read/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production release accepts only exact current main for manual dispatch and automatic push", () => {
  assert.doesNotThrow(() => verifyProductionHead(valid));
  assert.doesNotThrow(() => verifyProductionHead({ ...valid, event: "push", expectedSha: "" }));
  for (const overrides of [{ ref: "refs/heads/codex/topic" }, { event: "pull_request" },
    { expectedSha: "" }, { expectedSha: "$(arbitrary-input)" }, { expectedSha: head.slice(0, 7) },
    { expectedSha: head.toUpperCase() }, { expectedSha: other }, { checkoutSha: other },
    { remoteMain: other }, { remoteMain: undefined }, { eventSha: undefined }]) {
    assert.throws(() => verifyProductionHead({ ...valid, ...overrides }));
  }
  assert.throws(() => verifyProductionHead({ ...valid, event: "push", remoteMain: other }));
});

test("production workflow guards before OIDC and deployment, preserves safe flags and validates manual heads", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/deploy-prod.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      expected_sha:/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /group: deploy-prod-main\n  cancel-in-progress: false/);
  const guard = "node scripts/deploy/verify-production-head.mjs";
  assert.equal(workflow.split(guard).length - 1, 3);
  const credentials = workflow.indexOf("- name: Configure AWS credentials");
  assert(workflow.indexOf(guard) < credentials);
  assert(workflow.indexOf("- name: Recheck production head before credentials") < credentials);
  assert(workflow.lastIndexOf(guard) < workflow.indexOf("make deploy ENV=prod SERVICE=api-health"));
  assert.match(workflow, /EXPECTED_SHA: \$\{\{ inputs.expected_sha \}\}/);
  assert.doesNotMatch(workflow, /run:.*\$\{\{ inputs.expected_sha/);
  const validation = workflow.slice(workflow.indexOf("- name: Validate manual production release"), credentials);
  assert.match(validation, /if: github.event_name == 'workflow_dispatch'/);
  for (const command of ["npm run lint", "npm test", "npm run contracts:check"]) assert(validation.includes(command));
  for (const flag of ["PLAYER_CONSOLIDATION_ENABLED", "PLAYER_RETURNING_JOIN_ENABLED"]) {
    assert(workflow.includes(`${flag}: \${{ vars.${flag} || 'false' }}`));
  }
});

test("production core evidence survives later site failure and final acceptance is a separate artifact", () => {
  const w = readFileSync(new URL("../../.github/workflows/deploy-prod.yml", import.meta.url), "utf8");
  const early = w.indexOf("- name: Preserve production API deployment evidence");
  const final = w.indexOf("- name: Preserve completed production release evidence");
  assert(early > w.indexOf("make deploy ENV=prod SERVICE=api-core"));
  assert(early < w.indexOf("make deploy ENV=prod SERVICE=site"));
  assert(final > w.indexOf('run: bash scripts/deploy/verify-api-core.sh prod "$EXPECTED_HEAD"'));
  assert(final < w.indexOf("- name: Write deployment summary"));
  assert.match(w, /name: prod-api-core-deployment-\$\{\{ github.sha \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
  for (const at of [early, final]) {
    const step = w.slice(at, w.indexOf("\n      - name:", at + 1));
    assert.match(step, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(step, /if-no-files-found: error/); assert.match(step, /retention-days: 90/);
    assert.doesNotMatch(step, /always\(|continue-on-error|\.serverless|\*\*/);
  }
});
