import assert from "node:assert/strict";
import test from "node:test";

import { buildHealthResponse } from "./index.js";

test("buildHealthResponse includes service and version metadata", () => {
  const now = new Date("2026-02-22T00:00:00.000Z");

  const payload = buildHealthResponse(now, "9.9.9");

  assert.deepEqual(payload, {
    status: "ok",
    service: "api",
    version: "9.9.9",
    timestamp: "2026-02-22T00:00:00.000Z",
  });
});
