import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";

import { buildSecurityHeaders } from "./security.js";
import {
  renderComponentShowcasePage,
  renderGamePage,
  renderLeaguePage,
  renderMagicLinkCallbackPage,
  renderSeasonPage,
  renderSignInPage,
  renderSetupHomePage,
  renderStatusPage,
} from "./ui/layout.js";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3001";
const UI_STYLESHEET_PATHS = [
  fileURLToPath(new URL("./ui/styles.css", import.meta.url)),
  resolve(process.cwd(), "src/ui/styles.css"),
  resolve(process.cwd(), "app/src/ui/styles.css"),
];
const UI_MODAL_SCRIPT_PATHS = [
  fileURLToPath(new URL("./ui/modal.js", import.meta.url)),
  resolve(process.cwd(), "src/ui/modal.js"),
  resolve(process.cwd(), "app/src/ui/modal.js"),
];
const UI_SETUP_FLOW_SCRIPT_PATHS = [
  fileURLToPath(new URL("./ui/setup-flow.js", import.meta.url)),
  resolve(process.cwd(), "src/ui/setup-flow.js"),
  resolve(process.cwd(), "app/src/ui/setup-flow.js"),
];
const UI_AUTH_FLOW_SCRIPT_PATHS = [
  fileURLToPath(new URL("./ui/auth-flow.js", import.meta.url)),
  resolve(process.cwd(), "src/ui/auth-flow.js"),
  resolve(process.cwd(), "app/src/ui/auth-flow.js"),
];
const UI_STYLESHEET = loadUiStylesheet();
const UI_MODAL_SCRIPT = loadUiModalScript();
const UI_SETUP_FLOW_SCRIPT = loadUiSetupFlowScript();
const UI_AUTH_FLOW_SCRIPT = loadUiAuthFlowScript();

function loadUiStylesheet(): string {
  for (const stylesheetPath of UI_STYLESHEET_PATHS) {
    try {
      return readFileSync(stylesheetPath, "utf8");
    } catch {
      // Continue until a readable stylesheet path is found.
    }
  }

  return "/* ui stylesheet unavailable */";
}

function loadUiModalScript(): string {
  for (const scriptPath of UI_MODAL_SCRIPT_PATHS) {
    try {
      return readFileSync(scriptPath, "utf8");
    } catch {
      // Continue until a readable script path is found.
    }
  }

  return "/* ui modal script unavailable */";
}

function loadUiSetupFlowScript(): string {
  for (const scriptPath of UI_SETUP_FLOW_SCRIPT_PATHS) {
    try {
      return readFileSync(scriptPath, "utf8");
    } catch {
      // Continue until a readable script path is found.
    }
  }

  return "/* ui setup flow script unavailable */";
}

function loadUiAuthFlowScript(): string {
  for (const scriptPath of UI_AUTH_FLOW_SCRIPT_PATHS) {
    try {
      return readFileSync(scriptPath, "utf8");
    } catch {
      // Continue until a readable script path is found.
    }
  }

  return "/* ui auth flow script unavailable */";
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

function sendCss(
  response: ServerResponse,
  securityHeaders: Record<string, string>,
  statusCode: number,
  css: string,
): void {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "text/css; charset=utf-8",
  });
  response.end(css);
}

function sendJavascript(
  response: ServerResponse,
  securityHeaders: Record<string, string>,
  statusCode: number,
  javascript: string,
): void {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/javascript; charset=utf-8",
  });
  response.end(javascript);
}

export function createAppRequestHandler(apiBaseUrl: string) {
  const securityHeaders = buildSecurityHeaders(apiBaseUrl);
  const setupShellHtml = renderSetupHomePage(apiBaseUrl);
  const componentShowcaseHtml = renderComponentShowcasePage(apiBaseUrl);

  return (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const route = requestUrl.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && (request.url ?? "/") === "/health") {
      sendJson(response, securityHeaders, 200, { status: "ok", service: "app" });
      return;
    }

    if (method === "GET" && (route === "/" || route === "/setup")) {
      sendHtml(response, securityHeaders, 200, setupShellHtml);
      return;
    }

    if (method === "GET" && route === "/sign-in") {
      const returnTo = requestUrl.searchParams.get("returnTo") ?? "/setup";
      sendHtml(response, securityHeaders, 200, renderSignInPage(apiBaseUrl, returnTo));
      return;
    }

    if (method === "GET" && route === "/ui/components") {
      sendHtml(response, securityHeaders, 200, componentShowcaseHtml);
      return;
    }

    if (method === "GET" && route === "/ui/styles.css") {
      sendCss(response, securityHeaders, 200, UI_STYLESHEET);
      return;
    }

    if (method === "GET" && route === "/ui/modal.js") {
      sendJavascript(response, securityHeaders, 200, UI_MODAL_SCRIPT);
      return;
    }

    if (method === "GET" && route === "/ui/setup-flow.js") {
      sendJavascript(response, securityHeaders, 200, UI_SETUP_FLOW_SCRIPT);
      return;
    }

    if (method === "GET" && route === "/ui/auth-flow.js") {
      sendJavascript(response, securityHeaders, 200, UI_AUTH_FLOW_SCRIPT);
      return;
    }

    const leaguePageMatch = route.match(/^\/leagues\/([^/]+)$/);
    if (method === "GET" && leaguePageMatch) {
      sendHtml(
        response,
        securityHeaders,
        200,
        renderLeaguePage(apiBaseUrl, decodeURIComponent(leaguePageMatch[1])),
      );
      return;
    }

    const seasonPageMatch = route.match(/^\/seasons\/([^/]+)$/);
    if (method === "GET" && seasonPageMatch) {
      sendHtml(
        response,
        securityHeaders,
        200,
        renderSeasonPage(apiBaseUrl, decodeURIComponent(seasonPageMatch[1])),
      );
      return;
    }

    const gamePageMatch = route.match(/^\/games\/([^/]+)$/);
    if (method === "GET" && gamePageMatch) {
      const gameId = decodeURIComponent(gamePageMatch[1]);
      sendHtml(response, securityHeaders, 200, renderGamePage(apiBaseUrl, { gameId }));
      return;
    }

    if (method === "GET" && route === "/auth/callback") {
      const errorCode = requestUrl.searchParams.get("error");
      const token = requestUrl.searchParams.get("token");
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

      if (token) {
        sendHtml(response, securityHeaders, 200, renderMagicLinkCallbackPage(apiBaseUrl));
        return;
      }

      if (!code) {
        sendHtml(
          response,
          securityHeaders,
          400,
          renderStatusPage("Sign-in callback failed", "Authorization callback did not include token or code."),
        );
        return;
      }

      sendHtml(response, securityHeaders, 200, renderMagicLinkCallbackPage(apiBaseUrl));
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
