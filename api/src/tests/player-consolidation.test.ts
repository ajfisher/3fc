import assert from "node:assert/strict";
import test from "node:test";
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type AttributeValue, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { PlayerConsolidationService } from "../data/player-consolidation.js";
import { identityItem, identityDirectorySk, identityGameSk, identityLeagueSk, PlayerIdentityError } from "../data/player-identity.js";
import { playerClaimSk } from "../data/keys.js";

type Item = Record<string, AttributeValue>;
const NOW = "2026-09-12T00:00:00.000Z";
class FixtureClient {
  readonly items = new Map<string, Item>();
  beforeTransaction: (() => void) | null = null;
  loseNextTransactionResponse = false;
  queryOverride: ((command: QueryCommand) => unknown) | null = null;
  readonly transactions: TransactWriteItem[][] = [];
  key(pk: string, sk: string): string { return JSON.stringify([pk, sk]); }
  seed(pk: string, sk: string, type: string, value: unknown): void { this.items.set(this.key(pk, sk), identityItem(pk, sk, type, value, NOW)); }
  read(pk: string, sk: string): Item | undefined { return this.items.get(this.key(pk, sk)); }
  data(pk: string, sk: string): Record<string, unknown> { return JSON.parse(this.read(pk, sk)!.data!.S!); }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetItemCommand) return { Item: structuredClone(this.read(command.input.Key!.pk!.S!, command.input.Key!.sk!.S!)) };
    if (command instanceof QueryCommand) {
      if (this.queryOverride) return this.queryOverride(command);
      const pk = command.input.ExpressionAttributeValues![":pk"]!.S!;
      const all = [...this.items.values()].filter(item => item.pk!.S === pk).sort((a, b) => a.sk!.S!.localeCompare(b.sk!.S!));
      const start = command.input.ExclusiveStartKey?.sk?.S;
      const remaining = start === undefined ? all : all.filter(item => item.sk!.S!.localeCompare(start) > 0);
      const page = remaining.slice(0, command.input.Limit ?? 50), last = page.at(-1);
      return { Items: structuredClone(page), ...(remaining.length > page.length && last ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
    }
    if (command instanceof TransactWriteItemsCommand) {
      const hook = this.beforeTransaction; this.beforeTransaction = null; hook?.();
      const actions = command.input.TransactItems!; this.transactions.push(structuredClone(actions));
      for (const action of actions) {
        const op = action.Put ?? action.Delete ?? action.ConditionCheck!;
        const key = action.Put?.Item ?? action.Delete?.Key ?? action.ConditionCheck!.Key!;
        const current = this.read(key!.pk!.S!, key!.sk!.S!);
        const missing = op.ConditionExpression?.includes("attribute_not_exists") === true;
        const values = op.ExpressionAttributeValues;
        if (missing ? Boolean(current) : !current || current.data?.S !== values?.[":data"]?.S || current.entityType?.S !== values?.[":type"]?.S) {
          throw Object.assign(new Error("snapshot changed"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
        }
      }
      for (const action of actions) {
        if (action.Put) this.items.set(this.key(action.Put.Item!.pk!.S!, action.Put.Item!.sk!.S!), structuredClone(action.Put.Item!));
        if (action.Delete) this.items.delete(this.key(action.Delete.Key!.pk!.S!, action.Delete.Key!.sk!.S!));
      }
      if (this.loseNextTransactionResponse) {
        this.loseNextTransactionResponse = false;
        throw new Error("Committed response lost");
      }
      return {};
    }
    throw new Error("Unexpected fixture command");
  }
}
function fixture(owner: string | null = null, ids = ["a", "b"]) {
  const client = new FixtureClient();
  client.seed("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "fenced", coverage: "verified", epoch: "epoch", writerVersion: 1 });
  client.seed("LEAGUE#league", "METADATA", "league", { leagueId: "league", name: "League" });
  client.seed("LEAGUE#league", "ACL#USER#admin", "acl", { leagueId: "league", userId: "admin", role: "admin" });
  client.seed("LEAGUE#league", "PLAYER_DIRECTORY", "playerDirectoryRevision", { revision: "directory" });
  for (const [index, id] of ids.entries()) {
    const claimed = index === 0 ? owner : null;
    client.seed(`PLAYER#${id}`, "PROFILE", "player", { playerId: id, nickname: `Player ${index}`, claimedByUserId: claimed });
    client.seed(`PLAYER#${id}`, "IDENTITY", "playerIdentity", { playerId: id, rootId: id, members: [id], identityVersion: 0,
      writeVersion: `write-${id}`, displayName: `Player ${index}`, formerNames: [] });
    client.seed(`PLAYER#${id}`, identityLeagueSk("league"), "playerLeagueMembership", { playerId: id, leagueId: "league" });
    client.seed(`PLAYER#${id}`, identityGameSk(`game-${index}`), "playerGameMembership", { playerId: id, gameId: `game-${index}`,
      leagueId: "league", seasonId: "season", gameStartTs: NOW });
    client.seed(`GAME#game-${index}`, `PLAYER#${id}`, "gamePlayer", { playerId: id, gameId: `game-${index}` });
    client.seed("LEAGUE#league", identityDirectorySk(id), "leaguePlayer", { playerId: id, nickname: `Player ${index}`,
      active: true, formerNames: [], seasonIds: ["season"], hasMoreSeasons: false });
    if (claimed) client.seed(`USER#${claimed}`, playerClaimSk(id), "playerClaim", { userId: claimed, playerId: id });
  }
  const service = new PlayerConsolidationService(client, "fixture", () => NOW, true);
  const input = { proposalId: "proposal_abcdefghijklmnop", leagueId: "league", playerIds: ids,
    retainedPlayerId: ids[0], nickname: "Retained", userIds: ["admin"] };
  return { client, service, input };
}

test("unclaimed consolidation preserves historical rows and replays exactly once", async () => {
  const { client, service, input } = fixture();
  const raw = structuredClone(client.read("PLAYER#b", "PROFILE"));
  const registration = structuredClone(client.read("GAME#game-1", "PLAYER#b"));
  const preview = await service.preview(input);
  assert.equal(preview.status, "ready"); assert.equal(preview.canCommit, true);
  const result = await service.commit({ proposalId: input.proposalId, userIds: ["admin"] });
  assert.equal(result.status, "committed");
  assert.deepEqual(client.data("PLAYER#a", "IDENTITY").members, ["a", "b"]);
  assert.equal(client.data("PLAYER#b", "IDENTITY").rootId, "a");
  assert.deepEqual(client.read("PLAYER#b", "PROFILE"), raw);
  assert.deepEqual(client.read("GAME#game-1", "PLAYER#b"), registration);
  const count = client.transactions.length;
  assert.equal((await service.commit({ proposalId: input.proposalId, userIds: ["admin"] })).status, "committed");
  assert.equal(client.transactions.length, count);
  assert(client.transactions.every(tx => tx.length <= 100));
});

test("claimed history requires exact owner approval; private view does not expose ownership IDs", async () => {
  const { client, service, input } = fixture("private-owner@example.invalid");
  const preview = await service.preview(input);
  assert.equal(preview.status, "pending_approval"); assert.equal(preview.canCommit, false);
  assert(!JSON.stringify(preview).includes("private-owner"));
  await assert.rejects(service.decide({ proposalId: input.proposalId, decision: "approve", userIds: ["intruder"] }), PlayerIdentityError);
  await assert.rejects(service.commit({ proposalId: input.proposalId, userIds: ["admin"] }), /approve/);
  assert.equal((await service.decide({ proposalId: input.proposalId, decision: "approve", userIds: ["private-owner@example.invalid"] })).status, "ready");
  assert.equal((await service.commit({ proposalId: input.proposalId, userIds: ["admin"] })).status, "committed");
  assert.equal(client.data("PLAYER#a", "PROFILE").claimedByUserId, "private-owner@example.invalid");
});

test("decline is final and cannot be overridden by an organiser", async () => {
  const { service, input } = fixture("owner"); await service.preview(input);
  assert.equal((await service.decide({ proposalId: input.proposalId, decision: "decline", userIds: ["owner"] })).status, "declined");
  await assert.rejects(service.decide({ proposalId: input.proposalId, decision: "approve", userIds: ["owner"] }), /already been decided/);
  await assert.rejects(service.commit({ proposalId: input.proposalId, userIds: ["admin"] }), PlayerIdentityError);
});

for (const conflict of ["overlap", "foreign", "owners", "coverage"]) test(`consolidation blocks ${conflict} without writing proposals`, async () => {
  const { client, service, input } = fixture(conflict === "owners" ? "owner-a" : null);
  if (conflict === "overlap") client.seed("PLAYER#b", identityGameSk("game-0"), "playerGameMembership",
    { playerId: "b", gameId: "game-0", leagueId: "league", seasonId: "season", gameStartTs: NOW });
  if (conflict === "foreign") client.seed("PLAYER#b", identityLeagueSk("private-foreign"), "playerLeagueMembership", { playerId: "b", leagueId: "private-foreign" });
  if (conflict === "owners") client.seed("PLAYER#b", "PROFILE", "player", { playerId: "b", nickname: "Player 1", claimedByUserId: "owner-b" });
  if (conflict === "coverage") client.seed("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "fenced", coverage: "unknown", epoch: "epoch", writerVersion: 1 });
  await assert.rejects(service.preview(input), (error: unknown) => error instanceof PlayerIdentityError && !error.message.includes("private-foreign"));
  assert.equal(client.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "PROPOSAL"), undefined);
});

test("a registration at the commit transaction boundary invalidates approval without partial alias writes", async () => {
  const { client, service, input } = fixture("owner"); await service.preview(input);
  await service.decide({ proposalId: input.proposalId, decision: "approve", userIds: ["owner"] });
  client.beforeTransaction = () => client.seed("PLAYER#b", "IDENTITY", "playerIdentity", { ...client.data("PLAYER#b", "IDENTITY"), writeVersion: "new-membership" });
  await assert.rejects(service.commit({ proposalId: input.proposalId, userIds: ["admin"] }), /changed/);
  assert.equal(client.data("PLAYER#b", "IDENTITY").rootId, "b");
  assert.equal(client.data(`PLAYER_CONSOLIDATION#${input.proposalId}`, "PROPOSAL").state, "ready");
  assert.equal(client.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "AUDIT"), undefined);
});

test("20-member atomic operation fits and 21-member proposals are rejected", async () => {
  const { client, service, input } = fixture(null, Array.from({ length: 20 }, (_, i) => `p${i.toString().padStart(2, "0")}`));
  await service.preview(input); await service.commit({ proposalId: input.proposalId, userIds: ["admin"] });
  assert.equal((client.data(`PLAYER#${input.retainedPlayerId}`, "IDENTITY").members as string[]).length, 20);
  const another = fixture(null, Array.from({ length: 21 }, (_, i) => `p${i}`));
  await assert.rejects(another.service.preview(another.input), PlayerIdentityError);
});

test("disablement blocks new changes but retains authorised committed receipt recovery", async () => {
  const { client, service, input } = fixture(); await service.preview(input); await service.commit({ proposalId: input.proposalId, userIds: ["admin"] });
  const disabled = new PlayerConsolidationService(client, "fixture", () => NOW, false);
  assert.equal((await disabled.commit({ proposalId: input.proposalId, userIds: ["admin"] })).status, "committed");
  await assert.rejects(disabled.preview({ ...input, proposalId: "proposal_abcdefghijklmnop2" }), /temporarily unavailable/);
});

test("a second consolidation checks the full existing alias closure", async () => {
  const { client, service, input } = fixture(null, ["a", "b", "c"]);
  await service.preview({ ...input, playerIds: ["a", "b"] });
  await service.commit({ proposalId: input.proposalId, userIds: ["admin"] });
  client.seed("PLAYER#b", identityLeagueSk("foreign"), "playerLeagueMembership", { playerId: "b", leagueId: "foreign" });
  await assert.rejects(service.preview({ ...input, proposalId: "proposal_abcdefghijklmnop2", playerIds: ["a", "c"] }),
    (error: unknown) => error instanceof PlayerIdentityError && error.code === "consolidation_external_history");
  assert.equal(client.data("PLAYER#c", "IDENTITY").rootId, "c");
});

test("membership queries follow pagination before allowing a proposal", async () => {
  const { client, service, input } = fixture();
  for (let i = 0; i < 60; i++) client.seed("PLAYER#b", identityGameSk(`extra-${i}`), "playerGameMembership",
    { playerId: "b", gameId: `extra-${i}`, leagueId: "league", seasonId: "season", gameStartTs: NOW });
  client.seed("PLAYER#b", identityLeagueSk("foreign"), "playerLeagueMembership", { playerId: "b", leagueId: "foreign" });
  await assert.rejects(service.preview(input), (error: unknown) => error instanceof PlayerIdentityError && error.code === "consolidation_external_history");
  assert.equal(client.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "PROPOSAL"), undefined);
});

test("hashed long-ID owner index is retained and alias indexes are removed atomically", async () => {
  const long = "x".repeat(1025);
  const { client, service, input } = fixture("owner", [long, "b"]);
  // The long standalone identity is readable but cannot have a physical game
  // registration. Its shorter alias supplies the retained historical game.
  client.items.delete(client.key(`PLAYER#${long}`, identityGameSk("game-0")));
  client.items.delete(client.key("GAME#game-0", `PLAYER#${long}`));
  client.seed("PLAYER#b", "PROFILE", "player", { playerId: "b", nickname: "Player 1", claimedByUserId: "owner" });
  client.seed("USER#owner", playerClaimSk("b"), "playerClaim", { userId: "owner", playerId: "b" });
  await service.preview(input);
  await service.decide({ proposalId: input.proposalId, decision: "approve", userIds: ["owner"] });
  await service.commit({ proposalId: input.proposalId, userIds: ["admin"] });
  assert.equal(client.data("USER#owner", playerClaimSk(long)).playerId, long);
  assert.equal(client.read("USER#owner", playerClaimSk("b")), undefined);
});

test("20 claimed members fit one transaction and retain exactly one owner index", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `claimed-${i}`);
  const { client, service, input } = fixture("owner", ids);
  for (const id of ids) {
    client.seed(`PLAYER#${id}`, "PROFILE", "player", { ...client.data(`PLAYER#${id}`, "PROFILE"), claimedByUserId: "owner" });
    client.seed("USER#owner", playerClaimSk(id), "playerClaim", { userId: "owner", playerId: id });
  }
  await service.preview(input);
  await service.decide({ proposalId: input.proposalId, decision: "approve", userIds: ["owner"] });
  await service.commit({ proposalId: input.proposalId, userIds: ["admin"] });
  assert(client.transactions.every(tx => tx.length <= 100));
  assert.deepEqual(client.data(`PLAYER#${ids[0]}`, "IDENTITY").members, [...ids].sort());
  for (const id of ids) {
    assert.equal(client.data(`PLAYER#${id}`, "IDENTITY").rootId, ids[0]);
    assert.equal(Boolean(client.read("USER#owner", playerClaimSk(id))), id === ids[0]);
  }
  const audit = client.data(`PLAYER_CONSOLIDATION#${input.proposalId}`, "AUDIT");
  assert.equal((audit.indexesBefore as unknown[]).length, 20);
  assert.deepEqual(audit.indexesAfter, [{ userId: "owner", playerId: ids[0] }]);
});

