import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AuthSessionRecord } from "../auth/magic-link.js";
import { handleLocalPlayerDirectoryRoute, handleLocalPlayerProofRoute } from "../server.js";
import type { PlayerDirectoryRepository } from "../player-directory-routes.js";
import type { PlayerProofRepository } from "../player-proof-routes.js";

test("directory and league invitation HTTP adapters parse real request streams and preserve private headers", async () => {
  const calls: string[] = [];
  const player = { playerId: "opaque/#% player", nickname: "Kesh", claimed: false, seasons: [], hasMoreSeasons: false };
  const directory: PlayerDirectoryRepository = {
    async listLeaguePlayers(input) { assert.equal(input.leagueId, "league/#%"); calls.push("list"); return { players: [input.includeGames ? {
      ...player, games: [{ gameId: "game", kickoffAt: "2026-09-12T00:00:00.000Z", seasonId: "season" }], gamesIncomplete: true,
    } : player], cursor: null }; },
    async createLeaguePlayer(input) { calls.push("create"); return { ...player, playerId: input.playerId, nickname: input.nickname }; },
    async addExistingLeaguePlayer(input) { calls.push("register"); return { playerId: input.playerId, alreadyInGame: false }; },
    async removeGamePlayer(input) { assert.equal(input.expectedRegistrationRevision, "registration-revision"); calls.push("remove"); return { entityType: "rosterRemoval", gameId: input.gameId, leagueId: "league/#%",
      playerId: input.playerId, teamId: "blue", removedAt: "2026-09-21T01:02:03.000Z", requestHash: "private",
      actorRef: "private", actorRole: "scorekeeper", createdAt: "2026-09-21T01:02:03.000Z", updatedAt: "2026-09-21T01:02:03.000Z" }; },
  };
  const proofs = { async getPlayerInvitation(input: Parameters<PlayerProofRepository["getPlayerInvitation"]>[0]) {
    assert.equal(input.scope, "league"); assert.equal(input.leagueId, "league/#%"); assert.equal(input.playerId, player.playerId);
    calls.push("invitation"); return null;
  } } as PlayerProofRepository;
  const session = { sessionId: "fixture", email: "fixture@example.com", subject: "fixture" } as AuthSessionRecord;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const common = { request, response, method: request.method!, route: url.pathname,
      rawQueryString: url.search.slice(1), session: request.headers.cookie === "fixture=valid" ? session : null };
    const run = url.pathname.startsWith("/v1/player-proofs/")
      ? handleLocalPlayerProofRoute({ ...common, playerRepository: proofs })
      : handleLocalPlayerDirectoryRoute({ ...common, playerRepository: directory });
    void run.catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const query = new URLSearchParams({ leagueId: "league/#%" });
  const headers = { cookie: "fixture=valid", "content-type": "application/json" };
  try {
    const unsigned = await fetch(`${base}/v1/league-players?${query}`);
    assert.equal(unsigned.status, 401); await unsigned.arrayBuffer(); assert.deepEqual(calls, []);
    const listing = await fetch(`${base}/v1/league-players?${query}`, { headers });
    assert.equal(listing.status, 200); assert.equal(listing.headers.get("cache-control"), "no-store");
    assert.equal(listing.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(await listing.json(), { players: [player], cursor: null });
    const enriched = await fetch(`${base}/v1/league-players?${query}&includeGames=true&limit=10`, { headers });
    assert.equal(enriched.status, 200);
    assert.deepEqual((await enriched.json() as { players: unknown[] }).players, [{ ...player,
      games: [{ gameId: "game", kickoffAt: "2026-09-12T00:00:00.000Z", seasonId: "season" }], gamesIncomplete: true }]);
    for (const suffix of ["includeGames=yes", "includeGames=true&limit=11", "includeGames=true&includeGames=false"]) {
      const badContext = await fetch(`${base}/v1/league-players?${query}&${suffix}`, { headers });
      assert.equal(badContext.status, 400); await badContext.arrayBuffer();
    }
    const created = await fetch(`${base}/v1/league-players?${query}`, { headers, method: "POST", body: JSON.stringify({ playerId: player.playerId, nickname: "Kesh" }) });
    assert.equal(created.status, 201); await created.arrayBuffer();
    const registration = await fetch(`${base}/v1/game-player-registrations?gameId=game`, { headers, method: "POST", body: JSON.stringify({ playerId: player.playerId }) });
    assert.equal(registration.status, 200); await registration.arrayBuffer();
    const removalUrl = new URL(`${base}/v1/games/game/player-registration`);
    removalUrl.searchParams.set("playerId", player.playerId);
    removalUrl.searchParams.set("registrationRevision", "registration-revision");
    const removal = await fetch(removalUrl, { headers: { ...headers,
      "idempotency-key": "removal-fixture-0001" }, method: "DELETE" });
    assert.equal(removal.status, 200); assert.deepEqual(await removal.json(), { removal: { gameId: "game", playerId: player.playerId,
      teamId: "blue", removedAt: "2026-09-21T01:02:03.000Z" } });
    const missingKey = await fetch(removalUrl, { headers, method: "DELETE" });
    assert.equal(missingKey.status, 400); await missingKey.arrayBuffer();
    const missingRevision = new URL(removalUrl); missingRevision.searchParams.delete("registrationRevision");
    const staleUnsafe = await fetch(missingRevision, { headers: { ...headers, "idempotency-key": "unsafe-without-revision" }, method: "DELETE" });
    assert.equal(staleUnsafe.status, 400); await staleUnsafe.arrayBuffer();
    const malformed = await fetch(`${base}/v1/league-players?${query}`, { headers, method: "POST", body: "{" });
    assert.equal(malformed.status, 400); await malformed.arrayBuffer();
    query.set("playerId", player.playerId);
    const invitation = await fetch(`${base}/v1/player-proofs/league-invitation?${query}`, { headers });
    assert.equal(invitation.status, 200); assert.deepEqual(await invitation.json(), { invitation: null });
    assert.equal(invitation.headers.get("cache-control"), "no-store");
    const invalid = await fetch(`${base}/v1/player-proofs/league-invitation?${query}&gameId=foreign`, { headers });
    assert.equal(invalid.status, 400); await invalid.arrayBuffer();
    assert.deepEqual(calls, ["list", "list", "create", "register", "remove", "invitation"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
