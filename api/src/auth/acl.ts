import type { LeagueAclRecord, SeasonRecord, SessionRecord } from "../data/types.js";

const ROUTES = {
  createLeague: /^\/v1\/leagues$/,
  createSeason: /^\/v1\/leagues\/([^/]+)\/seasons$/,
  createSession: /^\/v1\/seasons\/([^/]+)\/sessions$/,
  createGame: /^\/v1\/sessions\/([^/]+)\/games$/,
} as const;

export type ProtectedMutationOperation =
  | "createLeague"
  | "createSeason"
  | "createSession"
  | "createGame";

export interface ProtectedMutationRoute {
  operation: ProtectedMutationOperation;
  leagueId?: string;
  seasonId?: string;
  sessionId?: string;
}

export interface AclLookup {
  getLeagueAccess(leagueId: string, userId: string): Promise<LeagueAclRecord | null>;
  getSeason(seasonId: string): Promise<SeasonRecord | null>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
}

export interface AclErrorResponse {
  error: "forbidden" | "not_found";
  code: "admin_required" | "acl_scope_not_found";
  message: string;
}

export interface AclAuthorizationResult {
  allowed: boolean;
  statusCode: number;
  operation: ProtectedMutationOperation | null;
  scope: { leagueId: string; seasonId?: string; sessionId?: string } | null;
  error: AclErrorResponse | null;
}

function decodeRouteParam(value: string): string {
  return decodeURIComponent(value);
}

export function resolveProtectedMutationRoute(
  method: string,
  route: string,
): ProtectedMutationRoute | null {
  const upperMethod = method.toUpperCase();
  if (upperMethod !== "POST") {
    return null;
  }

  if (ROUTES.createLeague.test(route)) {
    return { operation: "createLeague" };
  }

  const seasonMatch = route.match(ROUTES.createSeason);
  if (seasonMatch) {
    return {
      operation: "createSeason",
      leagueId: decodeRouteParam(seasonMatch[1]),
    };
  }

  const sessionMatch = route.match(ROUTES.createSession);
  if (sessionMatch) {
    return {
      operation: "createSession",
      seasonId: decodeRouteParam(sessionMatch[1]),
    };
  }

  const gameMatch = route.match(ROUTES.createGame);
  if (gameMatch) {
    return {
      operation: "createGame",
      sessionId: decodeRouteParam(gameMatch[1]),
    };
  }

  return null;
}

function forbiddenAdminRequired(leagueId: string): AclAuthorizationResult {
  return {
    allowed: false,
    statusCode: 403,
    operation: null,
    scope: null,
    error: {
      error: "forbidden",
      code: "admin_required",
      message: `Admin role is required for league ${leagueId}.`,
    },
  };
}

function missingScope(scopeType: "season" | "session", scopeId: string): AclAuthorizationResult {
  return {
    allowed: false,
    statusCode: 404,
    operation: null,
    scope: null,
    error: {
      error: "not_found",
      code: "acl_scope_not_found",
      message: `ACL scope could not be resolved for ${scopeType} ${scopeId}.`,
    },
  };
}

async function verifyLeagueAdmin(
  userId: string,
  leagueId: string,
  aclLookup: AclLookup,
): Promise<boolean> {
  const access = await aclLookup.getLeagueAccess(leagueId, userId);
  return access?.role === "admin";
}

export async function authorizeProtectedMutation(
  method: string,
  route: string,
  userId: string,
  aclLookup: AclLookup,
): Promise<AclAuthorizationResult> {
  const resolvedRoute = resolveProtectedMutationRoute(method, route);
  if (!resolvedRoute) {
    return {
      allowed: true,
      statusCode: 200,
      operation: null,
      scope: null,
      error: null,
    };
  }

  if (resolvedRoute.operation === "createLeague") {
    return {
      allowed: true,
      statusCode: 200,
      operation: resolvedRoute.operation,
      scope: null,
      error: null,
    };
  }

  if (resolvedRoute.operation === "createSeason") {
    const leagueId = resolvedRoute.leagueId as string;
    const isAdmin = await verifyLeagueAdmin(userId, leagueId, aclLookup);

    if (!isAdmin) {
      return forbiddenAdminRequired(leagueId);
    }

    return {
      allowed: true,
      statusCode: 200,
      operation: resolvedRoute.operation,
      scope: { leagueId },
      error: null,
    };
  }

  if (resolvedRoute.operation === "createSession") {
    const seasonId = resolvedRoute.seasonId as string;
    const season = await aclLookup.getSeason(seasonId);

    if (!season) {
      return missingScope("season", seasonId);
    }

    const isAdmin = await verifyLeagueAdmin(userId, season.leagueId, aclLookup);
    if (!isAdmin) {
      return forbiddenAdminRequired(season.leagueId);
    }

    return {
      allowed: true,
      statusCode: 200,
      operation: resolvedRoute.operation,
      scope: {
        leagueId: season.leagueId,
        seasonId,
      },
      error: null,
    };
  }

  const sessionId = resolvedRoute.sessionId as string;
  const session = await aclLookup.getSession(sessionId);
  if (!session) {
    return missingScope("session", sessionId);
  }

  const season = await aclLookup.getSeason(session.seasonId);
  if (!season) {
    return missingScope("season", session.seasonId);
  }

  const isAdmin = await verifyLeagueAdmin(userId, season.leagueId, aclLookup);
  if (!isAdmin) {
    return forbiddenAdminRequired(season.leagueId);
  }

  return {
    allowed: true,
    statusCode: 200,
    operation: resolvedRoute.operation,
    scope: {
      leagueId: season.leagueId,
      seasonId: session.seasonId,
      sessionId,
    },
    error: null,
  };
}
