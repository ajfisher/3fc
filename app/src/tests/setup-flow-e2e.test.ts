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
  renderInvitePage,
  renderJoinPage,
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

interface MockLeagueInvite {
  leagueId: string;
  inviteCode: string;
  kind: "share" | "email";
  role: "admin";
  email: string | null;
  createdByUserId: string;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
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
  joinCode?: string;
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
  disableScopedSeasonApi: boolean;
  session: MockSession | null;
  leagues: Map<string, MockLeague>;
  leagueAccess: Map<string, MockLeagueRole>;
  leagueInvites: Map<string, MockLeagueInvite>;
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
  lastPublicJoinRequest: { body: Record<string, unknown>; idempotencyKey: string | null } | null;
  lastGrantAccessRequest: { leagueId: string; body: Record<string, unknown> } | null;
  lastOrganiserInviteRequest: {
    leagueId: string;
    body: Record<string, unknown>;
    idempotencyKey: string | null;
  } | null;
  seasonDeleteRequests: Array<{ path: string; leagueId: string | null; seasonId: string }>;
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
    disableScopedSeasonApi: false,
    session: null,
    leagues: new Map<string, MockLeague>(),
    leagueAccess: new Map<string, MockLeagueRole>(),
    leagueInvites: new Map<string, MockLeagueInvite>(),
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
    lastPublicJoinRequest: null,
    lastGrantAccessRequest: null,
    lastOrganiserInviteRequest: null,
    seasonDeleteRequests: [],
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

function gamePlayerResponse(state: MockApiState, game: MockGame, player: MockPlayer): Record<string, unknown> {
  const response = publicPlayer(player);
  const league = state.leagues.get(game.leagueId);
  const callerRole = league ? mockLeagueRoleForSession(state, league) : null;
  if (callerRole !== "admin" || !player.claimedByUserId) {
    return response;
  }

  return {
    ...response,
    access: {
      userId: player.claimedByUserId,
      role: state.leagueAccess.get(leagueAccessKey(game.leagueId, player.claimedByUserId)) ?? null,
    },
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

    const joinMatch = path.match(/^\/v1\/join\/([^/]+)$/);
    if (method === "POST" && joinMatch) {
      const joinCode = decodeURIComponent(joinMatch[1]).trim().toUpperCase();
      const nickname = String(body.nickname ?? "").trim();
      const idempotencyKey = readInitHeader(init, "idempotency-key");
      state.lastPublicJoinRequest = { body, idempotencyKey };
      const game = [...state.games.values()].find((candidate) => candidate.joinCode === joinCode);
      if (!game) {
        return createJsonResponse(404, {
          error: "not_found",
          message: "Join code was not found.",
        });
      }
      if (!idempotencyKey?.trim()) {
        return createJsonResponse(400, {
          error: "bad_request",
          message: "Idempotency-Key header is required.",
        });
      }
      if ("playerId" in body) {
        return createJsonResponse(400, {
          error: "bad_request",
          message: "playerId is not accepted on public join.",
        });
      }
      if (!nickname) {
        return createJsonResponse(400, {
          error: "bad_request",
          message: "nickname is required.",
        });
      }

      const playerId = `player-${idempotencyKey}`;
      const now = "2026-03-28T11:00:12.000Z";
      const player: MockPlayer = {
        playerId,
        nickname,
        claimedByUserId: null,
        createdAt: now,
        updatedAt: now,
      };
      const link: MockGamePlayer = {
        gameId: game.gameId,
        playerId,
        createdAt: now,
        updatedAt: now,
      };
      state.players.set(playerId, player);
      state.gamePlayers.set(`${game.gameId}:${playerId}`, link);
      return createJsonResponse(201, {
        gameId: game.gameId,
        joinCode: game.joinCode,
        player,
        link,
      });
    }

    if (!isAuthenticated(state) || !state.session) {
      return createJsonResponse(401, {
        error: "unauthorized",
        message: "Valid session cookie required.",
      });
    }

    const claimPlayerMatch = path.match(/^\/v1\/players\/([^/]+)\/claim$/);
    if (method === "POST" && claimPlayerMatch) {
      const playerId = decodeURIComponent(claimPlayerMatch[1]);
      const player = state.players.get(playerId);
      if (!player) {
        return createJsonResponse(404, {
          error: "not_found",
          message: `Player ${playerId} was not found.`,
        });
      }

      if (player.claimedByUserId && player.claimedByUserId !== state.session.email) {
        return createJsonResponse(409, {
          error: "conflict",
          code: "player_already_claimed",
          message: `Player ${playerId} has already been claimed.`,
        });
      }

      const updated = {
        ...player,
        claimedByUserId: state.session.email,
        updatedAt: "2026-03-28T11:00:13.000Z",
      };
      state.players.set(playerId, updated);
      return createJsonResponse(200, {
        player: publicPlayer(updated),
        claim: {
          claimedByCurrentUser: true,
        },
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

    const leagueAccessMatch = path.match(/^\/v1\/leagues\/([^/]+)\/access$/);
    if (method === "POST" && leagueAccessMatch) {
      const leagueId = decodeURIComponent(leagueAccessMatch[1]);
      const league = state.leagues.get(leagueId);
      if (!league) {
        return createJsonResponse(404, { error: "not_found", message: "League not found." });
      }

      const callerRole = mockLeagueRoleForSession(state, league);
      if (callerRole !== "admin") {
        return createJsonResponse(403, {
          error: "forbidden",
          code: "admin_required",
          message: `Admin role is required for league ${leagueId}.`,
        });
      }

      const userId = String(body.userId ?? "");
      const role = body.role === "admin" ? "admin" : body.role === "scorekeeper" ? "scorekeeper" : null;
      if (!userId || !role) {
        return createJsonResponse(400, {
          error: "bad_request",
          message: "userId and role are required.",
        });
      }

      state.lastGrantAccessRequest = { leagueId, body };
      grantMockLeagueAccess(state, leagueId, userId, role);
      return createJsonResponse(200, {
        leagueId,
        userId,
        role,
        grantedByUserId: state.session.email,
        createdAt: "2026-03-28T11:00:14.000Z",
        updatedAt: "2026-03-28T11:00:14.000Z",
      });
    }

    const organiserInviteMatch = path.match(/^\/v1\/leagues\/([^/]+)\/organiser-invites$/);
    if (method === "POST" && organiserInviteMatch) {
      const leagueId = decodeURIComponent(organiserInviteMatch[1]);
      const league = state.leagues.get(leagueId);
      if (!league) {
        return createJsonResponse(404, { error: "not_found", message: "League not found." });
      }

      const callerRole = mockLeagueRoleForSession(state, league);
      if (callerRole !== "admin") {
        return createJsonResponse(403, {
          error: "forbidden",
          code: "admin_required",
          message: `Admin role is required for league ${leagueId}.`,
        });
      }

      const email = typeof body.email === "string" && body.email.trim().length > 0
        ? body.email.trim().toLowerCase()
        : null;
      if (email && !isValidEmail(email)) {
        return createJsonResponse(400, {
          error: "invalid_email",
          message: "Email must be a valid email address.",
        });
      }

      if (!email) {
        const existingShareInvite = [...state.leagueInvites.values()].find(
          (candidate) =>
            candidate.leagueId === leagueId &&
            candidate.kind === "share" &&
            candidate.email === null,
        );
        state.lastOrganiserInviteRequest = {
          leagueId,
          body,
          idempotencyKey: readInitHeader(init, "idempotency-key"),
        };
        if (existingShareInvite) {
          return createJsonResponse(201, {
            invite: existingShareInvite,
            inviteCode: existingShareInvite.inviteCode,
            inviteLink: `http://localhost:3000/invites?code=${existingShareInvite.inviteCode}`,
            emailDelivery: null,
          });
        }
      }

      const inviteCode = ["ABCD2345", "EFGH2345", "JKLM2345"][state.leagueInvites.size] ?? "NPQR2345";
      const invite: MockLeagueInvite = {
        leagueId,
        inviteCode,
        kind: email ? "email" : "share",
        role: "admin",
        email,
        createdByUserId: state.session.email,
        acceptedByUserId: null,
        acceptedAt: null,
        createdAt: "2026-03-28T11:00:15.000Z",
        updatedAt: "2026-03-28T11:00:15.000Z",
      };
      state.lastOrganiserInviteRequest = {
        leagueId,
        body,
        idempotencyKey: readInitHeader(init, "idempotency-key"),
      };
      state.leagueInvites.set(inviteCode, invite);
      return createJsonResponse(201, {
        invite,
        inviteCode,
        inviteLink: `http://localhost:3000/invites?code=${inviteCode}`,
        emailDelivery: email
          ? {
              status: "sent",
              email,
              expiresAt: "2026-03-28T11:15:00.000Z",
              messageId: "msg-1",
            }
          : null,
      });
    }

    const acceptOrganiserInviteMatch = path.match(/^\/v1\/invites\/([^/]+)\/accept$/);
    if (method === "POST" && acceptOrganiserInviteMatch) {
      const inviteCode = decodeURIComponent(acceptOrganiserInviteMatch[1]).trim().toUpperCase();
      const invite = state.leagueInvites.get(inviteCode);
      if (!invite) {
        return createJsonResponse(404, {
          error: "not_found",
          message: "Organiser invite was not found.",
        });
      }

      const sessionEmail = state.session.email.trim().toLowerCase();
      if (invite.email && invite.email !== sessionEmail) {
        return createJsonResponse(403, {
          error: "forbidden",
          code: "invite_email_mismatch",
          message: "This organiser invite was issued for a different email address.",
        });
      }

      if (invite.kind !== "share" && invite.acceptedByUserId && invite.acceptedByUserId !== state.session.email) {
        return createJsonResponse(409, {
          error: "conflict",
          code: "invite_already_accepted",
          message: "This organiser invite has already been accepted.",
        });
      }

      const acceptedInvite: MockLeagueInvite = {
        ...invite,
        acceptedByUserId: invite.kind === "share" ? null : invite.acceptedByUserId ?? state.session.email,
        acceptedAt: invite.kind === "share" ? null : invite.acceptedAt ?? "2026-03-28T11:00:16.000Z",
        updatedAt:
          invite.kind === "share" || invite.acceptedByUserId
            ? invite.updatedAt
            : "2026-03-28T11:00:16.000Z",
      };
      state.leagueInvites.set(inviteCode, acceptedInvite);
      grantMockLeagueAccess(state, invite.leagueId, state.session.email, "admin");
      return createJsonResponse(200, {
        invite: acceptedInvite,
        access: {
          leagueId: invite.leagueId,
          userId: state.session.email,
          role: "admin",
          grantedByUserId: invite.createdByUserId,
          createdAt: "2026-03-28T11:00:16.000Z",
          updatedAt: "2026-03-28T11:00:16.000Z",
        },
        inviteLink: `http://localhost:3000/invites?code=${inviteCode}`,
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
      for (const [inviteCode, invite] of state.leagueInvites) {
        if (invite.leagueId === leagueId) {
          state.leagueInvites.delete(inviteCode);
        }
      }
      for (const accessKey of state.leagueAccess.keys()) {
        if (accessKey.startsWith(`${leagueId}:`)) {
          state.leagueAccess.delete(accessKey);
        }
      }
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

    const leagueSeasonMatch = path.match(/^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)$/);
    if (method === "GET" && leagueSeasonMatch) {
      if (state.disableScopedSeasonApi) {
        return createJsonResponse(404, { error: "not_found", message: "Route not found." });
      }

      const leagueId = decodeURIComponent(leagueSeasonMatch[1]);
      const seasonId = decodeURIComponent(leagueSeasonMatch[2]);
      const season =
        [...state.seasons.values()].find(
          (candidate) => candidate.leagueId === leagueId && candidate.seasonId === seasonId,
        ) ?? null;
      if (!season) {
        return createJsonResponse(404, { error: "not_found", message: "Season not found." });
      }

      return createJsonResponse(200, season);
    }

    const leagueSeasonGamesMatch = path.match(/^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)\/games$/);
    if (method === "GET" && leagueSeasonGamesMatch) {
      if (state.disableScopedSeasonApi) {
        return createJsonResponse(404, { error: "not_found", message: "Route not found." });
      }

      const leagueId = decodeURIComponent(leagueSeasonGamesMatch[1]);
      const seasonId = decodeURIComponent(leagueSeasonGamesMatch[2]);
      return createJsonResponse(200, {
        games: [...state.games.values()].filter(
          (game) => game.leagueId === leagueId && game.seasonId === seasonId,
        ),
      });
    }

    const leagueSeasonSessionsMatch = path.match(/^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)\/sessions$/);
    if (method === "POST" && leagueSeasonSessionsMatch) {
      if (state.disableScopedSeasonApi) {
        return createJsonResponse(404, { error: "not_found", message: "Route not found." });
      }

      const seasonId = decodeURIComponent(leagueSeasonSessionsMatch[2]);
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

    const leagueSeasonSessionGamesMatch = path.match(
      /^\/v1\/leagues\/([^/]+)\/seasons\/([^/]+)\/sessions\/([^/]+)\/games$/,
    );
    if (method === "POST" && leagueSeasonSessionGamesMatch) {
      if (state.disableScopedSeasonApi) {
        return createJsonResponse(404, { error: "not_found", message: "Route not found." });
      }

      const leagueId = decodeURIComponent(leagueSeasonSessionGamesMatch[1]);
      const seasonId = decodeURIComponent(leagueSeasonSessionGamesMatch[2]);
      const sessionId = decodeURIComponent(leagueSeasonSessionGamesMatch[3]);
      const gameId = String(body.gameId ?? "");
      const now = "2026-03-28T11:00:04.000Z";
      const game: MockGame = {
        gameId,
        joinCode: `JOIN${gameId.slice(-4).toUpperCase()}`,
        leagueId,
        seasonId,
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

    if (method === "DELETE" && leagueSeasonMatch) {
      if (state.disableScopedSeasonApi) {
        return createJsonResponse(404, { error: "not_found", message: "Route not found." });
      }

      const leagueId = decodeURIComponent(leagueSeasonMatch[1]);
      const seasonId = decodeURIComponent(leagueSeasonMatch[2]);
      state.seasonDeleteRequests.push({ path, leagueId, seasonId });
      const season = state.seasons.get(seasonId);
      if (!season || season.leagueId !== leagueId) {
        return createJsonResponse(404, { error: "not_found", message: "Season not found." });
      }

      if ([...state.games.values()].some((game) => game.leagueId === leagueId && game.seasonId === seasonId)) {
        return createJsonResponse(409, {
          error: "conflict",
          message: "Cannot delete season with existing games.",
        });
      }

      state.seasons.delete(seasonId);
      return new Response(null, { status: 204 });
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
      state.seasonDeleteRequests.push({ path, leagueId: null, seasonId });
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
        joinCode: `JOIN${gameId.slice(-4).toUpperCase()}`,
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
        .map((player) => gamePlayerResponse(state, game, player));
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

function expectedLocalTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16).replace("T", " ");
}

function expectedLocalDateHeading(isoTimestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(isoTimestamp));
}

function expectedLocalKickoffTime(isoTimestamp: string): string {
  return `Kickoff at ${new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoTimestamp))}`;
}

async function bootPage(input: {
  html: string;
  url: string;
  scriptFile: string;
  apiState: MockApiState;
  fetch?: ReturnType<typeof createMockFetch>;
  flushOnBoot?: boolean;
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
  if (input.flushOnBoot !== false) {
    await flushAsync();
  }

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

test("auth callback rejects backslash return targets", async () => {
  const apiState = createMockApiState();
  apiState.pendingEmail = "organizer@3fc.football";
  apiState.pendingToken = "token-1";

  const callbackPage = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1&returnTo=/%5Cevil.example",
    scriptFile: "auth-flow.js",
    apiState,
  });
  await flushAsync();

  assert.equal(callbackPage.navigations.length, 0);
  assert.equal(apiState.cookieJar, "");
  assert.equal(
    callbackPage.document.getElementById("auth-callback-status")?.textContent,
    "Magic link ready. Complete sign-in to continue.",
  );

  const completeButton = callbackPage.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof callbackPage.window.HTMLButtonElement);
  dispatchClick(completeButton);
  await flushAsync();

  const callbackNavigation = callbackPage.navigations.at(-1);
  assert(callbackNavigation);
  assert.equal(callbackNavigation.url, "/setup");
  assert.equal(apiState.cookieJar, "threefc_session=session-1");
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
  const createLeagueToggle = dashboard.document.querySelector('[data-action="toggle-create-league"]');
  const createLeagueRegion = dashboard.document.getElementById("dashboard-create-league-region");
  const leagueNameNotice = dashboard.document.getElementById("league-name-notice");
  assert(createLeagueButton instanceof dashboard.window.HTMLButtonElement);
  assert(createLeagueToggle instanceof dashboard.window.HTMLButtonElement);
  assert(createLeagueRegion instanceof dashboard.window.HTMLElement);
  assert(leagueNameNotice instanceof dashboard.window.HTMLElement);
  assert.equal(dashboard.document.getElementById("dashboard-welcome")?.textContent, "Welcome Organizer");
  assert.equal(createLeagueToggle.getAttribute("aria-expanded"), "true");
  assert.equal(createLeagueRegion.hidden, false);
  assert.notEqual(dashboard.document.activeElement?.id, "league-name");
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
  assert.equal(seasonNavigation.url, "/leagues/autumn-league/seasons/autumn-2026");

  const seasonPage = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-2026", "autumn-league"),
    url: "http://localhost:3000/leagues/autumn-league/seasons/autumn-2026",
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

test("populated dashboard keeps league creation disclosed on demand and handles icon-child actions", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "AJ.FISHER@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.leagues.set("autumn-league", {
    leagueId: "autumn-league",
    name: "Autumn League",
    slug: "autumn-league",
    createdByUserId: apiState.session.email,
    createdAt: "2026-03-28T11:00:00.000Z",
    updatedAt: "2026-03-28T11:00:00.000Z",
  });
  grantMockLeagueAccess(apiState, "autumn-league", apiState.session.email, "admin");

  const page = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"),
    url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const toggle = page.document.querySelector('[data-testid="toggle-create-league"]');
  const region = page.document.getElementById("dashboard-create-league-region");
  assert(toggle instanceof page.window.HTMLButtonElement);
  assert(region instanceof page.window.HTMLElement);
  assert.equal(page.document.getElementById("dashboard-welcome")?.textContent, "Welcome Aj");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(region.hidden, true);

  dispatchClick(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(region.hidden, false);
  assert.equal(page.document.activeElement?.id, "league-name");

  let confirmations = 0;
  Object.defineProperty(page.window, "confirm", {
    value: () => {
      confirmations += 1;
      return true;
    },
    configurable: true,
  });
  const deleteIcon = page.document.querySelector(
    '[data-action="delete-league"][data-league-id="autumn-league"] [data-icon="trash-2"]',
  );
  assert(deleteIcon instanceof page.window.HTMLElement);
  dispatchClick(deleteIcon);
  await flushAsync();

  assert.equal(confirmations, 1);
  assert.equal(apiState.leagues.has("autumn-league"), false);
});

test("empty dashboard does not reopen creation after a slow response overrides user choice", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  const defaultFetch = createMockFetch(apiState);
  let resolveLeagues: ((response: Response) => void) | undefined;
  const delayedFetch: typeof fetch = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    if ((init.method ?? "GET").toUpperCase() === "GET" && target.pathname === "/v1/leagues") {
      return new Promise<Response>((resolve) => {
        resolveLeagues = resolve;
      });
    }
    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"),
    url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: delayedFetch,
    flushOnBoot: false,
  });
  await flushAsync();

  const toggle = page.document.querySelector('[data-testid="toggle-create-league"]');
  const region = page.document.getElementById("dashboard-create-league-region");
  assert(toggle instanceof page.window.HTMLButtonElement);
  assert(region instanceof page.window.HTMLElement);
  dispatchClick(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  dispatchClick(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(page.document.activeElement, toggle);

  assert(resolveLeagues);
  resolveLeagues(createJsonResponse(200, { leagues: [] }));
  await flushAsync();

  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(region.hidden, true);
  assert.equal(page.document.activeElement, toggle);
});

test("dashboard greeting falls back to the full email when no local-part token exists", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "...@example.com",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";

  const page = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"),
    url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  assert.equal(page.document.getElementById("dashboard-welcome")?.textContent, "Welcome ...@example.com");
});

test("league page loads reusable organiser share invites and sends direct email invites", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-admin",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-admin";
  apiState.leagues.set("autumn-league", {
    leagueId: "autumn-league",
    name: "Autumn League",
    slug: "autumn-league",
    createdByUserId: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    updatedAt: "2026-03-28T11:00:00.000Z",
  });
  grantMockLeagueAccess(apiState, "autumn-league", "organizer@3fc.football", "admin");

  const leaguePage = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "autumn-league"),
    url: "http://localhost:3000/leagues/autumn-league",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const createInviteButton = leaguePage.document.querySelector('[data-testid="create-organiser-invite"]');
  const createSeasonToggle = leaguePage.document.querySelector('[data-testid="toggle-create-season"]');
  const createSeasonRegion = leaguePage.document.getElementById("league-create-season-region");
  const inviteToggle = leaguePage.document.querySelector('[data-testid="toggle-organiser-invite"]');
  const inviteRegion = leaguePage.document.getElementById("league-organiser-invite-region");
  const inviteEmailInput = leaguePage.document.getElementById("organiser-invite-email");
  assert(createInviteButton instanceof leaguePage.window.HTMLButtonElement);
  assert(createSeasonToggle instanceof leaguePage.window.HTMLButtonElement);
  assert(createSeasonRegion instanceof leaguePage.window.HTMLElement);
  assert(inviteToggle instanceof leaguePage.window.HTMLButtonElement);
  assert(inviteRegion instanceof leaguePage.window.HTMLElement);
  assert(inviteEmailInput instanceof leaguePage.window.HTMLInputElement);

  assert.equal(apiState.lastOrganiserInviteRequest, null);
  assert.equal(inviteRegion.hidden, true);
  dispatchClick(createSeasonToggle);
  assert.equal(createSeasonRegion.hidden, false);
  assert.equal(leaguePage.document.activeElement?.id, "season-name");
  dispatchClick(inviteToggle);
  await flushAsync();

  assert.equal(inviteToggle.getAttribute("aria-expanded"), "true");
  assert.equal(inviteRegion.hidden, false);
  assert.equal(createSeasonToggle.getAttribute("aria-expanded"), "false");
  assert.equal(createSeasonRegion.hidden, true);
  assert.equal(leaguePage.document.activeElement, inviteEmailInput);
  const shareRequest = apiState.lastOrganiserInviteRequest as unknown as Exclude<
    MockApiState["lastOrganiserInviteRequest"],
    null
  >;
  assert.equal(shareRequest.leagueId, "autumn-league");
  assert.deepEqual(shareRequest.body, { email: null });
  assert.equal(
    shareRequest.idempotencyKey,
    "organiser-share-invite-autumn-league",
  );
  assert.equal(
    apiState.storage.has("threefc-idempotency:organiser-invite:autumn-league-link"),
    false,
  );
  assert.equal(leaguePage.document.getElementById("organiser-share-invite-status")?.textContent, "");
  assert.equal(leaguePage.document.getElementById("organiser-share-invite-code")?.textContent, "ABCD2345");
  const inviteLink = leaguePage.document.getElementById("organiser-share-invite-link");
  assert(inviteLink instanceof leaguePage.window.HTMLAnchorElement);
  assert.equal(inviteLink.href, "http://localhost:3000/invites?code=ABCD2345");
  dispatchClick(inviteToggle);
  assert.equal(inviteRegion.hidden, true);
  assert.equal(leaguePage.document.activeElement, inviteToggle);
  dispatchClick(inviteToggle);
  await flushAsync();
  assert.deepEqual(shareRequest.body, { email: null });
  assert.equal(leaguePage.document.getElementById("organiser-email-invite-result"), null);
  assert.equal(leaguePage.document.getElementById("organiser-invite-email-status")?.textContent, "");

  inviteEmailInput.value = "Coach@Example.COM";
  inviteEmailInput.dispatchEvent(new leaguePage.window.Event("input", { bubbles: true }));
  dispatchClick(createInviteButton);
  await flushAsync();

  const emailRequest = apiState.lastOrganiserInviteRequest as unknown as Exclude<
    MockApiState["lastOrganiserInviteRequest"],
    null
  >;
  assert.deepEqual(emailRequest.body, { email: "Coach@Example.COM" });
  assert.equal(leaguePage.document.getElementById("organiser-share-invite-code")?.textContent, "ABCD2345");
  assert.equal(leaguePage.document.getElementById("organiser-email-invite-result"), null);
  assert.equal(leaguePage.document.getElementById("organiser-email-invite-code"), null);
  assert.equal(leaguePage.document.getElementById("organiser-email-invite-link"), null);
  assert.equal(
    leaguePage.document.getElementById("organiser-invite-email-status")?.textContent,
    "Sent to coach@example.com.",
  );
});

test("league page reuses organiser invite idempotency key until a retry succeeds", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-admin",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-admin";
  apiState.leagues.set("autumn-league", {
    leagueId: "autumn-league",
    name: "Autumn League",
    slug: "autumn-league",
    createdByUserId: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    updatedAt: "2026-03-28T11:00:00.000Z",
  });
  grantMockLeagueAccess(apiState, "autumn-league", "organizer@3fc.football", "admin");

  const defaultFetch = createMockFetch(apiState);
  const requestedKeys: string[] = [];
  let failNextInvite = true;
  const retryFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "POST" && target.pathname === "/v1/leagues/autumn-league/organiser-invites") {
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      if (typeof body.email === "string" && body.email.trim().length > 0) {
        const idempotencyKey = readInitHeader(init, "idempotency-key");
        if (idempotencyKey) {
          requestedKeys.push(idempotencyKey);
        }
        if (failNextInvite) {
          failNextInvite = false;
          return createJsonResponse(503, {
            error: "temporary_failure",
            message: "Temporary failure.",
          });
        }
      }
    }

    return defaultFetch(input, init);
  };

