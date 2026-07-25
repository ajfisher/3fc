import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { URL, pathToFileURL } from "node:url";

import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
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

import {
  isMagicLinkEmailLike,
  MagicLinkAuthError,
  MagicLinkService,
  normalizeMagicLinkEmail,
  type AuthSessionRecord,
  type MagicLinkEmailSender,
} from "./auth/magic-link.js";
import {
  authorizeProtectedMutation,
} from "./auth/acl.js";
import {
  buildCorsHeaders,
  isMagicLinkStartOriginPermitted,
  isStateChangeOriginPermitted,
  parseAllowedOrigins,
} from "./auth/http-security.js";
import {
  AuthRateLimiter,
  readMagicLinkRateLimitConfig,
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
  undoLastGoalRequestSchema,
  updateGoalRequestSchema,
  upsertTeamRequestSchema,
} from "./contracts/core-write.js";
import {
  GameMutationStateError,
  GameTimerTransitionError,
  GoalCorrectionError,
  GoalCreationError,
  ThreeFcRepository,
} from "./data/repository.js";
import type { GameRecord } from "./data/types.js";
import { buildHealthResponse } from "./index.js";
import { logAuthRateLimit, logRequest, logRequestError } from "./logging.js";

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const TABLE_NAME = process.env.DYNAMODB_TABLE ?? "threefc_local";
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const FAKE_SES_URL = process.env.FAKE_SES_URL ?? "http://localhost:4025/send-email";
const FAKE_SES_FROM = process.env.FAKE_SES_FROM ?? "noreply@3fc.football";
const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";
const MAGIC_LINK_CALLBACK_PATH = process.env.MAGIC_LINK_CALLBACK_PATH ?? "/auth/callback";
const MAGIC_LINK_TOKEN_TTL_SECONDS = Number.parseInt(
  process.env.MAGIC_LINK_TOKEN_TTL_SECONDS ?? "900",
  10,
);
const MAGIC_LINK_SESSION_TTL_SECONDS = Number.parseInt(
  process.env.MAGIC_LINK_SESSION_TTL_SECONDS ?? "86400",
  10,
);
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "threefc_session";
const SESSION_COOKIE_SECURE = resolveSessionCookieSecureFlag(
  process.env.SESSION_COOKIE_SECURE,
  APP_BASE_URL,
);
const CORS_ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const DEV_ITEM_SK = "METADATA";

const ddbClient = new DynamoDBClient({
  region: REGION,
  endpoint: DYNAMODB_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
  },
});

const magicLinkEmailSender: MagicLinkEmailSender = {
  async sendMagicLink(input) {
    const sendResponse = await fetch(FAKE_SES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: input.to,
        from: FAKE_SES_FROM,
        subject: input.subject,
        body: input.body,
      }),
    });

    if (!sendResponse.ok) {
      throw new Error(`Magic-link email send failed with status ${sendResponse.status}.`);
    }

    const payload = (await sendResponse.json()) as { messageId?: unknown };

    return {
      messageId: typeof payload.messageId === "string" ? payload.messageId : undefined,
    };
  },
};

const magicLinkService = new MagicLinkService(ddbClient, magicLinkEmailSender, {
  tableName: TABLE_NAME,
  appBaseUrl: APP_BASE_URL,
  callbackPath: MAGIC_LINK_CALLBACK_PATH,
  tokenTtlSeconds: MAGIC_LINK_TOKEN_TTL_SECONDS,
  sessionTtlSeconds: MAGIC_LINK_SESSION_TTL_SECONDS,
});
const magicLinkRateLimiter = new AuthRateLimiter(
  ddbClient,
  TABLE_NAME,
  readMagicLinkRateLimitConfig(),
);
const repository = new ThreeFcRepository(ddbClient, TABLE_NAME);

type LocalFinishGameRouteRepository = Pick<
  ThreeFcRepository,
  | "getGame"
  | "finishGame"
  | "getLeagueAccess"
  | "getIdempotencyRecord"
  | "createIdempotencyRecord"
  | "listTeamsForSeason"
  | "createTeam"
  | "listTeamsForGame"
  | "createGameTeamOverride"
>;

type LocalUpdateGameTeamRouteRepository = Pick<
  ThreeFcRepository,
  "getGame" | "listTeamsForSeason" | "createTeam" | "listTeamsForGame" | "createGameTeamOverride"
>;

type LocalDeleteGameRouteRepository = Pick<ThreeFcRepository, "getGame" | "getLeagueAccess" | "deleteGame">;

type LocalIdempotencyRepository = Pick<
  ThreeFcRepository,
  "getIdempotencyRecord" | "createIdempotencyRecord"
>;

