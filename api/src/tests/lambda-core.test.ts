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

interface MockLeagueRecord {
  leagueId: string;
  name: string;
  slug: string | null;
  createdByUserId: string;
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

interface MockGameRecord {
  gameId: string;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status: "scheduled" | "live" | "finished";
  gameStartTs: string;
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

interface StoredIdempotencyRecord {
  scope: string;
  key: string;
  requestHash: string;
  responseStatusCode: number;
  responseBody: string;
  createdAt: string;
  updatedAt: string;
}

interface HarnessConfig {
  sessions?: Record<string, MockSessionRecord>;
  leagueAccess?: Record<string, MockLeagueAccessRecord>;
  leagues?: Record<string, MockLeagueRecord>;
  seasons?: Record<string, MockSeasonRecord>;
  seasonSessions?: Record<string, MockSessionEntity>;
  games?: Record<string, MockGameRecord>;
}

function createEvent(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: Record<string, unknown>;
}): ApiGatewayHttpEvent {
  return {
    rawPath: input.path,
    headers: input.headers,
    cookies: input.cookies,
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
  const idempotencyRecords = new Map<string, StoredIdempotencyRecord>();
  const leagues = new Map<string, MockLeagueRecord>(Object.entries(config.leagues ?? {}));
  const seasons = new Map<string, MockSeasonRecord>(Object.entries(config.seasons ?? {}));
  const sessionEntities = new Map<string, MockSessionEntity>(
    Object.entries(config.seasonSessions ?? {}),
  );
  const games = new Map<string, MockGameRecord>(Object.entries(config.games ?? {}));

  const handler = createLambdaCoreHandler({
    sessionCookieName: "threefc_session",
    corsAllowedOrigins: ["https://qa.3fc.football"],
    sessionLookup: {
      async getSession(sessionId: string) {
        return config.sessions?.[sessionId] ?? null;
      },
    },
    repository: {
      async listLeaguesForUser(userId: string) {
        const accessibleLeagueIds = Object.values(config.leagueAccess ?? {})
          .filter((entry) => entry.userId === userId)
          .map((entry) => entry.leagueId);
        const uniqueIds = new Set(accessibleLeagueIds);
        return [...uniqueIds]
          .map((leagueId) => leagues.get(leagueId))
          .filter((league): league is MockLeagueRecord => Boolean(league));
      },
      async createLeague(input) {
        createdLeagues.push(input);
        const record = {
          leagueId: input.leagueId,
          name: input.name,
          slug: input.slug ?? null,
          createdByUserId: input.createdByUserId,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        leagues.set(input.leagueId, record);
        return record;
      },
      async getLeague(leagueId: string) {
        return leagues.get(leagueId) ?? null;
      },
      async listSeasonsForLeague(leagueId: string) {
        return [...seasons.values()].filter((season) => season.leagueId === leagueId);
      },
      async createSeason(input) {
        createdSeasons.push(input);
        const record = {
          leagueId: input.leagueId,
          seasonId: input.seasonId,
          name: input.name,
          slug: input.slug ?? null,
          startsOn: input.startsOn ?? null,
          endsOn: input.endsOn ?? null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        seasons.set(input.seasonId, record);
        return record;
      },
      async createSession(input) {
        createdSessions.push(input);
        const record = {
          ...input,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        sessionEntities.set(input.sessionId, record);
        return record;
      },
      async createGame(input) {
        createdGames.push(input);
        const record = {
          gameId: input.gameId,
          leagueId: input.leagueId,
          seasonId: input.seasonId,
          sessionId: input.sessionId,
          status: input.status ?? "scheduled",
          gameStartTs: input.gameStartTs,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        games.set(input.gameId, record);
        return record;
      },
      async createSessionGame(input) {
        createdSessionGames.push(input);
        return input;
      },
      async listGamesForSeason(seasonId: string) {
        return [...games.values()].filter((game) => game.seasonId === seasonId);
      },
      async getGame(gameId: string) {
        return games.get(gameId) ?? null;
      },
      async updateGame(input) {
        const existing = games.get(input.gameId);
        if (!existing) {
          return null;
        }

        const updated = {
          ...existing,
          status: input.status ?? existing.status,
          gameStartTs: input.gameStartTs ?? existing.gameStartTs,
          updatedAt: "2026-02-23T00:00:01.000Z",
        };
        games.set(input.gameId, updated);
        return updated;
      },
      async deleteGame(gameId: string) {
        return games.delete(gameId);
      },
      async deleteSeason(seasonId: string) {
        return seasons.delete(seasonId);
      },
      async deleteLeague(leagueId: string) {
        return leagues.delete(leagueId);
      },
      async getLeagueAccess(leagueId: string, userId: string) {
        return config.leagueAccess?.[`${leagueId}:${userId}`] ?? null;
      },
      async getSeason(seasonId: string) {
        return seasons.get(seasonId) ?? null;
      },
      async getSession(sessionId: string) {
        return sessionEntities.get(sessionId) ?? null;
      },
      async getIdempotencyRecord(scope: string, key: string) {
        return idempotencyRecords.get(`${scope}:${key}`) ?? null;
      },
      async createIdempotencyRecord(input) {
        const recordKey = `${input.scope}:${input.key}`;
        if (idempotencyRecords.has(recordKey)) {
          return false;
        }

        idempotencyRecords.set(recordKey, {
          ...input,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        });

        return true;
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
    idempotencyRecords,
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

test("core lambda accepts session cookie from API Gateway cookies array", async () => {
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
      cookies: ["threefc_session=session-1"],
      body: {
        leagueId: "league-1",
        name: "League 1",
      },
    }),
  );

  assert.equal(response.statusCode, 201);
  assert.equal(harness.createdLeagues.length, 1);
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

test("core lambda deduplicates repeated create league request by idempotency key", async () => {
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

  const event = createEvent({
    method: "POST",
    path: "/v1/leagues",
    headers: {
      Cookie: "threefc_session=session-1",
      "Idempotency-Key": "league-create-1",
    },
    body: {
      leagueId: "league-1",
      name: "League 1",
    },
  });

  const firstResponse = await harness.handler(event);
  const secondResponse = await harness.handler(event);

  assert.equal(firstResponse.statusCode, 201);
  assert.equal(secondResponse.statusCode, 201);
  assert.equal(harness.createdLeagues.length, 1);
  assert.deepEqual(JSON.parse(secondResponse.body), JSON.parse(firstResponse.body));
  assert.equal(harness.idempotencyRecords.size, 1);
});

test("core lambda rejects idempotency key reuse for different payloads", async () => {
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

  const baseHeaders = {
    Cookie: "threefc_session=session-1",
    "Idempotency-Key": "league-create-1",
  };

  const firstResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/leagues",
      headers: baseHeaders,
      body: {
        leagueId: "league-1",
        name: "League 1",
      },
    }),
  );

  const secondResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/leagues",
      headers: baseHeaders,
      body: {
        leagueId: "league-1",
        name: "League A",
      },
    }),
  );

  assert.equal(firstResponse.statusCode, 201);
  assert.equal(secondResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(secondResponse.body), {
    error: "idempotency_conflict",
    message: "Idempotency key has already been used with a different payload.",
  });
  assert.equal(harness.createdLeagues.length, 1);
});

test("core lambda rejects invalid idempotency key header", async () => {
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
        "Idempotency-Key": "   ",
      },
      body: {
        leagueId: "league-1",
        name: "League 1",
      },
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.equal(harness.createdLeagues.length, 0);
});
