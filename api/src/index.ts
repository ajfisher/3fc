import type { GameHealth } from "@3fc/contracts";

const DEFAULT_API_VERSION = process.env.API_VERSION ?? "0.1.0";

export function buildHealthResponse(
  now = new Date(),
  version = DEFAULT_API_VERSION,
): GameHealth {
  return {
    status: "ok",
    service: "api",
    version,
    timestamp: now.toISOString(),
  };
}
