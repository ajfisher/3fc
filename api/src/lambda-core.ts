import { createHash, randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  buildGameTimerState,
  DEFAULT_TEAMS,
  isThirdLengthMinutes,
  isThirdNumber,
  TEAM_IDS,
  type TeamId,
  type ThirdLengthMinutes,
  type ThirdNumber,
} from "@3fc/contracts";

import { authorizeProtectedMutation } from "./auth/acl.js";
import {
  buildCorsHeaders,
  isMagicLinkStartOriginPermitted,
  isStateChangeOriginPermitted,
  parseAllowedOrigins,
} from "./auth/http-security.js";
import {
  isMagicLinkEmailLike,
  MagicLinkAuthError,
  MagicLinkService,
  normalizeMagicLinkEmail,
} from "./auth/magic-link.js";
import {
  AuthRateLimiter,
  readMagicLinkRateLimitConfig,
  type RateLimitDecision,
} from "./auth/rate-limit.js";
import { resolveSessionFromCookie } from "./auth/session-guard.js";
import {
  buildSessionCookie,
  isAuthenticatedApiRoute,
  resolveSessionCookieSecureFlag,
} from "./auth/session.js";
import {
  createGameRequestSchema,
  createGoalRequestSchema,
  createLeagueRequestSchema,
  createSeasonRequestSchema,
  createSessionRequestSchema,
  assignRosterPlayerRequestSchema,
  formatSchemaValidationError,
  idempotencyKeyHeaderSchema,
  quickCreateGamePlayerRequestSchema,
  upsertTeamRequestSchema,
} from "./contracts/core-write.js";
import { GameTimerTransitionError, GoalCreationError, ThreeFcRepository } from "./data/repository.js";
import type { CreateGoalResult, GameStatus } from "./data/types.js";
import { logAuthRateLimit, logRequest, logRequestError } from "./logging.js";

export interface ApiGatewayHttpEvent {
  rawPath?: string;
  rawQueryString?: string;
  body?: string | null;
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  requestContext?: {
    requestId?: string;
    routeKey?: string;
    http?: {
      method?: string;
      path?: string;
      sourceIp?: string;
    };
  };
}

export interface ApiGatewayHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface RequestDetails {
  requestId: string;
  route: string;
  method: string;
}

type AuthSessionRecord = {
  sessionId: string;
  email: string;
  createdAt: string;
  expiresAt: string;
};

interface SessionLookup {
  getSession(sessionId: string): Promise<AuthSessionRecord | null>;
}

interface MagicLinkServiceContract extends SessionLookup {
  start(email: string): Promise<{
    email: string;
    expiresAt: string;
    messageId: string | null;
  }>;
  complete(token: string): Promise<{
    sessionId: string;
    email: string;
    createdAt: string;
    expiresAt: string;
    maxAgeSeconds: number;
  }>;
}

