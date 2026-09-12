import assert from "node:assert/strict";
import test from "node:test";
import { migrationArguments, verifyMigrationProvenance } from "../player-identity-migrate.mjs";

test("migration CLI requires explicit profile, reviewed write pause and bounded page count", () => {
  const common = ["--manifest", "migration.json", "--deployment-manifest", "deployment.json", "--profile", "3fc-agent"];
  assert.equal(migrationArguments(["status", ...common]).command, "status");
  assert.throws(() => migrationArguments(["begin", ...common]), /reviewed-write-pause/);
  assert.equal(migrationArguments(["step", ...common, "--apply", "reviewed-write-pause", "--pages", "3"]).pages, 3);
  for (const args of [[], ["status"], ["status", ...common, "--profile", "other"], ["status", ...common, "--unknown", "yes"],
    ["status", ...common, "--pages", "2"], ["step", ...common, "--apply", "reviewed-write-pause", "--pages", "101"]]) {
    assert.throws(() => migrationArguments(args));
  }
});

function provenance() {
  const hash = `${"A".repeat(43)}=`, sha = "a".repeat(40);
  return { manifest: { writerSha: sha, accountId: "123456789012", region: "ap-southeast-2", tableName: "3fc-qa-app",
    tableArn: "arn:aws:dynamodb:ap-southeast-2:123456789012:table/3fc-qa-app", drainedAt: "2026-09-11T00:16:00Z" },
  deployment: { env: "qa", service: "api-core", gitCommit: sha, region: "ap-southeast-2", packageCodeSha256: hash,
    functionFingerprint: { functionName: "3fc-qa-api-core", codeSha256: hash, revisionId: "revision", playerClaimMode: "proof" } },
  caller: { Account: "123456789012" },
  table: { TableArn: "arn:aws:dynamodb:ap-southeast-2:123456789012:table/3fc-qa-app", TableName: "3fc-qa-app", TableStatus: "ACTIVE" },
  live: { functionName: "3fc-qa-api-core", codeSha256: hash, revisionId: "revision", state: "Active", lastUpdateStatus: "Successful",
    tableName: "3fc-qa-app", claimMode: "proof", lastModified: "2026-09-11T00:00:00Z", timeout: 30 },
  now: Date.parse("2026-09-11T00:17:00Z") };
}

test("migration CLI pins caller, live table, exact deployment and completed old-writer drain", () => {
  verifyMigrationProvenance(provenance());
  for (const [part, key, value] of [["caller", "Account", "other"], ["table", "TableArn", "other"], ["table", "TableStatus", "UPDATING"],
    ["live", "revisionId", "changed"], ["live", "codeSha256", "changed"], ["live", "state", "Pending"], ["live", "tableName", "other"],
    ["live", "claimMode", "legacy"], ["deployment", "gitCommit", "b".repeat(40)], ["deployment", "env", "prod"],
    ["manifest", "drainedAt", "2026-09-11T00:00:20Z"], ["manifest", "drainedAt", "2026-09-12T00:00:00Z"],
    ["manifest", "drainedAt", "invalid"], ["live", "timeout", "30"]]) {
    const input = provenance(); input[part][key] = value;
    assert.throws(() => verifyMigrationProvenance(input), `${part}.${key}`);
  }
});

test("migration CLI permits only a pinned disposable QA function with its own matching table", () => {
  const input = provenance();
  input.live.functionName = "3fc-qa-player-directory-disposable-123";
  input.deployment.functionFingerprint.functionName = input.live.functionName;
  input.manifest.tableName = `${input.live.functionName}-app`;
  input.manifest.tableArn = `arn:aws:dynamodb:ap-southeast-2:123456789012:table/${input.manifest.tableName}`;
  input.table.TableArn = input.manifest.tableArn; input.table.TableName = input.manifest.tableName;
  input.live.tableName = input.manifest.tableName;
  assert.deepEqual(verifyMigrationProvenance(input), { isolated: true });
  input.live.tableName = "3fc-qa-app";
  assert.throws(() => verifyMigrationProvenance(input), /fingerprint/);
});
