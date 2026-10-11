import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { instrumentDynamoDb, requestPerformance, withRequestPerformance } from "../request-performance.js";
import { logRequest } from "../logging.js";
import { createLambdaCoreHandler } from "../lambda-core.js";

function client(statuses = [200], waitMs = 0) {
  let calls = 0;
  const db = new DynamoDBClient({ region: "ap-southeast-2", credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 2, requestHandler: { async handle() {
      await delay(waitMs);
      const statusCode = statuses[Math.min(calls++, statuses.length - 1)];
      const body = statusCode === 200 ? '{}' : '{"__type":"InternalServerError","message":"private@example.invalid"}';
      return { response: { statusCode, headers: { "content-type": "application/x-amz-json-1.0" }, body: new TextEncoder().encode(body) } };
    } } });
  instrumentDynamoDb(db);
  return db;
}
const read = (db: DynamoDBClient) => db.send(new GetItemCommand({ TableName: "private-table", Key: { pk: { S: "secret-player" } } }));

test("SDK metrics include command latency and retries without retaining data", async () => {
  const db = client([500, 200], 5);
  try {
    await withRequestPerformance(async () => {
      const value = await read(db);
      assert.equal(value.$metadata.attempts, 2);
      const metrics = requestPerformance()!;
      assert.equal(metrics.dbCalls, 1); assert.equal(metrics.dbRetries, 1); assert.equal(metrics.dbFailures, 0);
      assert.ok(metrics.dbElapsedMs >= 10); assert.ok(metrics.durationMs >= metrics.dbElapsedMs);
      assert.deepEqual(Object.keys(metrics).sort(), ["dbCalls", "dbElapsedMs", "dbFailures", "dbRetries", "durationMs"]);
      assert.ok(!JSON.stringify(metrics).includes("secret-player"));
    });
    assert.equal(requestPerformance(), undefined);
  } finally { db.destroy(); }
});

test("failed SDK commands preserve errors and count retry exhaustion", async () => {
  const db = client([500]);
  try {
    await withRequestPerformance(async () => {
      await assert.rejects(read(db), { name: "InternalServerError", message: "private@example.invalid" });
      const metrics = requestPerformance()!;
      assert.equal(metrics.dbCalls, 1); assert.equal(metrics.dbFailures, 1); assert.equal(metrics.dbRetries, 1);
      assert.ok(!JSON.stringify(metrics).includes("private"));
    });
  } finally { db.destroy(); }
});

test("overlapping requests, background calls and nested scopes keep separate counters", async () => {
  const db = client([200], 5);
  try {
    assert.equal(requestPerformance(), undefined);
    await read(db);
    await Promise.all([1, 3].map(count => withRequestPerformance(async () => {
      await Promise.all(Array.from({ length: count }, () => read(db)));
      assert.equal(requestPerformance()!.dbCalls, count);
      await withRequestPerformance(async () => { assert.equal(requestPerformance()!.dbCalls, 0); await read(db); });
      assert.equal(requestPerformance()!.dbCalls, count);
    })));
    assert.equal(requestPerformance(), undefined);
    await assert.rejects(withRequestPerformance(async () => { throw new Error("handler failure"); }), /handler failure/);
    assert.equal(requestPerformance(), undefined);
  } finally { db.destroy(); }
});

test("calls outside request scope keep normal SDK behaviour", async () => {
  const db = client([500]);
  try { await assert.rejects(read(db), /private@example.invalid/); assert.equal(requestPerformance(), undefined); }
  finally { db.destroy(); }
});

test("completion logs contain only numeric performance fields and omit them outside a request", async () => {
  const original = console.log, logs: string[] = [];
  console.log = value => { logs.push(String(value)); };
  try {
    const fields = { requestId: "correlation", route: "/v1/auth/session", method: "GET", status: 401 };
    logRequest(fields);
    await withRequestPerformance(async () => logRequest(fields));
    assert.equal(JSON.parse(logs[0]).performance, undefined);
    const metrics = JSON.parse(logs[1]).performance;
    assert.equal(metrics.dbCalls, 0);
    assert.ok(Object.values(metrics).every(value => typeof value === "number" && Number.isFinite(value)));
  } finally { console.log = original; }
});

test("Lambda completion telemetry covers early return and handled failure without changing responses", async () => {
  const original = console.log, originalError = console.error, logs: string[] = [];
  console.log = value => { logs.push(String(value)); }; console.error = () => {};
  try {
    const unused = async (): Promise<never> => { throw new Error("unused dependency"); };
    const handler = createLambdaCoreHandler({ corsAllowedOrigins: [], sessionCookieName: "session",
      sessionCookieSecure: true, appBaseUrl: "https://qa.3fc.football", repository: {} as never,
      magicLinkRateLimiter: { consumeMagicLinkStart: unused },
      magicLinkService: { getSession: async () => { throw new Error("lookup failure"); },
        revokeSession: unused, start: unused, complete: unused } });
    const preflight = await handler({ rawPath: "/v1/leagues", requestContext: { http: { method: "OPTIONS" } } });
    assert.equal(preflight.statusCode, 204);
    const failed = await handler({ rawPath: "/v1/leagues", cookies: ["session=secret"], requestContext: { http: { method: "GET" } } });
    assert.equal(failed.statusCode, 500);
    const completed = logs.map(value => JSON.parse(value)).filter(value => value.message === "request_complete");
    assert.equal(completed.length, 2);
    assert.deepEqual(completed.map(value => value.status), [204, 500]);
    assert.ok(completed.every(value => value.performance.dbCalls === 0 && value.performance.durationMs >= 0));
  } finally { console.log = original; console.error = originalError; }
});