  const leaguePage = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "autumn-league"),
    url: "http://localhost:3000/leagues/autumn-league",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: retryFetch,
  });

  const createInviteButton = leaguePage.document.querySelector('[data-testid="create-organiser-invite"]');
  const inviteEmailInput = leaguePage.document.getElementById("organiser-invite-email");
  assert(createInviteButton instanceof leaguePage.window.HTMLButtonElement);
  assert(inviteEmailInput instanceof leaguePage.window.HTMLInputElement);

  inviteEmailInput.value = "Coach@Example.COM";
  inviteEmailInput.dispatchEvent(new leaguePage.window.Event("input", { bubbles: true }));
  dispatchClick(createInviteButton);
  await flushAsync();

  assert.equal(leaguePage.document.getElementById("setup-status")?.textContent, "Organiser invite failed.");
  assert.equal(
    leaguePage.document.getElementById("organiser-invite-email-status")?.textContent,
    "Invite failed: Temporary failure.",
  );
  assert.equal(
    apiState.storage.get("threefc-idempotency:organiser-invite:autumn-league-coach%40example.com"),
    requestedKeys[0],
  );

  dispatchClick(createInviteButton);
  await flushAsync();

  assert.equal(requestedKeys.length, 2);
  assert.equal(requestedKeys[1], requestedKeys[0]);
  assert.equal(
    apiState.storage.has("threefc-idempotency:organiser-invite:autumn-league-coach%40example.com"),
    false,
  );
  assert.equal(leaguePage.document.getElementById("setup-status")?.textContent, "Organiser invite sent.");
  assert.equal(
    leaguePage.document.getElementById("organiser-invite-email-status")?.textContent,
    "Sent to coach@example.com.",
  );
});

test("league page retries a failed reusable invite when its disclosure is reopened", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-admin",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-admin";
  apiState.leagues.set("autumn-league", {
    leagueId: "autumn-league",
    name: "Autumn League",
    slug: "autumn-league",
    createdByUserId: apiState.session.email,
    createdAt: "2026-03-28T11:00:00.000Z",
    updatedAt: "2026-03-28T11:00:00.000Z",
  });
  grantMockLeagueAccess(apiState, "autumn-league", apiState.session.email, "admin");

  const defaultFetch = createMockFetch(apiState);
  let shareAttempts = 0;
  const retryFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && target.pathname === "/v1/leagues/autumn-league/organiser-invites") {
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (body.email === null) {
        shareAttempts += 1;
        if (shareAttempts === 1) {
          return createJsonResponse(503, { error: "temporary_failure", message: "Temporary failure." });
        }
      }
    }
    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "autumn-league"),
    url: "http://localhost:3000/leagues/autumn-league",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: retryFetch,
  });
  const toggle = page.document.querySelector('[data-testid="toggle-organiser-invite"]');
  assert(toggle instanceof page.window.HTMLButtonElement);

  dispatchClick(toggle);
  await flushAsync();
  assert.equal(shareAttempts, 1);
  assert.equal(
    page.document.getElementById("organiser-share-invite-status")?.textContent,
    "Share invite unavailable. Close and reopen to try again.",
  );

  dispatchClick(toggle);
  dispatchClick(toggle);
  await flushAsync();
  assert.equal(shareAttempts, 2);
  assert.equal(page.document.getElementById("organiser-share-invite-code")?.textContent, "ABCD2345");
});

