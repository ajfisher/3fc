import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  createDefaultThirdTimerSegments,
  DEFAULT_THIRD_LENGTH_MINUTES,
  type GameResult,
  type TeamId,
  type ThirdLengthMinutes,
  type ThirdTimerSegment,
} from "@3fc/contracts";

import {
  renderGamePage,
  renderLeaguePage,
  renderMagicLinkCallbackPage,
  renderSeasonPage,
  renderSetupHomePage,
  renderSignInPage,
} from "../ui/layout.js";

interface MockSession {
  sessionId: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

interface MockLeague {
  leagueId: string;
  name: string;
  slug: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface MockSeason {
  leagueId: string;
  seasonId: string;
  name: string;
  slug: string | null;
  startsOn: string | null;
  endsOn: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockSessionEntity {
  seasonId: string;
  sessionId: string;
  sessionDate: string;
  createdAt: string;
  updatedAt: string;
}

interface MockGame {
  gameId: string;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status: "scheduled" | "live" | "finished";
  gameStartTs: string;
  thirdLengthMinutes: ThirdLengthMinutes;
  thirds: ThirdTimerSegment[];
  finishedAt?: string | null;
  result?: GameResult | null;
  createdAt: string;
  updatedAt: string;
}

interface MockTeam {
  gameId?: string;
  seasonId?: string;
  teamId: TeamId;
  name: string;
  color: string | null;
  scored?: number;
  conceded?: number;
  createdAt: string;
  updatedAt: string;
}

interface MockPlayer {
  playerId: string;
  nickname: string;
  claimedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockRosterAssignment {
  gameId: string;
  teamId: TeamId;
  playerId: string;
  createdAt: string;
  updatedAt: string;
}

interface MockGamePlayer {
  gameId: string;
  playerId: string;
  createdAt: string;
  updatedAt: string;
}

interface MockGoalEvent {
  gameId: string;
  eventId: string;
  third: 1 | 2 | 3;
  thirdMinute: number;
  gameMinute: number;
  elapsedSeconds: number;
  stoppageMinute: number | null;
  displayTime: string;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
  createdAt: string;
  updatedAt: string;
}

type MockLeagueRole = "admin" | "scorekeeper" | "viewer";

interface MockApiState {
  cookieJar: string;
  storage: Map<string, string>;
  pendingToken: string | null;
  pendingEmail: string | null;
  session: MockSession | null;
  leagues: Map<string, MockLeague>;
  leagueAccess: Map<string, MockLeagueRole>;
  seasons: Map<string, MockSeason>;
  sessions: Map<string, MockSessionEntity>;
  games: Map<string, MockGame>;
  seasonTeams: Map<string, MockTeam>;
  gameTeams: Map<string, MockTeam>;
  players: Map<string, MockPlayer>;
  gamePlayers: Map<string, MockGamePlayer>;
  roster: Map<string, MockRosterAssignment>;
  goalEvents: Map<string, MockGoalEvent>;
  goalSequence: number;
}

function readUiScript(fileName: string): string {
  return readFileSync(resolve(process.cwd(), "src/ui", fileName), "utf8");
}

function createMockApiState(): MockApiState {
  return {
    cookieJar: "",
    storage: new Map<string, string>(),
    pendingToken: null,
    pendingEmail: null,
    session: null,
    leagues: new Map<string, MockLeague>(),
    leagueAccess: new Map<string, MockLeagueRole>(),
    seasons: new Map<string, MockSeason>(),
    sessions: new Map<string, MockSessionEntity>(),
    games: new Map<string, MockGame>(),
    seasonTeams: new Map<string, MockTeam>(),
    gameTeams: new Map<string, MockTeam>(),
    players: new Map<string, MockPlayer>(),
    gamePlayers: new Map<string, MockGamePlayer>(),
    roster: new Map<string, MockRosterAssignment>(),
    goalEvents: new Map<string, MockGoalEvent>(),
    goalSequence: 0,
  };
}

function createJsonResponse(
  status: number,
  payload: unknown,
  init: { headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function isValidEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isAuthenticated(state: MockApiState): boolean {
  return Boolean(state.session && state.cookieJar.includes(`threefc_session=${state.session.sessionId}`));
}

function leagueAccessKey(leagueId: string, userId: string): string {
  return `${leagueId}:${userId}`;
}

function grantMockLeagueAccess(
  state: MockApiState,
  leagueId: string,
  userId: string,
  role: MockLeagueRole,
): void {
  state.leagueAccess.set(leagueAccessKey(leagueId, userId), role);
}

function mockLeagueRoleForSession(state: MockApiState, league: MockLeague): MockLeagueRole | null {
  if (!state.session) {
    return null;
  }

  return state.leagueAccess.get(leagueAccessKey(league.leagueId, state.session.email)) ?? null;
}

function canMockCorrectFinishedGame(state: MockApiState, game: MockGame): boolean {
  const league = state.leagues.get(game.leagueId);
  return Boolean(league && mockLeagueRoleForSession(state, league) === "admin");
}

function mockFinishedGameMutationError(game: MockGame): Response {
  return createJsonResponse(409, {
    error: "finished_game_locked",
    message: `Game ${game.gameId} is finished. Admin role is required to mutate finished games.`,
  });
}

function parseMockThirdRouteParam(value: string): 1 | 2 | 3 | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }

  if (decoded === "1" || decoded === "2" || decoded === "3") {
    return Number(decoded) as 1 | 2 | 3;
  }

  return null;
}

const DEFAULT_MOCK_TEAMS: Array<{ teamId: TeamId; name: string; color: string }> = [
  { teamId: "red", name: "Red", color: "#d83b36" },
  { teamId: "blue", name: "Blue", color: "#2364d2" },
  { teamId: "yellow", name: "Yellow", color: "#e0a612" },
];

function ensureSeasonTeams(state: MockApiState, seasonId: string): MockTeam[] {
  for (const team of DEFAULT_MOCK_TEAMS) {
    const key = `${seasonId}:${team.teamId}`;
    if (state.seasonTeams.has(key)) {
      continue;
    }

    state.seasonTeams.set(key, {
      seasonId,
      teamId: team.teamId,
      name: team.name,
      color: team.color,
      createdAt: "2026-03-28T11:00:05.000Z",
      updatedAt: "2026-03-28T11:00:05.000Z",
    });
  }

  return [...state.seasonTeams.values()].filter((team) => team.seasonId === seasonId);
}

function ensureGameTeams(state: MockApiState, game: MockGame): MockTeam[] {
  const seasonTeams = ensureSeasonTeams(state, game.seasonId);
  for (const team of seasonTeams) {
    const key = `${game.gameId}:${team.teamId}`;
    if (state.gameTeams.has(key)) {
      continue;
    }

    state.gameTeams.set(key, {
      gameId: game.gameId,
      teamId: team.teamId,
      name: team.name,
      color: team.color,
      scored: 0,
      conceded: 0,
      createdAt: "2026-03-28T11:00:06.000Z",
      updatedAt: "2026-03-28T11:00:06.000Z",
    });
  }

  return [...state.gameTeams.values()]
    .filter((team) => team.gameId === game.gameId)
    .map((team) => ({
      ...team,
      scored: team.scored ?? 0,
      conceded: team.conceded ?? 0,
    }));
}

function publicPlayer(player: MockPlayer): Omit<MockPlayer, "claimedByUserId"> {
  return {
    playerId: player.playerId,
    nickname: player.nickname,
    createdAt: player.createdAt,
    updatedAt: player.updatedAt,
  };
}

function sortedGoalTimeline(state: MockApiState, gameId: string): MockGoalEvent[] {
  return [...state.goalEvents.values()]
    .filter((goal) => goal.gameId === gameId)
    .sort((left, right) => {
      const thirdDelta = left.third - right.third;
      if (thirdDelta !== 0) {
        return thirdDelta;
      }

      const gameMinuteDelta = left.gameMinute - right.gameMinute;
      if (gameMinuteDelta !== 0) {
        return gameMinuteDelta;
      }

      const elapsedDelta = left.elapsedSeconds - right.elapsedSeconds;
      if (elapsedDelta !== 0) {
        return elapsedDelta;
      }

      const createdAtDelta = left.createdAt.localeCompare(right.createdAt);
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }

      return left.eventId.localeCompare(right.eventId);
    });
}

function recomputeMockScoreboard(state: MockApiState, game: MockGame): MockTeam[] {
  const teams = ensureGameTeams(state, game).map((team) => ({
    ...team,
    scored: 0,
    conceded: 0,
  }));
  const byTeamId = new Map(teams.map((team) => [team.teamId, team]));

  for (const goal of sortedGoalTimeline(state, game.gameId)) {
    if (!goal.ownGoal && goal.scoringTeamId) {
      const scoringTeam = byTeamId.get(goal.scoringTeamId);
      if (scoringTeam) {
        scoringTeam.scored = (scoringTeam.scored ?? 0) + 1;
      }
    }

    const concedingTeam = byTeamId.get(goal.concedingTeamId);
    if (concedingTeam) {
      concedingTeam.conceded = (concedingTeam.conceded ?? 0) + 1;
    }
  }

  for (const team of teams) {
    state.gameTeams.set(`${game.gameId}:${team.teamId}`, team);
  }

  return teams;
}

function compareMockTeamIds(left: TeamId, right: TeamId): number {
  const leftIndex = DEFAULT_MOCK_TEAMS.findIndex((team) => team.teamId === left);
  const rightIndex = DEFAULT_MOCK_TEAMS.findIndex((team) => team.teamId === right);
  const leftSort = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
  const rightSort = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
  const orderDelta = leftSort - rightSort;
  return orderDelta !== 0 ? orderDelta : left.localeCompare(right);
}

function compareMockResultTeams(left: MockTeam, right: MockTeam): number {
  const concededDelta = (left.conceded ?? 0) - (right.conceded ?? 0);
  if (concededDelta !== 0) {
    return concededDelta;
  }

  const scoredDelta = (right.scored ?? 0) - (left.scored ?? 0);
  if (scoredDelta !== 0) {
    return scoredDelta;
  }

  return compareMockTeamIds(left.teamId, right.teamId);
}

function sameMockResultPosition(left: MockTeam, right: MockTeam): boolean {
  return (left.conceded ?? 0) === (right.conceded ?? 0) && (left.scored ?? 0) === (right.scored ?? 0);
}

function buildMockGameResult(state: MockApiState, game: MockGame, computedAt: string): GameResult {
  const rankedTeams = recomputeMockScoreboard(state, game).sort(compareMockResultTeams);
  const topTeam = rankedTeams[0] ?? null;
  const topTiedTeams = topTeam ? rankedTeams.filter((team) => sameMockResultPosition(team, topTeam)) : [];
  const winnerTeamId = topTiedTeams.length === 1 ? topTiedTeams[0].teamId : null;

  let previousTeam: MockTeam | null = null;
  let previousRank = 0;
  const teams = rankedTeams.map((team, index) => {
    const rank = previousTeam && sameMockResultPosition(team, previousTeam) ? previousRank : index + 1;
    previousTeam = team;
    previousRank = rank;

    const outcome: GameResult["teams"][number]["outcome"] = winnerTeamId
      ? team.teamId === winnerTeamId
        ? "win"
        : "loss"
      : topTeam && sameMockResultPosition(team, topTeam)
        ? "draw"
        : "loss";

    return {
      teamId: team.teamId,
      name: team.name,
      color: team.color,
      scored: team.scored ?? 0,
      conceded: team.conceded ?? 0,
      rank,
      outcome,
    };
  });

  return {
    winnerTeamId,
    outcome: winnerTeamId ? "win" : "draw",
    comparator: "fewest_conceded_then_most_scored",
    computedAt,
    teams,
  };
}

function goalResponsePayload(state: MockApiState, game: MockGame, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    scoreboard: {
      teams: recomputeMockScoreboard(state, game),
    },
    timeline: sortedGoalTimeline(state, game.gameId),
  };
}

function refreshMockFinishedResult(state: MockApiState, game: MockGame, computedAt: string): MockGame {
  if (game.status !== "finished") {
    return game;
  }

  const updated: MockGame = {
    ...game,
    finishedAt: game.finishedAt ?? computedAt,
    result: buildMockGameResult(state, game, computedAt),
    updatedAt: computedAt,
  };
  state.games.set(game.gameId, updated);
  return updated;
}

function teamIdsForGame(state: MockApiState, game: MockGame): Set<TeamId> {
  return new Set(ensureGameTeams(state, game).map((team) => team.teamId));
}

function rosterByPlayerId(state: MockApiState, gameId: string): Map<string, MockRosterAssignment> {
  return new Map(
    [...state.roster.values()]
      .filter((assignment) => assignment.gameId === gameId)
      .map((assignment) => [assignment.playerId, assignment]),
  );
}

function validateMockGoalPayload(
  state: MockApiState,
  game: MockGame,
  payload: {
    scoringTeamId: TeamId | null;
    concedingTeamId: TeamId;
    scorerPlayerId: string;
    assistPlayerIds: string[];
    ownGoal: boolean;
  },
): Response | null {
  const gameTeamIds = teamIdsForGame(state, game);
  if (!gameTeamIds.has(payload.concedingTeamId)) {
    return createJsonResponse(400, { error: "invalid_conceding_team", message: "Conceding team is invalid." });
  }

  if (payload.ownGoal && payload.scoringTeamId !== null) {
    return createJsonResponse(400, { error: "own_goal_scoring_team", message: "Own goals require scoringTeamId=null." });
  }

  if (!payload.ownGoal && (!payload.scoringTeamId || !gameTeamIds.has(payload.scoringTeamId))) {
    return createJsonResponse(400, { error: "invalid_scoring_team", message: "Scoring team is invalid." });
  }

  if (!payload.ownGoal && payload.scoringTeamId === payload.concedingTeamId) {
    return createJsonResponse(400, { error: "same_team_goal", message: "Scoring and conceding teams must differ." });
  }

  const uniqueAssists = new Set(payload.assistPlayerIds);
  if (payload.assistPlayerIds.length > 3 || uniqueAssists.size !== payload.assistPlayerIds.length) {
    return createJsonResponse(400, { error: "invalid_assists", message: "Assists must be unique and capped at 3." });
  }

  if (uniqueAssists.has(payload.scorerPlayerId)) {
    return createJsonResponse(400, { error: "invalid_assists", message: "Scorer cannot also assist." });
  }

  const roster = rosterByPlayerId(state, game.gameId);
  const scorerAssignment = roster.get(payload.scorerPlayerId);
  if (!scorerAssignment) {
    return createJsonResponse(400, { error: "scorer_not_rostered", message: "Scorer must be rostered." });
  }

  if (!payload.ownGoal && scorerAssignment.teamId !== payload.scoringTeamId) {
    return createJsonResponse(400, { error: "scorer_not_on_scoring_team", message: "Scorer must be on scoring team." });
  }

  if (payload.ownGoal && scorerAssignment.teamId !== payload.concedingTeamId) {
    return createJsonResponse(400, { error: "scorer_not_on_conceding_team", message: "Own-goal scorer must be on conceding team." });
  }

  for (const assistPlayerId of payload.assistPlayerIds) {
    if (!roster.has(assistPlayerId)) {
      return createJsonResponse(400, { error: "assist_not_rostered", message: "Assist players must be rostered." });
    }
  }

  return null;
}

function activeMockThird(game: MockGame): 1 | 2 | 3 | null {
  const running = game.thirds.find((third) => third.startedAt && !third.finishedAt);
  if (!running || (running.third !== 1 && running.third !== 2 && running.third !== 3)) {
    return null;
  }

  return running.third;
}

function readInitHeader(init: RequestInit, headerName: string): string | null {
  const headers = init.headers;
  if (!headers) {
    return null;
  }

  if (headers instanceof Headers) {
    return headers.get(headerName);
  }

  const lowerName = headerName.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find(([name]) => name.toLowerCase() === lowerName);
    return found?.[1] ?? null;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lowerName) {
      return String(value);
    }
  }

