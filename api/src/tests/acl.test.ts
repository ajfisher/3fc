import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeProtectedMutation,
  resolveProtectedMutationRoute,
  type AclLookup,
} from "../auth/acl.js";
import type { LeagueAclRecord, SeasonRecord, SessionRecord } from "../data/types.js";

interface AclHarnessInput {
  leagueAccess?: Record<string, LeagueAclRecord>;
  seasons?: Record<string, SeasonRecord>;
  sessions?: Record<string, SessionRecord>;
}

class InMemoryAclLookup implements AclLookup {
  constructor(private readonly input: AclHarnessInput) {}

  async getLeagueAccess(leagueId: string, userId: string): Promise<LeagueAclRecord | null> {
    return this.input.leagueAccess?.[`${leagueId}:${userId}`] ?? null;
  }

  async getSeason(seasonId: string): Promise<SeasonRecord | null> {
    return this.input.seasons?.[seasonId] ?? null;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.input.sessions?.[sessionId] ?? null;
  }
}

test("resolveProtectedMutationRoute maps supported mutation endpoints", () => {
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/leagues"), {
    operation: "createLeague",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/leagues/league-1/seasons"), {
    operation: "createSeason",
    leagueId: "league-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/seasons/season-1/sessions"), {
    operation: "createSession",
    seasonId: "season-1",
  });
  assert.deepEqual(resolveProtectedMutationRoute("POST", "/v1/sessions/session-1/games"), {
    operation: "createGame",
    sessionId: "session-1",
  });
  assert.equal(resolveProtectedMutationRoute("GET", "/v1/leagues"), null);
});

test("createLeague mutation is allowed for authenticated users", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/leagues",
    "user-1",
    new InMemoryAclLookup({}),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.operation, "createLeague");
  assert.equal(result.error, null);
});

test("league-scoped mutation rejects non-admin users", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/leagues/league-1/seasons",
    "user-1",
    new InMemoryAclLookup({
      leagueAccess: {
        "league-1:user-1": {
          leagueId: "league-1",
          userId: "user-1",
          role: "scorekeeper",
          grantedByUserId: "owner",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error?.code, "admin_required");
});

test("season-scoped mutation resolves league scope and allows admins", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/seasons/season-1/sessions",
    "admin-user",
    new InMemoryAclLookup({
      seasons: {
        "season-1": {
          leagueId: "league-1",
          seasonId: "season-1",
          name: "Season 1",
          slug: null,
          startsOn: null,
          endsOn: null,
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
      leagueAccess: {
        "league-1:admin-user": {
          leagueId: "league-1",
          userId: "admin-user",
          role: "admin",
          grantedByUserId: "admin-user",
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.scope, {
    leagueId: "league-1",
    seasonId: "season-1",
  });
});

test("session-scoped mutation returns not_found when acl scope cannot be resolved", async () => {
  const result = await authorizeProtectedMutation(
    "POST",
    "/v1/sessions/missing-session/games",
    "admin-user",
    new InMemoryAclLookup({}),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error?.code, "acl_scope_not_found");
});
