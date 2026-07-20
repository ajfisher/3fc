import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyCodexReview,
  desiredManagedLabels,
  evaluateReview,
  globMatches,
} from "../evaluate.mjs";
import { parseReviewPacket } from "../packet.mjs";
import { parsePolicy, validatePolicy } from "../policy.mjs";
import { renderSummary } from "../render.mjs";

const policyPath = new URL("../../../.github/review-policy.yml", import.meta.url);
const fixturePath = new URL("../fixtures/base-state.json", import.meta.url);
const policy = parsePolicy(await readFile(policyPath, "utf8"));
const baseState = JSON.parse(await readFile(fixturePath, "utf8"));

function packet({
  risk = "low",
  claim = "Documentation describes the review process.",
  acceptance = true,
  acceptanceResult = "PASS",
  changeTypes = [],
  architecture = "none",
  invariants = "",
  architectureRecord = "",
  failureBehaviour = "",
  rollbackApproach = "",
  rollbackEvidence = "",
  rejectedFinding = "",
  noJudgement = true,
  judgementDecision = "",
  judgementOptions = "",
  judgementReason = "",
  reversalCost = "",
} = {}) {
  const changeTypeIds = [
    "documentation-only",
    "tests-only",
    "application-behaviour",
    "backlog-maintenance",
    "dependency-tooling",
    "public-contract",
    "data-migration",
    "permission-trust-boundary",
    "durable-state-ownership",
    "destructive-behaviour",
    "new-production-dependency",
    "authentication-authorisation",
    "privacy-regulated-data",
    "infrastructure-production-configuration",
    "review-policy",
  ];
  const selectedChangeTypes = changeTypes.length > 0
    ? changeTypes
    : ["documentation-only"];
  const architectureToken = `architecture:${architecture}`;
  return `<!-- review-packet-version:1 -->

## Behavioural claim

${claim}

## Specification and acceptance evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
${acceptance ? `| Review behaviour is documented | docs/review-process.md | ${acceptanceResult} |` : "|  |  | PENDING |"}

## Scope boundaries

Included: review process

Excluded: product behaviour

## Change classification

- Declared risk: \`${risk}\`
${changeTypeIds.map((id) => `- [${selectedChangeTypes.includes(id) ? "x" : " "}] \`${id}\``).join("\n")}

## Architecture and invariants

${["architecture:none", "architecture:documented", "architecture:judgement-required"]
  .map((token) => `- [${architectureToken === token ? "x" : " "}] \`${token}\``)
  .join("\n")}

### Affected invariants

${invariants}

### Architecture or decision record

${architectureRecord}

## Failure and rollback

### Failure behaviour

${failureBehaviour}

### Rollback approach

${rollbackApproach}

### Rollback evidence

${rollbackEvidence}

## Automated and agent review disposition

### Unresolved blocking findings

None.

### Rejected findings and evidence

${rejectedFinding || "None."}

## Human judgement

- [${noJudgement ? "x" : " "}] \`human-judgement:none\`
- [${noJudgement ? " " : "x"}] \`human-judgement:required\`

### Decision requiring judgement

${judgementDecision}

### Options considered

${judgementOptions}

### Reason selected

${judgementReason}

### Reversal cost

${reversalCost}

## Review focus

Please inspect: review policy
`;
}

function state(overrides = {}) {
  return {
    ...structuredClone(baseState),
    body: packet(),
    ...overrides,
  };
}

function completedCheck(name, conclusion = "success") {
  return {
    name,
    status: "completed",
    conclusion,
    completedAt: "2026-07-18T02:00:00Z",
  };
}

function invariantTable(
  invariant = "INV-002",
  affected = "Changes protected write routing.",
  valid = "The route still requires a scoped authenticated session.",
  evidence = "`npm run test -w @3fc/api`",
) {
  return [
    "| Invariant | How this PR affects it | Why it remains valid | Evidence |",
    "| --- | --- | --- | --- |",
    `| ${invariant} | ${affected} | ${valid} | ${evidence} |`,
  ].join("\n");
}

