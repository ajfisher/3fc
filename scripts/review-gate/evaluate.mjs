import { riskTiers, validatePolicy } from "./policy.mjs";
import { parseReviewPacket } from "./packet.mjs";

const RISK_INDEX = new Map(riskTiers.map((tier, index) => [tier, index]));
const FAILURE_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

function unique(values) {
  return [...new Set(values)];
}

function maxRisk(...tiers) {
  return tiers.filter(Boolean).sort((left, right) => RISK_INDEX.get(right) - RISK_INDEX.get(left))[0] ?? "low";
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globMatches(path, glob) {
  let expression = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        const followedBySlash = glob[index + 2] === "/";
        expression += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`^${expression}$`).test(path);
}

function derivePathRisk(policy, changedFiles) {
  let risk = "low";
  const reasons = [];
  for (const path of changedFiles) {
    let fileRisk = "low";
    for (const tier of [...riskTiers].reverse()) {
      if (policy.risk[tier].paths.some((glob) => globMatches(path, glob))) {
        fileRisk = tier;
        break;
      }
    }
    if (RISK_INDEX.get(fileRisk) > RISK_INDEX.get(risk)) {
      risk = fileRisk;
    }
    if (fileRisk !== "low") {
      reasons.push(`${fileRisk} path: ${path}`);
    }
  }
  return { risk, reasons };
}

function deriveChangeTypeRisk(policy, changeTypes) {
  let risk = "low";
  const reasons = [];
  for (const changeType of changeTypes) {
    for (const tier of [...riskTiers].reverse()) {
      if (policy.risk[tier].change_types.includes(changeType)) {
        if (RISK_INDEX.get(tier) > RISK_INDEX.get(risk)) {
          risk = tier;
        }
        reasons.push(`${tier} change type: ${changeType}`);
        break;
      }
    }
  }
  return { risk, reasons };
}

function normalizeCheck(check) {
  return {
    name: check.name,
    status: (check.status ?? "").toLowerCase(),
    conclusion: check.conclusion ? check.conclusion.toLowerCase() : null,
    completedAt: check.completedAt ?? check.completed_at ?? "",
  };
}

function findLatestCheck(checkRuns, name) {
  return checkRuns
    .map(normalizeCheck)
    .filter((check) => check.name === name && check.name !== "review-gate")
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0] ?? null;
}

function evaluateCheckGroups(policy, requirements, input, blockers, pending) {
  const groups = [];
  for (const [groupName, groupPolicy] of Object.entries(policy.checks)) {
    const required = requirements[groupName] === "required";
    const group = { name: groupName, required, checks: [] };
    const triggerMissing = required
      && groupPolicy.trigger_label
      && !input.labels.includes(groupPolicy.trigger_label);

    if (triggerMissing) {
      blockers.push(`Required ${groupName.toUpperCase()} evidence is missing; apply the ${groupPolicy.trigger_label} label.`);
    }

    for (const checkName of groupPolicy.required_check_names) {
      const check = findLatestCheck(input.checkRuns, checkName);
      let state = "missing";
      if (check?.status !== "completed") {
        state = check ? "pending" : "missing";
      } else if (check.conclusion === "success") {
        state = "pass";
      } else if (FAILURE_CONCLUSIONS.has(check.conclusion) || ["neutral", "skipped"].includes(check.conclusion)) {
        state = "fail";
      } else {
        state = "pending";
      }
      group.checks.push({ name: checkName, state, conclusion: check?.conclusion ?? null });
      if (!required || triggerMissing) {
        continue;
      }
      if (state === "fail") {
        blockers.push(`Required check ${checkName} did not pass.`);
      } else if (state !== "pass") {
        pending.push(`Required check ${checkName} has not completed successfully.`);
      }
    }
    groups.push(group);
  }
  return groups;
}

