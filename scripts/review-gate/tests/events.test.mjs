import assert from "node:assert/strict";
import test from "node:test";

import { resolvePullRequestNumbers } from "../events.mjs";

test("pull request metadata and review events resolve the PR number", async () => {
  for (const eventName of [
    "pull_request_target",
    "pull_request_review",
    "pull_request_review_comment",
  ]) {
    assert.deepEqual(
      await resolvePullRequestNumbers(eventName, { pull_request: { number: 42 } }),
      [42],
    );
  }
});

test("workflow runs resolve unique associated pull requests", async () => {
  assert.deepEqual(await resolvePullRequestNumbers("workflow_run", {
    workflow_run: {
      pull_requests: [{ number: 42 }, { number: 43 }, { number: 42 }],
    },
  }), [42, 43]);
});

test("workflow completion falls back to current open PRs associated with its head", async () => {
  const calls = [];
  const result = await resolvePullRequestNumbers(
    "workflow_run",
    { workflow_run: { head_sha: "head-123", pull_requests: [] } },
    undefined,
    {
      async getAssociatedPullRequestNumbers(headSha) {
        calls.push(headSha);
        return [41, 42];
      },
    },
  );
  assert.deepEqual(result, [41, 42]);
  assert.deepEqual(calls, ["head-123"]);
});

test("issue comment refresh requires an exact trusted command on a pull request", async () => {
  assert.deepEqual(await resolvePullRequestNumbers("issue_comment", {
    issue: { number: 42, pull_request: {} },
    comment: {
      body: "/review-gate refresh",
      author_association: "COLLABORATOR",
    },
  }), [42]);
  assert.deepEqual(await resolvePullRequestNumbers("issue_comment", {
    issue: { number: 42, pull_request: {} },
    comment: { body: "please refresh", author_association: "OWNER" },
  }), []);
  assert.deepEqual(await resolvePullRequestNumbers("issue_comment", {
    issue: { number: 42, pull_request: {} },
    comment: {
      body: " /review-gate refresh ",
      author_association: "OWNER",
    },
  }), []);
  assert.deepEqual(await resolvePullRequestNumbers("issue_comment", {
    issue: { number: 42 },
    comment: {
      body: "/review-gate refresh",
      author_association: "OWNER",
    },
  }), []);
  assert.deepEqual(await resolvePullRequestNumbers("issue_comment", {
    issue: { number: 42, pull_request: {} },
    comment: {
      body: "/review-gate refresh",
      author_association: "CONTRIBUTOR",
    },
  }), []);
});

test("manual dispatch validates the PR number", async () => {
  assert.deepEqual(await resolvePullRequestNumbers("workflow_dispatch", {}, "17"), [17]);
  assert.deepEqual(await resolvePullRequestNumbers("workflow_dispatch", {}, "not-a-number"), []);
});
