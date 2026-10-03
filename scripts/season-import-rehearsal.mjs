#!/usr/bin/env node
// There is deliberately no production apply command or configurable write target.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DynamoDBClient, ScanCommand, DescribeTableCommand, CreateTableCommand, DeleteTableCommand,
  ListTagsOfResourceCommand, TransactWriteItemsCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { buildPlan, validatePlan, decode, key, inventoryDigest, excludedTypes, envelope } from "./season-import-plan.mjs";

export const sourceTable = "3fc-qa-app", productionTable = "3fc-prod-app", region = "ap-southeast-2";
export function assertDisposable(name) {
  if (!/^3fc-import-rehearsal-[a-f0-9-]{36}$/.test(name)) throw new Error("Only a newly owned disposable rehearsal table can be written.");
}
export function assertOwned(table, expected, tags) {
  assertDisposable(table.TableName);
  if (!expected.id || table.TableArn !== expected.arn || table.TableId !== expected.id || table.TableName !== expected.name ||
      !tags.some(t => t.Key === "RehearsalOwner" && t.Value === expected.owner)) throw new Error("Disposable table ownership changed; refusing cleanup.");
}
export async function scan(client, TableName, businessOnly = false) {
  const items = []; let ExclusiveStartKey, size = 0;
  const seen = new Set();
  do {
    const page = await client.send(new ScanCommand({ TableName, ConsistentRead: true, Limit: 250, ExclusiveStartKey,
      ...(businessOnly ? { FilterExpression: `attribute_exists(#type) AND NOT begins_with(pk, :auth) AND NOT (#type IN (${excludedTypes.map((_, i) => `:t${i}`).join(",")}))`,
        ExpressionAttributeNames: { "#type": "entityType" }, ExpressionAttributeValues: { ":auth": { S: "AUTH_" }, ...Object.fromEntries(excludedTypes.map((v, i) => [`:t${i}`, { S: v }])) } } : {}) }));
    for (const item of page.Items ?? []) { items.push(item); size += Buffer.byteLength(JSON.stringify(item)); }
    if (items.length > 10000 || size > 16 * 1024 * 1024) throw new Error("Inventory budget exceeded.");
    ExclusiveStartKey = page.LastEvaluatedKey;
    if (ExclusiveStartKey) {
      const cursor = JSON.stringify(ExclusiveStartKey);
      if (seen.has(cursor)) throw new Error("Repeated inventory cursor."); seen.add(cursor);
    }
  } while (ExclusiveStartKey);
  return items;
}
export function assertDestinationEmptyOfBusiness(items) {
  if (items.some(i => !((i.pk?.S === "PLAYER_IDENTITY" && i.sk?.S === "CONTROL" && i.entityType?.S === "playerIdentityControl") ||
    (i.pk?.S?.startsWith("PLAYER_MIGRATION#") && i.entityType?.S === "playerIdentityMigration")))) {
    throw new Error("Production contains business or unexpected records; revisit collision planning.");
  }
}
const aws = (profile, ...args) => JSON.parse(execFileSync("aws", [...args, "--profile", profile, "--region", region, "--output", "json"],
  { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }));
