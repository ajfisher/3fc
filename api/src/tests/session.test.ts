import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionCookie,
  isAuthenticatedApiRoute,
  resolveSessionCookieSecureFlag,
} from "../auth/session.js";

test("resolveSessionCookieSecureFlag honours explicit env overrides", () => {
  assert.equal(resolveSessionCookieSecureFlag("true", "http://localhost:3000"), true);
  assert.equal(resolveSessionCookieSecureFlag("false", "https://app.3fc.football"), false);
});

test("resolveSessionCookieSecureFlag defaults by app protocol", () => {
  assert.equal(resolveSessionCookieSecureFlag(undefined, "https://app.3fc.football"), true);
  assert.equal(resolveSessionCookieSecureFlag(undefined, "http://localhost:3000"), false);
});

test("buildSessionCookie includes secure baseline attributes", () => {
  const cookie = buildSessionCookie("threefc_session", "session-1", 3600, true);

  assert.match(cookie, /^threefc_session=session-1;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=3600/);
  assert.match(cookie, /Secure/);
});

test("buildSessionCookie omits Secure when disabled for local development", () => {
  const cookie = buildSessionCookie("threefc_session", "session-1", 3600, false);
  assert.equal(cookie.includes("Secure"), false);
});

test("isAuthenticatedApiRoute marks protected routes only", () => {
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/auth/session"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/dev/items"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/dev/items/demo"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/dev/send-email"), true);

  assert.equal(isAuthenticatedApiRoute("GET", "/v1/health"), false);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/auth/magic/start"), false);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/auth/magic/complete"), false);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/unknown"), false);
});
