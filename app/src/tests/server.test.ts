import assert from "node:assert/strict";
import test from "node:test";

import { createAppRequestHandler } from "../server.js";

class MockResponse {
  statusCode = 0;

  headers: Record<string, string> = {};

  body = "";

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(body: string = ""): this {
    this.body = body;
    return this;
  }
}

function executeRoute(method: string, url: string): MockResponse {
  const response = new MockResponse();
  const handler = createAppRequestHandler("https://qa-api.3fc.football");
  handler({ method, url } as never, response as never);
  return response;
}

function assertSecurityHeaders(headers: Record<string, string>): void {
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(headers["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");

  const csp = headers["Content-Security-Policy"];
  assert.ok(csp);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self' https:\/\/qa-api\.3fc\.football/);
}

test("health response includes security headers", () => {
  const response = executeRoute("GET", "/health");

  assert.equal(response.statusCode, 200);
  assertSecurityHeaders(response.headers);
  assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
});

test("home route includes security headers", () => {
  const response = executeRoute("GET", "/");

  assert.equal(response.statusCode, 200);
  assertSecurityHeaders(response.headers);
  assert.equal(response.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(response.body, /Step through league, season, then game creation/);
  assert.match(response.body, /data-testid="setup-flow-root"/);
});

test("component showcase routes render the setup shell", () => {
  const setupResponse = executeRoute("GET", "/setup");
  assert.equal(setupResponse.statusCode, 200);
  assert.match(setupResponse.body, /Step 1: Create League/);
  assert.match(setupResponse.body, /Step 2: Create Season/);
  assert.match(setupResponse.body, /Step 3: Create Games/);

  const componentsResponse = executeRoute("GET", "/ui\/components");
  assert.equal(componentsResponse.statusCode, 200);
  assert.match(componentsResponse.body, /Navigation items/);
  assert.match(componentsResponse.body, /Player representation/);
  assert.match(componentsResponse.body, /Information table/);
  assert.match(componentsResponse.body, /Field validation/);
  assert.match(componentsResponse.body, /Row action list/);
  assert.match(componentsResponse.body, /Popover modal prompt/);
});

test("sign-in route renders dedicated auth page", () => {
  const response = executeRoute("GET", "/sign-in?returnTo=%2Fsetup");

  assert.equal(response.statusCode, 200);
  assertSecurityHeaders(response.headers);
  assert.equal(response.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(response.body, /Sign in before setup/);
  assert.match(response.body, /id="auth-magic-form"/);
  assert.match(response.body, /id="auth-return-to"/);
  assert.match(response.body, /value="\/setup"/);
});

test("stylesheet route serves external UI css", () => {
  const response = executeRoute("GET", "/ui/styles.css");

  assert.equal(response.statusCode, 200);
  assertSecurityHeaders(response.headers);
  assert.equal(response.headers["Content-Type"], "text/css; charset=utf-8");
  assert.match(response.body, /\[data-ui="button"]/);
  assert.match(response.body, /\[data-ui="nav"]/);
  assert.match(response.body, /&:hover/);
});

test("modal behavior script route serves external javascript", () => {
  const response = executeRoute("GET", "/ui/modal.js");

  assert.equal(response.statusCode, 200);
  assertSecurityHeaders(response.headers);
  assert.equal(response.headers["Content-Type"], "application/javascript; charset=utf-8");
  assert.match(response.body, /data-modal-open/);
  assert.match(response.body, /modal-open/);
});

test("setup and auth flow script routes serve external javascript", () => {
  const setupFlowResponse = executeRoute("GET", "/ui/setup-flow.js");
  assert.equal(setupFlowResponse.statusCode, 200);
  assertSecurityHeaders(setupFlowResponse.headers);
  assert.equal(setupFlowResponse.headers["Content-Type"], "application/javascript; charset=utf-8");
  assert.match(setupFlowResponse.body, /setup-flow-root/);
  assert.match(setupFlowResponse.body, /create-league/);
  assert.match(setupFlowResponse.body, /sign-in\?returnTo=/);

  const authFlowResponse = executeRoute("GET", "/ui/auth-flow.js");
  assert.equal(authFlowResponse.statusCode, 200);
  assertSecurityHeaders(authFlowResponse.headers);
  assert.equal(authFlowResponse.headers["Content-Type"], "application/javascript; charset=utf-8");
  assert.match(authFlowResponse.body, /auth-magic-form/);
  assert.match(authFlowResponse.body, /RETURN_TO_STORAGE_KEY/);
  assert.match(authFlowResponse.body, /auth\/callback/);
});

test("game context route renders created game shell", () => {
  const response = executeRoute(
    "GET",
    "/games/game-123?leagueId=league-1&seasonId=season-1&sessionId=20260223&gameStartTs=2026-02-23T10:00:00.000Z",
  );

  assert.equal(response.statusCode, 200);
  assertSecurityHeaders(response.headers);
  assert.equal(response.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(response.body, /Game context created: game-123/);
  assert.match(response.body, /league-1/);
  assert.match(response.body, /season-1/);
});

test("auth callback error and success responses include security headers", () => {
  const errorResponse = executeRoute("GET", "/auth/callback?error=access_denied");
  assert.equal(errorResponse.statusCode, 400);
  assertSecurityHeaders(errorResponse.headers);

  const tokenResponse = executeRoute("GET", "/auth/callback?token=abc123");
  assert.equal(tokenResponse.statusCode, 200);
  assertSecurityHeaders(tokenResponse.headers);
  assert.match(tokenResponse.body, /Completing sign-in/);

  const successResponse = executeRoute("GET", "/auth/callback?code=abc123");
  assert.equal(successResponse.statusCode, 200);
  assertSecurityHeaders(successResponse.headers);

  const missingResponse = executeRoute("GET", "/auth/callback");
  assert.equal(missingResponse.statusCode, 400);
  assertSecurityHeaders(missingResponse.headers);
  assert.match(missingResponse.body, /did not include token or code/);
});
