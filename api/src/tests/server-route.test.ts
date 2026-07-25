import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type { GameResult, TeamId, ThirdTimerSegment } from "@3fc/contracts";
import { createDefaultThirdTimerSegments } from "@3fc/contracts";

import {
  handleLocalDeleteGameRoute,
  handleLocalFinishGameRoute,
  handleLocalUpdateGameTeamRoute,
} from "../server.js";
import { GameTimerTransitionError } from "../data/repository.js";

class MockResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? "";
  }
}

function createMockRequest(input: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
} = {}): IncomingMessage {
  const chunks = input.body ? [Buffer.from(JSON.stringify(input.body))] : [];
  return {
    headers: input.headers ?? {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as IncomingMessage;
}

function createMockResponse(): MockResponse & ServerResponse {
  return new MockResponse() as MockResponse & ServerResponse;
}

function completedThirds(): ThirdTimerSegment[] {
  return createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-02-23T00:0${third.third}:00.000Z`,
    finishedAt: `2026-02-23T00:0${third.third}:30.000Z`,
  }));
}

const result: GameResult = {
  winnerTeamId: "red",
  outcome: "win",
  comparator: "fewest_conceded_then_most_scored",
  computedAt: "2026-02-23T00:05:00.000Z",
  teams: [
    {
      teamId: "red",
      name: "Red",
      color: "#d83b36",
      scored: 1,
      conceded: 0,
      rank: 1,
      outcome: "win",
    },
    {
      teamId: "yellow",
      name: "Yellow",
      color: "#e0a612",
      scored: 0,
      conceded: 0,
      rank: 2,
      outcome: "loss",
    },
    {
      teamId: "blue",
      name: "Blue",
      color: "#2364d2",
      scored: 0,
      conceded: 1,
      rank: 3,
      outcome: "loss",
    },
  ],
};

function gameRecord(input: {
  status?: "scheduled" | "live" | "finished";
  finishedAt?: string | null;
  result?: GameResult | null;
  thirds?: ThirdTimerSegment[];
} = {}) {
  return {
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: input.status ?? "live",
    gameStartTs: "2026-02-23T10:00:00.000Z",
    thirdLengthMinutes: 20 as const,
    thirds: input.thirds ?? completedThirds(),
    finishedAt: input.finishedAt ?? null,
    result: input.result ?? null,
    createdAt: "2026-02-23T00:00:00.000Z",
    updatedAt: "2026-02-23T00:00:00.000Z",
  };
}

const seasonTeams = [
  { seasonId: "season-1", teamId: "red" as TeamId, name: "Red", color: "#d83b36", createdAt: "", updatedAt: "" },
  { seasonId: "season-1", teamId: "blue" as TeamId, name: "Blue", color: "#2364d2", createdAt: "", updatedAt: "" },
  { seasonId: "season-1", teamId: "yellow" as TeamId, name: "Yellow", color: "#e0a612", createdAt: "", updatedAt: "" },
];

const gameTeams = seasonTeams.map((team) => ({
  gameId: "game-1",
  teamId: team.teamId,
  name: team.name,
  color: team.color,
  scored: team.teamId === "red" ? 1 : 0,
  conceded: team.teamId === "blue" ? 1 : 0,
  createdAt: "",
  updatedAt: "",
}));

const scorekeeperAccess = {
  leagueId: "league-1",
  userId: "scorekeeper@example.com",
  role: "scorekeeper" as const,
  grantedByUserId: "admin@example.com",
  createdAt: "2026-02-23T00:00:00.000Z",
  updatedAt: "2026-02-23T00:00:00.000Z",
};

test("local server finish route returns finished game result", async () => {
  const request = createMockRequest({
    headers: {
      "idempotency-key": "finish-local-1",
    },
  });
  const response = createMockResponse();
  const finished = gameRecord({
    status: "finished",
    finishedAt: "2026-02-23T00:05:00.000Z",
    result,
  });
  const repositoryClient = {
    async getGame() {
      return gameRecord();
    },
    async finishGame() {
      return finished;
    },
    async getLeagueAccess() {
      return scorekeeperAccess;
    },
    async getIdempotencyRecord() {
      return null;
    },
    async createIdempotencyRecord() {
      return true;
    },
    async listTeamsForSeason() {
      return seasonTeams;
    },
    async createTeam() {
      throw new Error("season teams should already exist");
    },
    async listTeamsForGame() {
      return gameTeams;
    },
    async createGameTeamOverride() {
      throw new Error("game teams should already exist");
    },
  };

  const status = await handleLocalFinishGameRoute({
    request,
    response,
    method: "POST",
    route: "/v1/games/game-1/finish",
    gameId: "game-1",
    sessionEmail: "scorekeeper@example.com",
    repositoryClient,
  });

  assert.equal(status, 200);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as { status: string; result: GameResult };
  assert.equal(body.status, "finished");
  assert.equal(body.result.winnerTeamId, "red");
});

test("local server finish route returns existing result for already-finished games", async () => {
  const request = createMockRequest({
    headers: {
      "idempotency-key": "finish-local-existing-1",
    },
  });
  const response = createMockResponse();
  const finished = gameRecord({
    status: "finished",
    finishedAt: "2026-02-23T00:05:00.000Z",
    result,
  });
  const repositoryClient = {
    async getGame() {
      return finished;
    },
    async finishGame() {
      return finished;
    },
    async getLeagueAccess() {
      return scorekeeperAccess;
    },
    async getIdempotencyRecord() {
      return null;
    },
    async createIdempotencyRecord() {
      return true;
    },
    async listTeamsForSeason() {
      return seasonTeams;
    },
    async createTeam() {
      throw new Error("season teams should already exist");
    },
    async listTeamsForGame() {
      return gameTeams;
    },
    async createGameTeamOverride() {
      throw new Error("game teams should already exist");
    },
  };

  const status = await handleLocalFinishGameRoute({
    request,
    response,
    method: "POST",
    route: "/v1/games/game-1/finish",
    gameId: "game-1",
    sessionEmail: "scorekeeper@example.com",
    repositoryClient,
  });

  assert.equal(status, 200);
  const body = JSON.parse(response.body) as { status: string; result: GameResult };
  assert.equal(body.status, "finished");
  assert.equal(body.result.winnerTeamId, "red");
});

test("local server finish route recovers concurrent finished game state", async () => {
  const request = createMockRequest({
    headers: {
      "idempotency-key": "finish-local-race-1",
    },
  });
  const response = createMockResponse();
  const finished = gameRecord({
    status: "finished",
    finishedAt: "2026-02-23T00:05:00.000Z",
    result,
  });
  let getGameCalls = 0;
  let storedStatusCode: number | null = null;
  let storedBody: string | null = null;
  const repositoryClient = {
    async getGame() {
      getGameCalls += 1;
      return getGameCalls === 1 ? gameRecord() : finished;
    },
    async finishGame() {
      throw new GameTimerTransitionError(
        "game_state_changed",
        "Game game-1 changed before the finish write committed.",
      );
    },
    async getLeagueAccess() {
      return scorekeeperAccess;
    },
    async getIdempotencyRecord() {
      return null;
    },
    async createIdempotencyRecord(record: { responseStatusCode: number; responseBody: string }) {
      storedStatusCode = record.responseStatusCode;
      storedBody = record.responseBody;
      return true;
    },
    async listTeamsForSeason() {
      return seasonTeams;
    },
    async createTeam() {
      throw new Error("season teams should already exist");
    },
    async listTeamsForGame() {
      return gameTeams;
    },
    async createGameTeamOverride() {
      throw new Error("game teams should already exist");
    },
  };

  const status = await handleLocalFinishGameRoute({
    request,
    response,
    method: "POST",
    route: "/v1/games/game-1/finish",
    gameId: "game-1",
    sessionEmail: "scorekeeper@example.com",
    repositoryClient,
  });

  assert.equal(status, 200);
  assert.equal(response.statusCode, 200);
  assert.equal(storedStatusCode, 200);
  assert.equal((JSON.parse(storedBody ?? "{}") as { status?: string }).status, "finished");
  const body = JSON.parse(response.body) as { status: string; result: GameResult };
  assert.equal(body.status, "finished");
  assert.equal(body.result.winnerTeamId, "red");
});

test("local server finish route maps incomplete thirds to conflict", async () => {
  const request = createMockRequest({
    headers: {
      "idempotency-key": "finish-local-incomplete-1",
    },
  });
  const response = createMockResponse();
  const repositoryClient = {
    async getGame() {
      return gameRecord({
        thirds: createDefaultThirdTimerSegments(),
      });
    },
    async finishGame() {
      throw new GameTimerTransitionError(
        "thirds_incomplete",
        "All three thirds must be started and finished before the game can be finished.",
      );
    },
    async getLeagueAccess() {
      return scorekeeperAccess;
    },
    async getIdempotencyRecord() {
      return null;
    },
    async createIdempotencyRecord() {
      return true;
    },
    async listTeamsForSeason() {
      return seasonTeams;
    },
    async createTeam() {
      throw new Error("season teams should already exist");
    },
    async listTeamsForGame() {
      return gameTeams;
    },
    async createGameTeamOverride() {
      throw new Error("game teams should already exist");
    },
  };

  const status = await handleLocalFinishGameRoute({
    request,
    response,
    method: "POST",
    route: "/v1/games/game-1/finish",
    gameId: "game-1",
    sessionEmail: "scorekeeper@example.com",
    repositoryClient,
  });

  assert.equal(status, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "thirds_incomplete",
    message: "All three thirds must be started and finished before the game can be finished.",
  });
});

test("local server team override route allows finished-game admin corrections", async () => {
  const request = createMockRequest({
    body: {
      name: "Renamed Red",
      color: "#cc0000",
    },
  });
  const response = createMockResponse();
  let overrideWrites = 0;
  const repositoryClient = {
    async getGame() {
      return gameRecord({
        status: "finished",
        finishedAt: "2026-02-23T00:05:00.000Z",
        result,
      });
    },
    async listTeamsForSeason() {
      return seasonTeams;
    },
    async createTeam() {
      throw new Error("season teams should already exist");
    },
    async listTeamsForGame() {
      return gameTeams;
    },
    async createGameTeamOverride(input: { allowFinished?: boolean }) {
      overrideWrites += 1;
      assert.equal(input.allowFinished, true);
      return {
        gameId: "game-1",
        teamId: "red" as const,
        name: "Renamed Red",
        color: "#cc0000",
        scored: 0,
        conceded: 0,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      };
    },
  };

  const status = await handleLocalUpdateGameTeamRoute({
    request,
    response,
    gameId: "game-1",
    teamId: "red",
    repositoryClient,
  });

  assert.equal(status, 200);
  assert.equal(overrideWrites, 1);
  assert.deepEqual(JSON.parse(response.body), {
    gameId: "game-1",
    teamId: "red",
    name: "Renamed Red",
    color: "#cc0000",
    scored: 0,
    conceded: 0,
    createdAt: "2026-02-23T00:00:00.000Z",
    updatedAt: "2026-02-23T00:00:00.000Z",
  });
});

test("local server delete game route locks finished games", async () => {
  const request = createMockRequest();
  const response = createMockResponse();
  let deletedGames = 0;
  const repositoryClient = {
    async getGame() {
      return gameRecord({
        status: "finished",
        finishedAt: "2026-02-23T00:05:00.000Z",
        result,
      });
    },
    async getLeagueAccess() {
      return {
        leagueId: "league-1",
        userId: "admin@example.com",
        role: "admin" as const,
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      };
    },
    async deleteGame() {
      deletedGames += 1;
      throw new Error("finished games should not be deleted");
    },
  };

  const status = await handleLocalDeleteGameRoute({
    request,
    response,
    gameId: "game-1",
    sessionEmail: "admin@example.com",
    repositoryClient,
  });

  assert.equal(status, 409);
  assert.equal(deletedGames, 0);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Finished games cannot be deleted.",
  });
});

test("local server delete game route maps concurrent finish to conflict", async () => {
  const request = createMockRequest();
  const response = createMockResponse();
  let getGameCalls = 0;
  let deleteCalls = 0;
  const repositoryClient = {
    async getGame() {
      getGameCalls += 1;
      return getGameCalls === 1
        ? gameRecord({ status: "live" })
        : gameRecord({
            status: "finished",
            finishedAt: "2026-02-23T00:05:00.000Z",
            result,
          });
    },
    async getLeagueAccess() {
      return {
        leagueId: "league-1",
        userId: "admin@example.com",
        role: "admin" as const,
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      };
    },
    async deleteGame() {
      deleteCalls += 1;
      return false;
    },
  };

  const status = await handleLocalDeleteGameRoute({
    request,
    response,
    gameId: "game-1",
    sessionEmail: "admin@example.com",
    repositoryClient,
  });

  assert.equal(status, 409);
  assert.equal(deleteCalls, 1);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Finished games cannot be deleted.",
  });
});