function highRiskState(overrides = {}) {
  return state({
    body: packet({
      risk: "low",
      acceptance: true,
      architecture: "documented",
      invariants: "none",
      architectureRecord: "docs/decisions/0001-risk-based-pull-request-review.md",
      failureBehaviour: "The change fails closed.",
      rollbackApproach: "Revert the pull request.",
      rollbackEvidence: "Fixture verifies old policy.",
    }),
    changedFiles: ["api/src/auth/acl.ts"],
    labels: ["QA-ready"],
    checkRuns: [completedCheck("merge-gate"), completedCheck("deploy-qa")],
    ...overrides,
  });
}

test("low-risk documentation-only PR passes with low-risk evidence", () => {
  const result = evaluateReview(policy, state());
  assert.equal(result.state, "pass", result.blockers.join("\n"));
  assert.equal(result.conclusion, "success");
  assert.equal(result.risk.effective, "low");
  assert.deepEqual(result.labels, ["risk:low", "review:ready", "architecture:none"]);
});

test("high-risk path escalates a PR declared low risk", () => {
  const result = evaluateReview(policy, highRiskState());
  assert.equal(result.risk.declared, "low");
  assert.equal(result.risk.effective, "high");
  assert.match(result.risk.escalationReasons.join("\n"), /api\/src\/auth\/acl\.ts/);
});

test("high-risk change type escalates an otherwise low-risk path", () => {
  const result = evaluateReview(policy, highRiskState({
    changedFiles: ["docs/product.md"],
    body: packet({
      risk: "low",
      changeTypes: ["public-contract"],
      acceptance: true,
      architecture: "documented",
      invariants: "none",
      architectureRecord: "docs/decisions/001-public-contract.md",
      failureBehaviour: "Old clients could reject the response.",
      rollbackApproach: "Restore the prior contract.",
      rollbackEvidence: "Contract fixture.",
    }),
  }));
  assert.equal(result.risk.effective, "high");
  assert.match(result.risk.escalationReasons.join("\n"), /public-contract/);
});

