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

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const TABLE_NAME = process.env.DYNAMODB_TABLE ?? "threefc_local";
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const FAKE_SES_URL = process.env.FAKE_SES_URL ?? "http://localhost:4025/send-email";
const FAKE_SES_FROM = process.env.FAKE_SES_FROM ?? "noreply@3fc.football";

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
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
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

function badRequest(response: ServerResponse, message: string): void {
  sendJson(response, 400, { error: message });
}

async function handleCreateDevItem(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(request);

  if (typeof body.id !== "string" || body.id.length === 0) {
    badRequest(response, "Field `id` is required and must be a non-empty string.");
    return;
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
        data: { S: JSON.stringify(record) },
      },
    }),
  );

  sendJson(response, 201, record);
}

async function handleGetDevItem(
  itemId: string,
  response: ServerResponse,
): Promise<void> {
  const output = await ddbClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: itemId },
      },
    }),
  );

  if (!output.Item?.data?.S) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  sendJson(response, 200, JSON.parse(output.Item.data.S));
}

async function handleSendDevEmail(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(request);

  if (typeof body.to !== "string" || body.to.length === 0) {
    badRequest(response, "Field `to` is required.");
    return;
  }

  if (typeof body.subject !== "string" || body.subject.length === 0) {
    badRequest(response, "Field `subject` is required.");
    return;
  }

  if (typeof body.body !== "string") {
    badRequest(response, "Field `body` must be a string.");
    return;
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
    return;
  }

  const payload = (await sendResponse.json()) as Record<string, unknown>;
  sendJson(response, 202, {
    status: "queued",
    messageId: payload.messageId,
  });
}

async function start(): Promise<void> {
  await ensureTable();

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const path = requestUrl.pathname;
    const method = request.method ?? "GET";

    try {
      if (method === "GET" && path === "/v1/health") {
        sendJson(response, 200, buildHealthResponse());
        return;
      }

      if (method === "POST" && path === "/v1/dev/items") {
        await handleCreateDevItem(request, response);
        return;
      }

      if (method === "GET" && path.startsWith("/v1/dev/items/")) {
        const itemId = path.replace("/v1/dev/items/", "");
        await handleGetDevItem(itemId, response);
        return;
      }

      if (method === "POST" && path === "/v1/dev/send-email") {
        await handleSendDevEmail(request, response);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, {
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  server.listen(PORT, () => {
    // JSON logging baseline for local and future cloud environments.
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
