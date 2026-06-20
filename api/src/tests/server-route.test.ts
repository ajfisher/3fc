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
import { GameMutationStateError, GameTimerTransitionError } from "../data/repository.js";

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
  joinCode?: string;
  finishedAt?: string | null;
  result?: GameResult | null;
  thirds?: ThirdTimerSegment[];
} = {}) {
  return {
    gameId: "game-1",
    joinCode: input.joinCode ?? "JOIN1234",
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

test("local server finish route retries state-change conflicts before storing results", async () => {
  const request = createMockRequest({
    headers: {
      "idempotency-key": "finish-local-retry-conflict-1",
    },
  });
  const response = createMockResponse();
  const finished = gameRecord({
    status: "finished",
    finishedAt: "2026-02-23T00:05:00.000Z",
    result,
  });
  let finishGameCalls = 0;
  let storedStatusCode: number | null = null;
  const repositoryClient = {
    async getGame() {
      return gameRecord();
    },
    async finishGame() {
      finishGameCalls += 1;
      if (finishGameCalls === 1) {
        throw new GameTimerTransitionError(
          "game_state_changed",
          "Game game-1 changed before the finish write committed.",
        );
      }

      return finished;
    },
    async getLeagueAccess() {
      return scorekeeperAccess;
    },
    async getIdempotencyRecord() {
      return null;
    },
    async createIdempotencyRecord(record: { responseStatusCode: number }) {
      storedStatusCode = record.responseStatusCode;
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
  assert.equal(finishGameCalls, 2);
  const body = JSON.parse(response.body) as { status: string; result: GameResult };
  assert.equal(body.status, "finished");
  assert.equal(body.result.winnerTeamId, "red");
});

test("local server finish route uses a consistent finished read after team setup races", async () => {
  const request = createMockRequest({
    headers: {
      "idempotency-key": "finish-local-team-race-1",
    },
  });
  const response = createMockResponse();
  const finished = gameRecord({
    status: "finished",
    finishedAt: "2026-02-23T00:05:00.000Z",
    result,
  });
  const getGameCalls: Array<{ consistentRead: boolean }> = [];
  const listTeamsForSeasonCalls: Array<{ consistentRead: boolean }> = [];
  let storedStatusCode: number | null = null;
  const repositoryClient = {
    async getGame(_gameId: string, options: { consistentRead?: boolean } = {}) {
      getGameCalls.push({ consistentRead: options.consistentRead ?? false });
      return getGameCalls.length === 1 ? gameRecord() : finished;
    },
    async finishGame() {
      throw new Error("finishGame should not be called after team setup race recovery");
    },
    async getLeagueAccess() {
      return scorekeeperAccess;
    },
    async getIdempotencyRecord() {
      return null;
    },
    async createIdempotencyRecord(record: { responseStatusCode: number }) {
      storedStatusCode = record.responseStatusCode;
      return true;
    },
    async listTeamsForSeason(_seasonId: string, options: { consistentRead?: boolean } = {}) {
      listTeamsForSeasonCalls.push({ consistentRead: options.consistentRead ?? false });
      return seasonTeams;
    },
    async createTeam() {
      throw new Error("season teams should already exist");
    },
    async listTeamsForGame() {
      return gameTeams.slice(1);
    },
    async createGameTeamOverride() {
      throw new GameMutationStateError(
        "game_state_changed",
        "Game game-1 changed before the team override could be saved. Reload and try again.",
      );
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
  assert.equal(
    getGameCalls.some((call) => call.consistentRead),
    true,
  );
  assert.equal(
    listTeamsForSeasonCalls.some((call) => call.consistentRead),
    true,
  );
  const body = JSON.parse(response.body) as { status: string; result: GameResult };
  assert.equal(body.status, "finished");
  assert.equal(body.result.winnerTeamId, "red");
});

test("local server finish route repairs incomplete finished games after team setup races", async () => {
  const request = createMockRequest({
    headers: {
      "idempotency-key": "finish-local-incomplete-repair-1",
    },
  });
  const response = createMockResponse();
  const incompleteFinished = gameRecord({
    status: "finished",
    finishedAt: null,
    result: null,
  });
  const repairedFinished = gameRecord({
    status: "finished",
    finishedAt: "2026-02-23T00:05:00.000Z",
    result,
  });
  const storedSeasonTeams = seasonTeams.slice(1);
  const createdSeasonTeams: Array<{ teamId: TeamId; createOnly?: boolean }> = [];
  const createdGameTeams: Array<{ teamId: TeamId; allowFinished?: boolean; createOnly?: boolean }> = [];
  const listTeamsForSeasonCalls: Array<{ consistentRead: boolean }> = [];
  const listTeamsForGameCalls: Array<{ consistentRead: boolean }> = [];
  const getGameCalls: Array<{ consistentRead: boolean }> = [];
  let finishGameCalls = 0;
  let createGameTeamOverrideCalls = 0;
  const repositoryClient = {
    async getGame(_gameId: string, options: { consistentRead?: boolean } = {}) {
      getGameCalls.push({ consistentRead: options.consistentRead ?? false });
      return getGameCalls.length === 1 ? gameRecord() : incompleteFinished;
    },
    async finishGame() {
      finishGameCalls += 1;
      return repairedFinished;
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
    async listTeamsForSeason(_seasonId: string, options: { consistentRead?: boolean } = {}) {
      listTeamsForSeasonCalls.push({ consistentRead: options.consistentRead ?? false });
      return storedSeasonTeams;
    },
    async createTeam(input: { teamId: TeamId; createOnly?: boolean }) {
      createdSeasonTeams.push({
        teamId: input.teamId,
        createOnly: input.createOnly,
      });
      const record = {
        seasonId: "season-1",
        teamId: input.teamId,
        name: "Red",
        color: "#d83b36",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      };
      storedSeasonTeams.push(record);
      return record;
    },
    async listTeamsForGame(_gameId: string, options: { consistentRead?: boolean } = {}) {
      listTeamsForGameCalls.push({ consistentRead: options.consistentRead ?? false });
      return gameTeams.slice(1);
    },
    async createGameTeamOverride(input: {
      teamId: TeamId;
      allowFinished?: boolean;
      createOnly?: boolean;
    }) {
      createGameTeamOverrideCalls += 1;
      if (createGameTeamOverrideCalls === 1) {
        throw new GameMutationStateError(
          "game_finished",
          "Game game-1 is finished. Admin role is required to mutate finished games.",
        );
      }

      createdGameTeams.push({
        teamId: input.teamId,
        allowFinished: input.allowFinished,
        createOnly: input.createOnly,
      });
      return {
        gameId: "game-1",
        teamId: input.teamId,
        name: "Red",
        color: "#d83b36",
        scored: 0,
        conceded: 0,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      };
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
  assert.equal(finishGameCalls, 1);
  assert.equal(listTeamsForSeasonCalls.some((call) => call.consistentRead), true);
  assert.deepEqual(createdSeasonTeams, [{ teamId: "red", createOnly: true }]);
  assert.equal(listTeamsForGameCalls.some((call) => call.consistentRead), true);
  assert.deepEqual(createdGameTeams, [
    { teamId: "red", allowFinished: true, createOnly: true },
  ]);
  const body = JSON.parse(response.body) as { status: string; result: GameResult | null };
  assert.equal(body.status, "finished");
  assert.ok(body.result);
});

test("local server finish route rereads completed repair after repair conflicts", async () => {
  const request = createMockRequest({
    headers: {
      "idempotency-key": "finish-local-incomplete-repair-race-1",
    },
  });
  const response = createMockResponse();
  const incompleteFinished = gameRecord({
    status: "finished",
    finishedAt: null,
    result: null,
  });
  const repairedFinished = gameRecord({
    status: "finished",
    finishedAt: "2026-02-23T00:05:00.000Z",
    result,
  });
  const storedSeasonTeams = seasonTeams.slice(1);
  const getGameCalls: Array<{ consistentRead: boolean }> = [];
  let createGameTeamOverrideCalls = 0;
  let finishGameCalls = 0;
  let storedStatusCode: number | null = null;
  const repositoryClient = {
    async getGame(_gameId: string, options: { consistentRead?: boolean } = {}) {
      getGameCalls.push({ consistentRead: options.consistentRead ?? false });
      if (getGameCalls.length === 1) {
        return gameRecord();
      }
      if (getGameCalls.length === 2) {
        return incompleteFinished;
      }
      if (getGameCalls.length === 3) {
        return incompleteFinished;
      }
      return repairedFinished;
    },
    async finishGame() {
      finishGameCalls += 1;
      throw new GameTimerTransitionError(
        "game_state_changed",
        "Game changed while finishing. Reload the game and try again.",
      );
    },
    async getLeagueAccess() {
      return scorekeeperAccess;
    },
    async getIdempotencyRecord() {
      return null;
    },
    async createIdempotencyRecord(record: { responseStatusCode: number }) {
      storedStatusCode = record.responseStatusCode;
      return true;
    },
    async listTeamsForSeason() {
      return storedSeasonTeams;
    },
    async createTeam(input: { teamId: TeamId; createOnly?: boolean }) {
      const record = {
        seasonId: "season-1",
        teamId: input.teamId,
        name: "Red",
        color: "#d83b36",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      };
      storedSeasonTeams.push(record);
      return record;
    },
    async listTeamsForGame() {
      return gameTeams.slice(1);
    },
    async createGameTeamOverride() {
      createGameTeamOverrideCalls += 1;
      if (createGameTeamOverrideCalls === 1) {
        throw new GameMutationStateError(
          "game_finished",
          "Game game-1 is finished. Admin role is required to mutate finished games.",
        );
      }

      return {
        gameId: "game-1",
        teamId: "red" as TeamId,
        name: "Red",
        color: "#d83b36",
        scored: 0,
        conceded: 0,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      };
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
  assert.equal(finishGameCalls, 1);
  assert.equal(getGameCalls.filter((call) => call.consistentRead).length >= 3, true);
  const body = JSON.parse(response.body) as { status: string; result: GameResult | null };
  assert.equal(body.status, "finished");
  assert.ok(body.result);
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