test("league page shows manual invite link when organiser email delivery is unconfirmed", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-admin",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-admin";
  apiState.leagues.set("autumn-league", {
    leagueId: "autumn-league",
    name: "Autumn League",
    slug: "autumn-league",
    createdByUserId: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    updatedAt: "2026-03-28T11:00:00.000Z",
  });
  grantMockLeagueAccess(apiState, "autumn-league", "organizer@3fc.football", "admin");

  const defaultFetch = createMockFetch(apiState);
  const uncertainKeys: string[] = [];
  const uncertainFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "POST" && target.pathname === "/v1/leagues/autumn-league/organiser-invites") {
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      if (typeof body.email !== "string" || body.email.trim().length === 0) {
        return defaultFetch(input, init);
      }

      const idempotencyKey = readInitHeader(init, "idempotency-key");
      if (idempotencyKey) {
        uncertainKeys.push(idempotencyKey);
      }

      return createJsonResponse(202, {
        invite: {
          leagueId: "autumn-league",
          inviteCode: "UNKN2345",
          kind: "email",
          role: "admin",
          email: "coach@example.com",
          createdByUserId: "organizer@3fc.football",
          acceptedByUserId: null,
          acceptedAt: null,
          createdAt: "2026-03-28T11:00:15.000Z",
          updatedAt: "2026-03-28T11:00:15.000Z",
        },
        inviteCode: "UNKN2345",
        inviteLink: "http://localhost:3000/invites?code=UNKN2345",
        emailDelivery: {
          status: "unknown",
          email: "coach@example.com",
          expiresAt: null,
          messageId: null,
          message: "Email delivery could not be confirmed. Share the invite link manually.",
        },
      });
    }

    return defaultFetch(input, init);
  };

  const leaguePage = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "autumn-league"),
    url: "http://localhost:3000/leagues/autumn-league",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: uncertainFetch,
  });

  const createInviteButton = leaguePage.document.querySelector('[data-testid="create-organiser-invite"]');
  const inviteEmailInput = leaguePage.document.getElementById("organiser-invite-email");
  assert(createInviteButton instanceof leaguePage.window.HTMLButtonElement);
  assert(inviteEmailInput instanceof leaguePage.window.HTMLInputElement);

  inviteEmailInput.value = "Coach@Example.COM";
  inviteEmailInput.dispatchEvent(new leaguePage.window.Event("input", { bubbles: true }));
  dispatchClick(createInviteButton);
  await flushAsync();

  assert.equal(
    leaguePage.document.getElementById("setup-status")?.textContent,
    "Organiser invite created; email delivery unconfirmed.",
  );
  assert.equal(
    leaguePage.document.getElementById("organiser-invite-email-status")?.textContent,
    "Delivery unconfirmed. Open the email-restricted recovery link.",
  );
  const recoveryLink = leaguePage.document.querySelector(
    "#organiser-invite-email-status .inline-recovery-link",
  );
  assert(recoveryLink instanceof leaguePage.window.HTMLAnchorElement);
  assert.equal(recoveryLink.href, "http://localhost:3000/invites?code=UNKN2345");
  assert.equal(leaguePage.document.getElementById("organiser-email-invite-code"), null);
  assert.equal(leaguePage.document.getElementById("organiser-email-invite-link"), null);
  assert.equal(leaguePage.document.getElementById("organiser-email-invite-result"), null);
  assert.equal(
    apiState.storage.has("threefc-idempotency:organiser-invite:autumn-league-coach%40example.com"),
    false,
  );
  assert.equal(uncertainKeys.length, 1);
});

test("invite page accepts organiser codes after confirmation and grants league admin access", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-invitee",
    email: "coach@example.com",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-invitee";
  apiState.leagues.set("autumn-league", {
    leagueId: "autumn-league",
    name: "Autumn League",
    slug: "autumn-league",
    createdByUserId: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    updatedAt: "2026-03-28T11:00:00.000Z",
  });
  apiState.leagueInvites.set("ABCD2345", {
    leagueId: "autumn-league",
    inviteCode: "ABCD2345",
    kind: "email",
    role: "admin",
    email: "coach@example.com",
    createdByUserId: "organizer@3fc.football",
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: "2026-03-28T11:00:15.000Z",
    updatedAt: "2026-03-28T11:00:15.000Z",
  });

  const invitePage = await bootPage({
    html: renderInvitePage("http://localhost:3001", ""),
    url: "http://localhost:3000/invites?code=abcd2345",
    scriptFile: "setup-flow.js",
    apiState,
  });
  await flushAsync();

  assert.equal(apiState.leagueAccess.get(leagueAccessKey("autumn-league", "coach@example.com")), undefined);
  assert.equal(apiState.leagueInvites.get("ABCD2345")?.acceptedByUserId, null);
  assert.equal(
    invitePage.document.getElementById("setup-status")?.textContent,
    "Invite page ready.",
  );
  assert.equal(invitePage.document.getElementById("organiser-invite-code-form")?.hidden, true);
  assert.equal(invitePage.document.getElementById("organiser-invite-accept-code")?.textContent, "ABCD2345");

  const acceptButton = invitePage.document.querySelector('[data-action="accept-organiser-invite"]');
  assert(acceptButton instanceof invitePage.window.HTMLButtonElement);
  dispatchClick(acceptButton);
  await flushAsync();

  assert.equal(apiState.leagueAccess.get(leagueAccessKey("autumn-league", "coach@example.com")), "admin");
  assert.equal(
    invitePage.document.getElementById("setup-status")?.textContent,
    "Organiser invite accepted.",
  );
  assert.equal(invitePage.document.getElementById("organiser-invite-league")?.textContent, "autumn-league");
  assert.equal(invitePage.document.getElementById("organiser-invite-code-form")?.hidden, true);
  const leagueLink = invitePage.document.getElementById("organiser-invite-league-link");
  assert(leagueLink instanceof invitePage.window.HTMLAnchorElement);
  assert.equal(leagueLink.hidden, false);
  assert.equal(leagueLink.getAttribute("href"), "/leagues/autumn-league");
});

test("season page renders game kickoff times in the user local timezone", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, {
    gameId: "game-season-local-time",
  });
  const scheduledGame = apiState.games.get("game-season-local-time");
  assert(scheduledGame);
  apiState.games.set("game-season-live", {
    ...scheduledGame,
    gameId: "game-season-live",
    status: "live",
    gameStartTs: "2026-03-28T10:05:00.000Z",
  });
  apiState.games.set("game-season-finished", {
    ...scheduledGame,
    gameId: "game-season-finished",
    status: "finished",
    gameStartTs: "2026-03-28T10:10:00.000Z",
  });

  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup"),
    url: "http://localhost:3000/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const gamesBody = page.document.getElementById("season-games-body");
  const game = apiState.games.get("game-season-local-time");
  assert(gamesBody instanceof page.window.HTMLElement);
  assert(game);
  assert.match(gamesBody.textContent ?? "", new RegExp(expectedLocalTimestamp(game.gameStartTs)));
  assert.doesNotMatch(gamesBody.textContent ?? "", /game-season-local-time/);
  assert.doesNotMatch(gamesBody.textContent ?? "", /Z\b|UTC/);
  const kickoffLink = gamesBody.querySelector('a[href="/games/game-season-local-time"]');
  assert(kickoffLink instanceof page.window.HTMLAnchorElement);
  assert.equal(kickoffLink.textContent, expectedLocalTimestamp(game.gameStartTs));
  const statusChip = gamesBody.querySelector('[data-ui="status-chip"][data-status="scheduled"]');
  assert(statusChip instanceof page.window.HTMLElement);
  assert.match(statusChip.textContent ?? "", /Scheduled/);
  assert(statusChip.querySelector('[data-icon="calendar-clock"]'));
  assert(gamesBody.querySelector('[aria-label^="View game at"] [data-icon="eye"]'));
  assert(gamesBody.querySelector('[aria-label^="Delete game at"] [data-icon="trash-2"]'));
  assert(gamesBody.querySelector('[data-status="live"] [data-icon="activity"]'));
  assert(gamesBody.querySelector('[data-status="finished"] [data-icon="circle-check"]'));
});

test("season kickoff links use the next local calendar date across a UTC boundary", async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Australia/Melbourne";

  try {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "game-date-boundary" });
    const game = apiState.games.get("game-date-boundary");
    assert(game);
    game.gameStartTs = "2026-03-28T16:30:00.000Z";

    const page = await bootPage({
      html: renderSeasonPage("http://localhost:3001", "autumn-cup"),
      url: "http://localhost:3000/seasons/autumn-cup",
      scriptFile: "setup-flow.js",
      apiState,
    });

    const kickoffLink = page.document.querySelector('a[href="/games/game-date-boundary"]');
    assert(kickoffLink instanceof page.window.HTMLAnchorElement);
    assert.equal(kickoffLink.textContent, "2026-03-29 03:30");

    const gamePage = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "game-date-boundary" }),
      url: "http://localhost:3000/games/game-date-boundary",
      scriptFile: "setup-flow.js",
      apiState,
    });
    assert.equal(
      gamePage.document.getElementById("game-title")?.textContent,
      expectedLocalDateHeading(game.gameStartTs),
    );
    assert.match(gamePage.document.getElementById("game-title")?.textContent ?? "", /29/);
    assert.equal(
      gamePage.document.getElementById("game-subtitle")?.textContent,
      expectedLocalKickoffTime(game.gameStartTs),
    );
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

test("league static shell remounts nested league season routes as scoped season pages", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, {
    gameId: "game-season-static-fallback",
    role: "admin",
  });

  const page = await bootPage({
    html: renderLeaguePage("http://localhost:3001", ""),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const root = page.document.getElementById("setup-flow-root");
  const shell = page.document.querySelector('[data-testid="season-shell"]');
  const gamesBody = page.document.getElementById("season-games-body");

  assert(shell instanceof page.window.HTMLElement);
  assert.equal(root?.getAttribute("data-page"), "season");
  assert.equal(root?.getAttribute("data-league-id"), "three-sided-football-club");
  assert.equal(root?.getAttribute("data-season-id"), "autumn-cup");
  assert.equal(page.document.getElementById("season-title")?.textContent, "Autumn Cup");
  assert(gamesBody instanceof page.window.HTMLElement);
  assert(gamesBody.querySelector('a[href="/games/game-season-static-fallback"]'));
  assert.doesNotMatch(gamesBody.textContent ?? "", /game-season-static-fallback/);
});

test("season page falls back to legacy season APIs during site-first scoped rollout", async () => {
  const apiState = createMockApiState();
  apiState.disableScopedSeasonApi = true;
  apiState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  apiState.leagues.set("league-a", {
    leagueId: "league-a",
    name: "League A",
    slug: "league-a",
    createdByUserId: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:01.000Z",
    updatedAt: "2026-03-28T11:00:01.000Z",
  });
  apiState.seasons.set("winter-2026", {
    leagueId: "league-a",
    seasonId: "winter-2026",
    name: "Winter 2026",
    slug: "winter-2026",
    startsOn: null,
    endsOn: null,
    createdAt: "2026-03-28T11:00:02.000Z",
    updatedAt: "2026-03-28T11:00:02.000Z",
  });
  apiState.games.set("game-visible", {
    gameId: "game-visible",
    joinCode: "JOIN1111",
    leagueId: "league-a",
    seasonId: "winter-2026",
    sessionId: "session-shared",
    status: "scheduled",
    gameStartTs: "2026-06-21T10:00:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments(),
    finishedAt: null,
    result: null,
    createdAt: "2026-03-28T11:00:03.000Z",
    updatedAt: "2026-03-28T11:00:03.000Z",
  });
  apiState.games.set("game-foreign", {
    gameId: "game-foreign",
    joinCode: "JOIN2222",
    leagueId: "league-b",
    seasonId: "winter-2026",
    sessionId: "session-shared",
    status: "scheduled",
    gameStartTs: "2026-06-21T10:05:00.000Z",
    thirdLengthMinutes: DEFAULT_THIRD_LENGTH_MINUTES,
    thirds: createDefaultThirdTimerSegments(),
    finishedAt: null,
    result: null,
    createdAt: "2026-03-28T11:00:04.000Z",
    updatedAt: "2026-03-28T11:00:04.000Z",
  });

  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "winter-2026", "league-a"),
    url: "http://localhost:3000/leagues/league-a/seasons/winter-2026",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const gamesBody = page.document.getElementById("season-games-body");
  assert(gamesBody instanceof page.window.HTMLElement);
  assert.equal(page.document.getElementById("season-title")?.textContent, "Winter 2026");
  assert(gamesBody.querySelector('a[href="/games/game-visible"]'));
  assert.equal(gamesBody.querySelector('a[href="/games/game-foreign"]'), null);
  assert.doesNotMatch(gamesBody.textContent ?? "", /game-visible|game-foreign/);
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

  assert.equal(callbackPage.navigations.length, 0);
  assert.equal(apiState.cookieJar, "");
  const completeButton = callbackPage.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof callbackPage.window.HTMLButtonElement);
  dispatchClick(completeButton);
  await flushAsync();

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
  assert.equal(seasonNavigation.url, "/leagues/three-sided-football-club/seasons/autumn-cup");

  const seasonPage = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const gameDateInput = seasonPage.document.getElementById("game-date");
  const gameKickoffInput = seasonPage.document.getElementById("game-kickoff");
  const createGameButton = seasonPage.document.querySelector('[data-action="create-game"]');
  assert(gameDateInput instanceof seasonPage.window.HTMLInputElement);
  assert(gameKickoffInput instanceof seasonPage.window.HTMLInputElement);
  assert.equal(seasonPage.document.getElementById("game-id-display"), null);
  assert(createGameButton instanceof seasonPage.window.HTMLButtonElement);

  gameDateInput.value = "2026-03-28";
  gameDateInput.dispatchEvent(new seasonPage.window.Event("change", { bubbles: true }));
  gameKickoffInput.value = "2026-03-28T10:00";
  gameKickoffInput.dispatchEvent(new seasonPage.window.Event("change", { bubbles: true }));
  dispatchClick(createGameButton);
  await flushAsync();

  const gameNavigation = seasonPage.navigations.at(-1);
  assert(gameNavigation);
  const gameId = decodeURIComponent(gameNavigation.url.split("/").at(-1) ?? "");
  const createdGame = apiState.games.get(gameId);
  assert(createdGame);
  assert.equal(gameNavigation.url, `/games/${gameId}`);

  const gamePage = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId }),
    url: `http://localhost:3000/games/${gameId}`,
    scriptFile: "setup-flow.js",
    apiState,
  });

  const title = gamePage.document.getElementById("game-title");
  const subtitle = gamePage.document.getElementById("game-subtitle");
  const leagueId = gamePage.document.getElementById("game-league-id");
  const seasonId = gamePage.document.getElementById("game-season-id");
  const createAnotherLink = gamePage.document.getElementById("create-another-game-link");

  assert.equal(title?.textContent, expectedLocalDateHeading(createdGame.gameStartTs));
  assert.doesNotMatch(title?.textContent ?? "", new RegExp(gameId));
  assert.match(subtitle?.textContent ?? "", /^Kickoff at /);
  assert.doesNotMatch(subtitle?.textContent ?? "", /Z\b|UTC/);
  assert.equal(leagueId?.textContent, "three-sided-football-club");
  assert.equal(seasonId?.textContent, "autumn-cup");
  assert.equal(
    createAnotherLink?.getAttribute("href"),
    "/leagues/three-sided-football-club/seasons/autumn-cup#create-game",
  );
});

test("season create-game hash opens and focuses the hidden form", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "existing-game" });

  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup#create-game",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const toggle = page.document.querySelector('[data-testid="toggle-create-game"]');
  const region = page.document.getElementById("season-create-game-region");
  assert(toggle instanceof page.window.HTMLButtonElement);
  assert(region instanceof page.window.HTMLElement);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(region.hidden, false);
  assert.equal(page.document.activeElement?.id, "game-date");
});

