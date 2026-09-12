// Disposable DynamoDB + actual local HTTP acceptance. No existing Docker volume,
// QA data, email service or AWS credentials are used. Run after the API build.
// Pair the container's 512 MiB limit with a <=3.5 GiB host-process guard.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ThreeFcRepository } from "../../api/dist/data/repository.js";
import { hashPlayerProofSecret } from "../../api/dist/auth/player-proof.js";

const container = `threefc-consolidation-test-${randomUUID()}`;
const tableName = "threefc_consolidation_acceptance";
const origin = "http://localhost:3000";
const secrets = [];
let child;
let childExit;
let client;
let serverLogs = "";
let containerCreated = false;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
// Docker descendants are outside the host PGID. A guard interrupt must stop
// that separately bounded container too, not just its CLI/client processes.
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  child?.kill("SIGKILL");
  try { if (containerCreated) docker("stop", "--time", "1", container); }
  finally { process.exit(signal === "SIGINT" ? 130 : 143); }
});
function proof() {
  const secret = randomBytes(32).toString("base64url"); secrets.push(secret);
  return { proofId: randomBytes(18).toString("base64url"), secret, verifier: hashPlayerProofSecret(secret) };
}
async function freePort() {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function stopServer() {
  if (!child) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
  try { await childExit; } finally { clearTimeout(timer); child = null; }
}
let endpoint;
let base;
async function startServer(mode, returningMode = "true") {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["api/dist/server.js"], { env: { ...process.env,
    PORT: String(port), DYNAMODB_ENDPOINT: endpoint, DYNAMODB_TABLE: tableName,
    AWS_REGION: "ap-southeast-2", AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local",
    CORS_ALLOWED_ORIGINS: origin, APP_BASE_URL: origin, PLAYER_CLAIM_MODE: "proof", PLAYER_CONSOLIDATION_ENABLED: mode,
    PLAYER_RETURNING_JOIN_ENABLED: returningMode,
  }, stdio: ["ignore", "pipe", "pipe"] });
  childExit = once(child, "exit");
  for (const output of [child.stdout, child.stderr]) output.on("data", data => { serverLogs = (serverLogs + data).slice(-250_000); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Local API exited before readiness: " + secrets.reduce((log, secret) => log.replaceAll(secret, "[redacted]"), serverLogs));
    try { if ((await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* bounded startup */ }
    await delay(100);
  }
  throw new Error("Local API did not become ready");
}
async function request(path, { method = "POST", body = {}, account = "A", key, requestOrigin = origin } = {}) {
  const result = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(10000), headers: {
    Origin: requestOrigin, "Content-Type": "application/json",
    ...(account ? { Cookie: `threefc_session=${sessions[account] ?? account}` } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  return { status: result.status, headers: result.headers, body: result.status === 204 ? null : await result.json() };
}
const sessions = { A: randomUUID(), B: randomUUID(), organiser: randomUUID() };
const { PlayerIdentityMigration } = await import("../../api/dist/data/player-identity-migration.js");
const { identityItem } = await import("../../api/dist/data/player-identity.js");
const { playerClaimSk } = await import("../../api/dist/data/keys.js");
const consolidate = "/v1/player-consolidations";
const proposal = ids => ({ proposalId: randomUUID(), expectedAccountId: "organiser", leagueId: "league",
  playerIds: ids, retainedPlayerId: ids[0], nickname: "Combined player" });
let repository;
const read = async (pk, sk) => (await client.send(new GetItemCommand({ TableName: tableName,
  Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true }))).Item;
async function expect(path, options, status) {
  const response = await request(path, options);
  assert.equal(response.status, status, `Unexpected status for ${path.split("?")[0]}: ${response.status}`);
  return response;
}
async function preview(ids) {
  const body = proposal(ids);
  await expect(consolidate, { account: "organiser", body }, 200);
  return body;
}
const commit = p => request(consolidate + "/commit", { account: "organiser",
  body: { proposalId: p.proposalId, expectedAccountId: "organiser" } });
async function makeInvitation(playerId) {
  const credential = proof();
  await expect("/v1/player-proofs/league-invitation?leagueId=league&playerId=" + encodeURIComponent(playerId),
    { account: "organiser", body: { proofId: credential.proofId, verifier: credential.verifier } }, 201);
  return credential;
}
async function redeem(playerId, credential) {
  const body = { proofId: credential.proofId, secret: credential.secret };
  const seen = await expect("/v1/player-proofs/preview", { account: "A", body }, 200);
  await expect("/v1/player-proofs/claim?playerId=" + encodeURIComponent(playerId),
    { account: "A", body: { proof: { ...body, confirmation: seen.body.preview.confirmation } } }, 200);
}
try {
  console.log("Starting disposable DynamoDB: 512 MiB, one CPU, no volume");
  docker("run", "--detach", "--rm", "--name", container, "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
    "--publish", "127.0.0.1::8000", "amazon/dynamodb-local:2.5.2", "-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb");
  containerCreated = true;
  const address = docker("port", container, "8000/tcp");
  assert.match(address, /^127\.0\.0\.1:\d+$/); endpoint = `http://${address}`;
  client = new DynamoDBClient({ endpoint, region: "ap-southeast-2", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { await client.send(new ListTablesCommand({}), { abortSignal: AbortSignal.timeout(1000) }); ready = true; break; }
    catch { await delay(200); }
  }
  assert(ready, "disposable database readiness");
  await startServer("true");
  process.env.PLAYER_CLAIM_MODE = "proof"; process.env.PLAYER_CONSOLIDATION_ENABLED = "true";
  process.env.PLAYER_RETURNING_JOIN_ENABLED = "true";
  repository = new ThreeFcRepository(client, tableName);
  for (const [subject, sessionId] of Object.entries(sessions)) await client.send(new PutItemCommand({ TableName: tableName, Item: {
    pk: { S: `AUTH_SESSION#${sessionId}` }, sk: { S: "METADATA" }, entityType: { S: "session" },
    email: { S: `${subject}@example.invalid` }, subject: { S: subject }, createdAt: { S: new Date().toISOString() },
    expiresAtEpoch: { N: String(Math.floor(Date.now() / 1000) + 3600) },
  } }));
  await repository.createLeague({ leagueId: "league", name: "Synthetic consolidation acceptance", createdByUserId: "organiser" });
  await repository.createSeason({ leagueId: "league", seasonId: "season", name: "Synthetic season" });
  const owned = Array.from({ length: 20 }, (_, i) => `owned-${i}`);
  const unclaimed = ["race-a", "race-b", "race-c", "claim-a", "claim-b", "join-other"];
  // All records are newly created fixtures. Initial ownership/index seeding is
  // fixture setup; real claim redemption is exercised separately below.
  for (const id of [...owned, ...unclaimed]) {
    await repository.createGame({ gameId: `game-${id}`, leagueId: "league", seasonId: "season",
      sessionId: randomUUID(), gameStartTs: new Date().toISOString() });
    await repository.createPlayer({ playerId: id, nickname: id, claimedByUserId: owned.includes(id) ? "A" : null });
    await repository.linkGamePlayer({ gameId: `game-${id}`, playerId: id });
    if (owned.includes(id)) await client.send(new PutItemCommand({ TableName: tableName,
      Item: identityItem("USER#A", playerClaimSk(id), "playerClaim", { userId: "A", playerId: id }, new Date().toISOString()) }));
  }
  const future = await repository.createGame({ gameId: "future", leagueId: "league", seasonId: "season",
    sessionId: randomUUID(), gameStartTs: new Date().toISOString() });
  await stopServer(); // actual writer stop before the local-only audited cutover
  const manifest = { migrationId: randomUUID(), accountId: "000000000000", region: "ap-southeast-2", tableName,
    tableArn: `arn:aws:dynamodb:ap-southeast-2:000000000000:table/${tableName}`,
    writerSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    reviewedPlan: "https://github.com/ajfisher/3fc/issues/160", drainedAt: new Date().toISOString(), writerVersion: 1 };
  // Synthetic local manifest is not QA/production provenance or coverage evidence.
  let runner = new PlayerIdentityMigration(client, manifest);
  let audit = await runner.begin();
  for (let pages = 0; ["inventory", "verification"].includes(audit.phase); pages++) {
    assert(pages < 300, "bounded migration");
    runner = new PlayerIdentityMigration(client, manifest);
    assert.deepEqual(await runner.begin(), audit, "checkpoint resumes without restarting");
    audit = await runner.step(10);
  }
  assert.equal(audit.phase, "ready", "complete disposable inventory must verify");
  assert.deepEqual(audit.inventory, audit.verification);
  assert.equal((await runner.activate()).phase, "active");
  await startServer("true");
  console.log("PASS actual resumable migration and verified local-only cutover");

  const maximum = await preview(owned);
  await expect(consolidate + "/approve", { account: "A",
    body: { proposalId: maximum.proposalId, decision: "approve", expectedAccountId: "A" } }, 200);
  assert.equal((await commit(maximum)).status, 200);
  const firstAudit = await read("PLAYER_CONSOLIDATION#" + maximum.proposalId, "AUDIT");
  assert(firstAudit);
  // Ignore the committed result, then replay exactly as a lost-response client.
  assert.equal((await commit(maximum)).status, 200);
  assert.deepEqual(await read("PLAYER_CONSOLIDATION#" + maximum.proposalId, "AUDIT"), firstAudit);
  assert.equal(JSON.parse((await read("PLAYER#owned-0", "IDENTITY")).data.S).members.length, 20);
  assert(await read("USER#A", playerClaimSk("owned-0")));
  for (const id of owned.slice(1)) assert.equal(await read("USER#A", playerClaimSk(id)), undefined);
  const oldProfile = await repository.getPlayerView("owned-1");
  assert.equal(oldProfile.originalPlayerId, "owned-1");
  assert.equal(oldProfile.canonicalPlayerId, "owned-0");
  assert.equal(oldProfile.player.playerId, "owned-1");
  assert.equal(oldProfile.player.nickname, "Combined player");
  const historicalPlayers = await expect("/v1/games/game-owned-1/players", { method: "GET", account: "organiser" }, 200);
  assert.equal(historicalPlayers.body.players[0].playerId, "owned-1");
  assert.equal(historicalPlayers.body.players[0].canonicalPlayerId, "owned-0");
  assert.equal(historicalPlayers.body.players[0].nickname, "Combined player");
  assert.equal(historicalPlayers.body.players[0].access.userId, "A");
  const oldRegistration = await repository.addExistingLeaguePlayer({ gameId: "game-owned-1", playerId: "owned-0", userIds: ["organiser"] });
  assert.deepEqual(oldRegistration, { playerId: "owned-1", alreadyInGame: true });
  const added = await repository.addExistingLeaguePlayer({ gameId: "future", playerId: "owned-1", userIds: ["organiser"] });
  assert.equal(added.playerId, "owned-0");
  assert.equal((await repository.addExistingLeaguePlayer({ gameId: "future", playerId: "owned-1", userIds: ["organiser"] })).alreadyInGame, true);
  console.log("PASS 20 claimed identities, indexes, immutable receipt/audit replay and historical/future registration mapping");

  const left = await preview(["race-a", "race-b"]);
  const right = await preview(["race-b", "race-c"]);
  const races = await Promise.all([commit(left), commit(right)]);
  assert.equal(races.filter(r => r.status === 200).length, 1);
  assert.equal(races.filter(r => r.status === 409).length, 1);
  const loser = races[0].status === 200 ? right : left;
  assert.equal(await read("PLAYER_CONSOLIDATION#" + loser.proposalId, "AUDIT"), undefined);
  console.log("PASS real overlapping commits converge without a losing audit");

  const invitation = await makeInvitation("claim-a");
  const stale = await preview(["claim-a", "claim-b"]);
  await redeem("claim-a", invitation);
  assert.equal((await commit(stale)).status, 409);
  assert.equal(await read("PLAYER_CONSOLIDATION#" + stale.proposalId, "AUDIT"), undefined);
  assert.equal(JSON.parse((await read("PLAYER#claim-b", "IDENTITY")).data.S).rootId, "claim-b");
  const joinedProof = proof();
  const joined = await expect("/v1/join/" + future.joinCode, { account: null, key: randomUUID(), body: {
    nickname: "Fresh anonymous player", claimProof: { proofId: joinedProof.proofId, verifier: joinedProof.verifier },
  } }, 201);
  const joinStale = await preview([joined.body.player.playerId, "join-other"]);
  await redeem(joined.body.player.playerId, joinedProof);
  assert.equal((await commit(joinStale)).status, 409);
  console.log("PASS actual invitation and anonymous-registration proof claims invalidate pending consolidation");

  Object.assign(process.env, { DYNAMODB_ENDPOINT: endpoint, DYNAMODB_TABLE: tableName, AWS_REGION: "ap-southeast-2",
    AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local", APP_BASE_URL: origin, CORS_ALLOWED_ORIGINS: origin });
  const { handler } = await import("../../api/dist/lambda-core.js");
  const lambda = await handler({ rawPath: consolidate, rawQueryString: "proposalId=" + maximum.proposalId,
    headers: { origin }, cookies: ["threefc_session=" + sessions.organiser],
    requestContext: { http: { method: "GET", path: consolidate, sourceIp: "127.0.0.1" } } });
  assert.equal(lambda.statusCode, 200);
  assert.equal(JSON.parse(lambda.body).proposal.status, "committed");
  assert.equal(lambda.headers["cache-control"], "no-store");
  const switched = await handler({ rawPath: consolidate + "/commit", headers: { origin, "content-type": "application/json" },
    cookies: ["threefc_session=" + sessions.B],
    body: JSON.stringify({ proposalId: maximum.proposalId, expectedAccountId: "organiser" }),
    requestContext: { http: { method: "POST", path: consolidate + "/commit", sourceIp: "127.0.0.1" } } });
  assert.equal(switched.statusCode, 403);
  assert.equal(JSON.parse(switched.body).code, "account_changed");
  // Returning joins use only disposable canonical/alias fixtures established
  // above. Traverse every bounded private source stream, not just page one.
  const ownedList = async (code, account = "A") => {
    const found = new Map(); let cursor = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const params = new URLSearchParams({ limit: "2", ...(cursor ? { cursor } : {}) });
      const response = await expect(`/v1/join/${code}/linked-players?${params}`, { method: "GET", account }, 200);
      assert.equal(response.body.accountId, account);
      assert.equal(response.body.complete, response.body.cursor === null);
      for (const player of response.body.players) {
        assert.equal(Object.hasOwn(player, "claimedByUserId"), false);
        assert.equal(Object.hasOwn(player, "email"), false);
        assert.equal(found.has(player.playerId), false, "canonical roots must not repeat across pages");
        found.set(player.playerId, player);
      }
      cursor = response.body.cursor;
      if (response.body.complete) return found;
    }
    assert.fail("owned-player pagination did not terminate within fixture bound");
  };
  const historicalGame = await repository.getGame("game-owned-1");
  const historicalOwned = await ownedList(historicalGame.joinCode);
  assert.equal(historicalOwned.get("owned-0").registeredPlayerId, "owned-1");
  assert.equal(historicalOwned.has("owned-1"), false);
  const historicalKey = randomUUID();
  const historicalJoin = await expect(`/v1/join/${historicalGame.joinCode}/linked-player`, { key: historicalKey,
    body: { playerId: "owned-0", expectedAccountId: "A" } }, 200);
  assert.equal(historicalJoin.body.player.playerId, "owned-1");
  assert.equal(historicalJoin.body.alreadyRegistered, true);
  assert.deepEqual((await expect(`/v1/join/${historicalGame.joinCode}/linked-player`, { key: historicalKey,
    body: { playerId: "owned-0", expectedAccountId: "A" } }, 200)).body, historicalJoin.body);
  const returningGame = await repository.createGame({ gameId: "returning-new", leagueId: "league", seasonId: "season",
    sessionId: randomUUID(), gameStartTs: new Date().toISOString() });
  const returningPath = `/v1/join/${returningGame.joinCode}/linked-player`;
  const returningKey = randomUUID();
  await expect(returningPath, { key: randomUUID(), body: { playerId: "owned-1", expectedAccountId: "A" } }, 409);
  const firstReturning = await expect(returningPath, { key: returningKey, body: { playerId: "owned-0", expectedAccountId: "A" } }, 200);
  assert.equal(firstReturning.body.player.playerId, "owned-0", "future registration uses the selected canonical identity");
  assert.equal(firstReturning.body.alreadyRegistered, false);
  assert.equal(firstReturning.body.team, null);
  assert.equal((await ownedList(returningGame.joinCode)).get("owned-0").registeredPlayerId, "owned-0");
  assert.deepEqual((await expect(returningPath, { key: returningKey, body: { playerId: "owned-0", expectedAccountId: "A" } }, 200)).body, firstReturning.body);
  assert.equal((await expect(returningPath, { key: randomUUID(), body: { playerId: "owned-0", expectedAccountId: "A" } }, 200)).body.alreadyRegistered, true);
  assert(await read("GAME#returning-new", "PLAYER#owned-0"));
  assert.equal(await read("GAME#returning-new", "PLAYER#owned-1"), undefined);
  for (const teamId of ["red", "blue", "yellow"]) assert.equal(await read("GAME#returning-new", `ROSTER#${teamId}#owned-0`), undefined);
  await expect(returningPath, { key: returningKey, body: { playerId: "owned-1", expectedAccountId: "A" } }, 409);
  await expect(returningPath, { account: "B", key: randomUUID(), body: { playerId: "owned-0", expectedAccountId: "A" } }, 403);
  await expect(returningPath, { account: "B", key: randomUUID(), body: { playerId: "owned-0", expectedAccountId: "B" } }, 403);
  assert.equal((await ownedList(returningGame.joinCode, "B")).size, 0);
  await expect(`/v1/join/${returningGame.joinCode}/linked-players`, { method: "GET", account: null }, 401);
  await expect(returningPath, { account: null, key: randomUUID(), body: { playerId: "owned-0", expectedAccountId: "A" } }, 401);
  const finishedJoinGame = await repository.createGame({ gameId: "returning-finished", leagueId: "league", seasonId: "season",
    sessionId: randomUUID(), gameStartTs: new Date().toISOString() });
  for (const teamId of ["red", "blue", "yellow"]) await repository.createGameTeamOverride({ gameId: finishedJoinGame.gameId, teamId, name: teamId });
  for (const third of [1, 2, 3]) {
    await repository.startGameThird({ gameId: finishedJoinGame.gameId, third });
    await repository.finishGameThird({ gameId: finishedJoinGame.gameId, third });
  }
  await repository.finishGame({ gameId: finishedJoinGame.gameId });
  const finishedReturning = await expect(`/v1/join/${finishedJoinGame.joinCode}/linked-player`, { key: randomUUID(),
    body: { playerId: "owned-0", expectedAccountId: "A" } }, 200);
  assert.equal(finishedReturning.body.alreadyRegistered, false);
  assert.equal(finishedReturning.body.team, null);
  await repository.createLeague({ leagueId: "returning-other-league", name: "Private other fixture", createdByUserId: "organiser" });
  await repository.createSeason({ leagueId: "returning-other-league", seasonId: "other-season", name: "Other season" });
  const outside = await repository.createGame({ gameId: "returning-outside", leagueId: "returning-other-league", seasonId: "other-season",
    sessionId: randomUUID(), gameStartTs: new Date().toISOString() });
  assert.equal((await ownedList(outside.joinCode)).size, 0, "linked profiles are not imported into another league");
  await expect(`/v1/join/${outside.joinCode}/linked-player`, { key: randomUUID(), body: { playerId: "owned-0", expectedAccountId: "A" } }, 403);
  console.log("PASS actual returning-player paginated discovery, historical alias registration, canonical future join, immutable retries and account privacy");

  if (process.argv.includes("--browser")) {
    const { runConsolidationBrowser } = await import("./consolidation-browser.mjs");
    await runConsolidationBrowser({ repository, base, sessions, origin });
    const { runReturningPlayerBrowser } = await import("./returning-player-browser.mjs");
    await runReturningPlayerBrowser({ repository, base, sessions, origin });
  }
  await stopServer(); await startServer("false", "false");
  assert.equal((await commit(maximum)).status, 200);
  await expect(consolidate, { account: "organiser", body: proposal(["claim-a", "claim-b"]) }, 503);
  await expect(`/v1/join/${returningGame.joinCode}/linked-players`, { method: "GET", account: "A" }, 503);
  await expect(returningPath, { key: randomUUID(), body: { playerId: "owned-0", expectedAccountId: "A" } }, 503);
  for (const secret of secrets) assert.equal(serverLogs.includes(secret), false, "no bearer proof in API logs");
  console.log("PASS actual Lambda adapter, account binding and disabled new writes with committed receipt recovery");
} finally {
  try { await stopServer(); } finally {
    client?.destroy();
    if (containerCreated) {
      docker("stop", "--time", "3", container);
      assert.equal(docker("ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"), "");
      console.log("CLEANUP owned API exited and disposable DynamoDB removed");
    }
  }
}