test("overlapping proposals have one winner and leave no loser audit or partial aliases", async () => {
  const { client, service, input } = fixture(null, ["a", "b", "c"]);
  const second = { ...input, proposalId: "proposal_overlapping_second", playerIds: ["b", "c"], retainedPlayerId: "b" };
  await service.preview({ ...input, playerIds: ["a", "b"] });
  await service.preview(second);
  await service.commit({ proposalId: input.proposalId, userIds: ["admin"] });
  const before = JSON.stringify([...client.items]);
  await assert.rejects(service.commit({ proposalId: second.proposalId, userIds: ["admin"] }), PlayerIdentityError);
  assert.equal(JSON.stringify([...client.items]), before);
  assert.equal(client.data("PLAYER#c", "IDENTITY").rootId, "c");
  assert.equal(client.read(`PLAYER_CONSOLIDATION#${second.proposalId}`, "AUDIT"), undefined);
  assert.equal(client.data(`PLAYER_CONSOLIDATION#${second.proposalId}`, "PROPOSAL").state, "ready");
});

test("lost committed response recovers with byte-identical receipt and audit", async () => {
  const { client, service, input } = fixture();
  await service.preview(input);
  client.loseNextTransactionResponse = true;
  await assert.rejects(service.commit({ proposalId: input.proposalId, userIds: ["admin"] }), /Committed response lost/);
  const receipt = JSON.stringify(client.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "PROPOSAL"));
  const audit = JSON.stringify(client.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "AUDIT"));
  const count = client.transactions.length;
  assert.equal((await service.commit({ proposalId: input.proposalId, userIds: ["admin"] })).status, "committed");
  assert.equal(client.transactions.length, count);
  assert.equal(JSON.stringify(client.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "PROPOSAL")), receipt);
  assert.equal(JSON.stringify(client.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "AUDIT")), audit);
});

