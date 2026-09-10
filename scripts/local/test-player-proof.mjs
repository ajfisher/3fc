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

const container = `threefc-proof-test-${randomUUID()}`;
const tableName = "threefc_proof_acceptance";
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
async function startServer(mode) {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["api/dist/server.js"], { env: { ...process.env,
    PORT: String(port), DYNAMODB_ENDPOINT: endpoint, DYNAMODB_TABLE: tableName,
    AWS_REGION: "ap-southeast-2", AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local",
    CORS_ALLOWED_ORIGINS: origin, APP_BASE_URL: origin, PLAYER_CLAIM_MODE: mode,
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
try {
  console.log("Starting disposable DynamoDB (512 MiB, one CPU, no volume)");
  docker("run", "--detach", "--rm", "--name", container, "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
    "--publish", "127.0.0.1::8000", "amazon/dynamodb-local:2.5.2", "-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb");
  containerCreated = true;
  const address = docker("port", container, "8000/tcp");
  assert.match(address, /^127\.0\.0\.1:\d+$/); endpoint = `http://${address}`;
  client = new DynamoDBClient({ endpoint, region: "ap-southeast-2", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  // docker run returning only proves the container exists, not that Java has
  // opened DynamoDB. The local API intentionally fails if its DB is absent.
  let databaseReady = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await client.send(new ListTablesCommand({}), { abortSignal: AbortSignal.timeout(1000) }); databaseReady = true; break; }
    catch { await delay(200); }
  }
  assert.equal(databaseReady, true, "disposable DynamoDB must be ready before starting the API");
  await startServer("proof");
  const repository = new ThreeFcRepository(client, tableName);
  for (const [subject, sessionId] of Object.entries(sessions)) {
    await client.send(new PutItemCommand({ TableName: tableName, Item: {
      pk: { S: `AUTH_SESSION#${sessionId}` }, sk: { S: "METADATA" }, entityType: { S: "session" },
      email: { S: `${subject}@example.invalid` }, subject: { S: subject }, createdAt: { S: new Date().toISOString() },
      expiresAtEpoch: { N: String(Math.floor(Date.now() / 1000) + 3600) },
    } }));
  }
  await repository.createLeague({ leagueId: "proof-league", name: "Disposable league", createdByUserId: "organiser@example.invalid" });
  await repository.createSeason({ leagueId: "proof-league", seasonId: "season", name: "Disposable season" });
  const game = await repository.createGame({ gameId: "proof-game", leagueId: "proof-league", seasonId: "season", sessionId: "session", gameStartTs: new Date().toISOString() });
  const credentials = proof();
  const joinBody = { nickname: "Disposable player", claimProof: { proofId: credentials.proofId, verifier: credentials.verifier } };
  const joinPath = `/v1/join/${game.joinCode}`;
  assert.equal((await request(joinPath, { body: joinBody, account: null })).status, 400, "proof joins need a stable request key before writing");
  assert.equal((await client.send(new GetItemCommand({ TableName: tableName, Key: { pk: { S: `PLAYER_PROOF#${credentials.proofId}` }, sk: { S: "METADATA" } } }))).Item, undefined);
  const joinOptions = { body: joinBody, account: null, key: randomUUID() };
  const joined = await request(joinPath, joinOptions); assert.equal(joined.status, 201);
  assert.deepEqual((await request(joinPath, joinOptions)).body, joined.body, "lost response retry returns the original registration");
  const playerId = joined.body.player.playerId;
  const claimPath = `/v1/players/${encodeURIComponent(playerId)}/claim`;
  const previewBody = { proofId: credentials.proofId, secret: credentials.secret };
  assert.equal((await request(claimPath)).status, 403, "an account and player ID are not ownership proof");
  for (const account of [null, "invalid-cookie"]) assert.equal((await request("/v1/player-proofs/preview", { account, body: previewBody })).status, 401);
  assert.equal((await request("/v1/player-proofs/preview", { body: previewBody, requestOrigin: "https://other.invalid" })).status, 403);
  const previews = await Promise.all(["A", "B"].map(account => request("/v1/player-proofs/preview", { body: previewBody, account })));
  assert.equal(previews[0].body.account.id, "A");
  const invalidSecret = await request("/v1/player-proofs/preview", { body: { ...previewBody, secret: "B".repeat(43) } });
  assert.equal(invalidSecret.status, 400); assert.equal(invalidSecret.body.error, "bad_request");
  const wrongPlayer = await request("/v1/players/another-player/claim", { body: { proof: { ...previewBody, confirmation: previews[0].body.preview.confirmation } } });
  assert.equal(wrongPlayer.status, 400); assert.equal(wrongPlayer.body.error, "bad_request");
  for (const preview of previews) { assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store"); assert.equal(preview.headers.get("referrer-policy"), "no-referrer"); }
  assert.equal(previews[0].body.account.email, "A@example.invalid");
  assert.equal((await request(claimPath, { account: "B", body: { proof: { ...previewBody, confirmation: previews[0].body.preview.confirmation } } })).status, 409);
  const claimOptions = ["A", "B"].map((account, index) => ({ account, body: { proof: { ...previewBody, confirmation: previews[index].body.preview.confirmation } } }));
  const claims = await Promise.all(claimOptions.map(options => request(claimPath, options)));
  assert.equal(claims.filter(result => result.status === 200).length, 1, "real concurrent transactions produce one owner");
  const winner = claims.findIndex(result => result.status === 200);
  assert.deepEqual((await request(claimPath, claimOptions[winner])).body, claims[winner].body);
  assert.equal((await repository.getPlayer(playerId)).claimedByUserId, claimOptions[winner].account);
  console.log("PASS local HTTP authentication, origin, proof issuance, concurrent claim and committed-request replay");
  await repository.createAndLinkGamePlayer({ gameId: game.gameId, playerId: "unclaimed", nickname: "Xavier" });
  const invitationPath = `/v1/games/${game.gameId}/players/unclaimed/profile-invitation`;
  for (const invalid of ["%ZZ", "%E0%A4"]) {
    for (const [gameId, playerId] of [[invalid, "unclaimed"], [game.gameId, invalid]]) {
      const path = `/v1/games/${gameId}/players/${playerId}/profile-invitation`;
      for (const [method, suffix] of [["GET", ""], ["POST", ""], ["POST", "/revoke"]]) {
        assert.equal((await request(path + suffix, { method, account: "organiser" })).status, 400);
        assert.equal((await request(path + suffix, { method, account: null })).status, 401);
      }
    }
    assert.equal((await request(`/v1/players/${invalid}/claim`)).status, 400);
  }
  console.log("PASS actual local HTTP malformed proof paths return400 and missing sessions remain401");
  assert.equal((await request(invitationPath, { method: "GET" })).status, 403);
  assert.equal((await request(invitationPath, { method: "GET", account: "organiser" })).body.invitation, null);
  const first = proof(); const second = proof();
  const create = { account: "organiser", body: { proofId: first.proofId, verifier: first.verifier } };
  const issued = await request(invitationPath, create); assert.equal(issued.status, 201, JSON.stringify(issued.body));
  await repository.grantLeagueAccess({ leagueId: "proof-league", userId: "organiser", role: "admin", grantedByUserId: "organiser@example.invalid" });
  assert.deepEqual((await request(invitationPath, create)).body, issued.body);
  // Grants deliberately retain the higher role; remove this disposable legacy
  // ACL directly to model revocation, rather than pretending a grant demotes it.
  await client.send(new DeleteItemCommand({ TableName: tableName, Key: {
    pk: { S: "LEAGUE#proof-league" }, sk: { S: "ACL#USER#organiser@example.invalid" },
  } }));
  assert.equal((await request(invitationPath, create)).status, 409);
  console.log("PASS actual HTTP invitation recovery after subject ACL addition; revoked legacy issuer cannot be substituted");
  assert.equal((await request(invitationPath, { account: "organiser", body: { proofId: second.proofId, verifier: second.verifier } })).status, 409);
  assert.equal((await request(invitationPath, { account: "organiser", body: { proofId: second.proofId, verifier: second.verifier, replacesProofId: first.proofId } })).status, 201);
  assert.equal((await request("/v1/player-proofs/preview", { body: { proofId: first.proofId, secret: first.secret } })).status, 409);
  assert.equal((await request(`${invitationPath}/revoke`, { account: "organiser", body: { proofId: second.proofId } })).status, 200);
  assert.equal((await request("/v1/player-proofs/preview", { body: { proofId: second.proofId, secret: second.secret } })).status, 409);
  console.log("PASS local HTTP organiser invitation lifecycle and stale predecessor checks");
  await stopServer(); await startServer("disabled");
  const fresh = proof();
  const disabledJoin = { account: null, key: randomUUID(), body: { nickname: "Disabled", claimProof: { proofId: fresh.proofId, verifier: fresh.verifier } } };
  const disabledOutcome = await request(joinPath, disabledJoin);
  assert.equal(disabledOutcome.status, 201);
  assert.equal(disabledOutcome.body.linkingUnavailable, true);
  assert.equal(disabledOutcome.body.claimProof, undefined);
  assert.deepEqual((await request(joinPath, disabledJoin)).body, disabledOutcome.body);
  assert.equal((await request(joinPath, { account: null, key: randomUUID(), body: { nickname: "Still playing" } })).status, 201);
  assert.deepEqual((await request(claimPath, claimOptions[winner])).body, claims[winner].body);
  for (const secret of secrets) assert.equal(serverLogs.includes(secret), false, "bearer secret must never enter local logs");
  console.log("PASS disabled mode preserves unclaimed joins and committed ownership receipts; no secret in server logs");
} finally {
  await stopServer(); client?.destroy();
  if (containerCreated) {
    docker("stop", "--time", "3", container);
    assert.equal(docker("ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"), "");
    console.log("CLEANUP disposable API exited and DynamoDB container removed");
  }
}