test("season page does not fall back to legacy create routes when scoped writes are unavailable", async () => {
  const apiState = createMockApiState();
  apiState.disableScopedSeasonApi = true;
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

  const seasonPage = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const gameDateInput = seasonPage.document.getElementById("game-date");
  const gameKickoffInput = seasonPage.document.getElementById("game-kickoff");
  const createGameButton = seasonPage.document.querySelector('[data-action="create-game"]');
  assert(gameDateInput instanceof seasonPage.window.HTMLInputElement);
  assert(gameKickoffInput instanceof seasonPage.window.HTMLInputElement);
  assert(createGameButton instanceof seasonPage.window.HTMLButtonElement);

  gameDateInput.value = "2026-03-28";
  gameDateInput.dispatchEvent(new seasonPage.window.Event("change", { bubbles: true }));
  gameKickoffInput.value = "2026-03-28T10:00";
  gameKickoffInput.dispatchEvent(new seasonPage.window.Event("change", { bubbles: true }));
  dispatchClick(createGameButton);
  await flushAsync();

  assert.equal(apiState.sessions.size, 0);
  assert.equal(apiState.games.size, 0);
  assert.equal(seasonPage.navigations.length, 0);
  assert.equal(seasonPage.document.getElementById("setup-status")?.textContent, "Game creation failed.");
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
  assert.deepEqual(apiState.seasonDeleteRequests, [
    {
      path: "/v1/leagues/three-sided-football-club/seasons/autumn-cup",
      leagueId: "three-sided-football-club",
      seasonId: "autumn-cup",
    },
  ]);
  assert.equal(page.navigations.at(-1)?.url, "/leagues/three-sided-football-club");
});

test("season page delete does not fall back to legacy API during site-first scoped rollout", async () => {
  const apiState = createMockApiState();
  apiState.disableScopedSeasonApi = true;
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
    html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup",
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

  assert.equal(apiState.seasons.has("autumn-cup"), true);
  assert.deepEqual(apiState.seasonDeleteRequests, []);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.document.getElementById("setup-status")?.textContent, "Season deletion failed.");
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
    joinCode: "JOIN0001",
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
  const playerPool = gamePage.document.getElementById("player-pool");
  const rosterTeams = gamePage.document.getElementById("roster-teams");
  const scoringTeamInput = gamePage.document.getElementById("goal-scoring-team");
  const concedingTeamInput = gamePage.document.getElementById("goal-conceding-team");
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
  assert(playerPool instanceof gamePage.window.HTMLElement);
  assert(rosterTeams instanceof gamePage.window.HTMLElement);
  assert(scoringTeamInput instanceof gamePage.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof gamePage.window.HTMLSelectElement);
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
  assert.doesNotMatch(playerPool.textContent ?? "", /Assigned to/);
  const activeRedChip = playerPool.querySelector(
    `[data-ui="team-chip"][data-player-id="${createdPlayer.playerId}"][data-team-id="red"]`,
  );
  assert(activeRedChip instanceof gamePage.window.HTMLButtonElement);
  assert.equal(activeRedChip.getAttribute("aria-pressed"), "true");
  assert.match(activeRedChip.getAttribute("style") ?? "", /--team-color: #d83b36/);
  assert(activeRedChip.querySelector('[data-icon="circle-check"]'));
  assert.equal(scoringTeamInput.value, "");
  assert.equal(concedingTeamInput.value, "");
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.value, "");
  assert.equal(scorerInput.disabled, true);
  assert.equal(scorerInput.textContent, "Assign players first");
  assert.equal(saveGoalButton.disabled, true);
  assert.match(goalFormNote.textContent ?? "", /Choose a scoring team/);

  const redRoster = rosterTeams.querySelector('[data-ui="roster-team"][data-team-id="red"]');
  let transferButton = redRoster?.querySelector(
    `[data-action="toggle-transfer"][data-player-id="${createdPlayer.playerId}"]`,
  );
  assert(transferButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(transferButton.getAttribute("aria-label"), "Transfer Ari");
  const transferIcon = transferButton.querySelector('[data-icon="arrow-left-right"]');
  assert(transferIcon instanceof gamePage.window.HTMLElement);
  dispatchClick(transferIcon);

  let transferMenu = gamePage.document.getElementById(`transfer-options-${createdPlayer.playerId}`);
  assert(transferMenu instanceof gamePage.window.HTMLElement);
  assert.equal(transferMenu.hidden, false);
  assert.match(transferMenu.textContent ?? "", /Blue/);
  assert.match(transferMenu.textContent ?? "", /Yellow/);
  assert.doesNotMatch(transferMenu.textContent ?? "", /Red/);
  assert.equal(
    transferMenu.querySelector('[data-team-id="blue"]')?.getAttribute("aria-label"),
    "Transfer Ari to Blue",
  );
  assert.equal(gamePage.document.activeElement?.getAttribute("data-team-id"), "blue");

  transferMenu.dispatchEvent(
    new gamePage.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  transferButton = rosterTeams.querySelector(
    `[data-action="toggle-transfer"][data-player-id="${createdPlayer.playerId}"]`,
  );
  assert(transferButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(transferButton.getAttribute("aria-expanded"), "false");
  assert.equal(gamePage.document.activeElement, transferButton);

  dispatchClick(transferButton);
  transferMenu = gamePage.document.getElementById(`transfer-options-${createdPlayer.playerId}`);
  const transferBlue = transferMenu?.querySelector('[data-action="assign-player"][data-team-id="blue"]');
  assert(transferBlue instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(transferBlue);
  await flushAsync();

  assert.equal(apiState.roster.get(`game-1:${createdPlayer.playerId}`)?.teamId, "blue");
  const blueTransferButton = rosterTeams.querySelector(
    `[data-ui="roster-team"][data-team-id="blue"] [data-action="toggle-transfer"][data-player-id="${createdPlayer.playerId}"]`,
  );
  assert(blueTransferButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(blueTransferButton.getAttribute("aria-expanded"), "false");
  assert.equal(gamePage.document.activeElement, blueTransferButton);
  dispatchClick(blueTransferButton);
  const returnRed = gamePage.document
    .getElementById(`transfer-options-${createdPlayer.playerId}`)
    ?.querySelector('[data-action="assign-player"][data-team-id="red"]');
  assert(returnRed instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(returnRed);
  await flushAsync();
  assert.equal(apiState.roster.get(`game-1:${createdPlayer.playerId}`)?.teamId, "red");

  scoringTeamInput.value = "red";
  scoringTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = createdPlayer.playerId;
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  dispatchClick(startThirdButton);
  await flushAsync();
  assert.equal(apiState.games.get("game-1")?.thirds[1].startedAt, "2026-03-28T11:00:10.000Z");
  assert.equal(saveGoalButton.disabled, false);
  assert.match(goalFormNote.textContent ?? "", /third 2/);
});

test("game roster transfer remains open after assignment failure", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, {
    gameId: "game-transfer-failure",
    role: "admin",
    sessionEmail: "organizer@3fc.football",
  });
  const transferFailureGame = apiState.games.get("game-transfer-failure");
  assert(transferFailureGame);
  ensureGameTeams(apiState, transferFailureGame);
  const malformedRedTeam = apiState.gameTeams.get("game-transfer-failure:red");
  assert(malformedRedTeam);
  apiState.gameTeams.set("game-transfer-failure:red", {
    ...malformedRedTeam,
    color: "#12345",
  });
  apiState.players.set("player one", {
    playerId: "player one",
    nickname: "Player One",
    claimedByUserId: null,
    createdAt: "2026-03-28T11:00:09.000Z",
    updatedAt: "2026-03-28T11:00:09.000Z",
  });
  apiState.gamePlayers.set("game-transfer-failure:player one", {
    gameId: "game-transfer-failure",
    playerId: "player one",
    createdAt: "2026-03-28T11:00:09.000Z",
    updatedAt: "2026-03-28T11:00:09.000Z",
  });
  apiState.roster.set("game-transfer-failure:player one", {
    gameId: "game-transfer-failure",
    playerId: "player one",
    teamId: "yellow",
    createdAt: "2026-03-28T11:00:09.000Z",
    updatedAt: "2026-03-28T11:00:09.000Z",
  });
  const defaultFetch = createMockFetch(apiState);
  const failingTransferFetch: typeof fetch = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    if (
      (init.method ?? "GET").toUpperCase() === "PUT" &&
      target.pathname === "/v1/games/game-transfer-failure/roster/player-ari"
    ) {
      return createJsonResponse(503, {
        error: "unavailable",
        message: "Roster service unavailable.",
      });
    }
    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-transfer-failure" }),
    url: "http://localhost:3000/games/game-transfer-failure",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: failingTransferFetch,
  });

  const transferButton = page.document.querySelector(
    '[data-ui="roster-team"][data-team-id="red"] [data-action="toggle-transfer"][data-player-id="player-ari"]',
  );
  const unclaimedBadge = page.document.querySelector(
    '[data-ui="claim-badge"][data-state="unclaimed"]',
  );
  const malformedRedRoster = page.document.querySelector(
    '[data-ui="roster-team"][data-team-id="red"]',
  );
  const malformedRedChip = page.document.querySelector(
    '[data-ui="team-chip"][data-player-id="player-ari"][data-team-id="red"]',
  );
  const validBlueRoster = page.document.querySelector(
    '[data-ui="roster-team"][data-team-id="blue"]',
  );
  const spacedIdTransfer = page.document.querySelector(
    '[data-action="toggle-transfer"][data-player-id="player one"]',
  );
  assert(transferButton instanceof page.window.HTMLButtonElement);
  assert(unclaimedBadge instanceof page.window.HTMLElement);
  assert(malformedRedRoster instanceof page.window.HTMLElement);
  assert(malformedRedChip instanceof page.window.HTMLButtonElement);
  assert(validBlueRoster instanceof page.window.HTMLElement);
  assert(spacedIdTransfer instanceof page.window.HTMLButtonElement);
  assert.equal(malformedRedRoster.hasAttribute("style"), false);
  assert.equal(malformedRedChip.hasAttribute("style"), false);
  assert.match(validBlueRoster.getAttribute("style") ?? "", /--team-color: #2364d2/);
  assert.equal(spacedIdTransfer.getAttribute("aria-controls"), "transfer-options-player%20one");
  assert(page.document.getElementById("transfer-options-player%20one"));
  assert.equal(unclaimedBadge.getAttribute("aria-label"), "Not claimed");
  assert(unclaimedBadge.querySelector('[data-icon="circle-user-round"]'));
  assert.doesNotMatch(page.document.getElementById("player-pool")?.textContent ?? "", /Not claimed/);
  dispatchClick(transferButton);
  let menu = page.document.getElementById("transfer-options-player-ari");
  const beaTransferButton = page.document.querySelector(
    '[data-ui="roster-team"][data-team-id="red"] [data-action="toggle-transfer"][data-player-id="player-bea"]',
  );
  assert(beaTransferButton instanceof page.window.HTMLButtonElement);
  dispatchClick(beaTransferButton);
  assert.equal(page.document.getElementById("transfer-options-player-ari")?.hidden, true);
  assert.equal(page.document.getElementById("transfer-options-player-bea")?.hidden, false);
  page.document
    .getElementById("transfer-options-player-bea")
    ?.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const currentAriTransferButton = page.document.querySelector(
    '[data-action="toggle-transfer"][data-player-id="player-ari"]',
  );
  assert(currentAriTransferButton instanceof page.window.HTMLButtonElement);
  dispatchClick(currentAriTransferButton);
  menu = page.document.getElementById("transfer-options-player-ari");
  const blueOption = menu?.querySelector('[data-action="assign-player"][data-team-id="blue"]');
  assert(menu instanceof page.window.HTMLElement);
  assert(blueOption instanceof page.window.HTMLButtonElement);
  dispatchClick(blueOption);
  blueOption.blur();
  await flushAsync();

  assert.equal(apiState.roster.get("game-transfer-failure:player-ari")?.teamId, "red");
  assert.equal(menu.hidden, false);
  assert.equal(
    page.document
      .querySelector('[data-action="toggle-transfer"][data-player-id="player-ari"]')
      ?.getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(page.document.activeElement, blueOption);
  assert.equal(page.document.getElementById("setup-status")?.textContent, "Roster assignment failed.");
});

test("game roster reconciles a committed transfer when refresh fails", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, {
    gameId: "game-transfer-refresh-failure",
    role: "admin",
    sessionEmail: "organizer@3fc.football",
  });
  const defaultFetch = createMockFetch(apiState);
  let assignmentCommitted = false;
  let resolveRosterRefresh: ((response: Response) => void) | undefined;
  const refreshFailureFetch: typeof fetch = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (
      method === "PUT" &&
      target.pathname === "/v1/games/game-transfer-refresh-failure/roster/player-ari"
    ) {
      const response = await defaultFetch(input, init);
      assignmentCommitted = true;
      return response;
    }
    if (
      assignmentCommitted &&
      method === "GET" &&
      target.pathname === "/v1/games/game-transfer-refresh-failure/roster"
    ) {
      return new Promise<Response>((resolve) => {
        resolveRosterRefresh = resolve;
      });
    }
    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-transfer-refresh-failure" }),
    url: "http://localhost:3000/games/game-transfer-refresh-failure",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: refreshFailureFetch,
  });

  const transferButton = page.document.querySelector(
    '[data-ui="roster-team"][data-team-id="red"] [data-action="toggle-transfer"][data-player-id="player-ari"]',
  );
  assert(transferButton instanceof page.window.HTMLButtonElement);
  dispatchClick(transferButton);
  const blueOption = page.document
    .getElementById("transfer-options-player-ari")
    ?.querySelector('[data-action="assign-player"][data-team-id="blue"]');
  assert(blueOption instanceof page.window.HTMLButtonElement);
  dispatchClick(blueOption);
  await flushAsync();

  assert.equal(assignmentCommitted, true);
  assert.equal(apiState.roster.get("game-transfer-refresh-failure:player-ari")?.teamId, "blue");
  let reconciledTrigger = page.document.querySelector(
    '[data-ui="roster-team"][data-team-id="blue"] [data-action="toggle-transfer"][data-player-id="player-ari"]',
  );
  assert(reconciledTrigger instanceof page.window.HTMLButtonElement);
  assert.equal(reconciledTrigger.getAttribute("aria-expanded"), "false");
  assert.equal(page.document.activeElement, reconciledTrigger);
  assert.equal(page.document.querySelector('[data-ui="transfer-menu"]:not([hidden])'), null);

  assert(resolveRosterRefresh);
  resolveRosterRefresh(createJsonResponse(503, {
    error: "unavailable",
    message: "Roster refresh unavailable.",
  }));
  await flushAsync();

  reconciledTrigger = page.document.querySelector(
    '[data-ui="roster-team"][data-team-id="blue"] [data-action="toggle-transfer"][data-player-id="player-ari"]',
  );
  assert(reconciledTrigger instanceof page.window.HTMLButtonElement);
  assert.equal(page.document.activeElement, reconciledTrigger);
  assert.equal(
    page.document.getElementById("setup-status")?.textContent,
    "Roster assignment saved; roster refresh failed.",
  );
  assert.match(
    page.document.getElementById("setup-error")?.textContent ?? "",
    /Assignment was saved.*Roster refresh unavailable/,
  );
});

