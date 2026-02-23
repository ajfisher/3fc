import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";

import { buildSecurityHeaders } from "./security.js";
import { renderSetupHomePage, renderStatusPage } from "./ui/layout.js";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3001";

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
  const setupShellHtml = renderSetupHomePage(apiBaseUrl);

  return (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const route = requestUrl.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && (request.url ?? "/") === "/health") {
      sendJson(response, securityHeaders, 200, { status: "ok", service: "app" });
      return;
    }

    if (method === "GET" && (route === "/" || route === "/setup" || route === "/ui/components")) {
      sendHtml(response, securityHeaders, 200, setupShellHtml);
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
          renderStatusPage("Sign-in failed", `OAuth provider returned: ${errorCode}.`),
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
        renderStatusPage(
          "Sign-in complete",
          "Authorization callback received. Continue in the app.",
        ),
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
