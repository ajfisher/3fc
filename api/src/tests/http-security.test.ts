import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCorsHeaders,
  getCookieValue,
  isMagicLinkStartOriginPermitted,
  isStateChangeOriginPermitted,
  parseAllowedOrigins,
  parseCookies,
} from "../auth/http-security.js";

test("parseAllowedOrigins falls back to defaults when env is empty", () => {
  const origins = parseAllowedOrigins(undefined);
  assert.deepEqual(origins, [
    "http://localhost:3000",
    "https://qa.3fc.football",
    "https://3fc.football",
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

test("malformed cookie values do not block valid session cookies or logout", () => {
  assert.equal(getCookieValue("theme=%; threefc_session=session-123", "threefc_session"), "session-123");
  assert.equal(getCookieValue("threefc_session=%; theme=dark", "threefc_session"), null);
  assert.equal(getCookieValue("threefc_session=%E0%A4%A; theme=dark", "threefc_session"), null);
  assert.equal(getCookieValue("threefc_session=opaque%3Alegacy%2Bid%2F%3D", "threefc_session"), "opaque:legacy+id/=");
  assert.equal(getCookieValue(undefined, "threefc_session"), null);
});

test("cookie parsing ignores oversized, invalid-name and control-bearing values", () => {
  for (const value of ["a".repeat(4097), "%00session", "session%0A", "session%7F"]) {
    assert.equal(getCookieValue(`threefc_session=${value}`, "threefc_session"), null);
  }
  assert.equal(getCookieValue("invalid name=value; threefc_session=valid", "invalid name"), null);
  assert.equal(getCookieValue("theme=%0D%0A; threefc_session=valid", "threefc_session"), "valid");
});

test("cookie names neither inherit nor mutate an object prototype", () => {
  const cookies = parseCookies("__proto__=polluted; constructor=opaque; threefc_session=valid");
  assert.equal(Object.getPrototypeOf(cookies), null);
  assert.equal(cookies.__proto__, "polluted");
  assert.equal(cookies.constructor, "opaque");
  assert.equal(getCookieValue(undefined, "toString"), null);
  assert.equal(getCookieValue("theme=dark", "constructor"), null);
});

test("CORS headers are returned only for allowed origins", () => {
  const allowlist = ["https://qa.3fc.football"];
  const allowed = buildCorsHeaders("https://qa.3fc.football", allowlist);
  assert.equal(allowed["Access-Control-Allow-Origin"], "https://qa.3fc.football");
  assert.equal(allowed["Access-Control-Allow-Credentials"], "true");
  assert.equal(allowed["Access-Control-Allow-Methods"], "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  assert.equal(
    allowed["Access-Control-Allow-Headers"],
    "content-type,x-csrf-token,idempotency-key",
  );
  assert.match(allowed["Access-Control-Allow-Methods"], /\bPUT\b/);

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

test("magic-link start requires an allowed origin", () => {
  const allowlist = ["https://qa.3fc.football"];

  assert.equal(
    isMagicLinkStartOriginPermitted(
      "POST",
      "/v1/auth/magic/start",
      "https://qa.3fc.football",
      allowlist,
    ),
    true,
  );
  assert.equal(
    isMagicLinkStartOriginPermitted("POST", "/v1/auth/magic/start", undefined, allowlist),
    false,
  );
  assert.equal(
    isMagicLinkStartOriginPermitted(
      "POST",
      "/v1/auth/magic/start",
      "https://evil.example",
      allowlist,
    ),
    false,
  );
  assert.equal(
    isMagicLinkStartOriginPermitted("POST", "/v1/auth/magic/complete", undefined, allowlist),
    true,
  );
});
