import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createLambdaCoreHandler,
  type ApiGatewayHttpEvent,
} from "../lambda-core.js";
import type { RateLimitDecision } from "../auth/rate-limit.js";
import { PUBLIC_JOIN_NICKNAME_MAX_LENGTH } from "../contracts/core-write.js";
import {
  createDefaultThirdTimerSegments,
  DEFAULT_THIRD_LENGTH_MINUTES,
  formatThirdDisplayTime,
  TEAM_IDS,
  type GameResult,
  type TeamId,
  type ThirdLengthMinutes,
  type ThirdTimerSegment,
} from "@3fc/contracts";
import {
  buildJoinCodeForGameId,
  GameAlreadyExistsError,
  GameJoinCodeCollisionError,
  GameJoinRegistrationError,
  GameMutationStateError,
  GameTimerTransitionError,
  GoalCorrectionError,
  GoalCreationError,
} from "../data/repository.js";

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
  joinCode: string;
  createRequestHash?: string;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status: "scheduled" | "live" | "finished";
  gameStartTs: string;
  thirdLengthMinutes: ThirdLengthMinutes;
  thirds: ThirdTimerSegment[];
  finishedAt: string | null;
  result: GameResult | null;
  createdAt: string;
  updatedAt: string;
}

type MockGameInput = Omit<MockGameRecord, "joinCode" | "thirdLengthMinutes" | "thirds" | "finishedAt" | "result"> &
  Partial<Pick<MockGameRecord, "joinCode" | "thirdLengthMinutes" | "thirds" | "finishedAt" | "result">>;

interface MockSeasonTeamRecord {
  seasonId: string;
  teamId: TeamId;
  name: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockGameTeamRecord {
  gameId: string;
  teamId: TeamId;
  name: string;
  color: string | null;
  scored: number;
  conceded: number;
  createdAt: string;
  updatedAt: string;
}

type MockGameTeamInput = Omit<MockGameTeamRecord, "scored" | "conceded"> &
  Partial<Pick<MockGameTeamRecord, "scored" | "conceded">>;

interface MockPlayerRecord {
  playerId: string;
  nickname: string;
  claimedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockRosterAssignmentRecord {
  gameId: string;
  teamId: TeamId;
  playerId: string;
  createdAt: string;
  updatedAt: string;
}

interface MockGamePlayerRecord {
  gameId: string;
  playerId: string;
  createdAt: string;
  updatedAt: string;
}

interface MockGoalEventRecord {
  gameId: string;
  eventId: string;
  third: 1 | 2 | 3;
  thirdMinute: number;
  gameMinute: number;
  elapsedSeconds: number;
  stoppageMinute: number | null;
  displayTime: string;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
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
  joinCode?: string | null;
  createRequestHash?: string | null;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status?: "scheduled" | "live" | "finished";
  gameStartTs: string;
  thirdLengthMinutes?: ThirdLengthMinutes;
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
  games?: Record<string, MockGameInput>;
  legacyJoinCodeRepairs?: Record<string, string>;
  seasonTeams?: Record<string, MockSeasonTeamRecord>;
  gameTeams?: Record<string, MockGameTeamInput>;
  players?: Record<string, MockPlayerRecord>;
  rosterAssignments?: Record<string, MockRosterAssignmentRecord>;
  gamePlayers?: Record<string, MockGamePlayerRecord>;
  finishGameStateChangedOnce?: boolean;
  finishGameStateChangedWithIncompleteFinishOnce?: boolean;
  finishGameStateChangedWithoutFinishOnce?: boolean;
  deleteGameFinishesBeforeDeleteOnce?: boolean;
  createGameTeamOverrideStateChangedOnce?: boolean;
  createGameTeamOverrideFinishesIncompleteOnce?: boolean;
  completeFinishedRepairAfterConsistentReads?: number;
  joinGameByCodeStateChangedOnce?: boolean;
  createAndLinkGamePlayerStateChangedOnce?: boolean;
  assignRosterPlayerStateChangedOnce?: boolean;
  finishBeforeGoalCorrectionOnce?: boolean;
  createSessionGameFailures?: number;
  rateLimitDecision?:
    | RateLimitDecision
    | ((input: { email: string; clientIp: string }) => RateLimitDecision);
  beforeIdempotencyRecordRead?: (input: {
    scope: string;
    key: string;
    readCount: number;
    records: Map<string, StoredIdempotencyRecord>;
  }) => void;
}

function createEvent(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: Record<string, unknown>;
  sourceIp?: string;
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
        sourceIp: input.sourceIp,
      },
    },
  };
}

function normalizePayloadForTestHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizePayloadForTestHash);
  }

  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, normalizePayloadForTestHash(source[key])] as const),
    );
  }

  return value;
}

function buildTestIdempotencyRequestHash(scope: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${scope}:${JSON.stringify(normalizePayloadForTestHash(payload))}`)
    .digest("hex");
}

function completedThirdTimerSegments(): ThirdTimerSegment[] {
  return createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-02-23T00:0${third.third}:00.000Z`,
    finishedAt: `2026-02-23T00:0${third.third}:30.000Z`,
  }));
}

