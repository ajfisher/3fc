import assert from "node:assert/strict";
import test from "node:test";
import { BatchGetItemCommand, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { directoryGameSamples } from "../data/player-directory-games.js";
import { identityGameSk, identityItem } from "../data/player-identity.js";

type Item = Record<string, AttributeValue>;
const now = "2026-09-12T00:00:00.000Z";
function fixture(members = ["player"]) {
  const items = new Map<string, Item>(); let queries = 0, batches = 0;
  const put = (pk: string, sk: string, type: string, data: unknown) => {
    const item = identityItem(pk, sk, type, data, now); items.set(JSON.stringify([pk, sk]), item); return item;
  };
  put("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", { mode: "fenced", coverage: "verified", epoch: "epoch", writerVersion: 1 });
  for (const member of members) put(`PLAYER#${member}`, "IDENTITY", "playerIdentity", { playerId: member, rootId: members[0],
    members: member === members[0] ? members : [], identityVersion: 1, writeVersion: "revision", displayName: member, formerNames: [] });
  const client = { async send(command: unknown) {
    if (command instanceof BatchGetItemCommand) {
      batches++; const request = command.input.RequestItems!.fixture!; assert.equal(request.ConsistentRead, true); assert(request.Keys!.length <= 100);
      return { Responses: { fixture: request.Keys!.flatMap(key => { const found = items.get(JSON.stringify([key.pk!.S, key.sk!.S])); return found ? [found] : []; }) } };
    }
    assert(command instanceof QueryCommand); queries++; assert.equal(command.input.ConsistentRead, true); assert.equal(command.input.Limit, 10);
    const pk = command.input.ExpressionAttributeValues![":pk"]!.S!, after = command.input.ExclusiveStartKey?.sk?.S;
    const matches = [...items.values()].filter(item => item.pk!.S === pk && item.sk!.S!.startsWith("GAME#") && (!after || item.sk!.S! > after))
      .sort((a, b) => a.sk!.S!.localeCompare(b.sk!.S!));
    const page = matches.slice(0, 10);
    return { Items: page, ...(matches.length > 10 ? { LastEvaluatedKey: { pk: page[9]!.pk!, sk: page[9]!.sk! } } : {}) };
  } };
  const game = (gameId: string, member = members[0]!, options: { deleted?: boolean; liveLeague?: string; registered?: boolean } = {}) => {
    put(`PLAYER#${member}`, identityGameSk(gameId), "playerGameMembership", { playerId: member, gameId, leagueId: "league", seasonId: "season", gameStartTs: "2000-01-01T00:00:00.000Z" });
    if (!options.deleted) put(`GAME#${gameId}`, "METADATA", "game", { gameId, leagueId: options.liveLeague ?? "league", seasonId: "season", gameStartTs: now });
    if (options.registered !== false) put(`GAME#${gameId}`, `PLAYER#${member}`, "gamePlayer", { gameId, playerId: member });
  };
  return { client, put, game, queries: () => queries, batches: () => batches };
}

test("directory dates use current scoped metadata and verified original registrations", async () => {
  const f = fixture(["player", "alias"]);
  f.game("live", "alias"); f.game("deleted", "player", { deleted: true });
  f.game("foreign", "player", { liveLeague: "other" }); f.game("unregistered", "player", { registered: false });
  const result = await directoryGameSamples(f.client, "fixture", { leagueId: "league", playerIds: ["player"] });
  assert.deepEqual(result.samples.get("player"), { games: [{ gameId: "live", kickoffAt: now, seasonId: "season" }], gamesIncomplete: false });
  assert.equal(result.checks.length, 2); // original control and canonical root snapshots fence later changes
  assert.equal(f.queries(), 2); assert(f.batches() <= 4);
});

test("directory game samples bound all reverse reads and truthfully mark truncation", async () => {
  const f = fixture();
  for (let index = 0; index < 401; index++) f.game(`game-${index}`);
  const result = await directoryGameSamples(f.client, "fixture", { leagueId: "league", playerIds: ["player"] });
  assert.equal(f.queries(), 40); assert.equal(result.samples.get("player")!.games.length, 20);
  assert.equal(result.samples.get("player")!.gamesIncomplete, true);
});

test("directory sample refuses contradictory original registrations in one canonical group", async () => {
  const f = fixture(["player", "alias"]); f.game("same", "player"); f.game("same", "alias");
  await assert.rejects(directoryGameSamples(f.client, "fixture", { leagueId: "league", playerIds: ["player"] }), /could not be checked/);
});

test("directory sample rejects excessive result rows before network work", async () => {
  const f = fixture();
  await assert.rejects(directoryGameSamples(f.client, "fixture", { leagueId: "league", playerIds: Array.from({ length: 11 }, (_, index) => `p${index}`) }));
  assert.equal(f.queries(), 0); assert.equal(f.batches(), 0);
});

test("optional game context budget exhaustion keeps valid directory rows with explicit incomplete context", async () => {
  const f = fixture(), original = Date.now; let calls = 0;
  try {
    Date.now = () => ++calls === 1 ? 1000 : 7000;
    const result = await directoryGameSamples(f.client, "fixture", { leagueId: "league", playerIds: ["player"] });
    assert.deepEqual(result.samples.get("player"), { games: [], gamesIncomplete: true });
    assert.deepEqual(result.checks, []); assert.equal(f.batches(), 0);
  } finally { Date.now = original; }
});
