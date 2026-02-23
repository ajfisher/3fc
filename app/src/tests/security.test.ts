import assert from "node:assert/strict";
import test from "node:test";

import { buildContentSecurityPolicy, buildSecurityHeaders } from "../security.js";

test("buildContentSecurityPolicy includes api origin in connect-src", () => {
  const policy = buildContentSecurityPolicy("https://qa-api.3fc.football/v1");

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /connect-src 'self' https:\/\/qa-api\.3fc\.football/);
});

test("buildContentSecurityPolicy falls back to self-only connect-src for invalid API url", () => {
  const policy = buildContentSecurityPolicy("not-a-valid-url");
  assert.match(policy, /connect-src 'self'/);
  assert.equal(policy.includes("not-a-valid-url"), false);
});

test("buildSecurityHeaders returns CSP and standard browser hardening headers", () => {
  const headers = buildSecurityHeaders("https://api.3fc.football");

  assert.equal(typeof headers["Content-Security-Policy"], "string");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(headers["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(headers["Cross-Origin-Resource-Policy"], "same-site");
});
