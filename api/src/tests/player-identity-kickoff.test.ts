import assert from "node:assert/strict";
import test from "node:test";
import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { identityGameSk, identityItem, PlayerIdentityError } from "../data/player-identity.js";
import { repairMigrationKickoff } from "../data/player-identity-migration.js";

const now = "2026-09-12T00:00:00.000Z";
const game = { gameId: "game", leagueId: "league", seasonId: "season", gameStartTs: "2026-09-13T00:00:00.000Z" };
function planned(): TransactWriteItem {
  return { Put: { TableName: "fixture", Item: identityItem("PLAYER#original", identityGameSk(game.gameId), "playerGameMembership",
    { ...game, playerId: "original", registeredPlayerId: "original", gameStartTs: now }, now),
  ConditionExpression: "#data = :previous", ExpressionAttributeNames: { "#data": "data" },
  ExpressionAttributeValues: { ":previous": { S: "original snapshot" } } } };
}

test("paused kickoff repair retains original membership identity, timestamps and transaction condition", () => {
  const action = planned();
  const before = structuredClone(action);
  repairMigrationKickoff([action], "original", game);
  const data = JSON.parse(action.Put!.Item!.data!.S!);
  assert.equal(data.gameStartTs, game.gameStartTs);
  assert.equal(data.playerId, "original");
  assert.equal(data.registeredPlayerId, "original");
  assert.equal(action.Put!.Item!.createdAt!.S, now);
  assert.equal(action.Put!.ConditionExpression, before.Put!.ConditionExpression);
  assert.deepEqual(action.Put!.ExpressionAttributeValues, before.Put!.ExpressionAttributeValues);
  action.Put!.Item!.data = before.Put!.Item!.data!;
  assert.deepEqual(action, before);
});

test("kickoff repair refuses missing, duplicate or mismatched projection targets", () => {
  assert.throws(() => repairMigrationKickoff([], "original", game), PlayerIdentityError);
  assert.throws(() => repairMigrationKickoff([planned(), planned()], "original", game), PlayerIdentityError);
  const action = planned();
  const before = structuredClone(action);
  assert.throws(() => repairMigrationKickoff([action], "original", { ...game, leagueId: "other" }), PlayerIdentityError);
  assert.deepEqual(action, before);
});
