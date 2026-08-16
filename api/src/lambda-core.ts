import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  buildGameTimerState,
  DEFAULT_TEAMS,
  isThirdLengthMinutes,
  isThirdNumber,
  TEAM_IDS,
  type GameResult,
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
  DEFAULT_SESSION_TTL_SECONDS,
  isAuthenticatedApiRoute,
  resolveSessionCookieSecureFlag,
} from "./auth/session.js";
import {
  claimPlayerRequestSchema,
  acceptLeagueOrganiserInviteRequestSchema,
  createGameRequestSchema,
  createGoalRequestSchema,
  createLeagueOrganiserInviteRequestSchema,
  createLeagueRequestSchema,
  createSeasonRequestSchema,
  createSessionRequestSchema,
  assignRosterPlayerRequestSchema,
  formatSchemaValidationError,
  grantLeagueAccessRequestSchema,
  idempotencyKeyHeaderSchema,
  isJoinCodePathParamValid,
  joinGameRequestSchema,
  normalizeJoinCodePathParam,
  quickCreateGamePlayerRequestSchema,
  undoLastGoalRequestSchema,
  updateGoalRequestSchema,
  upsertTeamRequestSchema,
} from "./contracts/core-write.js";
import {
  GameAlreadyExistsError,
  GameJoinCodeCollisionError,
  GameJoinRegistrationError,
  GameMutationStateError,
  GameTimerTransitionError,
  GoalCorrectionError,
  GoalCreationError,
  LeagueInviteCodeCollisionError,
  LeagueInviteError,
  PlayerClaimError,
  ThreeFcRepository,
} from "./data/repository.js";
import type {
  AcceptLeagueOrganiserInviteResult,
  CreateGoalResult,
  DeleteGoalResult,
  GameStatus,
  LeagueInviteRecord,
  UpdateGoalResult,
} from "./data/types.js";
import { logAuthRateLimit, logMagicLinkEvent, logRequest, logRequestError } from "./logging.js";

const FINISHED_REPAIR_RETRY_DELAYS_MS = [25, 50, 100] as const;
const FINISHED_REPAIR_MAX_ATTEMPTS = 3;

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
  subject?: string;
  createdAt: string;
  expiresAt: string;
};

interface SessionLookup {
  getSession(sessionId: string): Promise<AuthSessionRecord | null>;
}

interface MagicLinkServiceContract extends SessionLookup {
  start(
    email: string,
    options?: { returnTo?: string | null; subject?: string; introLines?: string[] },
  ): Promise<{
    email: string;
    expiresAt: string;
    messageId: string | null;
  }>;
  complete(token: string): Promise<{
    sessionId: string;
    email: string;
    subject?: string;
    createdAt: string;
    expiresAt: string;
    maxAgeSeconds: number;
  }>;
}

function sessionSubject(session: AuthSessionRecord): string {
  return session.subject ?? session.email;
}

function normalizeUserIds(userIds: string | readonly string[]): string[] {
  const values = Array.isArray(userIds) ? userIds : [userIds];
  return values.filter((value, index) => value.trim().length > 0 && values.indexOf(value) === index);
}

function sessionUserIds(session: AuthSessionRecord): string[] {
  return normalizeUserIds([sessionSubject(session), session.email]);
}

