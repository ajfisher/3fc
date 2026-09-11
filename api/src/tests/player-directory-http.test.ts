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
    async listLeaguePlayers(input) { assert.equal(input.leagueId, "league/#%"); calls.push("list"); return { players: [player], cursor: null }; },
    async createLeaguePlayer(input) { calls.push("create"); return { ...player, playerId: input.playerId, nickname: input.nickname }; },
    async addExistingLeaguePlayer(input) { calls.push("register"); return { playerId: input.playerId, alreadyInGame: false }; },
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
    const created = await fetch(`${base}/v1/league-players?${query}`, { headers, method: "POST", body: JSON.stringify({ playerId: player.playerId, nickname: "Kesh" }) });
    assert.equal(created.status, 201); await created.arrayBuffer();
    const registration = await fetch(`${base}/v1/game-player-registrations?gameId=game`, { headers, method: "POST", body: JSON.stringify({ playerId: player.playerId }) });
    assert.equal(registration.status, 200); await registration.arrayBuffer();
    const malformed = await fetch(`${base}/v1/league-players?${query}`, { headers, method: "POST", body: "{" });
    assert.equal(malformed.status, 400); await malformed.arrayBuffer();
    query.set("playerId", player.playerId);
    const invitation = await fetch(`${base}/v1/player-proofs/league-invitation?${query}`, { headers });
    assert.equal(invitation.status, 200); assert.deepEqual(await invitation.json(), { invitation: null });
    assert.equal(invitation.headers.get("cache-control"), "no-store");
    const invalid = await fetch(`${base}/v1/player-proofs/league-invitation?${query}&gameId=foreign`, { headers });
    assert.equal(invalid.status, 400); await invalid.arrayBuffer();
    assert.deepEqual(calls, ["list", "create", "register", "invitation"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