function createHarness(config: HarnessConfig = {}) {
  const createdLeagues: CreatedLeagueInput[] = [];
  const createdSeasons: CreatedSeasonInput[] = [];
  const createdSessions: CreatedSessionInput[] = [];
  const createdGames: CreatedGameInput[] = [];
  const createdSessionGames: CreatedSessionGameInput[] = [];
  const createdSeasonTeams: Array<{
    seasonId: string;
    teamId: TeamId;
    name: string;
    color?: string | null;
    createOnly?: boolean;
  }> = [];
  const createdGameTeams: Array<{
    gameId: string;
    teamId: TeamId;
    name: string;
    color?: string | null;
    allowFinished?: boolean;
    createOnly?: boolean;
  }> = [];
  const createdPlayers: Array<{ playerId: string; nickname: string; claimedByUserId?: string | null }> = [];
  const createdGoals: Array<{
    gameId: string;
    eventId: string;
    actorUserId: string;
    allowFinished?: boolean;
    scoringTeamId: TeamId | null;
    concedingTeamId: TeamId;
    scorerPlayerId: string;
    assistPlayerIds: string[];
    ownGoal: boolean;
  }> = [];
  const updatedGoals: Array<{ gameId: string; eventId: string; allowFinished?: boolean }> = [];
  const deletedGoals: Array<{ gameId: string; eventId: string; allowFinished?: boolean }> = [];
  const undoneGoals: Array<{ gameId: string; expectedEventId: string; allowFinished?: boolean }> = [];
  const deletedGames: string[] = [];
  const assignedRosterPlayers: Array<{ gameId: string; teamId: TeamId; playerId: string }> = [];
  const linkedGamePlayers: Array<{ gameId: string; playerId: string }> = [];
  const magicLinkStarts: string[] = [];
  const magicLinkCompletes: string[] = [];
  const magicLinkRateLimitChecks: Array<{ email: string; clientIp: string }> = [];
  const getGameCalls: Array<{
    gameId: string;
    consistentRead: boolean;
    repairLegacyJoinCode: boolean;
  }> = [];
  const listTeamsForSeasonCalls: Array<{ seasonId: string; consistentRead: boolean }> = [];
  const listTeamsForGameCalls: Array<{ gameId: string; consistentRead: boolean }> = [];
  const idempotencyRecords = new Map<string, StoredIdempotencyRecord>();
  let finishGameStateChangedOnce = config.finishGameStateChangedOnce ?? false;
  let finishGameStateChangedWithIncompleteFinishOnce =
    config.finishGameStateChangedWithIncompleteFinishOnce ?? false;
  let finishGameStateChangedWithoutFinishOnce = config.finishGameStateChangedWithoutFinishOnce ?? false;
  let deleteGameFinishesBeforeDeleteOnce = config.deleteGameFinishesBeforeDeleteOnce ?? false;
  let createGameTeamOverrideStateChangedOnce = config.createGameTeamOverrideStateChangedOnce ?? false;
  let createGameTeamOverrideFinishesIncompleteOnce =
    config.createGameTeamOverrideFinishesIncompleteOnce ?? false;
  let completeFinishedRepairAfterConsistentReads = config.completeFinishedRepairAfterConsistentReads ?? 0;
  let joinGameByCodeStateChangedOnce = config.joinGameByCodeStateChangedOnce ?? false;
  let createAndLinkGamePlayerStateChangedOnce = config.createAndLinkGamePlayerStateChangedOnce ?? false;
  let assignRosterPlayerStateChangedOnce = config.assignRosterPlayerStateChangedOnce ?? false;
  let finishBeforeGoalCorrectionOnce = config.finishBeforeGoalCorrectionOnce ?? false;
  let createSessionGameFailures = config.createSessionGameFailures ?? 0;
  const idempotencyRecordReads = new Map<string, number>();
  const leagues = new Map<string, MockLeagueRecord>(Object.entries(config.leagues ?? {}));
  const seasons = new Map<string, MockSeasonRecord>(Object.entries(config.seasons ?? {}));
  const sessionEntities = new Map<string, MockSessionEntity>(
    Object.entries(config.seasonSessions ?? {}),
  );
  const games = new Map<string, MockGameRecord>(
    Object.entries(config.games ?? {}).map(([gameId, game]) => [
      gameId,
      {
        ...game,
        joinCode: game.joinCode ?? buildJoinCodeForGameId(game.gameId),
        ...(game.createRequestHash ? { createRequestHash: game.createRequestHash } : {}),
        thirdLengthMinutes: game.thirdLengthMinutes ?? DEFAULT_THIRD_LENGTH_MINUTES,
        thirds: game.thirds ?? createDefaultThirdTimerSegments(),
        finishedAt: game.finishedAt ?? null,
        result: game.result ?? null,
      },
    ]),
  );
  const seasonTeams = new Map<string, MockSeasonTeamRecord>(
    Object.entries(config.seasonTeams ?? {}),
  );
  const gameTeams = new Map<string, MockGameTeamRecord>(
    Object.entries(config.gameTeams ?? {}).map(([key, team]) => [
      key,
      {
        ...team,
        scored: team.scored ?? 0,
        conceded: team.conceded ?? 0,
      },
    ]),
  );
  const players = new Map<string, MockPlayerRecord>(Object.entries(config.players ?? {}));
  const rosterAssignments = new Map<string, MockRosterAssignmentRecord>(
    Object.entries(config.rosterAssignments ?? {}),
  );
  const gamePlayers = new Map<string, MockGamePlayerRecord>(
    Object.entries(config.gamePlayers ?? {}),
  );
  const goalEvents = new Map<string, MockGoalEventRecord>();
  const goalAuditEntries: Array<{
    auditId: string;
    gameId: string;
    eventId: string;
    actorUserId: string;
    action: "goal_created" | "goal_updated" | "goal_deleted" | "goal_undo_last";
    before: MockGoalEventRecord | null;
    after: MockGoalEventRecord | null;
    createdAt: string;
    updatedAt: string;
  }> = [];

  function sortedGameTeams(gameId: string): MockGameTeamRecord[] {
    return [...gameTeams.values()]
      .filter((team) => team.gameId === gameId)
      .sort((left, right) => TEAM_IDS.indexOf(left.teamId) - TEAM_IDS.indexOf(right.teamId));
  }

  function sortedGoalTimeline(gameId: string): MockGoalEventRecord[] {
    return [...goalEvents.values()]
      .filter((entry) => entry.gameId === gameId)
      .sort((left, right) => {
        const thirdSort = left.third - right.third;
        if (thirdSort !== 0) {
          return thirdSort;
        }

        const minuteSort = left.gameMinute - right.gameMinute;
        if (minuteSort !== 0) {
          return minuteSort;
        }

        const elapsedSort = left.elapsedSeconds - right.elapsedSeconds;
        if (elapsedSort !== 0) {
          return elapsedSort;
        }

        return left.eventId.localeCompare(right.eventId);
      });
  }

  function latestGoal(gameId: string): MockGoalEventRecord | null {
    return sortedGoalTimeline(gameId).at(-1) ?? null;
  }

  function buildMockGameResult(gameId: string, computedAt: string): GameResult {
    const rankedTeams = sortedGameTeams(gameId).sort((left, right) => {
      const concededSort = left.conceded - right.conceded;
      if (concededSort !== 0) {
        return concededSort;
      }

      const scoredSort = right.scored - left.scored;
      if (scoredSort !== 0) {
        return scoredSort;
      }

      return TEAM_IDS.indexOf(left.teamId) - TEAM_IDS.indexOf(right.teamId);
    });
    const topTeam = rankedTeams[0] ?? null;
    const topTiedTeams = topTeam
      ? rankedTeams.filter(
          (team) => team.conceded === topTeam.conceded && team.scored === topTeam.scored,
        )
      : [];
    const winnerTeamId = topTiedTeams.length === 1 ? topTiedTeams[0].teamId : null;
    let previousTeam: MockGameTeamRecord | null = null;
    let previousRank = 0;

    return {
      winnerTeamId,
      outcome: winnerTeamId ? "win" : "draw",
      comparator: "fewest_conceded_then_most_scored",
      computedAt,
      teams: rankedTeams.map((team, index) => {
        const samePosition =
          previousTeam !== null &&
          previousTeam.conceded === team.conceded &&
          previousTeam.scored === team.scored;
        const rank = samePosition ? previousRank : index + 1;
        previousTeam = team;
        previousRank = rank;

        return {
          teamId: team.teamId,
          name: team.name,
          color: team.color,
          scored: team.scored,
          conceded: team.conceded,
          rank,
          outcome: winnerTeamId
            ? team.teamId === winnerTeamId
              ? "win"
              : "loss"
            : topTeam && team.conceded === topTeam.conceded && team.scored === topTeam.scored
              ? "draw"
              : "loss",
        };
      }),
    };
  }

  function isCompleteMockGameResult(result: GameResult | null): result is GameResult {
    const resultTeams = result?.teams ?? [];
    const resultTeamIds = new Set(resultTeams.map((team) => team.teamId));
    return (
      resultTeams.length === TEAM_IDS.length &&
      TEAM_IDS.every((teamId) => resultTeamIds.has(teamId))
    );
  }

  function finishGameBeforeGoalCorrection(gameId: string): void {
    if (!finishBeforeGoalCorrectionOnce) {
      return;
    }

    finishBeforeGoalCorrectionOnce = false;
    const existing = games.get(gameId);
    if (!existing) {
      return;
    }

    const finishedAt = "2026-02-23T00:00:06.000Z";
    games.set(gameId, {
      ...existing,
      status: "finished",
      finishedAt,
      result: buildMockGameResult(gameId, finishedAt),
      updatedAt: finishedAt,
    });
  }

  function rejectFinishedGoalCorrectionUnlessAllowed(input: {
    gameId: string;
    allowFinished?: boolean;
  }): void {
    const game = games.get(input.gameId);
    if (game?.status !== "finished" || input.allowFinished === true) {
      return;
    }

    throw new GoalCorrectionError(
      "game_finished",
      409,
      `Game ${input.gameId} is finished. Admin role is required to mutate finished games.`,
    );
  }

  function validateMockGoal(goal: {
    gameId: string;
    scoringTeamId: TeamId | null;
    concedingTeamId: TeamId;
    scorerPlayerId: string;
    assistPlayerIds: string[];
    ownGoal: boolean;
  }): void {
    const gameTeamIds = new Set(sortedGameTeams(goal.gameId).map((team) => team.teamId));
    if (!gameTeamIds.has(goal.concedingTeamId)) {
      throw new GoalCorrectionError(
        "invalid_conceding_team",
        400,
        "concedingTeamId must be an active team for this game.",
      );
    }

    if (!goal.ownGoal && (!goal.scoringTeamId || !gameTeamIds.has(goal.scoringTeamId))) {
      throw new GoalCorrectionError(
        "invalid_scoring_team",
        400,
        "scoringTeamId must be an active team for this game.",
      );
    }

    if (goal.ownGoal && goal.scoringTeamId !== null) {
      throw new GoalCorrectionError(
        "own_goal_scoring_team",
        400,
        "ownGoal=true requires scoringTeamId to be null.",
      );
    }

    if (!goal.ownGoal && goal.scoringTeamId === goal.concedingTeamId) {
      throw new GoalCorrectionError(
        "same_team_goal",
        400,
        "scoringTeamId and concedingTeamId must be different for a standard goal.",
      );
    }

    const rosterByPlayerId = new Map(
      [...rosterAssignments.values()]
        .filter((assignment) => assignment.gameId === goal.gameId)
        .map((assignment) => [assignment.playerId, assignment]),
    );
    const scorerRoster = rosterByPlayerId.get(goal.scorerPlayerId);
    if (!scorerRoster) {
      throw new GoalCorrectionError("scorer_not_rostered", 400, "Scorer must be rostered in this game.");
    }

    if (!goal.ownGoal && scorerRoster.teamId !== goal.scoringTeamId) {
      throw new GoalCorrectionError(
        "scorer_not_on_scoring_team",
        400,
        "Scorer must be rostered on the scoring team for a standard goal.",
      );
    }

    if (goal.ownGoal && scorerRoster.teamId !== goal.concedingTeamId) {
      throw new GoalCorrectionError(
        "scorer_not_on_conceding_team",
        400,
        "Own-goal scorer must be rostered on the conceding team.",
      );
    }

    for (const assistPlayerId of goal.assistPlayerIds) {
      if (!rosterByPlayerId.has(assistPlayerId)) {
        throw new GoalCorrectionError(
          "assist_not_rostered",
          400,
          "Assist players must be rostered in this game.",
        );
      }
    }
  }

  function recomputeMockGameTeams(gameId: string): MockGameTeamRecord[] {
    const counts = new Map<TeamId, { scored: number; conceded: number }>();
    for (const team of sortedGameTeams(gameId)) {
      counts.set(team.teamId, { scored: 0, conceded: 0 });
    }

    for (const goal of sortedGoalTimeline(gameId)) {
      if (!goal.ownGoal && goal.scoringTeamId) {
        const scoringCounts = counts.get(goal.scoringTeamId);
        if (scoringCounts) {
          scoringCounts.scored += 1;
        }
      }

      const concedingCounts = counts.get(goal.concedingTeamId);
      if (concedingCounts) {
        concedingCounts.conceded += 1;
      }
    }

    for (const [key, team] of gameTeams.entries()) {
      if (team.gameId !== gameId) {
        continue;
      }

      const teamCounts = counts.get(team.teamId) ?? { scored: 0, conceded: 0 };
      gameTeams.set(key, {
        ...team,
        scored: teamCounts.scored,
        conceded: teamCounts.conceded,
        updatedAt: "2026-02-23T00:00:04.000Z",
      });
    }

    const game = games.get(gameId);
    if (game?.status === "finished") {
      games.set(gameId, {
        ...game,
        finishedAt: game.finishedAt ?? "2026-02-23T00:00:04.000Z",
        result: buildMockGameResult(gameId, "2026-02-23T00:00:04.000Z"),
        updatedAt: "2026-02-23T00:00:04.000Z",
      });
    }

    return sortedGameTeams(gameId);
  }

  function createMockGoalAudit(input: {
    gameId: string;
    eventId: string;
    actorUserId: string;
    action: "goal_created" | "goal_updated" | "goal_deleted" | "goal_undo_last";
    before: MockGoalEventRecord | null;
    after: MockGoalEventRecord | null;
  }) {
    const audit = {
      auditId: `audit-${goalAuditEntries.length + 1}`,
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: input.action,
      before: input.before,
      after: input.after,
      createdAt: "2026-02-23T00:00:04.000Z",
      updatedAt: "2026-02-23T00:00:04.000Z",
    };
    goalAuditEntries.push(audit);
    return audit;
  }

  const handler = createLambdaCoreHandler({
    sessionCookieName: "threefc_session",
    sessionCookieSecure: false,
    corsAllowedOrigins: ["https://qa.3fc.football"],
    magicLinkService: {
      async getSession(sessionId: string) {
        return config.sessions?.[sessionId] ?? null;
      },
      async start(email: string) {
        magicLinkStarts.push(email);
        return {
          email,
          expiresAt: "2026-02-24T00:00:00.000Z",
          messageId: "msg-1",
        };
      },
      async complete(token: string) {
        magicLinkCompletes.push(token);
        return {
          sessionId: "new-session-1",
          email: "admin@example.com",
          createdAt: "2026-02-23T00:00:00.000Z",
          expiresAt: "2026-02-24T00:00:00.000Z",
          maxAgeSeconds: 86400,
        };
      },
    },
    magicLinkRateLimiter: {
      async consumeMagicLinkStart(input) {
        magicLinkRateLimitChecks.push(input);
        if (typeof config.rateLimitDecision === "function") {
          return config.rateLimitDecision(input);
        }

        return config.rateLimitDecision ?? { allowed: true };
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
      async createTeam(input) {
        createdSeasonTeams.push(input);
        const existing = seasonTeams.get(`${input.seasonId}:${input.teamId}`);
        const record = {
          seasonId: input.seasonId,
          teamId: input.teamId,
          name: input.name,
          color: input.color ?? null,
          createdAt: existing?.createdAt ?? "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        seasonTeams.set(`${input.seasonId}:${input.teamId}`, record);
        return record;
      },
      async listTeamsForSeason(seasonId: string, options: { consistentRead?: boolean } = {}) {
        listTeamsForSeasonCalls.push({ seasonId, consistentRead: options.consistentRead ?? false });
        return [...seasonTeams.values()].filter((team) => team.seasonId === seasonId);
      },
      async createGameTeamOverride(input) {
        if (createGameTeamOverrideFinishesIncompleteOnce) {
          createGameTeamOverrideFinishesIncompleteOnce = false;
          const existingGame = games.get(input.gameId);
          if (existingGame) {
            games.set(input.gameId, {
              ...existingGame,
              status: "finished",
              finishedAt: null,
              result: null,
              updatedAt: "2026-02-23T00:00:05.000Z",
            });
          }
          throw new GameMutationStateError(
            "game_finished",
            `Game ${input.gameId} is finished. Admin role is required to mutate finished games.`,
          );
        }

        if (createGameTeamOverrideStateChangedOnce) {
          createGameTeamOverrideStateChangedOnce = false;
          const existingGame = games.get(input.gameId);
          if (existingGame) {
            games.set(input.gameId, {
              ...existingGame,
              status: "finished",
              finishedAt: "2026-02-23T00:00:05.000Z",
              result: buildMockGameResult(input.gameId, "2026-02-23T00:00:05.000Z"),
              updatedAt: "2026-02-23T00:00:05.000Z",
            });
          }
          throw new GameMutationStateError(
            "game_state_changed",
            `Game ${input.gameId} changed before the team override could be saved. Reload and try again.`,
          );
        }

        createdGameTeams.push(input);
        const existing = gameTeams.get(`${input.gameId}:${input.teamId}`);
        const record = {
          gameId: input.gameId,
          teamId: input.teamId,
          name: input.name,
          color: input.color ?? null,
          scored: existing?.scored ?? 0,
          conceded: existing?.conceded ?? 0,
          createdAt: existing?.createdAt ?? "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        gameTeams.set(`${input.gameId}:${input.teamId}`, record);
        return record;
      },
      async listTeamsForGame(gameId: string, options: { consistentRead?: boolean } = {}) {
        listTeamsForGameCalls.push({ gameId, consistentRead: options.consistentRead ?? false });
        return [...gameTeams.values()].filter((team) => team.gameId === gameId);
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
        if (games.has(input.gameId)) {
          throw new GameAlreadyExistsError(input.gameId);
        }
        const joinCode = input.joinCode ?? buildJoinCodeForGameId(input.gameId);
        if (
          [...games.values()].some(
            (game) => game.joinCode.trim().toUpperCase() === joinCode.trim().toUpperCase(),
          )
        ) {
          throw new GameJoinCodeCollisionError();
        }

        createdGames.push(input);
        const record = {
          gameId: input.gameId,
          joinCode,
          ...(input.createRequestHash ? { createRequestHash: input.createRequestHash } : {}),
          leagueId: input.leagueId,
          seasonId: input.seasonId,
          sessionId: input.sessionId,
          status: input.status ?? "scheduled",
          gameStartTs: input.gameStartTs,
          thirdLengthMinutes: input.thirdLengthMinutes ?? DEFAULT_THIRD_LENGTH_MINUTES,
          thirds: createDefaultThirdTimerSegments(),
          finishedAt: null,
          result: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        games.set(input.gameId, record);
        return record;
      },
      async createSessionGame(input) {
        if (createSessionGameFailures > 0) {
          createSessionGameFailures -= 1;
          throw new Error("Session game index write failed.");
        }

        createdSessionGames.push(input);
        return input;
      },
      async listGamesForSeason(seasonId: string) {
        return [...games.values()].filter((game) => game.seasonId === seasonId);
      },
      async getGame(
        gameId: string,
        options: { consistentRead?: boolean; repairLegacyJoinCode?: boolean } = {},
      ) {
        getGameCalls.push({
          gameId,
          consistentRead: options.consistentRead ?? false,
          repairLegacyJoinCode: options.repairLegacyJoinCode ?? false,
        });
        const game = games.get(gameId) ?? null;
        if (
          game &&
          options.consistentRead &&
          completeFinishedRepairAfterConsistentReads > 0 &&
          game.status === "finished" &&
          (!game.finishedAt || !game.result)
        ) {
          completeFinishedRepairAfterConsistentReads -= 1;
          if (completeFinishedRepairAfterConsistentReads === 0) {
            const finishedAt = "2026-02-23T00:00:05.000Z";
            games.set(gameId, {
              ...game,
              finishedAt,
              result: buildMockGameResult(gameId, finishedAt),
              updatedAt: finishedAt,
            });
          }
        }

        const repairedJoinCode = config.legacyJoinCodeRepairs?.[gameId];
        if (game && options.repairLegacyJoinCode && repairedJoinCode) {
          const repairedGame = {
            ...game,
            joinCode: repairedJoinCode,
            updatedAt: "2026-02-23T00:00:05.000Z",
          };
          games.set(gameId, repairedGame);
          return repairedGame;
        }

        return game;
      },
      async getGameByJoinCode(joinCode: string) {
        const normalizedJoinCode = joinCode.trim().toUpperCase();
        return (
          [...games.values()].find(
            (game) => game.joinCode.trim().toUpperCase() === normalizedJoinCode,
          ) ?? null
        );
      },
      async joinGameByCode(input) {
        const normalizedJoinCode = input.joinCode.trim().toUpperCase();
        const game =
          [...games.values()].find(
            (candidate) => candidate.joinCode.trim().toUpperCase() === normalizedJoinCode,
          ) ?? null;
        if (!game) {
          return null;
        }

        if (game.status === "finished") {
          throw new GameJoinRegistrationError(
            "game_finished",
            409,
            `Game ${game.gameId} is finished. Join registration is closed.`,
          );
        }

        if (joinGameByCodeStateChangedOnce) {
          joinGameByCodeStateChangedOnce = false;
          throw new GameJoinRegistrationError(
            "join_state_changed",
            409,
            "Game join state changed while registering this player. Reload and try again.",
          );
        }

        const player = {
          playerId: input.playerId,
          nickname: input.nickname,
          claimedByUserId: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        const link = {
          gameId: game.gameId,
          playerId: input.playerId,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        createdPlayers.push({
          playerId: input.playerId,
          nickname: input.nickname,
          claimedByUserId: null,
        });
        linkedGamePlayers.push({
          gameId: game.gameId,
          playerId: input.playerId,
        });
        players.set(input.playerId, player);
        gamePlayers.set(`${game.gameId}:${input.playerId}`, link);

        return {
          game,
          player,
        };
      },
      async updateGame(input) {
        const existing = games.get(input.gameId);
        if (!existing) {
          return null;
        }

        if (input.status === "finished" && existing.status !== "finished") {
          throw new GameTimerTransitionError(
            "use_finish_endpoint",
            "Use POST /v1/games/{gameId}/finish to finish a game.",
          );
        }

        if (
          existing.status === "finished" &&
          input.status !== undefined &&
          input.status !== "finished"
        ) {
          throw new GameTimerTransitionError(
            "game_finished",
            "Finished games cannot be moved back to scheduled or live.",
          );
        }

        if (
          input.thirdLengthMinutes !== undefined &&
          input.thirdLengthMinutes !== existing.thirdLengthMinutes &&
          existing.status === "finished"
        ) {
          throw new GameTimerTransitionError(
            "game_finished",
            "Third length cannot be changed after the game is finished.",
          );
        }

        if (
          input.thirdLengthMinutes !== undefined &&
          input.thirdLengthMinutes !== existing.thirdLengthMinutes &&
          existing.thirds.some((third) => third.startedAt !== null)
        ) {
          throw new GameTimerTransitionError(
            "third_length_locked",
            "Third length cannot be changed after a third has started.",
          );
        }

        if (input.status === "scheduled" && existing.thirds.some((third) => third.startedAt !== null)) {
          throw new GameTimerTransitionError(
            "timer_status_locked",
            "Game status cannot be set back to scheduled after a third has started.",
          );
        }

        const updated = {
          ...existing,
          status: input.status ?? existing.status,
          gameStartTs: input.gameStartTs ?? existing.gameStartTs,
          thirdLengthMinutes: input.thirdLengthMinutes ?? existing.thirdLengthMinutes,
          updatedAt: "2026-02-23T00:00:01.000Z",
        };
        games.set(input.gameId, updated);
        return updated;
      },
      async startGameThird(input) {
        const existing = games.get(input.gameId);
        if (!existing) {
          return null;
        }

        if (existing.status === "finished") {
          throw new GameTimerTransitionError("game_finished", "Cannot start a third after the game is finished.");
        }

        const thirds = existing.thirds.map((third) => ({ ...third }));
        const target = thirds.find((third) => third.third === input.third);
        if (!target) {
          throw new GameTimerTransitionError("invalid_third", "Third must be 1, 2, or 3.");
        }
        if (target.startedAt) {
          throw new GameTimerTransitionError("third_already_started", `Third ${input.third} has already been started.`);
        }
        const runningThird = thirds.find((third) => third.startedAt && !third.finishedAt);
        if (runningThird) {
          throw new GameTimerTransitionError(
            "third_already_running",
            `Third ${runningThird.third} must be finished before another third can start.`,
          );
        }
        const unfinishedPreviousThird = thirds
          .filter((third) => third.third < input.third)
          .find((third) => !third.finishedAt);
        if (unfinishedPreviousThird) {
          throw new GameTimerTransitionError(
            "previous_third_unfinished",
            `Third ${unfinishedPreviousThird.third} must be finished before third ${input.third} can start.`,
          );
        }

        target.startedAt = "2026-02-23T00:00:01.000Z";
        const updated = {
          ...existing,
          status: "live" as const,
          thirds,
          updatedAt: "2026-02-23T00:00:01.000Z",
        };
        games.set(input.gameId, updated);
        return updated;
      },
      async finishGameThird(input) {
        const existing = games.get(input.gameId);
        if (!existing) {
          return null;
        }

        if (existing.status === "finished") {
          throw new GameTimerTransitionError("game_finished", "Cannot finish a third after the game is finished.");
        }

        const thirds = existing.thirds.map((third) => ({ ...third }));
        const target = thirds.find((third) => third.third === input.third);
        if (!target) {
          throw new GameTimerTransitionError("invalid_third", "Third must be 1, 2, or 3.");
        }
        if (!target.startedAt) {
          throw new GameTimerTransitionError(
            "third_not_started",
            `Third ${input.third} cannot be finished before it is started.`,
          );
        }
        if (target.finishedAt) {
          throw new GameTimerTransitionError(
            "third_already_finished",
            `Third ${input.third} has already been finished.`,
          );
        }

        target.finishedAt = "2026-02-23T00:00:02.000Z";
        const updated = {
          ...existing,
          status: existing.status === "scheduled" ? ("live" as const) : existing.status,
          thirds,
          updatedAt: "2026-02-23T00:00:02.000Z",
        };
        games.set(input.gameId, updated);
        return updated;
      },
      async finishGame(input) {
        const existing = games.get(input.gameId);
        if (!existing) {
          return null;
        }

        if (
          existing.status === "finished" &&
          existing.finishedAt &&
          isCompleteMockGameResult(existing.result)
        ) {
          return existing;
        }

        const runningThird = existing.thirds.find((third) => third.startedAt && !third.finishedAt);
        if (runningThird) {
          throw new GameTimerTransitionError(
            "third_running",
            `Third ${runningThird.third} must be finished before the game can be finished.`,
          );
        }

        const allThirdsCompleted =
          existing.thirds.length === 3 &&
          existing.thirds.every((third) => third.startedAt && third.finishedAt);
        if (!allThirdsCompleted) {
          throw new GameTimerTransitionError(
            "thirds_incomplete",
            "All three thirds must be started and finished before the game can be finished.",
          );
        }

        const finishedAt = "2026-02-23T00:00:05.000Z";
        if (finishGameStateChangedWithIncompleteFinishOnce) {
          finishGameStateChangedWithIncompleteFinishOnce = false;
          games.set(input.gameId, {
            ...existing,
            status: "finished" as const,
            finishedAt: null,
            result: null,
            updatedAt: finishedAt,
          });
          throw new GameTimerTransitionError(
            "game_state_changed",
            "Game or scoreboard state changed while finishing this game. Reload and try again.",
          );
        }

        if (finishGameStateChangedWithoutFinishOnce) {
          finishGameStateChangedWithoutFinishOnce = false;
          throw new GameTimerTransitionError(
            "game_state_changed",
            "Game or scoreboard state changed while finishing this game. Reload and try again.",
          );
        }

        if (finishGameStateChangedOnce) {
          finishGameStateChangedOnce = false;
          games.set(input.gameId, {
            ...existing,
            status: "finished" as const,
            finishedAt,
            result: buildMockGameResult(input.gameId, finishedAt),
            updatedAt: finishedAt,
          });
          throw new GameTimerTransitionError(
            "game_state_changed",
            "Game or scoreboard state changed while finishing this game. Reload and try again.",
          );
        }

        const updated = {
          ...existing,
          status: "finished" as const,
          finishedAt,
          result: buildMockGameResult(input.gameId, finishedAt),
          updatedAt: finishedAt,
        };
        games.set(input.gameId, updated);
        return updated;
      },
      async deleteGame(gameId: string) {
        if (deleteGameFinishesBeforeDeleteOnce) {
          deleteGameFinishesBeforeDeleteOnce = false;
          const existing = games.get(gameId);
          if (existing) {
            games.set(gameId, {
              ...existing,
              status: "finished",
              finishedAt: "2026-02-23T00:00:05.000Z",
              result: buildMockGameResult(gameId, "2026-02-23T00:00:05.000Z"),
              updatedAt: "2026-02-23T00:00:05.000Z",
            });
          }
          return false;
        }

        deletedGames.push(gameId);
        return games.delete(gameId);
      },
      async deleteSeason(seasonId: string) {
        return seasons.delete(seasonId);
      },
      async deleteLeague(leagueId: string) {
        return leagues.delete(leagueId);
      },
      async createPlayer(input) {
        createdPlayers.push(input);
        const record = {
          playerId: input.playerId,
          nickname: input.nickname,
          claimedByUserId: input.claimedByUserId ?? null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        players.set(input.playerId, record);
        return record;
      },
      async createAndLinkGamePlayer(input) {
        if (createAndLinkGamePlayerStateChangedOnce) {
          createAndLinkGamePlayerStateChangedOnce = false;
          const existingGame = games.get(input.gameId);
          if (existingGame) {
            games.set(input.gameId, {
              ...existingGame,
              status: "finished",
              finishedAt: "2026-02-23T00:00:05.000Z",
              result: buildMockGameResult(input.gameId, "2026-02-23T00:00:05.000Z"),
              updatedAt: "2026-02-23T00:00:05.000Z",
            });
          }
          throw new GameMutationStateError(
            "game_state_changed",
            `Game ${input.gameId} changed before the player could be saved. Reload and try again.`,
          );
        }

        createdPlayers.push(input);
        const record = {
          playerId: input.playerId,
          nickname: input.nickname,
          claimedByUserId: input.claimedByUserId ?? null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        players.set(input.playerId, record);
        linkedGamePlayers.push({
          gameId: input.gameId,
          playerId: input.playerId,
        });
        const existing = gamePlayers.get(`${input.gameId}:${input.playerId}`);
        gamePlayers.set(`${input.gameId}:${input.playerId}`, {
          gameId: input.gameId,
          playerId: input.playerId,
          createdAt: existing?.createdAt ?? "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        });
        return record;
      },
      async getPlayer(playerId: string) {
        return players.get(playerId) ?? null;
      },
      async listPlayers(input = {}) {
        const search = input.search?.toLowerCase() ?? "";
        return [...players.values()]
          .filter((player) => search.length === 0 || player.nickname.toLowerCase().includes(search))
          .slice(0, input.limit ?? 20);
      },
      async linkGamePlayer(input) {
        linkedGamePlayers.push(input);
        const existing = gamePlayers.get(`${input.gameId}:${input.playerId}`);
        const record = {
          gameId: input.gameId,
          playerId: input.playerId,
          createdAt: existing?.createdAt ?? "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        gamePlayers.set(`${input.gameId}:${input.playerId}`, record);
        return record;
      },
      async listGamePlayers(gameId: string) {
        return [...gamePlayers.values()].filter((player) => player.gameId === gameId);
      },
      async assignRosterPlayer(input) {
        if (assignRosterPlayerStateChangedOnce) {
          assignRosterPlayerStateChangedOnce = false;
          const existing = games.get(input.gameId);
          if (existing) {
            games.set(input.gameId, {
              ...existing,
              status: "finished",
              finishedAt: "2026-02-23T00:00:05.000Z",
              result: buildMockGameResult(input.gameId, "2026-02-23T00:00:05.000Z"),
              updatedAt: "2026-02-23T00:00:05.000Z",
            });
          }
          throw new GameMutationStateError(
            "game_state_changed",
            `Game ${input.gameId} changed before the roster assignment could be saved. Reload and try again.`,
          );
        }

        assignedRosterPlayers.push(input);
        for (const [key, assignment] of rosterAssignments.entries()) {
          if (assignment.gameId === input.gameId && assignment.playerId === input.playerId) {
            rosterAssignments.delete(key);
          }
        }

        linkedGamePlayers.push({
          gameId: input.gameId,
          playerId: input.playerId,
        });
        const existingGamePlayer = gamePlayers.get(`${input.gameId}:${input.playerId}`);
        gamePlayers.set(`${input.gameId}:${input.playerId}`, {
          gameId: input.gameId,
          playerId: input.playerId,
          createdAt: existingGamePlayer?.createdAt ?? "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        });
        const record = {
          gameId: input.gameId,
          teamId: input.teamId,
          playerId: input.playerId,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        };
        rosterAssignments.set(`${input.gameId}:${input.playerId}`, record);
        return record;
      },
      async listGameRoster(gameId: string) {
        return [...rosterAssignments.values()].filter((assignment) => assignment.gameId === gameId);
      },
      async createGoal(input) {
        createdGoals.push(input);
        const game = games.get(input.gameId);
        if (!game) {
          return null;
        }

        const allowFinished = game.status === "finished" && input.allowFinished === true;
        if (game.status === "finished" && !allowFinished) {
          throw new GoalCreationError(
            "game_finished",
            409,
            "Cannot create a goal after the game is finished.",
          );
        }

        const activeThird = game.thirds.find((third) => third.startedAt && !third.finishedAt);
        const sortedThirds = [...game.thirds].sort((left, right) => left.third - right.third);
        const finishedCorrectionThird = allowFinished
          ? sortedThirds.filter((third) => third.finishedAt).at(-1) ?? sortedThirds.at(-1)
          : null;
        const goalThird = activeThird ?? finishedCorrectionThird;
        if (!goalThird || (!activeThird?.startedAt && !allowFinished)) {
          throw new GoalCreationError(
            "no_active_third",
            409,
            allowFinished
              ? "A finished-game correction needs at least one configured third."
              : "A goal can only be created while a third is running.",
          );
        }

        const now = `2026-02-23T00:00:${String(3 + goalEvents.size).padStart(2, "0")}.000Z`;
        const startedAtMs = activeThird?.startedAt ? Date.parse(activeThird.startedAt) : NaN;
        const nowMs = Date.parse(now);
        const elapsedSeconds = allowFinished
          ? game.thirdLengthMinutes * 60
          : Number.isFinite(startedAtMs) && Number.isFinite(nowMs)
            ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
            : 0;
        const display = formatThirdDisplayTime(elapsedSeconds, game.thirdLengthMinutes);
        const thirdMinute = allowFinished
          ? game.thirdLengthMinutes
          : Math.min(game.thirdLengthMinutes, Math.floor(display.elapsedSeconds / 60) + 1);
        const gameMinute = (goalThird.third - 1) * game.thirdLengthMinutes + thirdMinute;
        const goal = {
          gameId: input.gameId,
          eventId: input.eventId,
          third: goalThird.third,
          thirdMinute,
          gameMinute,
          elapsedSeconds: display.elapsedSeconds,
          stoppageMinute: display.stoppageMinute,
          displayTime: display.displayTime,
          scoringTeamId: input.scoringTeamId,
          concedingTeamId: input.concedingTeamId,
          scorerPlayerId: input.scorerPlayerId,
          assistPlayerIds: input.assistPlayerIds,
          ownGoal: input.ownGoal,
          createdAt: now,
          updatedAt: now,
        };

        goalEvents.set(`${input.gameId}:${input.eventId}`, goal);
        const teams = recomputeMockGameTeams(input.gameId);
        const timeline = sortedGoalTimeline(input.gameId);
        createMockGoalAudit({
          gameId: input.gameId,
          eventId: input.eventId,
          actorUserId: input.actorUserId,
          action: "goal_created",
          before: null,
          after: goal,
        });

        return {
          goal,
          scoreboard: {
            teams,
          },
          timeline,
        };
      },
      async listGoalEvents(gameId: string) {
        return sortedGoalTimeline(gameId);
      },
      async updateGoal(input) {
        updatedGoals.push({
          gameId: input.gameId,
          eventId: input.eventId,
          allowFinished: input.allowFinished,
        });
        finishGameBeforeGoalCorrection(input.gameId);
        rejectFinishedGoalCorrectionUnlessAllowed(input);
        const existing = goalEvents.get(`${input.gameId}:${input.eventId}`);
        if (!games.has(input.gameId) || !existing) {
          return null;
        }

        const updated = {
          ...existing,
          scoringTeamId:
            input.scoringTeamId === undefined ? existing.scoringTeamId : input.scoringTeamId,
          concedingTeamId: input.concedingTeamId ?? existing.concedingTeamId,
          scorerPlayerId: input.scorerPlayerId ?? existing.scorerPlayerId,
          assistPlayerIds: input.assistPlayerIds ?? existing.assistPlayerIds,
          ownGoal: input.ownGoal ?? existing.ownGoal,
          updatedAt: "2026-02-23T00:00:04.000Z",
        };
        validateMockGoal(updated);
        goalEvents.set(`${input.gameId}:${input.eventId}`, updated);
        const teams = recomputeMockGameTeams(input.gameId);
        const timeline = sortedGoalTimeline(input.gameId);
        const audit = createMockGoalAudit({
          gameId: input.gameId,
          eventId: input.eventId,
          actorUserId: input.actorUserId,
          action: "goal_updated",
          before: existing,
          after: updated,
        });

        return {
          goal: updated,
          previousGoal: existing,
          scoreboard: {
            teams,
          },
          timeline,
          audit,
        };
      },
      async deleteGoal(input) {
        deletedGoals.push({
          gameId: input.gameId,
          eventId: input.eventId,
          allowFinished: input.allowFinished,
        });
        finishGameBeforeGoalCorrection(input.gameId);
        rejectFinishedGoalCorrectionUnlessAllowed(input);
        const existing = goalEvents.get(`${input.gameId}:${input.eventId}`);
        if (!games.has(input.gameId) || !existing) {
          return null;
        }

        goalEvents.delete(`${input.gameId}:${input.eventId}`);
        const teams = recomputeMockGameTeams(input.gameId);
        const timeline = sortedGoalTimeline(input.gameId);
        const audit = createMockGoalAudit({
          gameId: input.gameId,
          eventId: input.eventId,
          actorUserId: input.actorUserId,
          action: "goal_deleted",
          before: existing,
          after: null,
        });

        return {
          deletedGoal: existing,
          scoreboard: {
            teams,
          },
          timeline,
          audit,
        };
      },
      async undoLastGoal(input) {
        undoneGoals.push({
          gameId: input.gameId,
          expectedEventId: input.expectedEventId,
          allowFinished: input.allowFinished,
        });
        finishGameBeforeGoalCorrection(input.gameId);
        rejectFinishedGoalCorrectionUnlessAllowed(input);
        const latest = latestGoal(input.gameId);
        if (!games.has(input.gameId) || !latest) {
          return null;
        }

        if (latest.eventId !== input.expectedEventId) {
          throw new GoalCorrectionError(
            "latest_goal_changed",
            409,
            "Latest goal changed before undo could be applied. Reload the game and try again.",
          );
        }

        goalEvents.delete(`${input.gameId}:${latest.eventId}`);
        const teams = recomputeMockGameTeams(input.gameId);
        const timeline = sortedGoalTimeline(input.gameId);
        const audit = createMockGoalAudit({
          gameId: input.gameId,
          eventId: latest.eventId,
          actorUserId: input.actorUserId,
          action: "goal_undo_last",
          before: latest,
          after: null,
        });

        return {
          deletedGoal: latest,
          scoreboard: {
            teams,
          },
          timeline,
          audit,
        };
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
        const recordKey = `${scope}:${key}`;
        const readCount = (idempotencyRecordReads.get(recordKey) ?? 0) + 1;
        idempotencyRecordReads.set(recordKey, readCount);
        config.beforeIdempotencyRecordRead?.({
          scope,
          key,
          readCount,
          records: idempotencyRecords,
        });
        return idempotencyRecords.get(recordKey) ?? null;
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
    createdSeasonTeams,
    createdGameTeams,
    createdPlayers,
    createdGoals,
    updatedGoals,
    deletedGoals,
    undoneGoals,
    deletedGames,
    assignedRosterPlayers,
    linkedGamePlayers,
    magicLinkStarts,
    magicLinkCompletes,
    magicLinkRateLimitChecks,
    getGameCalls,
    listTeamsForSeasonCalls,
    listTeamsForGameCalls,
    idempotencyRecords,
    goalAuditEntries,
    games,
  };
}

function createGoalHarness(input: {
  email?: string;
  role?: "admin" | "scorekeeper" | "viewer";
  runningThird?: boolean;
  completedThirds?: boolean;
  finishGameStateChangedOnce?: boolean;
  finishGameStateChangedWithIncompleteFinishOnce?: boolean;
  finishGameStateChangedWithoutFinishOnce?: boolean;
  deleteGameFinishesBeforeDeleteOnce?: boolean;
  createGameTeamOverrideStateChangedOnce?: boolean;
  createGameTeamOverrideFinishesIncompleteOnce?: boolean;
  completeFinishedRepairAfterConsistentReads?: number;
  createAndLinkGamePlayerStateChangedOnce?: boolean;
  assignRosterPlayerStateChangedOnce?: boolean;
  finishBeforeGoalCorrectionOnce?: boolean;
  gameTeams?: Record<string, MockGameTeamInput>;
} = {}) {
  const email = input.email ?? "scorekeeper@example.com";
  const role = input.role ?? "scorekeeper";
  const runningThird = input.runningThird ?? true;
  const completedThirds = input.completedThirds ?? false;
  const thirds = completedThirds ? completedThirdTimerSegments() : createDefaultThirdTimerSegments();
  if (runningThird && !completedThirds) {
    thirds[0] = {
      ...thirds[0],
      startedAt: "2026-02-23T00:00:00.000Z",
    };
  }

  return createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email,
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: runningThird || completedThirds ? "live" : "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        thirdLengthMinutes: 20,
        thirds,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    finishGameStateChangedOnce: input.finishGameStateChangedOnce,
    finishGameStateChangedWithIncompleteFinishOnce: input.finishGameStateChangedWithIncompleteFinishOnce,
    finishGameStateChangedWithoutFinishOnce: input.finishGameStateChangedWithoutFinishOnce,
    deleteGameFinishesBeforeDeleteOnce: input.deleteGameFinishesBeforeDeleteOnce,
    createGameTeamOverrideStateChangedOnce: input.createGameTeamOverrideStateChangedOnce,
    createGameTeamOverrideFinishesIncompleteOnce: input.createGameTeamOverrideFinishesIncompleteOnce,
    completeFinishedRepairAfterConsistentReads: input.completeFinishedRepairAfterConsistentReads,
    createAndLinkGamePlayerStateChangedOnce: input.createAndLinkGamePlayerStateChangedOnce,
    assignRosterPlayerStateChangedOnce: input.assignRosterPlayerStateChangedOnce,
    finishBeforeGoalCorrectionOnce: input.finishBeforeGoalCorrectionOnce,
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
      [`league-1:${email}`]: {
        leagueId: "league-1",
        userId: email,
        role,
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    gameTeams: input.gameTeams ?? {
      "game-1:red": {
        gameId: "game-1",
        teamId: "red",
        name: "Red",
        color: "#d83b36",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-1:blue": {
        gameId: "game-1",
        teamId: "blue",
        name: "Blue",
        color: "#2364d2",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-1:yellow": {
        gameId: "game-1",
        teamId: "yellow",
        name: "Yellow",
        color: "#e0a612",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    players: {
      "player-red": {
        playerId: "player-red",
        nickname: "Red Player",
        claimedByUserId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "player-blue": {
        playerId: "player-blue",
        nickname: "Blue Player",
        claimedByUserId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "player-yellow": {
        playerId: "player-yellow",
        nickname: "Yellow Player",
        claimedByUserId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    rosterAssignments: {
      "game-1:player-red": {
        gameId: "game-1",
        teamId: "red",
        playerId: "player-red",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-1:player-blue": {
        gameId: "game-1",
        teamId: "blue",
        playerId: "player-blue",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-1:player-yellow": {
        gameId: "game-1",
        teamId: "yellow",
        playerId: "player-yellow",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });
}

async function completeGoalHarnessThirds(
  harness: ReturnType<typeof createGoalHarness>,
  input: { firstThirdAlreadyRunning?: boolean } = {},
): Promise<void> {
  for (const third of [1, 2, 3] as const) {
    if (!(input.firstThirdAlreadyRunning && third === 1)) {
      const startResponse = await harness.handler(
        createEvent({
          method: "POST",
          path: `/v1/games/game-1/thirds/${third}/start`,
          headers: {
            Cookie: "threefc_session=session-1",
          },
        }),
      );
      assert.equal(startResponse.statusCode, 200);
    }

    const finishResponse = await harness.handler(
      createEvent({
        method: "POST",
        path: `/v1/games/game-1/thirds/${third}/finish`,
        headers: {
          Cookie: "threefc_session=session-1",
        },
      }),
    );
    assert.equal(finishResponse.statusCode, 200);
  }
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

test("core lambda starts magic-link auth without requiring a session", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/auth/magic/start",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      sourceIp: "203.0.113.10",
      body: {
        email: "player@example.com",
      },
    }),
  );

  assert.equal(response.statusCode, 202);
  assert.equal(harness.magicLinkStarts.length, 1);
  assert.equal(harness.magicLinkStarts[0], "player@example.com");
  assert.deepEqual(harness.magicLinkRateLimitChecks, [
    {
      email: "player@example.com",
      clientIp: "203.0.113.10",
    },
  ]);
  assert.deepEqual(JSON.parse(response.body), {
    status: "sent",
    email: "player@example.com",
    expiresAt: "2026-02-24T00:00:00.000Z",
    messageId: "msg-1",
  });
});

test("core lambda rejects magic-link start without an allowed origin", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/auth/magic/start",
      body: {
        email: "player@example.com",
      },
    }),
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), {
    error: "forbidden_origin",
    message: "State-changing requests must originate from an allowed app domain.",
  });
  assert.deepEqual(harness.magicLinkRateLimitChecks, []);
  assert.deepEqual(harness.magicLinkStarts, []);
});

test("core lambda does not rate-limit malformed magic-link start requests", async () => {
  const harness = createHarness({
    rateLimitDecision: {
      allowed: false,
      dimension: "email",
      retryAfterSeconds: 900,
    },
  });
  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/auth/magic/start",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      body: {},
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: "Field `email` is required.",
  });
  assert.deepEqual(harness.magicLinkRateLimitChecks, []);
  assert.deepEqual(harness.magicLinkStarts, []);
});

test("core lambda returns rate limit response before starting magic-link auth", async () => {
  const harness = createHarness({
    rateLimitDecision: {
      allowed: false,
      dimension: "email",
      retryAfterSeconds: 900,
    },
  });
  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/auth/magic/start",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      sourceIp: "203.0.113.10",
      body: {
        email: "Player@Example.COM",
      },
    }),
  );

  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "900");
  assert.deepEqual(JSON.parse(response.body), {
    error: "rate_limited",
    message: "Too many sign-in link requests. Try again later.",
    retryAfterSeconds: 900,
  });
  assert.deepEqual(harness.magicLinkRateLimitChecks, [
    {
      email: "player@example.com",
      clientIp: "203.0.113.10",
    },
  ]);
  assert.deepEqual(harness.magicLinkStarts, []);
});

test("core lambda completes magic-link auth and returns a session cookie", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/auth/magic/complete",
      body: {
        token: "tok_abc",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(harness.magicLinkCompletes.length, 1);
  assert.equal(harness.magicLinkCompletes[0], "tok_abc");
  assert.match(response.headers["set-cookie"] ?? "", /^threefc_session=new-session-1;/);

  assert.deepEqual(JSON.parse(response.body), {
    status: "authenticated",
    session: {
      sessionId: "new-session-1",
      email: "admin@example.com",
      createdAt: "2026-02-23T00:00:00.000Z",
      expiresAt: "2026-02-24T00:00:00.000Z",
    },
  });
});

test("core lambda does not repair legacy join codes before game access is authorized", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "outsider@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-legacy": {
        gameId: "game-legacy",
        joinCode: buildJoinCodeForGameId("game-legacy"),
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    legacyJoinCodeRepairs: {
      "game-legacy": "RNDM2345",
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/games/game-legacy",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(harness.getGameCalls, [
    {
      gameId: "game-legacy",
      consistentRead: false,
      repairLegacyJoinCode: false,
    },
  ]);
});

test("core lambda repairs legacy join codes only after game access is authorized", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "viewer@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-legacy": {
        gameId: "game-legacy",
        joinCode: buildJoinCodeForGameId("game-legacy"),
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    legacyJoinCodeRepairs: {
      "game-legacy": "RNDM2345",
    },
    leagueAccess: {
      "league-1:viewer@example.com": {
        leagueId: "league-1",
        userId: "viewer@example.com",
        role: "viewer",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/games/game-legacy",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.equal((JSON.parse(response.body) as { joinCode: string }).joinCode, "RNDM2345");
  assert.deepEqual(harness.getGameCalls, [
    {
      gameId: "game-legacy",
      consistentRead: false,
      repairLegacyJoinCode: false,
    },
    {
      gameId: "game-legacy",
      consistentRead: true,
      repairLegacyJoinCode: true,
    },
  ]);
});

test("core lambda repairs legacy join codes in authorized season game listings", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "viewer@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
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
    games: {
      "game-legacy": {
        gameId: "game-legacy",
        joinCode: buildJoinCodeForGameId("game-legacy"),
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    legacyJoinCodeRepairs: {
      "game-legacy": "RNDM2345",
    },
    leagueAccess: {
      "league-1:viewer@example.com": {
        leagueId: "league-1",
        userId: "viewer@example.com",
        role: "viewer",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/seasons/season-1/games",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as { games: Array<{ gameId: string; joinCode: string }> };
  assert.deepEqual(body.games.map((game) => ({ gameId: game.gameId, joinCode: game.joinCode })), [
    { gameId: "game-legacy", joinCode: "RNDM2345" },
  ]);
  assert.deepEqual(harness.getGameCalls, [
    {
      gameId: "game-legacy",
      consistentRead: true,
      repairLegacyJoinCode: true,
    },
  ]);
});

test("core lambda lets players join an active game by join code and appear in the player pool", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "scorekeeper@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        joinCode: "JNABCD23",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "live",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    leagueAccess: {
      "league-1:scorekeeper@example.com": {
        leagueId: "league-1",
        userId: "scorekeeper@example.com",
        role: "scorekeeper",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const joinResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/jnabcd23",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );

  assert.equal(joinResponse.statusCode, 201);
  assert.equal(harness.createdPlayers.length, 1);
  assert.equal(harness.linkedGamePlayers.length, 1);
  const joinBody = JSON.parse(joinResponse.body) as {
    gameId: string;
    joinCode: string;
    player: { playerId: string; nickname: string; createdAt: string; updatedAt: string };
  };
  assert.equal(joinBody.gameId, "game-1");
  assert.equal(joinBody.joinCode, "JNABCD23");
  assert.equal(joinBody.player.nickname, "Nia");
  assert.match(joinBody.player.playerId, /^player-/);
  assert.deepEqual(harness.linkedGamePlayers[0], {
    gameId: "game-1",
    playerId: joinBody.player.playerId,
  });

  const playerPoolResponse = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/games/game-1/players",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(playerPoolResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(playerPoolResponse.body), {
    players: [joinBody.player],
  });
});

test("core lambda replays public join retries by idempotency key", async () => {
  const harness = createHarness({
    games: {
      "game-1": {
        gameId: "game-1",
        joinCode: "JNABCD23",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "live",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/jnabcd23",
      headers: {
        Origin: "https://qa.3fc.football",
        "Idempotency-Key": "public-join-1",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );
  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body) as {
    gameId: string;
    player: { playerId: string; nickname: string };
  };
  assert.equal(body.gameId, "game-1");
  assert.equal(body.player.nickname, "Nia");
  assert.match(body.player.playerId, /^player-join-/);
  assert.equal(harness.createdPlayers.length, 1);
  assert.equal(harness.linkedGamePlayers.length, 1);

  const replayResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/JNABCD23",
      headers: {
        Origin: "https://qa.3fc.football",
        "Idempotency-Key": "public-join-1",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );
  assert.equal(replayResponse.statusCode, 201);
  assert.deepEqual(JSON.parse(replayResponse.body), body);
  assert.equal(harness.createdPlayers.length, 1);
  assert.equal(harness.linkedGamePlayers.length, 1);

  const conflictResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/JNABCD23",
      headers: {
        Origin: "https://qa.3fc.football",
        "Idempotency-Key": "public-join-1",
      },
      body: {
        nickname: "Mia",
      },
    }),
  );
  assert.equal(conflictResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(conflictResponse.body), {
    error: "idempotency_conflict",
    message: "Idempotency key has already been used with a different payload.",
  });
  assert.equal(harness.createdPlayers.length, 1);
  assert.equal(harness.linkedGamePlayers.length, 1);
});

test("core lambda retries retryable public join conflicts without persisting them", async () => {
  const harness = createHarness({
    joinGameByCodeStateChangedOnce: true,
    games: {
      "game-1": {
        gameId: "game-1",
        joinCode: "JNABCD23",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "live",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const conflictResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/JNABCD23",
      headers: {
        Origin: "https://qa.3fc.football",
        "Idempotency-Key": "public-join-retry-1",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );

  assert.equal(conflictResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(conflictResponse.body), {
    error: "conflict",
    code: "join_state_changed",
    message: "Game join state changed while registering this player. Reload and try again.",
  });
  assert.equal(harness.idempotencyRecords.size, 0);

  const retryResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/JNABCD23",
      headers: {
        Origin: "https://qa.3fc.football",
        "Idempotency-Key": "public-join-retry-1",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );

  assert.equal(retryResponse.statusCode, 201);
  assert.equal(harness.createdPlayers.length, 1);
  assert.equal(harness.linkedGamePlayers.length, 1);
  assert.equal(harness.idempotencyRecords.size, 1);
});

test("core lambda rejects oversized public join nicknames before persistence", async () => {
  const harness = createHarness({
    games: {
      "game-1": {
        gameId: "game-1",
        joinCode: "JNABCD23",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "live",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/JNABCD23",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      body: {
        nickname: "N".repeat(PUBLIC_JOIN_NICKNAME_MAX_LENGTH + 1),
      },
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: `Field \`nickname\` must be ${PUBLIC_JOIN_NICKNAME_MAX_LENGTH} characters or fewer.`,
  });
  assert.equal(harness.createdPlayers.length, 0);
  assert.equal(harness.linkedGamePlayers.length, 0);
});

test("core lambda returns stable errors for invalid and missing join codes", async () => {
  const harness = createHarness();

  const invalidResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/ABCDEFGH",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );

  assert.equal(invalidResponse.statusCode, 404);
  assert.deepEqual(JSON.parse(invalidResponse.body), {
    error: "not_found",
    code: "invalid_join_code",
    message: "Join code was not found.",
  });
  assert.equal(harness.idempotencyRecords.size, 0);

  const invalidResponseWithIdempotencyKey = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/ABCDEFGH",
      headers: {
        Origin: "https://qa.3fc.football",
        "Idempotency-Key": "unknown-public-join-1",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );

  assert.equal(invalidResponseWithIdempotencyKey.statusCode, 404);
  assert.deepEqual(JSON.parse(invalidResponseWithIdempotencyKey.body), {
    error: "not_found",
    code: "invalid_join_code",
    message: "Join code was not found.",
  });
  assert.equal(harness.idempotencyRecords.size, 0);

  const missingResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );

  assert.equal(missingResponse.statusCode, 400);
  assert.deepEqual(JSON.parse(missingResponse.body), {
    error: "bad_request",
    code: "join_code_required",
    message: "Join code is required.",
  });

  const invalidFormatResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/too-long-code",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );

  assert.equal(invalidFormatResponse.statusCode, 400);
  assert.deepEqual(JSON.parse(invalidFormatResponse.body), {
    error: "bad_request",
    code: "join_code_invalid",
    message: "Join code must be 8 uppercase non-ambiguous letters or digits.",
  });

  const malformedResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/%E0%A4%A",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      body: {
        nickname: "Nia",
      },
    }),
  );

  assert.equal(malformedResponse.statusCode, 400);
  assert.deepEqual(JSON.parse(malformedResponse.body), {
    error: "bad_request",
    code: "join_code_invalid",
    message: "Join code must be URL encoded correctly.",
  });
  assert.equal(harness.createdPlayers.length, 0);
  assert.equal(harness.linkedGamePlayers.length, 0);
});

test("core lambda rejects join registration for finished games", async () => {
  const harness = createHarness({
    games: {
      "game-1": {
        gameId: "game-1",
        joinCode: "FNSH2DAB",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "finished",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/join/FNSH2DAB",
      headers: {
        Origin: "https://qa.3fc.football",
      },
      body: {
        nickname: "Late",
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Join registration is closed.",
  });
  assert.equal(harness.createdPlayers.length, 0);
  assert.equal(harness.linkedGamePlayers.length, 0);
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

test("core lambda includes caller league role on league reads", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "scorekeeper@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    leagues: {
      "league-1": {
        leagueId: "league-1",
        name: "League 1",
        slug: null,
        createdByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    leagueAccess: {
      "league-1:scorekeeper@example.com": {
        leagueId: "league-1",
        userId: "scorekeeper@example.com",
        role: "scorekeeper",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/leagues/league-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    leagueId: "league-1",
    name: "League 1",
    slug: null,
    createdByUserId: "admin@example.com",
    createdAt: "2026-02-23T00:00:00.000Z",
    updatedAt: "2026-02-23T00:00:00.000Z",
    access: {
      role: "scorekeeper",
    },
  });
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
  assert.deepEqual(
    harness.createdSeasonTeams.map((team) => team.teamId),
    ["red", "blue", "yellow"],
  );
  assert.deepEqual(
    harness.createdGameTeams.map((team) => team.teamId),
    ["red", "blue", "yellow"],
  );
});

test("core lambda rejects creating games directly as finished", async () => {
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
        gameId: "game-finished",
        gameStartTs: "2026-02-23T10:00:00Z",
        status: "finished",
      },
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.match((JSON.parse(response.body) as { error: string }).error, /status/);
  assert.equal(harness.createdGames.length, 0);
  assert.equal(harness.createdSessionGames.length, 0);
});

test("core lambda recovers idempotent create game retry after the game write commits", async () => {
  const harness = createHarness({
    createSessionGameFailures: 1,
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

  const event = createEvent({
    method: "POST",
    path: "/v1/sessions/session-abc/games",
    headers: {
      Cookie: "threefc_session=session-1",
      "Idempotency-Key": "create-game-recover-1",
    },
    body: {
      gameId: "game-1",
      gameStartTs: "2026-02-23T10:00:00Z",
    },
  });

  const failedResponse = await harness.handler(event);
  assert.equal(failedResponse.statusCode, 500);
  assert.equal(harness.createdGames.length, 1);
  assert.ok(harness.createdGames[0]?.createRequestHash);
  assert.equal(harness.createdSessionGames.length, 0);
  const existingGame = harness.games.get("game-1");
  assert.ok(existingGame);
  harness.games.set("game-1", {
    ...existingGame,
    status: "live",
    gameStartTs: "2026-02-23T11:00:00Z",
    thirdLengthMinutes: 25,
    updatedAt: "2026-02-23T00:01:00.000Z",
  });

  const unrelatedRetryResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/sessions/session-abc/games",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "create-game-recover-1",
      },
      body: {
        gameId: "game-1",
        gameStartTs: "2026-02-23T12:00:00Z",
      },
    }),
  );
  assert.equal(unrelatedRetryResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(unrelatedRetryResponse.body), {
    error: "conflict",
    code: "game_exists",
    message: "Game game-1 already exists.",
  });
  assert.equal(harness.createdSessionGames.length, 0);

  const differentKeyRetryResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/sessions/session-abc/games",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "create-game-recover-2",
      },
      body: {
        gameId: "game-1",
        gameStartTs: "2026-02-23T10:00:00Z",
      },
    }),
  );
  assert.equal(differentKeyRetryResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(differentKeyRetryResponse.body), {
    error: "conflict",
    code: "game_exists",
    message: "Game game-1 already exists.",
  });
  assert.equal(harness.createdSessionGames.length, 0);

  const retryResponse = await harness.handler(event);
  assert.equal(retryResponse.statusCode, 201);
  assert.equal(harness.createdGames.length, 1);
  assert.equal(harness.createdSessionGames.length, 1);
  assert.equal(harness.createdSessionGames[0]?.gameStartTs, "2026-02-23T11:00:00Z");
  assert.deepEqual(
    harness.createdGameTeams.map((team) => team.teamId),
    ["red", "blue", "yellow"],
  );
  assert.equal(harness.idempotencyRecords.size, 1);
  const retryBody = JSON.parse(retryResponse.body) as {
    status: string;
    gameStartTs: string;
    thirdLengthMinutes: number;
  };
  assert.equal(retryBody.status, "live");
  assert.equal(retryBody.gameStartTs, "2026-02-23T11:00:00Z");
  assert.equal(retryBody.thirdLengthMinutes, 25);
  assert.equal("createRequestHash" in retryBody, false);

  const replayResponse = await harness.handler(event);
  assert.equal(replayResponse.statusCode, 201);
  assert.equal(harness.createdSessionGames.length, 1);
});

test("core lambda maps duplicate game IDs to conflict on game creation", async () => {
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
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-abc",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
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
        gameStartTs: "2026-02-23T11:00:00Z",
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_exists",
    message: "Game game-1 already exists.",
  });
  assert.equal(harness.createdGames.length, 0);
  assert.equal(harness.createdSessionGames.length, 0);
});

test("core lambda replays idempotent create game response after a duplicate race", async () => {
  const scope = "admin@example.com:POST:/v1/sessions/session-abc/games";
  const key = "create-game-race-1";
  const requestPayload = {
    gameId: "game-1",
    gameStartTs: "2026-02-23T11:00:00Z",
  };
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
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-abc",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
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
    beforeIdempotencyRecordRead: ({ readCount, records }) => {
      if (readCount !== 2) {
        return;
      }

      records.set(`${scope}:${key}`, {
        scope,
        key,
        requestHash: buildTestIdempotencyRequestHash(scope, requestPayload),
        responseStatusCode: 201,
        responseBody: JSON.stringify({ replayed: true }),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      });
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/sessions/session-abc/games",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": key,
      },
      body: requestPayload,
    }),
  );

  assert.equal(response.statusCode, 201);
  assert.deepEqual(JSON.parse(response.body), { replayed: true });
  assert.equal(harness.createdGames.length, 0);
  assert.equal(harness.createdSessionGames.length, 0);
});

test("core lambda lets scorekeepers quick-create and assign roster players", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "scorekeeper@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
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
      "league-1:scorekeeper@example.com": {
        leagueId: "league-1",
        userId: "scorekeeper@example.com",
        role: "scorekeeper",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const createPlayerResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/players",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "player-create-1",
      },
      body: {
        playerId: "player-ari",
        nickname: "Ari",
      },
    }),
  );

  assert.equal(createPlayerResponse.statusCode, 201);
  assert.equal(harness.createdPlayers.length, 1);
  assert.deepEqual(JSON.parse(createPlayerResponse.body), {
    playerId: "player-ari",
    nickname: "Ari",
    createdAt: "2026-02-23T00:00:00.000Z",
    updatedAt: "2026-02-23T00:00:00.000Z",
  });
  assert.deepEqual(harness.linkedGamePlayers[0], {
    gameId: "game-1",
    playerId: "player-ari",
  });

  const assignResponse = await harness.handler(
    createEvent({
      method: "PUT",
      path: "/v1/games/game-1/roster/player-ari",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        teamId: "red",
      },
    }),
  );

  assert.equal(assignResponse.statusCode, 200);
  assert.equal(harness.assignedRosterPlayers.length, 1);
  assert.equal(harness.assignedRosterPlayers[0].teamId, "red");

  const rosterResponse = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/games/game-1/roster",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(rosterResponse.statusCode, 200);
  const rosterBody = JSON.parse(rosterResponse.body) as {
    teams: Array<{ teamId: string }>;
    roster: Array<{ playerId: string; teamId: string; player: { nickname: string } | null }>;
  };
  assert.deepEqual(rosterBody.teams.map((team) => team.teamId), ["red", "blue", "yellow"]);
  assert.deepEqual(rosterBody.roster, [
    {
      gameId: "game-1",
      teamId: "red",
      playerId: "player-ari",
      createdAt: "2026-02-23T00:00:00.000Z",
      updatedAt: "2026-02-23T00:00:00.000Z",
      player: {
        playerId: "player-ari",
        nickname: "Ari",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  ]);
});

test("core lambda lets scorekeepers start and finish thirds", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "scorekeeper@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        thirdLengthMinutes: 30,
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
      "league-1:scorekeeper@example.com": {
        leagueId: "league-1",
        userId: "scorekeeper@example.com",
        role: "scorekeeper",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const startResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/thirds/1/start",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(startResponse.statusCode, 200);
  const startBody = JSON.parse(startResponse.body) as {
    status: string;
    thirdLengthMinutes: number;
    timer: { status: string; activeThird: number | null; thirdLengthMinutes: number };
    thirds: Array<{ third: number; startedAt: string | null }>;
  };
  assert.equal(startBody.status, "live");
  assert.equal(startBody.thirdLengthMinutes, 30);
  assert.equal(startBody.timer.thirdLengthMinutes, 30);
  assert.equal(startBody.timer.activeThird, 1);
  assert.equal(startBody.timer.status, "running");
  assert.equal(startBody.thirds[0].startedAt, "2026-02-23T00:00:01.000Z");

  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/thirds/1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(finishResponse.statusCode, 200);
  const finishBody = JSON.parse(finishResponse.body) as {
    timer: { status: string; activeThird: number | null; thirds: Array<{ status: string }> };
    thirds: Array<{ finishedAt: string | null }>;
  };
  assert.equal(finishBody.timer.status, "between_thirds");
  assert.equal(finishBody.timer.activeThird, null);
  assert.equal(finishBody.timer.thirds[0].status, "finished");
  assert.equal(finishBody.thirds[0].finishedAt, "2026-02-23T00:00:02.000Z");

  const invalidFinishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/thirds/2/finish",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(invalidFinishResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(invalidFinishResponse.body), {
    error: "conflict",
    code: "third_not_started",
    message: "Third 2 cannot be finished before it is started.",
  });

  for (const invalidThird of ["1abc", "1.9", "01", ""]) {
    const invalidStartResponse = await harness.handler(
      createEvent({
        method: "POST",
        path: `/v1/games/game-1/thirds/${invalidThird}/start`,
        headers: {
          Cookie: "threefc_session=session-1",
        },
      }),
    );

    assert.equal(invalidStartResponse.statusCode, 400);
    assert.deepEqual(JSON.parse(invalidStartResponse.body), {
      error: "Third must be 1, 2, or 3.",
    });
  }
});