const log = (stage, more = {}) => process.stdout.write(`${JSON.stringify({ stage, ...more })}\n`);
async function privateFile(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); }
async function loadPrivate(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Private inputs must be regular files readable only by the operator.");
  return JSON.parse(await readFile(path, "utf8"));
}
function options(args) {
  const out = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!["--config", "--plan", "--out", "--apply"].includes(args[i]) || out[args[i]] || !args[i + 1]) throw new Error("Invalid or duplicate argument.");
    out[args[i]] = args[i + 1];
  }
  if (!["plan", "rehearse"].includes(args[0]) || !out["--config"] || !out["--out"]) throw new Error("Use plan or rehearse with --config and a new private --out directory.");
  if (args[0] === "rehearse" && (!out["--plan"] || out["--apply"] !== "disposable-table-only")) throw new Error("Rehearsal requires --plan and --apply disposable-table-only.");
  if (args[0] === "plan" && (out["--plan"] || out["--apply"])) throw new Error("Planning has no write flag.");
  return out;
}
async function waitFor(client, name, state, interrupted = () => false) {
  for (let i = 0; i < 60; i++) {
    if (interrupted()) throw new Error("Rehearsal interrupted.");
    try {
      const result = await client.send(new DescribeTableCommand({ TableName: name }));
      if (state !== "absent" && result.Table?.TableStatus === state) return result.Table;
    } catch (error) { if (error.name === "ResourceNotFoundException" && state === "absent") return; if (error.name !== "ResourceNotFoundException") throw error; }
    await delay(1000);
  }
  throw new Error(`Disposable table did not become ${state}.`);
}
export async function writeItems(client, name, items, progress = () => {}) {
  assertDisposable(name);
  for (let i = 0; i < items.length; i += 25) {
    await client.send(new TransactWriteItemsCommand({ TransactItems: items.slice(i, i + 25).map(Item => ({ Put: {
      TableName: name, Item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    } })) }));
    progress(Math.min(i + 25, items.length));
  }
}
export function readOnlyRepositoryClient(client, name) {
  assertDisposable(name);
  return { async send(command) {
    const allowed = ["GetItemCommand", "QueryCommand", "ScanCommand"].includes(command.constructor.name) && command.input.TableName === name;
    const batch = command.constructor.name === "BatchGetItemCommand" && command.input.RequestItems &&
      Object.keys(command.input.RequestItems).length === 1 && Object.hasOwn(command.input.RequestItems, name);
    const transaction = command.constructor.name === "TransactWriteItemsCommand" && command.input.TransactItems?.length > 0 &&
      command.input.TransactItems.every(item => Object.keys(item).length === 1 && item.ConditionCheck?.TableName === name);
    if (!allowed && !batch && !transaction) throw new Error("Repository acceptance attempted a mutation or another table.");
    return client.send(command);
  } };
}
export async function collectOwnedPlayers(repository, input) {
  const players = [], cursors = new Set(); let cursor;
  for (let pageNumber = 0; pageNumber < 500; pageNumber++) {
    // Returning discovery's public bound is20, unlike directory's bound of50.
    const page = await repository.listOwnedJoinPlayers({ ...input, limit: 20, cursor });
    players.push(...page.players);
    if (page.cursor === null && page.complete === true) return players;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("Repository acceptance: invalid ownership continuation");
    cursors.add(page.cursor); cursor = page.cursor;
  }
  throw new Error("Repository acceptance: ownership page budget");
}
async function repositoryAcceptance(client, name, plan, interrupted) {
  const { ThreeFcRepository } = await import("../api/dist/data/repository.js");
  const { PlayerIdentityPlanner } = await import("../api/dist/data/player-identity.js");
  const ro = readOnlyRepositoryClient(client, name), repository = new ThreeFcRepository(ro, name), planner = new PlayerIdentityPlanner(ro, name);
  const expected = plan.items.map(i => ({ type: i.entityType.S, d: decode(i) }));
  const { leagueId, seasonId, excludedGameIds } = plan.scope;
  const check = (test, code) => { if (!test) throw new Error(`Repository acceptance: ${code}`); if (interrupted()) throw new Error("Rehearsal interrupted."); };
  const games = await repository.listGamesForSeason(seasonId, { leagueId, consistentRead: true });
  check(games.length === plan.summary.games && games.every(g => !excludedGameIds.includes(g.gameId)), "season_games");
  for (const game of games) {
    const players = await repository.listGamePlayers(game.gameId, { complete: true, consistentRead: true });
    const roster = await repository.listGameRoster(game.gameId, { complete: true, consistentRead: true });
    const goals = await repository.listGoalEvents(game.gameId);
    for (const [type, actual] of [["gamePlayer", players], ["roster", roster], ["goal", goals]]) {
      check(actual.length === expected.filter(r => r.type === type && r.d.gameId === game.gameId).length, `${type}_count`);
    }
    check((await repository.getGameByJoinCode(game.joinCode))?.gameId === game.gameId, "join_lookup");
    log("game-read-verified");
  }
  let resolved = 0;
  for (const row of expected.filter(r => r.type === "playerIdentity")) {
    const view = await repository.getPlayerView(row.d.playerId);
    check(view?.canonicalPlayerId === row.d.rootId, "alias_resolution");
    if (++resolved % 20 === 0) log("aliases-read-verified", { profiles: resolved });
  }
  const directory = []; let cursor;
  do {
    const page = await planner.directoryPage({ leagueId, seasonId, cursor, limit: 25 });
    directory.push(...page.entries); cursor = page.cursor;
  } while (cursor);
  check(directory.length === plan.summary.canonicalPlayers && new Set(directory.map(d => d.playerId)).size === directory.length, "directory_players");
  for (const userId of plan.admins) check((await repository.getLeagueAccess(leagueId, userId))?.role === "admin", "admin_access");
  const acl = await repository.listLeagueAccess(leagueId);
  check(acl.length === 2, "only_two_admins");
  process.env.PLAYER_RETURNING_JOIN_ENABLED = "true";
  for (const row of expected.filter(r => r.type === "playerClaim")) {
    const players = await collectOwnedPlayers(repository, { joinCode: games[0].joinCode, userId: row.d.userId });
    check(players.some(p => p.playerId === row.d.playerId), "returning_player_ownership");
  }
  return { games: games.length, profileResolutions: expected.filter(r => r.type === "playerIdentity").length, directoryPlayers: directory.length, adminGrants: acl.length };
}