export function classifyCodexReview(reviews, codexActivity, headSha, reviewerLogins) {
  const reviewerSet = new Set(reviewerLogins.map((login) => login.toLowerCase()));
  const codexReviews = reviews
    .filter((review) => reviewerSet.has((review.login ?? review.user?.login ?? "").toLowerCase()))
    .sort((left, right) => (right.submittedAt ?? right.submitted_at ?? "").localeCompare(left.submittedAt ?? left.submitted_at ?? ""));

  if (codexReviews.length > 0) {
    const latest = codexReviews[0];
    const reviewedSha = latest.commitId ?? latest.commit_id ?? null;
    if (!reviewedSha) {
      return { state: "unknown", reviewedSha: null };
    }
    return {
      state: reviewedSha === headSha ? "current" : "stale",
      reviewedSha,
    };
  }

  const hasActivity = codexActivity.some((activity) =>
    reviewerSet.has((activity.login ?? activity.user?.login ?? "").toLowerCase()));
  return { state: hasActivity ? "unknown" : "missing", reviewedSha: null };
}

export function countValidApprovals(reviews, codexLogins) {
  const ignored = new Set(codexLogins.map((login) => login.toLowerCase()));
  const latestByReviewer = new Map();
  for (const review of reviews) {
    const login = (review.login ?? review.user?.login ?? "").toLowerCase();
    if (!login || ignored.has(login) || login.endsWith("[bot]")) {
      continue;
    }
    const submittedAt = review.submittedAt ?? review.submitted_at ?? "";
    const current = latestByReviewer.get(login);
    if (!current || submittedAt >= current.submittedAt) {
      latestByReviewer.set(login, {
        state: (review.state ?? "").toUpperCase(),
        submittedAt,
      });
    }
  }
  return [...latestByReviewer.values()].filter((review) => review.state === "APPROVED").length;
}

function determineReviewLabel({ draft, packetBlockers, blockers, pending, judgementRequested, approvalShortfall }) {
  if (draft) {
    return "review:automated";
  }
  if (packetBlockers.length > 0) {
    return "review:awaiting-evidence";
  }
  if (pending.length > 0) {
    return "review:automated";
  }
  const nonApprovalBlockers = blockers.filter((blocker) => !/^Human approvals:/.test(blocker));
  if (nonApprovalBlockers.length > 0) {
    return "review:blocked";
  }
  if (judgementRequested) {
    return "review:awaiting-judgement";
  }
  if (approvalShortfall) {
    return "review:awaiting-human";
  }
  return "review:ready";
}

function architectureLabel(packet) {
  if (packet.architecture === "documented") {
    return "architecture:documented";
  }
  if (packet.architecture === "judgement-required") {
    return "architecture:judgement-required";
  }
  return "architecture:none";
}

function configurationError(error, mode = "observe") {
  return {
    state: "configuration-error",
    conclusion: mode === "observe" ? "neutral" : "failure",
    blockers: [error.message],
    pending: [],
    actions: ["Correct the base-branch review policy and rerun review-gate."],
    labels: [],
  };
}