test("game page lets league admins promote claimed players to scorers", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, {
    gameId: "game-delegate-scorer",
    role: "admin",
    sessionEmail: "organizer@3fc.football",
  });
  apiState.players.set("player-delegate", {
    playerId: "player-delegate",
    nickname: "Delegate",
    claimedByUserId: "delegate@3fc.football",
    createdAt: "2026-03-28T11:00:09.000Z",
    updatedAt: "2026-03-28T11:00:09.000Z",
  });
  apiState.gamePlayers.set("game-delegate-scorer:player-delegate", {
    gameId: "game-delegate-scorer",
    playerId: "player-delegate",
    createdAt: "2026-03-28T11:00:09.000Z",
    updatedAt: "2026-03-28T11:00:09.000Z",
  });
  apiState.roster.set("game-delegate-scorer:player-delegate", {
    gameId: "game-delegate-scorer",
    playerId: "player-delegate",
    teamId: "yellow",
    createdAt: "2026-03-28T11:00:09.000Z",
    updatedAt: "2026-03-28T11:00:09.000Z",
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-delegate-scorer" }),
    url: "http://localhost:3000/games/game-delegate-scorer",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const playerPool = page.document.getElementById("player-pool");
  const makeScorerButton = page.document.querySelector(
    '[data-action="grant-player-access"][data-player-id="player-delegate"][data-role="scorekeeper"]',
  );
  assert(playerPool instanceof page.window.HTMLElement);
  assert(makeScorerButton instanceof page.window.HTMLButtonElement);
  assert.doesNotMatch(playerPool.textContent ?? "", /delegate@3fc\.football/);
  assert.doesNotMatch(playerPool.innerHTML, /delegate@3fc\.football|data-user-id/);
  assert.equal(
    playerPool.querySelector('[data-ui="claim-badge"][data-state="claimed"]')?.getAttribute("aria-label"),
    "Claimed",
  );

  dispatchClick(makeScorerButton);
  await flushAsync();

  assert.equal(
    apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "delegate@3fc.football")),
    "scorekeeper",
  );
  assert.deepEqual(apiState.lastGrantAccessRequest, {
    leagueId: "three-sided-football-club",
    body: {
      userId: "delegate@3fc.football",
      role: "scorekeeper",
    },
  });
  assert.equal(page.document.getElementById("setup-status")?.textContent, "Player can now score this league's games.");
});

test("game page hides claimed-player emails and access controls from scorekeepers", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, {
    gameId: "game-delegate-hidden",
    role: "scorekeeper",
    sessionEmail: "scorekeeper@3fc.football",
  });
  apiState.players.set("player-delegate", {
    playerId: "player-delegate",
    nickname: "Delegate",
    claimedByUserId: "delegate@3fc.football",
    createdAt: "2026-03-28T11:00:09.000Z",
    updatedAt: "2026-03-28T11:00:09.000Z",
  });
  apiState.gamePlayers.set("game-delegate-hidden:player-delegate", {
    gameId: "game-delegate-hidden",
    playerId: "player-delegate",
    createdAt: "2026-03-28T11:00:09.000Z",
    updatedAt: "2026-03-28T11:00:09.000Z",
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-delegate-hidden" }),
    url: "http://localhost:3000/games/game-delegate-hidden",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const playerPool = page.document.getElementById("player-pool");
  assert(playerPool instanceof page.window.HTMLElement);
  assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
  assert.doesNotMatch(playerPool.textContent ?? "", /delegate@3fc\.football/);
});

test("game page mode panels switch without resetting a goal draft", async () => {
  const apiState = createMockApiState();
  const runningThirds = createDefaultThirdTimerSegments();
  runningThirds[0] = {
    ...runningThirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-mode-draft",
    status: "live",
    thirds: runningThirds,
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-mode-draft" }),
    url: "http://localhost:3000/games/game-mode-draft",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const runMode = page.document.getElementById("game-mode-run");
  const playersMode = page.document.getElementById("game-mode-players");
  const playersTab = page.document.querySelector('[data-action="select-game-mode"][data-game-mode="players"]');
  const runTab = page.document.querySelector('[data-action="select-game-mode"][data-game-mode="run"]');
  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const assistsElement = page.document.getElementById("goal-assists");

  assert(runMode instanceof page.window.HTMLElement);
  assert(playersMode instanceof page.window.HTMLElement);
  assert(playersTab instanceof page.window.HTMLButtonElement);
  assert(runTab instanceof page.window.HTMLButtonElement);
  assert(scoringTeamInput instanceof page.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof page.window.HTMLSelectElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(assistsElement instanceof page.window.HTMLElement);
  assert.equal(runMode.hidden, false);

  scoringTeamInput.value = "red";
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-ari";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  const beaAssist = assistsElement.querySelector('input[value="player-bea"]');
  assert(beaAssist instanceof page.window.HTMLInputElement);
  beaAssist.checked = true;
  beaAssist.dispatchEvent(new page.window.Event("change", { bubbles: true }));

  dispatchClick(playersTab);
  await flushAsync();
  assert.equal(playersMode.hidden, false);
  assert.equal(runMode.hidden, true);

  dispatchClick(runTab);
  await flushAsync();
  assert.equal(runMode.hidden, false);
  assert.equal(scoringTeamInput.value, "red");
  assert.equal(concedingTeamInput.value, "blue");
  assert.equal(scorerInput.value, "player-ari");
  const preservedAssist = assistsElement.querySelector('input[value="player-bea"]');
  assert(preservedAssist instanceof page.window.HTMLInputElement);
  assert.equal(preservedAssist.checked, true);
});

test("game page preserves run mode after live game metadata save", async () => {
  const apiState = createMockApiState();
  const runningThirds = createDefaultThirdTimerSegments();
  runningThirds[0] = {
    ...runningThirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-mode-save-running",
    status: "live",
    thirds: runningThirds,
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-mode-save-running" }),
    url: "http://localhost:3000/games/game-mode-save-running",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const structureMode = page.document.getElementById("game-mode-structure");
  const runMode = page.document.getElementById("game-mode-run");
  const structureTab = page.document.querySelector('[data-action="select-game-mode"][data-game-mode="structure"]');
  const kickoffInput = page.document.getElementById("game-edit-kickoff");
  const saveGameButton = page.document.querySelector('[data-action="save-game"]');

  assert(structureMode instanceof page.window.HTMLElement);
  assert(runMode instanceof page.window.HTMLElement);
  assert(structureTab instanceof page.window.HTMLButtonElement);
  assert(kickoffInput instanceof page.window.HTMLInputElement);
  assert(saveGameButton instanceof page.window.HTMLButtonElement);
  assert.equal(runMode.hidden, false);

  dispatchClick(structureTab);
  await flushAsync();
  assert.equal(structureMode.hidden, false);
  assert.equal(runMode.hidden, true);

  kickoffInput.value = "2026-03-28T10:30";
  kickoffInput.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  dispatchClick(saveGameButton);
  await flushAsync();

  assert.equal(apiState.games.get("game-mode-save-running")?.gameStartTs, new Date("2026-03-28T10:30").toISOString());
  assert.equal(structureMode.hidden, true);
  assert.equal(runMode.hidden, false);
});

test("game page mode panels advance from setup to run and finalisation", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, {
    gameId: "game-mode-advance",
  });
  apiState.roster.clear();

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-mode-advance" }),
    url: "http://localhost:3000/games/game-mode-advance",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const structureMode = page.document.getElementById("game-mode-structure");
  const playersMode = page.document.getElementById("game-mode-players");
  const runMode = page.document.getElementById("game-mode-run");
  const finalMode = page.document.getElementById("game-mode-final");
  const playersTab = page.document.querySelector('[data-action="select-game-mode"][data-game-mode="players"]');
  const runTab = page.document.querySelector('[data-action="select-game-mode"][data-game-mode="run"]');
  const gameStateTab = page.document.querySelector('[data-testid="game-mode-final-tab"]');
  const startThirdButton = page.document.querySelector('[data-action="start-active-third"]');
  const finishThirdButton = page.document.querySelector('[data-action="finish-active-third"]');
  const finishGameButton = page.document.querySelector('[data-action="finish-game"]');
  const timerDisplay = page.document.getElementById("timer-display");
  const resultSummary = page.document.getElementById("game-result-summary");
  const finalStatus = page.document.getElementById("final-game-status");
  const thirdStatusList = page.document.getElementById("third-status-list");

  assert(structureMode instanceof page.window.HTMLElement);
  assert(playersMode instanceof page.window.HTMLElement);
  assert(runMode instanceof page.window.HTMLElement);
  assert(finalMode instanceof page.window.HTMLElement);
  assert(playersTab instanceof page.window.HTMLButtonElement);
  assert(runTab instanceof page.window.HTMLButtonElement);
  assert(gameStateTab instanceof page.window.HTMLButtonElement);
  assert(startThirdButton instanceof page.window.HTMLButtonElement);
  assert(finishThirdButton instanceof page.window.HTMLButtonElement);
  assert(finishGameButton instanceof page.window.HTMLButtonElement);
  assert(timerDisplay instanceof page.window.HTMLElement);
  assert(resultSummary instanceof page.window.HTMLElement);
  assert(finalStatus instanceof page.window.HTMLElement);
  assert(thirdStatusList instanceof page.window.HTMLElement);
  assert.equal(structureMode.hidden, false);
  assert.equal(playersMode.hidden, true);
  assert.match(gameStateTab.textContent ?? "", /Pregame/);
  assert.match(gameStateTab.textContent ?? "", /Start clock/);
  assert.equal(gameStateTab.getAttribute("role"), null);
  assert.equal(gameStateTab.getAttribute("aria-controls"), null);
  assert.equal(gameStateTab.getAttribute("aria-pressed"), "false");
  assert.equal(gameStateTab.getAttribute("data-game-state"), "pregame");

  dispatchClick(gameStateTab);
  await flushAsync();
  assert.equal(runMode.hidden, false);
  assert.equal(runTab.getAttribute("aria-pressed"), "true");
  assert.equal(gameStateTab.getAttribute("aria-pressed"), "false");
  assert.equal(page.document.activeElement, startThirdButton);

  dispatchClick(playersTab);
  await flushAsync();
  assert.equal(structureMode.hidden, true);
  assert.equal(playersMode.hidden, false);

  dispatchClick(runTab);
  await flushAsync();
  assert.equal(runMode.hidden, false);

  dispatchClick(startThirdButton);
  await flushAsync();
  assert.equal(runMode.hidden, false);
  assert.equal(finalStatus.textContent, "Live");
  assert.match(gameStateTab.textContent ?? "", /Third 1/);
  assert.equal(gameStateTab.getAttribute("data-game-state"), "running");

  dispatchClick(gameStateTab);
  await flushAsync();
  assert.equal(runMode.hidden, false);
  assert.equal(page.document.activeElement, timerDisplay);

  dispatchClick(finishThirdButton);
  await flushAsync();
  assert.match(thirdStatusList.textContent ?? "", new RegExp(expectedLocalTimestamp("2026-03-28T11:00:11.000Z")));
  assert.doesNotMatch(thirdStatusList.textContent ?? "", /Z\b|UTC/);
  assert.match(gameStateTab.textContent ?? "", /Break/);
  assert.match(gameStateTab.textContent ?? "", /Start T2/);
  assert.equal(gameStateTab.getAttribute("data-game-state"), "break");

  dispatchClick(gameStateTab);
  await flushAsync();
  assert.equal(runMode.hidden, false);
  assert.equal(page.document.activeElement, startThirdButton);

  dispatchClick(startThirdButton);
  await flushAsync();
  dispatchClick(finishThirdButton);
  await flushAsync();
  dispatchClick(startThirdButton);
  await flushAsync();
  dispatchClick(finishThirdButton);
  await flushAsync();

  assert.equal(finalMode.hidden, false);
  assert.equal(finalStatus.textContent, "Live");
  assert.match(gameStateTab.textContent ?? "", /Final/);
  assert.match(gameStateTab.textContent ?? "", /Finish game/);
  assert.equal(gameStateTab.getAttribute("data-game-state"), "ready");
  assert.equal(gameStateTab.getAttribute("aria-pressed"), "true");
  assert.equal(finishGameButton.disabled, false);

  dispatchClick(gameStateTab);
  await flushAsync();
  assert.equal(finalMode.hidden, false);
  assert.equal(page.document.activeElement, finishGameButton);

  dispatchClick(finishGameButton);
  await flushAsync();

  assert.equal(apiState.games.get("game-mode-advance")?.status, "finished");
  assert.equal(finalMode.hidden, false);
  assert.match(gameStateTab.textContent ?? "", /Summary/);
  assert.equal(gameStateTab.getAttribute("data-game-state"), "finished");
  assert.equal(resultSummary.hidden, false);
  assert.match(resultSummary.textContent ?? "", /Draw/);
});

test("game page keeps delete locked while a finished game is loading", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, {
    gameId: "game-finished-loading",
    status: "finished",
    role: "admin",
    sessionEmail: "organizer@3fc.football",
  });
  const defaultFetch = createMockFetch(apiState);
  let resolveGameResponse: (response: Response) => void = () => undefined;
  const delayedGameResponse = new Promise<Response>((resolve) => {
    resolveGameResponse = resolve;
  });
  let delayInitialGameRequest = true;
  let deleteRequests = 0;
  const delayedGameFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "DELETE" && target.pathname === "/v1/games/game-finished-loading") {
      deleteRequests += 1;
    }
    if (
      delayInitialGameRequest &&
      method === "GET" &&
      target.pathname === "/v1/games/game-finished-loading"
    ) {
      delayInitialGameRequest = false;
      return delayedGameResponse;
    }
    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-finished-loading" }),
    url: "http://localhost:3000/games/game-finished-loading",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: delayedGameFetch,
    flushOnBoot: false,
  });
  const deleteButton = page.document.querySelector('[data-action="delete-game"]');
  const deleteReason = page.document.getElementById("game-delete-lock-reason");
  assert(deleteButton instanceof page.window.HTMLButtonElement);
  assert(deleteReason instanceof page.window.HTMLElement);
  assert.equal(deleteButton.disabled, true);
  assert.equal(deleteReason.hidden, true);
  dispatchClick(deleteButton);
  assert.equal(deleteRequests, 0);

  const game = apiState.games.get("game-finished-loading");
  assert(game);
  resolveGameResponse(createJsonResponse(200, game));
  await flushAsync();

  assert.equal(deleteButton.disabled, false);
  assert.equal(deleteButton.getAttribute("aria-disabled"), "true");
  assert.equal(deleteReason.hidden, false);
  deleteButton.focus();
  assert.equal(page.document.activeElement, deleteButton);
  dispatchClick(deleteButton);
  assert.equal(deleteRequests, 0);
  assert.equal(page.document.getElementById("setup-status")?.textContent, "Finished games are locked.");
});

