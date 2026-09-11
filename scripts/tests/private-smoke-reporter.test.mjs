import assert from "node:assert/strict";
import test from "node:test";
import PrivateSmokeReporter from "../local/private-smoke-reporter.mjs";

test("private browser reporter excludes bearer URLs, messages and attachments", () => {
  const lines = [], original = console.log;
  console.log = value => lines.push(value);
  try {
    const reporter = new PrivateSmokeReporter();
    const fixture = { title: "not exported", location: { file: "/repo/tests/e2e/m2-smoke.spec.ts", line: 922 } };
    reporter.onTestBegin(fixture);
    reporter.onTestEnd(fixture, { status: "failed", errors: [{ message: "https://local/auth/callback?token=private-secret",
      stack: "Error: token=private-secret\n at /repo/tests/e2e/m2-smoke.spec.ts:950:12" }],
      attachments: [{ body: "private-secret" }], stdout: ["private-secret"] });
    reporter.onError({ message: "private-secret" }); reporter.onEnd({ status: "failed" });
  } finally { console.log = original; }
  assert.equal(lines.join("\n").includes("private-secret"), false);
  assert.equal(lines.join("\n").includes("not exported"), false);
  assert.deepEqual(lines.map(line => JSON.parse(line).event), ["start", "end", "failure", "error", "run"]);
  assert.deepEqual(JSON.parse(lines[2]).frames, ["tests/e2e/m2-smoke.spec.ts:950:12"]);
});