  return null;
}

function requireIdempotencyKey(init: RequestInit): Response | null {
  const value = readInitHeader(init, "idempotency-key");
  if (value && value.trim().length > 0) {
    return null;
  }

  return createJsonResponse(400, {
    error: "invalid_idempotency_key",
    message: "Idempotency-Key header is required.",
  });
}

function createMockFetch(state: MockApiState) {
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const path = target.pathname;
    const body =
      typeof init.body === "string" && init.body.length > 0
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    if (method === "POST" && path === "/v1/auth/magic/start") {
      if (!isValidEmail(body.email)) {
        return createJsonResponse(400, {
          error: "invalid_email",
          message: "Email must be a valid email address.",
        });
      }

      state.pendingEmail = body.email;
      state.pendingToken = "token-1";
      return createJsonResponse(202, {
        status: "sent",
        email: body.email,
        expiresAt: "2026-03-28T11:15:00.000Z",
        messageId: "msg-1",
      });
    }

    if (method === "POST" && path === "/v1/auth/magic/complete") {
      if (body.token !== state.pendingToken || !state.pendingEmail) {
        return createJsonResponse(401, {
          error: "invalid_or_expired_magic_link",
          message: "Invalid or expired magic link.",
        });
      }

      state.session = {
        sessionId: "session-1",
        email: state.pendingEmail,
        createdAt: "2026-03-28T11:00:00.000Z",
        expiresAt: "2026-03-29T11:00:00.000Z",
      };
      state.cookieJar = `threefc_session=${state.session.sessionId}`;

      return createJsonResponse(
        200,
        {
          status: "authenticated",
          session: state.session,
        },
        {
          headers: {
            "set-cookie": `${state.cookieJar}; Path=/; HttpOnly; SameSite=Lax`,
          },
        },
      );
    }

    if (method === "GET" && path === "/v1/auth/session") {
      if (!isAuthenticated(state) || !state.session) {
        return createJsonResponse(401, {
          error: "unauthorized",
          message: "Valid session cookie required.",
        });
      }

      return createJsonResponse(200, {
        authenticated: true,
        session: state.session,
      });
    }

    if (!isAuthenticated(state) || !state.session) {
      return createJsonResponse(401, {
        error: "unauthorized",
        message: "Valid session cookie required.",
      });
    }

    if (method === "GET" && path === "/v1/leagues") {
      return createJsonResponse(200, {
        leagues: [...state.leagues.values()].sort((left, right) => left.name.localeCompare(right.name)),
      });
    }

    if (method === "POST" && path === "/v1/leagues") {
      const leagueId = String(body.leagueId ?? "");
      const name = String(body.name ?? "");
      const slug = typeof body.slug === "string" ? body.slug : null;
      const now = "2026-03-28T11:00:01.000Z";
      const league: MockLeague = {
        leagueId,
        name,
        slug,
        createdByUserId: state.session.email,
        createdAt: now,
        updatedAt: now,
      };
      state.leagues.set(leagueId, league);
      grantMockLeagueAccess(state, leagueId, state.session.email, "admin");
      return createJsonResponse(201, league);
    }

    const leagueMatch = path.match(/^\/v1\/leagues\/([^/]+)$/);
    if (method === "GET" && leagueMatch) {
      const league = state.leagues.get(decodeURIComponent(leagueMatch[1]));
      if (!league) {
        return createJsonResponse(404, { error: "not_found", message: "League not found." });
      }

      const role = mockLeagueRoleForSession(state, league);
      if (!role) {
        return createJsonResponse(403, {
          error: "league_access_required",
          message: `Access to league ${league.leagueId} is required.`,
        });
      }

      return createJsonResponse(200, {
        ...league,
        access: {
          role,
        },
      });
    }

    if (method === "DELETE" && leagueMatch) {
      const leagueId = decodeURIComponent(leagueMatch[1]);
      if (![...state.leagues.keys()].includes(leagueId)) {
        return createJsonResponse(404, { error: "not_found", message: "League not found." });
      }

      if ([...state.seasons.values()].some((season) => season.leagueId === leagueId)) {
        return createJsonResponse(409, {
          error: "conflict",
          message: "Cannot delete league with existing seasons.",
        });
      }

      state.leagues.delete(leagueId);
      return new Response(null, { status: 204 });
    }

    const leagueSeasonsMatch = path.match(/^\/v1\/leagues\/([^/]+)\/seasons$/);
    if (method === "GET" && leagueSeasonsMatch) {
      const leagueId = decodeURIComponent(leagueSeasonsMatch[1]);
      return createJsonResponse(200, {
        seasons: [...state.seasons.values()].filter((season) => season.leagueId === leagueId),
      });
    }

    if (method === "POST" && leagueSeasonsMatch) {
      const leagueId = decodeURIComponent(leagueSeasonsMatch[1]);
      const seasonId = String(body.seasonId ?? "");
      const name = String(body.name ?? "");
      const slug = typeof body.slug === "string" ? body.slug : null;
      const startsOn = typeof body.startsOn === "string" && body.startsOn.length > 0 ? body.startsOn : null;
      const endsOn = typeof body.endsOn === "string" && body.endsOn.length > 0 ? body.endsOn : null;
      const now = "2026-03-28T11:00:02.000Z";
      const season: MockSeason = {
        leagueId,
        seasonId,
        name,
        slug,
        startsOn,
        endsOn,
        createdAt: now,
        updatedAt: now,
      };
      state.seasons.set(seasonId, season);
      return createJsonResponse(201, season);
    }

    const seasonMatch = path.match(/^\/v1\/seasons\/([^/]+)$/);
    if (method === "GET" && seasonMatch) {
      const season = state.seasons.get(decodeURIComponent(seasonMatch[1]));
      if (!season) {
        return createJsonResponse(404, { error: "not_found", message: "Season not found." });
      }

      return createJsonResponse(200, season);
    }

    if (method === "DELETE" && seasonMatch) {
      const seasonId = decodeURIComponent(seasonMatch[1]);
      if (![...state.seasons.keys()].includes(seasonId)) {
        return createJsonResponse(404, { error: "not_found", message: "Season not found." });
      }

      if ([...state.games.values()].some((game) => game.seasonId === seasonId)) {
        return createJsonResponse(409, {
          error: "conflict",
          message: "Cannot delete season with existing games.",
        });
      }

      state.seasons.delete(seasonId);
      return new Response(null, { status: 204 });
    }

    const seasonGamesMatch = path.match(/^\/v1\/seasons\/([^/]+)\/games$/);
    if (method === "GET" && seasonGamesMatch) {
      const seasonId = decodeURIComponent(seasonGamesMatch[1]);
      return createJsonResponse(200, {
        games: [...state.games.values()].filter((game) => game.seasonId === seasonId),
      });
    }

    const seasonSessionsMatch = path.match(/^\/v1\/seasons\/([^/]+)\/sessions$/);
    if (method === "POST" && seasonSessionsMatch) {
      const seasonId = decodeURIComponent(seasonSessionsMatch[1]);
      const sessionId = String(body.sessionId ?? "");
      const sessionDate = String(body.sessionDate ?? "");
      const now = "2026-03-28T11:00:03.000Z";
      const sessionRecord: MockSessionEntity = {
        seasonId,
        sessionId,
        sessionDate,
        createdAt: now,
        updatedAt: now,
      };
      state.sessions.set(sessionId, sessionRecord);
      return createJsonResponse(201, sessionRecord);
    }

    const sessionGamesMatch = path.match(/^\/v1\/sessions\/([^/]+)\/games$/);
    if (method === "POST" && sessionGamesMatch) {
      const sessionId = decodeURIComponent(sessionGamesMatch[1]);
      const sessionRecord = state.sessions.get(sessionId);
      if (!sessionRecord) {
        return createJsonResponse(404, { error: "not_found", message: "Session not found." });
      }

      const season = state.seasons.get(sessionRecord.seasonId);
      if (!season) {
        return createJsonResponse(404, { error: "not_found", message: "Season not found." });
      }

      const gameId = String(body.gameId ?? "");
      const now = "2026-03-28T11:00:04.000Z";
      const game: MockGame = {
        gameId,
        leagueId: season.leagueId,
        seasonId: season.seasonId,
        sessionId,
        status: body.status === "live" || body.status === "finished" ? body.status : "scheduled",
        gameStartTs: String(body.gameStartTs ?? ""),
        thirdLengthMinutes:
          body.thirdLengthMinutes === 25 || body.thirdLengthMinutes === 30
            ? body.thirdLengthMinutes
            : DEFAULT_THIRD_LENGTH_MINUTES,
        thirds: createDefaultThirdTimerSegments(),
        finishedAt: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      state.games.set(gameId, game);
      ensureGameTeams(state, game);
      return createJsonResponse(201, game);
    }

    const gameMatch = path.match(/^\/v1\/games\/([^/]+)$/);
    if (method === "GET" && gameMatch) {
      const game = state.games.get(decodeURIComponent(gameMatch[1]));
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      return createJsonResponse(200, game);
    }

    if (method === "PATCH" && gameMatch) {
      const gameId = decodeURIComponent(gameMatch[1]);
      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      if (body.status === "scheduled" && game.thirds.some((third) => third.startedAt !== null)) {
        return createJsonResponse(409, {
          error: "conflict",
          code: "timer_status_locked",
          message: "Game status cannot be set back to scheduled after a third has started.",
        });
      }

      const updated: MockGame = {
        ...game,
        status:
          body.status === "scheduled" || body.status === "live" || body.status === "finished"
            ? body.status
            : game.status,
        gameStartTs: typeof body.gameStartTs === "string" ? body.gameStartTs : game.gameStartTs,
        thirdLengthMinutes:
          body.thirdLengthMinutes === 20 || body.thirdLengthMinutes === 25 || body.thirdLengthMinutes === 30
            ? body.thirdLengthMinutes
            : game.thirdLengthMinutes,
        updatedAt: "2026-03-28T11:00:09.000Z",
      };
      state.games.set(gameId, updated);
      return createJsonResponse(200, updated);
    }

    const startThirdMatch = path.match(/^\/v1\/games\/([^/]+)\/thirds\/([^/]+)\/start$/);
    if (method === "POST" && startThirdMatch) {
      const gameId = decodeURIComponent(startThirdMatch[1]);
      const thirdNumber = parseMockThirdRouteParam(startThirdMatch[2]);
      if (!thirdNumber) {
        return createJsonResponse(400, { error: "Third must be 1, 2, or 3." });
      }

      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const thirds = game.thirds.map((third) => ({ ...third }));
      const target = thirds.find((third) => third.third === thirdNumber);
      if (!target) {
        return createJsonResponse(400, { error: "Third must be 1, 2, or 3." });
      }
      if (target.startedAt) {
        return createJsonResponse(409, {
          error: "conflict",
          message: `Third ${thirdNumber} has already been started.`,
        });
      }

      target.startedAt = "2026-03-28T11:00:10.000Z";
      const updated: MockGame = {
        ...game,
        status: "live",
        thirds,
        updatedAt: "2026-03-28T11:00:10.000Z",
      };
      state.games.set(gameId, updated);
      return createJsonResponse(200, updated);
    }

    const finishThirdMatch = path.match(/^\/v1\/games\/([^/]+)\/thirds\/([^/]+)\/finish$/);
    if (method === "POST" && finishThirdMatch) {
      const gameId = decodeURIComponent(finishThirdMatch[1]);
      const thirdNumber = parseMockThirdRouteParam(finishThirdMatch[2]);
      if (!thirdNumber) {
        return createJsonResponse(400, { error: "Third must be 1, 2, or 3." });
      }

      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const thirds = game.thirds.map((third) => ({ ...third }));
      const target = thirds.find((third) => third.third === thirdNumber);
      if (!target) {
        return createJsonResponse(400, { error: "Third must be 1, 2, or 3." });
      }

      if (!target?.startedAt) {
        return createJsonResponse(409, {
          error: "conflict",
          message: `Third ${thirdNumber} cannot be finished before it is started.`,
        });
      }

      target.finishedAt = "2026-03-28T11:00:11.000Z";
      const updated: MockGame = {
        ...game,
        thirds,
        updatedAt: "2026-03-28T11:00:11.000Z",
      };
      state.games.set(gameId, updated);
      return createJsonResponse(200, updated);
    }

    const finishGameMatch = path.match(/^\/v1\/games\/([^/]+)\/finish$/);
    if (method === "POST" && finishGameMatch) {
      const gameId = decodeURIComponent(finishGameMatch[1]);
      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const idempotencyError = requireIdempotencyKey(init);
      if (idempotencyError) {
        return idempotencyError;
      }

      if (game.status === "finished" && game.finishedAt && game.result) {
        return createJsonResponse(200, game);
      }

      const unfinishedThird = game.thirds.find((third) => !third.finishedAt);
      if (unfinishedThird) {
        return createJsonResponse(409, {
          error: "thirds_not_finished",
          message: "All thirds must be finished before finishing the game.",
        });
      }

      const finishedAt = "2026-03-28T11:00:12.000Z";
      const updated: MockGame = {
        ...game,
        status: "finished",
        finishedAt,
        result: buildMockGameResult(state, game, finishedAt),
        updatedAt: finishedAt,
      };
      state.games.set(gameId, updated);
      return createJsonResponse(200, updated);
    }

    const gameRosterMatch = path.match(/^\/v1\/games\/([^/]+)\/roster$/);
    if (method === "GET" && gameRosterMatch) {
      const game = state.games.get(decodeURIComponent(gameRosterMatch[1]));
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const teams = ensureGameTeams(state, game);
      const roster = [...state.roster.values()]
        .filter((assignment) => assignment.gameId === game.gameId)
        .map((assignment) => ({
          ...assignment,
          player: state.players.get(assignment.playerId)
            ? publicPlayer(state.players.get(assignment.playerId) as MockPlayer)
            : null,
        }));

      return createJsonResponse(200, {
        teams,
        roster,
      });
    }

    const gamePlayersMatch = path.match(/^\/v1\/games\/([^/]+)\/players$/);
    if (method === "GET" && gamePlayersMatch) {
      const game = state.games.get(decodeURIComponent(gamePlayersMatch[1]));
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const search = target.searchParams.get("search")?.toLowerCase() ?? "";
      const linkedPlayerIds = new Set(
        [...state.gamePlayers.values()]
          .filter((link) => link.gameId === game.gameId)
          .map((link) => link.playerId),
      );
      const players = [...state.players.values()]
        .filter((player) => linkedPlayerIds.has(player.playerId))
        .filter((player) => search.length === 0 || player.nickname.toLowerCase().includes(search))
        .map((player) => publicPlayer(player));
      return createJsonResponse(200, {
        players,
      });
    }

    if (method === "POST" && gamePlayersMatch) {
      const game = state.games.get(decodeURIComponent(gamePlayersMatch[1]));
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const playerId = String(body.playerId ?? "");
      const now = "2026-03-28T11:00:07.000Z";
      const player: MockPlayer = {
        playerId,
        nickname: String(body.nickname ?? ""),
        claimedByUserId: null,
        createdAt: now,
        updatedAt: now,
      };
      state.players.set(playerId, player);
      state.gamePlayers.set(`${game.gameId}:${playerId}`, {
        gameId: game.gameId,
        playerId,
        createdAt: now,
        updatedAt: now,
      });
      return createJsonResponse(201, publicPlayer(player));
    }

    const rosterAssignMatch = path.match(/^\/v1\/games\/([^/]+)\/roster\/([^/]+)$/);
    if (method === "PUT" && rosterAssignMatch) {
      const gameId = decodeURIComponent(rosterAssignMatch[1]);
      const playerId = decodeURIComponent(rosterAssignMatch[2]);
      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const player = state.players.get(playerId);
      if (!player) {
        return createJsonResponse(404, { error: "not_found", message: "Player not found." });
      }

      const now = "2026-03-28T11:00:08.000Z";
      const assignment: MockRosterAssignment = {
        gameId,
        playerId,
        teamId: body.teamId as TeamId,
        createdAt: now,
        updatedAt: now,
      };
      state.roster.set(`${gameId}:${playerId}`, assignment);
      state.gamePlayers.set(`${gameId}:${playerId}`, {
        gameId,
        playerId,
        createdAt: now,
        updatedAt: now,
      });
      return createJsonResponse(200, {
        ...assignment,
        player: publicPlayer(player),
      });
    }

    const createGoalMatch = path.match(/^\/v1\/games\/([^/]+)\/goals$/);
    if (method === "GET" && createGoalMatch) {
      const gameId = decodeURIComponent(createGoalMatch[1]);
      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      return createJsonResponse(200, goalResponsePayload(state, game, {}));
    }

    if (method === "POST" && createGoalMatch) {
      const gameId = decodeURIComponent(createGoalMatch[1]);
      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const idempotencyError = requireIdempotencyKey(init);
      if (idempotencyError) {
        return idempotencyError;
      }

      const finishedCorrection = game.status === "finished" && canMockCorrectFinishedGame(state, game);
      if (game.status === "finished" && !finishedCorrection) {
        return mockFinishedGameMutationError(game);
      }

      const activeThird = activeMockThird(game);
      const configuredThirds = game.thirds
        .map((thirdSegment) => thirdSegment.third)
        .sort((left, right) => left - right);
      const finishedCorrectionThird = finishedCorrection
        ? configuredThirds
            .filter((third) =>
              game.thirds.some(
                (thirdSegment) => thirdSegment.third === third && thirdSegment.finishedAt,
              ),
            )
            .at(-1) ??
          configuredThirds.at(-1) ??
          null
        : null;
      const third = activeThird ?? finishedCorrectionThird;
      if (!third) {
        return createJsonResponse(409, {
          error: "no_running_third",
          message: finishedCorrection
            ? "A finished-game correction needs at least one configured third."
            : "A goal can only be created while a third is running.",
        });
      }

      const payload = {
        scoringTeamId: body.ownGoal === true ? null : (body.scoringTeamId as TeamId | null),
        concedingTeamId: body.concedingTeamId as TeamId,
        scorerPlayerId: String(body.scorerPlayerId ?? ""),
        assistPlayerIds: Array.isArray(body.assistPlayerIds)
          ? body.assistPlayerIds.map((playerId) => String(playerId))
          : [],
        ownGoal: body.ownGoal === true,
      };
      const validationError = validateMockGoalPayload(state, game, payload);
      if (validationError) {
        return validationError;
      }

      state.goalSequence += 1;
      const elapsedSeconds = finishedCorrection ? game.thirdLengthMinutes * 60 : state.goalSequence * 30;
      const now = `2026-03-28T11:01:${String(state.goalSequence).padStart(2, "0")}.000Z`;
      const thirdMinute = finishedCorrection ? game.thirdLengthMinutes : Math.floor(elapsedSeconds / 60) + 1;
      const goal: MockGoalEvent = {
        gameId,
        eventId: `goal-${state.goalSequence}`,
        third,
        thirdMinute,
        gameMinute: thirdMinute + (third - 1) * game.thirdLengthMinutes,
        elapsedSeconds,
        stoppageMinute: null,
        displayTime: finishedCorrection
          ? `${String(game.thirdLengthMinutes).padStart(2, "0")}:00`
          : `${Math.floor(elapsedSeconds / 60) + 1}'`,
        ...payload,
        createdAt: now,
        updatedAt: now,
      };
      state.goalEvents.set(goal.eventId, goal);
      const responseGame = finishedCorrection ? refreshMockFinishedResult(state, game, now) : game;

      return createJsonResponse(201, goalResponsePayload(state, responseGame, { goal }));
    }

    const undoLastGoalMatch = path.match(/^\/v1\/games\/([^/]+)\/goals\/undo-last$/);
    if (method === "POST" && undoLastGoalMatch) {
      const gameId = decodeURIComponent(undoLastGoalMatch[1]);
      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }

      const idempotencyError = requireIdempotencyKey(init);
      if (idempotencyError) {
        return idempotencyError;
      }

      if (game.status === "finished" && !canMockCorrectFinishedGame(state, game)) {
        return mockFinishedGameMutationError(game);
      }

      const latest = sortedGoalTimeline(state, gameId).at(-1);
      if (!latest) {
        return createJsonResponse(404, { error: "not_found", message: "No goals found." });
      }

      if (body.expectedEventId !== latest.eventId) {
        return createJsonResponse(409, {
          error: "latest_goal_changed",
          message: "Latest goal changed.",
        });
      }

      state.goalEvents.delete(latest.eventId);
      const refreshedGame = refreshMockFinishedResult(state, game, "2026-03-28T11:02:00.000Z");
      return createJsonResponse(
        200,
        goalResponsePayload(state, refreshedGame, {
          deletedGoal: latest,
          audit: {
            auditId: `audit-${latest.eventId}`,
            gameId,
            eventId: latest.eventId,
            actorUserId: state.session?.email ?? "",
            action: "goal_undo_last",
            before: latest,
            after: null,
            createdAt: "2026-03-28T11:02:00.000Z",
            updatedAt: "2026-03-28T11:02:00.000Z",
          },
        }),
      );
    }

    const goalMatch = path.match(/^\/v1\/games\/([^/]+)\/goals\/([^/]+)$/);
    if ((method === "PATCH" || method === "DELETE") && goalMatch) {
      const gameId = decodeURIComponent(goalMatch[1]);
      const eventId = decodeURIComponent(goalMatch[2]);
      const game = state.games.get(gameId);
      const existing = state.goalEvents.get(eventId);
      if (!game || !existing || existing.gameId !== gameId) {
        return createJsonResponse(404, { error: "not_found", message: "Goal not found." });
      }

      const idempotencyError = requireIdempotencyKey(init);
      if (idempotencyError) {
        return idempotencyError;
      }

      if (game.status === "finished" && !canMockCorrectFinishedGame(state, game)) {
        return mockFinishedGameMutationError(game);
      }

      if (method === "DELETE") {
        state.goalEvents.delete(eventId);
        const refreshedGame = refreshMockFinishedResult(state, game, "2026-03-28T11:02:01.000Z");
        return createJsonResponse(
          200,
          goalResponsePayload(state, refreshedGame, {
            deletedGoal: existing,
            audit: {
              auditId: `audit-${eventId}`,
              gameId,
              eventId,
              actorUserId: state.session?.email ?? "",
              action: "goal_deleted",
              before: existing,
              after: null,
              createdAt: "2026-03-28T11:02:01.000Z",
              updatedAt: "2026-03-28T11:02:01.000Z",
            },
          }),
        );
      }

      const updated: MockGoalEvent = {
        ...existing,
        scoringTeamId:
          body.ownGoal === true
            ? null
            : body.scoringTeamId === null
              ? null
              : ((body.scoringTeamId ?? existing.scoringTeamId) as TeamId | null),
        concedingTeamId: (body.concedingTeamId ?? existing.concedingTeamId) as TeamId,
        scorerPlayerId: typeof body.scorerPlayerId === "string" ? body.scorerPlayerId : existing.scorerPlayerId,
        assistPlayerIds: Array.isArray(body.assistPlayerIds)
          ? body.assistPlayerIds.map((playerId) => String(playerId))
          : existing.assistPlayerIds,
        ownGoal: typeof body.ownGoal === "boolean" ? body.ownGoal : existing.ownGoal,
        updatedAt: "2026-03-28T11:02:02.000Z",
      };
      const validationError = validateMockGoalPayload(state, game, updated);
      if (validationError) {
        return validationError;
      }

      state.goalEvents.set(eventId, updated);
      const refreshedGame = refreshMockFinishedResult(state, game, "2026-03-28T11:02:02.000Z");
      return createJsonResponse(
        200,
        goalResponsePayload(state, refreshedGame, {
          goal: updated,
          previousGoal: existing,
          audit: {
            auditId: `audit-${eventId}`,
            gameId,
            eventId,
            actorUserId: state.session?.email ?? "",
            action: "goal_updated",
            before: existing,
            after: updated,
            createdAt: "2026-03-28T11:02:02.000Z",
            updatedAt: "2026-03-28T11:02:02.000Z",
          },
        }),
      );
    }

    return createJsonResponse(404, {
      error: "not_found",
      message: `Unhandled route: ${method} ${path}`,
    });
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function bootPage(input: {
  html: string;
  url: string;
  scriptFile: string;
  apiState: MockApiState;
  fetch?: ReturnType<typeof createMockFetch>;
}) {
  const dom = new JSDOM(input.html, {
    url: input.url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  const { window } = dom;
  const navigations: Array<{ url: string; mode: string }> = [];

  Object.defineProperty(window, "crypto", {
    value: webcrypto,
    configurable: true,
  });
  Object.defineProperty(window, "__THREEFC_NAVIGATE__", {
    value: (url: string, mode: string) => {
      navigations.push({ url, mode });
    },
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => input.apiState.storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        input.apiState.storage.set(key, value);
      },
      removeItem: (key: string) => {
        input.apiState.storage.delete(key);
      },
    },
    configurable: true,
  });
  Object.defineProperty(window, "fetch", {
    value: input.fetch ?? createMockFetch(input.apiState),
    configurable: true,
  });
  Object.defineProperty(window, "setTimeout", {
    value: (callback: () => void) => {
      callback();
      return 0;
    },
    configurable: true,
  });
  Object.defineProperty(window, "setInterval", {
    value: () => 0,
    configurable: true,
  });
  Object.defineProperty(window, "clearInterval", {
    value: () => undefined,
    configurable: true,
  });

  window.eval(readUiScript(input.scriptFile));
  await flushAsync();

  return {
    dom,
    window,
    document: window.document,
    navigations,
  };
}

function dispatchClick(element: HTMLElement): void {
  element.dispatchEvent(new element.ownerDocument.defaultView!.MouseEvent("click", { bubbles: true }));
}

function dispatchSubmit(form: HTMLFormElement): void {
  form.dispatchEvent(new form.ownerDocument.defaultView!.Event("submit", { bubbles: true, cancelable: true }));
}

function seedGoalScoringGame(
  apiState: MockApiState,
  input: {
    gameId: string;
    status?: MockGame["status"];
    thirds?: ThirdTimerSegment[];
    role?: MockLeagueRole;
    sessionEmail?: string;
  },
): void {
  const sessionEmail = input.sessionEmail ?? "scorekeeper@3fc.football";
  apiState.session = {
    sessionId: "session-1",
    email: sessionEmail,
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.leagues.set("three-sided-football-club", {
    leagueId: "three-sided-football-club",
    name: "Three Sided Football Club",
    slug: "three-sided-football-club",
    createdByUserId: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:01.000Z",
    updatedAt: "2026-03-28T11:00:01.000Z",
  });
  grantMockLeagueAccess(apiState, "three-sided-football-club", sessionEmail, input.role ?? "scorekeeper");
  apiState.seasons.set("autumn-cup", {
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    name: "Autumn Cup",
    slug: "autumn-cup",
    startsOn: null,
    endsOn: null,
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });
  apiState.games.set(input.gameId, {
    gameId: input.gameId,
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    sessionId: "20260328",
    status: input.status ?? "scheduled",
    gameStartTs: "2026-03-28T10:00:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: input.thirds ?? createDefaultThirdTimerSegments(),
    createdAt: "2026-03-28T11:00:03.000Z",
    updatedAt: "2026-03-28T11:00:03.000Z",
  });

  const playerSeeds: Array<{ playerId: string; nickname: string; teamId: TeamId }> = [
    { playerId: "player-ari", nickname: "Ari", teamId: "red" },
    { playerId: "player-bea", nickname: "Bea", teamId: "red" },
    { playerId: "player-cy", nickname: "Cy", teamId: "blue" },
  ];
  for (const playerSeed of playerSeeds) {
    apiState.players.set(playerSeed.playerId, {
      playerId: playerSeed.playerId,
      nickname: playerSeed.nickname,
      claimedByUserId: null,
      createdAt: "2026-03-28T11:00:07.000Z",
      updatedAt: "2026-03-28T11:00:07.000Z",
    });
    apiState.gamePlayers.set(`${input.gameId}:${playerSeed.playerId}`, {
      gameId: input.gameId,
      playerId: playerSeed.playerId,
      createdAt: "2026-03-28T11:00:08.000Z",
      updatedAt: "2026-03-28T11:00:08.000Z",
    });
    apiState.roster.set(`${input.gameId}:${playerSeed.playerId}`, {
      gameId: input.gameId,
      playerId: playerSeed.playerId,
      teamId: playerSeed.teamId,
      createdAt: "2026-03-28T11:00:08.000Z",
      updatedAt: "2026-03-28T11:00:08.000Z",
    });
  }
}

test("sign-in page shows inline validation for invalid email", async () => {
  const apiState = createMockApiState();
  const page = await bootPage({
    html: renderSignInPage("http://localhost:3001", "/setup"),
    url: "http://localhost:3000/sign-in?returnTo=%2Fsetup",
    scriptFile: "auth-flow.js",
    apiState,
  });

  const form = page.document.getElementById("auth-magic-form");
  const emailInput = page.document.getElementById("auth-email");
  const notice = page.document.getElementById("auth-email-notice");

  assert(form instanceof page.window.HTMLFormElement);
  assert(emailInput instanceof page.window.HTMLInputElement);
  assert(notice instanceof page.window.HTMLElement);

  emailInput.value = "not-an-email";
  dispatchSubmit(form);
  await flushAsync();

  assert.equal(emailInput.getAttribute("data-state"), "invalid");
  assert.equal(emailInput.getAttribute("aria-invalid"), "true");
  assert.equal(notice.textContent, "Enter a valid email address.");
});

test("setup flow shows inline validation for blank required fields", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";

  const dashboard = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"),
    url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const createLeagueButton = dashboard.document.querySelector('[data-action="create-league"]');
  const leagueNameNotice = dashboard.document.getElementById("league-name-notice");
  assert(createLeagueButton instanceof dashboard.window.HTMLButtonElement);
  assert(leagueNameNotice instanceof dashboard.window.HTMLElement);
  dispatchClick(createLeagueButton);
  await flushAsync();
  assert.equal(leagueNameNotice.textContent, "League name is required.");

  const leagueNameInput = dashboard.document.getElementById("league-name");
  assert(leagueNameInput instanceof dashboard.window.HTMLInputElement);
  leagueNameInput.value = "Autumn League";
  leagueNameInput.dispatchEvent(new dashboard.window.Event("input", { bubbles: true }));
  dispatchClick(createLeagueButton);
  await flushAsync();

  const leagueNavigation = dashboard.navigations.at(-1);
  assert(leagueNavigation);
  assert.equal(leagueNavigation.url, "/leagues/autumn-league");

  const leaguePage = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "autumn-league"),
    url: "http://localhost:3000/leagues/autumn-league",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const createSeasonButton = leaguePage.document.querySelector('[data-action="create-season"]');
  const seasonNotice = leaguePage.document.getElementById("season-name-notice");
  assert(createSeasonButton instanceof leaguePage.window.HTMLButtonElement);
  assert(seasonNotice instanceof leaguePage.window.HTMLElement);
  dispatchClick(createSeasonButton);
  await flushAsync();
  assert.equal(seasonNotice.textContent, "Season name is required.");

  const seasonNameInput = leaguePage.document.getElementById("season-name");
  assert(seasonNameInput instanceof leaguePage.window.HTMLInputElement);
  seasonNameInput.value = "Autumn 2026";
  seasonNameInput.dispatchEvent(new leaguePage.window.Event("input", { bubbles: true }));
  dispatchClick(createSeasonButton);
  await flushAsync();

  const seasonNavigation = leaguePage.navigations.at(-1);
  assert(seasonNavigation);
  assert.equal(seasonNavigation.url, "/seasons/autumn-2026");

  const seasonPage = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-2026"),
    url: "http://localhost:3000/seasons/autumn-2026",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const gameDateInput = seasonPage.document.getElementById("game-date");
  const gameKickoffInput = seasonPage.document.getElementById("game-kickoff");
  const createGameButton = seasonPage.document.querySelector('[data-action="create-game"]');
  const gameDateNotice = seasonPage.document.getElementById("game-date-notice");
  const gameKickoffNotice = seasonPage.document.getElementById("game-kickoff-notice");

  assert(gameDateInput instanceof seasonPage.window.HTMLInputElement);
  assert(gameKickoffInput instanceof seasonPage.window.HTMLInputElement);
  assert(createGameButton instanceof seasonPage.window.HTMLButtonElement);
  assert(gameDateNotice instanceof seasonPage.window.HTMLElement);
  assert(gameKickoffNotice instanceof seasonPage.window.HTMLElement);

  gameDateInput.value = "";
  gameKickoffInput.value = "";
  dispatchClick(createGameButton);
  await flushAsync();
  assert.equal(gameDateNotice.textContent, "Game date is required.");

  gameDateInput.value = "2026-03-28";
  gameDateInput.dispatchEvent(new seasonPage.window.Event("input", { bubbles: true }));
  dispatchClick(createGameButton);
  await flushAsync();
  assert.equal(gameKickoffNotice.textContent, "Kickoff time must be valid.");
});

