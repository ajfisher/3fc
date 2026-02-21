import { randomUUID } from "node:crypto";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.FAKE_SES_PORT ?? "4025", 10);
const LOG_FILE = process.env.FAKE_SES_LOG_FILE ?? "/data/emails.jsonl";

async function parseJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function appendMessage(payload) {
  await mkdir(dirname(LOG_FILE), { recursive: true });

  const message = {
    messageId: randomUUID(),
    receivedAt: new Date().toISOString(),
    ...payload,
  };

  await appendFile(LOG_FILE, `${JSON.stringify(message)}\n`, "utf8");

  return message;
}

async function listMessages() {
  try {
    const content = await readFile(LOG_FILE, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const url = request.url ?? "/";

  try {
    if (method === "GET" && url === "/health") {
      sendJson(response, 200, { status: "ok", service: "fake-ses" });
      return;
    }

    if (method === "GET" && url === "/messages") {
      sendJson(response, 200, { messages: await listMessages() });
      return;
    }

    if (method === "POST" && url === "/send-email") {
      const body = await parseJsonBody(request);

      if (typeof body.to !== "string" || typeof body.subject !== "string") {
        sendJson(response, 400, {
          error: "Invalid payload. Expected `to` and `subject` fields.",
        });
        return;
      }

      const message = await appendMessage(body);
      sendJson(response, 202, {
        status: "accepted",
        messageId: message.messageId,
      });
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
  console.log(
    JSON.stringify({
      level: "info",
      service: "fake-ses",
      message: "Fake SES server started",
      port: PORT,
      logFile: LOG_FILE,
    }),
  );
});