export function evaluateReview(rawPolicy, rawInput) {
  let policy;
  try {
    policy = validatePolicy(rawPolicy);
  } catch (error) {
    return configurationError(error, rawPolicy?.mode);
  }

  const input = {
    body: "",
    changedFiles: [],
    checkRuns: [],
    reviews: [],
    codexActivity: [],
    reviewThreads: [],
    labels: [],
    draft: false,
    headSha: "",
    ...rawInput,
  };
  const packet = parseReviewPacket(input.body);
  const pathRisk = derivePathRisk(policy, input.changedFiles);
  const changeTypeRisk = deriveChangeTypeRisk(policy, packet.changeTypes);
  const declaredRisk = packet.declaredRisk ?? "low";
  const effectiveRisk = maxRisk(declaredRisk, pathRisk.risk, changeTypeRisk.risk);
  const requirements = policy.risk[effectiveRisk].requirements;
  const blockers = [];
  const packetBlockers = [];
  const pending = [];
  const actions = [];

  if (packet.version !== 1) {
    packetBlockers.push("Review packet version marker is missing or unsupported.");
  }
  if (!packet.claim) {
    packetBlockers.push("Behavioural claim is required.");
  }
  if (!packet.declaredRisk) {
    packetBlockers.push("Declared risk must be exactly low, medium, or high.");
  }
  if (packet.invalidChangeTypeSelection) {
    packetBlockers.push("None of the above cannot be selected with another change type.");
  }
  if (packet.architectureSelections.length !== 1) {
    packetBlockers.push("Select exactly one architecture-impact option.");
  }
  if (packet.architecture === "documented" && !packet.architectureRecord) {
    packetBlockers.push("Documented architecture impact requires an architecture or decision-record reference.");
  }
  if (packet.architecture === "judgement-required" && packet.noJudgementRequested) {
    packetBlockers.push("Architecture judgement cannot be requested while human judgement is marked unnecessary.");
  }
  if (requirements.acceptance_evidence === "required" && !packet.hasAcceptanceEvidence) {
    packetBlockers.push(`${effectiveRisk} risk requires at least one acceptance criterion with evidence.`);
  }
  if (requirements.failure_evidence === "required" && !packet.failureBehaviour) {
    packetBlockers.push(`${effectiveRisk} risk requires failure behaviour.`);
  }
  if (requirements.rollback_evidence === "required" && !packet.rollbackApproach) {
    packetBlockers.push(`${effectiveRisk} risk requires a rollback approach.`);
  }
  if (requirements.rollback_evidence === "required" && !packet.rollbackEvidence) {
    packetBlockers.push(`${effectiveRisk} risk requires rollback evidence.`);
  }
  if (
    requirements.invariant_declaration === "required"
    && !/^(none|INV-\d{3}(?:[\s,;]+INV-\d{3})*)$/i.test(packet.affectedInvariants)
  ) {
    packetBlockers.push(`${effectiveRisk} risk requires invariant identifiers or explicit none.`);
  }
  if (packet.rejectedFindingsMissingEvidence.length > 0) {
    packetBlockers.push("Every rejected automated finding requires a reason and evidence.");
  }
  if (packet.humanJudgementRequested && (!packet.judgementDecision || !packet.reversalCost)) {
    packetBlockers.push("Requested human judgement requires a decision and reversal cost.");
  }

  const architecturePaths = input.changedFiles.filter((path) =>
    policy.architecture_triggers.some((glob) => globMatches(path, glob)));
  if (architecturePaths.length > 0 && packet.architecture === "none") {
    packetBlockers.push("Architecture-sensitive paths require documentation or explicit human architecture judgement.");
  }

  blockers.push(...packetBlockers);
  const checkGroups = evaluateCheckGroups(policy, requirements, input, blockers, pending);

  const codex = classifyCodexReview(
    input.reviews,
    input.codexActivity,
    input.headSha,
    policy.codex.reviewer_logins,
  );
  if (requirements.codex_review === "required" && codex.state !== "current") {
    blockers.push(`Codex review is ${codex.state}; a current-head review is required.`);
  }

  const unresolvedThreads = input.reviewThreads.filter((thread) =>
    !thread.isResolved && !thread.isOutdated).length;
  if (unresolvedThreads > requirements.unresolved_review_threads) {
    blockers.push(`${unresolvedThreads} unresolved, non-outdated review thread(s) remain.`);
  }
  if (packet.unresolvedBlockingFindings && !/^(none|n\/a)$/i.test(packet.unresolvedBlockingFindings)) {
    blockers.push("The review packet declares unresolved blocking findings.");
  }

  const approvals = countValidApprovals(input.reviews, policy.codex.reviewer_logins);
  const approvalShortfall = approvals < requirements.human_approvals;
  if (approvalShortfall) {
    blockers.push(`Human approvals: ${approvals} / ${requirements.human_approvals}.`);
  }
  if (input.draft) {
    pending.push("Pull request is a draft.");
  }

  for (const message of packetBlockers) {
    actions.push(message);
  }
  for (const message of blockers.filter((message) => !packetBlockers.includes(message))) {
    actions.push(message);
  }
  for (const message of pending) {
    actions.push(message);
  }

  const state = blockers.length > 0 ? "blocked" : pending.length > 0 ? "pending" : "pass";
  const conclusion = policy.mode === "observe"
    ? state === "pass" ? "success" : "neutral"
    : state === "pass" ? "success" : state === "pending" ? null : "failure";
  const labels = [
    `risk:${effectiveRisk}`,
    determineReviewLabel({
      draft: input.draft,
      packetBlockers,
      blockers,
      pending,
      judgementRequested: packet.humanJudgementRequested && packet.judgementDecision && packet.reversalCost,
      approvalShortfall,
    }),
    architectureLabel(packet),
  ];

  return {
    state,
    conclusion,
    mode: policy.mode,
    risk: {
      declared: packet.declaredRisk,
      path: pathRisk.risk,
      changeType: changeTypeRisk.risk,
      effective: effectiveRisk,
      escalationReasons: unique([...pathRisk.reasons, ...changeTypeRisk.reasons]),
    },
    packet,
    requirements,
    checks: checkGroups,
    codex,
    unresolvedThreads,
    approvals,
    blockers: unique(blockers),
    packetBlockers: unique(packetBlockers),
    pending: unique(pending),
    actions: unique(actions),
    labels,
    architecturePaths,
  };
}

