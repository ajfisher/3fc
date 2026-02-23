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