interface RepositoryContract {
  listLeaguesForUser(userId: string): Promise<
    Array<{
      leagueId: string;
      name: string;
      slug: string | null;
      createdByUserId: string;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  createLeague(input: {
    leagueId: string;
    name: string;
    slug?: string | null;
    createdByUserId: string;
  }): Promise<unknown>;
  getLeague(
    leagueId: string,
  ): Promise<
    | {
        leagueId: string;
        name: string;
        slug: string | null;
        createdByUserId: string;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  listSeasonsForLeague(
    leagueId: string,
  ): Promise<
    Array<{
      leagueId: string;
      seasonId: string;
      name: string;
      slug: string | null;
      startsOn: string | null;
      endsOn: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  createSeason(input: {
    leagueId: string;
    seasonId: string;
    name: string;
    slug?: string | null;
    startsOn?: string | null;
    endsOn?: string | null;
  }): Promise<{
    leagueId: string;
    seasonId: string;
    name: string;
    slug: string | null;
    startsOn: string | null;
    endsOn: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  createTeam(input: {
    seasonId: string;
    teamId: TeamId;
    name: string;
    color?: string | null;
  }): Promise<{
    seasonId: string;
    teamId: TeamId;
    name: string;
    color: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  listTeamsForSeason(seasonId: string): Promise<
    Array<{
      seasonId: string;
      teamId: TeamId;
      name: string;
      color: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  createGameTeamOverride(input: {
    gameId: string;
    teamId: TeamId;
    name: string;
    color?: string | null;
  }): Promise<{
    gameId: string;
    teamId: TeamId;
    name: string;
    color: string | null;
    scored: number;
    conceded: number;
    createdAt: string;
    updatedAt: string;
  }>;
  listTeamsForGame(gameId: string): Promise<
    Array<{
      gameId: string;
      teamId: TeamId;
      name: string;
      color: string | null;
      scored: number;
      conceded: number;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  createSession(input: { seasonId: string; sessionId: string; sessionDate: string }): Promise<unknown>;
  createGame(input: {
    gameId: string;
    leagueId: string;
    seasonId: string;
    sessionId: string;
    status?: GameStatus;
    gameStartTs: string;
    thirdLengthMinutes?: ThirdLengthMinutes;
  }): Promise<{
    gameId: string;
    leagueId: string;
    seasonId: string;
    sessionId: string;
    gameStartTs: string;
    thirdLengthMinutes: ThirdLengthMinutes;
    thirds: Array<{
      third: ThirdNumber;
      startedAt: string | null;
      finishedAt: string | null;
    }>;
    status: "scheduled" | "live" | "finished";
    createdAt: string;
    updatedAt: string;
  }>;
  createSessionGame(input: {
    sessionId: string;
    gameId: string;
    gameStartTs: string;
    leagueId: string;
    seasonId: string;
  }): Promise<unknown>;
  listGamesForSeason(
    seasonId: string,
  ): Promise<
    Array<{
      gameId: string;
      leagueId: string;
      seasonId: string;
      sessionId: string;
      status: "scheduled" | "live" | "finished";
      gameStartTs: string;
      thirdLengthMinutes: ThirdLengthMinutes;
      thirds: Array<{
        third: ThirdNumber;
        startedAt: string | null;
        finishedAt: string | null;
      }>;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  getGame(
    gameId: string,
  ): Promise<
    | {
        gameId: string;
        leagueId: string;
        seasonId: string;
        sessionId: string;
        status: "scheduled" | "live" | "finished";
        gameStartTs: string;
        thirdLengthMinutes: ThirdLengthMinutes;
        thirds: Array<{
          third: ThirdNumber;
          startedAt: string | null;
          finishedAt: string | null;
        }>;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  updateGame(input: {
    gameId: string;
    status?: "scheduled" | "live" | "finished";
    gameStartTs?: string;
    thirdLengthMinutes?: ThirdLengthMinutes;
  }): Promise<
    | {
        gameId: string;
        leagueId: string;
        seasonId: string;
        sessionId: string;
        status: "scheduled" | "live" | "finished";
        gameStartTs: string;
        thirdLengthMinutes: ThirdLengthMinutes;
        thirds: Array<{
          third: ThirdNumber;
          startedAt: string | null;
          finishedAt: string | null;
        }>;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  startGameThird(input: { gameId: string; third: ThirdNumber }): Promise<
    | {
        gameId: string;
        leagueId: string;
        seasonId: string;
        sessionId: string;
        status: "scheduled" | "live" | "finished";
        gameStartTs: string;
        thirdLengthMinutes: ThirdLengthMinutes;
        thirds: Array<{
          third: ThirdNumber;
          startedAt: string | null;
          finishedAt: string | null;
        }>;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  finishGameThird(input: { gameId: string; third: ThirdNumber }): Promise<
    | {
        gameId: string;
        leagueId: string;
        seasonId: string;
        sessionId: string;
        status: "scheduled" | "live" | "finished";
        gameStartTs: string;
        thirdLengthMinutes: ThirdLengthMinutes;
        thirds: Array<{
          third: ThirdNumber;
          startedAt: string | null;
          finishedAt: string | null;
        }>;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  deleteGame(gameId: string): Promise<boolean>;
  deleteSeason(seasonId: string): Promise<boolean>;
  deleteLeague(leagueId: string): Promise<boolean>;
  createPlayer(input: {
    playerId: string;
    nickname: string;
    claimedByUserId?: string | null;
  }): Promise<{
    playerId: string;
    nickname: string;
    claimedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  getPlayer(
    playerId: string,
  ): Promise<
    | {
        playerId: string;
        nickname: string;
        claimedByUserId: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  listPlayers(input?: {
    search?: string | null;
    limit?: number;
  }): Promise<
    Array<{
      playerId: string;
      nickname: string;
      claimedByUserId: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  linkGamePlayer(input: {
    gameId: string;
    playerId: string;
  }): Promise<{
    gameId: string;
    playerId: string;
    createdAt: string;
    updatedAt: string;
  }>;
  listGamePlayers(gameId: string): Promise<
    Array<{
      gameId: string;
      playerId: string;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  assignRosterPlayer(input: {
    gameId: string;
    teamId: TeamId;
    playerId: string;
  }): Promise<{
    gameId: string;
    teamId: TeamId;
    playerId: string;
    createdAt: string;
    updatedAt: string;
  }>;
  listGameRoster(gameId: string): Promise<
    Array<{
      gameId: string;
      teamId: TeamId;
      playerId: string;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  createGoal(input: {
    gameId: string;
    eventId: string;
    scoringTeamId: TeamId | null;
    concedingTeamId: TeamId;
    scorerPlayerId: string;
    assistPlayerIds: string[];
    ownGoal: boolean;
  }): Promise<CreateGoalResult | null>;
  getLeagueAccess(
    leagueId: string,
    userId: string,
  ): Promise<
    | {
        leagueId: string;
        userId: string;
        role: "admin" | "scorekeeper" | "viewer";
        grantedByUserId: string;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  getSeason(
    seasonId: string,
  ): Promise<
    | {
        leagueId: string;
        seasonId: string;
        name: string;
        slug: string | null;
        startsOn: string | null;
        endsOn: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  getSession(
    sessionId: string,
  ): Promise<
    | {
        seasonId: string;
        sessionId: string;
        sessionDate: string;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  getIdempotencyRecord(
    scope: string,
    key: string,
  ): Promise<
    | {
        scope: string;
        key: string;
        requestHash: string;
        responseStatusCode: number;
        responseBody: string;
        createdAt: string;
        updatedAt: string;
      }
    | null
  >;
  createIdempotencyRecord(input: {
    scope: string;
    key: string;
    requestHash: string;
    responseStatusCode: number;
    responseBody: string;
  }): Promise<boolean>;
}

interface CoreHandlerDependencies {
  repository: RepositoryContract;
  magicLinkService: MagicLinkServiceContract;
  magicLinkRateLimiter: {
    consumeMagicLinkStart(input: { email: string; clientIp: string }): Promise<RateLimitDecision>;
  };
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  corsAllowedOrigins: string[];
}

function getRequestDetails(event: ApiGatewayHttpEvent): RequestDetails {
  return {
    requestId: event.requestContext?.requestId ?? randomUUID(),
    route: event.requestContext?.http?.path ?? event.rawPath ?? "/",
    method: event.requestContext?.http?.method ?? "GET",
  };
}

function getHeader(event: ApiGatewayHttpEvent, headerName: string): string | undefined {
  const target = headerName.toLowerCase();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (name.toLowerCase() === target) {
      return value ?? undefined;
    }
  }

  return undefined;
}

function getCookieHeader(event: ApiGatewayHttpEvent): string | undefined {
  const cookieHeader = getHeader(event, "cookie");
  if (cookieHeader && cookieHeader.trim().length > 0) {
    return cookieHeader;
  }

  if (Array.isArray(event.cookies) && event.cookies.length > 0) {
    return event.cookies.join("; ");
  }

  return undefined;
}

function getQueryParam(event: ApiGatewayHttpEvent, name: string): string | null {
  const query = event.rawQueryString ?? "";
  if (query.length === 0) {
    return null;
  }

  return new URLSearchParams(query).get(name);
}

function getClientIp(event: ApiGatewayHttpEvent): string {
  const sourceIp = event.requestContext?.http?.sourceIp;
  if (sourceIp && sourceIp.trim().length > 0) {
    return sourceIp.trim();
  }

  const forwardedFor = getHeader(event, "x-forwarded-for");
  if (forwardedFor && forwardedFor.trim().length > 0) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return "unknown";
}

function createJsonResponse(
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
): ApiGatewayHttpResponse {
  return {
    statusCode,
    headers: {
      ...headers,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  };
}

function createNoContentResponse(headers: Record<string, string> = {}): ApiGatewayHttpResponse {
  return {
    statusCode: 204,
    headers,
    body: "",
  };
}

function parseJsonBody(event: ApiGatewayHttpEvent): Record<string, unknown> {
  if (!event.body || event.body.length === 0) {
    return {};
  }

  return JSON.parse(event.body) as Record<string, unknown>;
}

function badRequest(
  origin: string | undefined,
  allowedOrigins: string[],
  message: string,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    400,
    { error: message },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function magicLinkErrorResponse(
  origin: string | undefined,
  allowedOrigins: string[],
  error: MagicLinkAuthError,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    error.statusCode,
    {
      error: error.code,
      message: error.message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function forbiddenOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    403,
    {
      error: "forbidden_origin",
      message: "State-changing requests must originate from an allowed app domain.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function rateLimited(
  origin: string | undefined,
  allowedOrigins: string[],
  retryAfterSeconds: number,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    429,
    {
      error: "rate_limited",
      message: "Too many sign-in link requests. Try again later.",
      retryAfterSeconds,
    },
    {
      ...buildCorsHeaders(origin, allowedOrigins),
      "retry-after": String(retryAfterSeconds),
    },
  );
}

function internalError(
  origin: string | undefined,
  allowedOrigins: string[],
  message: string,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    500,
    {
      error: "Internal server error",
      detail: message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function forbidden(
  origin: string | undefined,
  allowedOrigins: string[],
  code: string,
  message: string,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    403,
    {
      error: "forbidden",
      code,
      message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function notFound(
  origin: string | undefined,
  allowedOrigins: string[],
  message: string,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    404,
    {
      error: "not_found",
      message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function conflict(
  origin: string | undefined,
  allowedOrigins: string[],
  message: string,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "conflict",
      message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

async function ensureLeagueAccess(
  repository: RepositoryContract,
  leagueId: string,
  userId: string,
): Promise<{ allowed: boolean; role: "admin" | "scorekeeper" | "viewer" | null }> {
  const access = await repository.getLeagueAccess(leagueId, userId);
  if (!access) {
    return { allowed: false, role: null };
  }

  return { allowed: true, role: access.role };
}

async function ensureLeagueAdmin(
  repository: RepositoryContract,
  leagueId: string,
  userId: string,
): Promise<boolean> {
  const access = await repository.getLeagueAccess(leagueId, userId);
  return access?.role === "admin";
}

async function ensureLeagueRole(
  repository: RepositoryContract,
  leagueId: string,
  userId: string,
  allowedRoles: ReadonlySet<"admin" | "scorekeeper" | "viewer">,
): Promise<boolean> {
  const access = await repository.getLeagueAccess(leagueId, userId);
  return access ? allowedRoles.has(access.role) : false;
}

function parseTeamId(value: string): TeamId | null {
  return TEAM_IDS.includes(value as TeamId) ? (value as TeamId) : null;
}

function compareTeamIds(left: TeamId, right: TeamId): number {
  return TEAM_IDS.indexOf(left) - TEAM_IDS.indexOf(right);
}

function sortTeams<T extends { teamId: TeamId }>(teams: T[]): T[] {
  return [...teams].sort((left, right) => compareTeamIds(left.teamId, right.teamId));
}

function buildGameResponse(game: {
  gameId: string;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status: "scheduled" | "live" | "finished";
  gameStartTs: string;
  thirdLengthMinutes: ThirdLengthMinutes;
  thirds: Array<{
    third: ThirdNumber;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    ...game,
    timer: buildGameTimerState({
      thirdLengthMinutes: game.thirdLengthMinutes,
      thirds: game.thirds,
    }),
  };
}

function parseThirdRouteParam(value: string): ThirdNumber | null {
  if (value === "1" || value === "2" || value === "3") {
    const parsed = Number.parseInt(value, 10);
    return isThirdNumber(parsed) ? parsed : null;
  }

  return null;
}

function timerTransitionConflictResponse(
  origin: string | undefined,
  allowedOrigins: string[],
  error: GameTimerTransitionError,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "conflict",
      code: error.code,
      message: error.message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function goalCreationErrorResponse(
  origin: string | undefined,
  allowedOrigins: string[],
  error: GoalCreationError,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    error.statusCode,
    {
      error: error.statusCode === 409 ? "conflict" : "bad_request",
      code: error.code,
      message: error.message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function toPublicPlayer(player: {
  playerId: string;
  nickname: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    playerId: player.playerId,
    nickname: player.nickname,
    createdAt: player.createdAt,
    updatedAt: player.updatedAt,
  };
}

function buildReadOnlySeasonTeams(
  season: {
    seasonId: string;
    createdAt: string;
    updatedAt: string;
  },
  existingTeams: Array<{
    seasonId: string;
    teamId: TeamId;
    name: string;
    color: string | null;
    createdAt: string;
    updatedAt: string;
  }>,
) {
  const teamsById = new Map(existingTeams.map((team) => [team.teamId, team]));

  for (const defaultTeam of DEFAULT_TEAMS) {
    if (teamsById.has(defaultTeam.teamId)) {
      continue;
    }

    teamsById.set(defaultTeam.teamId, {
      seasonId: season.seasonId,
      teamId: defaultTeam.teamId,
      name: defaultTeam.name,
      color: defaultTeam.color,
      createdAt: season.createdAt,
      updatedAt: season.updatedAt,
    });
  }

  return sortTeams([...teamsById.values()]);
}

async function readSeasonTeams(
  repository: RepositoryContract,
  season: {
    seasonId: string;
    createdAt: string;
    updatedAt: string;
  },
) {
  const existingTeams = await repository.listTeamsForSeason(season.seasonId);
  return buildReadOnlySeasonTeams(season, existingTeams);
}

async function ensureSeasonDefaultTeams(repository: RepositoryContract, seasonId: string) {
  const existingTeams = await repository.listTeamsForSeason(seasonId);
  const teamsById = new Map(existingTeams.map((team) => [team.teamId, team]));

  for (const defaultTeam of DEFAULT_TEAMS) {
    if (teamsById.has(defaultTeam.teamId)) {
      continue;
    }

    const createdTeam = await repository.createTeam({
      seasonId,
      teamId: defaultTeam.teamId,
      name: defaultTeam.name,
      color: defaultTeam.color,
    });
    teamsById.set(createdTeam.teamId, createdTeam);
  }

  return sortTeams([...teamsById.values()]);
}

async function ensureGameTeamsForGame(
  repository: RepositoryContract,
  game: {
    gameId: string;
    seasonId: string;
  },
) {
  const seasonTeams = await ensureSeasonDefaultTeams(repository, game.seasonId);
  const existingGameTeams = await repository.listTeamsForGame(game.gameId);
  const gameTeamsById = new Map(existingGameTeams.map((team) => [team.teamId, team]));

  for (const seasonTeam of seasonTeams) {
    if (gameTeamsById.has(seasonTeam.teamId)) {
      continue;
    }

    const gameTeam = await repository.createGameTeamOverride({
      gameId: game.gameId,
      teamId: seasonTeam.teamId,
      name: seasonTeam.name,
      color: seasonTeam.color,
    });
    gameTeamsById.set(gameTeam.teamId, gameTeam);
  }

  return sortTeams([...gameTeamsById.values()]);
}

async function readGameTeams(
  repository: RepositoryContract,
  game: {
    gameId: string;
    seasonId: string;
    createdAt: string;
    updatedAt: string;
  },
) {
  const season = await repository.getSeason(game.seasonId);
  const existingGameTeams = await repository.listTeamsForGame(game.gameId);
  const gameTeamsById = new Map(existingGameTeams.map((team) => [team.teamId, team]));
  const seasonTeams = season
    ? await readSeasonTeams(repository, season)
    : DEFAULT_TEAMS.map((team) => ({
        seasonId: game.seasonId,
        teamId: team.teamId,
        name: team.name,
        color: team.color,
        createdAt: game.createdAt,
        updatedAt: game.updatedAt,
      }));

  for (const seasonTeam of seasonTeams) {
    if (gameTeamsById.has(seasonTeam.teamId)) {
      continue;
    }

    gameTeamsById.set(seasonTeam.teamId, {
      gameId: game.gameId,
      teamId: seasonTeam.teamId,
      name: seasonTeam.name,
      color: seasonTeam.color,
      scored: 0,
      conceded: 0,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    });
  }

  return sortTeams([...gameTeamsById.values()]);
}

async function buildRosterResponse(repository: RepositoryContract, game: {
  gameId: string;
  seasonId: string;
  createdAt: string;
  updatedAt: string;
}) {
  const teams = await readGameTeams(repository, game);
  const roster = await repository.listGameRoster(game.gameId);
  const playersById = new Map(
    (
      await Promise.all(
        [...new Set(roster.map((assignment) => assignment.playerId))].map((playerId) =>
          repository.getPlayer(playerId),
        ),
      )
    )
      .filter((player) => player !== null)
      .map((player) => [player.playerId, toPublicPlayer(player)]),
  );

  return {
    teams,
    roster: roster
      .map((assignment) => ({
        ...assignment,
        player: playersById.get(assignment.playerId) ?? null,
      }))
      .sort((left, right) => {
        const teamSort = compareTeamIds(left.teamId, right.teamId);
        if (teamSort !== 0) {
          return teamSort;
        }

        const leftName = left.player?.nickname ?? left.playerId;
        const rightName = right.player?.nickname ?? right.playerId;
        return leftName.localeCompare(rightName);
      }),
  };
}

function parseGamePatchBody(rawBody: Record<string, unknown>): {
  status?: "scheduled" | "live" | "finished";
  gameStartTs?: string;
  thirdLengthMinutes?: ThirdLengthMinutes;
} | null {
  const allowedStatuses = new Set(["scheduled", "live", "finished"]);
  const parsed: {
    status?: "scheduled" | "live" | "finished";
    gameStartTs?: string;
    thirdLengthMinutes?: ThirdLengthMinutes;
  } = {};

  if (rawBody.status !== undefined) {
    if (typeof rawBody.status !== "string" || !allowedStatuses.has(rawBody.status)) {
      return null;
    }

    parsed.status = rawBody.status as "scheduled" | "live" | "finished";
  }

  if (rawBody.gameStartTs !== undefined) {
    if (typeof rawBody.gameStartTs !== "string" || rawBody.gameStartTs.trim().length === 0) {
      return null;
    }

    parsed.gameStartTs = rawBody.gameStartTs;
  }

  if (rawBody.thirdLengthMinutes !== undefined) {
    if (typeof rawBody.thirdLengthMinutes !== "number" || !isThirdLengthMinutes(rawBody.thirdLengthMinutes)) {
      return null;
    }

    parsed.thirdLengthMinutes = rawBody.thirdLengthMinutes;
  }

  if (
    parsed.status === undefined &&
    parsed.gameStartTs === undefined &&
    parsed.thirdLengthMinutes === undefined
  ) {
    return null;
  }

  return parsed;
}

function buildIdempotencyScope(sessionEmail: string, method: string, route: string): string {
  return `${sessionEmail}:${method}:${route}`;
}

function normalizePayloadForHashing(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePayloadForHashing(entry));
  }

  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sortedKeys = Object.keys(source).sort();
    const normalizedEntries = sortedKeys.map((key) => [key, normalizePayloadForHashing(source[key])] as const);
    return Object.fromEntries(normalizedEntries);
  }

  return value;
}

function buildIdempotencyRequestHash(scope: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${scope}:${JSON.stringify(normalizePayloadForHashing(payload))}`)
    .digest("hex");
}

function buildGoalEventId(input: {
  idempotencyKey: string | undefined;
  sessionEmail: string;
  method: string;
  route: string;
}): string {
  const parsedIdempotencyKey = input.idempotencyKey
    ? idempotencyKeyHeaderSchema.safeParse(input.idempotencyKey)
    : null;

  if (!parsedIdempotencyKey?.success) {
    return `goal-${randomUUID()}`;
  }

  const scope = buildIdempotencyScope(input.sessionEmail, input.method, input.route);
  const digest = createHash("sha256")
    .update(`${scope}:${parsedIdempotencyKey.data}`)
    .digest("hex")
    .slice(0, 32);
  return `goal-idem-${digest}`;
}

function parseStoredIdempotencyResponseBody(responseBody: string): unknown {
  try {
    return JSON.parse(responseBody);
  } catch {
    return {
      error: "Internal server error",
      detail: "Stored idempotency response could not be parsed.",
    };
  }
}

function idempotencyConflictResponse(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "idempotency_conflict",
      message: "Idempotency key has already been used with a different payload.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

async function executeIdempotentMutation(input: {
  repository: RepositoryContract;
  idempotencyKey: string | undefined;
  sessionEmail: string;
  method: string;
  route: string;
  requestPayload: unknown;
  origin: string | undefined;
  allowedOrigins: string[];
  execute: () => Promise<ApiGatewayHttpResponse>;
}): Promise<ApiGatewayHttpResponse> {
  if (!input.idempotencyKey) {
    return input.execute();
  }

  const parsedHeader = idempotencyKeyHeaderSchema.safeParse(input.idempotencyKey);
  if (!parsedHeader.success) {
    return badRequest(
      input.origin,
      input.allowedOrigins,
      formatSchemaValidationError(parsedHeader.error),
    );
  }

  const idempotencyKey = parsedHeader.data;
  const scope = buildIdempotencyScope(input.sessionEmail, input.method, input.route);
  const requestHash = buildIdempotencyRequestHash(scope, input.requestPayload);
  const existingRecord = await input.repository.getIdempotencyRecord(scope, idempotencyKey);

  if (existingRecord) {
    if (existingRecord.requestHash !== requestHash) {
      return idempotencyConflictResponse(input.origin, input.allowedOrigins);
    }

    return createJsonResponse(
      existingRecord.responseStatusCode,
      parseStoredIdempotencyResponseBody(existingRecord.responseBody),
      buildCorsHeaders(input.origin, input.allowedOrigins),
    );
  }

  const mutationResponse = await input.execute();
  const created = await input.repository.createIdempotencyRecord({
    scope,
    key: idempotencyKey,
    requestHash,
    responseStatusCode: mutationResponse.statusCode,
    responseBody: mutationResponse.body,
  });

  if (created) {
    return mutationResponse;
  }

  const raceRecord = await input.repository.getIdempotencyRecord(scope, idempotencyKey);
  if (!raceRecord) {
    return mutationResponse;
  }

  if (raceRecord.requestHash !== requestHash) {
    return idempotencyConflictResponse(input.origin, input.allowedOrigins);
  }

  return createJsonResponse(
    raceRecord.responseStatusCode,
    parseStoredIdempotencyResponseBody(raceRecord.responseBody),
    buildCorsHeaders(input.origin, input.allowedOrigins),
  );
}

function decodeRouteParam(value: string): string {
  return decodeURIComponent(value);
}

function createDefaultDependencies(): CoreHandlerDependencies {
  const region = process.env.AWS_REGION ?? "ap-southeast-2";
  const tableName = process.env.DYNAMODB_TABLE ?? "threefc_local";
  const ddbEndpoint = process.env.DYNAMODB_ENDPOINT;
  const appBaseUrl = process.env.APP_BASE_URL ?? "https://app.3fc.football";
  const sessionCookieSecure = resolveSessionCookieSecureFlag(
    process.env.SESSION_COOKIE_SECURE,
    appBaseUrl,
  );
  const sesFromEmail = process.env.SES_FROM_EMAIL ?? "noreply@3fc.football";
  const callbackPath = process.env.MAGIC_LINK_CALLBACK_PATH ?? "/auth/callback";
  const tokenTtlSeconds = Number.parseInt(process.env.MAGIC_LINK_TOKEN_TTL_SECONDS ?? "900", 10);
  const sessionTtlSeconds = Number.parseInt(
    process.env.MAGIC_LINK_SESSION_TTL_SECONDS ?? "86400",
    10,
  );

  const ddbClient = new DynamoDBClient({
    region,
    ...(ddbEndpoint
      ? {
          endpoint: ddbEndpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
          },
        }
      : {}),
  });

  const repository = new ThreeFcRepository(ddbClient, tableName);
  const magicLinkRateLimiter = new AuthRateLimiter(
    ddbClient,
    tableName,
    readMagicLinkRateLimitConfig(),
  );
  const sesClient = new SESv2Client({ region });
  const magicLinkService = new MagicLinkService(
    ddbClient,
    {
      async sendMagicLink(input) {
        const output = await sesClient.send(
          new SendEmailCommand({
            FromEmailAddress: sesFromEmail,
            Destination: {
              ToAddresses: [input.to],
            },
            Content: {
              Simple: {
                Subject: {
                  Data: input.subject,
                  Charset: "UTF-8",
                },
                Body: {
                  Text: {
                    Data: input.body,
                    Charset: "UTF-8",
                  },
                },
              },
            },
          }),
        );

        return {
          messageId: output.MessageId,
        };
      },
    },
    {
      tableName,
      appBaseUrl,
      callbackPath,
      tokenTtlSeconds,
      sessionTtlSeconds,
    },
  );

  return {
    repository,
    magicLinkService,
    magicLinkRateLimiter,
    sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "threefc_session",
    sessionCookieSecure,
    corsAllowedOrigins: parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
  };
}

export function createLambdaCoreHandler(dependencies: CoreHandlerDependencies) {
  return async (event: ApiGatewayHttpEvent): Promise<ApiGatewayHttpResponse> => {
    const details = getRequestDetails(event);
    const route = details.route;
    const method = details.method;
    const origin = getHeader(event, "origin");
    const cookieHeader = getCookieHeader(event);
    const idempotencyKey = getHeader(event, "idempotency-key");
    const clientIp = getClientIp(event);
    let status = 500;

    try {
      if (method === "OPTIONS" && route.startsWith("/v1/")) {
        status = 204;
        return createNoContentResponse(buildCorsHeaders(origin, dependencies.corsAllowedOrigins));
      }

      if (!isStateChangeOriginPermitted(method, origin, dependencies.corsAllowedOrigins)) {
        status = 403;
        return forbiddenOrigin(origin, dependencies.corsAllowedOrigins);
      }

      if (method === "POST" && route === "/v1/auth/magic/start") {
        if (!isMagicLinkStartOriginPermitted(method, route, origin, dependencies.corsAllowedOrigins)) {
          status = 403;
          return forbiddenOrigin(origin, dependencies.corsAllowedOrigins);
        }

        let rawBody: Record<string, unknown>;
        try {
          rawBody = parseJsonBody(event);
        } catch {
          status = 400;
          return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
        }

        if (typeof rawBody.email !== "string") {
          status = 400;
          return badRequest(origin, dependencies.corsAllowedOrigins, "Field `email` is required.");
        }

        const email = normalizeMagicLinkEmail(rawBody.email);
        if (!isMagicLinkEmailLike(email)) {
          status = 400;
          return magicLinkErrorResponse(
            origin,
            dependencies.corsAllowedOrigins,
            new MagicLinkAuthError("invalid_email", 400, "Email must be a valid email address."),
          );
        }

        const rateLimitDecision = await dependencies.magicLinkRateLimiter.consumeMagicLinkStart({
          email,
          clientIp,
        });
        if (!rateLimitDecision.allowed) {
          status = 429;
          logAuthRateLimit({
            requestId: details.requestId,
            route,
            method,
            status,
            dimension: rateLimitDecision.dimension,
            retryAfterSeconds: rateLimitDecision.retryAfterSeconds,
          });
          return rateLimited(
            origin,
            dependencies.corsAllowedOrigins,
            rateLimitDecision.retryAfterSeconds,
          );
        }

        try {
          const startResult = await dependencies.magicLinkService.start(email);
          status = 202;
          return createJsonResponse(
            status,
            {
              status: "sent",
              email: startResult.email,
              expiresAt: startResult.expiresAt,
              messageId: startResult.messageId,
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        } catch (error) {
          if (error instanceof MagicLinkAuthError) {
            status = error.statusCode;
            return magicLinkErrorResponse(origin, dependencies.corsAllowedOrigins, error);
          }

          throw error;
        }
      }

      if (method === "POST" && route === "/v1/auth/magic/complete") {
        let rawBody: Record<string, unknown>;
        try {
          rawBody = parseJsonBody(event);
        } catch {
          status = 400;
          return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
        }

        if (typeof rawBody.token !== "string") {
          status = 400;
          return badRequest(origin, dependencies.corsAllowedOrigins, "Field `token` is required.");
        }

        try {
          const completed = await dependencies.magicLinkService.complete(rawBody.token);
          status = 200;
          return createJsonResponse(
            status,
            {
              status: "authenticated",
              session: {
                sessionId: completed.sessionId,
                email: completed.email,
                createdAt: completed.createdAt,
                expiresAt: completed.expiresAt,
              },
            },
            {
              ...buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              "set-cookie": buildSessionCookie(
                dependencies.sessionCookieName,
                completed.sessionId,
                completed.maxAgeSeconds,
                dependencies.sessionCookieSecure,
              ),
            },
          );
        } catch (error) {
          if (error instanceof MagicLinkAuthError) {
            status = error.statusCode;
            return magicLinkErrorResponse(origin, dependencies.corsAllowedOrigins, error);
          }

          throw error;
        }
      }

      let session: AuthSessionRecord | null = null;
      if (isAuthenticatedApiRoute(method, route)) {
        const sessionResolution = await resolveSessionFromCookie(
          cookieHeader,
          dependencies.sessionCookieName,
          dependencies.magicLinkService,
        );
        if (sessionResolution.failure === "missing_cookie") {
          status = 401;
          return createJsonResponse(
            status,
            {
              error: "unauthorized",
              message: "Valid session cookie required.",
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }
        if (sessionResolution.failure === "invalid_session") {
          status = 401;
          return createJsonResponse(
            status,
            {
              error: "unauthorized",
              message: "Session is missing, invalid, or expired.",
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        session = sessionResolution.session;
      }

      if (session) {
        const aclResult = await authorizeProtectedMutation(
          method,
          route,
          session.email,
          dependencies.repository,
        );
        if (!aclResult.allowed) {
          status = aclResult.statusCode;
          return createJsonResponse(
            status,
            aclResult.error,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        if (method === "POST" && route === "/v1/leagues") {
          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = createLeagueRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const mutationResponse = await executeIdempotentMutation({
            repository: dependencies.repository,
            idempotencyKey,
            sessionEmail: session.email,
            method,
            route,
            requestPayload: parsedBody.data,
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
            execute: async () => {
              const createdLeague = await dependencies.repository.createLeague({
                leagueId: parsedBody.data.leagueId,
                name: parsedBody.data.name,
                slug: parsedBody.data.slug ?? null,
                createdByUserId: session.email,
              });

              return createJsonResponse(
                201,
                createdLeague,
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            },
          });

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        if (method === "GET" && route === "/v1/leagues") {
          const leagues = await dependencies.repository.listLeaguesForUser(session.email);
          status = 200;
          return createJsonResponse(
            status,
            {
              leagues,
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const getLeagueMatch = route.match(/^\/v1\/leagues\/([^/]+)$/);
        if (method === "GET" && getLeagueMatch) {
          const leagueId = decodeRouteParam(getLeagueMatch[1]);
          const access = await ensureLeagueAccess(dependencies.repository, leagueId, session.email);
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${leagueId} is required.`,
            );
          }

          const league = await dependencies.repository.getLeague(leagueId);
          if (!league) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `League ${leagueId} was not found.`);
          }

          status = 200;
          return createJsonResponse(
            status,
            league,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const createSeasonMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons$/);
        if (method === "POST" && createSeasonMatch) {
          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = createSeasonRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const mutationResponse = await executeIdempotentMutation({
            repository: dependencies.repository,
            idempotencyKey,
            sessionEmail: session.email,
            method,
            route,
            requestPayload: parsedBody.data,
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
            execute: async () => {
              const createdSeason = await dependencies.repository.createSeason({
                leagueId: decodeRouteParam(createSeasonMatch[1]),
                seasonId: parsedBody.data.seasonId,
                name: parsedBody.data.name,
                slug: parsedBody.data.slug ?? null,
                startsOn: parsedBody.data.startsOn ?? null,
                endsOn: parsedBody.data.endsOn ?? null,
              });
              await ensureSeasonDefaultTeams(dependencies.repository, createdSeason.seasonId);

              return createJsonResponse(
                201,
                createdSeason,
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            },
          });

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        const listSeasonsMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons$/);
        if (method === "GET" && listSeasonsMatch) {
          const leagueId = decodeRouteParam(listSeasonsMatch[1]);
          const access = await ensureLeagueAccess(dependencies.repository, leagueId, session.email);
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${leagueId} is required.`,
            );
          }

          const seasons = await dependencies.repository.listSeasonsForLeague(leagueId);
          status = 200;
          return createJsonResponse(
            status,
            {
              seasons,
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const deleteLeagueMatch = route.match(/^\/v1\/leagues\/([^/]+)$/);
        if (method === "DELETE" && deleteLeagueMatch) {
          const leagueId = decodeRouteParam(deleteLeagueMatch[1]);
          const isAdmin = await ensureLeagueAdmin(dependencies.repository, leagueId, session.email);
          if (!isAdmin) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "admin_required",
              `Admin role is required for league ${leagueId}.`,
            );
          }

          try {
            const deleted = await dependencies.repository.deleteLeague(leagueId);
            if (!deleted) {
              status = 404;
              return notFound(
                origin,
                dependencies.corsAllowedOrigins,
                `League ${leagueId} was not found.`,
              );
            }
          } catch (error) {
            if (error instanceof Error && /Cannot delete league/.test(error.message)) {
              status = 409;
              return conflict(origin, dependencies.corsAllowedOrigins, error.message);
            }

            throw error;
          }

          status = 204;
          return createNoContentResponse(buildCorsHeaders(origin, dependencies.corsAllowedOrigins));
        }

        const createSessionMatch = route.match(/^\/v1\/seasons\/([^/]+)\/sessions$/);
        if (method === "POST" && createSessionMatch) {
          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = createSessionRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const mutationResponse = await executeIdempotentMutation({
            repository: dependencies.repository,
            idempotencyKey,
            sessionEmail: session.email,
            method,
            route,
            requestPayload: parsedBody.data,
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
            execute: async () => {
              const createdSession = await dependencies.repository.createSession({
                seasonId: decodeRouteParam(createSessionMatch[1]),
                sessionId: parsedBody.data.sessionId,
                sessionDate: parsedBody.data.sessionDate,
              });

              return createJsonResponse(
                201,
                createdSession,
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            },
          });

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        const getSeasonMatch = route.match(/^\/v1\/seasons\/([^/]+)$/);
        if (method === "GET" && getSeasonMatch) {
          const seasonId = decodeRouteParam(getSeasonMatch[1]);
          const season = await dependencies.repository.getSeason(seasonId);
          if (!season) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
          }

          const access = await ensureLeagueAccess(
            dependencies.repository,
            season.leagueId,
            session.email,
          );
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${season.leagueId} is required.`,
            );
          }

          status = 200;
          return createJsonResponse(
            status,
            season,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const listSeasonGamesMatch = route.match(/^\/v1\/seasons\/([^/]+)\/games$/);
        if (method === "GET" && listSeasonGamesMatch) {
          const seasonId = decodeRouteParam(listSeasonGamesMatch[1]);
          const season = await dependencies.repository.getSeason(seasonId);
          if (!season) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
          }

          const access = await ensureLeagueAccess(
            dependencies.repository,
            season.leagueId,
            session.email,
          );
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${season.leagueId} is required.`,
            );
          }

          const games = await dependencies.repository.listGamesForSeason(seasonId);
          status = 200;
          return createJsonResponse(
            status,
            {
              games: games.map((game) => buildGameResponse(game)),
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const listSeasonTeamsMatch = route.match(/^\/v1\/seasons\/([^/]+)\/teams$/);
        if (method === "GET" && listSeasonTeamsMatch) {
          const seasonId = decodeRouteParam(listSeasonTeamsMatch[1]);
          const season = await dependencies.repository.getSeason(seasonId);
          if (!season) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
          }

          const access = await ensureLeagueAccess(
            dependencies.repository,
            season.leagueId,
            session.email,
          );
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${season.leagueId} is required.`,
            );
          }

          const teams = await readSeasonTeams(dependencies.repository, season);
          status = 200;
          return createJsonResponse(
            status,
            {
              teams,
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const updateSeasonTeamMatch = route.match(/^\/v1\/seasons\/([^/]+)\/teams\/([^/]+)$/);
        if (method === "PUT" && updateSeasonTeamMatch) {
          const seasonId = decodeRouteParam(updateSeasonTeamMatch[1]);
          const teamId = parseTeamId(decodeRouteParam(updateSeasonTeamMatch[2]));
          if (!teamId) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Team ID must be red, blue, or yellow.");
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = upsertTeamRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          await ensureSeasonDefaultTeams(dependencies.repository, seasonId);
          const team = await dependencies.repository.createTeam({
            seasonId,
            teamId,
            name: parsedBody.data.name,
            color: parsedBody.data.color ?? null,
          });
          status = 200;
          return createJsonResponse(
            status,
            team,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const deleteSeasonMatch = route.match(/^\/v1\/seasons\/([^/]+)$/);
        if (method === "DELETE" && deleteSeasonMatch) {
          const seasonId = decodeRouteParam(deleteSeasonMatch[1]);
          const season = await dependencies.repository.getSeason(seasonId);
          if (!season) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
          }

          const isAdmin = await ensureLeagueAdmin(
            dependencies.repository,
            season.leagueId,
            session.email,
          );
          if (!isAdmin) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "admin_required",
              `Admin role is required for league ${season.leagueId}.`,
            );
          }

          try {
            await dependencies.repository.deleteSeason(seasonId);
          } catch (error) {
            if (error instanceof Error && /Cannot delete season/.test(error.message)) {
              status = 409;
              return conflict(origin, dependencies.corsAllowedOrigins, error.message);
            }

            throw error;
          }

          status = 204;
          return createNoContentResponse(buildCorsHeaders(origin, dependencies.corsAllowedOrigins));
        }

        const createGameMatch = route.match(/^\/v1\/sessions\/([^/]+)\/games$/);
        if (method === "POST" && createGameMatch) {
          if (!aclResult.scope?.leagueId || !aclResult.scope?.seasonId || !aclResult.scope?.sessionId) {
            status = 500;
            return internalError(
              origin,
              dependencies.corsAllowedOrigins,
              "ACL scope should be available for create game route.",
            );
          }

          const leagueId = aclResult.scope.leagueId;
          const seasonId = aclResult.scope.seasonId;
          const sessionId = aclResult.scope.sessionId;

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = createGameRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const mutationResponse = await executeIdempotentMutation({
            repository: dependencies.repository,
            idempotencyKey,
            sessionEmail: session.email,
            method,
            route,
            requestPayload: parsedBody.data,
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
            execute: async () => {
              const createdGame = await dependencies.repository.createGame({
                gameId: parsedBody.data.gameId,
                leagueId,
                seasonId,
                sessionId,
                status: parsedBody.data.status as GameStatus | undefined,
                gameStartTs: parsedBody.data.gameStartTs,
                thirdLengthMinutes: parsedBody.data.thirdLengthMinutes,
              });

              await dependencies.repository.createSessionGame({
                sessionId: createdGame.sessionId,
                gameId: createdGame.gameId,
                gameStartTs: createdGame.gameStartTs,
                leagueId: createdGame.leagueId,
                seasonId: createdGame.seasonId,
              });
              await ensureGameTeamsForGame(dependencies.repository, createdGame);

              return createJsonResponse(
                201,
                buildGameResponse(createdGame),
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            },
          });

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        const getGameMatch = route.match(/^\/v1\/games\/([^/]+)$/);
        if (method === "GET" && getGameMatch) {
          const gameId = decodeRouteParam(getGameMatch[1]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const access = await ensureLeagueAccess(
            dependencies.repository,
            game.leagueId,
            session.email,
          );
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${game.leagueId} is required.`,
            );
          }

          status = 200;
          return createJsonResponse(
            status,
            buildGameResponse(game),
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const startThirdMatch = route.match(/^\/v1\/games\/([^/]+)\/thirds\/([^/]*)\/start$/);
        if (method === "POST" && startThirdMatch) {
          const gameId = decodeRouteParam(startThirdMatch[1]);
          const third = parseThirdRouteParam(decodeRouteParam(startThirdMatch[2]));
          if (!third) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Third must be 1, 2, or 3.");
          }

          let updated;
          try {
            updated = await dependencies.repository.startGameThird({ gameId, third });
          } catch (error) {
            if (error instanceof GameTimerTransitionError) {
              status = 409;
              return timerTransitionConflictResponse(
                origin,
                dependencies.corsAllowedOrigins,
                error,
              );
            }

            throw error;
          }

          if (!updated) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          status = 200;
          return createJsonResponse(
            status,
            buildGameResponse(updated),
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const finishThirdMatch = route.match(/^\/v1\/games\/([^/]+)\/thirds\/([^/]*)\/finish$/);
        if (method === "POST" && finishThirdMatch) {
          const gameId = decodeRouteParam(finishThirdMatch[1]);
          const third = parseThirdRouteParam(decodeRouteParam(finishThirdMatch[2]));
          if (!third) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Third must be 1, 2, or 3.");
          }

          let updated;
          try {
            updated = await dependencies.repository.finishGameThird({ gameId, third });
          } catch (error) {
            if (error instanceof GameTimerTransitionError) {
              status = 409;
              return timerTransitionConflictResponse(
                origin,
                dependencies.corsAllowedOrigins,
                error,
              );
            }

            throw error;
          }

          if (!updated) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          status = 200;
          return createJsonResponse(
            status,
            buildGameResponse(updated),
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const createGoalMatch = route.match(/^\/v1\/games\/([^/]+)\/goals$/);
        if (method === "POST" && createGoalMatch) {
          const gameId = decodeRouteParam(createGoalMatch[1]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = createGoalRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          let mutationResponse: ApiGatewayHttpResponse;
          try {
            mutationResponse = await executeIdempotentMutation({
              repository: dependencies.repository,
              idempotencyKey,
              sessionEmail: session.email,
              method,
              route,
              requestPayload: parsedBody.data,
              origin,
              allowedOrigins: dependencies.corsAllowedOrigins,
              execute: async () => {
                const currentGame = await dependencies.repository.getGame(gameId);
                if (!currentGame) {
                  return notFound(
                    origin,
                    dependencies.corsAllowedOrigins,
                    `Game ${gameId} was not found.`,
                  );
                }

                if (!currentGame.thirds.some((third) => third.startedAt && !third.finishedAt)) {
                  throw new GoalCreationError(
                    "no_active_third",
                    409,
                    "A goal can only be created while a third is running.",
                  );
                }

                await ensureGameTeamsForGame(dependencies.repository, currentGame);
                const result = await dependencies.repository.createGoal({
                  gameId,
                  eventId: buildGoalEventId({
                    idempotencyKey,
                    sessionEmail: session.email,
                    method,
                    route,
                  }),
                  scoringTeamId: parsedBody.data.scoringTeamId,
                  concedingTeamId: parsedBody.data.concedingTeamId,
                  scorerPlayerId: parsedBody.data.scorerPlayerId,
                  assistPlayerIds: parsedBody.data.assistPlayerIds,
                  ownGoal: parsedBody.data.ownGoal,
                });

                if (!result) {
                  return notFound(
                    origin,
                    dependencies.corsAllowedOrigins,
                    `Game ${gameId} was not found.`,
                  );
                }

                return createJsonResponse(
                  201,
                  result,
                  buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                );
              },
            });
          } catch (error) {
            if (error instanceof GoalCreationError) {
              status = error.statusCode;
              return goalCreationErrorResponse(origin, dependencies.corsAllowedOrigins, error);
            }

            throw error;
          }

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        const listGameTeamsMatch = route.match(/^\/v1\/games\/([^/]+)\/teams$/);
        if (method === "GET" && listGameTeamsMatch) {
          const gameId = decodeRouteParam(listGameTeamsMatch[1]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const access = await ensureLeagueAccess(
            dependencies.repository,
            game.leagueId,
            session.email,
          );
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${game.leagueId} is required.`,
            );
          }

          const teams = await readGameTeams(dependencies.repository, game);
          status = 200;
          return createJsonResponse(
            status,
            {
              teams,
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const updateGameTeamMatch = route.match(/^\/v1\/games\/([^/]+)\/teams\/([^/]+)$/);
        if (method === "PUT" && updateGameTeamMatch) {
          const gameId = decodeRouteParam(updateGameTeamMatch[1]);
          const teamId = parseTeamId(decodeRouteParam(updateGameTeamMatch[2]));
          if (!teamId) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Team ID must be red, blue, or yellow.");
          }

          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = upsertTeamRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          await ensureGameTeamsForGame(dependencies.repository, game);
          const team = await dependencies.repository.createGameTeamOverride({
            gameId,
            teamId,
            name: parsedBody.data.name,
            color: parsedBody.data.color ?? null,
          });
          status = 200;
          return createJsonResponse(
            status,
            team,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const listGamePlayersMatch = route.match(/^\/v1\/games\/([^/]+)\/players$/);
        if (method === "GET" && listGamePlayersMatch) {
          const gameId = decodeRouteParam(listGamePlayersMatch[1]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const canManageRoster = await ensureLeagueRole(
            dependencies.repository,
            game.leagueId,
            session.email,
            new Set(["admin", "scorekeeper"]),
          );
          if (!canManageRoster) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "scorekeeper_required",
              `Admin or scorekeeper role is required for league ${game.leagueId}.`,
            );
          }

          const search = getQueryParam(event, "search")?.trim().toLowerCase() ?? "";
          const playerLinks = await dependencies.repository.listGamePlayers(gameId);
          const players = (
            await Promise.all(
              playerLinks.map(async (link) => ({
                link,
                player: await dependencies.repository.getPlayer(link.playerId),
              })),
            )
          )
            .flatMap((entry) => (entry.player ? [{ link: entry.link, player: entry.player }] : []))
            .filter((entry) =>
              search.length === 0 ? true : entry.player.nickname.toLowerCase().includes(search),
            )
            .sort((left, right) => {
              const updatedSort = right.link.updatedAt.localeCompare(left.link.updatedAt);
              if (updatedSort !== 0) {
                return updatedSort;
              }

              return left.player.nickname.localeCompare(right.player.nickname);
            })
            .slice(0, 20)
            .map((entry) => toPublicPlayer(entry.player));
          status = 200;
          return createJsonResponse(
            status,
            {
              players,
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const createGamePlayerMatch = route.match(/^\/v1\/games\/([^/]+)\/players$/);
        if (method === "POST" && createGamePlayerMatch) {
          const gameId = decodeRouteParam(createGamePlayerMatch[1]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = quickCreateGamePlayerRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const playerId = parsedBody.data.playerId ?? `player-${randomUUID()}`;
          const mutationResponse = await executeIdempotentMutation({
            repository: dependencies.repository,
            idempotencyKey,
            sessionEmail: session.email,
            method,
            route,
            requestPayload: parsedBody.data,
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
            execute: async () => {
              const player = await dependencies.repository.createPlayer({
                playerId,
                nickname: parsedBody.data.nickname,
              });
              await dependencies.repository.linkGamePlayer({
                gameId,
                playerId: player.playerId,
              });

              return createJsonResponse(
                201,
                toPublicPlayer(player),
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            },
          });

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        const listGameRosterMatch = route.match(/^\/v1\/games\/([^/]+)\/roster$/);
        if (method === "GET" && listGameRosterMatch) {
          const gameId = decodeRouteParam(listGameRosterMatch[1]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const access = await ensureLeagueAccess(
            dependencies.repository,
            game.leagueId,
            session.email,
          );
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${game.leagueId} is required.`,
            );
          }

          const rosterResponse = await buildRosterResponse(dependencies.repository, game);
          status = 200;
          return createJsonResponse(
            status,
            rosterResponse,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const assignRosterPlayerMatch = route.match(/^\/v1\/games\/([^/]+)\/roster\/([^/]+)$/);
        if (method === "PUT" && assignRosterPlayerMatch) {
          const gameId = decodeRouteParam(assignRosterPlayerMatch[1]);
          const playerId = decodeRouteParam(assignRosterPlayerMatch[2]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = assignRosterPlayerRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const teams = await ensureGameTeamsForGame(dependencies.repository, game);
          if (!teams.some((team) => team.teamId === parsedBody.data.teamId)) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Team ID must be active for this game.");
          }

          const player = await dependencies.repository.getPlayer(playerId);
          if (!player) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Player ${playerId} was not found.`);
          }

          const assignment = await dependencies.repository.assignRosterPlayer({
            gameId,
            teamId: parsedBody.data.teamId,
            playerId,
          });
          status = 200;
          return createJsonResponse(
            status,
            {
              ...assignment,
              player: toPublicPlayer(player),
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const patchGameMatch = route.match(/^\/v1\/games\/([^/]+)$/);
        if (method === "PATCH" && patchGameMatch) {
          const gameId = decodeRouteParam(patchGameMatch[1]);
          const existingGame = await dependencies.repository.getGame(gameId);
          if (!existingGame) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const isAdmin = await ensureLeagueAdmin(
            dependencies.repository,
            existingGame.leagueId,
            session.email,
          );
          if (!isAdmin) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "admin_required",
              `Admin role is required for league ${existingGame.leagueId}.`,
            );
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedPatch = parseGamePatchBody(rawBody);
          if (!parsedPatch) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              "PATCH /v1/games/{gameId} accepts status, gameStartTs, and/or thirdLengthMinutes.",
            );
          }

          let updated;
          try {
            updated = await dependencies.repository.updateGame({
              gameId,
              status: parsedPatch.status,
              gameStartTs: parsedPatch.gameStartTs,
              thirdLengthMinutes: parsedPatch.thirdLengthMinutes,
            });
          } catch (error) {
            if (error instanceof GameTimerTransitionError) {
              status = 409;
              return timerTransitionConflictResponse(
                origin,
                dependencies.corsAllowedOrigins,
                error,
              );
            }

            throw error;
          }

          if (!updated) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          status = 200;
          return createJsonResponse(
            status,
            buildGameResponse(updated),
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const deleteGameMatch = route.match(/^\/v1\/games\/([^/]+)$/);
        if (method === "DELETE" && deleteGameMatch) {
          const gameId = decodeRouteParam(deleteGameMatch[1]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const isAdmin = await ensureLeagueAdmin(
            dependencies.repository,
            game.leagueId,
            session.email,
          );
          if (!isAdmin) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "admin_required",
              `Admin role is required for league ${game.leagueId}.`,
            );
          }

          await dependencies.repository.deleteGame(gameId);
          status = 204;
          return createNoContentResponse(buildCorsHeaders(origin, dependencies.corsAllowedOrigins));
        }

        if (method === "GET" && route === "/v1/auth/session") {
          status = 200;
          return createJsonResponse(
            status,
            {
              authenticated: true,
              session,
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }
      }

      status = 404;
      return createJsonResponse(
        status,
        { error: "Not found" },
        buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
      );
    } catch (error) {
      status = 500;

      logRequestError({
        requestId: details.requestId,
        route: details.route,
        method: details.method,
        status,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      return createJsonResponse(
        status,
        {
          error: "Internal server error",
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
      );
    } finally {
      logRequest({
        requestId: details.requestId,
        route: details.route,
        method: details.method,
        status,
      });
    }
  };
}

const defaultDependencies = createDefaultDependencies();

export const handler = createLambdaCoreHandler(defaultDependencies);
