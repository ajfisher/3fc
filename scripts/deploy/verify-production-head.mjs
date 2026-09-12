// No AWS calls or credentials: reject stale/foreign production dispatches.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function verifyProductionHead({ event, ref, eventSha, expectedSha, checkoutSha, remoteMain }) {
  const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
  if (!["push", "workflow_dispatch"].includes(event) || ref !== "refs/heads/main" ||
      !sha(eventSha) || checkoutSha !== eventSha || remoteMain !== eventSha ||
      (event === "workflow_dispatch" && (!sha(expectedSha) || expectedSha !== eventSha))) {
    throw new Error("Production release must use the approved, current main SHA. Start a fresh authorised run.");
  }
}

export function main(env = process.env) {
  const git = args => execFileSync("git", args, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const checkoutSha = git(["rev-parse", "HEAD"]);
  const remote = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
  const match = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(remote);
  verifyProductionHead({ event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, eventSha: env.GITHUB_SHA,
    expectedSha: env.EXPECTED_SHA, checkoutSha, remoteMain: match?.[1] });
  console.log("[deploy] Approved current main checkout verified.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch {
    // Do not echo arbitrary dispatch input or git stderr/authentication details.
    console.error("[deploy] Production head verification failed; no deployment is authorised by this check.");
    process.exitCode = 1;
  }
}
