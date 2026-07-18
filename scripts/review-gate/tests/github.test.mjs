import assert from "node:assert/strict";
import test from "node:test";

import { GitHubClient } from "../github.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("GitHub client requires an exact owner/repository identifier", () => {
  assert.throws(
    () => new GitHubClient({
      token: "token",
      repository: "owner/repository/extra",
    }),
    /owner\/repository format/,
  );
});

test("workflow-run fallback keeps only open associated pull requests", async () => {
  const requests = [];
  const client = new GitHubClient({
    token: "token",
    repository: "ajfisher/3fc",
    async fetchImpl(url) {
      requests.push(url);
      return jsonResponse([
        { number: 41, state: "closed" },
        { number: 42, state: "open" },
      ]);
    },
  });

  assert.deepEqual(
    await client.getAssociatedPullRequestNumbers("head-123"),
    [42],
  );
  assert.match(requests[0], /commits\/head-123\/pulls\?per_page=100&page=1$/);
});

test("GraphQL errors are surfaced with their server diagnostics", async () => {
  const client = new GitHubClient({
    token: "token",
    repository: "ajfisher/3fc",
    async fetchImpl() {
      return jsonResponse({ errors: [{ message: "reviewThreads unavailable" }] });
    },
  });

  await assert.rejects(
    client.graphql("query Test { viewer { login } }", {}),
    /reviewThreads unavailable/,
  );
});

test("publishing updates the one existing review-gate check", async () => {
  const requests = [];
  const client = new GitHubClient({
    token: "token",
    repository: "ajfisher/3fc",
    async fetchImpl(url, options) {
      requests.push({ url, options });
      if (options.method === "GET") {
        return jsonResponse({
          check_runs: [{
            id: 99,
            name: "review-gate",
            started_at: "2026-07-18T00:00:00Z",
          }],
        });
      }
      return jsonResponse({ id: 99 });
    },
  });

  await client.publishCheck({
    headSha: "head-123",
    state: "blocked",
    conclusion: "neutral",
    summary: "Review summary",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/ajfisher/3fc/pull/42",
  });

  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /check-runs\/99$/);
  assert.equal(requests[1].options.method, "PATCH");
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.name, "review-gate");
  assert.equal(payload.details_url, "https://github.com/ajfisher/3fc/pull/42");
  assert.equal(payload.conclusion, "neutral");
  assert.equal("head_sha" in payload, false);
});
