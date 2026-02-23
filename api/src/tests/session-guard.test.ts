import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionFromCookie, type SessionLookup } from "../auth/session-guard.js";

class InMemorySessionLookup implements SessionLookup {
  constructor(
    private readonly sessions: Record<string, { sessionId: string; email: string; createdAt: string; expiresAt: string }>,
  ) {}

  async getSession(sessionId: string) {
    return this.sessions[sessionId] ?? null;
  }
}

test("resolveSessionFromCookie returns missing_cookie when session cookie is absent", async () => {
  const result = await resolveSessionFromCookie(
    "theme=light",
    "threefc_session",
    new InMemorySessionLookup({}),
  );

  assert.equal(result.failure, "missing_cookie");
  assert.equal(result.session, null);
});

test("resolveSessionFromCookie returns invalid_session when cookie does not map to session", async () => {
  const result = await resolveSessionFromCookie(
    "threefc_session=session-404",
    "threefc_session",
    new InMemorySessionLookup({}),
  );

  assert.equal(result.failure, "invalid_session");
  assert.equal(result.session, null);
});

test("resolveSessionFromCookie returns session when cookie maps to active session", async () => {
  const result = await resolveSessionFromCookie(
    "threefc_session=session-1",
    "threefc_session",
    new InMemorySessionLookup({
      "session-1": {
        sessionId: "session-1",
        email: "player@example.com",
        createdAt: "2026-02-22T00:00:00.000Z",
        expiresAt: "2026-02-23T00:00:00.000Z",
      },
    }),
  );

  assert.equal(result.failure, null);
  assert(result.session);
  assert.equal(result.session.sessionId, "session-1");
  assert.equal(result.session.email, "player@example.com");
});
