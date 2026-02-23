import assert from "node:assert/strict";
import test from "node:test";

import {
  createLambdaCoreHandler,
  type ApiGatewayHttpEvent,
} from "../lambda-core.js";

interface MockSessionRecord {
  sessionId: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

interface MockLeagueAccessRecord {
  leagueId: string;
  userId: string;
  role: "admin" | "scorekeeper" | "viewer";
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface MockSeasonRecord {
  leagueId: string;
  seasonId: string;
  name: string;
  slug: string | null;
  startsOn: string | null;
  endsOn: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockSessionEntity {
  seasonId: string;
  sessionId: string;
  sessionDate: string;
  createdAt: string;
  updatedAt: string;
}

interface CreatedLeagueInput {
  leagueId: string;
  name: string;
  slug?: string | null;
  createdByUserId: string;
}

interface CreatedSeasonInput {
  leagueId: string;
  seasonId: string;
  name: string;
  slug?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}

interface CreatedSessionInput {
  seasonId: string;
  sessionId: string;
  sessionDate: string;
}

interface CreatedGameInput {
  gameId: string;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status?: "scheduled" | "live" | "finished";
  gameStartTs: string;
}

interface CreatedSessionGameInput {
  sessionId: string;
  gameId: string;
  gameStartTs: string;
  leagueId: string;
  seasonId: string;
}

interface HarnessConfig {
  sessions?: Record<string, MockSessionRecord>;
  leagueAccess?: Record<string, MockLeagueAccessRecord>;
  seasons?: Record<string, MockSeasonRecord>;
  seasonSessions?: Record<string, MockSessionEntity>;
}

function createEvent(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}): ApiGatewayHttpEvent {
  return {
    rawPath: input.path,
    headers: input.headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
    requestContext: {
      requestId: "req-test",
      http: {
        method: input.method,
        path: input.path,
      },
    },
  };
}

function createHarness(config: HarnessConfig = {}) {
  const createdLeagues: CreatedLeagueInput[] = [];
  const createdSeasons: CreatedSeasonInput[] = [];
  const createdSessions: CreatedSessionInput[] = [];
  const createdGames: CreatedGameInput[] = [];
  const createdSessionGames: CreatedSessionGameInput[] = [];

  const handler = createLambdaCoreHandler({
    sessionCookieName: "threefc_session",
    corsAllowedOrigins: ["https://qa.3fc.football"],
    sessionLookup: {
      async getSession(sessionId: string) {
        return config.sessions?.[sessionId] ?? null;
      },
    },
    repository: {
      async createLeague(input) {
        createdLeagues.push(input);
        return {
          ...input,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
      },
      async createSeason(input) {
        createdSeasons.push(input);
        return {
          ...input,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
      },
      async createSession(input) {
        createdSessions.push(input);
        return {
          ...input,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
      },
      async createGame(input) {
        createdGames.push(input);
        return {
          gameId: input.gameId,
          leagueId: input.leagueId,
          seasonId: input.seasonId,
          sessionId: input.sessionId,
          gameStartTs: input.gameStartTs,
        };
      },
      async createSessionGame(input) {
        createdSessionGames.push(input);
        return input;
      },
      async getLeagueAccess(leagueId: string, userId: string) {
        return config.leagueAccess?.[`${leagueId}:${userId}`] ?? null;
      },
      async getSeason(seasonId: string) {
        return config.seasons?.[seasonId] ?? null;
      },
      async getSession(sessionId: string) {
        return config.seasonSessions?.[sessionId] ?? null;
      },
    },
  });

  return {
    handler,
    createdLeagues,
    createdSeasons,
    createdSessions,
    createdGames,
    createdSessionGames,
  };
}

test("core lambda rejects protected mutation without session cookie", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/leagues",
      body: {
        leagueId: "league-1",
        name: "League 1",
      },
    }),
  );

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), {
    error: "unauthorized",
    message: "Valid session cookie required.",
  });
});

test("core lambda creates league for authenticated users", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/leagues",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        leagueId: "league-1",
        name: "League 1",
      },
    }),
  );

  assert.equal(response.statusCode, 201);
  assert.equal(harness.createdLeagues.length, 1);
  assert.equal(harness.createdLeagues[0].createdByUserId, "admin@example.com");
});

test("core lambda blocks non-admin season creation", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "user@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    leagueAccess: {
      "league-1:user@example.com": {
        leagueId: "league-1",
        userId: "user@example.com",
        role: "scorekeeper",
        grantedByUserId: "owner@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/leagues/league-1/seasons",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        seasonId: "season-1",
        name: "Season 1",
      },
    }),
  );

  assert.equal(response.statusCode, 403);
  assert.equal(harness.createdSeasons.length, 0);
  assert.deepEqual(JSON.parse(response.body), {
    error: "forbidden",
    code: "admin_required",
    message: "Admin role is required for league league-1.",
  });
});

test("core lambda returns not_found for unresolved ACL scope", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/seasons/season-missing/sessions",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        sessionId: "session-1",
        sessionDate: "2026-02-23",
      },
    }),
  );

  assert.equal(response.statusCode, 404);
  assert.equal(harness.createdSessions.length, 0);
  assert.deepEqual(JSON.parse(response.body), {
    error: "not_found",
    code: "acl_scope_not_found",
    message: "ACL scope could not be resolved for season season-missing.",
  });
});

test("core lambda creates game for admin with resolved ACL scope", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    seasonSessions: {
      "session-abc": {
        seasonId: "season-1",
        sessionId: "session-abc",
        sessionDate: "2026-02-23",
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
      "league-1:admin@example.com": {
        leagueId: "league-1",
        userId: "admin@example.com",
        role: "admin",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/sessions/session-abc/games",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        gameId: "game-1",
        gameStartTs: "2026-02-23T10:00:00Z",
      },
    }),
  );

  assert.equal(response.statusCode, 201);
  assert.equal(harness.createdGames.length, 1);
  assert.equal(harness.createdSessionGames.length, 1);
  assert.equal(harness.createdGames[0].leagueId, "league-1");
  assert.equal(harness.createdGames[0].seasonId, "season-1");
  assert.equal(harness.createdGames[0].sessionId, "session-abc");
});