test("game page retries early game-state tab selection after initial game loading", async () => {
  const apiState = createMockApiState();
  const runningThirds = createDefaultThirdTimerSegments();
  runningThirds[0] = {
    ...runningThirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-state-loading",
    status: "live",
    thirds: runningThirds,
  });

  const defaultFetch = createMockFetch(apiState);
  let resolveGameResponse: (response: Response) => void = () => undefined;
  const delayedGameResponse = new Promise<Response>((resolve) => {
    resolveGameResponse = resolve;
  });
  let delayInitialGameRequest = true;
  const delayedGameFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (delayInitialGameRequest && method === "GET" && target.pathname === "/v1/games/game-state-loading") {
      delayInitialGameRequest = false;
      return delayedGameResponse;
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-state-loading" }),
    url: "http://localhost:3000/games/game-state-loading",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: delayedGameFetch,
    flushOnBoot: false,
  });

  const structureMode = page.document.getElementById("game-mode-structure");
  const runMode = page.document.getElementById("game-mode-run");
  const gameStateTab = page.document.querySelector('[data-testid="game-mode-final-tab"]');

  assert(structureMode instanceof page.window.HTMLElement);
  assert(runMode instanceof page.window.HTMLElement);
  assert(gameStateTab instanceof page.window.HTMLButtonElement);

  dispatchClick(gameStateTab);
  await flushAsync();
  assert.equal(structureMode.hidden, false);
  assert.equal(runMode.hidden, true);
  assert.equal(gameStateTab.getAttribute("data-game-state"), "loading");

  const game = apiState.games.get("game-state-loading");
  assert(game);
  resolveGameResponse(createJsonResponse(200, game));
  await flushAsync();

  assert.equal(structureMode.hidden, true);
  assert.equal(runMode.hidden, false);
  assert.equal(gameStateTab.getAttribute("data-game-state"), "running");
});

test("game page resumes completed live timers in finalisation mode", async () => {
  const apiState = createMockApiState();
  const completeThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:0${third.third}:00.000Z`,
    finishedAt: `2026-03-28T11:1${third.third}:00.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-mode-complete",
    status: "live",
    thirds: completeThirds,
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-mode-complete" }),
    url: "http://localhost:3000/games/game-mode-complete",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const runMode = page.document.getElementById("game-mode-run");
  const finalMode = page.document.getElementById("game-mode-final");
  const finishGameButton = page.document.querySelector('[data-action="finish-game"]');
  const finalStatus = page.document.getElementById("final-game-status");

  assert(runMode instanceof page.window.HTMLElement);
  assert(finalMode instanceof page.window.HTMLElement);
  assert(finishGameButton instanceof page.window.HTMLButtonElement);
  assert(finalStatus instanceof page.window.HTMLElement);
  assert.equal(runMode.hidden, true);
  assert.equal(finalMode.hidden, false);
  assert.equal(finishGameButton.disabled, false);
  assert.equal(finalStatus.textContent, "Live");
  assert.equal(page.document.getElementById("final-game-id-value"), null);
  assert.equal(page.document.getElementById("final-game-readiness"), null);
});

test("game page renders final team logs and aggregate player stats", async () => {
  const apiState = createMockApiState();
  const completeThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:0${third.third}:00.000Z`,
    finishedAt: `2026-03-28T11:1${third.third}:00.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-final-stats",
    status: "finished",
    thirds: completeThirds,
  });

  const goals: MockGoalEvent[] = [
    {
      gameId: "game-final-stats",
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
    },
    {
      gameId: "game-final-stats",
      eventId: "goal-2",
      third: 2,
      thirdMinute: 18,
      gameMinute: 43,
      elapsedSeconds: 1080,
      stoppageMinute: null,
      displayTime: "18:00",
      scoringTeamId: "blue",
      concedingTeamId: "yellow",
      scorerPlayerId: "player-cy",
      assistPlayerIds: [],
      ownGoal: false,
      createdAt: "2026-03-28T11:01:02.000Z",
      updatedAt: "2026-03-28T11:01:02.000Z",
    },
    {
      gameId: "game-final-stats",
      eventId: "goal-3",
      third: 3,
      thirdMinute: 25,
      gameMinute: 25,
      elapsedSeconds: 1680,
      stoppageMinute: 3,
      displayTime: "25+03",
      scoringTeamId: null,
      concedingTeamId: "red",
      scorerPlayerId: "player-bea",
      assistPlayerIds: [],
      ownGoal: true,
      createdAt: "2026-03-28T11:01:03.000Z",
      updatedAt: "2026-03-28T11:01:03.000Z",
    },
  ];
  for (const goal of goals) {
    apiState.goalEvents.set(goal.eventId, goal);
  }

  const seededGame = apiState.games.get("game-final-stats");
  assert(seededGame);
  seededGame.thirdLengthMinutes = 25;
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:02:00.000Z");

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-final-stats" }),
    url: "http://localhost:3000/games/game-final-stats",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const resultSummary = page.document.getElementById("game-result-summary");
  const redTeamLog = page.document.querySelector('[data-testid="final-team-log-red"]');
  const scorerStats = page.document.querySelector('[data-testid="final-scorer-stats"]');
  const assistStats = page.document.querySelector('[data-testid="final-assist-stats"]');
  const ownGoalStats = page.document.querySelector('[data-testid="final-own-goal-stats"]');
  const fullGoalLog = page.document.querySelector('[data-testid="final-full-goal-log"]');

  assert(resultSummary instanceof page.window.HTMLElement);
  assert(redTeamLog instanceof page.window.HTMLElement);
  assert(scorerStats instanceof page.window.HTMLElement);
  assert(assistStats instanceof page.window.HTMLElement);
  assert(ownGoalStats instanceof page.window.HTMLElement);
  assert(fullGoalLog instanceof page.window.HTMLElement);
  assert.equal(resultSummary.hidden, false);
  assert.doesNotMatch(resultSummary.textContent ?? "", /Computed|2026-03-28 22:02|Z\b|UTC/);
  assert.match(redTeamLog.textContent ?? "", /Ari/);
  assert.match(redTeamLog.textContent ?? "", /1"/);
  assert.match(redTeamLog.textContent ?? "", /Assisted by Bea/);
  assert.match(redTeamLog.textContent ?? "", /Bea own goal/);
  assert.match(redTeamLog.textContent ?? "", /75\+3"/);
  assert.match(redTeamLog.textContent ?? "", /Conceded-only own goal/);
  assert.match(scorerStats.textContent ?? "", /Ari\s*1/);
  assert.match(scorerStats.textContent ?? "", /Cy\s*1/);
  assert.match(assistStats.textContent ?? "", /Bea\s*1/);
  assert.match(ownGoalStats.textContent ?? "", /Bea\s*1/);
  assert.equal(fullGoalLog.querySelectorAll('[data-ui="final-goal-item"]').length, 3);
  assert.match(fullGoalLog.textContent ?? "", /43"/);
  assert.doesNotMatch(fullGoalLog.textContent ?? "", /Third [123]/);
  assert.equal(fullGoalLog.querySelectorAll('[data-ui="third-indicator"]').length, 3);
  assert(
    fullGoalLog.querySelector('[data-ui="third-indicator"][data-third="2"][aria-label="Third 2 of 3"]'),
  );
  assert(
    fullGoalLog.querySelector('[data-ui="third-indicator"][data-third="1"][aria-label="Third 1 of 3"]'),
  );
  assert(
    fullGoalLog.querySelector('[data-ui="third-indicator"][data-third="3"][aria-label="Third 3 of 3"]'),
  );
  assert.equal(
    fullGoalLog.querySelector('[data-event-id="goal-1"] [data-ui="goal-team-semantics"]')?.textContent,
    "Scoring team: Red. Conceding team: Blue.",
  );
  assert.equal(
    fullGoalLog.querySelector('[data-event-id="goal-3"] [data-ui="goal-team-semantics"]')?.textContent,
    "Own goal. No scoring team. Conceding team: Red.",
  );
});

test("game page converts partial goal times into full-match football notation", async () => {
  const apiState = createMockApiState();
  const completeThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:0${third.third}:00.000Z`,
    finishedAt: `2026-03-28T11:1${third.third}:00.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-football-time-format",
    status: "finished",
    thirds: completeThirds,
  });

  const seededGame = apiState.games.get("game-football-time-format");
  assert(seededGame);
  seededGame.thirdLengthMinutes = 25;

  apiState.goalEvents.set("goal-partial-second-third", {
    gameId: "game-football-time-format",
    eventId: "goal-partial-second-third",
    third: 2,
    thirdMinute: 18,
    gameMinute: 0,
    elapsedSeconds: 0,
    stoppageMinute: null,
    displayTime: "18:00",
    scoringTeamId: "blue",
    concedingTeamId: "yellow",
    scorerPlayerId: "player-cy",
    assistPlayerIds: [],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  });
  apiState.goalEvents.set("goal-partial-stoppage", {
    gameId: "game-football-time-format",
    eventId: "goal-partial-stoppage",
    third: 3,
    thirdMinute: 25,
    gameMinute: 0,
    elapsedSeconds: 1680,
    stoppageMinute: 3,
    displayTime: "25+03",
    scoringTeamId: null,
    concedingTeamId: "red",
    scorerPlayerId: "player-bea",
    assistPlayerIds: [],
    ownGoal: true,
    createdAt: "2026-03-28T11:01:02.000Z",
    updatedAt: "2026-03-28T11:01:02.000Z",
  });
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:02:00.000Z");

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-football-time-format" }),
    url: "http://localhost:3000/games/game-football-time-format",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const resultSummary = page.document.getElementById("game-result-summary");
  const fullGoalLog = page.document.querySelector('[data-testid="final-full-goal-log"]');
  const timeline = page.document.getElementById("goal-timeline");

  assert(resultSummary instanceof page.window.HTMLElement);
  assert(fullGoalLog instanceof page.window.HTMLElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert.equal(resultSummary.hidden, false);
  assert.match(resultSummary.textContent ?? "", /43"/);
  assert.match(resultSummary.textContent ?? "", /75\+3"/);
  assert.match(fullGoalLog.textContent ?? "", /43"/);
  assert.match(fullGoalLog.textContent ?? "", /75\+3"/);
  const latestGoal = timeline.querySelector('[data-ui="goal-event"][data-state="latest"]');
  assert(latestGoal instanceof page.window.HTMLElement);
  assert.match(latestGoal.textContent ?? "", /75\+3"\s*Bea\s*OG\s*→\s*Red/);
  assert.equal(latestGoal.querySelectorAll('[data-ui="goal-team-chip"]').length, 1);
  assert(latestGoal.querySelector('[data-ui="goal-team-chip"][data-team-id="red"]'));
  assert(latestGoal.querySelector('[data-ui="third-indicator"][data-third="3"][aria-label="Third 3 of 3"]'));
  assert.doesNotMatch(resultSummary.textContent ?? "", /18:00|25\+03|UTC|Z\b/);
});

test("game page remains usable when goal timeline load fails", async () => {
  const apiState = createMockApiState();
  const completeThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:0${third.third}:00.000Z`,
    finishedAt: `2026-03-28T11:1${third.third}:00.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-goals-fail",
    status: "finished",
    thirds: completeThirds,
    role: "admin",
  });
  apiState.goalEvents.set("goal-unavailable-1", {
    gameId: "game-goals-fail",
    eventId: "goal-unavailable-1",
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
    createdAt: "2026-03-28T11:01:00.000Z",
    updatedAt: "2026-03-28T11:01:00.000Z",
  });
  const seededGame = apiState.games.get("game-goals-fail");
  assert(seededGame);
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:02:00.000Z");

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
  const resultSummary = page.document.getElementById("game-result-summary");
  const goalSummaryUnavailable = page.document.querySelector('[data-testid="final-goal-summary-unavailable"]');
  const quickCreateButton = page.document.querySelector('[data-action="quick-create-player"]');

  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);
  assert(rosterTeams instanceof page.window.HTMLElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert(resultSummary instanceof page.window.HTMLElement);
  assert(goalSummaryUnavailable instanceof page.window.HTMLElement);
  assert(quickCreateButton instanceof page.window.HTMLButtonElement);
  assert.equal(status.textContent, "Could not load goal timeline.");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "Goal feed unavailable.");
  assert.match(rosterTeams.textContent ?? "", /Red/);
  assert.match(timeline.textContent ?? "", /Goal timeline unavailable/);
  assert.equal(resultSummary.hidden, false);
  assert.match(resultSummary.textContent ?? "", /Red win/);
  assert.match(resultSummary.textContent ?? "", /Goal summaries unavailable/);
  assert.doesNotMatch(resultSummary.textContent ?? "", /No goals recorded|No scorers recorded/);
  assert.equal(page.document.querySelector('[data-testid="final-full-goal-log"]'), null);
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
  const beaAssist = page.document.querySelector('#goal-assists input[value="player-bea"]');
  assert(beaAssist instanceof page.window.HTMLInputElement);
  beaAssist.checked = true;
  beaAssist.dispatchEvent(new page.window.Event("change", { bubbles: true }));

  dispatchClick(saveGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.size, 0);
  assert.equal(scoringTeamInput.value, "red");
  assert.equal(concedingTeamInput.value, "blue");
  assert.equal(scorerInput.value, "player-ari");
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 1);

  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 1);
  assert.equal(createGoalIdempotencyKeys.length, 2);
  assert.ok(createGoalIdempotencyKeys[0]);
  assert.equal(createGoalIdempotencyKeys[0], createGoalIdempotencyKeys[1]);
  assert.equal(scoringTeamInput.value, "");
  assert.equal(concedingTeamInput.value, "");
  assert.equal(scorerInput.value, "");
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.disabled, true);
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 0);
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
  const ownGoalInput = page.document.getElementById("goal-own-goal");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert(ownGoalInput instanceof page.window.HTMLInputElement);
  assert(concedingTeamInput instanceof page.window.HTMLSelectElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);

  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(editGoalButton);
  await flushAsync();
  ownGoalInput.checked = true;
  ownGoalInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();
  assert.equal(ownGoalInput.checked, true);
  assert.equal(concedingTeamInput.value, "blue");
  assert.equal(scorerInput.value, "player-cy");
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(updateKeys.length, 2);
  assert.ok(updateKeys[0]);
  assert.equal(updateKeys[0], updateKeys[1]);
  assert.equal(apiState.goalEvents.get("goal-1")?.ownGoal, true);

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

  assert.equal(scorerSelect.value, "");
  assert.equal(scorerSelect.disabled, false);
  assert.match(scorerSelect.textContent ?? "", /Cy/);
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
  assert.match(timeline.textContent ?? "", /Cy\s*Blue\s*→\s*Red/);
});

