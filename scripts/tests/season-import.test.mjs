import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, validatePlan, envelope, decode, subject, projection, inventoryDigest } from "../season-import-plan.mjs";
import { assertDisposable, assertOwned, assertDestinationEmptyOfBusiness, writeItems, scan, readOnlyRepositoryClient, collectOwnedPlayers } from "../season-import-rehearsal.mjs";
import { BatchGetItemCommand, GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { SeasonImportExecutor, cutoverManifest, validateCutover, isControl } from "../season-import-executor.mjs";
import { productionArguments, verifyFreeze, verifyBackup, verifyWriter, writerBaseline } from "../season-import-production.mjs";
import { key, digest } from "../season-import-plan.mjs";

const at = "2026-10-03T00:00:00Z", name = "3fc-import-rehearsal-12345678-1234-1234-1234-123456789012";
const scope = { leagueId: "league", seasonId: "winter", excludedGameIds: ["early"], adminEmails: ["organiser@example.invalid", "second@example.invalid"] };
export function fixture() {
  const rows = [];
  const put = (pk, sk, type, d) => rows.push(envelope(pk, sk, type, d, at));
  put("LEAGUE#league", "METADATA", "league", { leagueId: "league", name: "League", createdByUserId: scope.adminEmails[0] });
  const season = { leagueId: "league", seasonId: "winter", name: "Winter" };
  put("LEAGUE#league", "SEASON#winter", "season", season); put("SEASON#winter", "METADATA", "season", season);
  const session = { leagueId: "league", seasonId: "winter", sessionId: "day", sessionDate: "2026-09-20" };
  put("LEAGUE#league", "SEASON#winter#SESSION#day", "session", session); put("SESSION#day", "METADATA", "session", session);
  for (const email of [...scope.adminEmails, "extra@example.invalid"]) {
    const userId = subject(email);
    put("LEAGUE#league", `ACL#USER#${userId}`, "acl", { leagueId: "league", userId, role: "admin", grantedByUserId: scope.adminEmails[0] });
  }
  const game = { gameId: "later", leagueId: "league", seasonId: "winter", sessionId: "day", gameStartTs: at, status: "finished", result: null, joinCode: "AAAAAAAA" };
  put("GAME#later", "METADATA", "game", game);
  put("GAME#early", "METADATA", "game", { ...game, gameId: "early", sessionId: "early-day", joinCode: "BBBBBBBB" });
  put("SESSION#day", `GAME#${at}#later`, "sessionGame", { ...game });
  for (const id of ["root", "alias", "excluded-only"]) {
    put(`PLAYER#${id}`, "PROFILE", "player", { playerId: id, nickname: id, claimedByUserId: id === "root" ? subject(scope.adminEmails[0]) : null });
    put(`PLAYER#${id}`, "IDENTITY", "playerIdentity", { playerId: id, rootId: id === "alias" ? "root" : id, members: id === "root" ? ["root", "alias"] : id === "alias" ? [] : [id], displayName: id, formerNames: [], identityVersion: 1, writeVersion: "original" });
  }
  put("GAME#later", "PLAYER#alias", "gamePlayer", { gameId: "later", playerId: "alias" });
  put("GAME#later", "ROSTER#red#alias", "roster", { gameId: "later", teamId: "red", playerId: "alias" });
  put("GAME#early", "PLAYER#excluded-only", "gamePlayer", { gameId: "early", playerId: "excluded-only" });
  for (const teamId of ["red", "blue", "yellow"]) put("GAME#later", `TEAM#${teamId}`, "gameTeam", { gameId: "later", teamId, name: teamId, color: null, scored: 0, conceded: teamId === "red" ? 1 : 0 });
  const goal = { gameId: "later", eventId: "goal", third: 1, gameMinute: 1, elapsedSeconds: 60, thirdMinute: 1,
    scorerPlayerId: "alias", assistPlayerIds: [], ownGoal: true, scoringTeamId: null, concedingTeamId: "red" };
  put("GAME#later", "GOAL#1#0001#000060#goal", "goal", goal);
  put("GAME#later", "GOAL_EVENT#goal", "goalEventId", { gameId: "later", eventId: "goal" });
  put("GAME#later", "JOIN_RECEIPT#alias", "gameJoinReceipt", { gameId: "later", playerId: "alias" });
  put("PLAYER#alias", projection("GAME", "early"), "playerGameMembership", { playerId: "alias", gameId: "early", leagueId: "league", seasonId: "winter" });
  return rows;
}
const options = { at, nonce: "test-epoch", code: () => "CCCCCCCC" };
const change = (rows, type, fn) => { const item = rows.find(r => r.entityType.S === type); item.data.S = JSON.stringify(fn(decode(item))); };

test("explicit account repair moves claimed group members and indexes without changing history or QA", () => {
  const source = fixture(), before = inventoryDigest(source), old = subject(scope.adminEmails[0]), email = "correct@example.invalid";
  const alias = source.find(i => i.pk.S === "PLAYER#alias" && i.sk.S === "PROFILE");
  alias.data.S = JSON.stringify({ ...decode(alias), claimedByUserId: old });
  const frozen = inventoryDigest(source);
  const transferScope = { ...scope, ownershipMappings: [{ playerId: "root", expectedOwner: old, toEmail: email }] };
  const plan = buildPlan(source, transferScope, options);
  assert.equal(inventoryDigest(source), frozen); assert.notEqual(before, frozen);
  assert(plan.items.filter(i => i.entityType.S === "player").every(i => decode(i).claimedByUserId === subject(email)));
  assert(!plan.items.some(i => i.pk.S === `USER#${old}`));
  assert(plan.items.some(i => i.pk.S === `USER#${subject(email)}` && i.entityType.S === "playerClaim"));
  assert.equal(decode(plan.items.find(i => i.entityType.S === "goal")).scorerPlayerId, "alias");
  assert.deepEqual(plan.admins, buildPlan(source, scope, options).admins, "account repair never adds administrator authority");
  assert.equal(plan.summary.ownershipTransfers, 1);
  const unchanged = buildPlan(source, { ...scope, ownershipMappings: [{ playerId: "root", expectedOwner: old, toEmail: scope.adminEmails[0] }] }, options);
  assert.equal(unchanged.summary.ownershipTransfers, 0);
  assert.equal(unchanged.summary.verifiedOwnershipBindings, 1);
  assert.equal(inventoryDigest(unchanged.items.filter(i => i.entityType.S === "player")),
    inventoryDigest(source.filter(i => i.entityType.S === "player" && decode(i).playerId !== "excluded-only")));
  assert.equal(buildPlan([...source].reverse(), transferScope, options).planDigest, plan.planDigest);
  for (const bad of [
    { playerId: "alias", expectedOwner: old, toEmail: email },
    { playerId: "root", expectedOwner: subject("wrong@example.invalid"), toEmail: email },
  ]) assert.throws(() => buildPlan(source, { ...scope, ownershipMappings: [bad] }, options), /transfer_/);
  source.push(envelope("PLAYER#outside", "PROFILE", "player", { playerId: "outside", claimedByUserId: subject(email) }, at));
  assert.throws(() => buildPlan(source, transferScope, options), /transfer_destination_already_claimed/);
  source.at(-1).data.S = JSON.stringify({ playerId: "outside", claimedByUserId: old });
  assert.equal(buildPlan(source, { ...scope, ownershipMappings: [{ playerId: "root", expectedOwner: old, toEmail: scope.adminEmails[0] }] }, options).summary.ownershipTransfers, 0,
    "asserting existing ownership allows other unselected QA profiles owned by the same account");
});

test("ownership repair leaves unclaimed aliases unclaimed and rejects conflicting owners", () => {
  const source = fixture(), transferScope = { ...scope, ownershipMappings: [{ playerId: "root", expectedOwner: subject(scope.adminEmails[0]), toEmail: "correct@example.invalid" }] };
  const plan = buildPlan(source, transferScope, options);
  assert.equal(decode(plan.items.find(i => i.pk.S === "PLAYER#alias" && i.sk.S === "PROFILE")).claimedByUserId, null);
  const alias = source.find(i => i.pk.S === "PLAYER#alias" && i.sk.S === "PROFILE");
  alias.data.S = JSON.stringify({ ...decode(alias), claimedByUserId: subject("other@example.invalid") });
  assert.throws(() => buildPlan(source, transferScope, options), /conflicting_claim_owners/);
});

test("selection preserves historical IDs and alias closure, excludes early-only profiles and extra admins, regenerates scoped indexes", () => {
  const source = fixture(), plan = buildPlan(source, scope, options);
  assert.equal(plan.summary.games, 1); assert.equal(plan.summary.historicalPlayerIds, 2); assert.equal(plan.summary.canonicalPlayers, 1);
  assert.equal(plan.summary.adminGrants, 2); assert.equal(plan.summary.claimedAccounts, 1);
  assert(!plan.items.some(i => i.pk.S === "GAME#early" || i.pk.S === "PLAYER#excluded-only"));
  assert(!plan.items.some(i => i.entityType.S === "gameJoinReceipt" || i.pk.S === "JOIN_CODE#AAAAAAAA"));
  const memberships = plan.items.filter(i => i.entityType.S === "playerGameMembership").map(decode);
  assert.deepEqual(memberships.map(d => d.gameId), ["later"]);
  const profiles = source.filter(i => i.entityType.S === "player" && decode(i).playerId !== "excluded-only");
  assert.equal(inventoryDigest(plan.items.filter(i => i.entityType.S === "player")), inventoryDigest(profiles));
  const directory = plan.items.filter(i => i.entityType.S === "leaguePlayer").map(decode);
  assert.deepEqual(directory.filter(d => d.active).map(d => d.playerId), ["root"]);
  assert.equal(decode(plan.items.find(i => i.pk.S === "PLAYER_IDENTITY")).coverage, "unknown");
  assert(validatePlan(plan));
});

test("stable snapshot and generated inputs reproduce every byte of the reviewed plan", () => {
  const source = fixture(), plan = buildPlan(source, scope, options);
  assert.equal(buildPlan([...source].reverse(), scope, options).planDigest, plan.planDigest);
  const changed = structuredClone(plan); change(changed.items, "player", d => ({ ...d, nickname: "tampered" }));
  assert.throws(() => validatePlan(changed), /plan_digest/);
});

test("an explicitly selected claimed profile resolves only its existing organiser grant", () => {
  const source = fixture();
  const plan = buildPlan(source, { ...scope, adminEmails: [scope.adminEmails[1]], adminPlayerIds: ["root"] }, options);
  assert.deepEqual(new Set(plan.admins), new Set(scope.adminEmails.map(subject)));
  assert.throws(() => buildPlan(source, { ...scope, adminEmails: [scope.adminEmails[0]], adminPlayerIds: ["root"] }, options), /duplicate_target_key/);
  assert.throws(() => buildPlan(source, { ...scope, adminEmails: [scope.adminEmails[0]], adminPlayerIds: ["alias"] }, options), /admin_player_not_selected_root/);
});

test("scope, ownership and relationship gaps fail before a target can be created", () => {
  const cases = [
    [rows => rows.splice(rows.findIndex(i => i.pk.S === "PLAYER#root" && i.sk.S === "PROFILE"), 1), /missing_player/],
    [rows => rows.splice(rows.findIndex(i => i.entityType.S === "sessionGame"), 1), /missing_sessionGame/],
    [rows => change(rows, "season", d => ({ ...d, leagueId: "other" })), /season_mirror_scope/],
    [rows => change(rows, "playerGameMembership", d => ({ ...d, gameId: "unselected" })), /external_player_membership/],
    [rows => change(rows, "game", d => ({ ...d, status: "live" })), /live_or_unknown_game_state/],
    [rows => rows.push(envelope("GAME#later", "UNKNOWN", "newCriticalState", { gameId: "later" }, at)), /unknown_game_record/],
    [rows => change(rows, "playerIdentity", d => ({ ...d, members: ["root"] })), /identity_closure/],
    [rows => rows.push(envelope("GAME#later", "PLAYER#root", "gamePlayer", { gameId: "later", playerId: "root" }, at)), /canonical_registration_conflict/],
  ];
  for (const [mutate, error] of cases) { const rows = fixture(); mutate(rows); assert.throws(() => buildPlan(rows, scope, options), error); }
  assert.throws(() => buildPlan(fixture(), { ...scope, adminEmails: [scope.adminEmails[0], "unknown@example.invalid"] }, options), /admin_account_not_found/);
  assert.throws(() => buildPlan(fixture(), { ...scope, excludedGameIds: ["unknown"] }, options), /unknown_excluded_game/);
});

test("scheduled games can be retained only without played state", () => {
  const source = fixture();
  change(source, "game", d => ({ ...d, status: "scheduled", thirds: [{ third: 1, startedAt: null, finishedAt: null }] }));
  assert.throws(() => buildPlan(source, scope, options), /scheduled_game_has_played_state/);
  const clean = source.filter(i => !["goal", "goalEventId"].includes(i.entityType.S));
  for (const i of clean.filter(i => i.entityType.S === "gameTeam")) i.data.S = JSON.stringify({ ...decode(i), conceded: 0 });
  assert.equal(buildPlan(clean, scope, options).summary.games, 1);
  change(clean, "game", d => ({ ...d, thirds: [{ third: 1, startedAt: at, finishedAt: null }] }));
  assert.throws(() => buildPlan(clean, scope, options), /scheduled_game_has_played_state/);
});

test("foreign league, season and creation associations block even without a foreign game index", () => {
  for (const [type, d] of [
    ["playerLeagueMembership", { playerId: "alias", leagueId: "other" }],
    ["playerSeasonMembership", { playerId: "root", leagueId: "league", seasonId: "other" }],
    ["playerSeasonMembership", { playerId: "alias", leagueId: "other", seasonId: "winter" }],
    ["leaguePlayerCreation", { playerId: "root", leagueId: "other" }],
  ]) {
    const rows = fixture(); rows.push(envelope(`PLAYER#${d.playerId}`, `FOREIGN#${type}`, type, d, at));
    assert.throws(() => buildPlan(rows, scope, options), /external_player_membership/);
  }
  const rows = fixture();
  rows.push(envelope("PLAYER#root", projection("LEAGUE", "league"), "playerLeagueMembership", { playerId: "root", leagueId: "league" }, at));
  rows.push(envelope("PLAYER#alias", projection("SEASON", "league", "winter"), "playerSeasonMembership", { playerId: "alias", leagueId: "league", seasonId: "winter" }, at));
  assert.equal(buildPlan(rows, scope, options).summary.canonicalPlayers, 1);
});

test("legacy sessions get missing scoped rows and mirrors only with verified season ownership", () => {
  const source = fixture().filter(i => i.entityType.S !== "session");
  source.push(envelope("SEASON#winter", "SESSION#day", "session", { seasonId: "winter", sessionId: "day", sessionDate: "2026-09-20" }, at));
  const plan = buildPlan(source, scope, options);
  assert(plan.items.some(i => i.pk.S === "SESSION#day" && i.sk.S === "METADATA" && decode(i).leagueId === "league"));
  assert(plan.items.some(i => i.pk.S === "LEAGUE#league" && i.sk.S === "SEASON#winter#SESSION#day"));
  const conflict = [...source, envelope("SESSION#day", "METADATA", "session", { seasonId: "other", sessionId: "day", leagueId: "other" }, at)];
  const imported = buildPlan(conflict, scope, options);
  assert.equal(decode(imported.items.find(i => i.pk.S === "SESSION#day" && i.sk.S === "METADATA")).seasonId, "winter");
  assert.equal(decode(conflict.at(-1)).seasonId, "other", "foreign QA mirror is untouched");
  conflict.at(-1).entityType.S = "unknown";
  assert.throws(() => buildPlan(conflict, scope, options), /conflicting_session_address/);
  source.find(i => i.pk.S === "SEASON#winter" && i.sk.S === "METADATA").data.S = JSON.stringify({ seasonId: "winter", leagueId: "other" });
  assert.throws(() => buildPlan(source, scope, options), /season_mirror_scope/);
});

test("own goals remain conceding-only and goal/score/assist corruption is rejected", () => {
  for (const [type, mutate, error] of [
    ["gameTeam", d => ({ ...d, scored: 1 }), /score_timeline_mismatch/],
    ["goal", d => ({ ...d, assistPlayerIds: ["alias"] }), /goal_assists/],
    ["goal", d => ({ ...d, scorerPlayerId: "missing" }), /missing_playerIdentity/],
    ["game", d => ({ ...d, result: { winnerTeamId: "red" } }), /result_winner_mismatch/],
  ]) { const rows = fixture(); change(rows, type, mutate); assert.throws(() => buildPlan(rows, scope, options), error); }
});

test("writer refuses shared tables and puts each row with an absence condition", async () => {
  const sent = [], client = { async send(command) { sent.push(command); return {}; } };
  for (const table of ["3fc-prod-app", "3fc-qa-app", "3fc-import-rehearsal-existing"]) {
    assert.throws(() => assertDisposable(table)); await assert.rejects(writeItems(client, table, fixture()));
  }
  assert.equal(sent.length, 0);
  await writeItems(client, name, fixture());
  for (const command of sent) for (const item of command.input.TransactItems) {
    assert.equal(item.Put.TableName, name); assert.match(item.Put.ConditionExpression, /attribute_not_exists/);
  }
  let calls = 0;
  await assert.rejects(writeItems({ async send() { calls++; throw new Error("collision"); } }, name, fixture()), /collision/);
  assert.equal(calls, 1, "no retry or continuation after a write failure");
});

test("cleanup requires exact ARN, unique table ID and ownership tag", () => {
  const expected = { name, arn: "arn:table", id: "table-id", owner: "owner" };
  const table = { TableName: name, TableArn: expected.arn, TableId: expected.id }, tags = [{ Key: "RehearsalOwner", Value: expected.owner }];
  assertOwned(table, expected, tags);
  for (const changed of [{ ...table, TableName: "3fc-prod-app" }, { ...table, TableId: "replacement" }, { ...table, TableArn: "other-account" }]) assert.throws(() => assertOwned(changed, expected, tags));
  assert.throws(() => assertOwned(table, expected, []));
});

test("paginated inventory does not stop on an empty filtered page; rejects repeated cursors", async () => {
  const cursor = { pk: { S: "next" }, sk: { S: "row" } }, first = { Items: [], LastEvaluatedKey: cursor };
  const pages = [first, { Items: fixture() }];
  assert.equal((await scan({ async send() { return pages.shift(); } }, "read-only")).length, fixture().length);
  await assert.rejects(scan({ async send() { return first; } }, "read-only"), /Repeated/);
});

test("business inventory excludes raw authentication sessions even though they also have entityType session", async () => {
  await scan({ async send(command) {
    assert.match(command.input.FilterExpression, /NOT begins_with\(pk, :auth\)/);
    assert.equal(command.input.ExpressionAttributeValues[":auth"].S, "AUTH_");
    return { Items: [] };
  } }, "3fc-qa-app", true);
});

test("repository acceptance cannot write or read another table; conditions-only transactions are permitted", async () => {
  let calls = 0; const ro = readOnlyRepositoryClient({ async send() { calls++; return {}; } }, name);
  await ro.send(new GetItemCommand({ TableName: name }));
  await ro.send(new BatchGetItemCommand({ RequestItems: { [name]: { Keys: [] } } }));
  await ro.send(new TransactWriteItemsCommand({ TransactItems: [{ ConditionCheck: { TableName: name } }] }));
  await assert.rejects(ro.send(new PutItemCommand({ TableName: name })), /mutation/);
  await assert.rejects(ro.send(new GetItemCommand({ TableName: "3fc-prod-app" })), /another table/);
  await assert.rejects(ro.send(new BatchGetItemCommand({ RequestItems: { [name]: { Keys: [] }, "3fc-prod-app": { Keys: [] } } })), /another table/);
  await assert.rejects(ro.send(new TransactWriteItemsCommand({ TransactItems: [{ ConditionCheck: { TableName: name }, Delete: { TableName: name } }] })), /mutation/);
  assert.equal(calls, 3);
});

test("new production business data blocks this empty-destination plan", () => {
  assertDestinationEmptyOfBusiness([envelope("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", {}, at)]);
  assert.throws(() => assertDestinationEmptyOfBusiness(fixture()), /Production contains/);
});

test("returning-player acceptance respects its20-row bound and exhausts even empty namespace pages", async () => {
  const pages = [ { players: [], cursor: "hash-namespace", complete: false }, { players: [{ playerId: "root" }], cursor: null, complete: true } ];
  let calls = 0;
  const players = await collectOwnedPlayers({ async listOwnedJoinPlayers(input) {
    assert.equal(input.limit, 20);
    assert.equal(input.cursor, calls++ ? "hash-namespace" : undefined);
    return pages.shift();
  } }, { userId: "owner", joinCode: "CCCCCCCC" });
  assert.deepEqual(players, [{ playerId: "root" }]); assert.equal(calls, 2);
  await assert.rejects(collectOwnedPlayers({ async listOwnedJoinPlayers() { return { players: [], cursor: "stuck", complete: false }; } }, {}), /invalid ownership continuation/);
});

function engineFixture() {
  const plan = buildPlan(fixture(), scope, options);
  const baseline = [envelope("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "fenced", coverage: "verified", writerVersion: 1, epoch: "previous" }, at),
    envelope("PLAYER_MIGRATION#old", "AUDIT", "playerIdentityMigration", { phase: "active" }, at)];
  const manifest = cutoverManifest(plan, baseline, { test: true });
  let rows = new Map(baseline.map(i => [key(i), structuredClone(i)]));
  let transactions = 0, dropAt = 0;
  const client = { async send(command) {
    if (command instanceof GetItemCommand) return { Item: structuredClone(rows.get(key(command.input.Key))) };
    assert(command instanceof TransactWriteItemsCommand);
    const next = new Map(rows);
    for (const op of command.input.TransactItems) {
      const action = op.Put ?? op.ConditionCheck, item = action.Item ?? action.Key, current = rows.get(key(item));
      assert.equal(action.TableName, name);
      if (action.ConditionExpression.includes("attribute_not_exists")) {
        if (current) throw new Error("conditional collision");
      } else {
        for (const [alias, attr] of Object.entries(action.ExpressionAttributeNames)) {
          const valueName = { "#data": ":data", "#updated": ":updated", "#type": ":type", "#created": ":created" }[alias];
          if (digest(current?.[attr]) !== digest(action.ExpressionAttributeValues[valueName])) throw new Error("conditional state changed");
        }
      }
      if (op.Put) next.set(key(item), structuredClone(item));
    }
    rows = next;
    if (++transactions === dropAt) throw new Error("response lost after commit");
    return {};
  } };
  const scanAll = async () => [...rows.values()];
  const engineOptions = { scan: scanAll, guard: async () => {}, acceptance: async () => {
    assert.equal(decode([...rows.values()].find(isControl)).coverage, "verified"); return { passed: true };
  } };
  return { plan, baseline, manifest, client, engineOptions, scanAll, rows: () => rows, drop: at => { dropAt = at; }, transactions: () => transactions,
    runner: overrides => new SeasonImportExecutor(client, name, manifest, { ...engineOptions, ...overrides }) };
}

test("production engine preserves system audit and resumes lost begin, chunk, activation and acceptance responses", async () => {
  const complete = engineFixture(); await complete.runner().run();
  for (let lost = 1; lost <= complete.transactions(); lost++) {
    const f = engineFixture(); f.drop(lost);
    await assert.rejects(f.runner().run(), /response lost/);
    const result = await f.runner().run();
    assert.equal(result.phase, "accepted");
    assert.equal(inventoryDigest(await f.scanAll()), inventoryDigest(await complete.scanAll()));
    assert.deepEqual(f.rows().get(key(f.baseline[1])), f.baseline[1]);
    const count = f.transactions(); await f.runner().run();
    assert.equal(f.transactions(), count, "already accepted import performs no more writes");
  }
});

test("changed destination, previous imported rows and control stop resume without overwriting", async () => {
  for (const kind of ["extra", "row", "control"]) {
    const f = engineFixture(); f.drop(2);
    await assert.rejects(f.runner().run(), /response lost/);
    if (kind === "extra") { const row = envelope("UNEXPECTED", "DATA", "new", {}, at); f.rows().set(key(row), row); }
    else {
      const row = [...f.rows().values()].find(i => kind === "control" ? isControl(i) : i.entityType.S === "game");
      row.data.S = JSON.stringify({ ...decode(row), changed: true });
    }
    const snapshot = inventoryDigest(await f.scanAll()), calls = f.transactions();
    await assert.rejects(f.runner().run(), /destination differs/);
    assert.equal(f.transactions(), calls); assert.equal(inventoryDigest(await f.scanAll()), snapshot);
  }
});

test("mid-batch collision is atomic and does not advance the checkpoint", async () => {
  const f = engineFixture(); let injected = false;
  const wrapped = { async send(command) {
    if (!injected && command instanceof TransactWriteItemsCommand && command.input.TransactItems.length > 2) {
      const collision = structuredClone(command.input.TransactItems[2].Put.Item);
      collision.data.S = JSON.stringify({ unexpected: true }); f.rows().set(key(collision), collision); injected = true;
    }
    return f.client.send(command);
  } };
  const runner = new SeasonImportExecutor(wrapped, name, f.manifest, f.engineOptions);
  await assert.rejects(runner.run(), /conditional collision/);
  assert.equal(decode(await runner.status()).next, 0);
  assert.equal(decode(f.rows().get(key(f.baseline[0]))).mode, "paused");
});

test("freeze loss stops writes; failed acceptance leaves a resumable verified checkpoint", async () => {
  const f = engineFixture();
  await assert.rejects(f.runner({ guard: async () => { throw new Error("freeze lost"); } }).run(), /freeze lost/);
  assert.equal(f.transactions(), 0);
  await assert.rejects(f.runner({ acceptance: async () => { throw new Error("acceptance failed"); } }).run(), /acceptance failed/);
  assert.equal(decode(await f.runner().status()).phase, "verified");
  assert.equal((await f.runner().run()).phase, "accepted");
});

test("manifest tampering, different run ownership and business baseline are rejected", async () => {
  const f = engineFixture(), changed = structuredClone(f.manifest); changed.plan.items.pop();
  assert.throws(() => validateCutover(changed), /digest mismatch/);
  assert.throws(() => cutoverManifest(f.plan, [...f.baseline, fixture()[0]], {}), /only identity system/);
  f.drop(1); await assert.rejects(f.runner().run(), /response lost/);
  const other = cutoverManifest(f.plan, f.baseline, { different: true });
  await assert.rejects(new SeasonImportExecutor(f.client, name, other, f.engineOptions).run(), /checkpoint ownership/);
});

test("production CLI requires an explicit mode and approved manifest digest, never a configurable destination", () => {
  const base = ["apply", "--config", "private.json", "--out", "new-dir", "--manifest", "manifest.json"];
  assert.throws(() => productionArguments(base), /missing/);
  assert.throws(() => productionArguments([...base, "--approved-digest", "a".repeat(64), "--apply", "disposable-table-only"]), /explicit production/);
  assert.equal(productionArguments([...base, "--approved-digest", "a".repeat(64), "--apply", "production-season-import"]).command, "apply");
  assert.throws(() => productionArguments(["observe", "--config", "x", "--out", "x", "--table", "other"]), /invalid/);
  assert.throws(() => productionArguments(["prepare", "--config", "x", "--out", "x", "--observation", "x", "--apply", "anything"]), /invalid/);
  assert.equal(productionArguments(["baseline", "--config", "x", "--out", "new"]).command, "baseline");
  assert.throws(() => productionArguments(["baseline", "--config", "x", "--out", "new", "--apply", "anything"]), /invalid/);
});

test("freeze drain and physical-table backups must be current, complete and match", () => {
  const live = { qa: { revision: "q" }, prod: { revision: "p" } }, observed = { at, live }, start = Date.parse(at);
  assert.throws(() => verifyFreeze(observed, live, start + 904999), /905-second/);
  assert.throws(() => verifyFreeze(observed, { ...live, prod: { revision: "changed" } }, start + 905000), /writer changed/);
  verifyFreeze(observed, live, start + 905000);
  const table = { arn: "exact", id: "physical" };
  const backup = { BackupDetails: { BackupStatus: "AVAILABLE", BackupType: "USER", BackupCreationDateTime: new Date(start + 905000).toISOString() },
    SourceTableDetails: { TableArn: "exact", TableId: "physical" } };
  verifyBackup(backup, table, at);
  assert.throws(() => verifyBackup({ ...backup, SourceTableDetails: { TableArn: "exact", TableId: "replaced" } }, table, at), /backup/);
  assert.throws(() => verifyBackup({ ...backup, BackupDetails: { ...backup.BackupDetails, BackupStatus: "CREATING" } }, table, at), /backup/);
  assert.throws(() => verifyBackup({ ...backup, BackupDetails: { ...backup.BackupDetails, BackupCreationDateTime: at } }, table, at), /backup/);
});

test("accepted writer pins account, physical endpoint, revision and player feature settings", () => {
  const live = { name: "3fc-prod-api-core", arn: "arn:aws:lambda:ap-southeast-2:123456789012:function:3fc-prod-api-core",
    hash: "accepted-package", revision: "accepted-revision", state: "Active", update: "Successful", table: "3fc-prod-app",
    claim: "proof", returning: "true", consolidation: "false" };
  const deployment = { packageCodeSha256: live.hash, functionFingerprint: { functionName: live.name, codeSha256: live.hash,
    revisionId: live.revision, playerClaimMode: "proof", returningJoinEnabled: "true", consolidationEnabled: "false" } };
  verifyWriter(live, deployment, "prod", "123456789012", "3fc-prod-app");
  assert.throws(() => verifyWriter({ ...live, revision: "changed" }, deployment, "prod", "123456789012", "3fc-prod-app"), /pre-maintenance fingerprint/);
  for (const mutation of [{ hash: "changed" }, { arn: "different-account" }, { table: "3fc-qa-app" },
    { claim: "disabled" }, { returning: "false" }, { consolidation: "true" }]) {
    assert.throws(() => verifyWriter({ ...live, ...mutation }, deployment, "prod", "123456789012", "3fc-prod-app"), /writer or player feature/);
  }
  const disabled = structuredClone(deployment); disabled.functionFingerprint.returningJoinEnabled = "false";
  assert.throws(() => verifyWriter({ ...live, returning: "false" }, disabled, "prod", "123456789012", "3fc-prod-app"), /writer or player feature/);
});

test("concurrency revision changes require the original accepted baseline; runtime and observation drift still fail", () => {
  const account = "123456789012", live = {}, deployments = {};
  for (const env of ["qa", "prod"]) {
    const f = { name: `3fc-${env}-api-core`, arn: `arn:aws:lambda:ap-southeast-2:${account}:function:3fc-${env}-api-core`,
      hash: "accepted-package", revision: `accepted-${env}`, state: "Active", update: "Successful", modified: "2026-09-01T00:00:00Z",
      table: `3fc-${env}-app`, claim: "proof", returning: "true", consolidation: "false" };
    live[env] = { function: f, table: { name: f.table } };
    deployments[env] = { gitCommit: env === "qa" ? "a".repeat(40) : "b".repeat(40), deployedAtUtc: "2026-09-01T00:01:00Z", packageCodeSha256: f.hash,
      functionFingerprint: { functionName: f.name, codeSha256: f.hash, revisionId: f.revision, playerClaimMode: "proof", returningJoinEnabled: "true", consolidationEnabled: "false" } };
  }
  const baseline = writerBaseline(live, deployments, account, undefined, "2026-09-02T00:00:00Z");
  const paused = structuredClone(live);
  for (const env of ["qa", "prod"]) {
    paused[env].function.revision = `paused-${env}`;
    verifyWriter(paused[env].function, deployments[env], env, account, live[env].table.name, baseline);
  }
  const resumedBaseline = writerBaseline(paused, deployments, account, baseline, "2026-09-03T00:00:00Z");
  assert.equal(resumedBaseline.environments.prod.live.revision, "accepted-prod", "keep original provenance after an abandoned window");
  const missingRevision = structuredClone(deployments.prod), missingAnchor = structuredClone(baseline);
  delete missingRevision.functionFingerprint.revisionId; delete missingAnchor.environments.prod.live.revision;
  assert.throws(() => verifyWriter(paused.prod.function, missingRevision, "prod", account, "3fc-prod-app", missingAnchor), /writer or player feature/);
  for (const mutate of [
    b => { b.accountId = "999999999999"; },
    b => { b.environments.prod.acceptedDeploymentSha = "c".repeat(40); },
    b => { b.environments.prod.live.revision = "invented-original"; },
    b => { b.at = "invalid"; }, b => { b.at = "2026-08-31T00:00:00Z"; }, b => { b.at = "2999-01-01T00:00:00Z"; },
  ]) {
    const invalid = structuredClone(baseline); mutate(invalid);
    assert.throws(() => verifyWriter(paused.prod.function, deployments.prod, "prod", account, "3fc-prod-app", invalid), /pre-maintenance fingerprint/);
  }
  assert.throws(() => verifyWriter({ ...paused.prod.function, modified: "2026-09-02T00:00:01Z" }, deployments.prod, "prod", account, "3fc-prod-app", baseline), /pre-maintenance fingerprint/);
  assert.throws(() => verifyWriter({ ...paused.prod.function, returning: "false" }, deployments.prod, "prod", account, "3fc-prod-app", baseline), /feature mismatch/);
  const observed = { at: "2026-09-03T00:00:00Z", live: paused }, changed = structuredClone(paused);
  changed.prod.function.revision = "another-change-after-freeze";
  assert.throws(() => verifyFreeze(observed, changed, Date.parse(observed.at) + 905000), /writer changed/);
});
