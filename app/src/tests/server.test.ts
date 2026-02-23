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
  assert.match(response.body, /Create League to Game in one mobile-first flow/);
});

test("component showcase routes render the setup shell", () => {
  const setupResponse = executeRoute("GET", "/setup");
  assert.equal(setupResponse.statusCode, 200);
  assert.match(setupResponse.body, /3FC Setup Foundation/);

  const componentsResponse = executeRoute("GET", "/ui\/components");
  assert.equal(componentsResponse.statusCode, 200);
  assert.match(componentsResponse.body, /Navigation items/);
  assert.match(componentsResponse.body, /Player representation/);
  assert.match(componentsResponse.body, /Information table/);
  assert.match(componentsResponse.body, /Field validation/);
  assert.match(componentsResponse.body, /Row action list/);
  assert.match(componentsResponse.body, /Popover modal prompt/);
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

test("auth callback error and success responses include security headers", () => {
  const errorResponse = executeRoute("GET", "/auth/callback?error=access_denied");
  assert.equal(errorResponse.statusCode, 400);
  assertSecurityHeaders(errorResponse.headers);

  const successResponse = executeRoute("GET", "/auth/callback?code=abc123");
  assert.equal(successResponse.statusCode, 200);
  assertSecurityHeaders(successResponse.headers);
});