test("setup happy path runs from sign-in to created game context", async () => {
  const apiState = createMockApiState();

  const signInPage = await bootPage({
    html: renderSignInPage("http://localhost:3001", "/setup"),
    url: "http://localhost:3000/sign-in?returnTo=%2Fsetup",
    scriptFile: "auth-flow.js",
    apiState,
  });

  const signInForm = signInPage.document.getElementById("auth-magic-form");
  const emailInput = signInPage.document.getElementById("auth-email");
  const signInStatus = signInPage.document.getElementById("auth-status");
  assert(signInForm instanceof signInPage.window.HTMLFormElement);
  assert(emailInput instanceof signInPage.window.HTMLInputElement);
  assert(signInStatus instanceof signInPage.window.HTMLElement);

  emailInput.value = "organizer@3fc.football";
  dispatchSubmit(signInForm);
  await flushAsync();

  assert.equal(apiState.pendingToken, "token-1");
  assert.match(signInStatus.textContent ?? "", /Magic link sent/);

  const callbackPage = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1",
    scriptFile: "auth-flow.js",
    apiState,
  });

  const callbackNavigation = callbackPage.navigations.at(-1);
  assert(callbackNavigation);
  assert.equal(callbackNavigation.url, "/setup");
  assert.equal(apiState.cookieJar, "threefc_session=session-1");

  const dashboardPage = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"),
    url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const leagueNameInput = dashboardPage.document.getElementById("league-name");
  const createLeagueButton = dashboardPage.document.querySelector('[data-action="create-league"]');
  assert(leagueNameInput instanceof dashboardPage.window.HTMLInputElement);
  assert(createLeagueButton instanceof dashboardPage.window.HTMLButtonElement);

  leagueNameInput.value = "Three Sided Football Club";
  leagueNameInput.dispatchEvent(new dashboardPage.window.Event("input", { bubbles: true }));
  dispatchClick(createLeagueButton);
  await flushAsync();

  const leagueNavigation = dashboardPage.navigations.at(-1);
  assert(leagueNavigation);
  assert.equal(leagueNavigation.url, "/leagues/three-sided-football-club");

  const leaguePage = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const seasonNameInput = leaguePage.document.getElementById("season-name");
  const createSeasonButton = leaguePage.document.querySelector('[data-action="create-season"]');
  assert(seasonNameInput instanceof leaguePage.window.HTMLInputElement);
  assert(createSeasonButton instanceof leaguePage.window.HTMLButtonElement);

  seasonNameInput.value = "Autumn Cup";
  seasonNameInput.dispatchEvent(new leaguePage.window.Event("input", { bubbles: true }));
  dispatchClick(createSeasonButton);
  await flushAsync();

  const seasonNavigation = leaguePage.navigations.at(-1);
  assert(seasonNavigation);
  assert.equal(seasonNavigation.url, "/seasons/autumn-cup");

  const seasonPage = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup"),
    url: "http://localhost:3000/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const gameDateInput = seasonPage.document.getElementById("game-date");
  const gameKickoffInput = seasonPage.document.getElementById("game-kickoff");
  const gameIdDisplay = seasonPage.document.getElementById("game-id-display");
  const createGameButton = seasonPage.document.querySelector('[data-action="create-game"]');
  assert(gameDateInput instanceof seasonPage.window.HTMLInputElement);
  assert(gameKickoffInput instanceof seasonPage.window.HTMLInputElement);
  assert(gameIdDisplay instanceof seasonPage.window.HTMLElement);
  assert(createGameButton instanceof seasonPage.window.HTMLButtonElement);

  gameDateInput.value = "2026-03-28";
  gameDateInput.dispatchEvent(new seasonPage.window.Event("change", { bubbles: true }));
  gameKickoffInput.value = "2026-03-28T10:00";
  gameKickoffInput.dispatchEvent(new seasonPage.window.Event("change", { bubbles: true }));
  const gameId = gameIdDisplay.textContent ?? "";
  dispatchClick(createGameButton);
  await flushAsync();

  const gameNavigation = seasonPage.navigations.at(-1);
  assert(gameNavigation);
  assert.equal(gameNavigation.url, `/games/${gameId}`);

  const gamePage = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId }),
    url: `http://localhost:3000/games/${gameId}`,
    scriptFile: "setup-flow.js",
    apiState,
  });

  const title = gamePage.document.getElementById("game-title");
  const leagueId = gamePage.document.getElementById("game-league-id");
  const seasonId = gamePage.document.getElementById("game-season-id");
  const createAnotherLink = gamePage.document.getElementById("create-another-game-link");

  assert.equal(title?.textContent, gameId);
  assert.equal(leagueId?.textContent, "three-sided-football-club");
  assert.equal(seasonId?.textContent, "autumn-cup");
  assert.equal(createAnotherLink?.getAttribute("href"), "/seasons/autumn-cup");
});

