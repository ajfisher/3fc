import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AuthSessionRecord } from "../auth/magic-link.js";
import type { ConsolidationView } from "../data/player-consolidation.js";
import { PlayerIdentityError } from "../data/player-identity.js";
import { handlePlayerConsolidationRoute, isPlayerConsolidationRoute, consolidationResponseSchema, type PlayerConsolidationRepository } from "../player-consolidation-routes.js";
import { handleLocalPlayerConsolidationRoute } from "../server.js";

const route = "/v1/player-consolidations";
const proposalId = "proposal-identifier-12345";
const session: AuthSessionRecord = { sessionId: "fixture", subject: "account-subject", email: "private@example.com",
  createdAt: "2026-09-11T00:00:00Z", expiresAt: "2026-09-19T00:00:00Z" };
const view: ConsolidationView = { proposalId, leagueId: "league/#%", leagueName: "League", retainedPlayerId: "player/a",
  nickname: "Kesh", status: "ready", profiles: [
    { playerId: "player/a", nickname: "Kesh", claimed: false, games: [] },
    { playerId: "player%b", nickname: "Old Kesh", claimed: false, games: [] },
  ], blockers: [], requiresApproval: false, canApprove: false, canCommit: true };
const binding = { expectedAccountId: session.subject! };
const preview = { ...binding, proposalId, leagueId: view.leagueId, playerIds: ["player/a", "player%b"], retainedPlayerId: "player/a", nickname: " Kesh " };
function fixture() {
  const calls: Array<{ operation: string; input: unknown }> = [];
  let failure: unknown;
  const record = async (operation: string, input: unknown) => {
    calls.push({ operation, input }); if (failure) throw failure; return view;
  };
  const repository: PlayerConsolidationRepository = {
    previewPlayerConsolidation: input => record("preview", input), getPlayerConsolidation: input => record("get", input),
    decidePlayerConsolidation: input => record("decide", input), commitPlayerConsolidation: input => record("commit", input),
  };
  return { repository, calls, fail(error: unknown) { failure = error; },
    request: (method = "POST", target = route, body: unknown = preview, rawQueryString?: string, account: AuthSessionRecord | null = session) =>
      handlePlayerConsolidationRoute({ method, route: target, body, rawQueryString, session: account, repository }) };
}

