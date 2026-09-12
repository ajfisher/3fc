import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AuthSessionRecord } from "../auth/magic-link.js";
import { PlayerIdentityError } from "../data/player-identity.js";
import { handleOwnedPlayerJoinRoute, isOwnedPlayerJoinRoute, ownedJoinPageSchema, ownedJoinResultSchema,
  type OwnedPlayerJoinRepository } from "../owned-player-join-routes.js";
import { handleLocalOwnedPlayerJoinRoute } from "../server.js";

const base = "/v1/join/ABCDEFGH", readRoute = `${base}/linked-players`, writeRoute = `${base}/linked-player`;
const session: AuthSessionRecord = { sessionId: "session", subject: "subject", email: "legacy@example.invalid",
  createdAt: "2026-09-12T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z" };
const body = { playerId: "opaque/Player%2F", expectedAccountId: "subject" };
const page = { accountId: "subject", gameId: "game", leagueId: "league", players: [{ playerId: body.playerId,
  nickname: "Kesh", registeredPlayerId: null, team: null, seasons: [{ seasonId: "season", name: "Winter" }] }], cursor: null, complete: true };
const receipt = { accountId: "subject", gameId: "game", joinCode: "ABCDEFGH", player: { playerId: "old-player", nickname: "Kesh" },
  link: { gameId: "game", playerId: "old-player" }, alreadyRegistered: true, team: { teamId: "red" as const, name: "Red", color: "#ff0000" } };
function fixture() {
  const calls: Array<{ method: string; input: unknown }> = [];
  let failure: unknown;
  const repository: OwnedPlayerJoinRepository = {
    async listOwnedJoinPlayers(input) { calls.push({ method: "read", input }); if (failure) throw failure; return page; },
    async joinOwnedPlayer(input) { calls.push({ method: "join", input }); if (failure) throw failure; return receipt; },
  };
  return { repository, calls, fail(error: unknown) { failure = error; },
    request: (method = "POST", route = writeRoute, value: unknown = body, query?: string, account: AuthSessionRecord | null = session, key: unknown = "request-key") =>
      handleOwnedPlayerJoinRoute({ method, route, body: value, rawQueryString: query, session: account, idempotencyKey: key, repository }) };
}

test("owned join routes bind actor and legacy aliases without forwarding client account fields", async () => {
  const f = fixture();
  assert(isOwnedPlayerJoinRoute("GET", readRoute)); assert(isOwnedPlayerJoinRoute("POST", writeRoute));
  assert(!isOwnedPlayerJoinRoute("POST", readRoute)); assert(!isOwnedPlayerJoinRoute("GET", writeRoute));
  for (const [method, route] of [["GET", readRoute], ["POST", writeRoute]]) assert.equal((await f.request(method, route, {}, "%ZZ", null)).statusCode, 401);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request("GET", readRoute, undefined, "cursor=opaque%2Bcursor&limit=1")).statusCode, 200);
  assert.deepEqual(f.calls[0], { method: "read", input: { joinCode: "ABCDEFGH", userId: "subject", userIds: ["subject", session.email], cursor: "opaque+cursor", limit: 1 } });
  assert.deepEqual((await f.request()).payload, receipt);
  assert.deepEqual(f.calls[1], { method: "join", input: { joinCode: "ABCDEFGH", userId: "subject", userIds: ["subject", session.email], playerId: body.playerId, idempotencyKey: "request-key" } });
  const before = f.calls.length;
  const switched = await f.request("POST", writeRoute, body, undefined, { ...session, subject: "other" });
  assert.equal(switched.statusCode, 403); assert.equal(switched.payload.code, "account_changed"); assert.equal(f.calls.length, before);
});

test("owned join rejects malformed routes, query spoofing and unbound writes before repository calls", async () => {
  const f = fixture();
  for (const query of ["limit=0", "limit=26", "limit=01", "limit=1&limit=2", "cursor=", "cursor=%ZZ", "cursor=%E0%A4",
    "cursor=x&cursor=y", "userId=other", "leagueId=foreign", "limit=1&", "x".repeat(9001)]) {
    assert.equal((await f.request("GET", readRoute, {}, query)).statusCode, 400);
  }
  for (const value of [null, [], {}, { playerId: body.playerId }, { ...body, userId: "other" }, { ...body, userIds: ["other"] },
    { ...body, playerId: "bad\ud800" }, { ...body, expectedAccountId: null }]) assert.equal((await f.request("POST", writeRoute, value)).statusCode, 400);
  for (const key of [undefined, null, "", " ", [], "x".repeat(129)]) {
    const result = await handleOwnedPlayerJoinRoute({ method: "POST", route: writeRoute, body, session, idempotencyKey: key, repository: f.repository });
    assert.equal(result.statusCode, 400);
  }
  assert.equal((await f.request("POST", writeRoute, body, "limit=1")).statusCode, 400);
  for (const invalid of ["%ZZ", "%E0%A4", "bad%2Fcode"]) assert.equal((await f.request("GET", `/v1/join/${invalid}/linked-players`)).statusCode, 400);
  assert.equal(f.calls.length, 0);
});

