function bullets(items, emptyMessage) {
  return items.length > 0
    ? items.map((item) => `- ${item}`)
    : [`- ${emptyMessage}`];
}

function invariantSummary(packet) {
  if (packet.affectedInvariantRows?.length > 0) {
    return packet.affectedInvariantRows.map((row) => row.invariant).join(" ");
  }
  return packet.affectedInvariants || "missing";
}

export function renderSummary(result, headSha) {
  if (result.state === "configuration-error") {
    return [
      "## Review gate: CONFIGURATION ERROR",
      "",
      "### Blocking findings",
      "",
      ...bullets(result.blockers, "Unknown configuration error."),
      "",
      "### Exact unblock actions",
      "",
      ...result.actions.map((action, index) => `${index + 1}. ${action}`),
      "",
      "> Observe mode: this configuration error is reported with a neutral conclusion.",
    ].join("\n");
  }

  const lines = [
    `## Review gate: ${result.state.toUpperCase()} (${result.mode})`,
    "",
    `Current head: \`${headSha || "not available"}\``,
    "",
    "### Risk",
    "",
    "| Source | Classification |",
    "| --- | --- |",
    `| Declared | ${result.risk.declared?.toUpperCase() ?? "MISSING"} |`,
    `| Changed paths | ${result.risk.path.toUpperCase()} |`,
    `| Change types | ${result.risk.changeType.toUpperCase()} |`,
    `| **Effective** | **${result.risk.effective.toUpperCase()}** |`,
    "",
    "Escalation reasons:",
    "",
    ...bullets(result.risk.escalationReasons, "None."),
    "",
    "### Current-head evidence",
    "",
    "| Signal | State | Policy |",
    "| --- | --- | --- |",
  ];

  for (const group of result.checks) {
    for (const check of group.checks) {
      lines.push(
        `| ${group.name.toUpperCase()} / \`${check.name}\` | ${check.state.toUpperCase()} | ${group.required ? "required" : "optional"} |`,
      );
    }
  }
  lines.push(
    `| Codex review | ${result.codex.state.toUpperCase()} | ${result.requirements.codex_review} |`,
    `| Acceptance evidence | ${result.packet.hasAcceptanceEvidence ? "PASS evidence present" : "missing"} | ${result.requirements.acceptance_evidence} |`,
    `| Rollback approach | ${result.packet.rollbackApproach ? "present" : "missing"} | ${result.requirements.rollback_evidence} |`,
    `| Rollback evidence | ${result.packet.rollbackEvidence ? "present" : "missing"} | ${result.requirements.rollback_evidence} |`,
    "",
    `Reviewed SHA: \`${result.codex.reviewedSha ?? "not available"}\``,
    "",
    "### Review state",
    "",
    "| Signal | State |",
    "| --- | --- |",
    `| Unresolved current threads | ${result.unresolvedThreads} |`,
    `| Human approvals | ${result.approvals} / ${result.requirements.human_approvals} |`,
    `| Architecture | ${result.packet.architecture ?? "invalid"} |`,
    `| Affected invariants | ${invariantSummary(result.packet)} |`,
    `| Human judgement | ${result.packet.humanJudgement ?? "invalid"} |`,
    "",
    "### Blocking findings",
    "",
    ...bullets(result.blockers, "None."),
    "",
    "### Pending evidence",
    "",
    ...bullets(result.pending, "None."),
    "",
    "### Exact unblock actions",
    "",
    ...(result.actions.length > 0
      ? result.actions.map((action, index) => `${index + 1}. ${action}`)
      : ["1. No action required."]),
  );

  if (result.mode === "observe") {
    lines.push(
      "",
      "> Observe mode: non-passing states use a neutral conclusion and are not authoritative merge decisions.",
    );
  }
  return lines.join("\n");
}
