export function resolvePullRequestNumbers(eventName, payload, manualInput) {
  if (eventName === "workflow_dispatch") {
    const value = manualInput ?? payload.inputs?.pr_number;
    const number = Number.parseInt(String(value ?? ""), 10);
    return Number.isInteger(number) && number > 0 ? [number] : [];
  }

  if (eventName === "workflow_run") {
    return [...new Set(
      (payload.workflow_run?.pull_requests ?? [])
        .map((pullRequest) => pullRequest.number)
        .filter((number) => Number.isInteger(number) && number > 0),
    )];
  }

  if (eventName === "issue_comment") {
    const isPullRequest = Boolean(payload.issue?.pull_request);
    const isRefresh = (payload.comment?.body ?? "").trim() === "/review-gate refresh";
    return isPullRequest && isRefresh && Number.isInteger(payload.issue?.number)
      ? [payload.issue.number]
      : [];
  }

  const number = payload.pull_request?.number ?? payload.number;
  return Number.isInteger(number) && number > 0 ? [number] : [];
}
