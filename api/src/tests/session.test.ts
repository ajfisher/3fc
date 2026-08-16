import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionCookie,
  DEFAULT_SESSION_TTL_SECONDS,
  isAuthenticatedApiRoute,
  resolveSessionCookieSecureFlag,
} from "../auth/session.js";

test("default session lifetime spans eight days", () => {
  assert.equal(DEFAULT_SESSION_TTL_SECONDS, 691_200);
});

test("resolveSessionCookieSecureFlag honours explicit env overrides", () => {
  assert.equal(resolveSessionCookieSecureFlag("true", "http://localhost:3000"), true);
  assert.equal(resolveSessionCookieSecureFlag("false", "https://app.3fc.football"), false);
});

test("resolveSessionCookieSecureFlag defaults by app protocol", () => {
  assert.equal(resolveSessionCookieSecureFlag(undefined, "https://app.3fc.football"), true);
  assert.equal(resolveSessionCookieSecureFlag(undefined, "http://localhost:3000"), false);
});

test("buildSessionCookie includes secure baseline attributes", () => {
  const cookie = buildSessionCookie(
    "threefc_session",
    "session-1",
    "2026-03-02T00:00:00.000Z",
    true,
  );

  assert.match(cookie, /^threefc_session=session-1;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Expires=Mon, 02 Mar 2026 00:00:00 GMT/);
  assert.equal(cookie.includes("Max-Age"), false);
  assert.match(cookie, /Secure/);
});

test("buildSessionCookie omits Secure when disabled for local development", () => {
  const cookie = buildSessionCookie(
    "threefc_session",
    "session-1",
    "2026-03-02T00:00:00.000Z",
    false,
  );
  assert.equal(cookie.includes("Secure"), false);
});

test("buildSessionCookie rejects invalid absolute expiries", () => {
  assert.throws(
    () => buildSessionCookie("threefc_session", "session-1", "invalid", true),
    /valid date/,
  );
});

test("isAuthenticatedApiRoute marks protected routes only", () => {
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/leagues"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/leagues/league-1"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/leagues/league-1/seasons"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/leagues/league-1/seasons/season-1"), true);
  assert.equal(isAuthenticatedApiRoute("DELETE", "/v1/leagues/league-1/seasons/season-1"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/leagues/league-1/seasons/season-1/games"), true);
  assert.equal(isAuthenticatedApiRoute("DELETE", "/v1/leagues/league-1"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/seasons/season-1"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/seasons/season-1/games"), true);
  assert.equal(isAuthenticatedApiRoute("DELETE", "/v1/seasons/season-1"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/games/game-1"), true);
  assert.equal(isAuthenticatedApiRoute("PATCH", "/v1/games/game-1"), true);
  assert.equal(isAuthenticatedApiRoute("DELETE", "/v1/games/game-1"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/games/game-1/thirds/1/start"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/games/game-1/thirds/1/finish"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/games/game-1/goals"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/games/game-1/goals"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/games/game-1/finish"), true);
  assert.equal(isAuthenticatedApiRoute("PATCH", "/v1/games/game-1/goals/goal-1"), true);
  assert.equal(isAuthenticatedApiRoute("DELETE", "/v1/games/game-1/goals/goal-1"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/games/game-1/goals/undo-last"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/players/player-1/claim"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/leagues/league-1/access"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/leagues/league-1/organiser-invites"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/invites/ABCD2345/accept"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/auth/session"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/leagues"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/leagues/league-1/seasons"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/leagues/league-1/seasons/season-1/sessions"), true);
  assert.equal(
    isAuthenticatedApiRoute("POST", "/v1/leagues/league-1/seasons/season-1/sessions/session-1/games"),
    true,
  );
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/seasons/season-1/sessions"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/sessions/session-1/games"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/dev/items"), true);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/dev/items/demo"), true);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/dev/send-email"), true);

  assert.equal(isAuthenticatedApiRoute("GET", "/v1/health"), false);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/auth/magic/start"), false);
  assert.equal(isAuthenticatedApiRoute("POST", "/v1/auth/magic/complete"), false);
  assert.equal(isAuthenticatedApiRoute("GET", "/v1/unknown"), false);
  assert.equal(isAuthenticatedApiRoute("PATCH", "/v1/unknown"), false);
});
