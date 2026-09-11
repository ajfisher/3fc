// Current-stack M2 against disposable local services, never an existing/QA DB.
// Build first; run under the repository process guard with <=3.5GiB for this
// process group, reserving512MiB for the separately bounded Docker container.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { PlayerIdentityMigration } from "../../api/dist/data/player-identity-migration.js";
import { awaitLoopbackReadiness, cleanupAll } from "./player-stack-safety.mjs";

process.umask(0o077);
const container = `threefc-player-m2-${randomUUID()}`;
const tableName = "threefc_player_m2_acceptance";
const workers = new Set();
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }).trim();
let interrupted = false, client, privateDir;
async function freePort() {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
function start(args, env, visible = false) {
  assert(!interrupted, "Interrupted workflow cannot start another worker");
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "ignore"] });
  const worker = { child, exited: once(child, "close"), host: null };
  {
    let pending = "";
    child.stdout.on("data", chunk => {
      pending = (pending + chunk).slice(-16000);
      const lines = pending.split("\n"); pending = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (!visible) { if (event.message?.endsWith("server started")) worker.host = event.host; continue; }
          // Runner startup errors can bypass reporter hooks: forward only these
          // strictly bounded records, never arbitrary stdout or stderr.
          if (!["start", "end", "failure", "error", "run"].includes(event.event) ||
              !["running", "passed", "failed", "timedOut", "skipped", "interrupted"].includes(event.status) ||
              !/^(?:runner|[A-Za-z0-9_.-]+\.spec\.ts)$/.test(event.file) ||
              !Number.isInteger(event.line) || event.line < 0 || event.line > 100000 ||
              !Array.isArray(event.frames) || event.frames.length > 20 ||
              !event.frames.every(frame => /^tests\/e2e\/[A-Za-z0-9_.-]+\.spec\.ts:\d+:\d+$/.test(frame))) continue;
          console.log(JSON.stringify({ event: event.event, status: event.status, file: event.file, line: event.line, frames: event.frames }));
        } catch { /* never print service or browser payloads */ }
      }
    });
  }
  workers.add(worker); return worker;
}
async function stop(worker) {
  if (!workers.has(worker)) return;
  if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGTERM");
  const timer = setTimeout(() => worker.child.kill("SIGKILL"), 3000);
  try { await worker.exited; } finally { clearTimeout(timer); workers.delete(worker); }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  interrupted = true;
  for (const worker of workers) worker.child.kill("SIGTERM");
  // Docker runs outside the guarded PGID; stop only the generated container.
  try { if (docker("ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}")) docker("stop", "--time", "1", container); } catch { /* final cleanup verifies absence */ }
});
const healthy = (url, worker) => awaitLoopbackReadiness(url, worker, { isInterrupted: () => interrupted });
let stage = "setup";
try {
  privateDir = await mkdtemp(join(tmpdir(), "3fc-m2-private-"));
  docker("run", "--detach", "--rm", "--name", container, "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
    "--publish", "127.0.0.1::8000", "amazon/dynamodb-local:2.5.2", "-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb");
  const address = docker("port", container, "8000/tcp"); assert.match(address, /^127\.0\.0\.1:\d+$/);
  const endpoint = `http://${address}`;
  client = new DynamoDBClient({ endpoint, region: "ap-southeast-2", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  let ready = false;
  for (let attempt = 0; attempt < 50 && !interrupted; attempt++) {
    try { await client.send(new ListTablesCommand({}), { abortSignal: AbortSignal.timeout(1000) }); ready = true; break; } catch { await delay(200); }
  }
  assert(ready, "Disposable database readiness failed");
  const apiPort = await freePort(), appPort = await freePort(), emailPort = await freePort();
  assert.equal(new Set([apiPort, appPort, emailPort]).size, 3);
  const api = `http://127.0.0.1:${apiPort}`, app = `http://127.0.0.1:${appPort}`, email = `http://127.0.0.1:${emailPort}`;
  const env = { ...process.env, THREEFC_LISTEN_HOST: "127.0.0.1", AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local", AWS_REGION: "ap-southeast-2",
    DYNAMODB_ENDPOINT: endpoint, DYNAMODB_TABLE: tableName, APP_BASE_URL: app, PUBLIC_APP_BASE_URL: app,
    CORS_ALLOWED_ORIGINS: app, SESSION_COOKIE_SECURE: "false", FAKE_SES_URL: `${email}/send-email`,
    PLAYER_CLAIM_MODE: "proof", PLAYER_CONSOLIDATION_ENABLED: "true", PLAYER_RETURNING_JOIN_ENABLED: "true" };
  for (const key of ["AWS_PROFILE", "AWS_SESSION_TOKEN", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"]) delete env[key];
  let apiWorker = start(["api/dist/server.js"], { ...env, PORT: String(apiPort) });
  await healthy(`${api}/v1/health`, apiWorker);
  await stop(apiWorker); // no writer exists during the synthetic local cutover
  stage = "local migration";
  const migration = new PlayerIdentityMigration(client, { migrationId: randomUUID(), accountId: "000000000000",
    region: "ap-southeast-2", tableName, tableArn: `arn:aws:dynamodb:ap-southeast-2:000000000000:table/${tableName}`,
    writerSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), writerVersion: 1,
    reviewedPlan: "https://github.com/ajfisher/3fc/issues/162", drainedAt: new Date().toISOString() });
  let audit = await migration.begin();
  for (let pages = 0; ["inventory", "verification"].includes(audit.phase); pages++) {
    assert(pages < 100, "Bounded empty-fixture migration"); audit = await migration.step();
  }
  assert.equal(audit.phase, "ready"); assert.equal(audit.issueCount, 0);
  assert.deepEqual(audit.inventory, audit.verification); assert.equal((await migration.activate()).phase, "active");
  console.log("PASS stopped-writer local migration; synthetic provenance is not deployed migration evidence");
  stage = "services";
  const emailWorker = start(["scripts/local/fake-ses-server.mjs"], { ...env, FAKE_SES_PORT: String(emailPort), FAKE_SES_LOG_FILE: join(privateDir, "emails.jsonl") });
  await healthy(`${email}/health`, emailWorker);
  apiWorker = start(["api/dist/server.js"], { ...env, PORT: String(apiPort) }); await healthy(`${api}/v1/health`, apiWorker);
  const appWorker = start(["app/dist/server.js"], { ...env, PORT: String(appPort), API_BASE_URL: api }); await healthy(`${app}/health`, appWorker);
  stage = "M2 browser";
  const browser = start(["node_modules/@playwright/test/cli.js", "test", "tests/e2e/m2-smoke.spec.ts", "--workers=1",
    "--reporter=./scripts/local/private-smoke-reporter.mjs", `--output=${join(privateDir, "browser-output")}`], {
    ...env, THREEFC_SKIP_WEB_SERVER: "1", PLAYWRIGHT_BASE_URL: app, THREEFC_API_BASE_URL: api,
    THREEFC_FAKE_SES_BASE_URL: email, THREEFC_DYNAMODB_ENDPOINT: endpoint, THREEFC_DYNAMODB_TABLE: tableName,
  }, true);
  const [code] = await browser.exited; workers.delete(browser); assert.equal(code, 0, "M2 exited unsuccessfully; inspect bounded failure before retry");
  console.log("PASS current-stack M2 using only disposable local services");
} catch (error) {
  // Never print request bodies, URLs or email contents from an error object.
  console.error(`Player-stack M2 stopped at ${stage} (${error?.name ?? "Error"}).`); process.exitCode = 1;
} finally {
  const failed = await cleanupAll([
    ...[...workers].reverse().map((worker, index) => ({ name: `worker-${index + 1}`, run: () => stop(worker) })),
    { name: "client", run: () => client?.destroy() },
    { name: "docker", run: () => {
      // Inspect even if run timed out after the daemon created the container.
      if (docker("ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}")) docker("stop", "--time", "3", container);
      assert.equal(docker("ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"), "");
    } },
    { name: "private-files", run: async () => {
      if (!privateDir) return;
      // Exact mkdtemp-owned tree only; do this even after a Docker failure.
      assert(privateDir.startsWith(join(tmpdir(), "3fc-m2-private-")));
      await rm(privateDir, { recursive: true, force: false });
    } },
  ]);
  if (failed.length) {
    console.error(`INCOMPLETE cleanup: ${failed.join(", ")}. Investigate before another run.`); process.exitCode = 1;
  } else console.log("CLEANUP owned workers exited, disposable database absent, private email file removed");
}
