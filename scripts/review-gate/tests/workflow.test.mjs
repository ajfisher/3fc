import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../../.github/workflows/review-gate.yml", import.meta.url),
  "utf8",
);

test("workflow listens to every supported review-gate refresh source", () => {
  for (const trigger of [
    "pull_request_target:",
    "pull_request_review:",
    "pull_request_review_comment:",
    "issue_comment:",
    "workflow_run:",
    "schedule:",
    "workflow_dispatch:",
  ]) {
    assert.match(workflow, new RegExp(`\\n  ${trigger}`));
  }
  assert.match(workflow, /- PR checks/);
  assert.match(workflow, /- Deploy QA/);
  assert.match(workflow, /cron: "17 \* \* \* \*"/);
  assert.doesNotMatch(workflow, /pull_request_review_thread:/);
});

test("privileged evaluation uses pinned Actions and trusted default-branch code", () => {
  assert.match(
    workflow,
    /uses: actions\/checkout@[0-9a-f]{40} # v6/,
  );
  assert.match(
    workflow,
    /uses: actions\/setup-node@[0-9a-f]{40} # v6/,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /run: node scripts\/review-gate\/run\.mjs/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head/);
  assert.doesNotMatch(workflow, /github\.head_ref/);
  assert.doesNotMatch(workflow, /npm ci/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/);
});

test("workflow permissions and refresh authorisation are explicit", () => {
  assert.match(
    workflow,
    /permissions:\s*\n\s+contents: read\s*\n\s+pull-requests: read\s*\n\s+checks: write\s*\n\s+issues: write/,
  );
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /actions: write/);
  assert.doesNotMatch(workflow, /id-token: write/);
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.match(
      workflow,
      new RegExp(`author_association == '${association}'`),
    );
  }
});