test("core lambda rejects viewer third timer mutations through ACL", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "viewer@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
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
      "league-1:viewer@example.com": {
        leagueId: "league-1",
        userId: "viewer@example.com",
        role: "viewer",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/thirds/1/start",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), {
    error: "forbidden",
    code: "scorekeeper_required",
    message: "Admin or scorekeeper role is required for league league-1.",
  });
});

test("core lambda finishes a game with clear winner and idempotency replay", async () => {
  const harness = createGoalHarness();
  const goalPayloads = [
    {
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
      assistPlayerIds: [],
      ownGoal: false,
    },
    {
      scoringTeamId: "yellow",
      concedingTeamId: "blue",
      scorerPlayerId: "player-yellow",
      assistPlayerIds: [],
      ownGoal: false,
    },
    {
      scoringTeamId: "yellow",
      concedingTeamId: "red",
      scorerPlayerId: "player-yellow",
      assistPlayerIds: [],
      ownGoal: false,
    },
  ];

  for (const [index, body] of goalPayloads.entries()) {
    const goalResponse = await harness.handler(
      createEvent({
        method: "POST",
        path: "/v1/games/game-1/goals",
        headers: {
          Cookie: "threefc_session=session-1",
          "Idempotency-Key": `finish-goal-${index + 1}`,
        },
        body,
      }),
    );
    assert.equal(goalResponse.statusCode, 201);
  }

  await completeGoalHarnessThirds(harness, { firstThirdAlreadyRunning: true });

  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-game-1",
      },
    }),
  );
  const replayResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-game-1",
      },
    }),
  );
  const freshKeyReplayResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-game-2",
      },
    }),
  );

  assert.equal(finishResponse.statusCode, 200);
  assert.equal(replayResponse.statusCode, 200);
  assert.equal(freshKeyReplayResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(replayResponse.body), JSON.parse(finishResponse.body));
  assert.deepEqual(JSON.parse(freshKeyReplayResponse.body), JSON.parse(finishResponse.body));
  const body = JSON.parse(finishResponse.body) as {
    status: string;
    finishedAt: string | null;
    result: GameResult;
  };
  assert.equal(body.status, "finished");
  assert.equal(body.finishedAt, "2026-02-23T00:00:05.000Z");
  assert.equal(body.result.winnerTeamId, "yellow");
  assert.deepEqual(
    body.result.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
      rank: team.rank,
      outcome: team.outcome,
    })),
    [
      { teamId: "yellow", scored: 2, conceded: 0, rank: 1, outcome: "win" },
      { teamId: "red", scored: 1, conceded: 1, rank: 2, outcome: "loss" },
      { teamId: "blue", scored: 0, conceded: 2, rank: 3, outcome: "loss" },
    ],
  );
});

