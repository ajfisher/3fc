import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { publicPlayerSchema } from "../contracts/core-write.js";
import { readJoinPlayerContext, readRosterPlayerData, type PlayerReadRepository } from "../player-reads.js";
import { handleLocalJoinPlayerContextRoute } from "../server.js";

const timestamp = "2026-09-08T10:00:00.000Z";
const player = { playerId: "player-one", nickname: "Same name", createdAt: timestamp, updatedAt: timestamp };
const link = { gameId: "game-one", playerId: player.playerId, createdAt: timestamp, updatedAt: timestamp };
function fixture(overrides: Partial<PlayerReadRepository> = {}): PlayerReadRepository {
  return {
    async getGameByJoinCode(code) { return code === "ABCD2345" ? { gameId: "game-one", joinCode: code } : null; },
    async getGamePlayer(gameId, playerId) { return gameId === link.gameId && playerId === link.playerId ? link : null; },
    async getPlayer(id, options) { assert.equal(options?.consistentRead, true); return id === player.playerId ? { ...player, claimedByUserId: "private@example.com", access: { userId: "private-subject" } } : null; },
    async listGamePlayers(_id, options) { assert.deepEqual(options, { complete: true, consistentRead: true }); return [link]; },
    async listGameRoster(_id, options) { assert.deepEqual(options, { complete: true, consistentRead: true }); return []; },
    ...overrides,
  };
}

test("join context identifies exact membership without private fields, claiming or nickname resolution", async () => {
  assert.deepEqual(await readJoinPlayerContext(fixture(), "abcd2345", "player-one"), {
    statusCode: 200, payload: { gameId: "game-one", joinCode: "ABCD2345", player },
  });
  assert.equal(publicPlayerSchema.safeParse({ ...player, access: { userId: "private" } }).success, false);
  assert.equal(publicPlayerSchema.safeParse({ ...player, claimedByUserId: "private" }).success, false);
  let profileReads = 0;
  const mismatched = fixture({
    async getGamePlayer() { return { ...link, gameId: "another-game" }; },
    async getPlayer() { profileReads += 1; return player; },
  });
  const expected = { statusCode: 404, payload: { error: "not_found", message: "This player link is unavailable." } };
  assert.deepEqual(await readJoinPlayerContext(mismatched, "ABCD2345", "player-one"), expected);
  assert.equal(profileReads, 0);
  assert.deepEqual(await readJoinPlayerContext(fixture(), "ABCD2345", "same-name-but-other-id"), expected);
  assert.deepEqual(await readJoinPlayerContext(fixture(), "BCDE2345", "player-one"), expected);
  assert.deepEqual(await readJoinPlayerContext(fixture({ async getPlayer() { return null; } }), "ABCD2345", "player-one"), expected);
});

test("join context rejects malformed paths and preserves constructable opaque player IDs", async () => {
  for (const [code, id] of [["short", "player-one"], ["%E0%A4%A", "player-one"], ["ABCD2345", "%E0%A4%A"], ["ABCD2345", "%20"]]) {
    assert.equal((await readJoinPlayerContext(fixture(), code, id)).statusCode, 400);
  }
  for (const id of ["player\\one", "player/one", "player-" + "x".repeat(700), "player-\rlegacy", "player-\u0000legacy"]) {
    const opaque = fixture({
      async getGamePlayer(gameId, requestedId) { assert.equal(requestedId, id); return { ...link, gameId, playerId: id }; },
      async getPlayer(requestedId, options) { assert.equal(requestedId, id); assert.equal(options?.consistentRead, true); return { ...player, playerId: id }; },
    });
    const result = await readJoinPlayerContext(opaque, "ABCD2345", encodeURIComponent(id));
    assert.equal(result.statusCode, 200);
    assert.equal("player" in result.payload && result.payload.player.playerId, id);
  }
  const failed = await readJoinPlayerContext(fixture({ async getGamePlayer() { throw new Error("private SDK diagnostic"); } }), "ABCD2345", "player-one");
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(failed), /private|SDK/);
});

