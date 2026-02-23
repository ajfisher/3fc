import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { URL } from "node:url";

import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

import {
  MagicLinkAuthError,
  MagicLinkService,
  type AuthSessionRecord,
  type MagicLinkEmailSender,
} from "./auth/magic-link.js";
import {
  authorizeProtectedMutation,
} from "./auth/acl.js";
import {
  buildCorsHeaders,
  isStateChangeOriginPermitted,
  parseAllowedOrigins,
} from "./auth/http-security.js";
import { resolveSessionFromCookie } from "./auth/session-guard.js";
import {
  buildSessionCookie,
  isAuthenticatedApiRoute,
  resolveSessionCookieSecureFlag,
} from "./auth/session.js";
import { ThreeFcRepository } from "./data/repository.js";
import { buildHealthResponse } from "./index.js";
import { logRequest, logRequestError } from "./logging.js";

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
const repository = new ThreeFcRepository(ddbClient, TABLE_NAME);

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
): Promise<number> {
  let body: Record<string, unknown>;

  try {
    body = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  if (typeof body.leagueId !== "string" || body.leagueId.trim().length === 0) {
    return badRequest(request, response, "Field `leagueId` is required.");
  }

  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return badRequest(request, response, "Field `name` is required.");
  }

  if (body.slug !== undefined && body.slug !== null && typeof body.slug !== "string") {
    return badRequest(request, response, "Field `slug` must be a string when provided.");
  }

  const league = await repository.createLeague({
    leagueId: body.leagueId,
    name: body.name,
    slug: (body.slug as string | null | undefined) ?? null,
    createdByUserId: session.email,
  });

  sendJsonWithCors(request, response, 201, league);
  return 201;
}

async function handleCreateSeason(
  request: IncomingMessage,
  response: ServerResponse,
  leagueId: string,
): Promise<number> {
  let body: Record<string, unknown>;

  try {
    body = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  if (typeof body.seasonId !== "string" || body.seasonId.trim().length === 0) {
    return badRequest(request, response, "Field `seasonId` is required.");
  }

  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return badRequest(request, response, "Field `name` is required.");
  }

  if (body.slug !== undefined && body.slug !== null && typeof body.slug !== "string") {
    return badRequest(request, response, "Field `slug` must be a string when provided.");
  }

  if (body.startsOn !== undefined && body.startsOn !== null && typeof body.startsOn !== "string") {
    return badRequest(request, response, "Field `startsOn` must be a string when provided.");
  }

  if (body.endsOn !== undefined && body.endsOn !== null && typeof body.endsOn !== "string") {
    return badRequest(request, response, "Field `endsOn` must be a string when provided.");
  }

  const season = await repository.createSeason({
    leagueId,
    seasonId: body.seasonId,
    name: body.name,
    slug: (body.slug as string | null | undefined) ?? null,
    startsOn: (body.startsOn as string | null | undefined) ?? null,
    endsOn: (body.endsOn as string | null | undefined) ?? null,
  });

  sendJsonWithCors(request, response, 201, season);
  return 201;
}

async function handleCreateSession(
  request: IncomingMessage,
  response: ServerResponse,
  seasonId: string,
): Promise<number> {
  let body: Record<string, unknown>;

  try {
    body = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  if (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0) {
    return badRequest(request, response, "Field `sessionId` is required.");
  }

  if (typeof body.sessionDate !== "string" || body.sessionDate.trim().length === 0) {
    return badRequest(request, response, "Field `sessionDate` is required.");
  }

  const session = await repository.createSession({
    seasonId,
    sessionId: body.sessionId,
    sessionDate: body.sessionDate,
  });

  sendJsonWithCors(request, response, 201, session);
  return 201;
}

function isGameStatus(
  value: unknown,
): value is "scheduled" | "live" | "finished" {
  return value === "scheduled" || value === "live" || value === "finished";
}

async function handleCreateGame(
  request: IncomingMessage,
  response: ServerResponse,
  scope: { leagueId: string; seasonId: string; sessionId: string },
): Promise<number> {
  let body: Record<string, unknown>;

  try {
    body = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  if (typeof body.gameId !== "string" || body.gameId.trim().length === 0) {
    return badRequest(request, response, "Field `gameId` is required.");
  }

  if (typeof body.gameStartTs !== "string" || body.gameStartTs.trim().length === 0) {
    return badRequest(request, response, "Field `gameStartTs` is required.");
  }

  if (body.status !== undefined && !isGameStatus(body.status)) {
    return badRequest(
      request,
      response,
      "Field `status` must be one of `scheduled`, `live`, or `finished`.",
    );
  }

  const game = await repository.createGame({
    gameId: body.gameId,
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    sessionId: scope.sessionId,
    status: body.status as "scheduled" | "live" | "finished" | undefined,
    gameStartTs: body.gameStartTs,
  });

  await repository.createSessionGame({
    sessionId: scope.sessionId,
    gameId: game.gameId,
    gameStartTs: game.gameStartTs,
    leagueId: game.leagueId,
    seasonId: game.seasonId,
  });

  sendJsonWithCors(request, response, 201, game);
  return 201;
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
): Promise<number> {
  let body: Record<string, unknown>;

  try {
    body = await parseJsonBody(request);
  } catch {
    return badRequest(request, response, "Request body must be valid JSON.");
  }

  if (typeof body.email !== "string") {
    return badRequest(request, response, "Field `email` is required.");
  }

  try {
    const result = await magicLinkService.start(body.email);

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
        status = 403;
        sendJsonWithCors(request, response, status, {
          error: "forbidden_origin",
          message: "State-changing requests must originate from an allowed app domain.",
        });
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
        status = await handleMagicLinkStart(request, response);
        return;
      }

      if (method === "POST" && route === "/v1/auth/magic/complete") {
        status = await handleMagicLinkComplete(request, response);
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

        status = await handleCreateLeague(request, response, authGate.session);
        return;
      }

      const createSeasonMatch = route.match(/^\/v1\/leagues\/([^/]+)\/seasons$/);
      if (method === "POST" && createSeasonMatch) {
        status = await handleCreateSeason(
          request,
          response,
          aclGate.scope?.leagueId ?? decodeURIComponent(createSeasonMatch[1]),
        );
        return;
      }

      const createSessionMatch = route.match(/^\/v1\/seasons\/([^/]+)\/sessions$/);
      if (method === "POST" && createSessionMatch) {
        status = await handleCreateSession(
          request,
          response,
          aclGate.scope?.seasonId ?? decodeURIComponent(createSessionMatch[1]),
        );
        return;
      }

      if (method === "POST" && /^\/v1\/sessions\/[^/]+\/games$/.test(route)) {
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