test("game page invalidates current goals when correction replay refresh fails", async () => {
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
  const undoLastGoalButton = page.document.querySelector('[data-action="undo-last-goal"]');
  const timeline = page.document.getElementById("goal-timeline");
  const status = page.document.getElementById("setup-status");
  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert(scoringTeamInput instanceof page.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof page.window.HTMLSelectElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert.match(timeline.textContent ?? "", /Cy\s*Blue\s*→\s*Red/);

  dispatchClick(editGoalButton);
  await flushAsync();
  dispatchClick(saveGoalButton);
  await flushAsync();
  await flushAsync();

  assert.match(status.textContent ?? "", /Goal updated; timeline refresh failed/);
  assert.match(timeline.textContent ?? "", /Goal timeline unavailable/);
  assert.doesNotMatch(timeline.textContent ?? "", /Cy\s*Blue\s*→\s*Red/);
  assert.equal(scoringTeamInput.value, "");
  assert.equal(concedingTeamInput.value, "");
  assert.equal(scorerInput.value, "");
  assert.equal(saveGoalButton.disabled, true);
  assert.equal(undoLastGoalButton.disabled, true);
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
          color: "url(javascript:alert(1))",
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
  assert.equal(
    resultSummary.querySelector('[data-ui="result-team"][data-team-id="red"]')?.hasAttribute("style"),
    false,
  );
  assert.doesNotMatch(resultSummary.innerHTML, /javascript:/);
});

test("game page renders malformed goal identity values without crashing", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
    finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-malformed-goal",
    status: "finished",
    thirds,
  });
  const seededGame = apiState.games.get("game-malformed-goal");
  assert(seededGame);
  ensureGameTeams(apiState, seededGame);
  const malformedRedTeam = apiState.gameTeams.get("game-malformed-goal:red");
  assert(malformedRedTeam);
  malformedRedTeam.name = 123 as unknown as string;
  for (const player of [
    { playerId: "99", nickname: "Valid 99" },
    { playerId: "17", nickname: "Valid 17" },
  ]) {
    apiState.players.set(player.playerId, {
      ...player,
      claimedByUserId: null,
      createdAt: "2026-03-28T11:00:07.000Z",
      updatedAt: "2026-03-28T11:00:07.000Z",
    });
    apiState.gamePlayers.set(`game-malformed-goal:${player.playerId}`, {
      gameId: "game-malformed-goal",
      playerId: player.playerId,
      createdAt: "2026-03-28T11:00:08.000Z",
      updatedAt: "2026-03-28T11:00:08.000Z",
    });
    apiState.roster.set(`game-malformed-goal:${player.playerId}`, {
      gameId: "game-malformed-goal",
      playerId: player.playerId,
      teamId: "red",
      createdAt: "2026-03-28T11:00:08.000Z",
      updatedAt: "2026-03-28T11:00:08.000Z",
    });
  }
  apiState.goalEvents.set("malformed-goal", {
    gameId: "game-malformed-goal",
    eventId: 123,
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 30,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId: "red",
    concedingTeamId: 42,
    scorerPlayerId: 99,
    assistPlayerIds: [17],
    ownGoal: false,
    createdAt: "2026-03-28T11:01:01.000Z",
    updatedAt: "2026-03-28T11:01:01.000Z",
  } as unknown as MockGoalEvent);
  for (const [index, eventId] of ["valid-goal-1", "valid-goal-2"].entries()) {
    apiState.goalEvents.set(eventId, {
      gameId: "game-malformed-goal",
      eventId,
      third: 1,
      thirdMinute: 2 + index,
      gameMinute: 2 + index,
      elapsedSeconds: 60 + index * 30,
      stoppageMinute: null,
      displayTime: `${2 + index}'`,
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "99",
      assistPlayerIds: ["17"],
      ownGoal: false,
      createdAt: `2026-03-28T11:01:0${2 + index}.000Z`,
      updatedAt: `2026-03-28T11:01:0${2 + index}.000Z`,
    });
  }
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:02:00.000Z");

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-malformed-goal" }),
    url: "http://localhost:3000/games/game-malformed-goal",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const goal = page.document.querySelector('[data-ui="goal-event"][data-event-id="123"]');
  const fullGoalLog = page.document.querySelector('[data-testid="final-full-goal-log"]');
  const scorerStats = page.document.querySelector('[data-testid="final-scorer-stats"]');
  const assistStats = page.document.querySelector('[data-testid="final-assist-stats"]');
  assert(goal instanceof page.window.HTMLElement);
  assert(fullGoalLog instanceof page.window.HTMLElement);
  assert(scorerStats instanceof page.window.HTMLElement);
  assert(assistStats instanceof page.window.HTMLElement);
  assert.match(goal.textContent ?? "", /Unknown player \(invalid ID: 99\)\s*red\s*→\s*42/);
  assert.match(goal.textContent ?? "", /Assists: Unknown player \(invalid ID: 17\)/);
  assert(goal.querySelector('[data-ui="goal-team-chip"][data-team-id="red"]'));
  assert(goal.querySelector('[data-ui="goal-team-chip"][data-team-id="42"]'));
  assert.doesNotMatch(goal.innerHTML, /undefined|null/);
  assert.match(fullGoalLog.textContent ?? "", /Unknown player \(invalid ID: 99\)/);
  assert.match(scorerStats.textContent ?? "", /Valid 99\s*2/);
  assert.match(scorerStats.textContent ?? "", /Unknown player \(invalid ID: 99\)\s*1/);
  assert.doesNotMatch(scorerStats.textContent ?? "", /Valid 99\s*3/);
  assert.match(assistStats.textContent ?? "", /Valid 17\s*2/);
  assert.match(assistStats.textContent ?? "", /Unknown player \(invalid ID: 17\)\s*1/);
  assert.doesNotMatch(fullGoalLog.innerHTML, /undefined|null/);
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
  for (const scoreTeam of scoreboard.querySelectorAll('[data-ui="score-team"]')) {
    assert.deepEqual(
      [...scoreTeam.querySelectorAll("dt")].map((term) => term.textContent),
      ["Conceded", "Scored"],
    );
  }

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
  assert.match(timeline.textContent ?? "", /Ari\s*Red\s*→\s*Blue/);
  assert.match(timeline.textContent ?? "", /Assists: Bea/);
  assert.equal(undoLastGoalButton.disabled, false);
  assert.equal(scoringTeamInput.value, "");
  assert.equal(concedingTeamInput.value, "");
  assert.equal(scorerInput.value, "");
  assert.equal(ownGoalInput.checked, false);
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.disabled, true);
  assert.equal(assistsElement.querySelectorAll('input[type="checkbox"]:checked').length, 0);
  const firstGoal = timeline.querySelector('[data-ui="goal-event"][data-event-id="goal-1"]');
  assert(firstGoal instanceof gamePage.window.HTMLElement);
  assert(
    firstGoal.querySelector(
      '[data-ui="goal-team-chip"][role="img"][data-team-id="red"][aria-label="Scoring team: Red"]',
    ),
  );
  assert(firstGoal.querySelector('[data-ui="goal-team-arrow"]'));
  assert(
    firstGoal.querySelector(
      '[data-ui="goal-team-chip"][role="img"][data-team-id="blue"][aria-label="Conceding team: Blue"]',
    ),
  );
  assert(firstGoal.querySelector('[data-ui="third-indicator"][data-third="1"][aria-label="Third 1 of 3"]'));
  assert(firstGoal.querySelector('[data-action="edit-goal"] [data-icon="pencil"]'));
  assert(firstGoal.querySelector('[data-action="delete-goal"] [data-icon="trash-2"]'));
  assert.doesNotMatch(firstGoal.textContent ?? "", /Latest/);

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
  assert.match(refreshedTimeline.textContent ?? "", /Ari\s*Red\s*→\s*Blue/);
  assert.equal(refreshedUndoButton.disabled, false);

  const editGoalButton = gamePage.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  assert(editGoalButton instanceof gamePage.window.HTMLButtonElement);
  const editGoalIcon = editGoalButton.querySelector('[data-icon="pencil"]');
  assert(editGoalIcon instanceof gamePage.window.HTMLElement);
  dispatchClick(editGoalIcon);
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
  assert.match(timeline.textContent ?? "", /Cy\s*OG\s*→\s*Blue/);
  assert.equal(scoringTeamInput.value, "");
  assert.equal(concedingTeamInput.value, "");
  assert.equal(scorerInput.value, "");
  assert.equal(ownGoalInput.checked, false);
  const ownGoalEvent = timeline.querySelector('[data-ui="goal-event"][data-event-id="goal-1"]');
  assert(ownGoalEvent instanceof gamePage.window.HTMLElement);
  assert(ownGoalEvent.querySelector('[data-ui="own-goal-marker"][aria-label="Own goal"]'));
  assert.equal(ownGoalEvent.querySelectorAll('[data-ui="goal-team-chip"]').length, 1);
  assert(
    ownGoalEvent.querySelector(
      '[data-ui="goal-team-chip"][role="img"][data-team-id="blue"][aria-label="Conceding team: Blue"]',
    ),
  );

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
  assert.match(timeline.textContent ?? "", /Cy\s*Blue\s*→\s*Red/);

  const deleteGoalButton = gamePage.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(deleteGoalButton instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(deleteGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.has("goal-1"), false);
  assert.equal(apiState.goalEvents.has("goal-2"), true);
  assert.match(timeline.textContent ?? "", /Cy\s*Blue\s*→\s*Red/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Scored\s*1/);
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Conceded\s*1/);

  dispatchClick(undoLastGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.size, 0);
  assert.match(timeline.textContent ?? "", /No goals yet/);
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*0/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*0/);
});

test("game page enables and creates a fresh own goal after the timeline loads", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-own-goal-create",
    status: "live",
    thirds,
  });

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-own-goal-create" }),
    url: "http://localhost:3000/games/game-own-goal-create",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const ownGoalInput = page.document.getElementById("goal-own-goal");
  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const scoreboard = page.document.getElementById("live-scoreboard");
  assert(ownGoalInput instanceof page.window.HTMLInputElement);
  assert(scoringTeamInput instanceof page.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof page.window.HTMLSelectElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(scoreboard instanceof page.window.HTMLElement);

  assert.equal(ownGoalInput.disabled, false);
  ownGoalInput.click();
  assert.equal(ownGoalInput.checked, true);
  assert.equal(scoringTeamInput.disabled, true);
  assert.equal(scoringTeamInput.value, "");

  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  const goal = apiState.goalEvents.get("goal-1");
  assert(goal);
  assert.equal(goal.ownGoal, true);
  assert.equal(goal.scoringTeamId, null);
  assert.equal(goal.concedingTeamId, "blue");
  assert.equal(goal.scorerPlayerId, "player-cy");
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*1/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Scored\s*0/);
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
    joinCode: "SMOKE123",
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
  const joinCodeValue = gamePage.document.getElementById("game-join-code-value");
  const joinLink = gamePage.document.getElementById("game-join-link");
  const joinQr = gamePage.document.getElementById("game-join-qr");
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
  assert(joinCodeValue instanceof gamePage.window.HTMLElement);
  assert(joinLink instanceof gamePage.window.HTMLAnchorElement);
  assert(joinQr instanceof gamePage.window.HTMLElement);
  assert(scoreboard instanceof gamePage.window.HTMLElement);
  assert(goalFormNote instanceof gamePage.window.HTMLElement);
  assert(resultSummary instanceof gamePage.window.HTMLElement);
  assert.equal(finishGameButton.disabled, true);
  assert.equal(deleteGameButton.disabled, false);
  assert.equal(deleteGameButton.hasAttribute("aria-disabled"), false);
  assert.equal(gamePage.document.getElementById("game-delete-lock-reason")?.hidden, true);
  assert.equal(joinCodeValue.textContent, "SMOKE123");
  assert.equal(joinLink.getAttribute("href"), "http://localhost:3000/join?code=SMOKE123");
  assert.equal(joinLink.textContent, "http://localhost:3000/join?code=SMOKE123");
  const joinQrSvg = joinQr.querySelector("svg");
  assert(joinQrSvg instanceof gamePage.window.SVGElement);
  assert.equal(joinQrSvg.getAttribute("aria-label"), "Join QR code for http://localhost:3000/join?code=SMOKE123");
  assert.match(joinQrSvg.innerHTML, /<path/);
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
  assert.equal(deleteGameButton.disabled, false);
  assert.equal(deleteGameButton.getAttribute("aria-disabled"), "true");
  assert.equal(deleteGameButton.getAttribute("aria-describedby"), "game-delete-lock-reason");
  assert.match(deleteGameButton.getAttribute("aria-label") ?? "", /unavailable.*finished/i);
  assert.equal(deleteGameButton.title, "Finished games cannot be deleted");
  assert.equal(gamePage.document.getElementById("game-delete-lock-reason")?.hidden, false);
  deleteGameButton.focus();
  assert.equal(gamePage.document.activeElement, deleteGameButton);
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
  const lockedTransferButton = gamePage.document.querySelector(
    `[data-action="toggle-transfer"][data-player-id="${ari.playerId}"]`,
  );
  assert(lockedTransferButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(lockedTransferButton.disabled, true);
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
  assert.match(goalFormNote.textContent ?? "", /correct the finished result/);
  assert.doesNotMatch(goalFormNote.textContent ?? "", /final whistle/);
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 1);
  assert.equal([...apiState.goalEvents.values()][0]?.scorerPlayerId, dee.playerId);
  assert.equal(apiState.games.get("game-admin-finished-correction")?.result?.winnerTeamId, "red");
  assert.match(resultSummary.textContent ?? "", /Red win/);
  assert.equal(scoringTeamInput.value, "");
  assert.equal(concedingTeamInput.value, "");
  assert.equal(scorerInput.value, "");
});

test("game page serializes goal corrections through the finished-result refresh", async () => {
  const apiState = createMockApiState();
  const finishedThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
    finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-correction-serialized",
    status: "finished",
    thirds: finishedThirds,
    role: "admin",
    sessionEmail: "admin@3fc.football",
  });
  const seededGame = apiState.games.get("game-correction-serialized");
  assert(seededGame);
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:00:12.000Z");

  const defaultFetch = createMockFetch(apiState);
  let goalMutationRequests = 0;
  let goalCommitted = false;
  let resolveFinishedGameRefresh: ((response: Response) => void) | undefined;
  const serializedFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const isGoalMutation = method !== "GET" && target.pathname.includes("/goals");
    if (isGoalMutation) {
      goalMutationRequests += 1;
    }

    if (method === "POST" && target.pathname === "/v1/games/game-correction-serialized/goals") {
      const response = await defaultFetch(input, init);
      goalCommitted = true;
      return response;
    }

    if (
      goalCommitted &&
      method === "GET" &&
      target.pathname === "/v1/games/game-correction-serialized"
    ) {
      return new Promise<Response>((resolve) => {
        resolveFinishedGameRefresh = resolve;
      });
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-correction-serialized" }),
    url: "http://localhost:3000/games/game-correction-serialized",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: serializedFetch,
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

  assert.equal(goalMutationRequests, 1);
  assert(resolveFinishedGameRefresh);
  assert.equal(scoringTeamInput.disabled, true);
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.disabled, true);
  assert.equal(saveGoalButton.disabled, true);
  assert.match(page.document.getElementById("goal-form-note")?.textContent ?? "", /Saving goal change/);

  const pendingUndo = page.document.querySelector('[data-action="undo-last-goal"]');
  const pendingEdit = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const pendingDelete = page.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(pendingUndo instanceof page.window.HTMLButtonElement);
  assert(pendingEdit instanceof page.window.HTMLButtonElement);
  assert(pendingDelete instanceof page.window.HTMLButtonElement);
  assert.equal(pendingUndo.disabled, true);
  assert.equal(pendingEdit.disabled, true);
  assert.equal(pendingDelete.disabled, true);

  dispatchClick(pendingUndo);
  dispatchClick(pendingEdit);
  dispatchClick(pendingDelete);
  await flushAsync();
  assert.equal(goalMutationRequests, 1);
  assert.equal(page.document.querySelector('[data-action="cancel-goal-edit"]')?.hasAttribute("hidden"), true);

  const refreshedGame = apiState.games.get("game-correction-serialized");
  assert(refreshedGame);
  resolveFinishedGameRefresh(createJsonResponse(200, refreshedGame));
  await flushAsync();

  const restoredUndo = page.document.querySelector('[data-action="undo-last-goal"]');
  const restoredEdit = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const restoredDelete = page.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(restoredUndo instanceof page.window.HTMLButtonElement);
  assert(restoredEdit instanceof page.window.HTMLButtonElement);
  assert(restoredDelete instanceof page.window.HTMLButtonElement);
  assert.equal(scoringTeamInput.disabled, false);
  assert.equal(restoredUndo.disabled, false);
  assert.equal(restoredEdit.disabled, false);
  assert.equal(restoredDelete.disabled, false);
  assert.equal(page.document.getElementById("setup-status")?.textContent, "Goal added.");
});