test("core lambda replays concurrent same-key finish after game-state race", async () => {
  const harness = createGoalHarness({
    completedThirds: true,
    finishGameStateChangedOnce: true,
  });

  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-race-1",
      },
    }),
  );
  const replayResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-race-1",
      },
    }),
  );

  assert.equal(finishResponse.statusCode, 200);
  assert.equal(replayResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(replayResponse.body), JSON.parse(finishResponse.body));
  const body = JSON.parse(finishResponse.body) as {
    status: string;
    finishedAt: string | null;
    result: GameResult;
  };
  assert.equal(body.status, "finished");
  assert.equal(body.finishedAt, "2026-02-23T00:00:05.000Z");
  assert.ok(body.result);
});

test("core lambda retries finish conflicts before persisting idempotency results", async () => {
  const harness = createGoalHarness({
    completedThirds: true,
    finishGameStateChangedWithoutFinishOnce: true,
  });

  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-retry-conflict-1",
      },
    }),
  );

  assert.equal(finishResponse.statusCode, 200);
  const body = JSON.parse(finishResponse.body) as {
    status: string;
    finishedAt: string | null;
    result: GameResult;
  };
  assert.equal(body.status, "finished");
  assert.equal(body.finishedAt, "2026-02-23T00:00:05.000Z");
  assert.ok(body.result);
  const record = harness.idempotencyRecords.get(
    "scorekeeper@example.com:POST:/v1/games/game-1/finish:finish-retry-conflict-1",
  );
  assert.equal(record?.responseStatusCode, 200);
});

