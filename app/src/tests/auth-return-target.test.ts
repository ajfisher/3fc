import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAppReturnTarget } from "@3fc/contracts";

test("normalizes known application return targets", () => {
  const targets = [
    "/",
    "/setup",
    "/leagues/league-1",
    "/leagues/league-1/seasons/winter-2026?view=table#games",
    "/seasons/winter-2026",
    "/games/game-1",
    "/join?code=ABCD2345",
    "/join?code=100%25",
    "/join/ABCD2345",
    "/invites?code=ABCD2345",
  ];

  for (const target of targets) {
    assert.equal(normalizeAppReturnTarget(target), target);
  }
});

test("rejects non-application and ambiguous return targets", () => {
  const targets: unknown[] = [
    null,
    123,
    "",
    "setup",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/%5cevil.example",
    "/%255cevil.example",
    "/setup%0aevil",
    "/auth/callback",
    "/sign-in",
    "/v1/auth/session",
    "/ui/auth-flow.js",
    "/unknown",
  ];

  for (const target of targets) {
    assert.equal(normalizeAppReturnTarget(target), null);
  }
});
