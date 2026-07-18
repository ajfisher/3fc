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
    .filter((review) => {
      const login = (review.login ?? review.user?.login ?? "").toLowerCase();
      const state = (review.state ?? "").toUpperCase();
      return reviewerSet.has(login) && !["DISMISSED", "PENDING"].includes(state);
    })
    .sort((left, right) => (right.submittedAt ?? right.submitted_at ?? "").localeCompare(left.submittedAt ?? left.submitted_at ?? ""));

  if (codexReviews.length > 0) {
    const current = codexReviews.find(
      (review) => (review.commitId ?? review.commit_id) === headSha,
    );
    if (current) {
      return { state: "current", reviewedSha: headSha };
    }
    const verified = codexReviews.find(
      (review) => review.commitId ?? review.commit_id,
    );
    if (verified) {
      return {
        state: "stale",
        reviewedSha: verified.commitId ?? verified.commit_id,
      };
    }
    return { state: "unknown", reviewedSha: null };
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
  return [
    "architecture:none",
    "architecture:documented",
    "architecture:judgement-required",
  ].includes(packet.architecture)
    ? packet.architecture
    : "architecture:none";
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

  packetBlockers.push(...packet.errors);
  if (!packet.claim) {
    packetBlockers.push("Behavioural claim is required.");
  }
  if (!packet.scopeIncluded || !packet.scopeExcluded) {
    packetBlockers.push("Scope boundaries require both Included and Excluded content.");
  }
  if (packet.architecture === "architecture:documented" && !packet.architectureRecord) {
    packetBlockers.push("Documented architecture impact requires an architecture or decision-record reference.");
  }
  if (
    packet.architecture === "architecture:judgement-required"
    && packet.humanJudgement === "human-judgement:none"
  ) {
    packetBlockers.push("Architecture judgement cannot be requested while human judgement is marked unnecessary.");
  }
  if (requirements.acceptance_evidence === "required" && !packet.hasAcceptanceEvidence) {
    packetBlockers.push(`${effectiveRisk} risk requires at least one acceptance criterion with evidence and result PASS.`);
  }
  if (
    requirements.acceptance_evidence === "required"
    && packet.acceptanceRows.some((row) => row.result === "FAIL")
  ) {
    packetBlockers.push("Acceptance evidence contains a FAIL result.");
  }
  if (
    requirements.acceptance_evidence === "required"
    && packet.acceptanceRows.some((row) => row.result === "PENDING")
  ) {
    packetBlockers.push("Acceptance evidence contains a PENDING result.");
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
    && !/^(none\.?|INV-\d{3}(?:[\s,;]+INV-\d{3})*)$/i.test(packet.affectedInvariants)
  ) {
    packetBlockers.push(`${effectiveRisk} risk requires invariant identifiers or explicit none.`);
  }
  if (
    packet.rejectedFindings
    && !/(evidence|https?:\/\/|`[^`]+`|#[0-9]+)/i.test(packet.rejectedFindings)
  ) {
    packetBlockers.push("Rejected automated findings require supporting evidence.");
  }
  if (
    packet.humanJudgementRequested
    && (
      !packet.judgementDecision
      || !packet.judgementOptions
      || !packet.judgementReason
      || !packet.reversalCost
    )
  ) {
    packetBlockers.push("Requested human judgement requires a decision, options, reason, and reversal cost.");
  }
  if (
    packet.humanJudgement === "human-judgement:none"
    && (
      packet.judgementDecision
      || packet.judgementOptions
      || packet.judgementReason
      || packet.reversalCost
    )
  ) {
    packetBlockers.push("human-judgement:none contradicts the recorded judgement fields.");
  }

  const architecturePaths = input.changedFiles.filter((path) =>
    policy.architecture_triggers.paths.some((glob) => globMatches(path, glob)));
  const architectureChangeTypes = packet.changeTypes.filter((type) =>
    policy.architecture_triggers.change_types.includes(type));
  if (
    (architecturePaths.length > 0 || architectureChangeTypes.length > 0)
    && packet.architecture === "architecture:none"
  ) {
    packetBlockers.push("Architecture-sensitive paths or change types require documentation or explicit human architecture judgement.");
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
    architectureChangeTypes,
  };
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