test("complete roster identities exceed recent-search cap, deduplicate and bound profile concurrency", async () => {
  const records = Array.from({ length: 45 }, (_, index) => ({ ...player, playerId: `player-${index}`, nickname: "Same name", claimedByUserId: "private@example.com" }));
  let active = 0; let peak = 0;
  const reads: string[] = [];
  const repository = fixture({
    async listGamePlayers(gameId, options) { assert.deepEqual(options, { complete: true, consistentRead: true }); return [...records, records[0]].map((entry) => ({ ...link, gameId, playerId: entry.playerId })); },
    async listGameRoster(gameId, options) { assert.deepEqual(options, { complete: true, consistentRead: true }); return records.slice(0, 21).map((entry) => ({ ...link, gameId, playerId: entry.playerId, teamId: "red" as const })); },
    async getPlayer(id, options) {
      assert.equal(options?.consistentRead, true); reads.push(id); active += 1; peak = Math.max(peak, active);
      await Promise.resolve(); active -= 1;
      return records.find((entry) => entry.playerId === id) ?? null;
    },
  });
  const result = await readRosterPlayerData(repository, "game-one");
  assert.equal(result.roster.length, 21);
  assert.equal(result.unassignedPlayers.length, 24);
  assert.equal(new Set(result.unassignedPlayers.map((entry) => entry.playerId)).size, 24);
  assert.equal(reads.length, 45); assert.equal(new Set(reads).size, 45);
  assert.ok(peak > 1 && peak <= 8); assert.equal(active, 0);
  for (const entry of result.unassignedPlayers) assert.deepEqual(Object.keys(entry).sort(), ["createdAt", "nickname", "playerId", "updatedAt"]);
  assert.doesNotMatch(JSON.stringify(result.unassignedPlayers), /private|claimedBy|access/);
  const moved = await readRosterPlayerData({ ...repository, async listGameRoster(gameId) { return records.slice(0, 22).map((entry) => ({ ...link, gameId, playerId: entry.playerId, teamId: "red" as const })); } }, "game-one");
  assert.equal(moved.unassignedPlayers.length, 23);
  assert.equal(moved.unassignedPlayers.some((entry) => entry.playerId === "player-21"), false);
});

test("roster read fails instead of inventing empty data and drains bounded failed lookups", async () => {
  await assert.rejects(readRosterPlayerData(fixture({ async getPlayer() { return null; } }), "game-one"), /could not be loaded/);
  await assert.rejects(readRosterPlayerData(fixture({ async listGamePlayers() { return [{ ...link, gameId: "other" }]; } }), "game-one"), /membership/);
  let active = 0; let reads = 0;
  await assert.rejects(readRosterPlayerData(fixture({
    async listGamePlayers() { return Array.from({ length: 30 }, (_, index) => ({ ...link, playerId: `player-${index}` })); },
    async getPlayer() { reads += 1; active += 1; await Promise.resolve(); active -= 1; throw new Error("unavailable"); },
  }), "game-one"), /could not be loaded/);
  assert.equal(active, 0); assert.equal(reads, 8);
});

test("local join context adapter requires a session and returns shared safe no-store responses", async () => {
  const request = { headers: { origin: "https://qa.3fc.football" } } as IncomingMessage;
  const session = { sessionId: "session", email: "person@example.com", createdAt: timestamp, expiresAt: "2026-09-16T10:00:00.000Z" };
  for (const signedIn of [false, true]) {
    let read = false; let code = 0; let headers: Record<string, string> = {}; let body = "";
    const response = { writeHead(status: number, values: Record<string, string>) { code = status; headers = values; }, end(value: string) { body = value; } } as unknown as ServerResponse;
    await handleLocalJoinPlayerContextRoute({ request, response, session: signedIn ? session : null,
      rawJoinCode: "ABCD2345", rawPlayerId: "player-one", playerRepository: fixture({ async getGameByJoinCode(joinCode) { read = true; return { gameId: "game-one", joinCode }; } }),
    });
    assert.equal(code, signedIn ? 200 : 401); assert.equal(read, signedIn);
    assert.equal(headers["Cache-Control"], "no-store");
    if (signedIn) assert.deepEqual(JSON.parse(body), { gameId: "game-one", joinCode: "ABCD2345", player });
    assert.doesNotMatch(body, /person@example|private@example|claimedByUserId|access/);
  }
  for (const scenario of [
    { code: "short", id: "player-one", repository: fixture(), expected: 400 },
    { code: "ABCD2345", id: "missing", repository: fixture(), expected: 404 },
    { code: "BCDE2345", id: "player-one", repository: fixture(), expected: 404 },
    { code: "ABCD2345", id: "player-one", repository: fixture({ async getGamePlayer() { throw new Error("private SDK diagnostic"); } }), expected: 503 },
  ]) {
    let code = 0; let headers: Record<string, string> = {}; let body = "";
    const response = { writeHead(status: number, values: Record<string, string>) { code = status; headers = values; }, end(value: string) { body = value; } } as unknown as ServerResponse;
    await handleLocalJoinPlayerContextRoute({ request, response, session, rawJoinCode: scenario.code, rawPlayerId: scenario.id, playerRepository: scenario.repository });
    assert.equal(code, scenario.expected); assert.equal(headers["Cache-Control"], "no-store");
    assert.doesNotMatch(body, /person@example|private|SDK|claimedByUserId|access/);
  }
});