test("league page header delete button deletes an empty league", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.leagues.set("empty-league", {
    leagueId: "empty-league",
    name: "Empty League",
    slug: "empty-league",
    createdByUserId: apiState.session.email,
    createdAt: "2026-03-28T11:00:01.000Z",
    updatedAt: "2026-03-28T11:00:01.000Z",
  });

  const page = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "empty-league"),
    url: "http://localhost:3000/leagues/empty-league",
    scriptFile: "setup-flow.js",
    apiState,
  });
  Object.defineProperty(page.window, "confirm", {
    value: () => true,
    configurable: true,
  });

  const deleteLeagueButton = page.document.querySelector('[data-testid="delete-league"]');
  assert(deleteLeagueButton instanceof page.window.HTMLButtonElement);
  dispatchClick(deleteLeagueButton);
  await flushAsync();

  assert.equal(apiState.leagues.has("empty-league"), false);
  assert.equal(page.navigations.at(-1)?.url, "/setup");
});

test("season page header delete button deletes an empty season", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.leagues.set("three-sided-football-club", {
    leagueId: "three-sided-football-club",
    name: "Three Sided Football Club",
    slug: "three-sided-football-club",
    createdByUserId: apiState.session.email,
    createdAt: "2026-03-28T11:00:01.000Z",
    updatedAt: "2026-03-28T11:00:01.000Z",
  });
  apiState.seasons.set("autumn-cup", {
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    name: "Autumn Cup",
    slug: "autumn-cup",
    startsOn: null,
    endsOn: null,
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });

  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup"),
    url: "http://localhost:3000/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });
  Object.defineProperty(page.window, "confirm", {
    value: () => true,
    configurable: true,
  });

  const deleteSeasonButton = page.document.querySelector('[data-testid="delete-season"]');
  assert(deleteSeasonButton instanceof page.window.HTMLButtonElement);
  dispatchClick(deleteSeasonButton);
  await flushAsync();

  assert.equal(apiState.seasons.has("autumn-cup"), false);
  assert.equal(page.navigations.at(-1)?.url, "/leagues/three-sided-football-club");
});