test("missing behavioural claim blocks every tier", () => {
  const result = evaluateReview(policy, state({ body: packet({ claim: "" }) }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /Behavioural claim/);
  assert.ok(result.labels.includes("review:awaiting-evidence"));
});

test("missing acceptance evidence blocks medium risk", () => {
  const result = evaluateReview(policy, state({
    body: packet({ risk: "medium", acceptance: false }),
    changedFiles: ["app/src/index.ts"],
    labels: ["QA-ready"],
    checkRuns: [completedCheck("merge-gate"), completedCheck("deploy-qa")],
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /acceptance criterion/);
});

test("pending acceptance evidence is never presented as passing evidence", () => {
  const result = evaluateReview(policy, state({
    body: packet({
      risk: "medium",
      changeTypes: ["application-behaviour"],
      acceptanceResult: "PENDING",
    }),
    changedFiles: ["app/src/index.ts"],
    labels: ["QA-ready"],
    checkRuns: [completedCheck("merge-gate"), completedCheck("deploy-qa")],
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /PENDING result/);
});

test("missing acceptance evidence blocks high risk", () => {
  const high = highRiskState();
  high.body = packet({
    risk: "high",
    acceptance: false,
    architecture: "documented",
    invariants: invariantTable(),
    architectureRecord: "docs/decisions/001-auth.md",
    failureBehaviour: "Fail closed.",
    rollbackApproach: "Revert.",
  });
  const result = evaluateReview(policy, high);
  assert.match(result.blockers.join("\n"), /acceptance criterion/);
});

test("missing rollback evidence blocks high risk", () => {
  const high = highRiskState();
  high.body = packet({
    risk: "high",
    architecture: "documented",
    invariants: invariantTable(),
    architectureRecord: "docs/decisions/001-auth.md",
    failureBehaviour: "Fail closed.",
    rollbackApproach: "Revert the pull request.",
    rollbackEvidence: "",
  });
  const result = evaluateReview(policy, high);
  assert.match(result.blockers.join("\n"), /rollback evidence/);
});

test("pending QA produces pending rather than pass", () => {
  const result = evaluateReview(policy, state({
    body: packet({ risk: "medium" }),
    changedFiles: ["app/src/index.ts"],
    labels: ["QA-ready"],
  }));
  assert.equal(result.state, "pending");
  assert.equal(result.conclusion, "neutral");
  assert.match(result.pending.join("\n"), /deploy-qa/);
});

test("missing QA trigger label blocks medium risk with an action", () => {
  const result = evaluateReview(policy, state({
    body: packet({ risk: "medium" }),
    changedFiles: ["app/src/index.ts"],
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /QA-ready/);
});

test("failed CI produces blocked", () => {
  const result = evaluateReview(policy, state({
    checkRuns: [completedCheck("merge-gate", "failure")],
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /merge-gate/);
});

test("stale Codex reviewed SHA blocks when current-SHA mode is required", () => {
  const requiredPolicy = structuredClone(policy);
  requiredPolicy.risk.low.requirements.codex_review = "required";
  const result = evaluateReview(requiredPolicy, state({
    reviews: [{
      login: "chatgpt-codex-connector[bot]",
      state: "COMMENTED",
      commitId: "old-head",
      submittedAt: "2026-07-18T02:00:00Z",
    }],
  }));
  assert.equal(result.codex.state, "stale");
  assert.equal(result.state, "blocked");
});

test("Codex activity without a reviewed SHA is unknown, never current", () => {
  const result = classifyCodexReview(
    [],
    [{ login: "chatgpt-codex-connector[bot]" }],
    "head-123",
    policy.codex.reviewer_logins,
  );
  assert.deepEqual(result, { state: "unknown", reviewedSha: null });
});

test("Codex prefers a verified current-head review over newer unverified activity", () => {
  const result = classifyCodexReview(
    [
      {
        login: "chatgpt-codex-connector[bot]",
        state: "COMMENTED",
        commitId: "head-123",
        submittedAt: "2026-07-18T01:00:00Z",
      },
      {
        login: "chatgpt-codex-connector[bot]",
        state: "COMMENTED",
        commitId: null,
        submittedAt: "2026-07-18T02:00:00Z",
      },
    ],
    [],
    "head-123",
    policy.codex.reviewer_logins,
  );
  assert.deepEqual(result, { state: "current", reviewedSha: "head-123" });
});

test("dismissed Codex reviews do not count as current", () => {
  const result = classifyCodexReview(
    [{
      login: "chatgpt-codex-connector[bot]",
      state: "DISMISSED",
      commitId: "head-123",
      submittedAt: "2026-07-18T02:00:00Z",
    }],
    [],
    "head-123",
    policy.codex.reviewer_logins,
  );
  assert.deepEqual(result, { state: "missing", reviewedSha: null });
});

test("unresolved non-outdated review thread blocks", () => {
  const result = evaluateReview(policy, state({
    reviewThreads: [{ isResolved: false, isOutdated: false }],
  }));
  assert.equal(result.state, "blocked");
  assert.equal(result.unresolvedThreads, 1);
});

test("outdated or resolved review threads do not block", () => {
  const result = evaluateReview(policy, state({
    reviewThreads: [
      { isResolved: false, isOutdated: true },
      { isResolved: true, isOutdated: false },
    ],
  }));
  assert.equal(result.state, "pass");
  assert.equal(result.unresolvedThreads, 0);
});

test("missing required human approval blocks medium risk", () => {
  const approvalPolicy = structuredClone(policy);
  approvalPolicy.risk.medium.requirements.human_approvals = 1;
  const result = evaluateReview(approvalPolicy, state({
    body: packet({ risk: "medium" }),
    changedFiles: ["app/src/index.ts"],
    labels: ["QA-ready"],
    checkRuns: [completedCheck("merge-gate"), completedCheck("deploy-qa")],
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /0 \/ 1/);
});

test("latest valid human approval satisfies configured requirement", () => {
  const approvalPolicy = structuredClone(policy);
  approvalPolicy.risk.medium.requirements.human_approvals = 1;
  const result = evaluateReview(approvalPolicy, state({
    body: packet({ risk: "medium" }),
    changedFiles: ["app/src/index.ts"],
    labels: ["QA-ready"],
    checkRuns: [completedCheck("merge-gate"), completedCheck("deploy-qa")],
    reviews: [{
      login: "reviewer",
      state: "APPROVED",
      commitId: "head-123",
      submittedAt: "2026-07-18T02:00:00Z",
    }],
  }));
  assert.equal(result.state, "pass");
  assert.equal(result.approvals, 1);
});

test("managed labels update without removing unrelated labels", () => {
  const changes = desiredManagedLabels(
    policy,
    ["risk:low", "review:blocked", "architecture:none", "QA-ready", "area:api"],
    ["risk:high", "review:ready", "architecture:documented"],
  );
  assert.deepEqual(changes.remove, ["architecture:none", "review:blocked", "risk:low"]);
  assert.deepEqual(changes.add, ["architecture:documented", "review:ready", "risk:high"]);
});

test("malformed policy produces a useful configuration error", () => {
  assert.throws(() => parsePolicy("{bad"), /JSON-compatible YAML/);
  const malformed = structuredClone(policy);
  malformed.risk.order = ["high", "low"];
  const result = evaluateReview(malformed, state());
  assert.equal(result.state, "configuration-error");
  assert.match(result.blockers[0], /risk\.order/);
});

test("review-gate cannot wait on itself", () => {
  const recursive = structuredClone(policy);
  recursive.checks.ci.required_check_names.push("review-gate");
  assert.throws(() => validatePolicy(recursive), /cannot be one of its own/);
});

test("PR touching paths from two tiers receives the higher risk", () => {
  const result = evaluateReview(policy, highRiskState({
    changedFiles: ["docs/product.md", "app/src/index.ts", "infra/application/main.tf"],
  }));
  assert.equal(result.risk.effective, "high");
});

test("editing the PR packet refreshes missing evidence", () => {
  const missing = state({ body: packet({ claim: "" }) });
  assert.equal(evaluateReview(policy, missing).state, "blocked");
  assert.equal(evaluateReview(policy, { ...missing, body: packet() }).state, "pass");
});

test("draft PR reports pending and never ready", () => {
  const result = evaluateReview(policy, state({ draft: true }));
  assert.equal(result.state, "pending");
  assert.ok(result.labels.includes("review:automated"));
  assert.ok(!result.labels.includes("review:ready"));
});

test("rejected finding without reason and evidence blocks", () => {
  const result = evaluateReview(policy, state({
    body: packet({ rejectedFinding: true }),
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /rejected automated finding/i);
});

test("architecture trigger cannot be declared as no impact", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "none",
      invariants: "none",
      failureBehaviour: "Fail closed.",
      rollbackApproach: "Revert.",
    }),
  }));
  assert.match(result.blockers.join("\n"), /Architecture-sensitive paths/);
});

test("listed invariants require impact details", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: "INV-002 INV-003",
      architectureRecord: "docs/decisions/001-auth.md",
      failureBehaviour: "Fail closed.",
      rollbackApproach: "Revert.",
      rollbackEvidence: "Revert is sufficient because no data migration runs.",
    }),
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /invariant impact rows/);
});

test("complete invariant impact rows satisfy high-risk invariant declaration", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: invariantTable(
        "INV-003",
        "Adds an idempotent write endpoint.",
        "Stored results are replayed for matching operation keys.",
        "`npm run test -w @3fc/api`",
      ),
      architectureRecord: "docs/decisions/001-idempotent-write.md",
      failureBehaviour: "The endpoint fails closed on conflicting idempotency keys.",
      rollbackApproach: "Revert the endpoint and contract change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "pass", result.blockers.join("\n"));
  assert.deepEqual(result.packet.affectedInvariantRows, [{
    invariant: "INV-003",
    invariantIds: ["INV-003"],
    affected: "Adds an idempotent write endpoint.",
    valid: "Stored results are replayed for matching operation keys.",
    evidence: "`npm run test -w @3fc/api`",
  }]);
});

test("invariant impact rows accept tables without outer pipes", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: [
        "Invariant | How this PR affects it | Why it remains valid | Evidence",
        "--- | --- | --- | ---",
        "INV-004 | Changes a repository access path. | Keys remain owned by the documented entity. | `npm run test -w @3fc/api`",
      ].join("\n"),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Invalid access paths fail closed.",
      rollbackApproach: "Revert the repository change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "pass", result.blockers.join("\n"));
  assert.deepEqual(result.packet.affectedInvariantRows, [{
    invariant: "INV-004",
    invariantIds: ["INV-004"],
    affected: "Changes a repository access path.",
    valid: "Keys remain owned by the documented entity.",
    evidence: "`npm run test -w @3fc/api`",
  }]);
});

test("invariant impact rows accept escaped pipes and code-span pipes in cells", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: [
        "| Invariant | How this PR affects it | Why it remains valid | Evidence |",
        "| --- | --- | --- | --- |",
        "| INV-004 | Changes a parser path. | Table cells still parse deterministically. | `npm test \\| tee evidence.log` and `a|b` |",
      ].join("\n"),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Malformed packets fail closed.",
      rollbackApproach: "Revert the parser change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "pass", result.blockers.join("\n"));
  assert.deepEqual(result.packet.affectedInvariantRows, [{
    invariant: "INV-004",
    invariantIds: ["INV-004"],
    affected: "Changes a parser path.",
    valid: "Table cells still parse deterministically.",
    evidence: "`npm test \\| tee evidence.log` and `a|b`",
  }]);
});

