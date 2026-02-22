import assert from "node:assert/strict";
import test from "node:test";

import { handler, isHealthRoute } from "./lambda.js";

interface CapturedLogs {
  logs: string[];
  errors: string[];
}

async function withCapturedConsole(work: () => Promise<void>): Promise<CapturedLogs> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (message?: unknown, ...optionalParams: unknown[]) => {
    logs.push([message, ...optionalParams].map(String).join(" "));
  };

  console.error = (message?: unknown, ...optionalParams: unknown[]) => {
    errors.push([message, ...optionalParams].map(String).join(" "));
  };

  try {
    await work();
    return { logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("isHealthRoute identifies the API health route mapping", () => {
  assert.equal(isHealthRoute("GET", "/v1/health"), true);
  assert.equal(isHealthRoute("POST", "/v1/health"), false);
  assert.equal(isHealthRoute("GET", "/v1/other"), false);
});

test("handler returns health metadata for GET /v1/health", async () => {
  const response = await handler({
    rawPath: "/v1/health",
    requestContext: {
      requestId: "req-health",
      http: {
        method: "GET",
        path: "/v1/health",
      },
    },
  });

  assert.equal(response.statusCode, 200);

  const body = JSON.parse(response.body) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.service, "api");
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.timestamp, "string");
});

test("handler route mapping returns 404 for unknown routes", async () => {
  const response = await handler({
    rawPath: "/v1/missing",
    requestContext: {
      requestId: "req-missing",
      http: {
        method: "GET",
        path: "/v1/missing",
      },
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: "Not found" });
});

test("handler emits structured request logs with required fields", async () => {
  const output = await withCapturedConsole(async () => {
    await handler({
      rawPath: "/v1/health",
      requestContext: {
        requestId: "req-log",
        http: {
          method: "GET",
          path: "/v1/health",
        },
      },
    });
  });

  assert.equal(output.errors.length, 0);
  assert.equal(output.logs.length, 1);

  const entry = JSON.parse(output.logs[0]) as Record<string, unknown>;

  assert.equal(entry.requestId, "req-log");
  assert.equal(entry.route, "/v1/health");
  assert.equal(entry.method, "GET");
  assert.equal(entry.status, 200);
});