test("core lambda uses a consistent finished read after team setup races", async () => {
  const harness = createGoalHarness({
    completedThirds: true,
    createGameTeamOverrideStateChangedOnce: true,
    gameTeams: {
      "game-1:blue": {
        gameId: "game-1",
        teamId: "blue",
        name: "Blue",
        color: "#2364d2",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-1:yellow": {
        gameId: "game-1",
        teamId: "yellow",
        name: "Yellow",
        color: "#e0a612",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-team-race-1",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as { status: string; finishedAt: string | null };
  assert.equal(body.status, "finished");
  assert.equal(body.finishedAt, "2026-02-23T00:00:05.000Z");
  assert.equal(
    harness.getGameCalls.some((call) => call.gameId === "game-1" && call.consistentRead),
    true,
  );
  assert.equal(
    harness.listTeamsForSeasonCalls.some(
      (call) => call.seasonId === "season-1" && call.consistentRead,
    ),
    true,
  );
  assert.equal(
    harness.createdSeasonTeams.every((team) => team.createOnly === true),
    true,
  );
  assert.equal(
    harness.listTeamsForGameCalls.some((call) => call.gameId === "game-1" && call.consistentRead),
    true,
  );
});

test("core lambda repairs incomplete finished games after team setup races", async () => {
  const harness = createGoalHarness({
    completedThirds: true,
    createGameTeamOverrideFinishesIncompleteOnce: true,
    gameTeams: {
      "game-1:blue": {
        gameId: "game-1",
        teamId: "blue",
        name: "Blue",
        color: "#2364d2",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-1:yellow": {
        gameId: "game-1",
        teamId: "yellow",
        name: "Yellow",
        color: "#e0a612",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-incomplete-repair-1",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    status: string;
    finishedAt: string | null;
    result: GameResult | null;
  };
  assert.equal(body.status, "finished");
  assert.equal(body.finishedAt, "2026-02-23T00:00:05.000Z");
  assert.ok(body.result);
  assert.equal(
    harness.listTeamsForSeasonCalls.some(
      (call) => call.seasonId === "season-1" && call.consistentRead,
    ),
    true,
  );
  assert.equal(
    harness.createdSeasonTeams.every((team) => team.createOnly === true),
    true,
  );
  assert.deepEqual(
    harness.createdGameTeams.map((team) => ({
      teamId: team.teamId,
      allowFinished: team.allowFinished,
      createOnly: team.createOnly,
    })),
    [{ teamId: "red", allowFinished: true, createOnly: true }],
  );
});

test("core lambda recovers finished repair conflicts by rereading completed results", async () => {
  const harness = createGoalHarness({
    completedThirds: true,
    finishGameStateChangedWithIncompleteFinishOnce: true,
    createGameTeamOverrideFinishesIncompleteOnce: true,
    completeFinishedRepairAfterConsistentReads: 2,
    gameTeams: {
      "game-1:blue": {
        gameId: "game-1",
        teamId: "blue",
        name: "Blue",
        color: "#2364d2",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-1:yellow": {
        gameId: "game-1",
        teamId: "yellow",
        name: "Yellow",
        color: "#e0a612",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-incomplete-repair-race-1",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    status: string;
    finishedAt: string | null;
    result: GameResult | null;
  };
  assert.equal(body.status, "finished");
  assert.equal(body.finishedAt, "2026-02-23T00:00:05.000Z");
  assert.ok(body.result);
  assert.equal(
    harness.getGameCalls.filter((call) => call.gameId === "game-1" && call.consistentRead).length >= 3,
    true,
  );
  const record = harness.idempotencyRecords.get(
    "scorekeeper@example.com:POST:/v1/games/game-1/finish:finish-incomplete-repair-race-1",
  );
  assert.equal(record?.responseStatusCode, 200);
});

test("core lambda finishes a game with full draw result", async () => {
  const harness = createGoalHarness({ runningThird: false, completedThirds: true });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-draw-1",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    status: string;
    result: GameResult;
  };
  assert.equal(body.status, "finished");
  assert.equal(body.result.winnerTeamId, null);
  assert.equal(body.result.outcome, "draw");
  assert.deepEqual(
    body.result.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
      rank: team.rank,
      outcome: team.outcome,
    })),
    [
      { teamId: "red", scored: 0, conceded: 0, rank: 1, outcome: "draw" },
      { teamId: "blue", scored: 0, conceded: 0, rank: 1, outcome: "draw" },
      { teamId: "yellow", scored: 0, conceded: 0, rank: 1, outcome: "draw" },
    ],
  );
});

test("core lambda rejects finish before all thirds are completed", async () => {
  const harness = createGoalHarness({ runningThird: false });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-incomplete-1",
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "thirds_incomplete",
    message: "All three thirds must be started and finished before the game can be finished.",
  });
});

test("core lambda persists finish transition conflicts for idempotent replay", async () => {
  const harness = createGoalHarness({ runningThird: false });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-incomplete-replay-1",
      },
    }),
  );
  const replayResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-incomplete-replay-1",
      },
    }),
  );
  const record = harness.idempotencyRecords.get(
    "scorekeeper@example.com:POST:/v1/games/game-1/finish:finish-incomplete-replay-1",
  );

  assert.equal(response.statusCode, 409);
  assert.equal(replayResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(replayResponse.body), JSON.parse(response.body));
  assert.equal(record?.responseStatusCode, 409);
  assert.equal(record?.responseBody, response.body);
});

