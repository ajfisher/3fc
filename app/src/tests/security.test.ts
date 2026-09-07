import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

test("static CloudFront CSP stays semantically aligned with the app policy", () => {
  const applicationTerraform = readFileSync(
    resolve(process.cwd(), "../infra/application/main.tf"),
    "utf8",
  );
  const qaTerraform = readFileSync(resolve(process.cwd(), "../infra/qa/main.tf"), "utf8");
  const productionTerraform = readFileSync(
    resolve(process.cwd(), "../infra/prod/main.tf"),
    "utf8",
  );
  const cspBlock = applicationTerraform.match(
    /site_content_security_policy = join\("; ", \[([\s\S]*?)\n  \]\)/,
  )?.[1];
  assert(cspBlock, "Terraform must define the static-site CSP directive list");

  const terraformStaticDirectives = [...cspBlock.matchAll(/^\s+"([^"]+)",$/gm)].map(
    (match) => match[1],
  );
  const appStaticDirectives = buildContentSecurityPolicy("https://qa-api.3fc.football")
    .split("; ")
    .filter((directive) => !directive.startsWith("connect-src "));

  assert.deepEqual(terraformStaticDirectives, appStaticDirectives);
  assert.match(
    cspBlock,
    /local\.api_custom_domain_enabled \? "connect-src 'self' https:\/\/\$\{var\.api_domain\}" : "connect-src 'self'"/,
  );
  assert.match(qaTerraform, /api_domain\s*=\s*"qa-api\.3fc\.football"/);
  assert.match(productionTerraform, /api_domain\s*=\s*"api\.3fc\.football"/);
});