export function renderSummary(result, headSha) {
  if (result.state === "configuration-error") {
    return [
      `## Review gate: CONFIGURATION ERROR`,
      "",
      ...result.blockers.map((blocker) => `- ${blocker}`),
      "",
      "### To unblock",
      ...result.actions.map((action, index) => `${index + 1}. ${action}`),
    ].join("\n");
  }

  const lines = [
    `## Review gate: ${result.state.toUpperCase()} (${result.mode})`,
    "",
    "### Risk",
    "",
    `- Effective: **${result.risk.effective.toUpperCase()}**`,
    `- Declared: ${result.risk.declared?.toUpperCase() ?? "MISSING"}`,
    `- Path-derived: ${result.risk.path.toUpperCase()}`,
    `- Change-type-derived: ${result.risk.changeType.toUpperCase()}`,
  ];
  if (result.risk.escalationReasons.length > 0) {
    lines.push("- Escalation context:", ...result.risk.escalationReasons.map((reason) => `  - ${reason}`));
  }

  lines.push("", "### Evidence", "");
  for (const group of result.checks) {
    for (const check of group.checks) {
      lines.push(`- ${group.name.toUpperCase()} / ${check.name}: ${check.state.toUpperCase()}${group.required ? " (required)" : " (optional)"}`);
    }
  }
  lines.push(
    `- Codex review: ${result.codex.state.toUpperCase()}`,
    `- Reviewed SHA: ${result.codex.reviewedSha ?? "not available"}`,
    `- Current SHA: ${headSha || "not available"}`,
    `- Acceptance evidence: ${result.packet.hasAcceptanceEvidence ? "PRESENT" : "MISSING"}`,
    `- Rollback approach: ${result.packet.rollbackApproach ? "PRESENT" : "MISSING"}`,
    `- Rollback evidence: ${result.packet.rollbackEvidence ? "PRESENT" : "MISSING"}`,
  );

  lines.push(
    "",
    "### Review state",
    "",
    `- Unresolved threads: ${result.unresolvedThreads}`,
    `- Human approvals: ${result.approvals} / ${result.requirements.human_approvals}`,
    `- Architecture: ${result.packet.architecture ?? "INVALID"}`,
    `- Human judgement requested: ${result.packet.humanJudgementRequested ? "YES" : "NO"}`,
  );

  if (result.actions.length > 0) {
    lines.push("", "### To unblock", "", ...result.actions.map((action, index) => `${index + 1}. ${action}`));
  } else {
    lines.push("", "No deterministic blockers are present.");
  }
  if (result.mode === "observe") {
    lines.push("", "> Observe mode: non-passing states are reported with a neutral conclusion and are not authoritative merge decisions.");
  }
  return lines.join("\n");
}

export function desiredManagedLabels(policy, currentLabels, desiredLabels) {
  const managed = new Set(
    currentLabels.filter((label) =>
      policy.labels.managed_prefixes.some((prefix) => label.startsWith(prefix))),
  );
  return {
    remove: [...managed].filter((label) => !desiredLabels.includes(label)).sort(),
    add: desiredLabels.filter((label) => !currentLabels.includes(label)).sort(),
  };
}