test("invariant impact rows accept multi-backtick code-span pipes in cells", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: [
        "| Invariant | How this PR affects it | Why it remains valid | Evidence |",
        "| --- | --- | --- | --- |",
        "| INV-004 | Changes a parser path. | Table cells still parse deterministically. | ``command a|b`` |",
      ].join("\n"),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Malformed packets fail closed.",
      rollbackApproach: "Revert the parser change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "pass", result.blockers.join("\n"));
  assert.deepEqual(result.packet.affectedInvariantRows, [{
    invariant: "INV-004",
    invariantIds: ["INV-004"],
    affected: "Changes a parser path.",
    valid: "Table cells still parse deterministically.",
    evidence: "``command a|b``",
  }]);
});

test("invariant impact rows accept single-hyphen GFM delimiters", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: [
        "| Invariant | How this PR affects it | Why it remains valid | Evidence |",
        "| - | - | - | - |",
        "| INV-004 | Changes a parser path. | Table delimiter parsing still follows GFM. | `npm run test:review-gate` |",
      ].join("\n"),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Malformed packets fail closed.",
      rollbackApproach: "Revert the parser change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "pass", result.blockers.join("\n"));
  assert.deepEqual(result.packet.affectedInvariantRows, [{
    invariant: "INV-004",
    invariantIds: ["INV-004"],
    affected: "Changes a parser path.",
    valid: "Table delimiter parsing still follows GFM.",
    evidence: "`npm run test:review-gate`",
  }]);
});