test("core lambda returns idempotency conflict for reused finish key with mismatched record", async () => {
  const harness = createGoalHarness({ runningThird: false });
  harness.idempotencyRecords.set("scorekeeper@example.com:POST:/v1/games/game-1/finish:finish-conflict", {
    scope: "scorekeeper@example.com:POST:/v1/games/game-1/finish",
    key: "finish-conflict",
    requestHash: "different-hash",
    responseStatusCode: 200,
    responseBody: "{}",
    createdAt: "2026-02-23T00:00:00.000Z",
    updatedAt: "2026-02-23T00:00:00.000Z",
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-conflict",
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "idempotency_conflict",
    message: "Idempotency key has already been used with a different payload.",
  });
});

test("core lambda rejects goal creation after finish", async () => {
  const harness = createGoalHarness({ runningThird: false, completedThirds: true });
  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-before-create-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "post-finish-goal-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Admin role is required to mutate finished games.",
  });
  assert.equal(harness.createdGoals.length, 0);
});

test("core lambda allows admins to create corrective goals after finish", async () => {
  const harness = createGoalHarness({
    email: "admin@example.com",
    role: "admin",
    runningThird: false,
    completedThirds: true,
  });
  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-before-create-correction-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "post-finish-goal-correction-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );

  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.equal(body.goal.third, 3);
  assert.equal(body.goal.thirdMinute, 20);
  assert.equal(body.goal.gameMinute, 60);
  assert.equal(body.goal.displayTime, "20:00");
  assert.equal(harness.createdGoals.length, 1);
  assert.equal(harness.createdGoals[0]?.allowFinished, true);
});

