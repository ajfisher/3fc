import assert from "node:assert/strict";
import test from "node:test";

import { resolvePullRequestNumbers } from "../events.mjs";

test("pull request metadata and review events resolve the PR number", () => {
  for (const eventName of [
    "pull_request_target",
    "pull_request_review",
    "pull_request_review_comment",
  ]) {
    assert.deepEqual(
      resolvePullRequestNumbers(eventName, { pull_request: { number: 42 } }),
      [42],
    );
  }
});

test("workflow runs resolve unique associated pull requests", () => {
  assert.deepEqual(resolvePullRequestNumbers("workflow_run", {
    workflow_run: {
      pull_requests: [{ number: 42 }, { number: 43 }, { number: 42 }],
    },
  }), [42, 43]);
});

test("issue comment refresh requires an exact command on a pull request", () => {
  assert.deepEqual(resolvePullRequestNumbers("issue_comment", {
    issue: { number: 42, pull_request: {} },
    comment: { body: " /review-gate refresh " },
  }), [42]);
  assert.deepEqual(resolvePullRequestNumbers("issue_comment", {
    issue: { number: 42, pull_request: {} },
    comment: { body: "please refresh" },
  }), []);
  assert.deepEqual(resolvePullRequestNumbers("issue_comment", {
    issue: { number: 42 },
    comment: { body: "/review-gate refresh" },
  }), []);
});

test("manual dispatch validates the PR number", () => {
  assert.deepEqual(resolvePullRequestNumbers("workflow_dispatch", {}, "17"), [17]);
  assert.deepEqual(resolvePullRequestNumbers("workflow_dispatch", {}, "not-a-number"), []);
});