interface RepositoryGameRecord {
  gameId: string;
  joinCode: string;
  createRequestHash?: string;
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
  finishedAt: string | null;
  result: GameResult | null;
  createdAt: string;
  updatedAt: string;
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
  getSeasonForLeague(
    leagueId: string,
    seasonId: string,
    options?: { consistentRead?: boolean },
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
  listSeasonsForLeague(
    leagueId: string,
    options?: { consistentRead?: boolean },
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
    leagueId?: string;
    seasonId: string;
    teamId: TeamId;
    name: string;
    color?: string | null;
    createOnly?: boolean;
  }): Promise<{
    seasonId: string;
    teamId: TeamId;
    name: string;
    color: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  listTeamsForSeason(seasonId: string, options?: { consistentRead?: boolean; leagueId?: string }): Promise<
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
    allowFinished?: boolean;
    createOnly?: boolean;
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
  listTeamsForGame(
    gameId: string,
    options?: { consistentRead?: boolean },
  ): Promise<
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
  createSession(input: { leagueId?: string; seasonId: string; sessionId: string; sessionDate: string }): Promise<unknown>;
  getSessionForSeason(
    seasonId: string,
    sessionId: string,
    options?: { leagueId?: string },
  ): Promise<{ seasonId: string; sessionId: string; sessionDate: string } | null>;
  createGame(input: {
    gameId: string;
    joinCode?: string | null;
    createRequestHash?: string | null;
    leagueId: string;
    seasonId: string;
    sessionId: string;
    status?: GameStatus;
    gameStartTs: string;
    thirdLengthMinutes?: ThirdLengthMinutes;
    linkSession?: boolean;
  }): Promise<RepositoryGameRecord>;
  createSessionGame(input: {
    sessionId: string;
    gameId: string;
    gameStartTs: string;
    leagueId: string;
    seasonId: string;
    requireExistingGame?: boolean;
  }): Promise<unknown>;
  listGamesForSeason(
    seasonId: string,
    options?: { leagueId?: string },
  ): Promise<RepositoryGameRecord[]>;
  getGame(
    gameId: string,
    options?: {
      consistentRead?: boolean;
      repairLegacyJoinCode?: boolean;
      expectedLeagueId?: string;
      expectedSeasonId?: string;
    },
  ): Promise<RepositoryGameRecord | null>;
  getGameByJoinCode(joinCode: string): Promise<RepositoryGameRecord | null>;
  joinGameByCode(input: {
    joinCode: string;
    playerId: string;
    nickname: string;
  }): Promise<{
    game: RepositoryGameRecord;
    player: {
      playerId: string;
      nickname: string;
      claimedByUserId: string | null;
      createdAt: string;
      updatedAt: string;
    };
  } | null>;
  updateGame(input: {
    gameId: string;
    status?: "scheduled" | "live" | "finished";
    gameStartTs?: string;
    thirdLengthMinutes?: ThirdLengthMinutes;
  }): Promise<RepositoryGameRecord | null>;
  startGameThird(input: { gameId: string; third: ThirdNumber }): Promise<RepositoryGameRecord | null>;
  finishGameThird(input: { gameId: string; third: ThirdNumber }): Promise<RepositoryGameRecord | null>;
  finishGame(input: { gameId: string }): Promise<RepositoryGameRecord | null>;
  deleteGame(gameId: string): Promise<boolean>;
  deleteSeason(seasonId: string, options?: { leagueId?: string }): Promise<boolean>;
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
  createAndLinkGamePlayer(input: {
    gameId: string;
    playerId: string;
    nickname: string;
    claimedByUserId?: string | null;
    allowFinished?: boolean;
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
  claimPlayer(input: {
    playerId: string;
    userId: string;
  }): Promise<
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
    allowFinished?: boolean;
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
    actorUserId: string;
    scoringTeamId: TeamId | null;
    concedingTeamId: TeamId;
    scorerPlayerId: string;
    assistPlayerIds: string[];
    ownGoal: boolean;
    allowFinished?: boolean;
  }): Promise<CreateGoalResult | null>;
  listGoalEvents(gameId: string): Promise<CreateGoalResult["timeline"]>;
  updateGoal(input: {
    gameId: string;
    eventId: string;
    actorUserId: string;
    operationId?: string | null;
    operationRequestHash?: string | null;
    allowFinished?: boolean;
    scoringTeamId?: TeamId | null;
    concedingTeamId?: TeamId;
    scorerPlayerId?: string;
    assistPlayerIds?: string[];
    ownGoal?: boolean;
  }): Promise<UpdateGoalResult | null>;
  deleteGoal(input: {
    gameId: string;
    eventId: string;
    actorUserId: string;
    operationId?: string | null;
    operationRequestHash?: string | null;
    allowFinished?: boolean;
  }): Promise<DeleteGoalResult | null>;
  undoLastGoal(input: {
    gameId: string;
    actorUserId: string;
    operationId?: string | null;
    operationRequestHash?: string | null;
    allowFinished?: boolean;
    expectedEventId: string;
  }): Promise<DeleteGoalResult | null>;
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
  grantLeagueAccess(input: {
    leagueId: string;
    userId: string;
    role: "admin" | "scorekeeper" | "viewer";
    grantedByUserId: string;
  }): Promise<{
    leagueId: string;
    userId: string;
    role: "admin" | "scorekeeper" | "viewer";
    grantedByUserId: string;
    createdAt: string;
    updatedAt: string;
  }>;
  createLeagueOrganiserInvite(input: {
    leagueId: string;
    email?: string | null;
    createdByUserId: string;
    inviteCode?: string | null;
    kind?: LeagueInviteRecord["kind"];
  }): Promise<LeagueInviteRecord>;
  getLeagueOrganiserInvite(inviteCode: string): Promise<LeagueInviteRecord | null>;
  acceptLeagueOrganiserInvite(input: {
    inviteCode: string;
    userId: string;
    email: string;
  }): Promise<AcceptLeagueOrganiserInviteResult | null>;
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
  completeIdempotencyRecord(input: {
    scope: string;
    key: string;
    requestHash: string;
    responseStatusCode: number;
    responseBody: string;
    expectedResponseStatusCode: number;
    expectedResponseBody: string;
    expectedUpdatedAt?: string;
  }): Promise<boolean>;
  deleteIdempotencyRecord(input: {
    scope: string;
    key: string;
    requestHash: string;
    responseStatusCode: number;
    responseBody: string;
    updatedAt?: string;
  }): Promise<boolean>;
}

type LeagueListRecord = Awaited<ReturnType<RepositoryContract["listLeaguesForUser"]>>[number];

async function listLeaguesForSession(
  repository: Pick<RepositoryContract, "listLeaguesForUser">,
  session: AuthSessionRecord,
): Promise<LeagueListRecord[]> {
  const leaguesById = new Map<string, LeagueListRecord>();
  for (const userId of sessionUserIds(session)) {
    const leagues = await repository.listLeaguesForUser(userId);
    for (const league of leagues) {
      leaguesById.set(league.leagueId, league);
    }
  }
  return [...leaguesById.values()];
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
  appBaseUrl: string;
  publicAppBaseUrl?: string;
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
  userIds: string | readonly string[],
): Promise<{ allowed: boolean; role: "admin" | "scorekeeper" | "viewer" | null }> {
  for (const userId of normalizeUserIds(userIds)) {
    const access = await repository.getLeagueAccess(leagueId, userId);
    if (access) {
      return { allowed: true, role: access.role };
    }
  }

  return { allowed: false, role: null };
}

async function ensureLeagueAdmin(
  repository: RepositoryContract,
  leagueId: string,
  userIds: string | readonly string[],
): Promise<boolean> {
  for (const userId of normalizeUserIds(userIds)) {
    const access = await repository.getLeagueAccess(leagueId, userId);
    if (access?.role === "admin") {
      return true;
    }
  }
  return false;
}

async function ensureLeagueRole(
  repository: RepositoryContract,
  leagueId: string,
  userIds: string | readonly string[],
  allowedRoles: ReadonlySet<"admin" | "scorekeeper" | "viewer">,
): Promise<boolean> {
  for (const userId of normalizeUserIds(userIds)) {
    const access = await repository.getLeagueAccess(leagueId, userId);
    if (access && allowedRoles.has(access.role)) {
      return true;
    }
  }
  return false;
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

function buildGameResponse(game: RepositoryGameRecord) {
  const { createRequestHash: _createRequestHash, ...publicGame } = game;
  return {
    ...publicGame,
    timer: buildGameTimerState({
      thirdLengthMinutes: game.thirdLengthMinutes,
      thirds: game.thirds,
    }),
  };
}

function existingGameMatchesCreateRequest(input: {
  game: RepositoryGameRecord;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  createRequestHash: string;
  request: {
    gameId: string;
  };
}): boolean {
  return (
    input.game.gameId === input.request.gameId &&
    input.game.createRequestHash === input.createRequestHash &&
    input.game.leagueId === input.leagueId &&
    input.game.seasonId === input.seasonId &&
    input.game.sessionId === input.sessionId
  );
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

function goalCorrectionErrorResponse(
  origin: string | undefined,
  allowedOrigins: string[],
  error: GoalCorrectionError,
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

function finishedGameDeleteConflictResponse(
  origin: string | undefined,
  allowedOrigins: string[],
  gameId: string,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "conflict",
      code: "game_finished",
      message: `Game ${gameId} is finished. Finished games cannot be deleted.`,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function joinCodeRequiredResponse(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    400,
    {
      error: "bad_request",
      code: "join_code_required",
      message: "Join code is required.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function joinCodeInvalidFormatResponse(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    400,
    {
      error: "bad_request",
      code: "join_code_invalid",
      message: "Join code must be 8 uppercase non-ambiguous letters or digits.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function joinCodeMalformedResponse(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    400,
    {
      error: "bad_request",
      code: "join_code_invalid",
      message: "Join code must be URL encoded correctly.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function invalidJoinCodeResponse(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    404,
    {
      error: "not_found",
      code: "invalid_join_code",
      message: "Join code was not found.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function finishedGameJoinConflictResponse(
  origin: string | undefined,
  allowedOrigins: string[],
  message: string,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "conflict",
      code: "game_finished",
      message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function joinStateChangedResponse(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "conflict",
      code: "join_state_changed",
      message: "Game join state changed while registering this player. Reload and try again.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function hasNonPersistedPublicJoinConflictCode(payload: unknown): boolean {
  const code = typeof payload === "object" && payload !== null && "code" in payload
    ? (payload as { code?: unknown }).code
    : null;
  return (
    code === "join_state_changed" ||
    code === "game_finished"
  );
}

function shouldPersistPublicJoinResponse(response: ApiGatewayHttpResponse): boolean {
  if (response.statusCode === 404) {
    return false;
  }

  if (response.statusCode !== 409) {
    return true;
  }

  try {
    return !hasNonPersistedPublicJoinConflictCode(JSON.parse(response.body));
  } catch {
    return true;
  }
}

function gameAlreadyExistsConflictResponse(
  origin: string | undefined,
  allowedOrigins: string[],
  gameId: string,
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "conflict",
      code: "game_exists",
      message: `Game ${gameId} already exists.`,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function gameJoinCodeCollisionConflictResponse(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "conflict",
      code: "join_code_collision",
      message: "Join code is already assigned to another game.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

async function buildFinishedGameMutationBlock(input: {
  repository: RepositoryContract;
  game: Pick<RepositoryGameRecord, "gameId" | "leagueId" | "status">;
  sessionUserIds: string | readonly string[];
  origin: string | undefined;
  allowedOrigins: string[];
}): Promise<ApiGatewayHttpResponse | null> {
  if (input.game.status !== "finished") {
    return null;
  }

  const isAdmin = await ensureLeagueAdmin(
    input.repository,
    input.game.leagueId,
    input.sessionUserIds,
  );
  if (isAdmin) {
    return null;
  }

  return createJsonResponse(
    409,
    {
      error: "conflict",
      code: "game_finished",
      message: `Game ${input.game.gameId} is finished. Admin role is required to mutate finished games.`,
    },
    buildCorsHeaders(input.origin, input.allowedOrigins),
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

async function toGamePlayerForLeagueRole(input: {
  repository: RepositoryContract;
  player: {
    playerId: string;
    nickname: string;
    claimedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  leagueId: string;
  callerRole: "admin" | "scorekeeper" | "viewer" | null;
}) {
  const publicPlayer = toPublicPlayer(input.player);
  if (input.callerRole !== "admin" || !input.player.claimedByUserId) {
    return publicPlayer;
  }

  const access = await input.repository.getLeagueAccess(input.leagueId, input.player.claimedByUserId);
  return {
    ...publicPlayer,
    access: {
      userId: input.player.claimedByUserId,
      role: access?.role ?? null,
    },
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

async function ensureSeasonDefaultTeams(
  repository: RepositoryContract,
  seasonId: string,
  options: { leagueId?: string } = {},
) {
  const existingTeams = await repository.listTeamsForSeason(seasonId, {
    consistentRead: true,
    leagueId: options.leagueId,
  });
  const teamsById = new Map(existingTeams.map((team) => [team.teamId, team]));

  for (const defaultTeam of DEFAULT_TEAMS) {
    if (teamsById.has(defaultTeam.teamId)) {
      continue;
    }

    const createdTeam = await repository.createTeam({
      leagueId: options.leagueId,
      seasonId,
      teamId: defaultTeam.teamId,
      name: defaultTeam.name,
      color: defaultTeam.color,
      createOnly: true,
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
  options: { allowFinished?: boolean; leagueId?: string } = {},
) {
  const seasonTeams = await ensureSeasonDefaultTeams(repository, game.seasonId, {
    leagueId: options.leagueId,
  });
  const existingGameTeams = await repository.listTeamsForGame(game.gameId, {
    consistentRead: true,
  });
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
      allowFinished: options.allowFinished,
      createOnly: true,
    });
    gameTeamsById.set(gameTeam.teamId, gameTeam);
  }

  return sortTeams([...gameTeamsById.values()]);
}

function isCompleteFinishedGame(game: RepositoryGameRecord | null): game is RepositoryGameRecord {
  const resultTeams = game?.result?.teams ?? [];
  const resultTeamIds = new Set(resultTeams.map((team) => team.teamId));
  return (
    game?.status === "finished" &&
    Boolean(game.finishedAt && game.result) &&
    resultTeams.length === TEAM_IDS.length &&
    TEAM_IDS.every((teamId) => resultTeamIds.has(teamId))
  );
}

function isRetryableFinishedRepairConflict(error: unknown): boolean {
  return (
    error instanceof GameMutationStateError ||
    (error instanceof GameTimerTransitionError && error.code === "game_state_changed")
  );
}

async function waitForFinishedRepairCompletion(input: {
  repository: RepositoryContract;
  gameId: string;
}): Promise<RepositoryGameRecord | null> {
  let latest: RepositoryGameRecord | null = null;

  for (const delayMs of FINISHED_REPAIR_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    latest = await input.repository.getGame(input.gameId, {
      consistentRead: true,
    });
    if (!latest || latest.status !== "finished" || isCompleteFinishedGame(latest)) {
      return latest;
    }
  }

  return latest;
}

async function recoverFinishedGameForFinishRoute(input: {
  repository: RepositoryContract;
  gameId: string;
  origin: string | undefined;
  allowedOrigins: string[];
}): Promise<ApiGatewayHttpResponse | null> {
  const current = await input.repository.getGame(input.gameId, {
    consistentRead: true,
  });
  if (!current || current.status !== "finished") {
    return null;
  }

  if (isCompleteFinishedGame(current)) {
    return createJsonResponse(
      200,
      buildGameResponse(current),
      buildCorsHeaders(input.origin, input.allowedOrigins),
    );
  }

  let repaired: RepositoryGameRecord | null = current;
  for (let attempt = 0; attempt < FINISHED_REPAIR_MAX_ATTEMPTS; attempt += 1) {
    try {
      await ensureGameTeamsForGame(input.repository, current, { allowFinished: true });
      repaired = await input.repository.finishGame({ gameId: input.gameId });
      if (isCompleteFinishedGame(repaired)) {
        break;
      }
    } catch (error) {
      if (!isRetryableFinishedRepairConflict(error)) {
        throw error;
      }

      repaired = await waitForFinishedRepairCompletion({
        repository: input.repository,
        gameId: input.gameId,
      });
      if (!repaired || repaired.status !== "finished" || isCompleteFinishedGame(repaired)) {
        break;
      }
    }
  }

  if (!isCompleteFinishedGame(repaired)) {
    return null;
  }

  return createJsonResponse(
    200,
    buildGameResponse(repaired),
    buildCorsHeaders(input.origin, input.allowedOrigins),
  );
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

function hashDiagnosticValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function hashMagicLinkTokenId(rawToken: string): string {
  const tokenId = rawToken.trim().split(".")[0]?.trim() ?? "";
  return hashDiagnosticValue(tokenId || "missing-token-id");
}

function hashEmailDiagnostic(email: string): string {
  return hashDiagnosticValue(normalizeMagicLinkEmail(email));
}

function parseOptionalIdempotencyKey(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = idempotencyKeyHeaderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function buildKeyedRecoveryRequestHash(input: {
  scope: string;
  idempotencyKey: string;
  payload: unknown;
}): string {
  return buildIdempotencyRequestHash(input.scope, {
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  });
}

function buildCreateGameRecoveryRequestHash(input: {
  idempotencyKey: string | undefined;
  sessionEmail: string;
  method: string;
  route: string;
  payload: unknown;
}): string | null {
  const parsedIdempotencyKey = parseOptionalIdempotencyKey(input.idempotencyKey);
  if (!parsedIdempotencyKey) {
    return null;
  }

  return buildKeyedRecoveryRequestHash({
    scope: buildIdempotencyScope(input.sessionEmail, input.method, input.route),
    idempotencyKey: parsedIdempotencyKey,
    payload: input.payload,
  });
}

async function createGameMutationResponse(input: {
  dependencies: CoreHandlerDependencies;
  idempotencyKey: string | undefined;
  session: AuthSessionRecord;
  method: string;
  route: string;
  rawBody: Record<string, unknown>;
  origin: string | undefined;
  scope: { leagueId: string; seasonId: string; sessionId: string };
}): Promise<ApiGatewayHttpResponse> {
  const parsedBody = createGameRequestSchema.safeParse(input.rawBody);
  if (!parsedBody.success) {
    return badRequest(
      input.origin,
      input.dependencies.corsAllowedOrigins,
      formatSchemaValidationError(parsedBody.error),
    );
  }

  const createRequestHash = buildCreateGameRecoveryRequestHash({
    idempotencyKey: input.idempotencyKey,
    sessionEmail: input.session.email,
    method: input.method,
    route: input.route,
    payload: parsedBody.data,
  });

  try {
    return await executeIdempotentMutation({
      repository: input.dependencies.repository,
      idempotencyKey: input.idempotencyKey,
      sessionEmail: input.session.email,
      method: input.method,
      route: input.route,
      requestPayload: parsedBody.data,
      origin: input.origin,
      allowedOrigins: input.dependencies.corsAllowedOrigins,
      execute: async () => {
        let createdGame: RepositoryGameRecord;
        let recoveredExistingGame = false;
        try {
          createdGame = await input.dependencies.repository.createGame({
            gameId: parsedBody.data.gameId,
            createRequestHash,
            leagueId: input.scope.leagueId,
            seasonId: input.scope.seasonId,
            sessionId: input.scope.sessionId,
            status: parsedBody.data.status as GameStatus | undefined,
            gameStartTs: parsedBody.data.gameStartTs,
            thirdLengthMinutes: parsedBody.data.thirdLengthMinutes,
            linkSession: true,
          });
        } catch (error) {
          if (!(error instanceof GameAlreadyExistsError)) {
            throw error;
          }

          const replayResponse = await replayStoredIdempotencyMutation({
            repository: input.dependencies.repository,
            idempotencyKey: input.idempotencyKey,
            sessionEmail: input.session.email,
            method: input.method,
            route: input.route,
            requestPayload: parsedBody.data,
            origin: input.origin,
            allowedOrigins: input.dependencies.corsAllowedOrigins,
          });
          if (replayResponse) {
            return replayResponse;
          }
          if (!input.idempotencyKey || !createRequestHash) {
            throw error;
          }

          const existingGame = await input.dependencies.repository.getGame(parsedBody.data.gameId);
          if (
            !existingGame ||
            !existingGameMatchesCreateRequest({
              game: existingGame,
              leagueId: input.scope.leagueId,
              seasonId: input.scope.seasonId,
              sessionId: input.scope.sessionId,
              createRequestHash,
              request: parsedBody.data,
            })
          ) {
            throw error;
          }

          createdGame = existingGame;
          recoveredExistingGame = true;
        }

        if (recoveredExistingGame) {
          await input.dependencies.repository.createSessionGame({
            sessionId: createdGame.sessionId,
            gameId: createdGame.gameId,
            gameStartTs: createdGame.gameStartTs,
            leagueId: createdGame.leagueId,
            seasonId: createdGame.seasonId,
            requireExistingGame: true,
          });
        }
        await ensureGameTeamsForGame(input.dependencies.repository, createdGame, {
          leagueId: input.scope.leagueId,
        });

        return createJsonResponse(
          201,
          buildGameResponse(createdGame),
          buildCorsHeaders(input.origin, input.dependencies.corsAllowedOrigins),
        );
      },
    });
  } catch (error) {
    if (error instanceof GameAlreadyExistsError) {
      const replayResponse = await replayStoredIdempotencyMutation({
        repository: input.dependencies.repository,
        idempotencyKey: input.idempotencyKey,
        sessionEmail: input.session.email,
        method: input.method,
        route: input.route,
        requestPayload: parsedBody.data,
        origin: input.origin,
        allowedOrigins: input.dependencies.corsAllowedOrigins,
      });
      if (replayResponse) {
        return replayResponse;
      }

      return gameAlreadyExistsConflictResponse(
        input.origin,
        input.dependencies.corsAllowedOrigins,
        parsedBody.data.gameId,
      );
    }
    if (error instanceof GameJoinCodeCollisionError) {
      const replayResponse = await replayStoredIdempotencyMutation({
        repository: input.dependencies.repository,
        idempotencyKey: input.idempotencyKey,
        sessionEmail: input.session.email,
        method: input.method,
        route: input.route,
        requestPayload: parsedBody.data,
        origin: input.origin,
        allowedOrigins: input.dependencies.corsAllowedOrigins,
      });
      if (replayResponse) {
        return replayResponse;
      }

      return gameJoinCodeCollisionConflictResponse(
        input.origin,
        input.dependencies.corsAllowedOrigins,
      );
    }
    if (error instanceof GameMutationStateError) {
      return conflict(input.origin, input.dependencies.corsAllowedOrigins, error.message);
    }

    throw error;
  }
}

function buildPublicJoinPlayerId(joinCode: string, idempotencyKey: string): string {
  const fingerprint = createHash("sha256")
    .update(`public-join:${joinCode}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return `player-join-${fingerprint}`;
}

const PUBLIC_JOIN_IDEMPOTENCY_SUBJECT = "public-join";
const IDEMPOTENCY_PENDING_STATUS_CODE = 202;
const IDEMPOTENCY_PENDING_STALE_AFTER_MS = 2 * 60 * 1000;
const IDEMPOTENCY_EXTERNAL_SIDE_EFFECT_EMAIL_DELIVERY_STARTED = "email_delivery_started";
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_CODE_LENGTH = 8;

interface PendingIdempotencyBody {
  idempotencyState?: unknown;
  reservationId?: unknown;
  reservedAtEpochMs?: unknown;
  externalSideEffect?: unknown;
  externalSideEffectStartedAtEpochMs?: unknown;
}

interface ReservedIdempotencyMutationContext {
  markExternalSideEffectStarted: () => Promise<void>;
}

class ReservedIdempotencyReservationChangedError extends Error {
  constructor() {
    super("Idempotency reservation changed before external side effect could be marked.");
  }
}

function parsePendingIdempotencyBody(responseBody: string): PendingIdempotencyBody | null {
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as PendingIdempotencyBody : null;
  } catch {
    return null;
  }
}

function buildPendingIdempotencyBody(input: {
  reservationId?: string;
  reservedAtEpochMs?: number;
  externalSideEffect?: typeof IDEMPOTENCY_EXTERNAL_SIDE_EFFECT_EMAIL_DELIVERY_STARTED;
  externalSideEffectStartedAtEpochMs?: number;
} = {}): string {
  const body: PendingIdempotencyBody = {
    idempotencyState: "pending",
    reservationId: input.reservationId ?? randomUUID(),
    reservedAtEpochMs: input.reservedAtEpochMs ?? Date.now(),
  };

  if (input.externalSideEffect === IDEMPOTENCY_EXTERNAL_SIDE_EFFECT_EMAIL_DELIVERY_STARTED) {
    body.externalSideEffect = IDEMPOTENCY_EXTERNAL_SIDE_EFFECT_EMAIL_DELIVERY_STARTED;
    body.externalSideEffectStartedAtEpochMs =
      input.externalSideEffectStartedAtEpochMs ?? Date.now();
  }

  return JSON.stringify(body);
}

function buildAppUrl(appBaseUrl: string, path: string): string {
  const normalizedBase = appBaseUrl.endsWith("/") ? appBaseUrl.slice(0, -1) : appBaseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function buildOrganiserInvitePath(inviteCode: string): string {
  return `/invites?code=${encodeURIComponent(inviteCode)}`;
}

type OrganiserInviteEmailDeliveryResponse =
  | { status: "sent"; email: string; expiresAt: string; messageId: string | null }
  | { status: "unknown"; email: string; expiresAt: null; messageId: null; message: string };

function buildOrganiserInviteResponse(
  invite: LeagueInviteRecord,
  appBaseUrl: string,
  emailDelivery: OrganiserInviteEmailDeliveryResponse | null = null,
): Record<string, unknown> {
  const invitePath = buildOrganiserInvitePath(invite.inviteCode);
  return {
    invite,
    inviteCode: invite.inviteCode,
    inviteLink: buildAppUrl(appBaseUrl, invitePath),
    emailDelivery,
  };
}

function buildOrganiserInviteIdempotencyCode(input: {
  sessionEmail: string;
  method: string;
  route: string;
  idempotencyKey: string | undefined;
}): string | null {
  const parsedIdempotencyKey = input.idempotencyKey
    ? idempotencyKeyHeaderSchema.safeParse(input.idempotencyKey)
    : null;

  if (!parsedIdempotencyKey?.success) {
    return null;
  }

  const scope = buildIdempotencyScope(input.sessionEmail, input.method, input.route);
  const digest = createHash("sha256")
    .update(`organiser-invite:${scope}:${parsedIdempotencyKey.data}`)
    .digest();
  let inviteCode = "";
  for (let index = 0; index < INVITE_CODE_LENGTH; index += 1) {
    inviteCode += INVITE_CODE_ALPHABET[digest[index] % INVITE_CODE_ALPHABET.length];
  }
  return inviteCode;
}

function isMatchingRecoveredOrganiserInvite(input: {
  invite: LeagueInviteRecord;
  leagueId: string;
  email: string | null;
  createdByUserId: string;
  kind: LeagueInviteRecord["kind"];
}): boolean {
  return (
    input.invite.leagueId === input.leagueId &&
    input.invite.kind === input.kind &&
    input.invite.role === "admin" &&
    input.invite.email === input.email &&
    input.invite.createdByUserId === input.createdByUserId
  );
}

async function createOrRecoverLeagueOrganiserInvite(input: {
  repository: RepositoryContract;
  leagueId: string;
  email: string | null;
  createdByUserId: string;
  inviteCode: string | null;
  kind: LeagueInviteRecord["kind"];
}): Promise<LeagueInviteRecord> {
  try {
    return await input.repository.createLeagueOrganiserInvite({
      leagueId: input.leagueId,
      email: input.email,
      createdByUserId: input.createdByUserId,
      inviteCode: input.inviteCode,
      kind: input.kind,
    });
  } catch (error) {
    if (!(error instanceof LeagueInviteCodeCollisionError) || !input.inviteCode) {
      throw error;
    }

    const existingInvite = await input.repository.getLeagueOrganiserInvite(input.inviteCode);
    if (
      existingInvite &&
      isMatchingRecoveredOrganiserInvite({
        invite: existingInvite,
        leagueId: input.leagueId,
        email: input.email,
        createdByUserId: input.createdByUserId,
        kind: input.kind,
      })
    ) {
      return existingInvite;
    }

    throw error;
  }
}

function leagueInviteErrorResponse(
  origin: string | undefined,
  allowedOrigins: string[],
  error: LeagueInviteError,
): ApiGatewayHttpResponse {
  const responseError = error.statusCode === 404 ? "not_found" : error.statusCode === 403 ? "forbidden" : "conflict";
  return createJsonResponse(
    error.statusCode,
    {
      error: responseError,
      code: error.code,
      message: error.message,
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
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

function buildGoalCorrectionOperation(input: {
  idempotencyKey: string | undefined;
  sessionEmail: string;
  method: string;
  route: string;
  requestPayload: unknown;
}): { operationId: string; operationRequestHash: string } | null {
  const parsedIdempotencyKey = input.idempotencyKey
    ? idempotencyKeyHeaderSchema.safeParse(input.idempotencyKey)
    : null;

  if (!parsedIdempotencyKey?.success) {
    return null;
  }

  const scope = buildIdempotencyScope(input.sessionEmail, input.method, input.route);
  const digest = createHash("sha256")
    .update(`${scope}:${parsedIdempotencyKey.data}`)
    .digest("hex")
    .slice(0, 32);

  return {
    operationId: `goal-correction-idem-${digest}`,
    operationRequestHash: buildIdempotencyRequestHash(scope, input.requestPayload),
  };
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

function idempotencyInProgressResponse(
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    409,
    {
      error: "idempotency_in_progress",
      message: "A request with this idempotency key is still in progress. Retry shortly.",
    },
    buildCorsHeaders(origin, allowedOrigins),
  );
}

function isPendingIdempotencyRecord(record: { responseStatusCode: number; responseBody: string }): boolean {
  if (record.responseStatusCode !== IDEMPOTENCY_PENDING_STATUS_CODE) {
    return false;
  }

  return parsePendingIdempotencyBody(record.responseBody)?.idempotencyState === "pending";
}

function pendingIdempotencyReservedAtEpochMs(record: {
  responseBody: string;
  createdAt?: string;
}): number | null {
  const parsed = parsePendingIdempotencyBody(record.responseBody);
  if (
    typeof parsed?.reservedAtEpochMs === "number" &&
    Number.isFinite(parsed.reservedAtEpochMs)
  ) {
    return parsed.reservedAtEpochMs;
  }

  if (record.createdAt) {
    const createdAtEpochMs = Date.parse(record.createdAt);
    if (Number.isFinite(createdAtEpochMs)) {
      return createdAtEpochMs;
    }
  }

  return null;
}

function pendingIdempotencyBodyHasExternalSideEffectStarted(responseBody: string): boolean {
  return parsePendingIdempotencyBody(responseBody)?.externalSideEffect ===
    IDEMPOTENCY_EXTERNAL_SIDE_EFFECT_EMAIL_DELIVERY_STARTED;
}

function isStalePendingIdempotencyRecord(record: {
  responseStatusCode: number;
  responseBody: string;
  createdAt?: string;
}): boolean {
  if (!isPendingIdempotencyRecord(record)) {
    return false;
  }

  const reservedAtEpochMs = pendingIdempotencyReservedAtEpochMs(record);
  return reservedAtEpochMs !== null && Date.now() - reservedAtEpochMs > IDEMPOTENCY_PENDING_STALE_AFTER_MS;
}

function isRecoverableStalePendingIdempotencyRecord(record: {
  responseStatusCode: number;
  responseBody: string;
  createdAt?: string;
}): boolean {
  return (
    isStalePendingIdempotencyRecord(record) &&
    !pendingIdempotencyBodyHasExternalSideEffectStarted(record.responseBody)
  );
}

function isRetryableReservedIdempotencyResponse(response: ApiGatewayHttpResponse): boolean {
  return response.statusCode === 429 || response.statusCode >= 500;
}

function replayIdempotencyRecord(
  record: { responseStatusCode: number; responseBody: string },
  origin: string | undefined,
  allowedOrigins: string[],
): ApiGatewayHttpResponse {
  return createJsonResponse(
    record.responseStatusCode,
    parseStoredIdempotencyResponseBody(record.responseBody),
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
  shouldPersistResponse?: (response: ApiGatewayHttpResponse) => boolean;
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

    if (isPendingIdempotencyRecord(existingRecord)) {
      if (
        isStalePendingIdempotencyRecord(existingRecord) &&
        await input.repository.deleteIdempotencyRecord({
          scope,
          key: idempotencyKey,
          requestHash,
          responseStatusCode: existingRecord.responseStatusCode,
          responseBody: existingRecord.responseBody,
          updatedAt: existingRecord.updatedAt,
        })
      ) {
        // Continue as a new mutation after clearing stale pending state.
      } else {
        const replay = await replayStoredIdempotencyMutation(input);
        return replay ?? idempotencyInProgressResponse(input.origin, input.allowedOrigins);
      }
    } else {
      return replayIdempotencyRecord(existingRecord, input.origin, input.allowedOrigins);
    }
  }

  const mutationResponse = await input.execute();
  if (input.shouldPersistResponse && !input.shouldPersistResponse(mutationResponse)) {
    return mutationResponse;
  }

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

  if (isPendingIdempotencyRecord(raceRecord)) {
    if (
      isStalePendingIdempotencyRecord(raceRecord) &&
      await input.repository.deleteIdempotencyRecord({
        scope,
        key: idempotencyKey,
        requestHash,
        responseStatusCode: raceRecord.responseStatusCode,
        responseBody: raceRecord.responseBody,
        updatedAt: raceRecord.updatedAt,
      })
    ) {
      return mutationResponse;
    }

    const replay = await replayStoredIdempotencyMutation(input);
    return replay ?? idempotencyInProgressResponse(input.origin, input.allowedOrigins);
  }

  return replayIdempotencyRecord(raceRecord, input.origin, input.allowedOrigins);
}

async function executeReservedIdempotentMutation(input: {
  repository: RepositoryContract;
  idempotencyKey: string | undefined;
  sessionEmail: string;
  method: string;
  route: string;
  requestPayload: unknown;
  origin: string | undefined;
  allowedOrigins: string[];
  execute: (context: ReservedIdempotencyMutationContext) => Promise<ApiGatewayHttpResponse>;
  recoverStartedExternalSideEffect?: (record: {
    scope: string;
    key: string;
    requestHash: string;
    responseStatusCode: number;
    responseBody: string;
    updatedAt: string;
  }) => Promise<ApiGatewayHttpResponse | null>;
}): Promise<ApiGatewayHttpResponse> {
  if (!input.idempotencyKey) {
    return input.execute({
      markExternalSideEffectStarted: async () => undefined,
    });
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
  let reserved = false;
  let reservedResponseBody: string | null = null;

  for (let reserveAttempt = 0; reserveAttempt < 2; reserveAttempt += 1) {
    const pendingResponseBody = buildPendingIdempotencyBody();
    reserved = await input.repository.createIdempotencyRecord({
      scope,
      key: idempotencyKey,
      requestHash,
      responseStatusCode: IDEMPOTENCY_PENDING_STATUS_CODE,
      responseBody: pendingResponseBody,
    });

    if (reserved) {
      reservedResponseBody = pendingResponseBody;
      break;
    }

    const existingRecord = await input.repository.getIdempotencyRecord(scope, idempotencyKey);
    if (!existingRecord) {
      continue;
    }

    if (existingRecord.requestHash !== requestHash) {
      return idempotencyConflictResponse(input.origin, input.allowedOrigins);
    }

    if (
      isPendingIdempotencyRecord(existingRecord) &&
      isRecoverableStalePendingIdempotencyRecord(existingRecord) &&
      await input.repository.deleteIdempotencyRecord({
        scope,
        key: idempotencyKey,
        requestHash,
        responseStatusCode: existingRecord.responseStatusCode,
        responseBody: existingRecord.responseBody,
        updatedAt: existingRecord.updatedAt,
      })
    ) {
      continue;
    }

    if (isPendingIdempotencyRecord(existingRecord)) {
      if (
        input.recoverStartedExternalSideEffect &&
        isStalePendingIdempotencyRecord(existingRecord) &&
        pendingIdempotencyBodyHasExternalSideEffectStarted(existingRecord.responseBody)
      ) {
        const recovered = await input.recoverStartedExternalSideEffect(existingRecord);
        if (recovered) {
          const completed = await input.repository.completeIdempotencyRecord({
            scope,
            key: idempotencyKey,
            requestHash,
            responseStatusCode: recovered.statusCode,
            responseBody: recovered.body,
            expectedResponseStatusCode: existingRecord.responseStatusCode,
            expectedResponseBody: existingRecord.responseBody,
            expectedUpdatedAt: existingRecord.updatedAt,
          });
          if (completed) {
            return recovered;
          }

          const replayAfterRecoveryRace = await replayStoredIdempotencyMutation(input);
          return replayAfterRecoveryRace ?? idempotencyInProgressResponse(
            input.origin,
            input.allowedOrigins,
          );
        }
      }

      const replay = await replayStoredIdempotencyMutation(input);
      if (replay) {
        return replay;
      }

      return idempotencyInProgressResponse(input.origin, input.allowedOrigins);
    }

    return replayIdempotencyRecord(existingRecord, input.origin, input.allowedOrigins);
  }

  if (!reserved) {
    return idempotencyInProgressResponse(input.origin, input.allowedOrigins);
  }
  if (!reservedResponseBody) {
    return idempotencyInProgressResponse(input.origin, input.allowedOrigins);
  }
  let ownedReservationBody = reservedResponseBody;

  const markExternalSideEffectStarted = async (): Promise<void> => {
    const parsed = parsePendingIdempotencyBody(ownedReservationBody);
    const markedResponseBody = buildPendingIdempotencyBody({
      reservationId: typeof parsed?.reservationId === "string" ? parsed.reservationId : undefined,
      reservedAtEpochMs: typeof parsed?.reservedAtEpochMs === "number" ? parsed.reservedAtEpochMs : undefined,
      externalSideEffect: IDEMPOTENCY_EXTERNAL_SIDE_EFFECT_EMAIL_DELIVERY_STARTED,
    });
    const marked = await input.repository.completeIdempotencyRecord({
      scope,
      key: idempotencyKey,
      requestHash,
      responseStatusCode: IDEMPOTENCY_PENDING_STATUS_CODE,
      responseBody: markedResponseBody,
      expectedResponseStatusCode: IDEMPOTENCY_PENDING_STATUS_CODE,
      expectedResponseBody: ownedReservationBody,
    });
    if (!marked) {
      throw new ReservedIdempotencyReservationChangedError();
    }
    ownedReservationBody = markedResponseBody;
  };

  let mutationResponse: ApiGatewayHttpResponse;
  try {
    mutationResponse = await input.execute({
      markExternalSideEffectStarted,
    });
  } catch (error) {
    if (error instanceof ReservedIdempotencyReservationChangedError) {
      const replay = await replayStoredIdempotencyMutation(input);
      return replay ?? idempotencyInProgressResponse(input.origin, input.allowedOrigins);
    }

    if (!pendingIdempotencyBodyHasExternalSideEffectStarted(ownedReservationBody)) {
      await input.repository.deleteIdempotencyRecord({
        scope,
        key: idempotencyKey,
        requestHash,
        responseStatusCode: IDEMPOTENCY_PENDING_STATUS_CODE,
        responseBody: ownedReservationBody,
      });
    }
    throw error;
  }

  if (isRetryableReservedIdempotencyResponse(mutationResponse)) {
    if (!pendingIdempotencyBodyHasExternalSideEffectStarted(ownedReservationBody)) {
      await input.repository.deleteIdempotencyRecord({
        scope,
        key: idempotencyKey,
        requestHash,
        responseStatusCode: IDEMPOTENCY_PENDING_STATUS_CODE,
        responseBody: ownedReservationBody,
      });
    }
    return mutationResponse;
  }

  await input.repository.completeIdempotencyRecord({
    scope,
    key: idempotencyKey,
    requestHash,
    responseStatusCode: mutationResponse.statusCode,
    responseBody: mutationResponse.body,
    expectedResponseStatusCode: IDEMPOTENCY_PENDING_STATUS_CODE,
    expectedResponseBody: ownedReservationBody,
  });

  return mutationResponse;
}

async function waitForIdempotencyRecord(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function replayStoredIdempotencyMutation(input: {
  repository: RepositoryContract;
  idempotencyKey: string | undefined;
  sessionEmail: string;
  method: string;
  route: string;
  requestPayload: unknown;
  origin: string | undefined;
  allowedOrigins: string[];
}): Promise<ApiGatewayHttpResponse | null> {
  if (!input.idempotencyKey) {
    return null;
  }

  const parsedHeader = idempotencyKeyHeaderSchema.safeParse(input.idempotencyKey);
  if (!parsedHeader.success) {
    return null;
  }

  const idempotencyKey = parsedHeader.data;
  const scope = buildIdempotencyScope(input.sessionEmail, input.method, input.route);
  const requestHash = buildIdempotencyRequestHash(scope, input.requestPayload);
  let sawPendingRecord = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await input.repository.getIdempotencyRecord(scope, idempotencyKey);
    if (record) {
      if (record.requestHash !== requestHash) {
        return idempotencyConflictResponse(input.origin, input.allowedOrigins);
      }

      if (isPendingIdempotencyRecord(record)) {
        sawPendingRecord = true;
        if (attempt < 2) {
          await waitForIdempotencyRecord();
        }
        continue;
      }

      return replayIdempotencyRecord(record, input.origin, input.allowedOrigins);
    }

    if (attempt < 2) {
      await waitForIdempotencyRecord();
    }
  }

  return sawPendingRecord ? idempotencyInProgressResponse(input.origin, input.allowedOrigins) : null;
}

function decodeRouteParam(value: string): string {
  return decodeURIComponent(value);
}

function createDefaultDependencies(): CoreHandlerDependencies {
  const region = process.env.AWS_REGION ?? "ap-southeast-2";
  const tableName = process.env.DYNAMODB_TABLE ?? "threefc_local";
  const ddbEndpoint = process.env.DYNAMODB_ENDPOINT;
  const appBaseUrl = process.env.APP_BASE_URL ?? "https://3fc.football";
  const publicAppBaseUrl = process.env.PUBLIC_APP_BASE_URL ?? appBaseUrl;
  const sessionCookieSecure = resolveSessionCookieSecureFlag(
    process.env.SESSION_COOKIE_SECURE,
    appBaseUrl,
  );
  const sesFromEmail = process.env.SES_FROM_EMAIL ?? "noreply@3fc.football";
  const callbackPath = process.env.MAGIC_LINK_CALLBACK_PATH ?? "/auth/callback";
  const tokenTtlSeconds = Number.parseInt(process.env.MAGIC_LINK_TOKEN_TTL_SECONDS ?? "900", 10);
  const sessionTtlSeconds = Number.parseInt(
    process.env.MAGIC_LINK_SESSION_TTL_SECONDS ?? String(DEFAULT_SESSION_TTL_SECONDS),
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
    appBaseUrl,
    publicAppBaseUrl,
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
          logMagicLinkEvent({
            requestId: details.requestId,
            route,
            method,
            status,
            action: "start",
            outcome: "failure",
            reason: "invalid_email",
            emailHash: hashEmailDiagnostic(email),
          });
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
          logMagicLinkEvent({
            requestId: details.requestId,
            route,
            method,
            status,
            action: "start",
            outcome: "blocked",
            reason: "rate_limited",
            emailHash: hashEmailDiagnostic(email),
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
          logMagicLinkEvent({
            requestId: details.requestId,
            route,
            method,
            status,
            action: "start",
            outcome: "success",
            reason: "sent",
            emailHash: hashEmailDiagnostic(email),
            correlationId: startResult.messageId ?? undefined,
          });
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
            logMagicLinkEvent({
              requestId: details.requestId,
              route,
              method,
              status,
              action: "start",
              outcome: "failure",
              reason: error.code,
              emailHash: hashEmailDiagnostic(email),
            });
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
          logMagicLinkEvent({
            requestId: details.requestId,
            route,
            method,
            status,
            action: "complete",
            outcome: "failure",
            reason: "missing_token",
          });
          return badRequest(origin, dependencies.corsAllowedOrigins, "Field `token` is required.");
        }

        try {
          const completed = await dependencies.magicLinkService.complete(rawBody.token);
          status = 200;
          logMagicLinkEvent({
            requestId: details.requestId,
            route,
            method,
            status,
            action: "complete",
            outcome: "success",
            reason: "authenticated",
            tokenIdHash: hashMagicLinkTokenId(rawBody.token),
          });
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
            logMagicLinkEvent({
              requestId: details.requestId,
              route,
              method,
              status,
              action: "complete",
              outcome: "failure",
              reason: error.code,
              tokenIdHash: hashMagicLinkTokenId(rawBody.token),
            });
            return magicLinkErrorResponse(origin, dependencies.corsAllowedOrigins, error);
          }

          throw error;
        }
      }

      const missingJoinCodeMatch = route.match(/^\/v1\/join\/?$/);
      if (method === "POST" && missingJoinCodeMatch) {
        status = 400;
        return joinCodeRequiredResponse(origin, dependencies.corsAllowedOrigins);
      }

      const joinGameMatch = route.match(/^\/v1\/join\/([^/]+)$/);
      if (method === "POST" && joinGameMatch) {
        let joinCode: string;
        try {
          joinCode = normalizeJoinCodePathParam(decodeURIComponent(joinGameMatch[1]));
        } catch {
          status = 400;
          return joinCodeMalformedResponse(origin, dependencies.corsAllowedOrigins);
        }
        if (joinCode.length === 0) {
          status = 400;
          return joinCodeRequiredResponse(origin, dependencies.corsAllowedOrigins);
        }
        if (!isJoinCodePathParamValid(joinCode)) {
          status = 400;
          return joinCodeInvalidFormatResponse(origin, dependencies.corsAllowedOrigins);
        }

        let rawBody: Record<string, unknown>;
        try {
          rawBody = parseJsonBody(event);
        } catch {
          status = 400;
          return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
        }

        const parsedBody = joinGameRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
          status = 400;
          return badRequest(
            origin,
            dependencies.corsAllowedOrigins,
            formatSchemaValidationError(parsedBody.error),
          );
        }

        const parsedIdempotencyKey = parseOptionalIdempotencyKey(idempotencyKey);
        const executeJoin = async () => {
          let joinResult: Awaited<ReturnType<RepositoryContract["joinGameByCode"]>>;
          try {
            joinResult = await dependencies.repository.joinGameByCode({
              joinCode,
              playerId: parsedIdempotencyKey
                ? buildPublicJoinPlayerId(joinCode, parsedIdempotencyKey)
                : `player-${randomUUID()}`,
              nickname: parsedBody.data.nickname,
            });
          } catch (error) {
            if (error instanceof GameJoinRegistrationError) {
              if (error.code === "game_finished") {
                return finishedGameJoinConflictResponse(
                  origin,
                  dependencies.corsAllowedOrigins,
                  error.message,
                );
              }

              return joinStateChangedResponse(origin, dependencies.corsAllowedOrigins);
            }

            throw error;
          }

          if (!joinResult) {
            return invalidJoinCodeResponse(origin, dependencies.corsAllowedOrigins);
          }

          return createJsonResponse(
            201,
            {
              gameId: joinResult.game.gameId,
              joinCode: joinResult.game.joinCode,
              player: toPublicPlayer(joinResult.player),
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        };

        const mutationResponse = await executeIdempotentMutation({
          repository: dependencies.repository,
          idempotencyKey,
          sessionEmail: PUBLIC_JOIN_IDEMPOTENCY_SUBJECT,
          method,
          route: `/v1/join/${joinCode}`,
          requestPayload: parsedBody.data,
          origin,
          allowedOrigins: dependencies.corsAllowedOrigins,
          execute: executeJoin,
          shouldPersistResponse: shouldPersistPublicJoinResponse,
        });
        status = mutationResponse.statusCode;
        return mutationResponse;
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
          sessionUserIds(session),
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
          const leagues = await listLeaguesForSession(dependencies.repository, session);
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
          const access = await ensureLeagueAccess(dependencies.repository, leagueId, sessionUserIds(session));
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
            {
              ...league,
              access: {
                role: access.role,
              },
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const grantLeagueAccessMatch = route.match(/^\/v1\/leagues\/([^/]+)\/access$/);
        if (method === "POST" && grantLeagueAccessMatch) {
          const leagueId = decodeRouteParam(grantLeagueAccessMatch[1]);
          const league = await dependencies.repository.getLeague(leagueId);
          if (!league) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `League ${leagueId} was not found.`);
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = grantLeagueAccessRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const accessGrant = await dependencies.repository.grantLeagueAccess({
            leagueId,
            userId: parsedBody.data.userId,
            role: parsedBody.data.role,
            grantedByUserId: session.email,
          });
          status = 200;
          return createJsonResponse(
            status,
            accessGrant,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const createLeagueOrganiserInviteMatch = route.match(
          /^\/v1\/leagues\/([^/]+)\/organiser-invites$/,
        );
        if (method === "POST" && createLeagueOrganiserInviteMatch) {
          const leagueId = decodeRouteParam(createLeagueOrganiserInviteMatch[1]);
          const league = await dependencies.repository.getLeague(leagueId);
          if (!league) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `League ${leagueId} was not found.`);
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = createLeagueOrganiserInviteRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const inviteEmail =
            typeof parsedBody.data.email === "string" && parsedBody.data.email.trim().length > 0
              ? normalizeMagicLinkEmail(parsedBody.data.email)
              : null;
          if (inviteEmail && !isMagicLinkEmailLike(inviteEmail)) {
            status = 400;
            return magicLinkErrorResponse(
              origin,
              dependencies.corsAllowedOrigins,
              new MagicLinkAuthError("invalid_email", 400, "Email must be a valid email address."),
            );
          }

          const createdByUserId = sessionSubject(session);
          const inviteKind: LeagueInviteRecord["kind"] = inviteEmail ? "email" : "share";
          const inviteCode = inviteEmail
            ? buildOrganiserInviteIdempotencyCode({
                sessionEmail: session.email,
                method,
                route,
                idempotencyKey,
              })
            : null;
          const recoverStartedExternalSideEffect = inviteEmail && inviteCode
            ? async (): Promise<ApiGatewayHttpResponse | null> => {
                const existingInvite = await dependencies.repository.getLeagueOrganiserInvite(inviteCode);
                if (
                  !existingInvite ||
                  !isMatchingRecoveredOrganiserInvite({
                    invite: existingInvite,
                    leagueId,
                    email: inviteEmail,
                    createdByUserId,
                    kind: inviteKind,
                  })
                ) {
                  return null;
                }

                logMagicLinkEvent({
                  requestId: details.requestId,
                  route,
                  method,
                  status: 202,
                  action: "organiser_invite_start",
                  outcome: "unknown",
                  reason: "stale_started_recovered",
                  emailHash: hashEmailDiagnostic(inviteEmail),
                });

                return createJsonResponse(
                  202,
                  buildOrganiserInviteResponse(
                    existingInvite,
                    dependencies.publicAppBaseUrl ?? dependencies.appBaseUrl,
                    {
                      status: "unknown",
                      email: inviteEmail,
                      expiresAt: null,
                      messageId: null,
                      message: "Email delivery could not be confirmed. Share the invite link manually.",
                    },
                  ),
                  buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                );
              }
            : undefined;

          const inviteResponse = await executeReservedIdempotentMutation({
            repository: dependencies.repository,
            idempotencyKey,
            sessionEmail: session.email,
            method,
            route,
            requestPayload: { email: inviteEmail },
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
            ...(recoverStartedExternalSideEffect ? { recoverStartedExternalSideEffect } : {}),
            execute: async ({ markExternalSideEffectStarted }) => {
              if (inviteEmail) {
                const rateLimitDecision = await dependencies.magicLinkRateLimiter.consumeMagicLinkStart({
                  email: inviteEmail,
                  clientIp,
                });
                if (!rateLimitDecision.allowed) {
                  logAuthRateLimit({
                    requestId: details.requestId,
                    route,
                    method,
                    status: 429,
                    dimension: rateLimitDecision.dimension,
                    retryAfterSeconds: rateLimitDecision.retryAfterSeconds,
                  });
                  return rateLimited(
                    origin,
                    dependencies.corsAllowedOrigins,
                    rateLimitDecision.retryAfterSeconds,
                  );
                }
              }

              let invite: LeagueInviteRecord;
              try {
                invite = await createOrRecoverLeagueOrganiserInvite({
                  repository: dependencies.repository,
                  leagueId,
                  email: inviteEmail,
                  createdByUserId,
                  inviteCode,
                  kind: inviteKind,
                });
              } catch (error) {
                if (error instanceof LeagueInviteCodeCollisionError) {
                  return createJsonResponse(
                    409,
                    {
                      error: "conflict",
                      code: "invite_code_collision",
                      message: error.message,
                    },
                    buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                  );
                }

                throw error;
              }
              const invitePath = buildOrganiserInvitePath(invite.inviteCode);
              let responseStatusCode = 201;
              let emailDelivery: OrganiserInviteEmailDeliveryResponse | null = null;
              if (inviteEmail) {
                await markExternalSideEffectStarted();
                try {
                  const delivery = await dependencies.magicLinkService.start(inviteEmail, {
                    returnTo: invitePath,
                    subject: `You're invited to organise ${league.name} on 3FC`,
                    introLines: [
                      `You have been invited to help organise ${league.name} on 3FC.`,
                    ],
                  });
                  emailDelivery = {
                    status: "sent",
                    email: delivery.email,
                    expiresAt: delivery.expiresAt,
                    messageId: delivery.messageId,
                  };
                  logMagicLinkEvent({
                    requestId: details.requestId,
                    route,
                    method,
                    status: responseStatusCode,
                    action: "organiser_invite_start",
                    outcome: "success",
                    reason: "sent",
                    emailHash: hashEmailDiagnostic(inviteEmail),
                    correlationId: delivery.messageId ?? undefined,
                  });
                } catch {
                  responseStatusCode = 202;
                  emailDelivery = {
                    status: "unknown",
                    email: inviteEmail,
                    expiresAt: null,
                    messageId: null,
                    message: "Email delivery could not be confirmed. Share the invite link manually.",
                  };
                  logMagicLinkEvent({
                    requestId: details.requestId,
                    route,
                    method,
                    status: responseStatusCode,
                    action: "organiser_invite_start",
                    outcome: "unknown",
                    reason: "delivery_unconfirmed",
                    emailHash: hashEmailDiagnostic(inviteEmail),
                  });
                }
              }

              return createJsonResponse(
                responseStatusCode,
                buildOrganiserInviteResponse(
                  invite,
                  dependencies.publicAppBaseUrl ?? dependencies.appBaseUrl,
                  emailDelivery,
                ),
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            },
          });
          status = inviteResponse.statusCode;
          return inviteResponse;
        }

        const acceptLeagueOrganiserInviteMatch = route.match(/^\/v1\/invites\/([^/]+)\/accept$/);
        if (method === "POST" && acceptLeagueOrganiserInviteMatch) {
          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = acceptLeagueOrganiserInviteRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          try {
            const result = await dependencies.repository.acceptLeagueOrganiserInvite({
              inviteCode: decodeRouteParam(acceptLeagueOrganiserInviteMatch[1]),
              userId: sessionSubject(session),
              email: session.email,
            });
            if (!result) {
              status = 404;
              return notFound(origin, dependencies.corsAllowedOrigins, "Organiser invite was not found.");
            }

            status = 200;
            return createJsonResponse(
              status,
              {
                ...result,
                inviteLink: buildAppUrl(
                  dependencies.publicAppBaseUrl ?? dependencies.appBaseUrl,
                  buildOrganiserInvitePath(result.invite.inviteCode),
                ),
              },
              buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
            );
          } catch (error) {
            if (error instanceof LeagueInviteError) {
              status = error.statusCode;
              return leagueInviteErrorResponse(origin, dependencies.corsAllowedOrigins, error);
            }

            throw error;
          }
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
          const access = await ensureLeagueAccess(dependencies.repository, leagueId, sessionUserIds(session));
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

        const getLeagueSeasonMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)$/);
        if (method === "GET" && getLeagueSeasonMatch) {
          const leagueId = decodeRouteParam(getLeagueSeasonMatch[1]);
          const seasonId = decodeRouteParam(getLeagueSeasonMatch[2]);
          const access = await ensureLeagueAccess(dependencies.repository, leagueId, sessionUserIds(session));
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${leagueId} is required.`,
            );
          }

          const season = await dependencies.repository.getSeasonForLeague(leagueId, seasonId, {
            consistentRead: true,
          });
          if (!season) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
          }

          status = 200;
          return createJsonResponse(
            status,
            season,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const listLeagueSeasonGamesMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)\/games$/);
        if (method === "GET" && listLeagueSeasonGamesMatch) {
          const leagueId = decodeRouteParam(listLeagueSeasonGamesMatch[1]);
          const seasonId = decodeRouteParam(listLeagueSeasonGamesMatch[2]);
          const access = await ensureLeagueAccess(dependencies.repository, leagueId, sessionUserIds(session));
          if (!access.allowed) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "league_access_required",
              `Access to league ${leagueId} is required.`,
            );
          }

          const season = await dependencies.repository.getSeasonForLeague(leagueId, seasonId, {
            consistentRead: true,
          });
          if (!season) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
          }

          const games = await dependencies.repository.listGamesForSeason(seasonId, { leagueId });
          const gamesWithUsableJoinCodes = await Promise.all(
            games.map(async (game) => {
              const refreshedGame = await dependencies.repository.getGame(game.gameId, {
                consistentRead: true,
                repairLegacyJoinCode: true,
                expectedLeagueId: leagueId,
                expectedSeasonId: seasonId,
              });
              if (
                !refreshedGame ||
                refreshedGame.leagueId !== leagueId ||
                refreshedGame.seasonId !== seasonId
              ) {
                return game;
              }

              return refreshedGame;
            }),
          );
          status = 200;
          return createJsonResponse(
            status,
            {
              games: gamesWithUsableJoinCodes.map((game) => buildGameResponse(game)),
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const deleteLeagueMatch = route.match(/^\/v1\/leagues\/([^/]+)$/);
        if (method === "DELETE" && deleteLeagueMatch) {
          const leagueId = decodeRouteParam(deleteLeagueMatch[1]);
          const isAdmin = await ensureLeagueAdmin(dependencies.repository, leagueId, sessionUserIds(session));
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

        const createLeagueSeasonSessionMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)\/sessions$/);
        if (method === "POST" && createLeagueSeasonSessionMatch) {
          const leagueId = decodeRouteParam(createLeagueSeasonSessionMatch[1]);
          const seasonId = decodeRouteParam(createLeagueSeasonSessionMatch[2]);
          const isAdmin = await ensureLeagueAdmin(dependencies.repository, leagueId, sessionUserIds(session));
          if (!isAdmin) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "admin_required",
              `Admin role is required for league ${leagueId}.`,
            );
          }

          const season = await dependencies.repository.getSeasonForLeague(leagueId, seasonId, {
            consistentRead: true,
          });
          if (!season) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
          }

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
              let createdSession: unknown;
              try {
                createdSession = await dependencies.repository.createSession({
                  leagueId,
                  seasonId,
                  sessionId: parsedBody.data.sessionId,
                  sessionDate: parsedBody.data.sessionDate,
                });
              } catch (error) {
                if (error instanceof GameMutationStateError) {
                  return conflict(origin, dependencies.corsAllowedOrigins, error.message);
                }

                throw error;
              }

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
            sessionUserIds(session),
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
            sessionUserIds(session),
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

          const games = await dependencies.repository.listGamesForSeason(seasonId, {
            leagueId: season.leagueId,
          });
          const gamesWithUsableJoinCodes = await Promise.all(
            games.map(async (game) => {
              const refreshedGame = await dependencies.repository.getGame(game.gameId, {
                consistentRead: true,
                repairLegacyJoinCode: true,
                expectedLeagueId: season.leagueId,
                expectedSeasonId: seasonId,
              });
              if (
                !refreshedGame ||
                refreshedGame.leagueId !== season.leagueId ||
                refreshedGame.seasonId !== seasonId
              ) {
                return game;
              }

              return refreshedGame;
            }),
          );
          status = 200;
          return createJsonResponse(
            status,
            {
              games: gamesWithUsableJoinCodes.map((game) => buildGameResponse(game)),
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
            sessionUserIds(session),
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

          let team: Awaited<ReturnType<RepositoryContract["createTeam"]>>;
          try {
            await ensureSeasonDefaultTeams(dependencies.repository, seasonId);
            team = await dependencies.repository.createTeam({
              seasonId,
              teamId,
              name: parsedBody.data.name,
              color: parsedBody.data.color ?? null,
            });
          } catch (error) {
            if (error instanceof GameMutationStateError) {
              status = 409;
              return conflict(origin, dependencies.corsAllowedOrigins, error.message);
            }

            throw error;
          }
          status = 200;
          return createJsonResponse(
            status,
            team,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const deleteLeagueSeasonMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)$/);
        if (method === "DELETE" && deleteLeagueSeasonMatch) {
          const leagueId = decodeRouteParam(deleteLeagueSeasonMatch[1]);
          const seasonId = decodeRouteParam(deleteLeagueSeasonMatch[2]);
          const isAdmin = await ensureLeagueAdmin(dependencies.repository, leagueId, sessionUserIds(session));
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
            const deleted = await dependencies.repository.deleteSeason(seasonId, { leagueId });
            if (!deleted) {
              status = 404;
              return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
            }
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
            sessionUserIds(session),
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

        const createLeagueSeasonSessionGameMatch = route.match(
          /^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)\/sessions\/([^/]+)\/games$/,
        );
        if (method === "POST" && createLeagueSeasonSessionGameMatch) {
          const leagueId = decodeRouteParam(createLeagueSeasonSessionGameMatch[1]);
          const seasonId = decodeRouteParam(createLeagueSeasonSessionGameMatch[2]);
          const sessionId = decodeRouteParam(createLeagueSeasonSessionGameMatch[3]);
          const isAdmin = await ensureLeagueAdmin(dependencies.repository, leagueId, sessionUserIds(session));
          if (!isAdmin) {
            status = 403;
            return forbidden(
              origin,
              dependencies.corsAllowedOrigins,
              "admin_required",
              `Admin role is required for league ${leagueId}.`,
            );
          }

          const season = await dependencies.repository.getSeasonForLeague(leagueId, seasonId, {
            consistentRead: true,
          });
          if (!season) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Season ${seasonId} was not found.`);
          }

          const sessionRecord = await dependencies.repository.getSessionForSeason(seasonId, sessionId, {
            leagueId,
          });
          if (!sessionRecord) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Session ${sessionId} was not found.`);
          }

          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const mutationResponse = await createGameMutationResponse({
            dependencies,
            idempotencyKey,
            session,
            method,
            route,
            rawBody,
            origin,
            scope: { leagueId, seasonId, sessionId },
          });
          status = mutationResponse.statusCode;
          return mutationResponse;
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

          let mutationResponse: ApiGatewayHttpResponse;
          const createRequestHash = buildCreateGameRecoveryRequestHash({
            idempotencyKey,
            sessionEmail: session.email,
            method,
            route,
            payload: parsedBody.data,
          });
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
                let createdGame: RepositoryGameRecord;
                let recoveredExistingGame = false;
                try {
                  createdGame = await dependencies.repository.createGame({
                    gameId: parsedBody.data.gameId,
                    createRequestHash,
                    leagueId,
                    seasonId,
                    sessionId,
                    status: parsedBody.data.status as GameStatus | undefined,
                    gameStartTs: parsedBody.data.gameStartTs,
                    thirdLengthMinutes: parsedBody.data.thirdLengthMinutes,
                    linkSession: true,
                  });
                } catch (error) {
                  if (!(error instanceof GameAlreadyExistsError)) {
                    throw error;
                  }

                  const replayResponse = await replayStoredIdempotencyMutation({
                    repository: dependencies.repository,
                    idempotencyKey,
                    sessionEmail: session.email,
                    method,
                    route,
                    requestPayload: parsedBody.data,
                    origin,
                    allowedOrigins: dependencies.corsAllowedOrigins,
                  });
                  if (replayResponse) {
                    return replayResponse;
                  }
                  if (!idempotencyKey || !createRequestHash) {
                    throw error;
                  }

                  const existingGame = await dependencies.repository.getGame(parsedBody.data.gameId);
                  if (
                    !existingGame ||
                    !existingGameMatchesCreateRequest({
                      game: existingGame,
                      leagueId,
                      seasonId,
                      sessionId,
                      createRequestHash,
                      request: parsedBody.data,
                    })
                  ) {
                    throw error;
                  }

                  createdGame = existingGame;
                  recoveredExistingGame = true;
                }

                if (recoveredExistingGame) {
                  await dependencies.repository.createSessionGame({
                    sessionId: createdGame.sessionId,
                    gameId: createdGame.gameId,
                    gameStartTs: createdGame.gameStartTs,
                    leagueId: createdGame.leagueId,
                    seasonId: createdGame.seasonId,
                    requireExistingGame: true,
                  });
                }
                await ensureGameTeamsForGame(dependencies.repository, createdGame, {
                  leagueId: createdGame.leagueId,
                });

                return createJsonResponse(
                  201,
                  buildGameResponse(createdGame),
                  buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                );
              },
            });
          } catch (error) {
            if (error instanceof GameAlreadyExistsError) {
              const replayResponse = await replayStoredIdempotencyMutation({
                repository: dependencies.repository,
                idempotencyKey,
                sessionEmail: session.email,
                method,
                route,
                requestPayload: parsedBody.data,
                origin,
                allowedOrigins: dependencies.corsAllowedOrigins,
              });
              if (replayResponse) {
                status = replayResponse.statusCode;
                return replayResponse;
              }

              status = 409;
              return gameAlreadyExistsConflictResponse(
                origin,
                dependencies.corsAllowedOrigins,
                parsedBody.data.gameId,
              );
            }
            if (error instanceof GameJoinCodeCollisionError) {
              const replayResponse = await replayStoredIdempotencyMutation({
                repository: dependencies.repository,
                idempotencyKey,
                sessionEmail: session.email,
                method,
                route,
                requestPayload: parsedBody.data,
                origin,
                allowedOrigins: dependencies.corsAllowedOrigins,
              });
              if (replayResponse) {
                status = replayResponse.statusCode;
                return replayResponse;
              }

              status = 409;
              return gameJoinCodeCollisionConflictResponse(origin, dependencies.corsAllowedOrigins);
            }
            if (error instanceof GameMutationStateError) {
              status = 409;
              return conflict(origin, dependencies.corsAllowedOrigins, error.message);
            }

            throw error;
          }

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
            sessionUserIds(session),
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

          const responseGame =
            (await dependencies.repository.getGame(gameId, {
              consistentRead: true,
              repairLegacyJoinCode: true,
              expectedLeagueId: game.leagueId,
              expectedSeasonId: game.seasonId,
            })) ?? game;

          status = 200;
          return createJsonResponse(
            status,
            buildGameResponse(responseGame),
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

          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const finishedBlock = await buildFinishedGameMutationBlock({
            repository: dependencies.repository,
            game,
            sessionUserIds: sessionUserIds(session),
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
          });
          if (finishedBlock) {
            status = finishedBlock.statusCode;
            return finishedBlock;
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

          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const finishedBlock = await buildFinishedGameMutationBlock({
            repository: dependencies.repository,
            game,
            sessionUserIds: sessionUserIds(session),
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
          });
          if (finishedBlock) {
            status = finishedBlock.statusCode;
            return finishedBlock;
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

        const finishGameMatch = route.match(/^\/v1\/games\/([^/]+)\/finish$/);
        if (method === "POST" && finishGameMatch) {
          const gameId = decodeRouteParam(finishGameMatch[1]);

          let mutationResponse: ApiGatewayHttpResponse;
          try {
            mutationResponse = await executeIdempotentMutation({
              repository: dependencies.repository,
              idempotencyKey,
              sessionEmail: session.email,
              method,
              route,
              requestPayload: {},
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

                try {
                  await ensureGameTeamsForGame(dependencies.repository, currentGame, {
                    leagueId: currentGame.leagueId,
                  });
                } catch (error) {
                  if (error instanceof GameMutationStateError) {
                    const replayResponse = await replayStoredIdempotencyMutation({
                      repository: dependencies.repository,
                      idempotencyKey,
                      sessionEmail: session.email,
                      method,
                      route,
                      requestPayload: {},
                      origin,
                      allowedOrigins: dependencies.corsAllowedOrigins,
                    });
                    if (replayResponse) {
                      return replayResponse;
                    }

                    const recovered = await recoverFinishedGameForFinishRoute({
                      repository: dependencies.repository,
                      gameId,
                      origin,
                      allowedOrigins: dependencies.corsAllowedOrigins,
                    });
                    if (recovered) {
                      return recovered;
                    }

                    return createJsonResponse(
                      409,
                      {
                        error: "conflict",
                        code: error.code,
                        message: error.message,
                      },
                      buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                    );
                  }

                  throw error;
                }
                let result;
                try {
                  result = await dependencies.repository.finishGame({ gameId });
                } catch (error) {
                  if (error instanceof GameTimerTransitionError && error.code === "game_state_changed") {
                    const replayResponse = await replayStoredIdempotencyMutation({
                      repository: dependencies.repository,
                      idempotencyKey,
                      sessionEmail: session.email,
                      method,
                      route,
                      requestPayload: {},
                      origin,
                      allowedOrigins: dependencies.corsAllowedOrigins,
                    });
                    if (replayResponse) {
                      return replayResponse;
                    }

                    const recovered = await recoverFinishedGameForFinishRoute({
                      repository: dependencies.repository,
                      gameId,
                      origin,
                      allowedOrigins: dependencies.corsAllowedOrigins,
                    });
                    if (recovered) {
                      return recovered;
                    }

                    await waitForIdempotencyRecord();
                    const replayResponseAfterWait = await replayStoredIdempotencyMutation({
                      repository: dependencies.repository,
                      idempotencyKey,
                      sessionEmail: session.email,
                      method,
                      route,
                      requestPayload: {},
                      origin,
                      allowedOrigins: dependencies.corsAllowedOrigins,
                    });
                    if (replayResponseAfterWait) {
                      return replayResponseAfterWait;
                    }

                    const recoveredAfterWait = await recoverFinishedGameForFinishRoute({
                      repository: dependencies.repository,
                      gameId,
                      origin,
                      allowedOrigins: dependencies.corsAllowedOrigins,
                    });
                    if (recoveredAfterWait) {
                      return recoveredAfterWait;
                    }

                    let retryFailure: unknown = null;
                    try {
                      result = await dependencies.repository.finishGame({ gameId });
                    } catch (retryError) {
                      if (
                        retryError instanceof GameTimerTransitionError &&
                        retryError.code === "game_state_changed"
                      ) {
                        const recoveredAfterRetry = await recoverFinishedGameForFinishRoute({
                          repository: dependencies.repository,
                          gameId,
                          origin,
                          allowedOrigins: dependencies.corsAllowedOrigins,
                        });
                        if (recoveredAfterRetry) {
                          return recoveredAfterRetry;
                        }
                      }
                      retryFailure = retryError;
                    }

                    if (retryFailure) {
                      throw retryFailure;
                    }
                  }

                  if (!result && error instanceof GameTimerTransitionError) {
                    return timerTransitionConflictResponse(
                      origin,
                      dependencies.corsAllowedOrigins,
                      error,
                    );
                  }

                  if (!result) {
                    throw error;
                  }
                }
                if (!result) {
                  return notFound(
                    origin,
                    dependencies.corsAllowedOrigins,
                    `Game ${gameId} was not found.`,
                  );
                }

                return createJsonResponse(
                  200,
                  buildGameResponse(result),
                  buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                );
              },
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

          status = mutationResponse.statusCode;
          return mutationResponse;
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

                const allowFinished = currentGame.status === "finished";
                if (currentGame.status === "finished") {
                  const finishedBlock = await buildFinishedGameMutationBlock({
                    repository: dependencies.repository,
                    game: currentGame,
                    sessionUserIds: sessionUserIds(session),
                    origin,
                    allowedOrigins: dependencies.corsAllowedOrigins,
                  });
                  if (finishedBlock) {
                    return finishedBlock;
                  }
                }

                if (!allowFinished && !currentGame.thirds.some((third) => third.startedAt && !third.finishedAt)) {
                  throw new GoalCreationError(
                    "no_active_third",
                    409,
                    "A goal can only be created while a third is running.",
                  );
                }

                await ensureGameTeamsForGame(dependencies.repository, currentGame, {
                  allowFinished,
                  leagueId: currentGame.leagueId,
                });
                const result = await dependencies.repository.createGoal({
                  gameId,
                  eventId: buildGoalEventId({
                    idempotencyKey,
                    sessionEmail: session.email,
                    method,
                    route,
                  }),
                  actorUserId: session.email,
                  scoringTeamId: parsedBody.data.scoringTeamId,
                  concedingTeamId: parsedBody.data.concedingTeamId,
                  scorerPlayerId: parsedBody.data.scorerPlayerId,
                  assistPlayerIds: parsedBody.data.assistPlayerIds,
                  ownGoal: parsedBody.data.ownGoal,
                  allowFinished,
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

        const updateGoalMatch = route.match(/^\/v1\/games\/([^/]+)\/goals\/([^/]+)$/);
        if (method === "PATCH" && updateGoalMatch) {
          const gameId = decodeRouteParam(updateGoalMatch[1]);
          const eventId = decodeRouteParam(updateGoalMatch[2]);
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

          const parsedBody = updateGoalRequestSchema.safeParse(rawBody);
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
            const correctionOperation = buildGoalCorrectionOperation({
              idempotencyKey,
              sessionEmail: session.email,
              method,
              route,
              requestPayload: parsedBody.data,
            });
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

                const finishedBlock = await buildFinishedGameMutationBlock({
                  repository: dependencies.repository,
                  game: currentGame,
                  sessionUserIds: sessionUserIds(session),
                  origin,
                  allowedOrigins: dependencies.corsAllowedOrigins,
                });
                if (finishedBlock) {
                  return finishedBlock;
                }

                const result = await dependencies.repository.updateGoal({
                  gameId,
                  eventId,
                  actorUserId: session.email,
                  operationId: correctionOperation?.operationId,
                  operationRequestHash: correctionOperation?.operationRequestHash,
                  allowFinished: currentGame.status === "finished",
                  ...parsedBody.data,
                });

                if (!result) {
                  return notFound(
                    origin,
                    dependencies.corsAllowedOrigins,
                    `Goal ${eventId} was not found for game ${gameId}.`,
                  );
                }

                return createJsonResponse(
                  200,
                  result,
                  buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                );
              },
            });
          } catch (error) {
            if (error instanceof GoalCorrectionError) {
              status = error.statusCode;
              return error.code === "idempotency_conflict"
                ? idempotencyConflictResponse(origin, dependencies.corsAllowedOrigins)
                : goalCorrectionErrorResponse(origin, dependencies.corsAllowedOrigins, error);
            }

            throw error;
          }

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        const deleteGoalMatch = route.match(/^\/v1\/games\/([^/]+)\/goals\/([^/]+)$/);
        if (method === "DELETE" && deleteGoalMatch) {
          const gameId = decodeRouteParam(deleteGoalMatch[1]);
          const eventId = decodeRouteParam(deleteGoalMatch[2]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          let mutationResponse: ApiGatewayHttpResponse;
          try {
            const requestPayload = { eventId };
            const correctionOperation = buildGoalCorrectionOperation({
              idempotencyKey,
              sessionEmail: session.email,
              method,
              route,
              requestPayload,
            });
            mutationResponse = await executeIdempotentMutation({
              repository: dependencies.repository,
              idempotencyKey,
              sessionEmail: session.email,
              method,
              route,
              requestPayload,
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

                const finishedBlock = await buildFinishedGameMutationBlock({
                  repository: dependencies.repository,
                  game: currentGame,
                  sessionUserIds: sessionUserIds(session),
                  origin,
                  allowedOrigins: dependencies.corsAllowedOrigins,
                });
                if (finishedBlock) {
                  return finishedBlock;
                }

                const result = await dependencies.repository.deleteGoal({
                  gameId,
                  eventId,
                  actorUserId: session.email,
                  operationId: correctionOperation?.operationId,
                  operationRequestHash: correctionOperation?.operationRequestHash,
                  allowFinished: currentGame.status === "finished",
                });

                if (!result) {
                  return notFound(
                    origin,
                    dependencies.corsAllowedOrigins,
                    `Goal ${eventId} was not found for game ${gameId}.`,
                  );
                }

                return createJsonResponse(
                  200,
                  result,
                  buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                );
              },
            });
          } catch (error) {
            if (error instanceof GoalCorrectionError) {
              status = error.statusCode;
              return error.code === "idempotency_conflict"
                ? idempotencyConflictResponse(origin, dependencies.corsAllowedOrigins)
                : goalCorrectionErrorResponse(origin, dependencies.corsAllowedOrigins, error);
            }

            throw error;
          }

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        const undoLastGoalMatch = route.match(/^\/v1\/games\/([^/]+)\/goals\/undo-last$/);
        if (method === "POST" && undoLastGoalMatch) {
          const gameId = decodeRouteParam(undoLastGoalMatch[1]);
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

          const parsedBody = undoLastGoalRequestSchema.safeParse(rawBody);
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
            const correctionOperation = buildGoalCorrectionOperation({
              idempotencyKey,
              sessionEmail: session.email,
              method,
              route,
              requestPayload: parsedBody.data,
            });
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

                const finishedBlock = await buildFinishedGameMutationBlock({
                  repository: dependencies.repository,
                  game: currentGame,
                  sessionUserIds: sessionUserIds(session),
                  origin,
                  allowedOrigins: dependencies.corsAllowedOrigins,
                });
                if (finishedBlock) {
                  return finishedBlock;
                }

                const result = await dependencies.repository.undoLastGoal({
                  gameId,
                  actorUserId: session.email,
                  operationId: correctionOperation?.operationId,
                  operationRequestHash: correctionOperation?.operationRequestHash,
                  allowFinished: currentGame.status === "finished",
                  expectedEventId: parsedBody.data.expectedEventId,
                });

                if (!result) {
                  return notFound(
                    origin,
                    dependencies.corsAllowedOrigins,
                    `No goal events were found for game ${gameId}.`,
                  );
                }

                return createJsonResponse(
                  200,
                  result,
                  buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                );
              },
            });
          } catch (error) {
            if (error instanceof GoalCorrectionError) {
              status = error.statusCode;
              return error.code === "idempotency_conflict"
                ? idempotencyConflictResponse(origin, dependencies.corsAllowedOrigins)
                : goalCorrectionErrorResponse(origin, dependencies.corsAllowedOrigins, error);
            }

            throw error;
          }

          status = mutationResponse.statusCode;
          return mutationResponse;
        }

        const listGameGoalsMatch = route.match(/^\/v1\/games\/([^/]+)\/goals$/);
        if (method === "GET" && listGameGoalsMatch) {
          const gameId = decodeRouteParam(listGameGoalsMatch[1]);
          const game = await dependencies.repository.getGame(gameId);
          if (!game) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
          }

          const access = await ensureLeagueAccess(
            dependencies.repository,
            game.leagueId,
            sessionUserIds(session),
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
          const timeline = await dependencies.repository.listGoalEvents(gameId);
          status = 200;
          return createJsonResponse(
            status,
            {
              scoreboard: {
                teams,
              },
              timeline,
            },
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
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

          let team;
          try {
            await ensureGameTeamsForGame(dependencies.repository, game, {
              leagueId: game.leagueId,
            });
            team = await dependencies.repository.createGameTeamOverride({
              gameId,
              teamId,
              name: parsedBody.data.name,
              color: parsedBody.data.color ?? null,
              allowFinished: game.status === "finished",
            });
          } catch (error) {
            if (error instanceof GameMutationStateError) {
              const currentGame = await dependencies.repository.getGame(gameId);
              if (
                error.code === "game_finished" ||
                (game.status !== "finished" && currentGame?.status === "finished")
              ) {
                status = 409;
                return createJsonResponse(
                  status,
                  {
                    error: "conflict",
                    code: "game_finished",
                    message: `Game ${gameId} is finished. Team overrides are locked after finish.`,
                  },
                  buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                );
              }

              status = 409;
              return createJsonResponse(
                status,
                {
                  error: "conflict",
                  code: error.code,
                  message: error.message,
                },
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            }

            throw error;
          }
          status = 200;
          return createJsonResponse(
            status,
            team,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const claimPlayerMatch = route.match(/^\/v1\/players\/([^/]+)\/claim$/);
        if (method === "POST" && claimPlayerMatch) {
          let rawBody: Record<string, unknown>;
          try {
            rawBody = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          const parsedBody = claimPlayerRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              formatSchemaValidationError(parsedBody.error),
            );
          }

          const playerId = decodeRouteParam(claimPlayerMatch[1]);
          let player;
          try {
            player = await dependencies.repository.claimPlayer({
              playerId,
              userId: sessionSubject(session),
            });
          } catch (error) {
            if (error instanceof PlayerClaimError) {
              status = 409;
              return createJsonResponse(
                status,
                {
                  error: "conflict",
                  code: error.code,
                  message: error.message,
                },
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            }

            throw error;
          }

          if (!player) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Player ${playerId} was not found.`);
          }

          status = 200;
          return createJsonResponse(
            status,
            {
              player: toPublicPlayer(player),
              claim: {
                claimedByCurrentUser: true,
              },
            },
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

          const access = await ensureLeagueAccess(dependencies.repository, game.leagueId, sessionUserIds(session));
          if (!access.allowed || (access.role !== "admin" && access.role !== "scorekeeper")) {
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
          const playerEntries = (
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
            .slice(0, 20);
          const players = await Promise.all(
            playerEntries.map((entry) =>
              toGamePlayerForLeagueRole({
                repository: dependencies.repository,
                player: entry.player,
                leagueId: game.leagueId,
                callerRole: access.role,
              }),
            ),
          );
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
              const currentGame = await dependencies.repository.getGame(gameId);
              if (!currentGame) {
                return notFound(
                  origin,
                  dependencies.corsAllowedOrigins,
                  `Game ${gameId} was not found.`,
                );
              }

              const finishedBlock = await buildFinishedGameMutationBlock({
                repository: dependencies.repository,
                game: currentGame,
                sessionUserIds: sessionUserIds(session),
                origin,
                allowedOrigins: dependencies.corsAllowedOrigins,
              });
              if (finishedBlock) {
                return finishedBlock;
              }

              const allowFinished =
                currentGame.status === "finished" &&
                (await ensureLeagueAccess(
                  dependencies.repository,
                  currentGame.leagueId,
                  sessionUserIds(session),
                )).role === "admin";
              let player;
              try {
                player = await dependencies.repository.createAndLinkGamePlayer({
                  gameId,
                  playerId,
                  nickname: parsedBody.data.nickname,
                  allowFinished,
                });
              } catch (error) {
                if (error instanceof GameMutationStateError) {
                  const latestGame = await dependencies.repository.getGame(gameId);
                  if (latestGame) {
                    const finishedBlockAfterRace = await buildFinishedGameMutationBlock({
                      repository: dependencies.repository,
                      game: latestGame,
                      sessionUserIds: sessionUserIds(session),
                      origin,
                      allowedOrigins: dependencies.corsAllowedOrigins,
                    });
                    if (finishedBlockAfterRace) {
                      return finishedBlockAfterRace;
                    }
                  }

                  return createJsonResponse(
                    409,
                    {
                      error: "conflict",
                      code: error.code,
                      message: error.message,
                    },
                    buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
                  );
                }

                throw error;
              }

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
            sessionUserIds(session),
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

          const finishedBlock = await buildFinishedGameMutationBlock({
            repository: dependencies.repository,
            game,
            sessionUserIds: sessionUserIds(session),
            origin,
            allowedOrigins: dependencies.corsAllowedOrigins,
          });
          if (finishedBlock) {
            status = finishedBlock.statusCode;
            return finishedBlock;
          }

          const isAdmin = await ensureLeagueAdmin(dependencies.repository, game.leagueId, sessionUserIds(session));
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

          const teams = await ensureGameTeamsForGame(dependencies.repository, game, {
            leagueId: game.leagueId,
          });
          if (!teams.some((team) => team.teamId === parsedBody.data.teamId)) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Team ID must be active for this game.");
          }

          const player = await dependencies.repository.getPlayer(playerId);
          if (!player) {
            status = 404;
            return notFound(origin, dependencies.corsAllowedOrigins, `Player ${playerId} was not found.`);
          }

          let assignment;
          try {
            assignment = await dependencies.repository.assignRosterPlayer({
              gameId,
              teamId: parsedBody.data.teamId,
              playerId,
              allowFinished: isAdmin,
            });
          } catch (error) {
            if (error instanceof GameMutationStateError) {
              const currentGame = await dependencies.repository.getGame(gameId);
              if (currentGame) {
                const finishedBlock = await buildFinishedGameMutationBlock({
                  repository: dependencies.repository,
                  game: currentGame,
                  sessionUserIds: sessionUserIds(session),
                  origin,
                  allowedOrigins: dependencies.corsAllowedOrigins,
                });
                if (finishedBlock) {
                  status = finishedBlock.statusCode;
                  return finishedBlock;
                }
              }

              status = 409;
              return createJsonResponse(
                status,
                {
                  error: "conflict",
                  code: error.code,
                  message: error.message,
                },
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            }

            throw error;
          }
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
            sessionUserIds(session),
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
            sessionUserIds(session),
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

          if (game.status === "finished") {
            status = 409;
            return finishedGameDeleteConflictResponse(
              origin,
              dependencies.corsAllowedOrigins,
              gameId,
            );
          }

          const deleted = await dependencies.repository.deleteGame(gameId);
          if (!deleted) {
            const currentGame = await dependencies.repository.getGame(gameId);
            if (currentGame?.status === "finished") {
              status = 409;
              return finishedGameDeleteConflictResponse(
                origin,
                dependencies.corsAllowedOrigins,
                gameId,
              );
            }
            if (!currentGame) {
              status = 404;
              return notFound(origin, dependencies.corsAllowedOrigins, `Game ${gameId} was not found.`);
            }

            status = 409;
            return createJsonResponse(
              status,
              {
                error: "conflict",
                code: "game_state_changed",
                message: `Game ${gameId} changed before it could be deleted. Reload and try again.`,
              },
              buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
            );
          }
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