test("core lambda allows admin team corrections after finish", async () => {
  const harness = createGoalHarness({
    email: "admin@example.com",
    role: "admin",
    runningThird: false,
    completedThirds: true,
  });
  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-before-team-override-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const response = await harness.handler(
    createEvent({
      method: "PUT",
      path: "/v1/games/game-1/teams/red",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        name: "Renamed Red",
        color: "#cc0000",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
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
  assert.equal(harness.createdGameTeams.length, 1);
  assert.equal(harness.createdGameTeams[0]?.allowFinished, true);
});

test("core lambda blocks team overrides if finish wins the write race", async () => {
  const harness = createGoalHarness({
    email: "admin@example.com",
    role: "admin",
    createGameTeamOverrideStateChangedOnce: true,
  });

  const response = await harness.handler(
    createEvent({
      method: "PUT",
      path: "/v1/games/game-1/teams/red",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        name: "Renamed Red",
        color: "#cc0000",
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Team overrides are locked after finish.",
  });
  assert.equal(harness.createdGameTeams.length, 0);
});

test("core lambda locks scorekeeper player and roster mutations after finish", async () => {
  const harness = createGoalHarness({
    runningThird: false,
    completedThirds: true,
  });
  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-before-roster-lock-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const playerResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/players",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finished-player-create-1",
      },
      body: {
        playerId: "player-late",
        nickname: "Late",
      },
    }),
  );

  assert.equal(playerResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(playerResponse.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Admin role is required to mutate finished games.",
  });
  assert.equal(harness.createdPlayers.length, 0);

  const rosterResponse = await harness.handler(
    createEvent({
      method: "PUT",
      path: "/v1/games/game-1/roster/player-red",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        teamId: "blue",
      },
    }),
  );

  assert.equal(rosterResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(rosterResponse.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Admin role is required to mutate finished games.",
  });
});

test("core lambda blocks scorekeeper roster assignment if finish wins the write race", async () => {
  const harness = createGoalHarness({
    assignRosterPlayerStateChangedOnce: true,
  });

  const response = await harness.handler(
    createEvent({
      method: "PUT",
      path: "/v1/games/game-1/roster/player-red",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        teamId: "blue",
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Admin role is required to mutate finished games.",
  });
  assert.equal(harness.assignedRosterPlayers.length, 0);
});

test("core lambda blocks scorekeeper quick player creation if finish wins the write race", async () => {
  const harness = createGoalHarness({
    createAndLinkGamePlayerStateChangedOnce: true,
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/players",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "player-create-race-1",
      },
      body: {
        playerId: "player-late",
        nickname: "Late",
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Admin role is required to mutate finished games.",
  });
  assert.equal(harness.createdPlayers.length, 0);
  assert.equal(harness.linkedGamePlayers.length, 0);
});

test("core lambda allows admin player and roster corrections after finish", async () => {
  const harness = createGoalHarness({
    email: "admin@example.com",
    role: "admin",
    runningThird: false,
    completedThirds: true,
  });
  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-before-admin-roster-correction-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const playerResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/players",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finished-admin-player-create-1",
      },
      body: {
        playerId: "player-late",
        nickname: "Late",
      },
    }),
  );

  assert.equal(playerResponse.statusCode, 201);
  assert.equal(harness.createdPlayers.length, 1);
  assert.equal(harness.createdPlayers[0].playerId, "player-late");

  const rosterResponse = await harness.handler(
    createEvent({
      method: "PUT",
      path: "/v1/games/game-1/roster/player-red",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        teamId: "blue",
      },
    }),
  );

  assert.equal(rosterResponse.statusCode, 200);
  assert.equal(harness.assignedRosterPlayers.length, 1);
  assert.deepEqual(harness.assignedRosterPlayers[0], {
    gameId: "game-1",
    teamId: "blue",
    playerId: "player-red",
    allowFinished: true,
  });
});

test("core lambda locks admin game deletion after finish", async () => {
  const harness = createGoalHarness({
    email: "admin@example.com",
    role: "admin",
    runningThird: false,
    completedThirds: true,
  });
  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-before-delete-lock-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const deleteResponse = await harness.handler(
    createEvent({
      method: "DELETE",
      path: "/v1/games/game-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(deleteResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(deleteResponse.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Finished games cannot be deleted.",
  });
  assert.deepEqual(harness.deletedGames, []);
});

test("core lambda blocks admin delete if finish wins the delete race", async () => {
  const harness = createGoalHarness({
    email: "admin@example.com",
    role: "admin",
    deleteGameFinishesBeforeDeleteOnce: true,
  });

  const deleteResponse = await harness.handler(
    createEvent({
      method: "DELETE",
      path: "/v1/games/game-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(deleteResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(deleteResponse.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Finished games cannot be deleted.",
  });
  assert.deepEqual(harness.deletedGames, []);
});

test("core lambda allows admin goal correction after finish and refreshes result", async () => {
  const harness = createGoalHarness({ email: "admin@example.com", role: "admin" });
  const createResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "admin-finish-goal-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );
  assert.equal(createResponse.statusCode, 201);
  const createdBody = JSON.parse(createResponse.body) as { goal: { eventId: string } };

  await completeGoalHarnessThirds(harness, { firstThirdAlreadyRunning: true });

  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "admin-finish-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);
  assert.equal((JSON.parse(finishResponse.body) as { result: GameResult }).result.winnerTeamId, "red");

  const updateResponse = await harness.handler(
    createEvent({
      method: "PATCH",
      path: `/v1/games/game-1/goals/${createdBody.goal.eventId}`,
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "admin-finished-update-1",
      },
      body: {
        scoringTeamId: "blue",
        concedingTeamId: "red",
        scorerPlayerId: "player-blue",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );
  assert.equal(updateResponse.statusCode, 200);
  assert.equal(harness.updatedGoals[0]?.allowFinished, true);

  const gameResponse = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/games/game-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );
  const gameBody = JSON.parse(gameResponse.body) as { result: GameResult };
  assert.equal(gameResponse.statusCode, 200);
  assert.equal(gameBody.result.winnerTeamId, "blue");
});

test("core lambda rejects scorekeeper goal updates if finish wins before repository correction", async () => {
  const harness = createGoalHarness({
    finishBeforeGoalCorrectionOnce: true,
  });
  const createResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "scorekeeper-finish-race-create-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );
  assert.equal(createResponse.statusCode, 201);
  const created = JSON.parse(createResponse.body) as { goal: { eventId: string } };

  const updateResponse = await harness.handler(
    createEvent({
      method: "PATCH",
      path: `/v1/games/game-1/goals/${created.goal.eventId}`,
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "scorekeeper-finish-race-update-1",
      },
      body: {
        scorerPlayerId: "player-blue",
      },
    }),
  );

  assert.equal(updateResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(updateResponse.body), {
    error: "conflict",
    code: "game_finished",
    message: "Game game-1 is finished. Admin role is required to mutate finished games.",
  });
  assert.equal(harness.updatedGoals[0]?.allowFinished, false);
});

test("core lambda creates goals with idempotency replay and conflict behavior", async () => {
  const harness = createGoalHarness();
  const requestBody = {
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: ["player-blue", "player-yellow"],
    ownGoal: false,
  };

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-create-1",
      },
      body: requestBody,
    }),
  );

  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body) as {
    goal: {
      eventId: string;
      third: number;
      thirdMinute: number;
      gameMinute: number;
      elapsedSeconds: number;
      displayTime: string;
      scoringTeamId: string | null;
      concedingTeamId: string;
      assistPlayerIds: string[];
    };
    scoreboard: {
      teams: Array<{ teamId: string; scored: number; conceded: number }>;
    };
    timeline: Array<{ eventId: string }>;
  };
  assert.match(body.goal.eventId, /^goal-idem-/);
  assert.equal(body.goal.third, 1);
  assert.equal(body.goal.thirdMinute, 1);
  assert.equal(body.goal.gameMinute, 1);
  assert.equal(body.goal.elapsedSeconds, 3);
  assert.equal(body.goal.displayTime, "00:03");
  assert.equal(body.goal.scoringTeamId, "red");
  assert.equal(body.goal.concedingTeamId, "blue");
  assert.deepEqual(body.goal.assistPlayerIds, ["player-blue", "player-yellow"]);
  assert.deepEqual(
    body.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 1, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );
  assert.deepEqual(body.timeline.map((goal) => goal.eventId), [body.goal.eventId]);
  assert.equal(harness.createdGoals.length, 1);

  await completeGoalHarnessThirds(harness, { firstThirdAlreadyRunning: true });
  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-create-finish-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const replayResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-create-1",
      },
      body: requestBody,
    }),
  );
  assert.equal(replayResponse.statusCode, 201);
  assert.deepEqual(JSON.parse(replayResponse.body), body);
  assert.equal(harness.createdGoals.length, 1);

  const conflictResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-create-1",
      },
      body: {
        ...requestBody,
        concedingTeamId: "yellow",
      },
    }),
  );

  assert.equal(conflictResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(conflictResponse.body), {
    error: "idempotency_conflict",
    message: "Idempotency key has already been used with a different payload.",
  });
});

test("core lambda lists existing game goals with scoreboard for page reloads", async () => {
  const harness = createGoalHarness();
  const createResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-list-create-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: ["player-yellow"],
        ownGoal: false,
      },
    }),
  );
  assert.equal(createResponse.statusCode, 201);
  const created = JSON.parse(createResponse.body) as {
    goal: { eventId: string };
  };

  const response = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    scoreboard: { teams: Array<{ teamId: string; scored: number; conceded: number }> };
    timeline: Array<{ eventId: string; assistPlayerIds: string[] }>;
  };
  assert.deepEqual(body.timeline.map((goal) => goal.eventId), [created.goal.eventId]);
  assert.deepEqual(body.timeline[0]?.assistPlayerIds, ["player-yellow"]);
  assert.deepEqual(
    body.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 1, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );
});

