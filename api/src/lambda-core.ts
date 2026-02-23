import { randomUUID } from "node:crypto";

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
import { ThreeFcRepository } from "./data/repository.js";
import type { GameStatus } from "./data/types.js";
import { logRequest, logRequestError } from "./logging.js";

export interface ApiGatewayHttpEvent {
  rawPath?: string;
  body?: string | null;
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

function isGameStatus(value: unknown): value is GameStatus {
  return value === "scheduled" || value === "live" || value === "finished";
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
    const cookieHeader = getHeader(event, "cookie");
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
          let body: Record<string, unknown>;
          try {
            body = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          if (typeof body.leagueId !== "string" || body.leagueId.trim().length === 0) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Field `leagueId` is required.");
          }

          if (typeof body.name !== "string" || body.name.trim().length === 0) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Field `name` is required.");
          }

          if (body.slug !== undefined && body.slug !== null && typeof body.slug !== "string") {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              "Field `slug` must be a string when provided.",
            );
          }

          const createdLeague = await dependencies.repository.createLeague({
            leagueId: body.leagueId,
            name: body.name,
            slug: (body.slug as string | null | undefined) ?? null,
            createdByUserId: session.email,
          });

          status = 201;
          return createJsonResponse(
            status,
            createdLeague,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const createSeasonMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons$/);
        if (method === "POST" && createSeasonMatch) {
          let body: Record<string, unknown>;
          try {
            body = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          if (typeof body.seasonId !== "string" || body.seasonId.trim().length === 0) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Field `seasonId` is required.");
          }

          if (typeof body.name !== "string" || body.name.trim().length === 0) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Field `name` is required.");
          }

          if (body.slug !== undefined && body.slug !== null && typeof body.slug !== "string") {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              "Field `slug` must be a string when provided.",
            );
          }

          if (body.startsOn !== undefined && body.startsOn !== null && typeof body.startsOn !== "string") {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              "Field `startsOn` must be a string when provided.",
            );
          }

          if (body.endsOn !== undefined && body.endsOn !== null && typeof body.endsOn !== "string") {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              "Field `endsOn` must be a string when provided.",
            );
          }

          const createdSeason = await dependencies.repository.createSeason({
            leagueId: decodeRouteParam(createSeasonMatch[1]),
            seasonId: body.seasonId,
            name: body.name,
            slug: (body.slug as string | null | undefined) ?? null,
            startsOn: (body.startsOn as string | null | undefined) ?? null,
            endsOn: (body.endsOn as string | null | undefined) ?? null,
          });

          status = 201;
          return createJsonResponse(
            status,
            createdSeason,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
        }

        const createSessionMatch = route.match(/^\/v1\/seasons\/([^/]+)\/sessions$/);
        if (method === "POST" && createSessionMatch) {
          let body: Record<string, unknown>;
          try {
            body = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          if (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Field `sessionId` is required.");
          }

          if (typeof body.sessionDate !== "string" || body.sessionDate.trim().length === 0) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Field `sessionDate` is required.");
          }

          const createdSession = await dependencies.repository.createSession({
            seasonId: decodeRouteParam(createSessionMatch[1]),
            sessionId: body.sessionId,
            sessionDate: body.sessionDate,
          });

          status = 201;
          return createJsonResponse(
            status,
            createdSession,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
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

          let body: Record<string, unknown>;
          try {
            body = parseJsonBody(event);
          } catch {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Request body must be valid JSON.");
          }

          if (typeof body.gameId !== "string" || body.gameId.trim().length === 0) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Field `gameId` is required.");
          }

          if (typeof body.gameStartTs !== "string" || body.gameStartTs.trim().length === 0) {
            status = 400;
            return badRequest(origin, dependencies.corsAllowedOrigins, "Field `gameStartTs` is required.");
          }

          if (body.status !== undefined && !isGameStatus(body.status)) {
            status = 400;
            return badRequest(
              origin,
              dependencies.corsAllowedOrigins,
              "Field `status` must be one of `scheduled`, `live`, or `finished`.",
            );
          }

          const createdGame = await dependencies.repository.createGame({
            gameId: body.gameId,
            leagueId: aclResult.scope.leagueId,
            seasonId: aclResult.scope.seasonId,
            sessionId: aclResult.scope.sessionId,
            status: body.status as GameStatus | undefined,
            gameStartTs: body.gameStartTs,
          });

          await dependencies.repository.createSessionGame({
            sessionId: createdGame.sessionId,
            gameId: createdGame.gameId,
            gameStartTs: createdGame.gameStartTs,
            leagueId: createdGame.leagueId,
            seasonId: createdGame.seasonId,
          });

          status = 201;
          return createJsonResponse(
            status,
            createdGame,
            buildCorsHeaders(origin, dependencies.corsAllowedOrigins),
          );
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