test("game page quick-creates and assigns roster players", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "scorekeeper@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.seasons.set("autumn-cup", {
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    name: "Autumn Cup",
    slug: "autumn-cup",
    startsOn: null,
    endsOn: null,
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });
  apiState.games.set("game-1", {
    gameId: "game-1",
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    sessionId: "20260328",
    status: "scheduled",
    gameStartTs: "2026-03-28T10:00:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments(),
    createdAt: "2026-03-28T11:00:03.000Z",
    updatedAt: "2026-03-28T11:00:03.000Z",
  });

  const gamePage = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-1" }),
    url: "http://localhost:3000/games/game-1",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const nicknameInput = gamePage.document.getElementById("player-nickname");
  const quickCreateButton = gamePage.document.querySelector('[data-action="quick-create-player"]');
  const rosterTeams = gamePage.document.getElementById("roster-teams");
  const scorerInput = gamePage.document.getElementById("goal-scorer");
  const saveGoalButton = gamePage.document.querySelector('[data-action="save-goal"]');
  const goalFormNote = gamePage.document.getElementById("goal-form-note");
  const statusInput = gamePage.document.getElementById("game-edit-status");
  const thirdLengthInput = gamePage.document.getElementById("game-edit-third-length");
  const timerDisplay = gamePage.document.getElementById("timer-display-value");
  const startThirdButton = gamePage.document.querySelector('[data-action="start-active-third"]');
  const finishThirdButton = gamePage.document.querySelector('[data-action="finish-active-third"]');
  const scheduledStatusOption = statusInput?.querySelector('option[value="scheduled"]');
  const finishedStatusOption = statusInput?.querySelector('option[value="finished"]');
  assert(nicknameInput instanceof gamePage.window.HTMLInputElement);
  assert(quickCreateButton instanceof gamePage.window.HTMLButtonElement);
  assert(rosterTeams instanceof gamePage.window.HTMLElement);
  assert(scorerInput instanceof gamePage.window.HTMLSelectElement);
  assert(saveGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(goalFormNote instanceof gamePage.window.HTMLElement);
  assert(statusInput instanceof gamePage.window.HTMLSelectElement);
  assert(scheduledStatusOption instanceof gamePage.window.HTMLOptionElement);
  assert(thirdLengthInput instanceof gamePage.window.HTMLSelectElement);
  assert(timerDisplay instanceof gamePage.window.HTMLElement);
  assert(startThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert(finishThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(statusInput.value, "scheduled");
  assert.equal(scheduledStatusOption.disabled, false);
  assert(finishedStatusOption instanceof gamePage.window.HTMLOptionElement);
  assert.equal(finishedStatusOption.disabled, true);
  assert.equal(thirdLengthInput.value, "20");
  assert.equal(timerDisplay.textContent, "00:00");
  assert.equal(startThirdButton.textContent, "Start Third 1");
  assert.match(rosterTeams.textContent ?? "", /Red/);

  dispatchClick(startThirdButton);
  await flushAsync();
  assert.equal(apiState.games.get("game-1")?.status, "live");
  assert.equal(apiState.games.get("game-1")?.thirds[0].startedAt, "2026-03-28T11:00:10.000Z");
  assert.equal(statusInput.value, "live");
  assert.equal(scheduledStatusOption.disabled, true);
  assert.equal(thirdLengthInput.disabled, true);
  assert.equal(finishThirdButton.textContent, "Finish Third 1");

  dispatchClick(finishThirdButton);
  await flushAsync();
  assert.equal(apiState.games.get("game-1")?.thirds[0].finishedAt, "2026-03-28T11:00:11.000Z");
  assert.equal(startThirdButton.textContent, "Start Third 2");

  nicknameInput.value = "Ari";
  nicknameInput.dispatchEvent(new gamePage.window.Event("input", { bubbles: true }));
  dispatchClick(quickCreateButton);
  await flushAsync();

  const createdPlayer = [...apiState.players.values()][0];
  assert(createdPlayer);
  assert.equal(createdPlayer.nickname, "Ari");

  const assignRedButton = gamePage.document.querySelector(
    `[data-action="assign-player"][data-player-id="${createdPlayer.playerId}"][data-team-id="red"]`,
  );
  assert(assignRedButton instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(assignRedButton);
  await flushAsync();

  const assignment = apiState.roster.get(`game-1:${createdPlayer.playerId}`);
  assert.equal(assignment?.teamId, "red");
  assert.match(rosterTeams.textContent ?? "", /Ari/);
  assert.equal(scorerInput.value, createdPlayer.playerId);
  assert.match(scorerInput.textContent ?? "", /Ari/);
  assert.equal(saveGoalButton.disabled, true);
  assert.match(goalFormNote.textContent ?? "", /Start a third/);

  dispatchClick(startThirdButton);
  await flushAsync();
  assert.equal(apiState.games.get("game-1")?.thirds[1].startedAt, "2026-03-28T11:00:10.000Z");
  assert.equal(saveGoalButton.disabled, false);
  assert.match(goalFormNote.textContent ?? "", /third 2/);
});

test("game page remains usable when goal timeline load fails", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "scorekeeper@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.seasons.set("autumn-cup", {
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    name: "Autumn Cup",
    slug: "autumn-cup",
    startsOn: null,
    endsOn: null,
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });
  apiState.games.set("game-goals-fail", {
    gameId: "game-goals-fail",
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    sessionId: "20260328",
    status: "scheduled",
    gameStartTs: "2026-03-28T10:00:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments(),
    createdAt: "2026-03-28T11:00:03.000Z",
    updatedAt: "2026-03-28T11:00:03.000Z",
  });

  const defaultFetch = createMockFetch(apiState);
  const failingGoalFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && target.pathname === "/v1/games/game-goals-fail/goals") {
      return createJsonResponse(503, {
        error: "unavailable",
        message: "Goal feed unavailable.",
      });
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-goals-fail" }),
    url: "http://localhost:3000/games/game-goals-fail",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: failingGoalFetch,
  });

  const status = page.document.getElementById("setup-status");
  const error = page.document.getElementById("setup-error");
  const rosterTeams = page.document.getElementById("roster-teams");
  const timeline = page.document.getElementById("goal-timeline");
  const quickCreateButton = page.document.querySelector('[data-action="quick-create-player"]');

  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);
  assert(rosterTeams instanceof page.window.HTMLElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert(quickCreateButton instanceof page.window.HTMLButtonElement);
  assert.equal(status.textContent, "Could not load goal timeline.");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "Goal feed unavailable.");
  assert.match(rosterTeams.textContent ?? "", /Red/);
  assert.match(timeline.textContent ?? "", /No goals yet/);
  assert.equal(quickCreateButton.disabled, false);
});

