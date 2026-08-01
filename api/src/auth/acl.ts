import type { GameRecord, LeagueAclRecord, SeasonRecord, SessionRecord } from "../data/types.js";

const ROUTES = {
  createLeague: /^\/v1\/leagues$/,
  createSeason: /^\/v1\/leagues\/([^/]+)\/seasons$/,
  createSession: /^\/v1\/seasons\/([^/]+)\/sessions$/,
  createGame: /^\/v1\/sessions\/([^/]+)\/games$/,
  updateSeasonTeam: /^\/v1\/seasons\/([^/]+)\/teams\/([^/]+)$/,
  updateGameTeam: /^\/v1\/games\/([^/]+)\/teams\/([^/]+)$/,
  createGamePlayer: /^\/v1\/games\/([^/]+)\/players$/,
  assignRosterPlayer: /^\/v1\/games\/([^/]+)\/roster\/([^/]+)$/,
  startGameThird: /^\/v1\/games\/([^/]+)\/thirds\/([^/]*)\/start$/,
  finishGameThird: /^\/v1\/games\/([^/]+)\/thirds\/([^/]*)\/finish$/,
  finishGame: /^\/v1\/games\/([^/]+)\/finish$/,
  createGoal: /^\/v1\/games\/([^/]+)\/goals$/,
  updateGoal: /^\/v1\/games\/([^/]+)\/goals\/([^/]+)$/,
  deleteGoal: /^\/v1\/games\/([^/]+)\/goals\/([^/]+)$/,
  undoLastGoal: /^\/v1\/games\/([^/]+)\/goals\/undo-last$/,
  claimPlayer: /^\/v1\/players\/([^/]+)\/claim$/,
  grantLeagueAccess: /^\/v1\/leagues\/([^/]+)\/access$/,
} as const;

export type ProtectedMutationOperation =
  | "createLeague"
  | "createSeason"
  | "createSession"
  | "createGame"
  | "updateSeasonTeam"
  | "updateGameTeam"
  | "createGamePlayer"
  | "assignRosterPlayer"
  | "startGameThird"
  | "finishGameThird"
  | "finishGame"
  | "createGoal"
  | "updateGoal"
  | "deleteGoal"
  | "undoLastGoal"
  | "claimPlayer"
  | "grantLeagueAccess";

export interface ProtectedMutationRoute {
  operation: ProtectedMutationOperation;
  leagueId?: string;
  seasonId?: string;
  sessionId?: string;
  gameId?: string;
}

export interface AclLookup {
  getLeagueAccess(leagueId: string, userId: string): Promise<LeagueAclRecord | null>;
  getSeason(seasonId: string): Promise<SeasonRecord | null>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  getGame(gameId: string): Promise<GameRecord | null>;
}

export interface AclErrorResponse {
  error: "forbidden" | "not_found";
  code: "admin_required" | "scorekeeper_required" | "acl_scope_not_found";
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
  if (upperMethod === "POST" && ROUTES.createLeague.test(route)) {
    return { operation: "createLeague" };
  }

  const seasonMatch = upperMethod === "POST" ? route.match(ROUTES.createSeason) : null;
  if (seasonMatch) {
    return {
      operation: "createSeason",
      leagueId: decodeRouteParam(seasonMatch[1]),
    };
  }

  const sessionMatch = upperMethod === "POST" ? route.match(ROUTES.createSession) : null;
  if (sessionMatch) {
    return {
      operation: "createSession",
      seasonId: decodeRouteParam(sessionMatch[1]),
    };
  }

  const createGameMatch = upperMethod === "POST" ? route.match(ROUTES.createGame) : null;
  if (createGameMatch) {
    return {
      operation: "createGame",
      sessionId: decodeRouteParam(createGameMatch[1]),
    };
  }

  const updateSeasonTeamMatch = upperMethod === "PUT" ? route.match(ROUTES.updateSeasonTeam) : null;
  if (updateSeasonTeamMatch) {
    return {
      operation: "updateSeasonTeam",
      seasonId: decodeRouteParam(updateSeasonTeamMatch[1]),
    };
  }

  const updateGameTeamMatch = upperMethod === "PUT" ? route.match(ROUTES.updateGameTeam) : null;
  if (updateGameTeamMatch) {
    return {
      operation: "updateGameTeam",
      gameId: decodeRouteParam(updateGameTeamMatch[1]),
    };
  }

  const createGamePlayerMatch = upperMethod === "POST" ? route.match(ROUTES.createGamePlayer) : null;
  if (createGamePlayerMatch) {
    return {
      operation: "createGamePlayer",
      gameId: decodeRouteParam(createGamePlayerMatch[1]),
    };
  }

  const assignRosterPlayerMatch = upperMethod === "PUT" ? route.match(ROUTES.assignRosterPlayer) : null;
  if (assignRosterPlayerMatch) {
    return {
      operation: "assignRosterPlayer",
      gameId: decodeRouteParam(assignRosterPlayerMatch[1]),
    };
  }

  const startGameThirdMatch = upperMethod === "POST" ? route.match(ROUTES.startGameThird) : null;
  if (startGameThirdMatch) {
    return {
      operation: "startGameThird",
      gameId: decodeRouteParam(startGameThirdMatch[1]),
    };
  }

