import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";

import { buildSecurityHeaders } from "./security.js";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3001";

function buildHomeHtml(apiBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3FC Local App</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        padding: 2rem;
        background: #f5f7fb;
        color: #1c2430;
      }

      main {
        max-width: 50rem;
        margin: 0 auto;
      }

      h1 {
        margin-top: 0;
      }

      code {
        background: #e5eaf3;
        border-radius: 4px;
        padding: 0.15rem 0.35rem;
      }

      .card {
        background: white;
        border: 1px solid #d8deea;
        border-radius: 10px;
        padding: 1rem;
        margin-top: 1rem;
      }

      ul {
        margin: 0.5rem 0 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>3FC Local Development</h1>
      <p>
        Local app scaffold is running. API base URL: <code>${apiBaseUrl}</code>
      </p>

      <section class="card">
        <strong>Useful endpoints</strong>
        <ul>
          <li><code>${apiBaseUrl}/v1/health</code></li>
          <li><code>${apiBaseUrl}/v1/dev/items</code> (POST)</li>
          <li><code>${apiBaseUrl}/v1/dev/items/&lt;id&gt;</code> (GET)</li>
          <li><code>${apiBaseUrl}/v1/dev/send-email</code> (POST)</li>
          <li><code>${apiBaseUrl}/v1/auth/magic/start</code> (POST)</li>
          <li><code>${apiBaseUrl}/v1/auth/magic/complete</code> (POST)</li>
          <li><code>${apiBaseUrl}/v1/auth/session</code> (GET)</li>
        </ul>
      </section>
    </main>
  </body>
</html>`;
}

function sendJson(
  response: ServerResponse,
  securityHeaders: Record<string, string>,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(
  response: ServerResponse,
  securityHeaders: Record<string, string>,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(body);
}

export function createAppRequestHandler(apiBaseUrl: string) {
  const securityHeaders = buildSecurityHeaders(apiBaseUrl);
  const homeHtml = buildHomeHtml(apiBaseUrl);

  return (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const route = requestUrl.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && (request.url ?? "/") === "/health") {
      sendJson(response, securityHeaders, 200, { status: "ok", service: "app" });
      return;
    }

    if (method === "GET" && route === "/") {
      sendHtml(response, securityHeaders, 200, homeHtml);
      return;
    }

    if (method === "GET" && route === "/auth/callback") {
      const errorCode = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");

      if (errorCode) {
        sendHtml(
          response,
          securityHeaders,
          400,
          `<h1>Sign-in failed</h1><p>OAuth provider returned: <code>${errorCode}</code>.</p>`,
        );
        return;
      }

      if (!code) {
        sendJson(response, securityHeaders, 400, {
          error: "missing_code",
          message: "Authorization callback did not include a code.",
        });
        return;
      }

      sendHtml(
        response,
        securityHeaders,
        200,
        "<h1>Sign-in complete</h1><p>Authorization callback received. Continue in the app.</p>",
      );
      return;
    }

    sendJson(response, securityHeaders, 404, { error: "Not found" });
  };
}

export function startServer(port: number = PORT, apiBaseUrl: string = API_BASE_URL): void {
  const server = createServer(createAppRequestHandler(apiBaseUrl));

  server.listen(port, () => {
    console.log(
      JSON.stringify({
        level: "info",
        service: "app",
        message: "App local server started",
        port,
        apiBaseUrl,
      }),
    );
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];

  if (!entrypoint) {
    return false;
  }

  return fileURLToPath(import.meta.url) === resolve(entrypoint);
}

if (isMainModule()) {
  startServer();
}