test("game page keeps edit goal helper text when no third is running", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-edit-note" });
  apiState.goalEvents.set("goal-1", {
    gameId: "game-edit-note",
    eventId: "goal-1",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: ["player-bea"],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-edit-note" }),
    url: "http://localhost:3000/games/game-edit-note",
    scriptFile: "setup-flow.js",
    apiState,
  });
  const note = page.document.getElementById("goal-form-note");
  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  assert(note instanceof page.window.HTMLElement);
  assert(editGoalButton instanceof page.window.HTMLButtonElement);

  dispatchClick(editGoalButton);
  await flushAsync();

  assert.equal(note.textContent, "Editing keeps the original timer stamp.");
});

test("game page reuses create goal idempotency key for unchanged retry", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-goal-retry",
    status: "live",
    thirds,
  });

  const defaultFetch = createMockFetch(apiState);
  const createGoalIdempotencyKeys: Array<string | null> = [];
  let failNextGoalCreate = true;
  const flakyGoalFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && target.pathname === "/v1/games/game-goal-retry/goals") {
      createGoalIdempotencyKeys.push(readInitHeader(init, "idempotency-key"));
      if (failNextGoalCreate) {
        failNextGoalCreate = false;
        return createJsonResponse(503, {
          error: "unavailable",
          message: "Goal create unavailable.",
        });
      }
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-goal-retry" }),
    url: "http://localhost:3000/games/game-goal-retry",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: flakyGoalFetch,
  });
  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  assert(scoringTeamInput instanceof page.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof page.window.HTMLSelectElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);

  scoringTeamInput.value = "red";
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-ari";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));

  dispatchClick(saveGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.size, 0);

  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 1);
  assert.equal(createGoalIdempotencyKeys.length, 2);
  assert.ok(createGoalIdempotencyKeys[0]);
  assert.equal(createGoalIdempotencyKeys[0], createGoalIdempotencyKeys[1]);
});

test("game page treats later created same-second goals as latest", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-goal-order",
    status: "live",
    thirds,
  });

  apiState.goalEvents.set("goal-z-old", {
    gameId: "game-goal-order",
    eventId: "goal-z-old",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  });
  apiState.goalEvents.set("goal-a-new", {
    gameId: "game-goal-order",
    eventId: "goal-a-new",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "blue",
    concedingTeamId: "red",
    scorerPlayerId: "player-cy",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:02.000Z",
    updatedAt: "2026-03-28T11:01:02.000Z",
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-goal-order" }),
    url: "http://localhost:3000/games/game-goal-order",
    scriptFile: "setup-flow.js",
    apiState,
  });
  const latestGoal = page.document.querySelector('[data-ui="goal-event"][data-state="latest"]');
  const undoLastGoalButton = page.document.querySelector('[data-action="undo-last-goal"]');
  assert(latestGoal instanceof page.window.HTMLElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert.equal(latestGoal.getAttribute("data-event-id"), "goal-a-new");

  dispatchClick(undoLastGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.has("goal-a-new"), false);
  assert.equal(apiState.goalEvents.has("goal-z-old"), true);
});

test("game page reuses correction idempotency keys for unchanged retries", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-correction-retry",
    status: "live",
    thirds,
  });
  apiState.goalEvents.set("goal-1", {
    gameId: "game-correction-retry",
    eventId: "goal-1",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  });
  apiState.goalEvents.set("goal-2", {
    gameId: "game-correction-retry",
    eventId: "goal-2",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 40,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "blue",
    concedingTeamId: "red",
    scorerPlayerId: "player-cy",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:02.000Z",
    updatedAt: "2026-03-28T11:01:02.000Z",
  });

  const defaultFetch = createMockFetch(apiState);
  const updateKeys: Array<string | null> = [];
  const deleteKeys: Array<string | null> = [];
  const undoKeys: Array<string | null> = [];
  let failNextUpdate = true;
  let failNextDelete = true;
  let failNextUndo = true;
  const flakyCorrectionFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "PATCH" && target.pathname === "/v1/games/game-correction-retry/goals/goal-1") {
      updateKeys.push(readInitHeader(init, "idempotency-key"));
      if (failNextUpdate) {
        failNextUpdate = false;
        return createJsonResponse(503, {
          error: "unavailable",
          message: "Goal update unavailable.",
        });
      }
    }
    if (method === "DELETE" && target.pathname === "/v1/games/game-correction-retry/goals/goal-1") {
      deleteKeys.push(readInitHeader(init, "idempotency-key"));
      if (failNextDelete) {
        failNextDelete = false;
        return createJsonResponse(503, {
          error: "unavailable",
          message: "Goal delete unavailable.",
        });
      }
    }
    if (method === "POST" && target.pathname === "/v1/games/game-correction-retry/goals/undo-last") {
      undoKeys.push(readInitHeader(init, "idempotency-key"));
      if (failNextUndo) {
        failNextUndo = false;
        return createJsonResponse(503, {
          error: "unavailable",
          message: "Goal undo unavailable.",
        });
      }
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-correction-retry" }),
    url: "http://localhost:3000/games/game-correction-retry",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: flakyCorrectionFetch,
  });
  Object.defineProperty(page.window, "confirm", {
    value: () => true,
    configurable: true,
  });

  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const undoLastGoalButton = page.document.querySelector('[data-action="undo-last-goal"]');
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);

  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(editGoalButton);
  await flushAsync();
  dispatchClick(saveGoalButton);
  await flushAsync();
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(updateKeys.length, 2);
  assert.ok(updateKeys[0]);
  assert.equal(updateKeys[0], updateKeys[1]);

  const deleteGoalButton = page.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(deleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(deleteGoalButton);
  await flushAsync();
  const retryDeleteGoalButton = page.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(retryDeleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(retryDeleteGoalButton);
  await flushAsync();

  assert.equal(deleteKeys.length, 2);
  assert.ok(deleteKeys[0]);
  assert.equal(deleteKeys[0], deleteKeys[1]);

  dispatchClick(undoLastGoalButton);
  await flushAsync();
  dispatchClick(undoLastGoalButton);
  await flushAsync();

  assert.equal(undoKeys.length, 2);
  assert.ok(undoKeys[0]);
  assert.equal(undoKeys[0], undoKeys[1]);
  assert.equal(apiState.goalEvents.size, 0);
});

test("game page preserves a historical scorer when editing an old goal", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-historical-scorer",
    status: "live",
    thirds,
  });
  apiState.roster.delete("game-historical-scorer:player-ari");
  apiState.goalEvents.set("goal-1", {
    gameId: "game-historical-scorer",
    eventId: "goal-1",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  });

  const defaultFetch = createMockFetch(apiState);
  let patchPayload: Record<string, unknown> | null = null;
  const capturePatchFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "PATCH" && target.pathname === "/v1/games/game-historical-scorer/goals/goal-1") {
      patchPayload = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      const game = apiState.games.get("game-historical-scorer");
      const goal = apiState.goalEvents.get("goal-1");
      assert(game);
      assert(goal);
      return createJsonResponse(200, goalResponsePayload(apiState, game, { goal }));
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-historical-scorer" }),
    url: "http://localhost:3000/games/game-historical-scorer",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: capturePatchFetch,
  });

  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const scorerSelect = page.document.getElementById("goal-scorer");
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(scorerSelect instanceof page.window.HTMLSelectElement);

  dispatchClick(editGoalButton);
  await flushAsync();
  assert.equal(scorerSelect.value, "player-ari");
  assert.match(scorerSelect.textContent ?? "", /Ari \(not currently rostered\)/);

  dispatchClick(saveGoalButton);
  await flushAsync();
  assert(patchPayload);
  assert.equal(patchPayload["scorerPlayerId"], "player-ari");
});

test("game page clears a historical scorer after changing the goal context", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-historical-context",
    status: "live",
    thirds,
  });
  apiState.roster.delete("game-historical-context:player-ari");
  apiState.goalEvents.set("goal-1", {
    gameId: "game-historical-context",
    eventId: "goal-1",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-historical-context" }),
    url: "http://localhost:3000/games/game-historical-context",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const ownGoalInput = page.document.getElementById("goal-own-goal");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerSelect = page.document.getElementById("goal-scorer");
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(ownGoalInput instanceof page.window.HTMLInputElement);
  assert(concedingTeamInput instanceof page.window.HTMLSelectElement);
  assert(scorerSelect instanceof page.window.HTMLSelectElement);

  dispatchClick(editGoalButton);
  await flushAsync();
  assert.equal(scorerSelect.value, "player-ari");
  assert.match(scorerSelect.textContent ?? "", /Ari \(not currently rostered\)/);

  ownGoalInput.checked = true;
  ownGoalInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));

  assert.equal(scorerSelect.value, "player-cy");
  assert.doesNotMatch(scorerSelect.textContent ?? "", /Ari \(not currently rostered\)/);
});

test("game page reconciles current goals after stale correction replay", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-stale-correction",
    status: "live",
    thirds,
  });
  const updatedGoal: MockGoalEvent = {
    gameId: "game-stale-correction",
    eventId: "goal-1",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:02:02.000Z",
  };
  const newerGoal: MockGoalEvent = {
    gameId: "game-stale-correction",
    eventId: "goal-2",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 40,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "blue",
    concedingTeamId: "red",
    scorerPlayerId: "player-cy",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:02.000Z",
    updatedAt: "2026-03-28T11:01:02.000Z",
  };
  apiState.goalEvents.set("goal-1", { ...updatedGoal, updatedAt: "2026-03-28T11:01:01.000Z" });

  const defaultFetch = createMockFetch(apiState);
  let patchCalls = 0;
  const staleReplayFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "PATCH" && target.pathname === "/v1/games/game-stale-correction/goals/goal-1") {
      patchCalls += 1;
      if (patchCalls === 1) {
        apiState.goalEvents.set("goal-1", updatedGoal);
        return createJsonResponse(503, {
          error: "unavailable",
          message: "Goal update response was lost.",
        });
      }

      return createJsonResponse(200, {
        goal: updatedGoal,
        scoreboard: {
          teams: recomputeMockScoreboard(apiState, apiState.games.get("game-stale-correction")!),
        },
        timeline: [updatedGoal],
      });
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-stale-correction" }),
    url: "http://localhost:3000/games/game-stale-correction",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: staleReplayFetch,
  });

  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const timeline = page.document.getElementById("goal-timeline");
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(timeline instanceof page.window.HTMLElement);

  dispatchClick(editGoalButton);
  await flushAsync();
  dispatchClick(saveGoalButton);
  await flushAsync();
  apiState.goalEvents.set("goal-2", newerGoal);

  dispatchClick(saveGoalButton);
  await flushAsync();
  await flushAsync();

  assert.equal(patchCalls, 2);
  assert.match(timeline.textContent ?? "", /Cy for Blue/);
});

test("game page keeps current goals when correction replay refresh fails", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-stale-refresh-fail",
    status: "live",
    thirds,
  });
  const updatedGoal: MockGoalEvent = {
    gameId: "game-stale-refresh-fail",
    eventId: "goal-1",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:02:02.000Z",
  };
  const newerGoal: MockGoalEvent = {
    gameId: "game-stale-refresh-fail",
    eventId: "goal-2",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 40,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "blue",
    concedingTeamId: "red",
    scorerPlayerId: "player-cy",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:02.000Z",
    updatedAt: "2026-03-28T11:01:02.000Z",
  };
  apiState.goalEvents.set("goal-1", { ...updatedGoal, updatedAt: "2026-03-28T11:01:01.000Z" });
  apiState.goalEvents.set("goal-2", newerGoal);

  const defaultFetch = createMockFetch(apiState);
  let failGoalRefresh = false;
  const staleReplayFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && target.pathname === "/v1/games/game-stale-refresh-fail/goals" && failGoalRefresh) {
      return createJsonResponse(503, {
        error: "unavailable",
        message: "Goal timeline could not be refreshed.",
      });
    }

    if (method === "PATCH" && target.pathname === "/v1/games/game-stale-refresh-fail/goals/goal-1") {
      apiState.goalEvents.set("goal-1", updatedGoal);
      failGoalRefresh = true;
      return createJsonResponse(200, {
        goal: updatedGoal,
        scoreboard: {
          teams: recomputeMockScoreboard(apiState, apiState.games.get("game-stale-refresh-fail")!),
        },
        timeline: [updatedGoal],
      });
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-stale-refresh-fail" }),
    url: "http://localhost:3000/games/game-stale-refresh-fail",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: staleReplayFetch,
  });

  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const timeline = page.document.getElementById("goal-timeline");
  const status = page.document.getElementById("setup-status");
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert.match(timeline.textContent ?? "", /Cy for Blue/);

  dispatchClick(editGoalButton);
  await flushAsync();
  dispatchClick(saveGoalButton);
  await flushAsync();
  await flushAsync();

  assert.match(status.textContent ?? "", /Goal save failed/);
  assert.match(timeline.textContent ?? "", /Cy for Blue/);
});

