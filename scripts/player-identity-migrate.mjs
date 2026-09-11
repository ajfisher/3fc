#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";

export function migrationArguments(args) {
  const command = args[0];
  if (!["status", "begin", "step", "activate", "restart-blocked"].includes(command)) throw new Error("Choose status, begin, step, activate or restart-blocked.");
  const options = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    if (!["--manifest", "--deployment-manifest", "--profile", "--apply", "--pages"].includes(key) || Object.hasOwn(options, key) || !args[index + 1]) {
      throw new Error("Unknown, duplicate or incomplete migration option.");
    }
    options[key] = args[index + 1];
  }
  for (const key of ["--manifest", "--deployment-manifest", "--profile"]) if (!options[key]) throw new Error(`${key} is required.`);
  if (!/^[a-zA-Z0-9_.-]+$/.test(options["--profile"])) throw new Error("Choose an explicit AWS profile.");
  if (command !== "status" && options["--apply"] !== "reviewed-write-pause") throw new Error("Writes require --apply reviewed-write-pause after reviewing the manifest and cutover runbook.");
  const pages = options["--pages"] === undefined ? 1 : Number(options["--pages"]);
  if (!Number.isInteger(pages) || pages < 1 || pages > 100 || (command !== "step" && options["--pages"] !== undefined)) throw new Error("Only step accepts --pages, from 1 to 100.");
  return { command, options, pages };
}

export function verifyMigrationProvenance({ manifest, deployment, caller, table, live, now }) {
  const isolated = deployment.env === "qa" && /^3fc-qa-player-directory-[a-z0-9-]{8,60}$/.test(live.functionName ?? "") &&
    manifest.tableName === `${live.functionName}-app`;
  if (!["qa", "prod"].includes(deployment.env) || deployment.service !== "api-core" || deployment.gitCommit !== manifest.writerSha ||
      deployment.region !== manifest.region || caller.Account !== manifest.accountId || table.TableArn !== manifest.tableArn ||
      table.TableName !== manifest.tableName || table.TableStatus !== "ACTIVE" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(deployment.packageCodeSha256 ?? "") ||
      !deployment.functionFingerprint?.revisionId || deployment.functionFingerprint.codeSha256 !== deployment.packageCodeSha256 ||
      (!isolated && live.functionName !== `3fc-${deployment.env}-api-core`) || live.functionName !== deployment.functionFingerprint.functionName ||
      live.codeSha256 !== deployment.packageCodeSha256 || live.revisionId !== deployment.functionFingerprint.revisionId ||
      live.state !== "Active" || live.lastUpdateStatus !== "Successful" || live.tableName !== manifest.tableName ||
      !["proof", "disabled"].includes(live.claimMode) || live.claimMode !== deployment.functionFingerprint.playerClaimMode) {
    throw new Error("Account, table or current API fingerprint does not match the reviewed migration manifest.");
  }
  // The newly deployed timeout does not bound an older invocation. Use Lambda's
  // maximum invocation duration, not an unverified former configuration.
  const drainBoundary = Date.parse(live.lastModified) + 905_000;
  if (!Number.isInteger(live.timeout) || live.timeout < 1 || live.timeout > 900 || !Number.isFinite(drainBoundary) ||
      Date.parse(manifest.drainedAt) < drainBoundary || Date.parse(manifest.drainedAt) > now || !Number.isFinite(Date.parse(manifest.drainedAt))) {
    throw new Error("Record a completed old-writer drain after the current deployment's maximum invocation duration.");
  }
  return { isolated };
}

async function main(args) {
  const { command, options, pages } = migrationArguments(args);
  const manifest = JSON.parse(await readFile(options["--manifest"], "utf8"));
  const deployment = JSON.parse(await readFile(options["--deployment-manifest"], "utf8"));
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (!/^[a-f0-9]{40}$/.test(manifest.writerSha ?? "") || resolve(process.cwd()) !== root ||
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== manifest.writerSha ||
      execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim()) {
    throw new Error("Run from a clean repository checkout at the exact reviewed writer SHA.");
  }
  // Do not trust stale/dirty dist output. The owned resource guard must encompass
  // this fresh build as well as the migration process. No incremental cache is
  // accepted as evidence that the executable matches the reviewed sources.
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--build", "api/tsconfig.json", "--force"],
    { stdio: "pipe", timeout: 120_000 });
  const { PlayerIdentityMigration } = await import("../api/dist/data/player-identity-migration.js");
  // Validate the full manifest before using any of its values in AWS commands.
  new PlayerIdentityMigration({ async send() { throw new Error("Validation only"); } }, manifest);
  const aws = (...parameters) => JSON.parse(execFileSync("aws", [...parameters, "--profile", options["--profile"],
    "--region", manifest.region, "--output", "json"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }));
  process.env.AWS_PROFILE = options["--profile"];
  const client = new DynamoDBClient({ region: manifest.region });
  try {
    const caller = aws("sts", "get-caller-identity");
    const readLive = () => aws("lambda", "get-function-configuration", "--function-name", deployment.functionFingerprint?.functionName ?? "invalid", "--query",
      "{functionName:FunctionName,codeSha256:CodeSha256,revisionId:RevisionId,state:State,lastUpdateStatus:LastUpdateStatus,lastModified:LastModified,timeout:Timeout,tableName:Environment.Variables.DYNAMODB_TABLE,claimMode:Environment.Variables.PLAYER_CLAIM_MODE}");
    const { Table: table } = await client.send(new DescribeTableCommand({ TableName: manifest.tableName }));
    const verifyLive = () => verifyMigrationProvenance({ manifest, deployment, caller, table: table ?? {}, live: readLive(), now: Date.now() });
    const { isolated } = verifyLive();
    if (!isolated && command !== "status") {
      const gh = (...parameters) => JSON.parse(execFileSync("gh", parameters, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }));
      const workflow = `repos/ajfisher/3fc/actions/workflows/deploy-${deployment.env}.yml`;
      if (gh("api", workflow).state !== "disabled_manually") throw new Error("Disable the target deployment workflow for the approved cutover window first.");
      for (const state of ["queued", "in_progress", "waiting", "pending", "requested"]) {
        if (gh("api", `${workflow}/runs?status=${state}&per_page=1`).total_count !== 0) throw new Error("Drain all pending target deployment runs before migration.");
      }
    }
    const runner = new PlayerIdentityMigration(client, manifest);
    if (command !== "status") verifyLive();
    let audit;
    if (command === "status") audit = await runner.status();
    else if (command === "begin") audit = await runner.begin();
    else if (command === "activate") audit = await runner.activate();
    else if (command === "restart-blocked") audit = await runner.restartBlocked();
    else for (let page = 0; page < pages; page += 1) {
      verifyLive();
      audit = await runner.step();
      if (!["inventory", "verification"].includes(audit.phase)) break;
    }
    // No source values, bearer material or private account identifiers in CLI
    // evidence. Investigation reads the bounded audit in the verified table.
    process.stdout.write(`${JSON.stringify({ migrationId: manifest.migrationId, phase: audit?.phase ?? "not-started",
      inventory: audit?.inventory, verification: audit?.verification, issueCount: audit?.issueCount ?? 0,
      morePages: Boolean(audit?.cursor) })}\n`);
    if (audit?.phase === "blocked") process.exitCode = 2;
  } finally { client.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    // Child-process stderr and SDK request objects can contain operator details.
    // Do not dump them or a full error object into captured evidence.
    process.stderr.write(`${error instanceof Error && !Object.hasOwn(error, "stderr") ? error.message : "Migration provenance check failed."}\n`);
    process.exitCode = 1;
  });
}