test("invariant impact rows require a Markdown table delimiter", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: [
        "Notes | context",
        "INV-002 | Changes protected writes. | ACL remains enforced. | `npm run test -w @3fc/api`",
      ].join("\n"),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Invalid access fails closed.",
      rollbackApproach: "Revert the change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /invariant impact rows/);
  assert.deepEqual(result.packet.affectedInvariantRows, []);
});

test("invariant impact rows require a delimiter matching the header width", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: [
        "Notes | context",
        "--- | --- | --- | ---",
        "INV-002 | Changes protected writes. | ACL remains enforced. | `npm run test -w @3fc/api`",
      ].join("\n"),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Invalid access fails closed.",
      rollbackApproach: "Revert the change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /invariant impact rows/);
  assert.deepEqual(result.packet.affectedInvariantRows, []);
});

test("invariant impact rows must be contiguous table rows", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: [
        "Invariant | How this PR affects it | Why it remains valid | Evidence",
        "--- | --- | --- | ---",
        "ordinary prose terminates the table",
        "INV-002 | Changes protected writes. | ACL remains enforced. | `npm run test -w @3fc/api`",
      ].join("\n"),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Invalid access fails closed.",
      rollbackApproach: "Revert the change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /invariant impact rows/);
  assert.deepEqual(result.packet.affectedInvariantRows, []);
});

test("invariant impact rows reject multiple invariant IDs in one row", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: invariantTable(
        "INV-002, INV-003",
        "Changes protected idempotent writes.",
        "ACL and idempotency remain enforced.",
        "`npm run test -w @3fc/api`",
      ),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Invalid writes fail closed.",
      rollbackApproach: "Revert the change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /Affected invariant rows require/);
  assert.equal(result.packet.affectedInvariantRows[0].invariant, "INV-002, INV-003");
  assert.deepEqual(result.packet.affectedInvariantRows[0].invariantIds, ["INV-002", "INV-003"]);
});

