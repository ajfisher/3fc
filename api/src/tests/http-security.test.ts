import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCorsHeaders,
  getCookieValue,
  isStateChangeOriginPermitted,
  parseAllowedOrigins,
  parseCookies,
} from "../auth/http-security.js";

test("parseAllowedOrigins falls back to defaults when env is empty", () => {
  const origins = parseAllowedOrigins(undefined);
  assert.deepEqual(origins, [
    "http://localhost:3000",
    "https://qa.3fc.football",
    "https://app.3fc.football",
  ]);
});

test("parseAllowedOrigins supports comma-separated overrides", () => {
  const origins = parseAllowedOrigins("https://qa.3fc.football, https://app.3fc.football");
  assert.deepEqual(origins, ["https://qa.3fc.football", "https://app.3fc.football"]);
});

test("cookie parser returns individual cookie values", () => {
  const cookies = parseCookies("threefc_session=session-123; theme=dark");
  assert.equal(cookies.threefc_session, "session-123");
  assert.equal(cookies.theme, "dark");
});

test("getCookieValue returns null for missing cookie", () => {
  assert.equal(getCookieValue("theme=dark", "threefc_session"), null);
});

test("CORS headers are returned only for allowed origins", () => {
  const allowlist = ["https://qa.3fc.football"];
  const allowed = buildCorsHeaders("https://qa.3fc.football", allowlist);
  assert.equal(allowed["Access-Control-Allow-Origin"], "https://qa.3fc.football");
  assert.equal(allowed["Access-Control-Allow-Credentials"], "true");

  const denied = buildCorsHeaders("https://evil.example", allowlist);
  assert.deepEqual(denied, {});
});

test("state-changing requests enforce origin allowlist while allowing non-browser clients", () => {
  const allowlist = ["https://qa.3fc.football"];

  assert.equal(isStateChangeOriginPermitted("GET", "https://evil.example", allowlist), true);
  assert.equal(isStateChangeOriginPermitted("POST", "https://qa.3fc.football", allowlist), true);
  assert.equal(isStateChangeOriginPermitted("POST", "https://evil.example", allowlist), false);
  assert.equal(isStateChangeOriginPermitted("POST", undefined, allowlist), true);
});
