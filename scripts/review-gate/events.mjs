const TRUSTED_REFRESH_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export async function resolvePullRequestNumbers(
  eventName,
  payload,
  manualInput,
  client,
) {
  if (eventName === "workflow_dispatch") {
    const value = manualInput ?? payload.inputs?.pr_number;
    const number = Number.parseInt(String(value ?? ""), 10);
    return Number.isInteger(number) && number > 0 ? [number] : [];
  }

  if (eventName === "workflow_run") {
    const direct = [...new Set(
      (payload.workflow_run?.pull_requests ?? [])
        .map((pullRequest) => pullRequest.number)
        .filter((number) => Number.isInteger(number) && number > 0),
    )];
    if (direct.length > 0 || !payload.workflow_run?.head_sha || !client) {
      return direct;
    }
    return client.getAssociatedPullRequestNumbers(payload.workflow_run.head_sha);
  }

  if (eventName === "issue_comment") {
    const isPullRequest = Boolean(payload.issue?.pull_request);
    const isRefresh = payload.comment?.body === "/review-gate refresh";
    const isTrusted = TRUSTED_REFRESH_ASSOCIATIONS.has(
      payload.comment?.author_association,
    );
    return isPullRequest
      && isRefresh
      && isTrusted
      && Number.isInteger(payload.issue?.number)
      ? [payload.issue.number]
      : [];
  }

  const number = payload.pull_request?.number ?? payload.number;
  return Number.isInteger(number) && number > 0 ? [number] : [];
}