test("game page renders malformed result data without crashing", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "scorekeeper@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.seasons.set("autumn-cup", {
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    name: "Autumn Cup",
    slug: "autumn-cup",
    startsOn: null,
    endsOn: null,
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });
  apiState.games.set("game-result-malformed", {
    gameId: "game-result-malformed",
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    sessionId: "20260328",
    status: "finished",
    gameStartTs: "2026-03-28T10:00:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments().map((third) => ({
      ...third,
      startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
      finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
    })),
    finishedAt: "2026-03-28T11:00:12.000Z",
    result: {
      winnerTeamId: null,
      outcome: 42,
      comparator: "fewest_conceded_then_most_scored",
      computedAt: null,
      teams: [
        {
          teamId: "red",
          name: 123,
          color: "#d83b36",
          scored: "1",
          conceded: null,
          rank: 0,
          outcome: {},
        },
        {
          teamId: null,
          name: "Bad Team",
          color: null,
          scored: 0,
          conceded: 0,
          rank: 1,
          outcome: "draw",
        },
      ],
    } as unknown as GameResult,
    createdAt: "2026-03-28T11:00:03.000Z",
    updatedAt: "2026-03-28T11:00:12.000Z",
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-result-malformed" }),
    url: "http://localhost:3000/games/game-result-malformed",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const resultSummary = page.document.getElementById("game-result-summary");
  assert(resultSummary instanceof page.window.HTMLElement);
  assert.equal(resultSummary.hidden, false);
  assert.match(resultSummary.textContent ?? "", /Draw/);
  assert.equal(resultSummary.querySelectorAll('[data-ui="result-team"]').length, 1);
  assert.equal(
    resultSummary.querySelector('[data-ui="result-team"][data-team-id="red"] strong')?.textContent,
    "red",
  );
});

test("game page runs live goal scoring, corrections, undo, and delete", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "scorekeeper@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.seasons.set("autumn-cup", {
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    name: "Autumn Cup",
    slug: "autumn-cup",
    startsOn: null,
    endsOn: null,
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });
  apiState.games.set("game-live-1", {
    gameId: "game-live-1",
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    sessionId: "20260328",
    status: "scheduled",
    gameStartTs: "2026-03-28T10:00:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments(),
    createdAt: "2026-03-28T11:00:03.000Z",
    updatedAt: "2026-03-28T11:00:03.000Z",
  });

  const playerSeeds = [
    { playerId: "player-ari", nickname: "Ari", teamId: "red" as TeamId },
    { playerId: "player-bea", nickname: "Bea", teamId: "red" as TeamId },
    { playerId: "player-cy", nickname: "Cy", teamId: "blue" as TeamId },
  ];
  for (const playerSeed of playerSeeds) {
    apiState.players.set(playerSeed.playerId, {
      playerId: playerSeed.playerId,
      nickname: playerSeed.nickname,
      claimedByUserId: null,
      createdAt: "2026-03-28T11:00:07.000Z",
      updatedAt: "2026-03-28T11:00:07.000Z",
    });
    apiState.gamePlayers.set(`game-live-1:${playerSeed.playerId}`, {
      gameId: "game-live-1",
      playerId: playerSeed.playerId,
      createdAt: "2026-03-28T11:00:08.000Z",
      updatedAt: "2026-03-28T11:00:08.000Z",
    });
    apiState.roster.set(`game-live-1:${playerSeed.playerId}`, {
      gameId: "game-live-1",
      playerId: playerSeed.playerId,
      teamId: playerSeed.teamId,
      createdAt: "2026-03-28T11:00:08.000Z",
      updatedAt: "2026-03-28T11:00:08.000Z",
    });
  }

  const gamePage = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-live-1" }),
    url: "http://localhost:3000/games/game-live-1",
    scriptFile: "setup-flow.js",
    apiState,
  });
  Object.defineProperty(gamePage.window, "confirm", {
    value: () => true,
    configurable: true,
  });

  const startThirdButton = gamePage.document.querySelector('[data-action="start-active-third"]');
  const scoreboard = gamePage.document.getElementById("live-scoreboard");
  const scoringTeamInput = gamePage.document.getElementById("goal-scoring-team");
  const concedingTeamInput = gamePage.document.getElementById("goal-conceding-team");
  const ownGoalInput = gamePage.document.getElementById("goal-own-goal");
  const scorerInput = gamePage.document.getElementById("goal-scorer");
  const assistsElement = gamePage.document.getElementById("goal-assists");
  const saveGoalButton = gamePage.document.querySelector('[data-action="save-goal"]');
  const undoLastGoalButton = gamePage.document.querySelector('[data-action="undo-last-goal"]');
  const timeline = gamePage.document.getElementById("goal-timeline");

  assert(startThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert(scoreboard instanceof gamePage.window.HTMLElement);
  assert(scoringTeamInput instanceof gamePage.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof gamePage.window.HTMLSelectElement);
  assert(ownGoalInput instanceof gamePage.window.HTMLInputElement);
  assert(scorerInput instanceof gamePage.window.HTMLSelectElement);
  assert(assistsElement instanceof gamePage.window.HTMLElement);
  assert(saveGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(timeline instanceof gamePage.window.HTMLElement);

  assert.match(scoreboard.textContent ?? "", /Red/);
  assert.match(timeline.textContent ?? "", /No goals yet/);
  assert.equal(undoLastGoalButton.disabled, true);

  dispatchClick(startThirdButton);
  await flushAsync();

  scoringTeamInput.value = "red";
  scoringTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-ari";
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  const beaAssist = assistsElement.querySelector('input[value="player-bea"]');
  assert(beaAssist instanceof gamePage.window.HTMLInputElement);
  beaAssist.checked = true;
  beaAssist.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, "red");
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*1/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*1/);
  assert.match(timeline.textContent ?? "", /Ari for Red/);
  assert.match(timeline.textContent ?? "", /Assists: Bea/);
  assert.equal(undoLastGoalButton.disabled, false);

  const refreshedPage = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-live-1" }),
    url: "http://localhost:3000/games/game-live-1",
    scriptFile: "setup-flow.js",
    apiState,
  });
  const refreshedScoreboard = refreshedPage.document.getElementById("live-scoreboard");
  const refreshedTimeline = refreshedPage.document.getElementById("goal-timeline");
  const refreshedUndoButton = refreshedPage.document.querySelector('[data-action="undo-last-goal"]');
  const refreshedEditButton = refreshedPage.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  assert(refreshedScoreboard instanceof refreshedPage.window.HTMLElement);
  assert(refreshedTimeline instanceof refreshedPage.window.HTMLElement);
  assert(refreshedUndoButton instanceof refreshedPage.window.HTMLButtonElement);
  assert(refreshedEditButton instanceof refreshedPage.window.HTMLButtonElement);
  assert.match(refreshedScoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*1/);
  assert.match(refreshedScoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*1/);
  assert.match(refreshedTimeline.textContent ?? "", /Ari for Red/);
  assert.equal(refreshedUndoButton.disabled, false);

  const editGoalButton = gamePage.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  assert(editGoalButton instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(editGoalButton);
  await flushAsync();
  ownGoalInput.checked = true;
  ownGoalInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.get("goal-1")?.ownGoal, true);
  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, null);
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*0/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*1/);
  assert.match(timeline.textContent ?? "", /Cy own goal against Blue/);

  ownGoalInput.checked = false;
  ownGoalInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scoringTeamInput.value = "blue";
  scoringTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "red";
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 2);
  assert.match(timeline.textContent ?? "", /Cy for Blue/);

  const deleteGoalButton = gamePage.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(deleteGoalButton instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(deleteGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.has("goal-1"), false);
  assert.equal(apiState.goalEvents.has("goal-2"), true);
  assert.match(timeline.textContent ?? "", /Cy for Blue/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Scored\s*1/);
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Conceded\s*1/);

  dispatchClick(undoLastGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.size, 0);
  assert.match(timeline.textContent ?? "", /No goals yet/);
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*0/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*0/);
});

