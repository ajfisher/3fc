import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  createDefaultThirdTimerSegments,
  DEFAULT_THIRD_LENGTH_MINUTES,
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

interface MockApiState {
  cookieJar: string;
  storage: Map<string, string>;
  pendingToken: string | null;
  pendingEmail: string | null;
  session: MockSession | null;
  leagues: Map<string, MockLeague>;
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

      const elapsedDelta = left.elapsedSeconds - right.elapsedSeconds;
      if (elapsedDelta !== 0) {
        return elapsedDelta;
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

function goalResponsePayload(state: MockApiState, game: MockGame, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    scoreboard: {
      teams: recomputeMockScoreboard(state, game),
    },
    timeline: sortedGoalTimeline(state, game.gameId),
  };
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
      return createJsonResponse(201, league);
    }

    const leagueMatch = path.match(/^\/v1\/leagues\/([^/]+)$/);
    if (method === "GET" && leagueMatch) {
      const league = state.leagues.get(decodeURIComponent(leagueMatch[1]));
      if (!league) {
        return createJsonResponse(404, { error: "not_found", message: "League not found." });
      }

      return createJsonResponse(200, league);
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

      const third = activeMockThird(game);
      if (!third) {
        return createJsonResponse(409, {
          error: "no_running_third",
          message: "A goal can only be created while a third is running.",
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
      const elapsedSeconds = state.goalSequence * 30;
      const now = `2026-03-28T11:01:${String(state.goalSequence).padStart(2, "0")}.000Z`;
      const goal: MockGoalEvent = {
        gameId,
        eventId: `goal-${state.goalSequence}`,
        third,
        thirdMinute: Math.floor(elapsedSeconds / 60) + 1,
        gameMinute: Math.floor(elapsedSeconds / 60) + 1 + (third - 1) * game.thirdLengthMinutes,
        elapsedSeconds,
        stoppageMinute: null,
        displayTime: `${Math.floor(elapsedSeconds / 60) + 1}'`,
        ...payload,
        createdAt: now,
        updatedAt: now,
      };
      state.goalEvents.set(goal.eventId, goal);

      return createJsonResponse(201, goalResponsePayload(state, game, { goal }));
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
      return createJsonResponse(
        200,
        goalResponsePayload(state, game, {
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

      if (method === "DELETE") {
        state.goalEvents.delete(eventId);
        return createJsonResponse(
          200,
          goalResponsePayload(state, game, {
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
      return createJsonResponse(
        200,
        goalResponsePayload(state, game, {
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
    value: createMockFetch(input.apiState),
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
  const statusInput = gamePage.document.getElementById("game-edit-status");
  const thirdLengthInput = gamePage.document.getElementById("game-edit-third-length");
  const timerDisplay = gamePage.document.getElementById("timer-display-value");
  const startThirdButton = gamePage.document.querySelector('[data-action="start-active-third"]');
  const finishThirdButton = gamePage.document.querySelector('[data-action="finish-active-third"]');
  const scheduledStatusOption = statusInput?.querySelector('option[value="scheduled"]');
  assert(nicknameInput instanceof gamePage.window.HTMLInputElement);
  assert(quickCreateButton instanceof gamePage.window.HTMLButtonElement);
  assert(rosterTeams instanceof gamePage.window.HTMLElement);
  assert(statusInput instanceof gamePage.window.HTMLSelectElement);
  assert(scheduledStatusOption instanceof gamePage.window.HTMLOptionElement);
  assert(thirdLengthInput instanceof gamePage.window.HTMLSelectElement);
  assert(timerDisplay instanceof gamePage.window.HTMLElement);
  assert(startThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert(finishThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(statusInput.value, "scheduled");
  assert.equal(scheduledStatusOption.disabled, false);
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