test("invariant impact rows parse every table in the section", () => {
  const result = evaluateReview(policy, highRiskState({
    body: packet({
      risk: "high",
      architecture: "documented",
      invariants: [
        "| Invariant | How this PR affects it | Why it remains valid | Evidence |",
        "| --- | --- | --- | --- |",
        "| INV-002 | Changes protected writes. | ACL remains enforced. | `npm run test:review-gate` |",
        "",
        "| Invariant | How this PR affects it | Why it remains valid | Evidence |",
        "| --- | --- | --- | --- |",
        "| INV-003 | Changes idempotent write handling. |  |  |",
      ].join("\n"),
      architectureRecord: "docs/architecture/invariants.md",
      failureBehaviour: "Invalid writes fail closed.",
      rollbackApproach: "Revert the change.",
      rollbackEvidence: "No migration is required.",
    }),
  }));
  assert.equal(result.state, "blocked");
  assert.match(result.blockers.join("\n"), /Affected invariant rows require/);
  assert.deepEqual(result.packet.affectedInvariantRows, [
    {
      invariant: "INV-002",
      invariantIds: ["INV-002"],
      affected: "Changes protected writes.",
      valid: "ACL remains enforced.",
      evidence: "`npm run test:review-gate`",
    },
    {
      invariant: "INV-003",
      invariantIds: ["INV-003"],
      affected: "Changes idempotent write handling.",
      valid: "",
      evidence: "",
    },
  ]);
});

test("packet parser rejects placeholder declared risk", () => {
  const parsed = parseReviewPacket(
    packet().replace(
      "- Declared risk: `low`",
      "- Declared risk: `choose: low | medium | high`",
    ),
  );
  assert.equal(parsed.declaredRisk, null);
});

test("unchanged pull request template reports every required author choice", async () => {
  const template = await readFile(
    new URL("../../../.github/pull_request_template.md", import.meta.url),
    "utf8",
  );
  const parsed = parseReviewPacket(template);
  assert.equal(parsed.claim, "");
  assert.equal(parsed.scopeIncluded, "");
  assert.equal(parsed.scopeExcluded, "");
  assert.match(parsed.errors.join("\n"), /Declared risk/);
  assert.match(parsed.errors.join("\n"), /change type/);
  assert.match(parsed.errors.join("\n"), /architecture disposition/);
  assert.match(parsed.errors.join("\n"), /human-judgement disposition/);
});

test("packet parser requires stable machine-readable dispositions", () => {
  const parsed = parseReviewPacket(
    packet().replace(
      "- [x] `human-judgement:none`",
      "- [ ] `human-judgement:none`",
    ),
  );
  assert.match(parsed.errors.join("\n"), /exactly one human-judgement/);
});

test("architecture-sensitive change types trigger without a matching path", () => {
  const result = evaluateReview(policy, highRiskState({
    changedFiles: ["notes.txt"],
    body: packet({
      risk: "high",
      changeTypes: ["permission-trust-boundary"],
      architecture: "none",
      invariants: "None",
      failureBehaviour: "The operation fails closed.",
      rollbackApproach: "Revert the change.",
      rollbackEvidence: "A revert procedure was reviewed.",
    }),
  }));
  assert.deepEqual(
    result.architectureChangeTypes,
    ["permission-trust-boundary"],
  );
  assert.match(result.blockers.join("\n"), /paths or change types/);
});

test("glob matching supports repository policy patterns", () => {
  assert.equal(globMatches("api/src/auth/acl.ts", "api/src/auth/**"), true);
  assert.equal(globMatches("docs/spec.md", "**/*.md"), true);
  assert.equal(globMatches("serverless.api-core.yml", "serverless.*.yml"), true);
  assert.equal(globMatches("api/src/index.ts", "app/**"), false);
});

test("summary explains risk, evidence, review state, and actions", () => {
  const result = evaluateReview(policy, state({ body: packet({ claim: "" }) }));
  const summary = renderSummary(result, "head-123");
  assert.match(summary, /### Risk/);
  assert.match(summary, /### Current-head evidence/);
  assert.match(summary, /### Review state/);
  assert.match(summary, /### Exact unblock actions/);
  assert.match(summary, /Observe mode/);
});
