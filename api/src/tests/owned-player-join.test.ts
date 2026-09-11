import assert from "node:assert/strict";
import test from "node:test";
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { OwnedPlayerJoinService } from "../data/owned-player-join.js";
import { PlayerIdentityPlanner, PlayerIdentityError, identityItem, identityDirectorySk, identityLeagueSk } from "../data/player-identity.js";
import { readPlayerClaimsRevision, advancePlayerClaimsRevision } from "../data/player-claims-revision.js";
import { playerClaimSk } from "../data/keys.js";

type Item = Record<string, AttributeValue>;
const NOW = "2026-09-12T00:00:00.000Z", CODE = "ABCDEF23";
class Client {
  items = new Map<string, Item>();
  before: (() => void) | null = null;
  lost = false;
  transactions = 0;
  key(pk: string, sk: string) { return JSON.stringify([pk, sk]); }
  item(pk: string, sk: string) { return this.items.get(this.key(pk, sk)); }
  seed(pk: string, sk: string, type: string, data: unknown) { this.items.set(this.key(pk, sk), identityItem(pk, sk, type, data, NOW)); }
  data(pk: string, sk: string) { return JSON.parse(this.item(pk, sk)!.data!.S!); }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetItemCommand) return { Item: structuredClone(this.item(command.input.Key!.pk!.S!, command.input.Key!.sk!.S!)) };
    if (command instanceof QueryCommand) {
      const pk = command.input.ExpressionAttributeValues![":pk"]!.S!, prefix = command.input.ExpressionAttributeValues![":prefix"]!.S!;
      const start = command.input.ExclusiveStartKey?.sk?.S;
      const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
      const all = [...this.items.values()].filter(i => i.pk!.S === pk && i.sk!.S!.startsWith(prefix) && (!start || compare(i.sk!.S!, start) > 0))
        .sort((a, b) => compare(a.sk!.S!, b.sk!.S!));
      const page = all.slice(0, command.input.Limit), last = page.at(-1);
      return { Items: structuredClone(page), ...(all.length > page.length && last ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
    }
    if (command instanceof TransactWriteItemsCommand) {
      this.transactions++; const hook = this.before; this.before = null; hook?.();
      for (const action of command.input.TransactItems!) {
        const operation = action.Put ?? action.ConditionCheck!;
        const key = action.Put?.Item ?? action.ConditionCheck!.Key!;
        const current = this.item(key!.pk!.S!, key!.sk!.S!);
        const invalid = operation.ConditionExpression?.includes("attribute_not_exists") ? Boolean(current)
          : !current || current.data?.S !== operation.ExpressionAttributeValues?.[":data"]?.S || current.entityType?.S !== operation.ExpressionAttributeValues?.[":type"]?.S;
        if (invalid) throw Object.assign(new Error("changed"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
      }
      for (const action of command.input.TransactItems!) if (action.Put) this.items.set(this.key(action.Put.Item!.pk!.S!, action.Put.Item!.sk!.S!), structuredClone(action.Put.Item!));
      if (this.lost) { this.lost = false; throw new Error("lost committed reply"); }
      return {};
    }
    throw new Error("Unsupported fixture command");
  }
}
function fixture(ids = ["a"], owner = "account") {
  const client = new Client();
  client.seed("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "fenced", coverage: "verified", epoch: "epoch", writerVersion: 1 });
  client.seed(`JOIN_CODE#${CODE}`, "METADATA", "gameJoinCode", { gameId: "game", joinCode: CODE });
  client.seed("GAME#game", "METADATA", "game", { gameId: "game", leagueId: "league", seasonId: "season", gameStartTs: NOW, joinCode: CODE, status: "finished" });
  client.seed("LEAGUE#league", "METADATA", "league", { leagueId: "league", name: "League" });
  client.seed("LEAGUE#league", "PLAYER_DIRECTORY", "playerDirectoryRevision", { revision: "directory" });
  client.seed("LEAGUE#league", "SEASON#season", "season", { leagueId: "league", seasonId: "season", name: "Season" });
  for (const id of ids) {
    client.seed(`PLAYER#${id}`, "PROFILE", "player", { playerId: id, nickname: id, claimedByUserId: owner });
    client.seed(`PLAYER#${id}`, "IDENTITY", "playerIdentity", { playerId: id, rootId: id, members: [id], identityVersion: 0, writeVersion: "v", displayName: id, formerNames: [] });
    client.seed(`PLAYER#${id}`, identityLeagueSk("league"), "playerLeagueMembership", { playerId: id, leagueId: "league" });
    client.seed("LEAGUE#league", identityDirectorySk(id), "leaguePlayer", { playerId: id, nickname: id, active: true, formerNames: [], seasonIds: ["season"] });
    client.seed(`USER#${owner}`, playerClaimSk(id), "playerClaim", { playerId: id, userId: owner });
  }
  const planner = new PlayerIdentityPlanner(client, "fixture");
  const service = new OwnedPlayerJoinService(client, "fixture", () => NOW, async (game, id, _name, now) => {
    const control = await planner.readControl(), identity = await planner.resolve(id), original = await planner.registeredOriginal(identity, game.gameId);
    return { identity, playerId: original ?? identity.root.value.playerId, actions: [planner.writableControl(control), ...planner.planRevision(identity, now)] };
  }, true);
  return { client, service };
}
const request = { joinCode: CODE, userId: "account", playerId: "a", idempotencyKey: "request-1" };

test("owned pagination follows DynamoDB UTF-8 order across supplementary IDs", async () => {
  const ids = ["\uE000", "😀", "😁"], { service } = fixture(ids);
  const found: string[] = []; let cursor: string | undefined;
  for (let index = 0; index < 5; index++) {
    const page = await service.list({ joinCode: CODE, userId: "account", cursor, limit: 1 });
    found.push(...page.players.map(player => player.playerId));
    if (page.complete) break;
    cursor = page.cursor!;
  }
  assert.deepEqual(found, ids);
});

test("new empty league uses a fenced absent directory revision, not unavailable or stale completeness", async () => {
  const { client, service } = fixture([]);
  client.items.delete(client.key("LEAGUE#league", "PLAYER_DIRECTORY"));
  const first = await service.list({ joinCode: CODE, userId: "account" });
  assert.deepEqual(first.players, []); assert.equal(first.complete, false);
  const second = await service.list({ joinCode: CODE, userId: "account", cursor: first.cursor! });
  assert.deepEqual(second.players, []); assert.equal(second.complete, true);
  client.seed("LEAGUE#league", "PLAYER_DIRECTORY", "playerDirectoryRevision", { revision: "first-membership" });
  await assert.rejects(service.list({ joinCode: CODE, userId: "account", cursor: first.cursor! }), /changed/);
});

test("owned discovery does not mark a filtered or first-namespace page complete", async () => {
  const long = "x".repeat(1025), { client, service } = fixture(["a", "b", long]);
  client.items.delete(client.key("LEAGUE#league", identityDirectorySk("a")));
  let cursor: string | undefined, complete = false;
  const found: string[] = [];
  for (let i = 0; i < 5 && !complete; i++) {
    const page = await service.list({ joinCode: CODE, userId: "account", cursor, limit: 1 });
    if (i === 0) { assert.deepEqual(page.players, []); assert.equal(page.complete, false); assert(page.cursor); }
    found.push(...page.players.map(p => p.playerId)); cursor = page.cursor ?? undefined; complete = page.complete;
  }
  assert.equal(complete, true); assert.deepEqual(found, ["b", long]);
});

test("legacy-email indexes are scoped to trusted aliases and cursor binds both revisions", async () => {
  const { client, service } = fixture(["a"], "old@example.invalid");
  const input = { joinCode: CODE, userId: "subject", userIds: ["subject", "old@example.invalid"] };
  let page = await service.list(input);
  assert.equal(page.complete, false); assert.equal(page.players.length, 0);
  page = await service.list({ ...input, cursor: page.cursor! });
  page = await service.list({ ...input, cursor: page.cursor! });
  assert.equal(page.players[0].playerId, "a");
  const revision = await readPlayerClaimsRevision(client, "fixture", "old@example.invalid");
  await client.send(new TransactWriteItemsCommand({ TransactItems: [advancePlayerClaimsRevision("fixture", revision, NOW)] }));
  await assert.rejects(service.list({ ...input, cursor: page.cursor! }), /changed/);
  await assert.rejects(service.list({ ...input, userId: "another", userIds: ["another"], cursor: page.cursor! }), PlayerIdentityError);
});

test("same-account join supports finished games, has immutable replay and creates no new profile", async () => {
  const { client, service } = fixture();
  const profile = structuredClone(client.item("PLAYER#a", "PROFILE"));
  client.lost = true;
  await assert.rejects(service.join(request), /lost committed reply/);
  const receipt = [...client.items.values()].find(i => i.entityType?.S === "ownedPlayerJoinReceipt")!;
  const bytes = JSON.stringify(receipt);
  const result = await service.join(request);
  assert.equal(result.player.playerId, "a"); assert.equal(result.alreadyRegistered, false);
  assert.equal(JSON.stringify([...client.items.values()].find(i => i.entityType?.S === "ownedPlayerJoinReceipt")), bytes);
  assert.deepEqual(client.item("PLAYER#a", "PROFILE"), profile);
  assert.equal([...client.items.values()].filter(i => i.entityType?.S === "gamePlayer").length, 1);
  await assert.rejects(service.join({ ...request, playerId: "b" }), PlayerIdentityError);
});

test("concurrent distinct keys converge on one registration", async () => {
  const { client, service } = fixture();
  const results = await Promise.all([service.join(request), service.join({ ...request, idempotencyKey: "other" })]);
  assert(results.every(r => r.player.playerId === "a"));
  assert.deepEqual(results.map(r => r.alreadyRegistered).sort(), [false, true]);
  assert.equal([...client.items.values()].filter(i => i.entityType?.S === "gamePlayer").length, 1);
  assert.equal([...client.items.values()].filter(i => i.entityType?.S === "ownedPlayerJoinReceipt").length, 2);
});

test("same-owner consolidation after commit retains the submitted alias receipt", async () => {
  const { client, service } = fixture(["a", "b"]);
  const committed = await service.join(request);
  const receipt = JSON.stringify([...client.items.values()].find(i => i.entityType?.S === "ownedPlayerJoinReceipt"));
  client.seed("PLAYER#b", "IDENTITY", "playerIdentity", { ...client.data("PLAYER#b", "IDENTITY"), members: ["a", "b"], displayName: "Combined", identityVersion: 1 });
  client.seed("PLAYER#a", "IDENTITY", "playerIdentity", { ...client.data("PLAYER#a", "IDENTITY"), rootId: "b", members: [], identityVersion: 1 });
  client.seed("LEAGUE#league", identityDirectorySk("a"), "leaguePlayer", { ...client.data("LEAGUE#league", identityDirectorySk("a")), active: false });
  assert.deepEqual(await service.join(request), committed);
  assert.equal(JSON.stringify([...client.items.values()].find(i => i.entityType?.S === "ownedPlayerJoinReceipt")), receipt);
  await assert.rejects(service.join({ ...request, idempotencyKey: "new-request" }), /changed/);
  client.items.delete(client.key(`JOIN_CODE#${CODE}`, "METADATA"));
  await assert.rejects(service.join(request), /unavailable/);
});

test("historical alias registration and assigned team survive canonical self-join and replay", async () => {
  const { client, service } = fixture(["a", "b"]);
  client.seed("PLAYER#a", "IDENTITY", "playerIdentity", { ...client.data("PLAYER#a", "IDENTITY"), members: ["a", "b"] });
  client.seed("PLAYER#b", "IDENTITY", "playerIdentity", { ...client.data("PLAYER#b", "IDENTITY"), rootId: "a", members: [] });
  client.seed("GAME#game", "PLAYER#b", "gamePlayer", { gameId: "game", playerId: "b" });
  client.seed("GAME#game", "ROSTER#red#b", "roster", { gameId: "game", playerId: "b", teamId: "red" });
  client.seed("GAME#game", "TEAM#red", "gameTeam", { gameId: "game", teamId: "red", name: "Red", color: "#ff0000" });
  const roster = structuredClone(client.item("GAME#game", "ROSTER#red#b"));
  const result = await service.join(request);
  assert.equal(result.player.playerId, "b"); assert.equal(result.team?.teamId, "red"); assert.equal(result.alreadyRegistered, true);
  assert.deepEqual(await service.join(request), result);
  assert.equal(client.item("GAME#game", "PLAYER#a"), undefined);
  assert.deepEqual(client.item("GAME#game", "ROSTER#red#b"), roster);
});

for (const boundary of ["owner", "deleted", "rotated", "paused"]) test(`join blocks ${boundary} transaction-boundary change without receipt`, async () => {
  const { client, service } = fixture();
  client.before = () => {
    if (boundary === "owner") client.seed("PLAYER#a", "PROFILE", "player", { ...client.data("PLAYER#a", "PROFILE"), claimedByUserId: "other" });
    if (boundary === "deleted") client.items.delete(client.key("GAME#game", "METADATA"));
    if (boundary === "rotated") client.items.delete(client.key(`JOIN_CODE#${CODE}`, "METADATA"));
    if (boundary === "paused") client.seed("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "paused", coverage: "unknown", epoch: "pause", writerVersion: 1 });
  };
  await assert.rejects(service.join(request), PlayerIdentityError);
  assert.equal(client.item("GAME#game", "PLAYER#a"), undefined);
  assert.equal([...client.items.values()].filter(i => i.entityType?.S === "ownedPlayerJoinReceipt").length, 0);
});

test("disabled returning join is closed while claims revision remains writable", async () => {
  const { client } = fixture();
  const disabled = new OwnedPlayerJoinService(client, "fixture", () => NOW, async () => { throw new Error("must not plan"); });
  await assert.rejects(disabled.list({ joinCode: CODE, userId: "account" }), /temporarily unavailable/);
  await assert.rejects(disabled.join(request), /temporarily unavailable/);
  const snapshot = await readPlayerClaimsRevision(client, "fixture", "account");
  await client.send(new TransactWriteItemsCommand({ TransactItems: [advancePlayerClaimsRevision("fixture", snapshot, NOW)] }));
  assert.notEqual((await readPlayerClaimsRevision(client, "fixture", "account")).value.revision, "legacy");
  await assert.rejects(client.send(new TransactWriteItemsCommand({ TransactItems: [advancePlayerClaimsRevision("fixture", snapshot, NOW)] })), /changed/);
});