test("core lambda updates and deletes goals with idempotency replay", async () => {
  const harness = createGoalHarness();
  const createResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-correction-create-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );
  assert.equal(createResponse.statusCode, 201);
  const createdBody = JSON.parse(createResponse.body) as {
    goal: { eventId: string };
  };

  const updateBody = {
    scoringTeamId: "yellow",
    concedingTeamId: "red",
    scorerPlayerId: "player-yellow",
    assistPlayerIds: ["player-blue"],
    ownGoal: false,
  };
  const updateResponse = await harness.handler(
    createEvent({
      method: "PATCH",
      path: `/v1/games/game-1/goals/${createdBody.goal.eventId}`,
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-update-1",
      },
      body: updateBody,
    }),
  );

  assert.equal(updateResponse.statusCode, 200);
  const updateResponseBody = JSON.parse(updateResponse.body) as {
    goal: { scoringTeamId: string; concedingTeamId: string; scorerPlayerId: string };
    scoreboard: { teams: Array<{ teamId: string; scored: number; conceded: number }> };
    audit: { action: string; actorUserId: string };
  };
  assert.deepEqual(updateResponseBody.goal, {
    ...updateResponseBody.goal,
    scoringTeamId: "yellow",
    concedingTeamId: "red",
    scorerPlayerId: "player-yellow",
  });
  assert.deepEqual(
    updateResponseBody.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 0, conceded: 1 },
      { teamId: "blue", scored: 0, conceded: 0 },
      { teamId: "yellow", scored: 1, conceded: 0 },
    ],
  );
  assert.equal(updateResponseBody.audit.action, "goal_updated");
  assert.equal(updateResponseBody.audit.actorUserId, "scorekeeper@example.com");
  assert.equal(harness.goalAuditEntries.length, 2);
  assert.equal(harness.updatedGoals[0]?.allowFinished, false);

  const updateReplayResponse = await harness.handler(
    createEvent({
      method: "PATCH",
      path: `/v1/games/game-1/goals/${createdBody.goal.eventId}`,
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-update-1",
      },
      body: updateBody,
    }),
  );
  assert.equal(updateReplayResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(updateReplayResponse.body), updateResponseBody);
  assert.equal(harness.goalAuditEntries.length, 2);

  const deleteResponse = await harness.handler(
    createEvent({
      method: "DELETE",
      path: `/v1/games/game-1/goals/${createdBody.goal.eventId}`,
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-delete-1",
      },
    }),
  );
  assert.equal(deleteResponse.statusCode, 200);
  const deleteBody = JSON.parse(deleteResponse.body) as {
    deletedGoal: { eventId: string };
    timeline: Array<{ eventId: string }>;
    scoreboard: { teams: Array<{ teamId: string; scored: number; conceded: number }> };
    audit: { action: string };
  };
  assert.equal(deleteBody.deletedGoal.eventId, createdBody.goal.eventId);
  assert.deepEqual(deleteBody.timeline, []);
  assert.deepEqual(
    deleteBody.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 0, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 0 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );
  assert.equal(deleteBody.audit.action, "goal_deleted");
  assert.equal(harness.goalAuditEntries.length, 3);
  assert.equal(harness.deletedGoals[0]?.allowFinished, false);

  const deleteReplayResponse = await harness.handler(
    createEvent({
      method: "DELETE",
      path: `/v1/games/game-1/goals/${createdBody.goal.eventId}`,
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-delete-1",
      },
    }),
  );
  assert.equal(deleteReplayResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(deleteReplayResponse.body), deleteBody);
  assert.equal(harness.goalAuditEntries.length, 3);
});

test("core lambda rejects viewer goal corrections through ACL", async () => {
  const harness = createGoalHarness({
    email: "viewer@example.com",
    role: "viewer",
  });

  const response = await harness.handler(
    createEvent({
      method: "PATCH",
      path: "/v1/games/game-1/goals/goal-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        scorerPlayerId: "player-red",
      },
    }),
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), {
    error: "forbidden",
    code: "scorekeeper_required",
    message: "Admin or scorekeeper role is required for league league-1.",
  });
});

test("core lambda rejects invalid goal correction payloads", async () => {
  const harness = createGoalHarness();

  const response = await harness.handler(
    createEvent({
      method: "PATCH",
      path: "/v1/games/game-1/goals/goal-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        assistPlayerIds: ["player-blue", "player-blue"],
      },
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: "Field `assistPlayerIds` must be unique.",
  });
});

test("core lambda requires expectedEventId for undo-last", async () => {
  const harness = createGoalHarness();

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals/undo-last",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {},
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.match((JSON.parse(response.body) as { error: string }).error, /expectedEventId/);
});

test("core lambda undo-last deletes latest goal only and rejects stale expected event", async () => {
  const harness = createGoalHarness();
  const firstCreateResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-create-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );
  const secondCreateResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-create-2",
      },
      body: {
        scoringTeamId: "yellow",
        concedingTeamId: "red",
        scorerPlayerId: "player-yellow",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );
  assert.equal(firstCreateResponse.statusCode, 201);
  assert.equal(secondCreateResponse.statusCode, 201);
  const firstGoalId = (JSON.parse(firstCreateResponse.body) as { goal: { eventId: string } }).goal.eventId;
  const secondGoalId = (JSON.parse(secondCreateResponse.body) as { goal: { eventId: string } }).goal.eventId;

  const staleUndoResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals/undo-last",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        expectedEventId: firstGoalId,
      },
    }),
  );
  assert.equal(staleUndoResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(staleUndoResponse.body), {
    error: "conflict",
    code: "latest_goal_changed",
    message: "Latest goal changed before undo could be applied. Reload the game and try again.",
  });

  const undoResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals/undo-last",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-1",
      },
      body: {
        expectedEventId: secondGoalId,
      },
    }),
  );

  assert.equal(undoResponse.statusCode, 200);
  const undoBody = JSON.parse(undoResponse.body) as {
    deletedGoal: { eventId: string };
    timeline: Array<{ eventId: string }>;
    audit: { action: string };
  };
  assert.equal(undoBody.deletedGoal.eventId, secondGoalId);
  assert.deepEqual(undoBody.timeline.map((goal) => goal.eventId), [firstGoalId]);
  assert.equal(undoBody.audit.action, "goal_undo_last");

  const auditCountAfterUndo = harness.goalAuditEntries.length;
  const thirdCreateResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-create-3",
      },
      body: {
        scoringTeamId: "yellow",
        concedingTeamId: "blue",
        scorerPlayerId: "player-yellow",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );
  assert.equal(thirdCreateResponse.statusCode, 201);
  const thirdGoalId = (JSON.parse(thirdCreateResponse.body) as { goal: { eventId: string } }).goal.eventId;

  const undoReplayResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals/undo-last",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-1",
      },
      body: {
        expectedEventId: secondGoalId,
      },
    }),
  );
  assert.equal(undoReplayResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(undoReplayResponse.body), undoBody);
  assert.equal(harness.goalAuditEntries.length, auditCountAfterUndo + 1);

  const thirdUndoResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals/undo-last",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-3",
      },
      body: {
        expectedEventId: thirdGoalId,
      },
    }),
  );
  assert.equal(thirdUndoResponse.statusCode, 200);
  assert.equal(
    (JSON.parse(thirdUndoResponse.body) as { deletedGoal: { eventId: string } }).deletedGoal.eventId,
    thirdGoalId,
  );
});

test("core lambda replays undo-last retries after the game is finished", async () => {
  const harness = createGoalHarness();
  const createResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-finished-create-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );
  assert.equal(createResponse.statusCode, 201);
  const goalId = (JSON.parse(createResponse.body) as { goal: { eventId: string } }).goal.eventId;
  const undoBody = {
    expectedEventId: goalId,
  };

  const undoResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals/undo-last",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-finished-1",
      },
      body: undoBody,
    }),
  );
  assert.equal(undoResponse.statusCode, 200);
  const undoneCalls = harness.undoneGoals.length;

  await completeGoalHarnessThirds(harness, { firstThirdAlreadyRunning: true });
  const finishResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-finished-finish-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const replayResponse = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals/undo-last",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "goal-undo-finished-1",
      },
      body: undoBody,
    }),
  );
  assert.equal(replayResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(replayResponse.body), JSON.parse(undoResponse.body));
  assert.equal(harness.undoneGoals.length, undoneCalls);
});

test("core lambda rejects goal creation when no third is running", async () => {
  const harness = createGoalHarness({
    runningThird: false,
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "no_active_third",
    message: "A goal can only be created while a third is running.",
  });
});

test("core lambda rejects viewer goal creation through ACL", async () => {
  const harness = createGoalHarness({
    email: "viewer@example.com",
    role: "viewer",
  });

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), {
    error: "forbidden",
    code: "scorekeeper_required",
    message: "Admin or scorekeeper role is required for league league-1.",
  });
  assert.equal(harness.createdGoals.length, 0);
});

test("core lambda rejects invalid assist payloads before creating goals", async () => {
  const harness = createGoalHarness();

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: ["player-blue", "player-yellow", "player-a", "player-b"],
        ownGoal: false,
      },
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: "Field `assistPlayerIds` must contain no more than 3 player IDs.",
  });
  assert.equal(harness.createdGoals.length, 0);
});

test("core lambda rejects duplicate assist IDs before creating goals", async () => {
  const harness = createGoalHarness();

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "blue",
        scorerPlayerId: "player-red",
        assistPlayerIds: ["player-blue", "player-blue"],
        ownGoal: false,
      },
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: "Field `assistPlayerIds` must be unique.",
  });
  assert.equal(harness.createdGoals.length, 0);
});

test("core lambda rejects same-team standard goals before creating goals", async () => {
  const harness = createGoalHarness();

  const response = await harness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/goals",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        scoringTeamId: "red",
        concedingTeamId: "red",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      },
    }),
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: "Field `concedingTeamId` must differ from scoringTeamId for standard goals.",
  });
  assert.equal(harness.createdGoals.length, 0);
});

test("core lambda rejects third length changes on finished games", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "finished",
        gameStartTs: "2026-02-23T10:00:00.000Z",
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
      method: "PATCH",
      path: "/v1/games/game-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        thirdLengthMinutes: 30,
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "game_finished",
    message: "Third length cannot be changed after the game is finished.",
  });
});

test("core lambda rejects setting scheduled status after a third starts", async () => {
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-02-23T00:00:01.000Z",
  };

  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "live",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        thirds,
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
      method: "PATCH",
      path: "/v1/games/game-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        status: "scheduled",
      },
    }),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "conflict",
    code: "timer_status_locked",
    message: "Game status cannot be set back to scheduled after a third has started.",
  });
});

test("core lambda rejects manual status finish and unfinish through patch", async () => {
  const scheduledHarness = createGoalHarness({
    email: "admin@example.com",
    role: "admin",
    runningThird: false,
  });
  const directFinishResponse = await scheduledHarness.handler(
    createEvent({
      method: "PATCH",
      path: "/v1/games/game-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        status: "finished",
      },
    }),
  );

  assert.equal(directFinishResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(directFinishResponse.body), {
    error: "conflict",
    code: "use_finish_endpoint",
    message: "Use POST /v1/games/{gameId}/finish to finish a game.",
  });

  const finishedHarness = createGoalHarness({
    email: "admin@example.com",
    role: "admin",
    runningThird: false,
    completedThirds: true,
  });
  const finishResponse = await finishedHarness.handler(
    createEvent({
      method: "POST",
      path: "/v1/games/game-1/finish",
      headers: {
        Cookie: "threefc_session=session-1",
        "Idempotency-Key": "finish-before-unfinish-1",
      },
    }),
  );
  assert.equal(finishResponse.statusCode, 200);

  const unfinishResponse = await finishedHarness.handler(
    createEvent({
      method: "PATCH",
      path: "/v1/games/game-1",
      headers: {
        Cookie: "threefc_session=session-1",
      },
      body: {
        status: "live",
      },
    }),
  );

  assert.equal(unfinishResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(unfinishResponse.body), {
    error: "conflict",
    code: "game_finished",
    message: "Finished games cannot be moved back to scheduled or live.",
  });
});

test("core lambda team, roster, and goal read routes do not create team records", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "viewer@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
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
      "league-1:viewer@example.com": {
        leagueId: "league-1",
        userId: "viewer@example.com",
        role: "viewer",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  for (const path of [
    "/v1/seasons/season-1/teams",
    "/v1/games/game-1/teams",
    "/v1/games/game-1/roster",
    "/v1/games/game-1/goals",
  ]) {
    const response = await harness.handler(
      createEvent({
        method: "GET",
        path,
        headers: {
          Cookie: "threefc_session=session-1",
        },
      }),
    );

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as {
      teams?: Array<{ teamId: string }>;
      scoreboard?: { teams: Array<{ teamId: string }> };
    };
    assert.deepEqual((body.teams ?? body.scoreboard?.teams)?.map((team) => team.teamId), ["red", "blue", "yellow"]);
  }

  assert.equal(harness.createdSeasonTeams.length, 0);
  assert.equal(harness.createdGameTeams.length, 0);
});

test("core lambda game player list is game-scoped and public", async () => {
  const harness = createHarness({
    sessions: {
      "session-1": {
        sessionId: "session-1",
        email: "scorekeeper@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        expiresAt: "2026-02-24T00:00:00.000Z",
      },
    },
    games: {
      "game-1": {
        gameId: "game-1",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-23T10:00:00.000Z",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-2": {
        gameId: "game-2",
        leagueId: "league-2",
        seasonId: "season-2",
        sessionId: "session-2",
        status: "scheduled",
        gameStartTs: "2026-02-24T10:00:00.000Z",
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
      "season-2": {
        leagueId: "league-2",
        seasonId: "season-2",
        name: "Season 2",
        slug: null,
        startsOn: null,
        endsOn: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    leagueAccess: {
      "league-1:scorekeeper@example.com": {
        leagueId: "league-1",
        userId: "scorekeeper@example.com",
        role: "scorekeeper",
        grantedByUserId: "admin@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    players: {
      "player-game-1": {
        playerId: "player-game-1",
        nickname: "Ari",
        claimedByUserId: "ari@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "player-game-2": {
        playerId: "player-game-2",
        nickname: "Bao",
        claimedByUserId: "bao@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "player-unlinked": {
        playerId: "player-unlinked",
        nickname: "Cy",
        claimedByUserId: "cy@example.com",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    gamePlayers: {
      "game-1:player-game-1": {
        gameId: "game-1",
        playerId: "player-game-1",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
      "game-2:player-game-2": {
        gameId: "game-2",
        playerId: "player-game-2",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
    rosterAssignments: {
      "game-1:player-game-1": {
        gameId: "game-1",
        playerId: "player-game-1",
        teamId: "red",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    },
  });

  const playersResponse = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/games/game-1/players",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(playersResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(playersResponse.body), {
    players: [
      {
        playerId: "player-game-1",
        nickname: "Ari",
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    ],
  });
  assert.equal(playersResponse.body.includes("claimedByUserId"), false);

  const rosterResponse = await harness.handler(
    createEvent({
      method: "GET",
      path: "/v1/games/game-1/roster",
      headers: {
        Cookie: "threefc_session=session-1",
      },
    }),
  );

  assert.equal(rosterResponse.statusCode, 200);
  assert.equal(rosterResponse.body.includes("claimedByUserId"), false);
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