async function ensureTable(): Promise<void> {
  try {
    await ddbClient.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
  } catch (error) {
    const awsError = error as { name?: string };
    if (awsError.name !== "ResourceInUseException") {
      throw error;
    }
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendJsonWithCors(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  sendJson(response, statusCode, payload, {
    ...buildCorsHeaders(request.headers.origin, CORS_ALLOWED_ORIGINS),
    ...headers,
  });
}

function sendNoContentWithCors(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(204, {
    ...buildCorsHeaders(request.headers.origin, CORS_ALLOWED_ORIGINS),
  });
  response.end();
}

function getClientIp(request: IncomingMessage): string {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (Array.isArray(forwardedFor) && forwardedFor[0]?.trim()) {
    return forwardedFor[0].split(",")[0]?.trim() || "unknown";
  }

  if (typeof forwardedFor === "string" && forwardedFor.trim().length > 0) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return request.socket.remoteAddress ?? "unknown";
}

async function parseJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Uint8Array);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function badRequest(request: IncomingMessage, response: ServerResponse, message: string): number {
  sendJsonWithCors(request, response, 400, { error: message });
  return 400;
}

function forbiddenOrigin(request: IncomingMessage, response: ServerResponse): number {
  sendJsonWithCors(request, response, 403, {
    error: "forbidden_origin",
    message: "State-changing requests must originate from an allowed app domain.",
  });
  return 403;
}

function rateLimited(
  request: IncomingMessage,
  response: ServerResponse,
  retryAfterSeconds: number,
): number {
  sendJsonWithCors(
    request,
    response,
    429,
    {
      error: "rate_limited",
      message: "Too many sign-in link requests. Try again later.",
      retryAfterSeconds,
    },
    {
      "Retry-After": String(retryAfterSeconds),
    },
  );
  return 429;
}

function forbidden(
  request: IncomingMessage,
  response: ServerResponse,
  code: string,
  message: string,
): number {
  sendJsonWithCors(request, response, 403, {
    error: "forbidden",
    code,
    message,
  });
  return 403;
}

function notFound(request: IncomingMessage, response: ServerResponse, message: string): number {
  sendJsonWithCors(request, response, 404, {
    error: "not_found",
    message,
  });
  return 404;
}

function conflict(request: IncomingMessage, response: ServerResponse, message: string): number {
  sendJsonWithCors(request, response, 409, {
    error: "conflict",
    message,
  });
  return 409;
}

async function ensureLeagueAccess(
  leagueId: string,
  userId: string,
  repositoryClient: Pick<ThreeFcRepository, "getLeagueAccess"> = repository,
): Promise<{ allowed: boolean; role: "admin" | "scorekeeper" | "viewer" | null }> {
  const access = await repositoryClient.getLeagueAccess(leagueId, userId);
  if (!access) {
    return {
      allowed: false,
      role: null,
    };
  }

  return {
    allowed: true,
    role: access.role,
  };
}

async function ensureLeagueAdmin(
  leagueId: string,
  userId: string,
  repositoryClient: Pick<ThreeFcRepository, "getLeagueAccess"> = repository,
): Promise<boolean> {
  const access = await repositoryClient.getLeagueAccess(leagueId, userId);
  return access?.role === "admin";
}

async function ensureLeagueRole(
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
  finishedAt: string | null;
  result: GameResult | null;
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

function timerTransitionConflict(
  request: IncomingMessage,
  response: ServerResponse,
  error: GameTimerTransitionError,
): number {
  sendJsonWithCors(request, response, 409, {
    error: "conflict",
    code: error.code,
    message: error.message,
  });
  return 409;
}

function goalCreationError(
  request: IncomingMessage,
  response: ServerResponse,
  error: GoalCreationError,
): number {
  sendJsonWithCors(request, response, error.statusCode, {
    error: error.statusCode === 409 ? "conflict" : "bad_request",
    code: error.code,
    message: error.message,
  });
  return error.statusCode;
}

function goalCorrectionError(
  request: IncomingMessage,
  response: ServerResponse,
  error: GoalCorrectionError,
): number {
  sendJsonWithCors(request, response, error.statusCode, {
    error: error.statusCode === 409 ? "conflict" : "bad_request",
    code: error.code,
    message: error.message,
  });
  return error.statusCode;
}

async function buildFinishedGameMutationBlock(
  game: { gameId: string; leagueId: string; status: "scheduled" | "live" | "finished" },
  sessionEmail: string,
  repositoryClient: Pick<ThreeFcRepository, "getLeagueAccess"> = repository,
): Promise<{ statusCode: 409; payload: { error: "conflict"; code: "game_finished"; message: string } } | null> {
  if (game.status !== "finished") {
    return null;
  }

  const access = await ensureLeagueAccess(game.leagueId, sessionEmail, repositoryClient);
  if (access.role === "admin") {
    return null;
  }

  return {
    statusCode: 409,
    payload: {
      error: "conflict",
      code: "game_finished",
      message: `Game ${game.gameId} is finished. Admin role is required to mutate finished games.`,
    },
  };
}

function finishedGameTeamOverrideConflict(
  request: IncomingMessage,
  response: ServerResponse,
  gameId: string,
): number {
  sendJsonWithCors(request, response, 409, {
    error: "conflict",
    code: "game_finished",
    message: `Game ${gameId} is finished. Team overrides are locked after finish.`,
  });
  return 409;
}

function finishedGameGoalMutationPayload(): { error: "conflict"; code: "game_finished"; message: string } {
  return {
    error: "conflict",
    code: "game_finished",
    message: "Cannot create a goal after the game is finished.",
  };
}

function finishedGameDeleteConflict(
  request: IncomingMessage,
  response: ServerResponse,
  gameId: string,
): number {
  sendJsonWithCors(request, response, 409, {
    error: "conflict",
    code: "game_finished",
    message: `Game ${gameId} is finished. Finished games cannot be deleted.`,
  });
  return 409;
}

async function ensureFinishedGameMutationAllowed(
  request: IncomingMessage,
  response: ServerResponse,
  game: { gameId: string; leagueId: string; status: "scheduled" | "live" | "finished" },
  sessionEmail: string,
): Promise<{ allowed: boolean; status: number }> {
  const block = await buildFinishedGameMutationBlock(game, sessionEmail);
  if (!block) {
    return { allowed: true, status: 200 };
  }

  sendJsonWithCors(request, response, block.statusCode, block.payload);
  return { allowed: false, status: block.statusCode };
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

async function readSeasonTeams(season: {
  seasonId: string;
  createdAt: string;
  updatedAt: string;
}) {
  const existingTeams = await repository.listTeamsForSeason(season.seasonId);
  return buildReadOnlySeasonTeams(season, existingTeams);
}

async function ensureSeasonDefaultTeams(
  seasonId: string,
  repositoryClient: Pick<ThreeFcRepository, "listTeamsForSeason" | "createTeam"> = repository,
) {
  const existingTeams = await repositoryClient.listTeamsForSeason(seasonId, {
    consistentRead: true,
  });
  const teamsById = new Map(existingTeams.map((team) => [team.teamId, team]));

  for (const defaultTeam of DEFAULT_TEAMS) {
    if (teamsById.has(defaultTeam.teamId)) {
      continue;
    }

    const createdTeam = await repositoryClient.createTeam({
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
  game: { gameId: string; seasonId: string },
  repositoryClient: Pick<
    ThreeFcRepository,
    "listTeamsForSeason" | "createTeam" | "listTeamsForGame" | "createGameTeamOverride"
  > = repository,
  options: { allowFinished?: boolean } = {},
) {
  const seasonTeams = await ensureSeasonDefaultTeams(game.seasonId, repositoryClient);
  const existingGameTeams = await repositoryClient.listTeamsForGame(game.gameId, {
    consistentRead: true,
  });
  const gameTeamsById = new Map(existingGameTeams.map((team) => [team.teamId, team]));

  for (const seasonTeam of seasonTeams) {
    if (gameTeamsById.has(seasonTeam.teamId)) {
      continue;
    }

    const gameTeam = await repositoryClient.createGameTeamOverride({
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

function isCompleteFinishedGame(game: GameRecord | null): game is GameRecord {
  const resultTeams = game?.result?.teams ?? [];
  const resultTeamIds = new Set(resultTeams.map((team) => team.teamId));
  return (
    game?.status === "finished" &&
    Boolean(game.finishedAt && game.result) &&
    resultTeams.length === TEAM_IDS.length &&
    TEAM_IDS.every((teamId) => resultTeamIds.has(teamId))
  );
}

async function waitForIdempotencyRecord(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function readGameTeams(game: {
  gameId: string;
  seasonId: string;
  createdAt: string;
  updatedAt: string;
}) {
  const season = await repository.getSeason(game.seasonId);
  const existingGameTeams = await repository.listTeamsForGame(game.gameId);
  const gameTeamsById = new Map(existingGameTeams.map((team) => [team.teamId, team]));
  const seasonTeams = season
    ? await readSeasonTeams(season)
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

async function buildRosterResponse(game: {
  gameId: string;
  seasonId: string;
  createdAt: string;
  updatedAt: string;
}) {
  const teams = await readGameTeams(game);
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
  const parsed: {
    status?: "scheduled" | "live" | "finished";
    gameStartTs?: string;
    thirdLengthMinutes?: ThirdLengthMinutes;
  } = {};

  if (rawBody.status !== undefined) {
    if (
      typeof rawBody.status !== "string" ||
      !["scheduled", "live", "finished"].includes(rawBody.status)
    ) {
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

function idempotencyConflict(request: IncomingMessage, response: ServerResponse): number {
  sendJsonWithCors(request, response, 409, {
    error: "idempotency_conflict",
    message: "Idempotency key has already been used with a different payload.",
  });
  return 409;
}

function readHeaderValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function normalizePayloadForHashing(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePayloadForHashing(entry));
  }

  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const normalizedEntries = Object.keys(source)
      .sort()
      .map((key) => [key, normalizePayloadForHashing(source[key])] as const);
    return Object.fromEntries(normalizedEntries);
  }

  return value;
}

function buildIdempotencyScope(sessionEmail: string, method: string, route: string): string {
  return `${sessionEmail}:${method}:${route}`;
}

function buildIdempotencyRequestHash(scope: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${scope}:${JSON.stringify(normalizePayloadForHashing(payload))}`)
    .digest("hex");
}

function buildGoalEventId(input: {
  request: IncomingMessage;
  sessionEmail: string;
  method: string;
  route: string;
}): string {
  const rawIdempotencyKey = readHeaderValue(input.request, "idempotency-key");
  const parsedIdempotencyKey = rawIdempotencyKey
    ? idempotencyKeyHeaderSchema.safeParse(rawIdempotencyKey)
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
  request: IncomingMessage;
  sessionEmail: string;
  method: string;
  route: string;
  requestPayload: unknown;
}): { operationId: string; operationRequestHash: string } | null {
  const rawIdempotencyKey = readHeaderValue(input.request, "idempotency-key");
  const parsedIdempotencyKey = rawIdempotencyKey
    ? idempotencyKeyHeaderSchema.safeParse(rawIdempotencyKey)
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

interface JsonMutationResult {
  statusCode: number;
  payload: unknown;
}

async function recoverLocalFinishedGameForFinishRoute(input: {
  repositoryClient: LocalFinishGameRouteRepository;
  gameId: string;
}): Promise<JsonMutationResult | null> {
  const current = await input.repositoryClient.getGame(input.gameId, {
    consistentRead: true,
  });
  if (!current || current.status !== "finished") {
    return null;
  }

  if (isCompleteFinishedGame(current)) {
    return {
      statusCode: 200,
      payload: buildGameResponse(current),
    };
  }

  let repaired: GameRecord | null = null;
  try {
    await ensureGameTeamsForGame(current, input.repositoryClient, { allowFinished: true });
    repaired = await input.repositoryClient.finishGame({ gameId: input.gameId });
  } catch (error) {
    const isRetryableRepairConflict =
      error instanceof GameMutationStateError ||
      (error instanceof GameTimerTransitionError && error.code === "game_state_changed");
    if (!isRetryableRepairConflict) {
      throw error;
    }

    repaired = await input.repositoryClient.getGame(input.gameId, {
      consistentRead: true,
    });
  }

  if (!isCompleteFinishedGame(repaired)) {
    return null;
  }

  return {
    statusCode: 200,
    payload: buildGameResponse(repaired),
  };
}

async function readStoredIdempotentMutation(input: {
  request: IncomingMessage;
  sessionEmail: string;
  method: string;
  route: string;
  requestPayload: unknown;
  repositoryClient: LocalIdempotencyRepository;
}): Promise<JsonMutationResult | null> {
  const idempotencyKeyRaw = readHeaderValue(input.request, "idempotency-key");
  if (!idempotencyKeyRaw) {
    return null;
  }

  const parsedHeader = idempotencyKeyHeaderSchema.safeParse(idempotencyKeyRaw);
  if (!parsedHeader.success) {
    return null;
  }

  const scope = buildIdempotencyScope(input.sessionEmail, input.method, input.route);
  const requestHash = buildIdempotencyRequestHash(scope, input.requestPayload);
  const existing = await input.repositoryClient.getIdempotencyRecord(scope, parsedHeader.data);
  if (!existing || existing.requestHash !== requestHash) {
    return null;
  }

  return {
    statusCode: existing.responseStatusCode,
    payload: parseStoredIdempotencyResponseBody(existing.responseBody),
  };
}

async function executeIdempotentMutation(input: {
  request: IncomingMessage;
  response: ServerResponse;
  sessionEmail: string;
  method: string;
  route: string;
  requestPayload: unknown;
  execute: () => Promise<JsonMutationResult>;
  repositoryClient?: LocalIdempotencyRepository;
}): Promise<number> {
  const repositoryClient = input.repositoryClient ?? repository;
  const idempotencyKeyRaw = readHeaderValue(input.request, "idempotency-key");

  if (!idempotencyKeyRaw) {
    const mutation = await input.execute();
    sendJsonWithCors(input.request, input.response, mutation.statusCode, mutation.payload);
    return mutation.statusCode;
  }

  const parsedHeader = idempotencyKeyHeaderSchema.safeParse(idempotencyKeyRaw);
  if (!parsedHeader.success) {
    return badRequest(
      input.request,
      input.response,
      formatSchemaValidationError(parsedHeader.error),
    );
  }

  const scope = buildIdempotencyScope(input.sessionEmail, input.method, input.route);
  const key = parsedHeader.data;
  const requestHash = buildIdempotencyRequestHash(scope, input.requestPayload);

  const existing = await repositoryClient.getIdempotencyRecord(scope, key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return idempotencyConflict(input.request, input.response);
    }

    sendJsonWithCors(
      input.request,
      input.response,
      existing.responseStatusCode,
      parseStoredIdempotencyResponseBody(existing.responseBody),
    );
    return existing.responseStatusCode;
  }

  const mutation = await input.execute();
  const mutationBody = JSON.stringify(mutation.payload);
  const created = await repositoryClient.createIdempotencyRecord({
    scope,
    key,
    requestHash,
    responseStatusCode: mutation.statusCode,
    responseBody: mutationBody,
  });

  if (!created) {
    const raceRecord = await repositoryClient.getIdempotencyRecord(scope, key);
    if (raceRecord) {
      if (raceRecord.requestHash !== requestHash) {
        return idempotencyConflict(input.request, input.response);
      }

      sendJsonWithCors(
        input.request,
        input.response,
        raceRecord.responseStatusCode,
        parseStoredIdempotencyResponseBody(raceRecord.responseBody),
      );
      return raceRecord.responseStatusCode;
    }
  }

  sendJsonWithCors(input.request, input.response, mutation.statusCode, mutation.payload);
  return mutation.statusCode;
}

export async function handleLocalFinishGameRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  route: string;
  gameId: string;
  sessionEmail: string;
  repositoryClient?: LocalFinishGameRouteRepository;
}): Promise<number> {
  const repositoryClient = input.repositoryClient ?? repository;

  try {
    return await executeIdempotentMutation({
      request: input.request,
      response: input.response,
      sessionEmail: input.sessionEmail,
      method: input.method,
      route: input.route,
      requestPayload: {},
      repositoryClient,
      execute: async () => {
        const currentGame = await repositoryClient.getGame(input.gameId);
        if (!currentGame) {
          return {
            statusCode: 404,
            payload: {
              error: "not_found",
              message: `Game ${input.gameId} was not found.`,
            },
          };
        }

        try {
          await ensureGameTeamsForGame(currentGame, repositoryClient);
        } catch (error) {
          if (error instanceof GameMutationStateError) {
            const recovered = await recoverLocalFinishedGameForFinishRoute({
              repositoryClient,
              gameId: input.gameId,
            });
            if (recovered) {
              return recovered;
            }

            return {
              statusCode: 409,
              payload: {
                error: "conflict",
                code: error.code,
                message: error.message,
              },
            };
          }

          throw error;
        }
        let result;
        try {
          result = await repositoryClient.finishGame({ gameId: input.gameId });
        } catch (error) {
          if (error instanceof GameTimerTransitionError) {
            if (error.code === "game_state_changed") {
              const replay = await readStoredIdempotentMutation({
                request: input.request,
                sessionEmail: input.sessionEmail,
                method: input.method,
                route: input.route,
                requestPayload: {},
                repositoryClient,
              });
              if (replay && replay.statusCode >= 200 && replay.statusCode < 300) {
                return replay;
              }

              const recovered = await recoverLocalFinishedGameForFinishRoute({
                repositoryClient,
                gameId: input.gameId,
              });
              if (recovered) {
                return recovered;
              }

              await waitForIdempotencyRecord();
              const replayAfterWait = await readStoredIdempotentMutation({
                request: input.request,
                sessionEmail: input.sessionEmail,
                method: input.method,
                route: input.route,
                requestPayload: {},
                repositoryClient,
              });
              if (replayAfterWait) {
                return replayAfterWait;
              }

              const recoveredAfterWait = await recoverLocalFinishedGameForFinishRoute({
                repositoryClient,
                gameId: input.gameId,
              });
              if (recoveredAfterWait) {
                return recoveredAfterWait;
              }

              let retryFailure: unknown = null;
              try {
                result = await repositoryClient.finishGame({ gameId: input.gameId });
              } catch (retryError) {
                if (
                  retryError instanceof GameTimerTransitionError &&
                  retryError.code === "game_state_changed"
                ) {
                  const recoveredAfterRetry = await recoverLocalFinishedGameForFinishRoute({
                    repositoryClient,
                    gameId: input.gameId,
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

              if (replay) {
                return replay;
              }
            }

            if (!result) {
              return {
                statusCode: 409,
                payload: {
                  error: "conflict",
                  code: error.code,
                  message: error.message,
                },
              };
            }
          }

          if (!(error instanceof GameTimerTransitionError)) {
            throw error;
          }

          if (!result) {
            return {
              statusCode: 409,
              payload: {
                error: "conflict",
                code: error.code,
                message: error.message,
              },
            };
          }
        }
        if (!result) {
          return {
            statusCode: 404,
            payload: {
              error: "not_found",
              message: `Game ${input.gameId} was not found.`,
            },
          };
        }

        return {
          statusCode: 200,
          payload: buildGameResponse(result),
        };
      },
    });
  } catch (error) {
    if (error instanceof GameTimerTransitionError) {
      return timerTransitionConflict(input.request, input.response, error);
    }

    throw error;
  }
}

export async function handleLocalUpdateGameTeamRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  gameId: string;
  teamId: TeamId;
  repositoryClient?: LocalUpdateGameTeamRouteRepository;
}): Promise<number> {
  const repositoryClient = input.repositoryClient ?? repository;
  const game = await repositoryClient.getGame(input.gameId);
  if (!game) {
    return notFound(input.request, input.response, `Game ${input.gameId} was not found.`);
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await parseJsonBody(input.request);
  } catch {
    return badRequest(input.request, input.response, "Request body must be valid JSON.");
  }

  const parsedBody = upsertTeamRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return badRequest(input.request, input.response, formatSchemaValidationError(parsedBody.error));
  }

  let team;
  try {
    await ensureGameTeamsForGame(game, repositoryClient);
    team = await repositoryClient.createGameTeamOverride({
      gameId: input.gameId,
      teamId: input.teamId,
      name: parsedBody.data.name,
      color: parsedBody.data.color ?? null,
      allowFinished: game.status === "finished",
    });
  } catch (error) {
    if (error instanceof GameMutationStateError) {
      const currentGame = await repositoryClient.getGame(input.gameId);
      if (
        error.code === "game_finished" ||
        (game.status !== "finished" && currentGame?.status === "finished")
      ) {
        return finishedGameTeamOverrideConflict(input.request, input.response, input.gameId);
      }

      sendJsonWithCors(input.request, input.response, 409, {
        error: "conflict",
        code: error.code,
        message: error.message,
      });
      return 409;
    }

    throw error;
  }
  sendJsonWithCors(input.request, input.response, 200, team);
  return 200;
}

export async function handleLocalDeleteGameRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  gameId: string;
  sessionEmail: string;
  repositoryClient?: LocalDeleteGameRouteRepository;
}): Promise<number> {
  const repositoryClient = input.repositoryClient ?? repository;
  const game = await repositoryClient.getGame(input.gameId);
  if (!game) {
    return notFound(input.request, input.response, `Game ${input.gameId} was not found.`);
  }

  const isAdmin = await ensureLeagueAdmin(game.leagueId, input.sessionEmail, repositoryClient);
  if (!isAdmin) {
    return forbidden(
      input.request,
      input.response,
      "admin_required",
      `Admin role is required for league ${game.leagueId}.`,
    );
  }

  if (game.status === "finished") {
    return finishedGameDeleteConflict(input.request, input.response, input.gameId);
  }

  const deleted = await repositoryClient.deleteGame(input.gameId);
  if (!deleted) {
    const currentGame = await repositoryClient.getGame(input.gameId);
    if (currentGame?.status === "finished") {
      return finishedGameDeleteConflict(input.request, input.response, input.gameId);
    }
    if (!currentGame) {
      return notFound(input.request, input.response, `Game ${input.gameId} was not found.`);
    }

    sendJsonWithCors(input.request, input.response, 409, {
      error: "conflict",
      code: "game_state_changed",
      message: `Game ${input.gameId} changed before it could be deleted. Reload and try again.`,
    });
    return 409;
  }

  sendNoContentWithCors(input.request, input.response);
  return 204;
}

interface AclGateResult {
  allowed: boolean;
  status: number;
  scope: { leagueId: string; seasonId?: string; sessionId?: string } | null;
}

async function enforceAclIfRequired(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  route: string,
  session: AuthSessionRecord | null,
): Promise<AclGateResult> {
  if (!session) {
    return {
      allowed: true,
      status: 200,
      scope: null,
    };
  }

  const aclResult = await authorizeProtectedMutation(method, route, session.email, repository);
  if (!aclResult.allowed) {
    sendJsonWithCors(request, response, aclResult.statusCode, aclResult.error);
    return {
      allowed: false,
      status: aclResult.statusCode,
      scope: null,
    };
  }

  return {
    allowed: true,
    status: 200,
    scope: aclResult.scope,
  };
}

async function handleCreateLeague(
  request: IncomingMessage,
  response: ServerResponse,
  session: AuthSessionRecord,
  method: string,
  route: string,
): Promise<number> {
  let rawBody: Record<string, unknown>;

  try {
    rawBody = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  const parsedBody = createLeagueRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return badRequest(request, response, formatSchemaValidationError(parsedBody.error));
  }

  return executeIdempotentMutation({
    request,
    response,
    sessionEmail: session.email,
    method,
    route,
    requestPayload: parsedBody.data,
    execute: async () => {
      const league = await repository.createLeague({
        leagueId: parsedBody.data.leagueId,
        name: parsedBody.data.name,
        slug: parsedBody.data.slug ?? null,
        createdByUserId: session.email,
      });

      return {
        statusCode: 201,
        payload: league,
      };
    },
  });
}

async function handleCreateSeason(
  request: IncomingMessage,
  response: ServerResponse,
  leagueId: string,
  sessionEmail: string,
  method: string,
  route: string,
): Promise<number> {
  let rawBody: Record<string, unknown>;

  try {
    rawBody = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  const parsedBody = createSeasonRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return badRequest(request, response, formatSchemaValidationError(parsedBody.error));
  }

  return executeIdempotentMutation({
    request,
    response,
    sessionEmail,
    method,
    route,
    requestPayload: parsedBody.data,
    execute: async () => {
      const season = await repository.createSeason({
        leagueId,
        seasonId: parsedBody.data.seasonId,
        name: parsedBody.data.name,
        slug: parsedBody.data.slug ?? null,
        startsOn: parsedBody.data.startsOn ?? null,
        endsOn: parsedBody.data.endsOn ?? null,
      });
      await ensureSeasonDefaultTeams(season.seasonId);

      return {
        statusCode: 201,
        payload: season,
      };
    },
  });
}

async function handleCreateSession(
  request: IncomingMessage,
  response: ServerResponse,
  seasonId: string,
  sessionEmail: string,
  method: string,
  route: string,
): Promise<number> {
  let rawBody: Record<string, unknown>;

  try {
    rawBody = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  const parsedBody = createSessionRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return badRequest(request, response, formatSchemaValidationError(parsedBody.error));
  }

  return executeIdempotentMutation({
    request,
    response,
    sessionEmail,
    method,
    route,
    requestPayload: parsedBody.data,
    execute: async () => {
      const session = await repository.createSession({
        seasonId,
        sessionId: parsedBody.data.sessionId,
        sessionDate: parsedBody.data.sessionDate,
      });

      return {
        statusCode: 201,
        payload: session,
      };
    },
  });
}

async function handleCreateGame(
  request: IncomingMessage,
  response: ServerResponse,
  scope: { leagueId: string; seasonId: string; sessionId: string },
  sessionEmail: string,
  method: string,
  route: string,
): Promise<number> {
  let rawBody: Record<string, unknown>;

  try {
    rawBody = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  const parsedBody = createGameRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return badRequest(request, response, formatSchemaValidationError(parsedBody.error));
  }

  return executeIdempotentMutation({
    request,
    response,
    sessionEmail,
    method,
    route,
    requestPayload: parsedBody.data,
    execute: async () => {
      const game = await repository.createGame({
        gameId: parsedBody.data.gameId,
        leagueId: scope.leagueId,
        seasonId: scope.seasonId,
        sessionId: scope.sessionId,
        status: parsedBody.data.status,
        gameStartTs: parsedBody.data.gameStartTs,
        thirdLengthMinutes: parsedBody.data.thirdLengthMinutes,
      });

      await repository.createSessionGame({
        sessionId: scope.sessionId,
        gameId: game.gameId,
        gameStartTs: game.gameStartTs,
        leagueId: game.leagueId,
        seasonId: game.seasonId,
      });
      await ensureGameTeamsForGame(game);

      return {
        statusCode: 201,
        payload: buildGameResponse(game),
      };
    },
  });
}

async function handleCreateDevItem(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<number> {
  const body = await parseJsonBody(request);

  if (typeof body.id !== "string" || body.id.length === 0) {
    return badRequest(request, response, "Field `id` is required and must be a non-empty string.");
  }

  const record = {
    id: body.id,
    value: body.value ?? null,
    createdAt: new Date().toISOString(),
  };

  await ddbClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: { S: body.id },
        sk: { S: DEV_ITEM_SK },
        data: { S: JSON.stringify(record) },
      },
    }),
  );

  sendJsonWithCors(request, response, 201, record);
  return 201;
}

async function handleGetDevItem(
  request: IncomingMessage,
  itemId: string,
  response: ServerResponse,
): Promise<number> {
  const output = await ddbClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: itemId },
        sk: { S: DEV_ITEM_SK },
      },
    }),
  );

  if (!output.Item?.data?.S) {
    sendJsonWithCors(request, response, 404, { error: "Not found" });
    return 404;
  }

  sendJsonWithCors(request, response, 200, JSON.parse(output.Item.data.S));
  return 200;
}

async function handleSendDevEmail(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<number> {
  const body = await parseJsonBody(request);

  if (typeof body.to !== "string" || body.to.length === 0) {
    return badRequest(request, response, "Field `to` is required.");
  }

  if (typeof body.subject !== "string" || body.subject.length === 0) {
    return badRequest(request, response, "Field `subject` is required.");
  }

  if (typeof body.body !== "string") {
    return badRequest(request, response, "Field `body` must be a string.");
  }

  const sendResponse = await fetch(FAKE_SES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: body.to,
      from: FAKE_SES_FROM,
      subject: body.subject,
      body: body.body,
    }),
  });

  if (!sendResponse.ok) {
    sendJsonWithCors(request, response, 502, {
      error: "Failed to hand off to fake SES",
      statusCode: sendResponse.status,
    });
    return 502;
  }

  const payload = (await sendResponse.json()) as Record<string, unknown>;
  sendJsonWithCors(request, response, 202, {
    status: "queued",
    messageId: payload.messageId,
  });
  return 202;
}

function handleMagicLinkError(
  request: IncomingMessage,
  error: unknown,
  response: ServerResponse,
): number {
  if (!(error instanceof MagicLinkAuthError)) {
    throw error;
  }

  sendJsonWithCors(request, response, error.statusCode, {
    error: error.code,
    message: error.message,
  });

  return error.statusCode;
}

async function handleMagicLinkStart(
  request: IncomingMessage,
  response: ServerResponse,
  context: { requestId: string; route: string; method: string },
): Promise<number> {
  if (
    !isMagicLinkStartOriginPermitted(
      context.method,
      context.route,
      request.headers.origin,
      CORS_ALLOWED_ORIGINS,
    )
  ) {
    return forbiddenOrigin(request, response);
  }

  let body: Record<string, unknown>;

  try {
    body = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  if (typeof body.email !== "string") {
    return badRequest(request, response, "Field `email` is required.");
  }

  const email = normalizeMagicLinkEmail(body.email);
  if (!isMagicLinkEmailLike(email)) {
    return handleMagicLinkError(
      request,
      new MagicLinkAuthError("invalid_email", 400, "Email must be a valid email address."),
      response,
    );
  }

  const rateLimitDecision = await magicLinkRateLimiter.consumeMagicLinkStart({
    email,
    clientIp: getClientIp(request),
  });
  if (!rateLimitDecision.allowed) {
    logAuthRateLimit({
      requestId: context.requestId,
      route: context.route,
      method: context.method,
      status: 429,
      dimension: rateLimitDecision.dimension,
      retryAfterSeconds: rateLimitDecision.retryAfterSeconds,
    });
    return rateLimited(request, response, rateLimitDecision.retryAfterSeconds);
  }

  try {
    const result = await magicLinkService.start(email);

    sendJsonWithCors(request, response, 202, {
      status: "sent",
      email: result.email,
      expiresAt: result.expiresAt,
      messageId: result.messageId,
    });

    return 202;
  } catch (error) {
    return handleMagicLinkError(request, error, response);
  }
}

async function handleMagicLinkComplete(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<number> {
  let body: Record<string, unknown>;

  try {
    body = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  if (typeof body.token !== "string") {
    return badRequest(request, response, "Field `token` is required.");
  }

  try {
    const session = await magicLinkService.complete(body.token);

    sendJsonWithCors(
      request,
      response,
      200,
      {
        status: "authenticated",
        session: {
          sessionId: session.sessionId,
          email: session.email,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        },
      },
      {
        "Set-Cookie": buildSessionCookie(
          SESSION_COOKIE_NAME,
          session.sessionId,
          session.maxAgeSeconds,
          SESSION_COOKIE_SECURE,
        ),
      },
    );

    return 200;
  } catch (error) {
    return handleMagicLinkError(request, error, response);
  }
}

async function handleGetAuthSession(
  request: IncomingMessage,
  response: ServerResponse,
  session: AuthSessionRecord,
): Promise<number> {
  sendJsonWithCors(request, response, 200, {
    authenticated: true,
    session,
  });

  return 200;
}

interface AuthGateResult {
  allowed: boolean;
  session: AuthSessionRecord | null;
  status: number;
}

async function enforceSessionIfRequired(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  route: string,
): Promise<AuthGateResult> {
  if (!isAuthenticatedApiRoute(method, route)) {
    return { allowed: true, session: null, status: 200 };
  }

  const sessionResolution = await resolveSessionFromCookie(
    request.headers.cookie,
    SESSION_COOKIE_NAME,
    magicLinkService,
  );
  if (sessionResolution.failure === "missing_cookie") {
    sendJsonWithCors(request, response, 401, {
      error: "unauthorized",
      message: "Valid session cookie required.",
    });

    return { allowed: false, session: null, status: 401 };
  }
  if (sessionResolution.failure === "invalid_session") {
    sendJsonWithCors(request, response, 401, {
      error: "unauthorized",
      message: "Session is missing, invalid, or expired.",
    });

    return { allowed: false, session: null, status: 401 };
  }

  return { allowed: true, session: sessionResolution.session, status: 200 };
}

function getRequestId(request: IncomingMessage): string {
  const header = request.headers["x-request-id"];

  if (Array.isArray(header) && header.length > 0 && header[0].length > 0) {
    return header[0];
  }

  if (typeof header === "string" && header.length > 0) {
    return header;
  }

  return randomUUID();
}

async function start(): Promise<void> {
  await ensureTable();

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const route = requestUrl.pathname;
    const method = request.method ?? "GET";
    const requestId = getRequestId(request);
    let status = 500;

    try {
      if (method === "OPTIONS" && route.startsWith("/v1/")) {
        status = 204;
        sendNoContentWithCors(request, response);
        return;
      }

      if (!isStateChangeOriginPermitted(method, request.headers.origin, CORS_ALLOWED_ORIGINS)) {
        status = forbiddenOrigin(request, response);
        return;
      }

      const authGate = await enforceSessionIfRequired(request, response, method, route);
      if (!authGate.allowed) {
        status = authGate.status;
        return;
      }

      const aclGate = await enforceAclIfRequired(request, response, method, route, authGate.session);
      if (!aclGate.allowed) {
        status = aclGate.status;
        return;
      }

      if (method === "GET" && route === "/v1/health") {
        status = 200;
        sendJsonWithCors(request, response, status, buildHealthResponse());
        return;
      }

      if (method === "POST" && route === "/v1/dev/items") {
        status = await handleCreateDevItem(request, response);
        return;
      }

      if (method === "GET" && route.startsWith("/v1/dev/items/")) {
        const itemId = route.replace("/v1/dev/items/", "");
        status = await handleGetDevItem(request, itemId, response);
        return;
      }

      if (method === "POST" && route === "/v1/dev/send-email") {
        status = await handleSendDevEmail(request, response);
        return;
      }

      if (method === "POST" && route === "/v1/auth/magic/start") {
        status = await handleMagicLinkStart(request, response, { requestId, route, method });
        return;
      }

      if (method === "POST" && route === "/v1/auth/magic/complete") {
        status = await handleMagicLinkComplete(request, response);
        return;
      }

      if (
        authGate.session &&
        method === "GET" &&
        route === "/v1/leagues"
      ) {
        const leagues = await repository.listLeaguesForUser(authGate.session.email);
        status = 200;
        sendJsonWithCors(request, response, status, {
          leagues,
        });
        return;
      }

      if (method === "POST" && route === "/v1/leagues") {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        status = await handleCreateLeague(request, response, authGate.session, method, route);
        return;
      }

      const getLeagueMatch = route.match(/^\/v1\/leagues\/([^/]+)$/);
      if (method === "GET" && getLeagueMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const leagueId = decodeURIComponent(getLeagueMatch[1]);
        const access = await ensureLeagueAccess(leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${leagueId} is required.`,
          );
          return;
        }

        const league = await repository.getLeague(leagueId);
        if (!league) {
          status = notFound(request, response, `League ${leagueId} was not found.`);
          return;
        }

        status = 200;
        sendJsonWithCors(request, response, status, league);
        return;
      }

      const createSeasonMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons$/);
      if (method === "POST" && createSeasonMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        status = await handleCreateSeason(
          request,
          response,
          aclGate.scope?.leagueId ?? decodeURIComponent(createSeasonMatch[1]),
          authGate.session.email,
          method,
          route,
        );
        return;
      }

      const listSeasonsMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons$/);
      if (method === "GET" && listSeasonsMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const leagueId = decodeURIComponent(listSeasonsMatch[1]);
        const access = await ensureLeagueAccess(leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${leagueId} is required.`,
          );
          return;
        }

        const seasons = await repository.listSeasonsForLeague(leagueId);
        status = 200;
        sendJsonWithCors(request, response, status, {
          seasons,
        });
        return;
      }

      const deleteLeagueMatch = route.match(/^\/v1\/leagues\/([^/]+)$/);
      if (method === "DELETE" && deleteLeagueMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const leagueId = decodeURIComponent(deleteLeagueMatch[1]);
        const isAdmin = await ensureLeagueAdmin(leagueId, authGate.session.email);
        if (!isAdmin) {
          status = forbidden(
            request,
            response,
            "admin_required",
            `Admin role is required for league ${leagueId}.`,
          );
          return;
        }

        try {
          const deleted = await repository.deleteLeague(leagueId);
          if (!deleted) {
            status = notFound(request, response, `League ${leagueId} was not found.`);
            return;
          }
        } catch (error) {
          if (error instanceof Error && /Cannot delete league/.test(error.message)) {
            status = conflict(request, response, error.message);
            return;
          }

          throw error;
        }

        status = 204;
        sendNoContentWithCors(request, response);
        return;
      }

      const createSessionMatch = route.match(/^\/v1\/seasons\/([^/]+)\/sessions$/);
      if (method === "POST" && createSessionMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        status = await handleCreateSession(
          request,
          response,
          aclGate.scope?.seasonId ?? decodeURIComponent(createSessionMatch[1]),
          authGate.session.email,
          method,
          route,
        );
        return;
      }

      const getSeasonMatch = route.match(/^\/v1\/seasons\/([^/]+)$/);
      if (method === "GET" && getSeasonMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const seasonId = decodeURIComponent(getSeasonMatch[1]);
        const season = await repository.getSeason(seasonId);
        if (!season) {
          status = notFound(request, response, `Season ${seasonId} was not found.`);
          return;
        }

        const access = await ensureLeagueAccess(season.leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${season.leagueId} is required.`,
          );
          return;
        }

        status = 200;
        sendJsonWithCors(request, response, status, season);
        return;
      }

      const listSeasonGamesMatch = route.match(/^\/v1\/seasons\/([^/]+)\/games$/);
      if (method === "GET" && listSeasonGamesMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const seasonId = decodeURIComponent(listSeasonGamesMatch[1]);
        const season = await repository.getSeason(seasonId);
        if (!season) {
          status = notFound(request, response, `Season ${seasonId} was not found.`);
          return;
        }

        const access = await ensureLeagueAccess(season.leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${season.leagueId} is required.`,
          );
          return;
        }

        const games = await repository.listGamesForSeason(seasonId);
        status = 200;
        sendJsonWithCors(request, response, status, {
          games: games.map((game) => buildGameResponse(game)),
        });
        return;
      }

      const listSeasonTeamsMatch = route.match(/^\/v1\/seasons\/([^/]+)\/teams$/);
      if (method === "GET" && listSeasonTeamsMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const seasonId = decodeURIComponent(listSeasonTeamsMatch[1]);
        const season = await repository.getSeason(seasonId);
        if (!season) {
          status = notFound(request, response, `Season ${seasonId} was not found.`);
          return;
        }

        const access = await ensureLeagueAccess(season.leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${season.leagueId} is required.`,
          );
          return;
        }

        const teams = await readSeasonTeams(season);
        status = 200;
        sendJsonWithCors(request, response, status, {
          teams,
        });
        return;
      }

      const updateSeasonTeamMatch = route.match(/^\/v1\/seasons\/([^/]+)\/teams\/([^/]+)$/);
      if (method === "PUT" && updateSeasonTeamMatch) {
        const seasonId = decodeURIComponent(updateSeasonTeamMatch[1]);
        const teamId = parseTeamId(decodeURIComponent(updateSeasonTeamMatch[2]));
        if (!teamId) {
          status = badRequest(request, response, "Team ID must be red, blue, or yellow.");
          return;
        }

        let rawBody: Record<string, unknown>;
        try {
          rawBody = await parseJsonBody(request);
        } catch {
          status = badRequest(request, response, "Request body must be valid JSON.");
          return;
        }

        const parsedBody = upsertTeamRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
          status = badRequest(request, response, formatSchemaValidationError(parsedBody.error));
          return;
        }

        await ensureSeasonDefaultTeams(seasonId);
        const team = await repository.createTeam({
          seasonId,
          teamId,
          name: parsedBody.data.name,
          color: parsedBody.data.color ?? null,
        });
        status = 200;
        sendJsonWithCors(request, response, status, team);
        return;
      }

      const deleteSeasonMatch = route.match(/^\/v1\/seasons\/([^/]+)$/);
      if (method === "DELETE" && deleteSeasonMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const seasonId = decodeURIComponent(deleteSeasonMatch[1]);
        const season = await repository.getSeason(seasonId);
        if (!season) {
          status = notFound(request, response, `Season ${seasonId} was not found.`);
          return;
        }

        const isAdmin = await ensureLeagueAdmin(season.leagueId, authGate.session.email);
        if (!isAdmin) {
          status = forbidden(
            request,
            response,
            "admin_required",
            `Admin role is required for league ${season.leagueId}.`,
          );
          return;
        }

        try {
          await repository.deleteSeason(seasonId);
        } catch (error) {
          if (error instanceof Error && /Cannot delete season/.test(error.message)) {
            status = conflict(request, response, error.message);
            return;
          }

          throw error;
        }

        status = 204;
        sendNoContentWithCors(request, response);
        return;
      }

      if (method === "POST" && /^\/v1\/sessions\/[^/]+\/games$/.test(route)) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        if (!aclGate.scope?.leagueId || !aclGate.scope?.seasonId || !aclGate.scope?.sessionId) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "ACL scope should be available for create game route.",
          });
          return;
        }

        status = await handleCreateGame(request, response, {
          leagueId: aclGate.scope.leagueId,
          seasonId: aclGate.scope.seasonId,
          sessionId: aclGate.scope.sessionId,
        }, authGate.session.email, method, route);
        return;
      }

      const getGameMatch = route.match(/^\/v1\/games\/([^/]+)$/);
      if (method === "GET" && getGameMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(getGameMatch[1]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        const access = await ensureLeagueAccess(game.leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${game.leagueId} is required.`,
          );
          return;
        }

        status = 200;
        sendJsonWithCors(request, response, status, buildGameResponse(game));
        return;
      }

      const startThirdMatch = route.match(/^\/v1\/games\/([^/]+)\/thirds\/([^/]*)\/start$/);
      if (method === "POST" && startThirdMatch) {
        const gameId = decodeURIComponent(startThirdMatch[1]);
        const third = parseThirdRouteParam(decodeURIComponent(startThirdMatch[2]));
        if (!third) {
          status = badRequest(request, response, "Third must be 1, 2, or 3.");
          return;
        }

        let updated;
        try {
          updated = await repository.startGameThird({ gameId, third });
        } catch (error) {
          if (error instanceof GameTimerTransitionError) {
            status = timerTransitionConflict(request, response, error);
            return;
          }

          throw error;
        }

        if (!updated) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        status = 200;
        sendJsonWithCors(request, response, status, buildGameResponse(updated));
        return;
      }

      const finishThirdMatch = route.match(/^\/v1\/games\/([^/]+)\/thirds\/([^/]*)\/finish$/);
      if (method === "POST" && finishThirdMatch) {
        const gameId = decodeURIComponent(finishThirdMatch[1]);
        const third = parseThirdRouteParam(decodeURIComponent(finishThirdMatch[2]));
        if (!third) {
          status = badRequest(request, response, "Third must be 1, 2, or 3.");
          return;
        }

        let updated;
        try {
          updated = await repository.finishGameThird({ gameId, third });
        } catch (error) {
          if (error instanceof GameTimerTransitionError) {
            status = timerTransitionConflict(request, response, error);
            return;
          }

          throw error;
        }

        if (!updated) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        status = 200;
        sendJsonWithCors(request, response, status, buildGameResponse(updated));
        return;
      }

      const finishGameMatch = route.match(/^\/v1\/games\/([^/]+)\/finish$/);
      if (method === "POST" && finishGameMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(finishGameMatch[1]);
        const sessionEmail = authGate.session.email;

        status = await handleLocalFinishGameRoute({
          request,
          response,
          method,
          route,
          gameId,
          sessionEmail,
        });
        return;
      }

      const createGoalMatch = route.match(/^\/v1\/games\/([^/]+)\/goals$/);
      if (method === "POST" && createGoalMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(createGoalMatch[1]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        let rawBody: Record<string, unknown>;
        try {
          rawBody = await parseJsonBody(request);
        } catch {
          status = badRequest(request, response, "Request body must be valid JSON.");
          return;
        }

        const parsedBody = createGoalRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
          status = badRequest(request, response, formatSchemaValidationError(parsedBody.error));
          return;
        }

        try {
          const sessionEmail = authGate.session.email;
          status = await executeIdempotentMutation({
            request,
            response,
            sessionEmail,
            method,
            route,
            requestPayload: parsedBody.data,
            execute: async () => {
              const currentGame = await repository.getGame(gameId);
              if (!currentGame) {
                return {
                  statusCode: 404,
                  payload: {
                    error: "not_found",
                    message: `Game ${gameId} was not found.`,
                  },
                };
              }

              if (currentGame.status === "finished") {
                return {
                  statusCode: 409,
                  payload: finishedGameGoalMutationPayload(),
                };
              }

              if (!currentGame.thirds.some((third) => third.startedAt && !third.finishedAt)) {
                throw new GoalCreationError(
                  "no_active_third",
                  409,
                  "A goal can only be created while a third is running.",
                );
              }

              await ensureGameTeamsForGame(currentGame);
              const result = await repository.createGoal({
                gameId,
                eventId: buildGoalEventId({
                  request,
                  sessionEmail,
                  method,
                  route,
                }),
                actorUserId: sessionEmail,
                scoringTeamId: parsedBody.data.scoringTeamId,
                concedingTeamId: parsedBody.data.concedingTeamId,
                scorerPlayerId: parsedBody.data.scorerPlayerId,
                assistPlayerIds: parsedBody.data.assistPlayerIds,
                ownGoal: parsedBody.data.ownGoal,
              });

              if (!result) {
                return {
                  statusCode: 404,
                  payload: {
                    error: "not_found",
                    message: `Game ${gameId} was not found.`,
                  },
                };
              }

              return {
                statusCode: 201,
                payload: result,
              };
            },
          });
        } catch (error) {
          if (error instanceof GoalCreationError) {
            status = goalCreationError(request, response, error);
            return;
          }

          throw error;
        }
        return;
      }

      const updateGoalMatch = route.match(/^\/v1\/games\/([^/]+)\/goals\/([^/]+)$/);
      if (method === "PATCH" && updateGoalMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(updateGoalMatch[1]);
        const eventId = decodeURIComponent(updateGoalMatch[2]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        let rawBody: Record<string, unknown>;
        try {
          rawBody = await parseJsonBody(request);
        } catch {
          status = badRequest(request, response, "Request body must be valid JSON.");
          return;
        }

        const parsedBody = updateGoalRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
          status = badRequest(request, response, formatSchemaValidationError(parsedBody.error));
          return;
        }

        try {
          const sessionEmail = authGate.session.email;
          const correctionOperation = buildGoalCorrectionOperation({
            request,
            sessionEmail,
            method,
            route,
            requestPayload: parsedBody.data,
          });
          status = await executeIdempotentMutation({
            request,
            response,
            sessionEmail,
            method,
            route,
            requestPayload: parsedBody.data,
            execute: async () => {
              const currentGame = await repository.getGame(gameId);
              if (!currentGame) {
                return {
                  statusCode: 404,
                  payload: {
                    error: "not_found",
                    message: `Game ${gameId} was not found.`,
                  },
                };
              }

              const finishedBlock = await buildFinishedGameMutationBlock(
                currentGame,
                sessionEmail,
              );
              if (finishedBlock) {
                return {
                  statusCode: finishedBlock.statusCode,
                  payload: finishedBlock.payload,
                };
              }

              const result = await repository.updateGoal({
                gameId,
                eventId,
                actorUserId: sessionEmail,
                operationId: correctionOperation?.operationId,
                operationRequestHash: correctionOperation?.operationRequestHash,
                allowFinished: currentGame.status === "finished",
                ...parsedBody.data,
              });

              if (!result) {
                return {
                  statusCode: 404,
                  payload: {
                    error: "not_found",
                    message: `Goal ${eventId} was not found for game ${gameId}.`,
                  },
                };
              }

              return {
                statusCode: 200,
                payload: result,
              };
            },
          });
        } catch (error) {
          if (error instanceof GoalCorrectionError) {
            status = error.code === "idempotency_conflict"
              ? idempotencyConflict(request, response)
              : goalCorrectionError(request, response, error);
            return;
          }

          throw error;
        }
        return;
      }

      const deleteGoalMatch = route.match(/^\/v1\/games\/([^/]+)\/goals\/([^/]+)$/);
      if (method === "DELETE" && deleteGoalMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(deleteGoalMatch[1]);
        const eventId = decodeURIComponent(deleteGoalMatch[2]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        try {
          const sessionEmail = authGate.session.email;
          const requestPayload = { eventId };
          const correctionOperation = buildGoalCorrectionOperation({
            request,
            sessionEmail,
            method,
            route,
            requestPayload,
          });
          status = await executeIdempotentMutation({
            request,
            response,
            sessionEmail,
            method,
            route,
            requestPayload,
            execute: async () => {
              const currentGame = await repository.getGame(gameId);
              if (!currentGame) {
                return {
                  statusCode: 404,
                  payload: {
                    error: "not_found",
                    message: `Game ${gameId} was not found.`,
                  },
                };
              }

              const finishedBlock = await buildFinishedGameMutationBlock(
                currentGame,
                sessionEmail,
              );
              if (finishedBlock) {
                return {
                  statusCode: finishedBlock.statusCode,
                  payload: finishedBlock.payload,
                };
              }

              const result = await repository.deleteGoal({
                gameId,
                eventId,
                actorUserId: sessionEmail,
                operationId: correctionOperation?.operationId,
                operationRequestHash: correctionOperation?.operationRequestHash,
                allowFinished: currentGame.status === "finished",
              });

              if (!result) {
                return {
                  statusCode: 404,
                  payload: {
                    error: "not_found",
                    message: `Goal ${eventId} was not found for game ${gameId}.`,
                  },
                };
              }

              return {
                statusCode: 200,
                payload: result,
              };
            },
          });
        } catch (error) {
          if (error instanceof GoalCorrectionError) {
            status = error.code === "idempotency_conflict"
              ? idempotencyConflict(request, response)
              : goalCorrectionError(request, response, error);
            return;
          }

          throw error;
        }
        return;
      }

      const undoLastGoalMatch = route.match(/^\/v1\/games\/([^/]+)\/goals\/undo-last$/);
      if (method === "POST" && undoLastGoalMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(undoLastGoalMatch[1]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        let rawBody: Record<string, unknown>;
        try {
          rawBody = await parseJsonBody(request);
        } catch {
          status = badRequest(request, response, "Request body must be valid JSON.");
          return;
        }

        const parsedBody = undoLastGoalRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
          status = badRequest(request, response, formatSchemaValidationError(parsedBody.error));
          return;
        }

        try {
          const sessionEmail = authGate.session.email;
          const correctionOperation = buildGoalCorrectionOperation({
            request,
            sessionEmail,
            method,
            route,
            requestPayload: parsedBody.data,
          });
          status = await executeIdempotentMutation({
            request,
            response,
            sessionEmail,
            method,
            route,
            requestPayload: parsedBody.data,
            execute: async () => {
              const currentGame = await repository.getGame(gameId);
              if (!currentGame) {
                return {
                  statusCode: 404,
                  payload: {
                    error: "not_found",
                    message: `Game ${gameId} was not found.`,
                  },
                };
              }

              const finishedBlock = await buildFinishedGameMutationBlock(
                currentGame,
                sessionEmail,
              );
              if (finishedBlock) {
                return {
                  statusCode: finishedBlock.statusCode,
                  payload: finishedBlock.payload,
                };
              }

              const result = await repository.undoLastGoal({
                gameId,
                actorUserId: sessionEmail,
                operationId: correctionOperation?.operationId,
                operationRequestHash: correctionOperation?.operationRequestHash,
                allowFinished: currentGame.status === "finished",
                expectedEventId: parsedBody.data.expectedEventId,
              });

              if (!result) {
                return {
                  statusCode: 404,
                  payload: {
                    error: "not_found",
                    message: `No goal events were found for game ${gameId}.`,
                  },
                };
              }

              return {
                statusCode: 200,
                payload: result,
              };
            },
          });
        } catch (error) {
          if (error instanceof GoalCorrectionError) {
            status = error.code === "idempotency_conflict"
              ? idempotencyConflict(request, response)
              : goalCorrectionError(request, response, error);
            return;
          }

          throw error;
        }
        return;
      }

      const listGameGoalsMatch = route.match(/^\/v1\/games\/([^/]+)\/goals$/);
      if (method === "GET" && listGameGoalsMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(listGameGoalsMatch[1]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        const access = await ensureLeagueAccess(game.leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${game.leagueId} is required.`,
          );
          return;
        }

        const teams = await readGameTeams(game);
        const timeline = await repository.listGoalEvents(gameId);
        status = 200;
        sendJsonWithCors(request, response, status, {
          scoreboard: {
            teams,
          },
          timeline,
        });
        return;
      }

      const listGameTeamsMatch = route.match(/^\/v1\/games\/([^/]+)\/teams$/);
      if (method === "GET" && listGameTeamsMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(listGameTeamsMatch[1]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        const access = await ensureLeagueAccess(game.leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${game.leagueId} is required.`,
          );
          return;
        }

        const teams = await readGameTeams(game);
        status = 200;
        sendJsonWithCors(request, response, status, {
          teams,
        });
        return;
      }

      const updateGameTeamMatch = route.match(/^\/v1\/games\/([^/]+)\/teams\/([^/]+)$/);
      if (method === "PUT" && updateGameTeamMatch) {
        const gameId = decodeURIComponent(updateGameTeamMatch[1]);
        const teamId = parseTeamId(decodeURIComponent(updateGameTeamMatch[2]));
        if (!teamId) {
          status = badRequest(request, response, "Team ID must be red, blue, or yellow.");
          return;
        }

        status = await handleLocalUpdateGameTeamRoute({
          request,
          response,
          gameId,
          teamId,
        });
        return;
      }

      const listGamePlayersMatch = route.match(/^\/v1\/games\/([^/]+)\/players$/);
      if (method === "GET" && listGamePlayersMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(listGamePlayersMatch[1]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        const canManageRoster = await ensureLeagueRole(
          game.leagueId,
          authGate.session.email,
          new Set(["admin", "scorekeeper"]),
        );
        if (!canManageRoster) {
          status = forbidden(
            request,
            response,
            "scorekeeper_required",
            `Admin or scorekeeper role is required for league ${game.leagueId}.`,
          );
          return;
        }

        const search = requestUrl.searchParams.get("search")?.trim().toLowerCase() ?? "";
        const playerLinks = await repository.listGamePlayers(gameId);
        const players = (
          await Promise.all(
            playerLinks.map(async (link) => ({
              link,
              player: await repository.getPlayer(link.playerId),
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
        sendJsonWithCors(request, response, status, {
          players,
        });
        return;
      }

      const createGamePlayerMatch = route.match(/^\/v1\/games\/([^/]+)\/players$/);
      if (method === "POST" && createGamePlayerMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(createGamePlayerMatch[1]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        let rawBody: Record<string, unknown>;
        try {
          rawBody = await parseJsonBody(request);
        } catch {
          status = badRequest(request, response, "Request body must be valid JSON.");
          return;
        }

        const parsedBody = quickCreateGamePlayerRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
          status = badRequest(request, response, formatSchemaValidationError(parsedBody.error));
          return;
        }

        const playerId = parsedBody.data.playerId ?? `player-${randomUUID()}`;
        const sessionEmail = authGate.session.email;
        status = await executeIdempotentMutation({
          request,
          response,
          sessionEmail,
          method,
          route,
          requestPayload: parsedBody.data,
          execute: async () => {
            const currentGame = await repository.getGame(gameId);
            if (!currentGame) {
              return {
                statusCode: 404,
                payload: {
                  error: "not_found",
                  message: `Game ${gameId} was not found.`,
                },
              };
            }

            const finishedBlock = await buildFinishedGameMutationBlock(
              currentGame,
              sessionEmail,
            );
            if (finishedBlock) {
              return {
                statusCode: finishedBlock.statusCode,
                payload: finishedBlock.payload,
              };
            }

            const allowFinished =
              currentGame.status === "finished" &&
              (await ensureLeagueAdmin(currentGame.leagueId, sessionEmail));
            let player;
            try {
              player = await repository.createAndLinkGamePlayer({
                gameId,
                playerId,
                nickname: parsedBody.data.nickname,
                allowFinished,
              });
            } catch (error) {
              if (error instanceof GameMutationStateError) {
                const latestGame = await repository.getGame(gameId);
                if (latestGame) {
                  const finishedBlockAfterRace = await buildFinishedGameMutationBlock(
                    latestGame,
                    sessionEmail,
                  );
                  if (finishedBlockAfterRace) {
                    return {
                      statusCode: finishedBlockAfterRace.statusCode,
                      payload: finishedBlockAfterRace.payload,
                    };
                  }
                }

                return {
                  statusCode: 409,
                  payload: {
                    error: "conflict",
                    code: error.code,
                    message: error.message,
                  },
                };
              }

              throw error;
            }

            return {
              statusCode: 201,
              payload: toPublicPlayer(player),
            };
          },
        });
        return;
      }

      const listGameRosterMatch = route.match(/^\/v1\/games\/([^/]+)\/roster$/);
      if (method === "GET" && listGameRosterMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(listGameRosterMatch[1]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        const access = await ensureLeagueAccess(game.leagueId, authGate.session.email);
        if (!access.allowed) {
          status = forbidden(
            request,
            response,
            "league_access_required",
            `Access to league ${game.leagueId} is required.`,
          );
          return;
        }

        const rosterResponse = await buildRosterResponse(game);
        status = 200;
        sendJsonWithCors(request, response, status, rosterResponse);
        return;
      }

      const assignRosterPlayerMatch = route.match(/^\/v1\/games\/([^/]+)\/roster\/([^/]+)$/);
      if (method === "PUT" && assignRosterPlayerMatch) {
        const gameId = decodeURIComponent(assignRosterPlayerMatch[1]);
        const playerId = decodeURIComponent(assignRosterPlayerMatch[2]);
        const game = await repository.getGame(gameId);
        if (!game) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const finishedLock = await ensureFinishedGameMutationAllowed(
          request,
          response,
          game,
          authGate.session.email,
        );
        if (!finishedLock.allowed) {
          status = finishedLock.status;
          return;
        }

        const isAdmin = await ensureLeagueAdmin(game.leagueId, authGate.session.email);
        let rawBody: Record<string, unknown>;
        try {
          rawBody = await parseJsonBody(request);
        } catch {
          status = badRequest(request, response, "Request body must be valid JSON.");
          return;
        }

        const parsedBody = assignRosterPlayerRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
          status = badRequest(request, response, formatSchemaValidationError(parsedBody.error));
          return;
        }

        const teams = await ensureGameTeamsForGame(game);
        if (!teams.some((team) => team.teamId === parsedBody.data.teamId)) {
          status = badRequest(request, response, "Team ID must be active for this game.");
          return;
        }

        const player = await repository.getPlayer(playerId);
        if (!player) {
          status = notFound(request, response, `Player ${playerId} was not found.`);
          return;
        }

        let assignment;
        try {
          assignment = await repository.assignRosterPlayer({
            gameId,
            teamId: parsedBody.data.teamId,
            playerId,
            allowFinished: isAdmin,
          });
        } catch (error) {
          if (error instanceof GameMutationStateError) {
            const currentGame = await repository.getGame(gameId);
            if (currentGame) {
              const finishedLock = await ensureFinishedGameMutationAllowed(
                request,
                response,
                currentGame,
                authGate.session.email,
              );
              if (!finishedLock.allowed) {
                status = finishedLock.status;
                return;
              }
            }

            status = 409;
            sendJsonWithCors(request, response, status, {
              error: "conflict",
              code: error.code,
              message: error.message,
            });
            return;
          }

          throw error;
        }
        status = 200;
        sendJsonWithCors(request, response, status, {
          ...assignment,
          player: toPublicPlayer(player),
        });
        return;
      }

      const patchGameMatch = route.match(/^\/v1\/games\/([^/]+)$/);
      if (method === "PATCH" && patchGameMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        const gameId = decodeURIComponent(patchGameMatch[1]);
        const existingGame = await repository.getGame(gameId);
        if (!existingGame) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        const isAdmin = await ensureLeagueAdmin(existingGame.leagueId, authGate.session.email);
        if (!isAdmin) {
          status = forbidden(
            request,
            response,
            "admin_required",
            `Admin role is required for league ${existingGame.leagueId}.`,
          );
          return;
        }

        let rawBody: Record<string, unknown>;
        try {
          rawBody = await parseJsonBody(request);
        } catch {
          status = badRequest(request, response, "Request body must be valid JSON.");
          return;
        }

        const parsedPatch = parseGamePatchBody(rawBody);
        if (!parsedPatch) {
          status = badRequest(
            request,
            response,
            "PATCH /v1/games/{gameId} accepts status, gameStartTs, and/or thirdLengthMinutes.",
          );
          return;
        }

        let updated;
        try {
          updated = await repository.updateGame({
            gameId,
            status: parsedPatch.status,
            gameStartTs: parsedPatch.gameStartTs,
            thirdLengthMinutes: parsedPatch.thirdLengthMinutes,
          });
        } catch (error) {
          if (error instanceof GameTimerTransitionError) {
            status = timerTransitionConflict(request, response, error);
            return;
          }

          throw error;
        }

        if (!updated) {
          status = notFound(request, response, `Game ${gameId} was not found.`);
          return;
        }

        status = 200;
        sendJsonWithCors(request, response, status, buildGameResponse(updated));
        return;
      }

      const deleteGameMatch = route.match(/^\/v1\/games\/([^/]+)$/);
      if (method === "DELETE" && deleteGameMatch) {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        status = await handleLocalDeleteGameRoute({
          request,
          response,
          gameId: decodeURIComponent(deleteGameMatch[1]),
          sessionEmail: authGate.session.email,
        });
        return;
      }

      if (method === "GET" && route === "/v1/auth/session") {
        if (!authGate.session) {
          status = 500;
          sendJsonWithCors(request, response, status, {
            error: "internal_error",
            message: "Session should be available for authenticated route.",
          });
          return;
        }

        status = await handleGetAuthSession(request, response, authGate.session);
        return;
      }

      status = 404;
      sendJsonWithCors(request, response, status, { error: "Not found" });
    } catch (error) {
      status = 500;

      logRequestError({
        requestId,
        route,
        method,
        status,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      sendJsonWithCors(request, response, status, {
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      logRequest({
        requestId,
        route,
        method,
        status,
      });
    }
  });

  server.listen(PORT, () => {
    console.log(
      JSON.stringify({
        level: "info",
        service: "api",
        message: "API local server started",
        port: PORT,
        tableName: TABLE_NAME,
        dynamodbEndpoint: DYNAMODB_ENDPOINT,
        fakeSesUrl: FAKE_SES_URL,
      }),
    );
  });
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  start().catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        service: "api",
        message: "Failed to start API local server",
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    process.exitCode = 1;
  });
}