test("game page clears a committed finished-goal draft when result refresh fails", async () => {
  const apiState = createMockApiState();
  const finishedThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
    finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-create-refresh-fail",
    status: "finished",
    thirds: finishedThirds,
    role: "admin",
    sessionEmail: "admin@3fc.football",
  });
  const seededGame = apiState.games.get("game-create-refresh-fail");
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

    if (method === "POST" && target.pathname === "/v1/games/game-create-refresh-fail/goals") {
      const response = await defaultFetch(input, init);
      failNextGameRefresh = true;
      return response;
    }

    if (method === "GET" && target.pathname === "/v1/games/game-create-refresh-fail" && failNextGameRefresh) {
      failNextGameRefresh = false;
      return createJsonResponse(503, {
        error: "unavailable",
        message: "Game refresh unavailable.",
      });
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-create-refresh-fail" }),
    url: "http://localhost:3000/games/game-create-refresh-fail",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: staleResultFetch,
  });

  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const ownGoalInput = page.document.getElementById("goal-own-goal");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const status = page.document.getElementById("setup-status");
  const error = page.document.getElementById("setup-error");
  const resultSummary = page.document.getElementById("game-result-summary");
  assert(scoringTeamInput instanceof page.window.HTMLSelectElement);
  assert(concedingTeamInput instanceof page.window.HTMLSelectElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(ownGoalInput instanceof page.window.HTMLInputElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);
  assert(resultSummary instanceof page.window.HTMLElement);

  scoringTeamInput.value = "red";
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  concedingTeamInput.value = "blue";
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-ari";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 1);
  assert.match(status.textContent ?? "", /Goal added; result refresh failed/);
  assert.match(error.textContent ?? "", /finished result could not be refreshed/);
  assert.equal(resultSummary.hidden, false);
  assert.match(resultSummary.textContent ?? "", /Result refresh required/);
  assert.match(resultSummary.textContent ?? "", /goal change was saved/);
  assert.equal(resultSummary.querySelector('[data-testid="game-result-outcome"]'), null);
  assert.equal(scoringTeamInput.value, "");
  assert.equal(concedingTeamInput.value, "");
  assert.equal(scorerInput.value, "");
  assert.equal(ownGoalInput.checked, false);
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.disabled, true);
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
  const resultSummary = page.document.getElementById("game-result-summary");
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);
  assert(resultSummary instanceof page.window.HTMLElement);

  dispatchClick(undoLastGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.has("goal-2"), false);
  assert.equal(apiState.goalEvents.has("goal-1"), true);
  assert.equal(apiState.games.get("game-undo-refresh-fail")?.result?.winnerTeamId, "red");
  assert.match(timeline.textContent ?? "", /Ari\s*Red\s*→\s*Blue/);
  assert.doesNotMatch(timeline.textContent ?? "", /Cy\s*Blue\s*→\s*Red/);
  assert.match(status.textContent ?? "", /Latest goal undone; result refresh failed/);
  assert.match(error.textContent ?? "", /finished result could not be refreshed/);
  assert.match(resultSummary.textContent ?? "", /Result refresh required/);
  assert.doesNotMatch(resultSummary.textContent ?? "", /Red win|Blue win|Draw/);
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
  assert.equal(
    gamePage.document.getElementById("game-title")?.textContent,
    expectedLocalDateHeading(apiState.games.get("game-20260328-abc123")!.gameStartTs),
  );
  assert.equal(gamePage.document.getElementById("game-id-value")?.textContent, "game-20260328-abc123");
});

test("join page registers a player without organizer authentication", async () => {
  const apiState = createMockApiState();
  apiState.games.set("game-join-1", {
    gameId: "game-join-1",
    joinCode: "JOIN0001",
    leagueId: "autumn-league",
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

  const joinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""),
    url: "http://localhost:3000/join?code=join0001",
    scriptFile: "setup-flow.js",
    apiState,
  });

  assert.equal(joinPage.navigations.length, 0);
  assert.equal(joinPage.document.getElementById("join-code-value")?.textContent, "JOIN0001");

  const nicknameInput = joinPage.document.getElementById("join-player-nickname");
  const form = joinPage.document.getElementById("join-game-form");
  assert(nicknameInput instanceof joinPage.window.HTMLInputElement);
  assert(form instanceof joinPage.window.HTMLFormElement);

  nicknameInput.value = "Cy";
  nicknameInput.dispatchEvent(new joinPage.window.Event("input", { bubbles: true }));
  dispatchSubmit(form);
  await flushAsync();

  const player = [...apiState.players.values()][0];
  assert(player);
  assert.equal(player.nickname, "Cy");
  assert.equal(apiState.lastPublicJoinRequest?.body.nickname, "Cy");
  assert.equal("playerId" in (apiState.lastPublicJoinRequest?.body ?? {}), false);
  const firstJoinKey = apiState.lastPublicJoinRequest?.idempotencyKey ?? "";
  assert.match(firstJoinKey, /^join-player-JOIN0001-Cy-/);
  assert.equal(apiState.storage.has("threefc-idempotency:join-player:JOIN0001-Cy"), false);
  assert.equal(apiState.gamePlayers.has(`game-join-1:${player.playerId}`), true);
  assert.equal(joinPage.document.getElementById("join-result")?.hidden, false);
  assert.equal(joinPage.document.getElementById("join-result-player")?.textContent, "Cy");
  assert.equal(joinPage.document.getElementById("join-result-game")?.textContent, "game-join-1");
  const claimActions = joinPage.document.getElementById("join-claim-actions");
  const signInLink = joinPage.document.getElementById("join-signin-link");
  const claimButton = joinPage.document.querySelector('[data-testid="claim-player"]');
  assert(claimActions instanceof joinPage.window.HTMLElement);
  assert(signInLink instanceof joinPage.window.HTMLAnchorElement);
  assert(claimButton instanceof joinPage.window.HTMLButtonElement);
  assert.equal(claimActions.hidden, false);
  assert.equal(claimButton.hidden, true);
  const signInHref = signInLink.getAttribute("href") ?? "";
  assert.match(signInHref, /^\/sign-in\?returnTo=/);
  assert.equal(
    new URL(signInHref, "http://localhost:3000").searchParams.get("returnTo"),
    `/join?code=join0001&playerId=${player.playerId}`,
  );

  const secondJoinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""),
    url: "http://localhost:3000/join?code=join0001",
    scriptFile: "setup-flow.js",
    apiState,
  });
  const secondNicknameInput = secondJoinPage.document.getElementById("join-player-nickname");
  const secondForm = secondJoinPage.document.getElementById("join-game-form");
  assert(secondNicknameInput instanceof secondJoinPage.window.HTMLInputElement);
  assert(secondForm instanceof secondJoinPage.window.HTMLFormElement);

  secondNicknameInput.value = "Cy";
  secondNicknameInput.dispatchEvent(new secondJoinPage.window.Event("input", { bubbles: true }));
  dispatchSubmit(secondForm);
  await flushAsync();

  const secondJoinKey = apiState.lastPublicJoinRequest?.idempotencyKey ?? "";
  assert.match(secondJoinKey, /^join-player-JOIN0001-Cy-/);
  assert.notEqual(secondJoinKey, firstJoinKey);
  assert.equal(apiState.players.size, 2);
  assert.equal(apiState.storage.has("threefc-idempotency:join-player:JOIN0001-Cy"), false);
});

test("join page lets a signed-in participant claim their joined player", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-player",
    email: "delegate@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-player";
  apiState.games.set("game-join-claim", {
    gameId: "game-join-claim",
    joinCode: "JOIN0002",
    leagueId: "autumn-league",
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

  const joinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", "join0002"),
    url: "http://localhost:3000/join/join0002",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const nicknameInput = joinPage.document.getElementById("join-player-nickname");
  const form = joinPage.document.getElementById("join-game-form");
  assert(nicknameInput instanceof joinPage.window.HTMLInputElement);
  assert(form instanceof joinPage.window.HTMLFormElement);

  nicknameInput.value = "Dee";
  nicknameInput.dispatchEvent(new joinPage.window.Event("input", { bubbles: true }));
  dispatchSubmit(form);
  await flushAsync();

  const player = [...apiState.players.values()][0];
  assert(player);
  assert.equal(player.claimedByUserId, "delegate@3fc.football");
  assert.equal(joinPage.document.getElementById("join-claim-status")?.textContent, "Player claimed. The organiser can now make this account a scorer.");
  const claimButton = joinPage.document.querySelector('[data-testid="claim-player"]');
  assert(claimButton instanceof joinPage.window.HTMLButtonElement);
  assert.equal(claimButton.disabled, true);
});

test("join page claims a joined player after returning from sign-in", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-player",
    email: "delegate@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-player";
  apiState.players.set("player-returned", {
    playerId: "player-returned",
    nickname: "Dee",
    claimedByUserId: null,
    createdAt: "2026-03-28T11:00:12.000Z",
    updatedAt: "2026-03-28T11:00:12.000Z",
  });

  const joinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""),
    url: "http://localhost:3000/join?code=join0002&playerId=player-returned",
    scriptFile: "setup-flow.js",
    apiState,
  });

  await flushAsync();

  assert.equal(apiState.players.get("player-returned")?.claimedByUserId, null);
  assert.equal(joinPage.document.getElementById("join-claim-status")?.textContent, "Signed in as delegate@3fc.football. Claim this player for scorer access.");
  const claimButton = joinPage.document.querySelector('[data-testid="claim-player"]');
  assert(claimButton instanceof joinPage.window.HTMLButtonElement);
  assert.equal(claimButton.hidden, false);
  assert.equal(claimButton.disabled, false);

  dispatchClick(claimButton);
  await flushAsync();

  assert.equal(apiState.players.get("player-returned")?.claimedByUserId, "delegate@3fc.football");
  assert.equal(joinPage.document.getElementById("join-claim-status")?.textContent, "Player claimed. The organiser can now make this account a scorer.");
});

test("join page keeps successful join state when signed-in claim fails", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-player",
    email: "delegate@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-player";
  apiState.games.set("game-join-claim-fail", {
    gameId: "game-join-claim-fail",
    joinCode: "JOIN0003",
    leagueId: "autumn-league",
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

  const defaultFetch = createMockFetch(apiState);
  const failingClaimFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "POST" && target.pathname.startsWith("/v1/players/") && target.pathname.endsWith("/claim")) {
      return createJsonResponse(503, {
        error: "temporary_failure",
        message: "Claim service unavailable.",
      });
    }

    return defaultFetch(input, init);
  };

  const joinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""),
    url: "http://localhost:3000/join?code=join0003",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: failingClaimFetch,
  });

  const nicknameInput = joinPage.document.getElementById("join-player-nickname");
  const form = joinPage.document.getElementById("join-game-form");
  const joinButton = joinPage.document.querySelector('[data-testid="join-game"]');
  assert(nicknameInput instanceof joinPage.window.HTMLInputElement);
  assert(form instanceof joinPage.window.HTMLFormElement);
  assert(joinButton instanceof joinPage.window.HTMLButtonElement);

  nicknameInput.value = "Ez";
  nicknameInput.dispatchEvent(new joinPage.window.Event("input", { bubbles: true }));
  dispatchSubmit(form);
  await flushAsync();

  const player = [...apiState.players.values()][0];
  assert(player);
  assert.equal(player.nickname, "Ez");
  assert.equal(player.claimedByUserId, null);
  assert.equal(apiState.players.size, 1);
  assert.equal(apiState.gamePlayers.has(`game-join-claim-fail:${player.playerId}`), true);
  assert.equal(joinPage.document.getElementById("join-result")?.hidden, false);
  assert.equal(joinPage.document.getElementById("join-result-player")?.textContent, "Ez");
  assert.equal(joinPage.document.getElementById("setup-status")?.textContent, "Joined game. Player claim failed.");
  assert.equal(joinPage.document.getElementById("setup-error")?.textContent, "Claim service unavailable.");
  assert.equal(nicknameInput.disabled, true);
  assert.equal(joinButton.disabled, true);

  const claimButton = joinPage.document.querySelector('[data-testid="claim-player"]');
  assert(claimButton instanceof joinPage.window.HTMLButtonElement);
  assert.equal(claimButton.hidden, false);
  assert.equal(claimButton.disabled, false);
});

test("join page preserves distinct retry keys for similar public nicknames", async () => {
  const apiState = createMockApiState();
  apiState.games.set("game-join-1", {
    gameId: "game-join-1",
    joinCode: "JOIN0001",
    leagueId: "autumn-league",
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

  const defaultFetch = createMockFetch(apiState);
  const requestedKeys: string[] = [];
  const failingJoinFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "POST" && target.pathname === "/v1/join/JOIN0001") {
      const idempotencyKey = readInitHeader(init, "idempotency-key");
      if (idempotencyKey) {
        requestedKeys.push(idempotencyKey);
      }
      return createJsonResponse(503, {
        error: "temporary_failure",
        message: "Temporary failure.",
      });
    }

    return defaultFetch(input, init);
  };

  const firstJoinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", "join0001"),
    url: "http://localhost:3000/join/join0001",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: failingJoinFetch,
  });
  const firstNicknameInput = firstJoinPage.document.getElementById("join-player-nickname");
  const firstForm = firstJoinPage.document.getElementById("join-game-form");
  assert(firstNicknameInput instanceof firstJoinPage.window.HTMLInputElement);
  assert(firstForm instanceof firstJoinPage.window.HTMLFormElement);

  firstNicknameInput.value = "A B";
  firstNicknameInput.dispatchEvent(new firstJoinPage.window.Event("input", { bubbles: true }));
  dispatchSubmit(firstForm);
  await flushAsync();

  const secondJoinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", "join0001"),
    url: "http://localhost:3000/join/join0001",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: failingJoinFetch,
  });
  const secondNicknameInput = secondJoinPage.document.getElementById("join-player-nickname");
  const secondForm = secondJoinPage.document.getElementById("join-game-form");
  assert(secondNicknameInput instanceof secondJoinPage.window.HTMLInputElement);
  assert(secondForm instanceof secondJoinPage.window.HTMLFormElement);

  secondNicknameInput.value = "A-B";
  secondNicknameInput.dispatchEvent(new secondJoinPage.window.Event("input", { bubbles: true }));
  dispatchSubmit(secondForm);
  await flushAsync();

  assert.equal(requestedKeys.length, 2);
  assert.notEqual(requestedKeys[0], requestedKeys[1]);
  assert.equal(apiState.storage.get("threefc-idempotency:join-player:JOIN0001-A%20B"), requestedKeys[0]);
  assert.equal(apiState.storage.get("threefc-idempotency:join-player:JOIN0001-A-B"), requestedKeys[1]);
});
