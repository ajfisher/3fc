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

import { buildHealthResponse } from "./index.js";
import { logRequest, logRequestError } from "./logging.js";

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const TABLE_NAME = process.env.DYNAMODB_TABLE ?? "threefc_local";
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const FAKE_SES_URL = process.env.FAKE_SES_URL ?? "http://localhost:4025/send-email";
const FAKE_SES_FROM = process.env.FAKE_SES_FROM ?? "noreply@3fc.football";
const DEV_ITEM_SK = "METADATA";

const ddbClient = new DynamoDBClient({
  region: REGION,
  endpoint: DYNAMODB_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
  },
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

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
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

function badRequest(response: ServerResponse, message: string): number {
  sendJson(response, 400, { error: message });
  return 400;
}

async function handleCreateDevItem(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<number> {
  const body = await parseJsonBody(request);

  if (typeof body.id !== "string" || body.id.length === 0) {
    return badRequest(response, "Field `id` is required and must be a non-empty string.");
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

  sendJson(response, 201, record);
  return 201;
}

async function handleGetDevItem(itemId: string, response: ServerResponse): Promise<number> {
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
    sendJson(response, 404, { error: "Not found" });
    return 404;
  }

  sendJson(response, 200, JSON.parse(output.Item.data.S));
  return 200;
}

async function handleSendDevEmail(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<number> {
  const body = await parseJsonBody(request);

  if (typeof body.to !== "string" || body.to.length === 0) {
    return badRequest(response, "Field `to` is required.");
  }

  if (typeof body.subject !== "string" || body.subject.length === 0) {
    return badRequest(response, "Field `subject` is required.");
  }

  if (typeof body.body !== "string") {
    return badRequest(response, "Field `body` must be a string.");
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
    sendJson(response, 502, {
      error: "Failed to hand off to fake SES",
      statusCode: sendResponse.status,
    });
    return 502;
  }

  const payload = (await sendResponse.json()) as Record<string, unknown>;
  sendJson(response, 202, {
    status: "queued",
    messageId: payload.messageId,
  });
  return 202;
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
      if (method === "GET" && route === "/v1/health") {
        status = 200;
        sendJson(response, status, buildHealthResponse());
        return;
      }

      if (method === "POST" && route === "/v1/dev/items") {
        status = await handleCreateDevItem(request, response);
        return;
      }

      if (method === "GET" && route.startsWith("/v1/dev/items/")) {
        const itemId = route.replace("/v1/dev/items/", "");
        status = await handleGetDevItem(itemId, response);
        return;
      }

      if (method === "POST" && route === "/v1/dev/send-email") {
        status = await handleSendDevEmail(request, response);
        return;
      }

      status = 404;
      sendJson(response, status, { error: "Not found" });
    } catch (error) {
      status = 500;

      logRequestError({
        requestId,
        route,
        method,
        status,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      sendJson(response, status, {
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