async function main(args) {
  const opt = options(args), config = await loadPrivate(opt["--config"]);
  if (!/^[a-zA-Z0-9_.-]+$/.test(config.profile ?? "") || !/^\d{12}$/.test(config.accountId ?? "")) throw new Error("Explicit profile and expected account required.");
  if (Object.keys(process.env).some(k => k.startsWith("AWS_ENDPOINT_URL") && process.env[k])) throw new Error("Custom AWS endpoints are unsupported.");
  const out = resolve(opt["--out"]);
  await mkdir(out, { mode: 0o700 }); // Must be new: no overwrite, symlink, or reused ownership.
  process.env.AWS_PROFILE = config.profile;
  const client = new DynamoDBClient({ region, maxAttempts: 2, requestHandler: { requestTimeout: 15000 } });
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  let owned, createAttempted = false, created = false, report = { productionUnchanged: false, cleanupVerified: false };
  let before, failure;
  try {
    const caller = aws(config.profile, "sts", "get-caller-identity");
    if (caller.Account !== config.accountId) throw new Error("AWS account mismatch.");
    for (const name of [sourceTable, productionTable]) {
      const { Table } = await client.send(new DescribeTableCommand({ TableName: name }));
      if (Table?.TableArn !== `arn:aws:dynamodb:${region}:${config.accountId}:table/${name}` || Table.TableStatus !== "ACTIVE") throw new Error("Unexpected source/destination table provenance.");
    }
    before = await scan(client, productionTable); assertDestinationEmptyOfBusiness(before);
    const source = await scan(client, sourceTable, true);
    log("source-read", { records: source.length });
    if (args[0] === "plan") {
      const plan = buildPlan(source, config.scope);
      if (inventoryDigest(await scan(client, sourceTable, true)) !== plan.sourceDigest) throw new Error("QA changed during planning; no stable rehearsal inventory captured.");
      await privateFile(`${out}/plan.json`, plan);
      report = { ...report, summary: plan.summary, planDigest: plan.planDigest, sourceDigest: plan.sourceDigest, mode: "plan" };
      log("plan-verified", report.summary);
    } else {
      const plan = await loadPrivate(opt["--plan"]); validatePlan(plan);
      if (plan.sourceDigest !== inventoryDigest(source)) throw new Error("QA changed since the plan; prepare a new plan.");
      const codes = new Map(plan.items.filter(i => i.entityType.S === "game").map(i => { const d = decode(i); return [d.gameId, d.joinCode]; }));
      const rebuilt = buildPlan(source, config.scope, { at: plan.at, nonce: plan.nonce, code: id => codes.get(id) });
      // A self-consistent digest is not authority: independently reproduce every
      // row from live QA and the explicit scope, including regenerated records.
      if (rebuilt.planDigest !== plan.planDigest) throw new Error("Config or source does not reproduce the reviewed plan.");
      const owner = randomUUID(), name = `3fc-import-rehearsal-${owner}`; assertDisposable(name);
      owned = { name, owner, arn: `arn:aws:dynamodb:${region}:${config.accountId}:table/${name}` };
      // Persist exact ownership intent before the first AWS mutation for interrupted recovery.
      await privateFile(`${out}/ownership.json`, owned);
      if (interrupted) throw new Error("Rehearsal interrupted.");
      createAttempted = true;
      const response = await client.send(new CreateTableCommand({ TableName: name, BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        Tags: [{ Key: "RehearsalOwner", Value: owner }, { Key: "Purpose", Value: "winter-selective-import-rehearsal" }] }));
      created = true;
      owned.id = response.TableDescription?.TableId;
      const table = await waitFor(client, name, "ACTIVE", () => interrupted);
      if (!owned.id) owned.id = table.TableId;
      await privateFile(`${out}/created-table.json`, owned);
      const tags = (await client.send(new ListTagsOfResourceCommand({ ResourceArn: owned.arn }))).Tags ?? [];
      assertOwned(table, owned, tags);
      log("disposable-created", { table: name });
      await writeItems(client, name, plan.items, count => { log("copied", { records: count }); if (interrupted) throw new Error("Rehearsal interrupted."); });
      const imported = await scan(client, name);
      if (inventoryDigest(imported) !== inventoryDigest(plan.items)) throw new Error("Imported records do not match plan.");
      validatePlan({ ...plan, items: imported.sort((a, b) => key(a).localeCompare(key(b), "en")) });
      // Only the disposable table gets a fresh verified control, after complete validation.
      const control = envelope("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "fenced", coverage: "verified", writerVersion: 1, epoch: plan.nonce }, plan.at);
      const original = plan.items.find(i => i.pk.S === "PLAYER_IDENTITY");
      await client.send(new PutItemCommand({ TableName: name, Item: control, ConditionExpression: "#data = :old",
        ExpressionAttributeNames: { "#data": "data" }, ExpressionAttributeValues: { ":old": original.data } }));
      const acceptance = await repositoryAcceptance(client, name, plan, () => interrupted);
      const final = await scan(client, name);
      if (inventoryDigest(final) !== inventoryDigest(plan.items.map(i => i.pk.S === "PLAYER_IDENTITY" ? control : i))) throw new Error("Read acceptance changed imported data.");
      report = { ...report, mode: "rehearse", table: name, planDigest: plan.planDigest, sourceDigest: plan.sourceDigest, summary: plan.summary, repositoryAcceptance: acceptance };
      log("rehearsal-verified", acceptance);
    }
  } catch (error) { failure = error; }
  finally {
    if (createAttempted && !created) {
      // An uncertain CreateTable response is not evidence that no table exists.
      // Adopt only the exact random name + owner tag, then use its physical ID.
      try {
        const table = await waitFor(client, owned.name, "ACTIVE");
        const tags = (await client.send(new ListTagsOfResourceCommand({ ResourceArn: owned.arn }))).Tags ?? [];
        owned.id = table.TableId; assertOwned(table, owned, tags); created = true;
        await privateFile(`${out}/recovered-table.json`, owned);
      } catch { report.cleanupRequired = true; }
    }
    if (created) {
      try {
        const { Table } = await client.send(new DescribeTableCommand({ TableName: owned.name }));
        const tags = (await client.send(new ListTagsOfResourceCommand({ ResourceArn: owned.arn }))).Tags ?? [];
        assertOwned(Table, owned, tags);
        await client.send(new DeleteTableCommand({ TableName: owned.name }));
        await waitFor(client, owned.name, "absent"); report.cleanupVerified = true; log("disposable-deleted");
      } catch { report.cleanupRequired = true; failure ??= new Error("Disposable cleanup requires investigation using private ownership evidence."); }
    }
    if (before) {
      try { report.productionUnchanged = inventoryDigest(before) === inventoryDigest(await scan(client, productionTable)); }
      catch { report.productionUnchanged = false; }
      if (!report.productionUnchanged) failure ??= new Error("Production verification changed or could not complete; investigate.");
    }
    report.success = !failure;
    if (failure) await privateFile(`${out}/failure.json`, { name: failure.name, message: failure.message });
    // Redacted report only: the private plan carries source records and account identifiers.
    await privateFile(`${out}/report.json`, report);
    client.destroy(); process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
  }
  if (failure) throw failure;
  log("complete", report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    // AWS/child errors may include request data. Only curated validation messages are printed.
    const safe = /^(Import validation:|Repository acceptance|Only |Disposable |Inventory |Repeated |Production |Explicit |Custom |AWS account|Unexpected |QA changed|Config |Source row|Rehearsal |Imported |Read acceptance|Private |Use |Invalid |Planning )/.test(error.message ?? "");
    process.stderr.write(`${safe ? error.message : "Rehearsal failed; inspect private evidence without publishing source data."}\n`); process.exitCode = 1;
  });
}
