import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeProtectedMutation,
  resolveProtectedMutationRoute,
  type AclLookup,
} from "../auth/acl.js";
import type { GameRecord, LeagueAclRecord, SeasonRecord, SessionRecord } from "../data/types.js";
import { createDefaultThirdTimerSegments, DEFAULT_THIRD_LENGTH_MINUTES } from "@3fc/contracts";

interface AclHarnessInput {
  leagueAccess?: Record<string, LeagueAclRecord>;
  seasons?: Record<string, SeasonRecord>;
  sessions?: Record<string, SessionRecord>;
  games?: Record<string, GameRecord>;
}

class InMemoryAclLookup implements AclLookup {
  constructor(private readonly input: AclHarnessInput) {}

  async getLeagueAccess(leagueId: string, userId: string): Promise<LeagueAclRecord | null> {
    return this.input.leagueAccess?.[`${leagueId}:${userId}`] ?? null;
  }

  async getSeason(seasonId: string): Promise<SeasonRecord | null> {
    return this.input.seasons?.[seasonId] ?? null;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.input.sessions?.[sessionId] ?? null;
  }

  async getGame(gameId: string): Promise<GameRecord | null> {
    return this.input.games?.[gameId] ?? null;
  }
}

function defaultGameStateFields(): Pick<GameRecord, "thirdLengthMinutes" | "thirds" | "finishedAt" | "result"> {
  return {
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments(),
    finishedAt: null,
    result: null,
  };
}

test("resolveProtectedMutationRoute maps supported mutation endpoints", () => {
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/leagues"), {
    operation: "createLeague",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/leagues/league-1/seasons"), {
    operation: "createSeason",
    leagueId: "league-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/seasons/season-1/sessions"), {
    operation: "createSession",
    seasonId: "season-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/sessions/session-1/games"), {
    operation: "createGame",
    sessionId: "session-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/games/game-1/players"), {
    operation: "createGamePlayer",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("PUT", "/v1/games/game-1/teams/red"), {
    operation: "updateGameTeam",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("PUT", "/v1/games/game-1/roster/player-1"), {
    operation: "assignRosterPlayer",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/games/game-1/thirds/1/start"), {
    operation: "startGameThird",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/games/game-1/thirds/1/finish"), {
    operation: "finishGameThird",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/games/game-1/finish"), {
    operation: "finishGame",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/games/game-1/goals"), {
    operation: "createGoal",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("PATCH", "/v1/games/game-1/goals/goal-1"), {
    operation: "updateGoal",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("DELETE", "/v1/games/game-1/goals/goal-1"), {
    operation: "deleteGoal",
    gameId: "game-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/games/game-1/goals/undo-last"), {
    operation: "undoLastGoal",
    gameId: "game-1",
  });
  assert.equal(resolveProtectedMutationRoute("GET", "/v1/leagues"), null);
});

test("createLeague mutation is allowed for authenticated users", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/leagues",
    "user-1",
    new InMemoryAclLookup({}),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.operation, "createLeague");
  assert.equal(result.error, null);
});

