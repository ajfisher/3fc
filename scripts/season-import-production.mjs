#!/usr/bin/env node
// Operator-only production cutover. Nothing here pauses services, creates backups,
// resumes traffic or edits workflows. Those actions require a separately approved window.
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { buildPlan, decode, digest, inventoryDigest } from "./season-import-plan.mjs";
import { scan, privateFile, loadPrivate, sourceTable, productionTable, region, repositoryAcceptance } from "./season-import-rehearsal.mjs";
import { cutoverManifest, validateCutover, SeasonImportExecutor } from "./season-import-executor.mjs";

const need = (ok, reason) => { if (!ok) throw new Error(`Cutover: ${reason}`); };
const root = fileURLToPath(new URL("..", import.meta.url));
const run = (binary, args) => execFileSync(binary, args, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
const log = value => process.stdout.write(`${JSON.stringify(value)}\n`);
export function productionArguments(args) {
  const [command] = args, opt = {};
  need(["observe", "prepare", "apply"].includes(command), "choose observe, prepare or apply");
  const allowed = { observe: ["--config", "--out"], prepare: ["--config", "--out", "--observation"],
    apply: ["--config", "--out", "--manifest", "--approved-digest", "--apply"] }[command];
  for (let i = 1; i < args.length; i += 2) {
    need(allowed.includes(args[i]) && !Object.hasOwn(opt, args[i]) && args[i + 1], "invalid or duplicate option");
    opt[args[i]] = args[i + 1];
  }
  need(allowed.every(k => opt[k]), "missing required option");
  if (command === "apply") need(opt["--apply"] === "production-season-import" && /^[a-f0-9]{64}$/.test(opt["--approved-digest"]), "explicit production approval and exact digest required");
  return { command, opt };
}
export function verifyFreeze(observed, current, now) {
  need(digest(observed.live) === digest(current), "table or frozen writer changed; restart observation and plan");
  const start = Date.parse(observed.at);
  need(Number.isFinite(start) && now >= start + 905000, "a completed 905-second freeze observation is required");
}
export function verifyBackup(description, table, frozenAt) {
  const details = description.BackupDetails, source = description.SourceTableDetails;
  need(details?.BackupStatus === "AVAILABLE" && details.BackupType === "USER" && source?.TableArn === table.arn &&
    source.TableId === table.id && Date.parse(details.BackupCreationDateTime) >= Date.parse(frozenAt) + 905000 &&
    Date.parse(details.BackupCreationDateTime) <= Date.now(), "available on-demand backup of the exact table, taken after drain, required");
}
export function verifyWriter(f, deployment, env, accountId, tableName) {
  const expected = deployment.functionFingerprint, functionName = `3fc-${env}-api-core`;
  need(f.arn === `arn:aws:lambda:${region}:${accountId}:function:${functionName}` && f.name === functionName &&
    f.name === expected?.functionName && f.hash === deployment.packageCodeSha256 && f.hash === expected.codeSha256 &&
    f.revision === expected.revisionId && f.state === "Active" && f.update === "Successful" && f.table === tableName &&
    f.claim === "proof" && f.claim === expected.playerClaimMode && ["true", "false"].includes(f.returning) &&
    f.returning === expected.returningJoinEnabled && f.consolidation === expected.consolidationEnabled &&
    ["true", "false"].includes(f.consolidation) && (env !== "prod" || f.returning === "true"), "accepted deployed writer or player feature mismatch");
}
function cleanHead() {
  need(resolve(process.cwd()) === resolve(root) && !run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim(), "run from a clean repository checkout");
  return run("git", ["rev-parse", "HEAD"]).trim();
}
async function main(args) {
  const { command, opt } = productionArguments(args), config = await loadPrivate(opt["--config"]), toolSha = cleanHead();
  need(/^[\w.-]+$/.test(config.profile ?? "") && /^\d{12}$/.test(config.accountId ?? ""), "explicit AWS profile and account required");
  need(/^https:\/\/github\.com\/ajfisher\/3fc\/pull\/\d+$/.test(config.reviewedPlan ?? ""), "reviewed tooling PR required");
  need(config.exclusiveWriterFreeze === true, "operator must attest all manual, local, versioned and service writers are excluded");
  need(!Object.keys(process.env).some(k => k.startsWith("AWS_ENDPOINT_URL") && process.env[k]), "custom AWS endpoints unsupported");
  const deployments = { qa: await loadPrivate(config.qaDeployment), prod: await loadPrivate(config.prodDeployment) };
  const aws = (...a) => JSON.parse(run("aws", [...a, "--profile", config.profile, "--region", region, "--output", "json"]));
  const gh = path => JSON.parse(run("gh", ["api", path]));
  need(aws("sts", "get-caller-identity").Account === config.accountId, "AWS account mismatch");
  process.env.AWS_PROFILE = config.profile;
  const client = new DynamoDBClient({ region, maxAttempts: 2, requestHandler: { requestTimeout: 15000 } });
  const out = resolve(opt["--out"]); await mkdir(out, { mode: 0o700 });
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try {
    // Compile the same API sources as the accepted deployed artifacts. This PR
    // changes tooling only; differing runtime sources require a separate release.
    for (const env of ["qa", "prod"]) {
      const d = deployments[env];
      need(d.env === env && d.region === region && d.service === "api-core" && /^[a-f0-9]{40}$/.test(d.gitCommit ?? ""), "invalid accepted deployment manifest");
      run("git", ["diff", "--exit-code", d.gitCommit, "HEAD", "--", "api", "packages/contracts", "package-lock.json"]);
    }
    const readFreeze = async () => {
      need(!interrupted, "interrupted; retain freeze and resume the same manifest");
      const live = {};
      for (const env of ["qa", "prod"]) {
        const tableName = env === "qa" ? sourceTable : productionTable, functionName = `3fc-${env}-api-core`, d = deployments[env];
        const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
        need(Table?.TableStatus === "ACTIVE" && Table.TableArn === `arn:aws:dynamodb:${region}:${config.accountId}:table/${tableName}` && Table.TableId, "table provenance mismatch");
        const f = aws("lambda", "get-function-configuration", "--function-name", functionName, "--query",
          "{name:FunctionName,arn:FunctionArn,hash:CodeSha256,revision:RevisionId,state:State,update:LastUpdateStatus,modified:LastModified,table:Environment.Variables.DYNAMODB_TABLE,claim:Environment.Variables.PLAYER_CLAIM_MODE,returning:Environment.Variables.PLAYER_RETURNING_JOIN_ENABLED,consolidation:Environment.Variables.PLAYER_CONSOLIDATION_ENABLED}");
        verifyWriter(f, d, env, config.accountId, tableName);
        need(aws("lambda", "get-function-concurrency", "--function-name", functionName).ReservedConcurrentExecutions === 0, "both APIs must remain at reserved concurrency zero");
        need((aws("lambda", "list-aliases", "--function-name", functionName).Aliases ?? []).length === 0 &&
          (aws("lambda", "list-event-source-mappings", "--function-name", functionName).EventSourceMappings ?? []).length === 0, "unexpected alias or queued event source");
        const workflow = `repos/ajfisher/3fc/actions/workflows/deploy-${env}.yml`;
        need(gh(workflow).state === "disabled_manually", "both deployment workflows must be disabled");
        for (const state of ["queued", "in_progress", "waiting", "pending", "requested"]) need(gh(`${workflow}/runs?status=${state}&per_page=1`).total_count === 0, "deployment runs must be drained");
        live[env] = { table: { name: tableName, arn: Table.TableArn, id: Table.TableId }, function: f };
      }
      return live;
    };
    const live = await readFreeze();
    if (command === "observe") {
      await privateFile(`${out}/observation.json`, { at: new Date().toISOString(), live, toolSha });
      log({ stage: "freeze-observed", waitSeconds: 905 }); return;
    }
    const manifest = command === "apply" ? await loadPrivate(opt["--manifest"]) : undefined;
    if (manifest) {
      validateCutover(manifest);
      need(manifest.digest === opt["--approved-digest"] && manifest.provenance.toolSha === toolSha &&
        manifest.provenance.accountId === config.accountId && manifest.provenance.reviewedPlan === config.reviewedPlan &&
        manifest.provenance.scopeDigest === digest(config.scope), "approval, checkout, account or scope mismatch");
    }
    const observation = manifest?.provenance.observation ?? await loadPrivate(opt["--observation"]);
    need(observation.toolSha === toolSha, "tooling changed since freeze observation");
    verifyFreeze(observation, live, Date.now());
    const backups = manifest?.provenance.backups ?? config.backups;
    for (const env of ["qa", "prod"]) {
      need(typeof backups?.[env] === "string" && backups[env].startsWith(`${live[env].table.arn}/backup/`), "explicit source and destination backup ARNs required");
      verifyBackup(aws("dynamodb", "describe-backup", "--backup-arn", backups[env]).BackupDescription, live[env].table, observation.at);
    }
    const source = await scan(client, sourceTable, true);
    if (!manifest) {
      const plan = buildPlan(source, config.scope), baseline = await scan(client, productionTable);
      need(inventoryDigest(await scan(client, sourceTable, true)) === plan.sourceDigest, "source changed during capture");
      verifyFreeze(observation, await readFreeze(), Date.now());
      const prepared = cutoverManifest(plan, baseline, { toolSha, accountId: config.accountId, reviewedPlan: config.reviewedPlan,
        scopeDigest: digest(config.scope), observation, backups });
      await privateFile(`${out}/manifest.json`, prepared);
      log({ stage: "prepared-no-writes", digest: prepared.digest, summary: plan.summary }); return;
    }
    const codes = new Map(manifest.plan.items.filter(i => i.entityType.S === "game").map(i => { const d = decode(i); return [d.gameId, d.joinCode]; }));
    need(buildPlan(source, config.scope, { at: manifest.plan.at, nonce: manifest.plan.nonce, code: id => codes.get(id) }).planDigest === manifest.plan.planDigest,
      "live source and config no longer reproduce approved plan");
    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--build", "api/tsconfig.json", "--force"], { stdio: "pipe", timeout: 120000 });
    const guard = async () => { verifyFreeze(observation, await readFreeze(), Date.now()); };
    const runner = new SeasonImportExecutor(client, productionTable, manifest, { scan: () => scan(client, productionTable), guard,
      progress: log, acceptance: async () => {
        need(inventoryDigest(await scan(client, sourceTable, true)) === manifest.plan.sourceDigest, "QA source changed during import");
        return repositoryAcceptance(client, productionTable, manifest.plan, () => interrupted);
      } });
    const report = await runner.run();
    await privateFile(`${out}/report.json`, { ...report, manifestDigest: manifest.digest, trafficStillPaused: true });
    log({ stage: "import-accepted-traffic-still-paused", ...report });
  } catch (error) {
    await privateFile(`${out}/failure.json`, { name: error.name, message: error.message });
    throw error;
  } finally { client.destroy(); process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message?.startsWith("Cutover:") ? error.message : "Cutover failed; inspect private evidence. Keep both APIs paused."}\n`);
    process.exitCode = 1;
  });
}
