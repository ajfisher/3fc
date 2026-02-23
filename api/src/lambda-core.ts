import { createHash, randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { authorizeProtectedMutation } from "./auth/acl.js";
import {
  buildCorsHeaders,
  isStateChangeOriginPermitted,
  parseAllowedOrigins,
} from "./auth/http-security.js";
import { MagicLinkService } from "./auth/magic-link.js";
import { resolveSessionFromCookie } from "./auth/session-guard.js";
import { isAuthenticatedApiRoute } from "./auth/session.js";
import {
  createGameRequestSchema,
  createLeagueRequestSchema,
  createSeasonRequestSchema,
  createSessionRequestSchema,
  formatSchemaValidationError,
  idempotencyKeyHeaderSchema,
} from "./contracts/core-write.js";
import { ThreeFcRepository } from "./data/repository.js";
import type { GameStatus } from "./data/types.js";
import { logRequest, logRequestError } from "./logging.js";

export interface ApiGatewayHttpEvent {
  rawPath?: string;
  body?: string | null;
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  requestContext?: {
    requestId?: string;
    routeKey?: string;
    http?: {
      method?: string;
      path?: string;
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

interface RepositoryContract {
  createLeague(input: {
    leagueId: string;
    name: string;
    slug?: string | null;
    createdByUserId: string;
  }): Promise<unknown>;
  createSeason(input: {
    leagueId: string;
    seasonId: string;
    name: string;
    slug?: string | null;
    startsOn?: string | null;
    endsOn?: string | null;
  }): Promise<unknown>;
  createSession(input: { seasonId: string; sessionId: string; sessionDate: string }): Promise<unknown>;
  createGame(input: {
    gameId: string;
    leagueId: string;
    seasonId: string;
    sessionId: string;
    status?: GameStatus;
    gameStartTs: string;
  }): Promise<{
    gameId: string;
    leagueId: string;
    seasonId: string;
    sessionId: string;
    gameStartTs: string;
  }>;
  createSessionGame(input: {
    sessionId: string;
    gameId: string;
    gameStartTs: string;
    leagueId: string;
    seasonId: string;
  }): Promise<unknown>;
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
  sessionLookup: SessionLookup;
  sessionCookieName: string;
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
  const magicLinkService = new MagicLinkService(
    ddbClient,
    {
      async sendMagicLink() {
        throw new Error("Magic link email sending is not supported by this lambda service.");
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
    sessionLookup: magicLinkService,
    sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "threefc_session",
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
    let status = 500;

    try {
      if (method === "OPTIONS" && route.startsWith("/v1/")) {
        status = 204;
        return createNoContentResponse(buildCorsHeaders(origin, dependencies.corsAllowedOrigins));
      }

      if (!isStateChangeOriginPermitted(method, origin, dependencies.corsAllowedOrigins)) {
        status = 403;
        return createJsonResponse(
          status,
          {
            error: "forbidden_origin",
            message: "State-changing requests must originate from an allowed app domain.",
          },
          buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
        );
      }

      let session: AuthSessionRecord | null = null;
      if (isAuthenticatedApiRoute(method, route)) {
        const sessionResolution = await resolveSessionFromCookie(
          cookieHeader,
          dependencies.sessionCookieName,
          dependencies.sessionLookup,
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
              });

              await dependencies.repository.createSessionGame({
                sessionId: createdGame.sessionId,
                gameId: createdGame.gameId,
                gameStartTs: createdGame.gameStartTs,
                leagueId: createdGame.leagueId,
                seasonId: createdGame.seasonId,
              });

              return createJsonResponse(
                201,
                createdGame,
                buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
              );
            },
          });

          status = mutationResponse.statusCode;
          return mutationResponse;
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