test("league-scoped mutation rejects non-admin users", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/leagues/league-1/seasons",
    "user-1",
    new InMemoryAclLookup({
      leagueAccess: {
        "league-1:user-1": {
          leagueId: "league-1",
          userId: "user-1",
          role: "scorekeeper",
          grantedByUserId: "owner",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error?.code, "admin_required");
});

test("season-scoped mutation resolves league scope and allows admins", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/seasons/season-1/sessions",
    "admin-user",
    new InMemoryAclLookup({
      seasons: {
        "season-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          name: "Season 1",
          slug: null,
          startsOn: null,
          endsOn: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      leagueAccess: {
        "league-1:admin-user": {
          leagueId: "league-1",
          userId: "admin-user",
          role: "admin",
          grantedByUserId: "admin-user",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.scope, {
    leagueId: "league-1",
    seasonId: "season-1",
  });
});

test("session-scoped mutation returns not_found when acl scope cannot be resolved", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/sessions/missing-session/games",
    "admin-user",
    new InMemoryAclLookup({}),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error?.code, "acl_scope_not_found");
});

test("game-scoped roster mutation allows scorekeepers", async () => {
  const result = await authorizeProtectedMutation(
    "PUT",
    "/v1/games/game-1/roster/player-1",
    "scorekeeper-user",
    new InMemoryAclLookup({
      games: {
        "game-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          sessionId: "session-1",
          gameId: "game-1",
          status: "scheduled",
          gameStartTs: "2026-02-23T10:00:00.000Z",
          ...defaultGameStateFields(),
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      seasons: {
        "season-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          name: "Season 1",
          slug: null,
          startsOn: null,
          endsOn: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      leagueAccess: {
        "league-1:scorekeeper-user": {
          leagueId: "league-1",
          userId: "scorekeeper-user",
          role: "scorekeeper",
          grantedByUserId: "admin-user",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.operation, "assignRosterPlayer");
  assert.deepEqual(result.scope, {
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
  });
});

test("game-scoped timer mutation allows scorekeepers", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/games/game-1/thirds/1/start",
    "scorekeeper-user",
    new InMemoryAclLookup({
      games: {
        "game-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          sessionId: "session-1",
          gameId: "game-1",
          status: "scheduled",
          gameStartTs: "2026-02-23T10:00:00.000Z",
          ...defaultGameStateFields(),
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      seasons: {
        "season-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          name: "Season 1",
          slug: null,
          startsOn: null,
          endsOn: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      leagueAccess: {
        "league-1:scorekeeper-user": {
          leagueId: "league-1",
          userId: "scorekeeper-user",
          role: "scorekeeper",
          grantedByUserId: "admin-user",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.operation, "startGameThird");
  assert.deepEqual(result.scope, {
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
  });
});

test("game-scoped goal mutation allows scorekeepers", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/games/game-1/goals",
    "scorekeeper-user",
    new InMemoryAclLookup({
      games: {
        "game-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          sessionId: "session-1",
          gameId: "game-1",
          status: "live",
          gameStartTs: "2026-02-23T10:00:00.000Z",
          ...defaultGameStateFields(),
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      seasons: {
        "season-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          name: "Season 1",
          slug: null,
          startsOn: null,
          endsOn: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      leagueAccess: {
        "league-1:scorekeeper-user": {
          leagueId: "league-1",
          userId: "scorekeeper-user",
          role: "scorekeeper",
          grantedByUserId: "admin-user",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.operation, "createGoal");
  assert.deepEqual(result.scope, {
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
  });
});

test("game team override mutation rejects scorekeepers", async () => {
  const result = await authorizeProtectedMutation(
    "PUT",
    "/v1/games/game-1/teams/red",
    "scorekeeper-user",
    new InMemoryAclLookup({
      games: {
        "game-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          sessionId: "session-1",
          gameId: "game-1",
          status: "scheduled",
          gameStartTs: "2026-02-23T10:00:00.000Z",
          ...defaultGameStateFields(),
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      seasons: {
        "season-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          name: "Season 1",
          slug: null,
          startsOn: null,
          endsOn: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      leagueAccess: {
        "league-1:scorekeeper-user": {
          leagueId: "league-1",
          userId: "scorekeeper-user",
          role: "scorekeeper",
          grantedByUserId: "admin-user",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error?.code, "admin_required");
});

test("game player creation mutation rejects viewers", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/games/game-1/players",
    "viewer-user",
    new InMemoryAclLookup({
      games: {
        "game-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          sessionId: "session-1",
          gameId: "game-1",
          status: "scheduled",
          gameStartTs: "2026-02-23T10:00:00.000Z",
          ...defaultGameStateFields(),
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      seasons: {
        "season-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          name: "Season 1",
          slug: null,
          startsOn: null,
          endsOn: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      leagueAccess: {
        "league-1:viewer-user": {
          leagueId: "league-1",
          userId: "viewer-user",
          role: "viewer",
          grantedByUserId: "admin-user",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error?.code, "scorekeeper_required");
});