test("owned join strict responses prevent private data and inconsistent completion or receipt scope", async () => {
  assert(ownedJoinPageSchema.safeParse(page).success); assert(ownedJoinResultSchema.safeParse(receipt).success);
  for (const value of [{ ...page, email: session.email }, { ...page, cursor: "more" }, { ...page, complete: false },
    { ...page, players: [{ ...page.players[0], claimedByUserId: "other" }] },
    { ...page, players: [{ ...page.players[0], seasons: [{ seasonId: "season", name: "Winter", private: true }] }] }]) assert(!ownedJoinPageSchema.safeParse(value).success);
  for (const value of [{ ...receipt, owner: session.email }, { ...receipt, player: { ...receipt.player, email: session.email } },
    { ...receipt, link: { ...receipt.link, playerId: "wrong" } }, { ...receipt, team: { ...receipt.team, private: true } }]) assert(!ownedJoinResultSchema.safeParse(value).success);
  const f = fixture();
  f.repository.listOwnedJoinPlayers = async () => ({ ...page, accountId: "another-account" });
  await assert.rejects(f.request("GET", readRoute), /account mismatch/);
  f.repository.joinOwnedPlayer = async () => ({ ...receipt, joinCode: "OTHER123" });
  await assert.rejects(f.request(), /scope mismatch/);
});

test("owned join exposes safe domain errors without pretending infrastructure faults are stale identities", async () => {
  const f = fixture();
  for (const status of [400, 403, 404, 409, 503] as const) {
    f.fail(new PlayerIdentityError("safe_code", status, "Safe recovery.")); const result = await f.request();
    assert.equal(result.statusCode, status); assert.equal(result.payload.code, "safe_code");
  }
  f.fail(Object.assign(new Error("private diagnostic"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] }));
  const stale = await f.request(); assert.equal(stale.statusCode, 409); assert.doesNotMatch(JSON.stringify(stale), /private diagnostic/);
  const failure = Object.assign(new Error("private infrastructure"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "ProvisionedThroughputExceeded" }] });
  f.fail(failure); await assert.rejects(f.request(), error => error === failure);
});

test("owned join actual local HTTP adapter preserves binding, request key and private headers", async () => {
  const f = fixture();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    void handleLocalOwnedPlayerJoinRoute({ request, response, method: request.method!, route: url.pathname, rawQueryString: url.search.slice(1),
      session: request.headers.cookie === "fixture=A" ? session : request.headers.cookie === "fixture=B" ? { ...session, subject: "other" } : null,
      playerRepository: f.repository }).catch(() => { response.writeHead(500); response.end("{}"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const item of [
      { method: "GET", path: readRoute, cookie: "", status: 401 },
      { method: "GET", path: readRoute + "?limit=1", cookie: "fixture=A", status: 200 },
      { method: "POST", path: writeRoute, cookie: "fixture=A", value: JSON.stringify(body), key: "actual-key", status: 200 },
      { method: "POST", path: writeRoute, cookie: "fixture=B", value: JSON.stringify(body), key: "actual-key", status: 403 },
      { method: "POST", path: writeRoute, cookie: "fixture=A", value: JSON.stringify(body), status: 400 },
      { method: "POST", path: writeRoute, cookie: "fixture=A", value: "{broken", key: "actual-key", status: 400 },
      { method: "POST", path: writeRoute, cookie: "fixture=A", value: "null", key: "actual-key", status: 400 },
      { method: "GET", path: readRoute + "?cursor=x&cursor=y", cookie: "fixture=A", status: 400 },
    ]) {
      const before = f.calls.length;
      const response = await fetch(origin + item.path, { method: item.method, body: item.value, headers: {
        cookie: item.cookie, "content-type": "application/json", ...(item.key ? { "idempotency-key": item.key } : {}),
      } });
      assert.equal(response.status, item.status); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      const value = await response.json(); assert.doesNotMatch(JSON.stringify(value), /legacy@example/);
      if (item.status !== 200) assert.equal(f.calls.length, before);
    }
    assert.equal(f.calls.length, 2);
    assert.equal((f.calls[1].input as { idempotencyKey: string }).idempotencyKey, "actual-key");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
