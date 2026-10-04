import assert from "node:assert/strict";
import test from "node:test";

import { ACHIEVEMENT_DEFINITIONS, normalizeAppReturnTarget } from "@3fc/contracts";

test("normalizes known application return targets", () => {
  const targets = [
    "/",
    "/setup",
    "/player",
    "/achievements",
    "/achievements?achievementId=goal",
    "/achievements?leagueId=l&playerId=p",
    "/achievements?leagueId=l&playerId=p&scope=season",
    "/achievements?leagueId=l&playerId=p&seasonId=winter",
    "/achievements?leagueId=l%2Fone&playerId=p%2525&scope=season&seasonId=winter&viewerPlayerId=v&achievementId=played",
    "/achievements?leagueId=l&playerId=p&scope=career&achievementId=hat-trick",
    "/player?leagueId=l%2Fone&playerId=p%2525%26x&seasonId=winter",
    "/player-settings?playerId=p%2Fone&leagueId=l&seasonId=winter&viewerPlayerId=viewer",
    "/leagues/league-1",
    "/leagues/league-1/seasons/winter-2026?view=table#games",
    "/seasons/winter-2026",
    "/games/game-1",
    "/join?code=ABCD2345",
    "/join?code=100%25",
    "/join/ABCD2345",
    "/invites?code=ABCD2345",
    "/link-player?proofId=proof-id-for-test-123456",
    "/combine-players?proposalId=proposal-id-for-test-123456",
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
    "/achievements?leagueId=l", "/achievements?playerId=p",
    "/achievements?achievementId=unknown", "/achievements?achievementId=goal&achievementId=played",
    "/achievements?scope=season", "/achievements?seasonId=winter", "/achievements?viewerPlayerId=v",
    "/achievements?leagueId=l&playerId=p&scope=career&seasonId=winter",
    "/achievements?leagueId=l&playerId=p&scope=last-game", "/achievements?leagueId=l&playerId=",
    "/achievements?leagueId=l&playerId=p&email=private", "/achievements#secret",
    "/player?seasonId=winter", "/player#secret", "/player?viewerPlayerId=v", "/player?playerId=p", "/player?leagueId=l&playerId=p&playerId=q",
    "/player?leagueId=l&playerId=p&email=private", "/player?leagueId=l&playerId=p#private",
    "/player-settings", "/player-settings?playerId=p&owner=true", "/player-settings?playerId=",
    "/player-settings?playerId=p", "/player-settings?playerId=p&leagueId=", "/player-settings?playerId=p&leagueId=+",
    "/player-settings?playerId=p&viewerPlayerId=v&viewerPlayerId=w",
    "/link-player",
    "/link-player#proofId=proof-id-for-test-123456&secret=private",
    "/link-player?proofId=proof-id-for-test-123456#secret=private",
    "/link-player/?proofId=proof-id-for-test-123456&secret=private",
    "/link-player?proofId=proof-id-for-test-123456&proofId=another-proof-id-123456",
    "/link-player?proofId=proof-id-for-test-123456%23secret%3Dprivate",
    "/link-player?proofId=short",
    "/combine-players",
    "/combine-players?proposalId=short",
    "/combine-players?proposalId=proposal-id-for-test-123456&account=other",
    "/combine-players?proposalId=proposal-id-for-test-123456#secret=private",
    "/combine-players?proposalId=proposal-id-for-test-123456&proposalId=another-proposal-123456",
    "/leagues/?id=not-a-path-segment",
  ];

  for (const target of targets) {
    assert.equal(normalizeAppReturnTarget(target), null);
  }
});

test("canonicalizes trailing slashes on known application return targets", () => {
  const targets = new Map([
    ["/setup/", "/setup"],
    ["/player/", "/player"],
    ["/achievements/?achievementId=goal", "/achievements?achievementId=goal"],
    ["/player/?leagueId=l&playerId=p", "/player?leagueId=l&playerId=p"],
    ["/player-settings/?playerId=p&leagueId=l", "/player-settings?playerId=p&leagueId=l"],
    ["/leagues/league-1/", "/leagues/league-1"],
    [
      "/leagues/league-1/seasons/winter-2026/?view=table#games",
      "/leagues/league-1/seasons/winter-2026?view=table#games",
    ],
    ["/seasons/winter-2026/", "/seasons/winter-2026"],
    ["/games/game-1/?mode=run#latest", "/games/game-1?mode=run#latest"],
    ["/join/ABCD2345/", "/join/ABCD2345"],
    ["/invites/ABCD2345/", "/invites/ABCD2345"],
    ["/link-player/?proofId=proof-id-for-test-123456", "/link-player?proofId=proof-id-for-test-123456"],
    ["/combine-players/?proposalId=proposal-id-for-test-123456", "/combine-players?proposalId=proposal-id-for-test-123456"],
  ]);

  for (const [target, expected] of targets) {
    assert.equal(normalizeAppReturnTarget(target), expected);
  }
});


test("every enabled achievement has a safe contextless detail return target", () => {
  for (const { id } of ACHIEVEMENT_DEFINITIONS) {
    const target = `/achievements?${new URLSearchParams({ achievementId: id })}`;
    assert.equal(normalizeAppReturnTarget(target), target);
  }
});
