import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  desiredManagedLabels,
  evaluateReview,
} from "./evaluate.mjs";
import { resolvePullRequestNumbers } from "./events.mjs";
import { GitHubClient } from "./github.mjs";
import { loadPolicy } from "./policy.mjs";
import { renderSummary } from "./render.mjs";

function normalizeReviews(reviews) {
  return reviews.map((review) => ({
    login: review.user?.login ?? "",
    state: review.state,
    commitId: review.commit_id ?? null,
    submittedAt: review.submitted_at ?? "",
  }));
}

function normalizeActivity(activity) {
  return activity.map((item) => ({
    login: item.user?.login ?? "",
    createdAt: item.created_at ?? item.updated_at ?? "",
  }));
}

function normalizeChecks(checks) {
  return checks.map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    completedAt: check.completed_at ?? check.started_at ?? "",
  }));
}

async function evaluatePullRequest(client, policy, number) {
  const pullRequest = await client.getPullRequest(number);
  const currentLabels = pullRequest.labels.map((label) => label.name);

  if (pullRequest.state === "closed") {
    const managed = currentLabels.filter((label) =>
      policy.labels.managed_prefixes.some((prefix) => label.startsWith(prefix)));
    await client.removeLabels(number, managed);
    console.log(`PR #${number}: closed; removed ${managed.length} managed label(s)`);
    return;
  }

  const headSha = pullRequest.head.sha;
  const [
    changedFiles,
    checkRuns,
    reviews,
    codexActivity,
    reviewThreads,
  ] = await Promise.all([
    client.getChangedFiles(number),
    client.getCheckRuns(headSha),
    client.getReviews(number),
    client.getCodexActivity(number),
    client.getReviewThreads(number),
  ]);

  const result = evaluateReview(policy, {
    body: pullRequest.body ?? "",
    changedFiles,
    checkRuns: normalizeChecks(checkRuns),
    reviews: normalizeReviews(reviews),
    codexActivity: normalizeActivity(codexActivity),
    reviewThreads,
    labels: currentLabels,
    draft: pullRequest.draft,
    headSha,
  });
  const summary = renderSummary(result, headSha);

  await client.ensureLabels(policy.labels.definitions);
  const labelChanges = desiredManagedLabels(policy, currentLabels, result.labels);
  await client.removeLabels(number, labelChanges.remove);
  await client.addLabels(number, labelChanges.add);
  await client.publishCheck({
    headSha,
    state: result.state,
    conclusion: result.conclusion,
    summary,
    pullRequestNumber: number,
    pullRequestUrl: pullRequest.html_url,
  });

  console.log(
    `PR #${number}: ${result.state}; risk=${result.risk.effective}; `
      + `labels +${labelChanges.add.length}/-${labelChanges.remove.length}`,
  );
}

async function publishConfigurationError(client, number, error) {
  const pullRequest = await client.getPullRequest(number);
  if (pullRequest.state === "closed") {
    return;
  }
  const summary = [
    "## Review gate: CONFIGURATION ERROR",
    "",
    `- ${error.message}`,
    "",
    "### To unblock",
    "",
    "1. Correct the base-branch review policy.",
    "2. Rerun review-gate.",
    "",
    "> Observe mode: this configuration error is reported with a neutral conclusion.",
  ].join("\n");
  await client.publishCheck({
    headSha: pullRequest.head.sha,
    state: "configuration-error",
    conclusion: "neutral",
    summary,
    pullRequestNumber: number,
    pullRequestUrl: pullRequest.html_url,
  });
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }
  const payload = JSON.parse(await readFile(eventPath, "utf8"));
  const client = new GitHubClient({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY ?? "",
  });

  let numbers = await resolvePullRequestNumbers(
    eventName,
    payload,
    process.env.INPUT_PR_NUMBER,
    client,
  );
  if (eventName === "schedule") {
    numbers = await client.listOpenPullRequestNumbers();
  }
  if (numbers.length === 0) {
    console.log(`No pull requests require review-gate refresh for ${eventName}.`);
    return;
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  let policy;
  try {
    policy = await loadPolicy(path.join(workspace, ".github", "review-policy.yml"));
  } catch (error) {
    const failures = [];
    for (const number of numbers) {
      try {
        await publishConfigurationError(client, number, error);
      } catch (publishError) {
        failures.push(`PR #${number}: ${publishError.stack ?? publishError.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Could not publish review policy configuration error:\n${failures.join("\n\n")}`);
    }
    console.log(`Published review policy configuration error for ${numbers.length} PR(s).`);
    return;
  }

  const failures = [];
  for (const number of numbers) {
    try {
      await evaluatePullRequest(client, policy, number);
    } catch (error) {
      failures.push(`PR #${number}: ${error.stack ?? error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Review gate refresh failed:\n${failures.join("\n\n")}`);
  }
}

await main();