test("consolidation routes authenticate and only forward trusted account identities", async () => {
  const f = fixture();
  for (const [method, path] of [["GET", route], ["POST", route], ["POST", `${route}/approve`], ["POST", `${route}/commit`]]) {
    assert.equal(isPlayerConsolidationRoute(method, path), true);
    assert.equal((await f.request(method, path, {}, "invalid", null)).statusCode, 401);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(isPlayerConsolidationRoute("GET", `${route}/approve`), false);
  assert.equal(isPlayerConsolidationRoute("DELETE", route), false);
  assert.equal(isPlayerConsolidationRoute("POST", `${route}/commit/extra`), false);
  assert.equal((await f.request()).statusCode, 200);
  const { expectedAccountId: _account, ...previewFields } = preview;
  assert.deepEqual(f.calls[0], { operation: "preview", input: { ...previewFields, nickname: "Kesh", userIds: [session.subject, session.email] } });
  await f.request("GET", route, undefined, `proposalId=${proposalId}`);
  await f.request("POST", `${route}/approve`, { ...binding, proposalId, decision: "decline" });
  await f.request("POST", `${route}/approve`, { ...binding, proposalId, decision: "approve" });
  await f.request("POST", `${route}/commit`, { ...binding, proposalId });
  assert.deepEqual(f.calls.slice(1).map(call => call.operation), ["get", "decide", "decide", "commit"]);
  for (const call of f.calls) {
    assert.deepEqual((call.input as { userIds: string[] }).userIds, [session.subject, session.email]);
    assert.equal(Object.hasOwn(call.input as object, "expectedAccountId"), false);
  }
  const result = await f.request("GET", route, undefined, `proposalId=${proposalId}`, { ...session, subject: session.email });
  assert.deepEqual((f.calls.at(-1)!.input as { userIds: string[] }).userIds, [session.email]);
  assert.deepEqual(result.payload, { proposal: view });
  assert.doesNotMatch(JSON.stringify(result.payload), /private@example|account-subject/);
});

test("consolidation mutations bind every request to the actual session before repository access", async () => {
  const f = fixture();
  for (const [path, body] of [[route, preview], [`${route}/approve`, { ...binding, proposalId, decision: "approve" }],
    [`${route}/commit`, { ...binding, proposalId }]] as const) {
    const switched = await f.request("POST", path, body, undefined, { ...session, subject: "other-account" });
    assert.equal(switched.statusCode, 403);
    assert.equal(switched.payload.code, "account_changed");
    const { expectedAccountId: _account, ...unbound } = body;
    assert.equal((await f.request("POST", path, unbound)).statusCode, 400);
    assert.equal((await f.request("POST", path, { ...body, expectedAccountId: null })).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
  const emailSession = { ...session, subject: undefined };
  assert.equal((await f.request("POST", `${route}/commit`, { proposalId, expectedAccountId: session.email }, undefined, emailSession)).statusCode, 200);
  assert.deepEqual(f.calls[0].input, { proposalId, userIds: [session.email] });
});

test("consolidation public response schema rejects private fields at every nested level", async () => {
  assert.equal(consolidationResponseSchema.safeParse({ proposal: view }).success, true);
  const malformed = [
    { proposal: view, account: session.email },
    { proposal: { ...view, ownerId: session.subject } },
    { proposal: { ...view, profiles: [{ ...view.profiles[0], claimedBy: session.subject }, view.profiles[1]] } },
    { proposal: { ...view, profiles: [{ ...view.profiles[0], games: [{ gameId: "game", kickoffAt: session.createdAt, leagueId: "private-league" }] }, view.profiles[1]] } },
    { proposal: { ...view, blockers: [{ code: "conflict", message: "Cannot combine.", email: session.email }] } },
  ];
  for (const payload of malformed) assert.equal(consolidationResponseSchema.safeParse(payload).success, false);
  const f = fixture();
  f.repository.previewPlayerConsolidation = async () => ({ ...view, ownerId: session.subject });
  await assert.rejects(f.request(), error => error instanceof Error && error.name === "ZodError");
});

test("consolidation strict schemas reject identity spoofing and malformed GET queries before repository access", async () => {
  const f = fixture();
  for (const body of [null, [], { ...preview, userIds: ["attacker"] }, { ...preview, ownerId: "attacker" },
    { ...preview, playerIds: ["same", "same"] }, { ...preview, playerIds: ["one"] },
    { ...preview, playerIds: Array.from({ length: 21 }, (_, i) => `p${i}`) }, { ...preview, retainedPlayerId: "bad\ud800" },
    { ...preview, leagueId: "bad\ud800" }, { ...preview, nickname: " " }, { ...preview, nickname: "x".repeat(81) },
    { ...preview, proposalId: "short" }]) assert.equal((await f.request("POST", route, body)).statusCode, 400);
  for (const target of [`${route}/approve`, `${route}/commit`]) {
    assert.equal((await f.request("POST", target, { ...binding, proposalId, userIds: ["attacker"] })).statusCode, 400);
    assert.equal((await f.request("POST", target, { proposalId }, "userId=attacker")).statusCode, 400);
  }
  assert.equal((await f.request("POST", `${route}/approve`, { ...binding, proposalId, decision: "override" })).statusCode, 400);
  for (const query of ["", "proposalId=", `proposalId=${proposalId}&proposalId=${proposalId}`, `proposalId=${proposalId}&userId=attacker`,
    `proposalId=${proposalId}&`, "proposalId=%ZZ", "proposalId=%E0%A4", `proposalId=${proposalId}%0A`, "%70roposalId=proposal-identifier-12345"]) {
    assert.equal((await f.request("GET", route, undefined, query)).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("consolidation maps domain and pure condition failures without disguising infrastructure errors", async () => {
  const f = fixture();
  for (const status of [400, 403, 404, 409, 503] as const) {
    f.fail(new PlayerIdentityError("fixture_failure", status, "Safe recovery message."));
    const response = await f.request(); assert.equal(response.statusCode, status);
    assert.equal(response.payload.code, "fixture_failure"); assert.equal(response.payload.message, "Safe recovery message.");
  }
  for (const failure of [Object.assign(new Error("private diagnostic"), { name: "ConditionalCheckFailedException" }),
    Object.assign(new Error("private diagnostic"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] })]) {
    f.fail(failure); const response = await f.request(); assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, "player_consolidation_changed"); assert.doesNotMatch(JSON.stringify(response), /private diagnostic/);
  }
  for (const failure of [new Error("private diagnostic"), Object.assign(new Error("capacity"), { name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "ProvisionedThroughputExceeded" }] })]) {
    f.fail(failure); await assert.rejects(f.request(), error => error === failure);
  }
});

test("consolidation local HTTP adapter parses real streams and preserves private headers on success and rejection", async () => {
  const f = fixture();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    void handleLocalPlayerConsolidationRoute({ request, response, method: request.method!, route: url.pathname,
      rawQueryString: url.search.slice(1), session: request.headers.cookie === "fixture=valid" ? session
        : request.headers.cookie === "fixture=switched" ? { ...session, subject: "other-account" } : null,
      playerRepository: f.repository }).catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const scenario of [
      { method: "GET", path: `${route}?proposalId=${proposalId}`, signed: false, status: 401 },
      { method: "GET", path: `${route}?proposalId=${proposalId}`, signed: true, status: 200 },
      { method: "POST", path: route, signed: true, body: JSON.stringify(preview), status: 200 },
      { method: "POST", path: `${route}/approve`, signed: true, body: JSON.stringify({ ...binding, proposalId, decision: "approve" }), status: 200 },
      { method: "POST", path: `${route}/commit`, signed: true, body: JSON.stringify({ ...binding, proposalId }), status: 200 },
      { method: "POST", path: route, signed: true, body: "{invalid", status: 400 },
      { method: "POST", path: route, signed: true, body: "null", status: 400 },
      { method: "POST", path: route, signed: true, body: "[]", status: 400 },
      { method: "GET", path: `${route}?proposalId=${proposalId}&proposalId=${proposalId}`, signed: true, status: 400 },
    ]) {
      const before = f.calls.length;
      const response = await fetch(`${base}${scenario.path}`, { method: scenario.method, body: scenario.body,
        headers: { "content-type": "application/json", ...(scenario.signed ? { cookie: "fixture=valid" } : {}) } });
      assert.equal(response.status, scenario.status); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      const body = await response.json(); assert.doesNotMatch(JSON.stringify(body), /private@example|account-subject/);
      if (scenario.status !== 200) assert.equal(f.calls.length, before);
    }
    assert.equal(f.calls.length, 4);
    for (const [path, body] of [[route, preview], [`${route}/approve`, { ...binding, proposalId, decision: "approve" }],
      [`${route}/commit`, { ...binding, proposalId }]] as const) {
      const response = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body),
        headers: { "content-type": "application/json", cookie: "fixture=switched" } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      const result = await response.json();
      assert.equal(result.code, "account_changed");
      assert.doesNotMatch(JSON.stringify(result), /private@example|account-subject|other-account/);
      assert.equal(f.calls.length, 4);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