test("setup smoke completes live game through finish", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "scorekeeper@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.leagues.set("three-sided-football-club", {
    leagueId: "three-sided-football-club",
    name: "Three Sided Football Club",
    slug: "three-sided-football-club",
    createdByUserId: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:01.000Z",
    updatedAt: "2026-03-28T11:00:01.000Z",
  });
  grantMockLeagueAccess(
    apiState,
    "three-sided-football-club",
    "scorekeeper@3fc.football",
    "scorekeeper",
  );
  apiState.seasons.set("autumn-cup", {
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    name: "Autumn Cup",
    slug: "autumn-cup",
    startsOn: null,
    endsOn: null,
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });
  apiState.games.set("game-smoke-1", {
    gameId: "game-smoke-1",
    leagueId: "three-sided-football-club",
    seasonId: "autumn-cup",
    sessionId: "20260328",
    status: "scheduled",
    gameStartTs: "2026-03-28T10:00:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments(),
    finishedAt: null,
    result: null,
    createdAt: "2026-03-28T11:00:03.000Z",
    updatedAt: "2026-03-28T11:00:03.000Z",
  });

  const gamePage = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-smoke-1" }),
    url: "http://localhost:3000/games/game-smoke-1",
    scriptFile: "setup-flow.js",
    apiState,
  });
  Object.defineProperty(gamePage.window, "confirm", {
    value: () => true,
    configurable: true,
  });

  const nicknameInput = gamePage.document.getElementById("player-nickname");
  const quickCreateButton = gamePage.document.querySelector('[data-action="quick-create-player"]');
  const startThirdButton = gamePage.document.querySelector('[data-action="start-active-third"]');
  const finishThirdButton = gamePage.document.querySelector('[data-action="finish-active-third"]');
  const finishGameButton = gamePage.document.querySelector('[data-action="finish-game"]');
  const scoringTeamInput = gamePage.document.getElementById("goal-scoring-team");
  const concedingTeamInput = gamePage.document.getElementById("goal-conceding-team");
  const scorerInput = gamePage.document.getElementById("goal-scorer");
  const saveGoalButton = gamePage.document.querySelector('[data-action="save-goal"]');
  const undoLastGoalButton = gamePage.document.querySelector('[data-action="undo-last-goal"]');
  const deleteGameButton = gamePage.document.querySelector('[data-action="delete-game"]');
  const statusInput = gamePage.document.getElementById("game-edit-status");
  const scoreboard = gamePage.document.getElementById("live-scoreboard");
  const goalFormNote = gamePage.document.getElementById("goal-form-note");
  const resultSummary = gamePage.document.getElementById("game-result-summary");

  assert(nicknameInput instanceof gamePage.window.HTMLInputElement);
  assert(quickCreateButton instanceof gamePage.window.HTMLButtonElement);
  assert(startThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert(finishThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert(finishGameButton instanceof gamePage.window.HTMLButtonElement);
  assert(scoringTeamInput instanceof gamePage.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof gamePage.window.HTMLSelectElement);
  assert(scorerInput instanceof gamePage.window.HTMLSelectElement);
  assert(saveGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(deleteGameButton instanceof gamePage.window.HTMLButtonElement);
  assert(statusInput instanceof gamePage.window.HTMLSelectElement);
  assert(scoreboard instanceof gamePage.window.HTMLElement);
  assert(goalFormNote instanceof gamePage.window.HTMLElement);
  assert(resultSummary instanceof gamePage.window.HTMLElement);
  assert.equal(finishGameButton.disabled, true);
  assert.equal(resultSummary.hidden, true);

  nicknameInput.value = "Ari";
  nicknameInput.dispatchEvent(new gamePage.window.Event("input", { bubbles: true }));
  dispatchClick(quickCreateButton);
  await flushAsync();
  const ari = [...apiState.players.values()].find((player) => player.nickname === "Ari");
  assert(ari);

  const assignAriRedButton = gamePage.document.querySelector(
    `[data-action="assign-player"][data-player-id="${ari.playerId}"][data-team-id="red"]`,
  );
  assert(assignAriRedButton instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(assignAriRedButton);
  await flushAsync();

  nicknameInput.value = "Cy";
  nicknameInput.dispatchEvent(new gamePage.window.Event("input", { bubbles: true }));
  dispatchClick(quickCreateButton);
  await flushAsync();
  const cy = [...apiState.players.values()].find((player) => player.nickname === "Cy");
  assert(cy);

  const assignCyBlueButton = gamePage.document.querySelector(
    `[data-action="assign-player"][data-player-id="${cy.playerId}"][data-team-id="blue"]`,
  );
  assert(assignCyBlueButton instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(assignCyBlueButton);
  await flushAsync();

  dispatchClick(startThirdButton);
  await flushAsync();

  scoringTeamInput.value = "red";
  scoringTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = ari.playerId;
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, "red");
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*1/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*1/);

  dispatchClick(finishThirdButton);
  await flushAsync();
  dispatchClick(startThirdButton);
  await flushAsync();
  dispatchClick(finishThirdButton);
  await flushAsync();
  dispatchClick(startThirdButton);
  await flushAsync();
  dispatchClick(finishThirdButton);
  await flushAsync();

  assert.equal(apiState.games.get("game-smoke-1")?.thirds.every((third) => third.finishedAt), true);
  assert.equal(finishGameButton.disabled, false);

  dispatchClick(finishGameButton);
  await flushAsync();

  const finishedGame = apiState.games.get("game-smoke-1");
  assert.equal(finishedGame?.status, "finished");
  assert.equal(finishedGame?.result?.winnerTeamId, "red");
  assert.equal(finishedGame?.result?.outcome, "win");
  assert.equal(finishedGame?.result?.comparator, "fewest_conceded_then_most_scored");
  assert.equal(statusInput.value, "finished");
  assert.equal(finishGameButton.disabled, true);
  assert.equal(finishGameButton.textContent, "Game finished");
  assert.equal(deleteGameButton.disabled, true);
  assert.equal(resultSummary.hidden, false);
  assert.match(resultSummary.textContent ?? "", /Red win/);
  assert.match(resultSummary.querySelector('[data-team-id="red"]')?.textContent ?? "", /Conceded\s*0/);
  assert.match(resultSummary.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*1/);
  assert.match(resultSummary.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*1/);
  assert.equal(startThirdButton.disabled, true);
  assert.equal(finishThirdButton.disabled, true);
  assert.equal(saveGoalButton.disabled, true);
  assert.equal(undoLastGoalButton.disabled, true);
  assert.equal(quickCreateButton.disabled, true);
  assert.match(goalFormNote.textContent ?? "", /Admin role is required/);

  const editGoalButton = gamePage.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const deleteGoalButton = gamePage.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  const lockedAssignButton = gamePage.document.querySelector(
    `[data-action="assign-player"][data-player-id="${ari.playerId}"][data-team-id="blue"]`,
  );
  assert(editGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(deleteGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(lockedAssignButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(editGoalButton.disabled, true);
  assert.equal(deleteGoalButton.disabled, true);
  assert.equal(lockedAssignButton.disabled, true);

  dispatchClick(editGoalButton);
  await flushAsync();
  assert.equal(saveGoalButton.disabled, true);
  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, "red");

  dispatchClick(undoLastGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.size, 1);
  assert.equal(apiState.games.get("game-smoke-1")?.result?.winnerTeamId, "red");

  const repeatFinishResponse = await createMockFetch(apiState)(
    "http://localhost:3001/v1/games/game-smoke-1/finish",
    {
      method: "POST",
      headers: {
        "Idempotency-Key": "finish-game-smoke-repeat",
      },
    },
  );
  const repeatFinishBody = (await repeatFinishResponse.json()) as MockGame;
  assert.equal(repeatFinishResponse.status, 200);
  assert.equal(repeatFinishBody.status, "finished");
  assert.equal(repeatFinishBody.result?.winnerTeamId, "red");
  assert.equal(repeatFinishBody.finishedAt, finishedGame?.finishedAt);
});

test("game page allows admins to correct finished goals and refresh result", async () => {
  const apiState = createMockApiState();
  const finishedThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
    finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-admin-finished-correction",
    status: "finished",
    thirds: finishedThirds,
    role: "admin",
    sessionEmail: "admin@3fc.football",
  });
  apiState.goalEvents.set("goal-1", {
    gameId: "game-admin-finished-correction",
    eventId: "goal-1",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  });
  apiState.goalEvents.set("goal-2", {
    gameId: "game-admin-finished-correction",
    eventId: "goal-2",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 40,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "blue",
    concedingTeamId: "red",
    scorerPlayerId: "player-cy",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:02.000Z",
    updatedAt: "2026-03-28T11:01:02.000Z",
  });
  const seededGame = apiState.games.get("game-admin-finished-correction");
  assert(seededGame);
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:00:12.000Z");

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-admin-finished-correction" }),
    url: "http://localhost:3000/games/game-admin-finished-correction",
    scriptFile: "setup-flow.js",
    apiState,
  });
  Object.defineProperty(page.window, "confirm", {
    value: () => true,
    configurable: true,
  });

  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const undoLastGoalButton = page.document.querySelector('[data-action="undo-last-goal"]');
  const resultSummary = page.document.getElementById("game-result-summary");
  const goalFormNote = page.document.getElementById("goal-form-note");
  const nicknameInput = page.document.getElementById("player-nickname");
  const quickCreateButton = page.document.querySelector('[data-action="quick-create-player"]');
  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const deleteGoalButton = page.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(scoringTeamInput instanceof page.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof page.window.HTMLSelectElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert(resultSummary instanceof page.window.HTMLElement);
  assert(goalFormNote instanceof page.window.HTMLElement);
  assert(nicknameInput instanceof page.window.HTMLInputElement);
  assert(quickCreateButton instanceof page.window.HTMLButtonElement);
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(deleteGoalButton instanceof page.window.HTMLButtonElement);
  assert.equal(nicknameInput.disabled, false);
  assert.equal(quickCreateButton.disabled, false);
  assert.equal(editGoalButton.disabled, false);
  assert.equal(deleteGoalButton.disabled, false);
  assert.equal(undoLastGoalButton.disabled, false);

  dispatchClick(editGoalButton);
  await flushAsync();
  assert.equal(saveGoalButton.disabled, false);
  assert.match(goalFormNote.textContent ?? "", /Finished-game correction/);
  scoringTeamInput.value = "blue";
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "red";
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, "blue");
  assert.equal(apiState.games.get("game-admin-finished-correction")?.result?.winnerTeamId, "blue");
  assert.match(resultSummary.textContent ?? "", /Blue win/);

  const refreshedDeleteGoalButton = page.document.querySelector(
    '[data-action="delete-goal"][data-event-id="goal-1"]',
  );
  assert(refreshedDeleteGoalButton instanceof page.window.HTMLButtonElement);
  assert.equal(refreshedDeleteGoalButton.disabled, false);
  dispatchClick(refreshedDeleteGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.has("goal-1"), false);
  assert.equal(apiState.games.get("game-admin-finished-correction")?.result?.winnerTeamId, "blue");
  assert.match(resultSummary.textContent ?? "", /Blue win/);

  dispatchClick(undoLastGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 0);
  assert.equal(apiState.games.get("game-admin-finished-correction")?.result?.winnerTeamId, null);
  assert.match(resultSummary.textContent ?? "", /Draw/);
  assert.equal(undoLastGoalButton.disabled, true);

  nicknameInput.value = "Dee";
  nicknameInput.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  dispatchClick(quickCreateButton);
  await flushAsync();
  const dee = [...apiState.players.values()].find((player) => player.nickname === "Dee");
  assert(dee);

  const assignDeeRedButton = page.document.querySelector(
    `[data-action="assign-player"][data-player-id="${dee.playerId}"][data-team-id="red"]`,
  );
  assert(assignDeeRedButton instanceof page.window.HTMLButtonElement);
  assert.equal(assignDeeRedButton.disabled, false);
  dispatchClick(assignDeeRedButton);
  await flushAsync();
  assert.equal(apiState.roster.get(`game-admin-finished-correction:${dee.playerId}`)?.teamId, "red");

  scoringTeamInput.value = "red";
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = dee.playerId;
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  assert.equal(saveGoalButton.disabled, false);
  assert.match(goalFormNote.textContent ?? "", /final whistle/);
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 1);
  assert.equal([...apiState.goalEvents.values()][0]?.scorerPlayerId, dee.playerId);
  assert.equal(apiState.games.get("game-admin-finished-correction")?.result?.winnerTeamId, "red");
  assert.match(resultSummary.textContent ?? "", /Red win/);
});

test("game page treats committed undo as success when finished result refresh fails", async () => {
  const apiState = createMockApiState();
  const finishedThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
    finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-undo-refresh-fail",
    status: "finished",
    thirds: finishedThirds,
    role: "admin",
    sessionEmail: "admin@3fc.football",
  });
  apiState.goalEvents.set("goal-1", {
    gameId: "game-undo-refresh-fail",
    eventId: "goal-1",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-ari",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  });
  apiState.goalEvents.set("goal-2", {
    gameId: "game-undo-refresh-fail",
    eventId: "goal-2",
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 40,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "blue",
    concedingTeamId: "red",
    scorerPlayerId: "player-cy",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:02.000Z",
    updatedAt: "2026-03-28T11:01:02.000Z",
  });
  const seededGame = apiState.games.get("game-undo-refresh-fail");
  assert(seededGame);
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:00:12.000Z");

  const defaultFetch = createMockFetch(apiState);
  let failNextGameRefresh = false;
  const staleResultFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "POST" && target.pathname === "/v1/games/game-undo-refresh-fail/goals/undo-last") {
      const response = await defaultFetch(input, init);
      failNextGameRefresh = true;
      return response;
    }

    if (method === "GET" && target.pathname === "/v1/games/game-undo-refresh-fail" && failNextGameRefresh) {
      failNextGameRefresh = false;
      return createJsonResponse(503, {
        error: "unavailable",
        message: "Game refresh unavailable.",
      });
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-undo-refresh-fail" }),
    url: "http://localhost:3000/games/game-undo-refresh-fail",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: staleResultFetch,
  });

  const undoLastGoalButton = page.document.querySelector('[data-action="undo-last-goal"]');
  const timeline = page.document.getElementById("goal-timeline");
  const status = page.document.getElementById("setup-status");
  const error = page.document.getElementById("setup-error");
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);

  dispatchClick(undoLastGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.has("goal-2"), false);
  assert.equal(apiState.goalEvents.has("goal-1"), true);
  assert.equal(apiState.games.get("game-undo-refresh-fail")?.result?.winnerTeamId, "red");
  assert.match(timeline.textContent ?? "", /Ari for Red/);
  assert.doesNotMatch(timeline.textContent ?? "", /Cy for Blue/);
  assert.match(status.textContent ?? "", /Latest goal undone; result refresh failed/);
  assert.match(error.textContent ?? "", /finished result could not be refreshed/);
});

test("setup flow resolves route ids from static shells", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";

  apiState.leagues.set("autumn-league", {
    leagueId: "autumn-league",
    name: "Autumn League",
    slug: "autumn-league",
    createdByUserId: apiState.session.email,
    createdAt: "2026-03-28T11:00:01.000Z",
    updatedAt: "2026-03-28T11:00:01.000Z",
  });
  grantMockLeagueAccess(apiState, "autumn-league", apiState.session.email, "admin");
  apiState.seasons.set("autumn-cup", {
    leagueId: "autumn-league",
    seasonId: "autumn-cup",
    name: "Autumn Cup",
    slug: "autumn-cup",
    startsOn: "2026-03-01",
    endsOn: "2026-05-31",
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });
  apiState.games.set("game-20260328-abc123", {
    gameId: "game-20260328-abc123",
    leagueId: "autumn-league",
    seasonId: "autumn-cup",
    sessionId: "20260328",
    status: "scheduled",
    gameStartTs: "2026-03-28T10:00:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments(),
    createdAt: "2026-03-28T11:00:03.000Z",
    updatedAt: "2026-03-28T11:00:03.000Z",
  });

  const leaguePage = await bootPage({
    html: renderLeaguePage("http://localhost:3001", ""),
    url: "http://localhost:3000/leagues/autumn-league",
    scriptFile: "setup-flow.js",
    apiState,
  });
  assert.equal(leaguePage.document.getElementById("league-title")?.textContent, "Autumn League");

  const seasonPage = await bootPage({
    html: renderSeasonPage("http://localhost:3001", ""),
    url: "http://localhost:3000/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });
  assert.equal(seasonPage.document.getElementById("season-title")?.textContent, "Autumn Cup");

  const gamePage = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "" }),
    url: "http://localhost:3000/games/game-20260328-abc123",
    scriptFile: "setup-flow.js",
    apiState,
  });
  assert.equal(gamePage.document.getElementById("game-title")?.textContent, "game-20260328-abc123");
  assert.equal(gamePage.document.getElementById("game-id-value")?.textContent, "game-20260328-abc123");
});