  const finishGameThirdMatch = upperMethod === "POST" ? route.match(ROUTES.finishGameThird) : null;
  if (finishGameThirdMatch) {
    return {
      operation: "finishGameThird",
      gameId: decodeRouteParam(finishGameThirdMatch[1]),
    };
  }

  const finishGameMatch = upperMethod === "POST" ? route.match(ROUTES.finishGame) : null;
  if (finishGameMatch) {
    return {
      operation: "finishGame",
      gameId: decodeRouteParam(finishGameMatch[1]),
    };
  }

  const createGoalMatch = upperMethod === "POST" ? route.match(ROUTES.createGoal) : null;
  if (createGoalMatch) {
    return {
      operation: "createGoal",
      gameId: decodeRouteParam(createGoalMatch[1]),
    };
  }

  const updateGoalMatch = upperMethod === "PATCH" ? route.match(ROUTES.updateGoal) : null;
  if (updateGoalMatch) {
    return {
      operation: "updateGoal",
      gameId: decodeRouteParam(updateGoalMatch[1]),
    };
  }

  const deleteGoalMatch = upperMethod === "DELETE" ? route.match(ROUTES.deleteGoal) : null;
  if (deleteGoalMatch) {
    return {
      operation: "deleteGoal",
      gameId: decodeRouteParam(deleteGoalMatch[1]),
    };
  }

  const undoLastGoalMatch = upperMethod === "POST" ? route.match(ROUTES.undoLastGoal) : null;
  if (undoLastGoalMatch) {
    return {
      operation: "undoLastGoal",
      gameId: decodeRouteParam(undoLastGoalMatch[1]),
    };
  }

  const claimPlayerMatch = upperMethod === "POST" ? route.match(ROUTES.claimPlayer) : null;
  if (claimPlayerMatch) {
    return {
      operation: "claimPlayer",
    };
  }

  const grantLeagueAccessMatch = upperMethod === "POST" ? route.match(ROUTES.grantLeagueAccess) : null;
  if (grantLeagueAccessMatch) {
    return {
      operation: "grantLeagueAccess",
      leagueId: decodeRouteParam(grantLeagueAccessMatch[1]),
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

function forbiddenScorekeeperRequired(leagueId: string): AclAuthorizationResult {
  return {
    allowed: false,
    statusCode: 403,
    operation: null,
    scope: null,
    error: {
      error: "forbidden",
      code: "scorekeeper_required",
      message: `Admin or scorekeeper role is required for league ${leagueId}.`,
    },
  };
}

function missingScope(scopeType: "game" | "season" | "session", scopeId: string): AclAuthorizationResult {
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

async function verifyLeagueRole(
  userId: string,
  leagueId: string,
  aclLookup: AclLookup,
  allowedRoles: ReadonlySet<LeagueAclRecord["role"]>,
): Promise<boolean> {
  const access = await aclLookup.getLeagueAccess(leagueId, userId);
  return access ? allowedRoles.has(access.role) : false;
}

async function resolveGameScope(
  gameId: string,
  aclLookup: AclLookup,
): Promise<
  | { found: true; game: GameRecord; leagueId: string; seasonId: string; sessionId: string }
  | { found: false; scopeType: "game" | "season"; scopeId: string }
> {
  const game = await aclLookup.getGame(gameId);
  if (!game) {
    return { found: false, scopeType: "game", scopeId: gameId };
  }

  const season = await aclLookup.getSeason(game.seasonId);
  if (!season) {
    return { found: false, scopeType: "season", scopeId: game.seasonId };
  }

  return {
    found: true,
    game,
    leagueId: game.leagueId,
    seasonId: game.seasonId,
    sessionId: game.sessionId,
  };
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

  if (resolvedRoute.operation === "claimPlayer") {
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

  if (resolvedRoute.operation === "grantLeagueAccess") {
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

  if (resolvedRoute.operation === "createGame") {
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

  if (resolvedRoute.operation === "updateSeasonTeam") {
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

  const gameScope = await resolveGameScope(resolvedRoute.gameId as string, aclLookup);
  if (!gameScope.found) {
    return missingScope(gameScope.scopeType, gameScope.scopeId);
  }

  if (resolvedRoute.operation === "updateGameTeam") {
    const isAdmin = await verifyLeagueAdmin(userId, gameScope.leagueId, aclLookup);
    if (!isAdmin) {
      return forbiddenAdminRequired(gameScope.leagueId);
    }

    return {
      allowed: true,
      statusCode: 200,
      operation: resolvedRoute.operation,
      scope: {
        leagueId: gameScope.leagueId,
        seasonId: gameScope.seasonId,
        sessionId: gameScope.sessionId,
      },
      error: null,
    };
  }

  const canOperateRoster = await verifyLeagueRole(
    userId,
    gameScope.leagueId,
    aclLookup,
    new Set(["admin", "scorekeeper"]),
  );
  if (!canOperateRoster) {
    return forbiddenScorekeeperRequired(gameScope.leagueId);
  }

  return {
    allowed: true,
    statusCode: 200,
    operation: resolvedRoute.operation,
    scope: {
      leagueId: gameScope.leagueId,
      seasonId: gameScope.seasonId,
      sessionId: gameScope.sessionId,
    },
    error: null,
  };
}
