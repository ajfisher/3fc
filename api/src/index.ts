import type { GameHealth } from "@3fc/contracts";

export function buildHealthResponse(now = new Date()): GameHealth {
  return {
    status: "ok",
    service: "api",
    timestamp: now.toISOString(),
  };
}
