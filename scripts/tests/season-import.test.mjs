import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, validatePlan, envelope, decode, subject, projection, inventoryDigest } from "../season-import-plan.mjs";
import { assertDisposable, assertOwned, assertDestinationEmptyOfBusiness, writeItems, scan, readOnlyRepositoryClient, collectOwnedPlayers } from "../season-import-rehearsal.mjs";
import { BatchGetItemCommand, GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";

const at = "2026-10-03T00:00:00Z", name = "3fc-import-rehearsal-12345678-1234-1234-1234-123456789012";
const scope = { leagueId: "league", seasonId: "winter", excludedGameIds: ["early"], adminEmails: ["organiser@example.invalid", "second@example.invalid"] };
function fixture() {
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