for (const change of ["issuer demotion", "unknown coverage"]) test(`commit fences ${change} at transaction boundary`, async () => {
  const { client, service, input } = fixture();
  await service.preview(input);
  client.beforeTransaction = () => {
    if (change === "issuer demotion") client.seed("LEAGUE#league", "ACL#USER#admin", "acl", { leagueId: "league", userId: "admin", role: "viewer" });
    else client.seed("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "fenced", coverage: "unknown", epoch: "changed", writerVersion: 1 });
  };
  await assert.rejects(service.commit({ proposalId: input.proposalId, userIds: ["admin"] }), PlayerIdentityError);
  assert.equal(client.data("PLAYER#a", "IDENTITY").rootId, "a");
  assert.equal(client.data("PLAYER#b", "IDENTITY").rootId, "b");
  assert.equal(client.data(`PLAYER_CONSOLIDATION#${input.proposalId}`, "PROPOSAL").state, "ready");
  assert.equal(client.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "AUDIT"), undefined);
});

for (const corruption of ["missing alias", "cyclic alias"]) test(`proposal rejects ${corruption} without writes`, async () => {
  const { client, service, input } = fixture();
  if (corruption === "missing alias") client.seed("PLAYER#a", "IDENTITY", "playerIdentity", { ...client.data("PLAYER#a", "IDENTITY"), members: ["a", "missing"] });
  else {
    client.seed("PLAYER#a", "IDENTITY", "playerIdentity", { ...client.data("PLAYER#a", "IDENTITY"), rootId: "b", members: [] });
    client.seed("PLAYER#b", "IDENTITY", "playerIdentity", { ...client.data("PLAYER#b", "IDENTITY"), rootId: "a", members: [] });
  }
  await assert.rejects(service.preview(input), PlayerIdentityError);
  assert.equal(client.transactions.length, 0);
});

for (const malformed of [false, true]) test(`empty membership pages ${malformed ? "reject malformed cursor" : "follow cursor and reject hidden foreign history"}`, async () => {
  const { client, service, input } = fixture();
  let queries = 0;
  client.queryOverride = command => {
    queries++;
    const pk = command.input.ExpressionAttributeValues![":pk"]!.S!;
    if (!command.input.ExclusiveStartKey) return { Items: [], LastEvaluatedKey: { pk: { S: malformed ? "PLAYER#foreign" : pk }, sk: { S: "GAME#empty" } } };
    return { Items: [identityItem(pk, identityLeagueSk("private-foreign"), "playerLeagueMembership", { playerId: pk.slice(7), leagueId: "private-foreign" }, NOW)] };
  };
  await assert.rejects(service.preview(input), (error: unknown) => error instanceof PlayerIdentityError && !error.message.includes("private-foreign"));
  assert.equal(queries, malformed ? 1 : 2);
  assert.equal(client.transactions.length, 0);
});
