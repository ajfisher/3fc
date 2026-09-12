import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
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
  subject?: string;
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
  lastMagicLinkStartRequest: Record<string, unknown> | null;
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
    lastMagicLinkStartRequest: null,
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
      state.lastMagicLinkStartRequest = body;
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

    const linkedJoin = path.match(/^\/v1\/join\/([^/]+)\/linked-players$/);
    if (method === "GET" && linkedJoin) {
      if (!isAuthenticated(state) || !state.session) return createJsonResponse(401, { error: "unauthorized" });
      const game = [...state.games.values()].find(candidate => candidate.joinCode === decodeURIComponent(linkedJoin[1]));
      if (!game) return createJsonResponse(404, { error: "not_found" });
      return createJsonResponse(200, { accountId: state.session.email, gameId: game.gameId, leagueId: game.leagueId, players: [], cursor: null, complete: true });
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

    if (method === "POST" && path === "/v1/auth/logout") {
      state.session = null;
      state.cookieJar = "";
      return new Response(null, { status: 204 });
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
        ...(body.claimProof ? { claimProof: { proofId: (body.claimProof as { proofId: string }).proofId,
          expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() } } : {}),
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
    const joinContextMatch = path.match(/^\/v1\/join\/([^/]+)\/player-context$/);
    if (method === "GET" && joinContextMatch) {
      const joinCode = decodeURIComponent(joinContextMatch[1]).trim().toUpperCase();
      let playerId: string;
      try {
        const fields = target.search.slice(1).split("&");
        if (fields.length !== 1) throw new Error("invalid_context_query");
        const separator = fields[0].indexOf("=");
        if (separator < 0 || decodeURIComponent(fields[0].slice(0, separator).replace(/\+/g, " ")) !== "playerId") throw new Error("invalid_context_query");
        playerId = decodeURIComponent(fields[0].slice(separator + 1).replace(/\+/g, " "));
        if (!playerId.trim()) throw new Error("invalid_context_query");
      } catch {
        return createJsonResponse(400, { error: "bad_request", message: "This player link is invalid." });
      }
      const game = [...state.games.values()].find((candidate) => candidate.joinCode === joinCode);
      const player = state.players.get(playerId);
      if (!game || !player || !state.gamePlayers.has(`${game.gameId}:${playerId}`)) {
        return createJsonResponse(404, { error: "not_found", message: "Player context unavailable." });
      }
      return createJsonResponse(200, { gameId: game.gameId, joinCode, player: publicPlayer(player) });
    }
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

    if (method === "DELETE" && gameMatch) {
      const gameId = decodeURIComponent(gameMatch[1]);
      const game = state.games.get(gameId);
      if (!game) {
        return createJsonResponse(404, { error: "not_found", message: "Game not found." });
      }
      if (game.status === "finished") {
        return createJsonResponse(409, {
          error: "conflict",
          code: "finished_game_locked",
          message: `Finished game ${gameId} cannot be deleted.`,
        });
      }
      state.games.delete(gameId);
      return new Response(null, { status: 204 });
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
        unassignedPlayers: [...state.gamePlayers.values()]
          .filter(link => link.gameId === game.gameId && !roster.some(assignment => assignment.playerId === link.playerId))
          .flatMap(link => {
            const player = state.players.get(link.playerId);
            return player ? [publicPlayer(player)] : [];
          }),
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
        .slice(0, 20)
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

function createManualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; runAt: number }>();

  return {
    setTimeout(callback: () => void, delay = 0): number {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, runAt: now + delay });
      return id;
    },
    clearTimeout(id: number): void {
      pending.delete(id);
    },
    pendingCount(): number {
      return pending.size;
    },
    elapsedMilliseconds(): number {
      return now;
    },
    pendingDelays(): number[] {
      return [...pending.values()].map(timer => timer.runAt - now).sort((left, right) => left - right);
    },
    advanceBy(milliseconds: number): void {
      const target = now + milliseconds;
      let callbacks = 0;
      while (true) {
        const next = [...pending.entries()]
          .filter(([, timer]) => timer.runAt <= target)
          .sort((left, right) => left[1].runAt - right[1].runAt || left[0] - right[0])[0];
        if (!next) {
          break;
        }
        const [id, timer] = next;
        assert(++callbacks <= 100, "A finite manual-timer advance must not execute an unbounded recurring loop");
        pending.delete(id);
        now = timer.runAt;
        timer.callback();
      }
      now = target;
    },
  };
}

function expectedLocalTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16).replace("T", " ");
}

function expectedSeasonKickoff(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(isoTimestamp));
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
  captureInterval?: (callback: () => void) => number;
  captureClearInterval?: (id: number) => void;
  sessionStorage?: Map<string, string>;
  timers?: ReturnType<typeof createManualTimers>;
}) {
  const dom = new JSDOM(input.html, {
    url: input.url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  const { window } = dom;
  const navigations: Array<{ url: string; mode: string }> = [];

  Object.defineProperty(window, "crypto", {
    // UI scheduling fixtures drain microtasks, not the native crypto thread
    // pool. Keep the actual SHA-256 result but make its completion deterministic.
    // player-proof.test.ts and browser acceptance use native WebCrypto.
    value: {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      randomUUID: webcrypto.randomUUID.bind(webcrypto),
      subtle: { async digest(algorithm: string, bytes: Uint8Array) {
        assert.equal(algorithm, "SHA-256");
        return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
      } },
    },
    configurable: true,
  });
  Object.defineProperty(window, "TextEncoder", { value: TextEncoder, configurable: true });
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
  if (input.sessionStorage) {
    Object.defineProperty(window, "sessionStorage", {
      value: {
        get length() { return input.sessionStorage!.size; },
        key(index: number) { return [...input.sessionStorage!.keys()][index] ?? null; },
        getItem: (key: string) => input.sessionStorage?.get(key) ?? null,
        setItem: (key: string, value: string) => {
          input.sessionStorage?.set(key, value);
        },
        removeItem: (key: string) => {
          input.sessionStorage?.delete(key);
        },
      },
      configurable: true,
    });
  }
  Object.defineProperty(window, "fetch", {
    value: input.fetch ?? createMockFetch(input.apiState),
    configurable: true,
  });
  Object.defineProperty(window, "setTimeout", {
    value: input.timers?.setTimeout ?? ((callback: () => void, delay = 0) => {
      // Long-running lifecycle work is advanced explicitly by its own tests.
      // Synchronous recurring callbacks would recurse without a browser clock.
      if (delay >= 1000) return 0;
      callback();
      return 0;
    }),
    configurable: true,
  });
  Object.defineProperty(window, "clearTimeout", {
    value: input.timers?.clearTimeout ?? (() => undefined),
    configurable: true,
  });
  Object.defineProperty(window, "setInterval", {
    value: input.captureInterval ?? (() => 0),
    configurable: true,
  });
  Object.defineProperty(window, "clearInterval", {
    value: input.captureClearInterval ?? (() => undefined),
    configurable: true,
  });
  if (input.timers) {
    Object.defineProperty(window.Date, "now", {
      value: () => Date.parse("2026-03-28T11:00:30.000Z") + input.timers!.elapsedMilliseconds(),
      configurable: true,
    });
  }

  window.eval(readFileSync(resolve(process.cwd(), "dist/ui/player-presentation-browser.js"), "utf8"));
  window.eval(readUiScript("player-proof.js"));
  window.eval(readUiScript("returning-player.js"));
  if (input.scriptFile === "setup-flow.js" && ["join", "invite"].includes(window.document.getElementById("setup-flow-root")?.getAttribute("data-page") ?? "")) {
    window.eval(readUiScript("auth-flow.js"));
  }
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
  element.dispatchEvent(new element.ownerDocument.defaultView!.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function openActionMenuFor(element: HTMLElement) {
  const window = element.ownerDocument.defaultView!;
  const menu = element.closest('[data-ui="action-menu"]');
  const trigger = menu?.querySelector('[data-action="toggle-action-menu"]');
  const surface = menu?.querySelector('[data-ui="action-menu-surface"]');
  assert(menu instanceof window.HTMLElement && trigger instanceof window.HTMLButtonElement && surface instanceof window.HTMLElement);
  if (trigger.getAttribute("aria-expanded") !== "true") dispatchClick(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(surface.hidden, false);
  assert.equal(trigger.getAttribute("aria-controls"), surface.id);
  return { menu, trigger, surface };
}

function interactionVisible(element: HTMLElement): boolean {
  const window = element.ownerDocument.defaultView!;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (ancestor.hidden || style.display === "none" || style.visibility === "hidden") return false;
  }
  return element.isConnected;
}

function dispatchSubmit(form: HTMLFormElement): void {
  form.dispatchEvent(new form.ownerDocument.defaultView!.Event("submit", { bubbles: true, cancelable: true }));
}

function goalTeamValue(group: HTMLFieldSetElement): string {
  return group.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value ?? "";
}

function setGoalTeamValue(group: HTMLFieldSetElement, value: string): void {
  for (const radio of group.querySelectorAll<HTMLInputElement>('input[type="radio"]')) radio.checked = radio.value === value;
}

function liveGoalControls(page: Awaited<ReturnType<typeof bootPage>>) {
  const scoring = page.document.getElementById("goal-scoring-team");
  const conceding = page.document.getElementById("goal-conceding-team");
  const scorer = page.document.getElementById("goal-scorer");
  const ownGoal = page.document.getElementById("goal-own-goal");
  const form = page.document.getElementById("goal-form");
  const save = page.document.querySelector('[data-action="save-goal"]');
  const retry = page.document.querySelector('[data-action="retry-goal-operation"]');
  const cancel = page.document.querySelector('[data-action="cancel-goal-edit"]');
  const undo = page.document.querySelector('[data-action="undo-last-goal"]');
  assert(scoring instanceof page.window.HTMLFieldSetElement);
  assert(conceding instanceof page.window.HTMLFieldSetElement);
  assert(scorer instanceof page.window.HTMLSelectElement);
  assert(ownGoal instanceof page.window.HTMLInputElement);
  assert(form instanceof page.window.HTMLFormElement);
  assert(save instanceof page.window.HTMLButtonElement && retry instanceof page.window.HTMLButtonElement);
  assert(cancel instanceof page.window.HTMLButtonElement && undo instanceof page.window.HTMLButtonElement);
  const choose = (group: HTMLFieldSetElement, value: string) => {
    setGoalTeamValue(group, value);
    group.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  };
  const draft = () => {
    choose(scoring, "red");
    choose(conceding, "blue");
    scorer.value = "player-ari";
    scorer.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  };
  return { scoring, conceding, scorer, ownGoal, form, save, retry, cancel, undo, choose, draft };
}

function seedLiveGoalEvent(apiState: MockApiState, gameId: string, eventId: string, second = 30): void {
  apiState.goalEvents.set(eventId, {
    gameId, eventId, third: 1, thirdMinute: 1, gameMinute: 1, elapsedSeconds: second,
    stoppageMinute: null, displayTime: "1'", scoringTeamId: "red", concedingTeamId: "blue",
    scorerPlayerId: "player-ari", assistPlayerIds: [], ownGoal: false,
    createdAt: `2026-03-28T11:01:${String(second).padStart(2, "0")}.000Z`,
    updatedAt: `2026-03-28T11:01:${String(second).padStart(2, "0")}.000Z`,
  });
}

function enterFinishedCorrections(page: Awaited<ReturnType<typeof bootPage>>, teams = false): void {
  const action = page.document.querySelector(`[data-action="${teams ? "edit-finished-teams" : "correct-finished-result"}"]`);
  assert(action instanceof page.window.HTMLButtonElement);
  assert.equal(action.hidden, false);
  dispatchClick(action);
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

test("sign out is hidden until the existing authenticated session check resolves", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  let resolveSession: ((response: Response) => void) | undefined;
  let logoutRequests = 0;
  const page = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"),
    url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/auth/session") {
        assert.equal(init?.cache, "no-store");
        return new Promise<Response>((resolve) => { resolveSession = resolve; });
      }
      if (path === "/v1/auth/logout") logoutRequests += 1;
      return baseFetch(input, init);
    },
  });
  try {
    const actions = page.document.getElementById("account-actions");
    const button = page.document.getElementById("sign-out");
    assert(actions instanceof page.window.HTMLElement);
    assert(button instanceof page.window.HTMLButtonElement);
    assert.equal(actions.hidden, true);
    assert.equal(button.disabled, true);
    dispatchClick(button);
    assert.equal(logoutRequests, 0);
    assert(resolveSession);
    resolveSession(createJsonResponse(200, { session: apiState.session }));
    await flushAsync();
    assert.equal(actions.hidden, false);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Sign out");
    assert.equal(button.type, "button");
    button.focus();
    assert.equal(page.document.activeElement, button);
  } finally {
    page.dom.window.close();
  }
});

for (const sessionResult of ["visitor", "unavailable", "missing-session"] as const) {
  test(`sign out is unavailable for a ${sessionResult} session`, async () => {
    const apiState = createMockApiState();
    let logoutRequests = 0;
    const page = await bootPage({
      html: renderSetupHomePage("http://localhost:3001"),
      url: "http://localhost:3000/setup",
      scriptFile: "setup-flow.js",
      apiState,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/auth/logout") logoutRequests += 1;
        if (sessionResult === "unavailable") throw new Error("offline");
        return createJsonResponse(sessionResult === "visitor" ? 401 : 200, {});
      },
    });
    try {
      const actions = page.document.getElementById("account-actions");
      const button = page.document.getElementById("sign-out");
      assert(actions instanceof page.window.HTMLElement);
      assert(button instanceof page.window.HTMLButtonElement);
      assert.equal(actions.hidden, true);
      assert.equal(button.disabled, true);
      dispatchClick(button);
      await flushAsync();
      assert.equal(logoutRequests, 0);
    } finally {
      page.dom.window.close();
    }
  });
}

test("sign out commits once, clears only auth recovery state and replaces history after confirmation", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "admin" });
  apiState.storage.set("threefc.auth.return_to", "/games/logout-fixture");
  apiState.storage.set("threefc.idempotency.goal-draft", "keep-retry-key");
  const sessionStorage = new Map([
    ["threefc.auth.callback", "private-recovery-state"],
    ["other-workflow", "keep-this"],
  ]);
  const baseFetch = createMockFetch(apiState);
  let completeLogout: (() => void) | undefined;
  const logoutRequests: RequestInit[] = [];
  const page = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"),
    url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js",
    apiState,
    sessionStorage,
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname !== "/v1/auth/logout") return baseFetch(input, init);
      logoutRequests.push(init ?? {});
      return new Promise<Response>((resolve) => {
        completeLogout = () => { void baseFetch(input, init).then(resolve); };
      });
    },
  });
  try {
    const button = page.document.getElementById("sign-out");
    const feedback = page.document.getElementById("sign-out-status");
    assert(button instanceof page.window.HTMLButtonElement);
    assert(feedback instanceof page.window.HTMLElement);
    // Nested markup has the same native button activation path as its label.
    button.innerHTML = "<span>Sign out</span>";
    const label = button.firstElementChild;
    assert(label instanceof page.window.HTMLElement);
    dispatchClick(label);
    dispatchClick(button);
    dispatchClick(label);
    assert.equal(logoutRequests.length, 1);
    assert.equal(logoutRequests[0]?.method, "POST");
    assert.equal(logoutRequests[0]?.credentials, "include");
    assert.equal(logoutRequests[0]?.body, undefined);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(feedback.hidden, false);
    assert.equal(feedback.getAttribute("role"), "status");
    assert.equal(feedback.textContent, "Signing out…");
    assert.equal(page.navigations.length, 0);
    assert(apiState.session);
    assert.equal(apiState.storage.get("threefc.auth.return_to"), "/games/logout-fixture");
    assert.equal(sessionStorage.get("threefc.auth.callback"), "private-recovery-state");

    assert(completeLogout);
    completeLogout();
    await flushAsync();
    assert.deepEqual(page.navigations, [{ url: "/sign-in", mode: "replace" }]);
    assert.equal(apiState.session, null);
    assert.equal(apiState.cookieJar, "");
    assert.equal(apiState.storage.has("threefc.auth.return_to"), false);
    assert.equal(sessionStorage.has("threefc.auth.callback"), false);
    assert.equal(apiState.storage.get("threefc.idempotency.goal-draft"), "keep-retry-key");
    assert.equal(sessionStorage.get("other-workflow"), "keep-this");
    dispatchClick(button);
    assert.equal(logoutRequests.length, 1, "keep the latch closed while replacement navigation completes");
  } finally {
    page.dom.window.close();
  }
});

for (const failure of ["network", "lost-response", 503, 401, 200] as const) {
  test(`sign out ${failure} failure retains drafts and offers one truthful retry`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "admin" });
    apiState.storage.set("threefc.auth.return_to", "/games/logout-fixture");
    apiState.storage.set("draft-retry-key", "unchanged");
    const sessionStorage = new Map([["threefc.auth.callback", "recovery-state"]]);
    const baseFetch = createMockFetch(apiState);
    let requests = 0;
    const page = await bootPage({
      html: renderSetupHomePage("http://localhost:3001"),
      url: "http://localhost:3000/setup",
      scriptFile: "setup-flow.js",
      apiState,
      sessionStorage,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname !== "/v1/auth/logout") return baseFetch(input, init);
        requests += 1;
        if (requests > 1) return baseFetch(input, init);
        if (failure === "lost-response") await baseFetch(input, init);
        if (typeof failure === "string") throw new Error("private transport diagnostic");
        return createJsonResponse(failure, { message: "private transport diagnostic" });
      },
    });
    try {
      const toggle = page.document.querySelector('[data-testid="toggle-create-league"]');
      const input = page.document.getElementById("league-name");
      const button = page.document.getElementById("sign-out");
      const feedback = page.document.getElementById("sign-out-status");
      assert(toggle instanceof page.window.HTMLButtonElement);
      assert(input instanceof page.window.HTMLInputElement);
      assert(button instanceof page.window.HTMLButtonElement);
      assert(feedback instanceof page.window.HTMLElement);
      dispatchClick(toggle);
      input.value = "Unfinished league draft";
      button.focus();
      dispatchClick(button);
      await flushAsync();
      assert.equal(requests, 1);
      assert.equal(page.navigations.length, 0);
      assert.equal(button.disabled, false);
      assert.equal(button.hasAttribute("aria-busy"), false);
      assert.equal(page.document.activeElement, button);
      assert.equal(input.value, "Unfinished league draft");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      assert.equal(apiState.storage.get("draft-retry-key"), "unchanged");
      assert.equal(apiState.storage.get("threefc.auth.return_to"), "/games/logout-fixture");
      assert.equal(sessionStorage.get("threefc.auth.callback"), "recovery-state");
      assert.equal(feedback.hidden, false);
      assert.equal(feedback.getAttribute("aria-live"), "polite");
      assert.equal(feedback.getAttribute("data-state"), "error");
      assert.equal(feedback.textContent, "Sign out could not be confirmed. Please try again.");
      assert.doesNotMatch(page.document.body.textContent ?? "", /private transport diagnostic|still signed in|signed out successfully/i);
      assert.equal(page.document.getElementById("setup-error")?.hasAttribute("hidden"), true);
      dispatchClick(button);
      await flushAsync();
      assert.equal(requests, 2);
      assert.deepEqual(page.navigations, [{ url: "/sign-in", mode: "replace" }]);
    } finally {
      page.dom.window.close();
    }
  });
}

for (const failure of ["lost-response", "upstream-503"] as const) {
  for (const ordering of ["before-failure", "after-failure", "after-retry"] as const) {
    test(`sign out recovery rejects a late join response: ${failure}, ${ordering}`, async () => {
      const apiState = createMockApiState();
      seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "viewer" });
      const game = apiState.games.get("logout-fixture");
      assert(game);
      game.joinCode = "ABCD2345";
      const baseFetch = createMockFetch(apiState);
      let completeJoin: (() => void) | undefined;
      let completeSessionProbe: (() => void) | undefined;
      let completeLogoutFailure: (() => void) | undefined;
      let sessionRequests = 0;
      let logoutRequests = 0;
      const page = await bootPage({
        html: renderJoinPage("http://localhost:3001", "ABCD2345"),
        url: "http://localhost:3000/join/ABCD2345", scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/auth/session" && ++sessionRequests > 1) {
            return new Promise<Response>((resolve) => {
              completeSessionProbe = () => resolve(createJsonResponse(401, { error: "unauthorized" }));
            });
          }
          if (path === "/v1/join/ABCD2345") {
            return new Promise<Response>((resolve) => {
              completeJoin = () => { void baseFetch(input, init).then(resolve); };
            });
          }
          if (path === "/v1/auth/logout" && ++logoutRequests === 1) {
            // Revocation committed but its response was lost or replaced by an
            // upstream error. Join registration is independent and can finish.
            await baseFetch(input, init);
            return new Promise<Response>((resolve, reject) => {
              completeLogoutFailure = () => {
                if (failure === "lost-response") reject(new Error("connection lost"));
                else resolve(createJsonResponse(503, { error: "unavailable" }));
              };
            });
          }
          return baseFetch(input, init);
        },
      });
      try {
        const form = page.document.getElementById("join-game-form");
        const nickname = page.document.getElementById("join-player-nickname");
        const button = page.document.getElementById("sign-out");
        const feedback = page.document.getElementById("sign-out-status");
        assert(form instanceof page.window.HTMLFormElement);
        assert(nickname instanceof page.window.HTMLInputElement);
        assert(button instanceof page.window.HTMLButtonElement);
        assert(feedback instanceof page.window.HTMLElement);
        const assertVisible = (element: HTMLElement) => {
          for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
            assert.equal(ancestor.hidden, false, `${ancestor.id || ancestor.tagName} must not hide logout recovery`);
            assert.notEqual(page.window.getComputedStyle(ancestor).display, "none", ancestor.id || ancestor.tagName);
          }
        };
        await chooseNewJoinPlayer(page);
        nickname.value = "New player";
        dispatchSubmit(form);
        // WebCrypto runs on a worker, so microtask draining alone cannot prove
        // that this request started before the separate sign-out action.
        for (let tick = 0; tick < 100 && !completeJoin; tick += 1) await new Promise(resolve => setTimeout(resolve, 2));
        assert(completeJoin);
        dispatchClick(button);
        await flushAsync();
        assert(completeJoin);
        assert(completeLogoutFailure);
        if (ordering === "before-failure") {
          completeJoin();
          await flushAsync();
          assert.equal(completeSessionProbe, undefined, "late registration must not start a post-logout claim session probe");
          assertVisible(feedback);
          assertVisible(button);
          assert.equal(button.disabled, true, "a late registration cannot release the pending logout latch");
          assert.equal(feedback.textContent, "Signing out…");
        }
        completeLogoutFailure();
        await flushAsync();
        assertVisible(feedback);
        assertVisible(button);
        assert.equal(button.disabled, false);
        if (ordering === "after-failure") {
          completeJoin();
          await flushAsync();
        }
        assert.equal(completeSessionProbe, undefined);
        assert.equal(sessionRequests, 1, "only initial account discovery is permitted after the entry flow is invalidated");
        assertVisible(feedback);
        assertVisible(button);
        assert.equal(feedback.textContent, "Sign out could not be confirmed. Please try again.");
        assert.equal(button.disabled, false);
        assert.equal(page.navigations.length, 0);
        assert.equal(page.document.getElementById("join-result-player")?.textContent, "");
        assert.equal(page.document.getElementById("join-result")?.hidden, true, "late response cannot restore private player context");
        assert.doesNotMatch(page.document.getElementById("join-claim-status")?.textContent ?? "", /signed in as/i);
        dispatchClick(button);
        await flushAsync();
        assert.equal(logoutRequests, 2);
        if (ordering === "after-retry") { completeJoin(); await flushAsync(); }
        assert.equal(completeSessionProbe, undefined);
        assert.equal(sessionRequests, 1);
        assert.equal(page.document.getElementById("join-result-player")?.textContent, "");
        const playerId = [...apiState.players.values()].find((player) => player.nickname === "New player")?.playerId;
        assert(playerId, "the independent public registration may commit without restoring its old browser flow");
        assert.deepEqual(page.navigations, [{ url: "/sign-in?returnTo=" + encodeURIComponent("/join?code=ABCD2345"), mode: "replace" }]);
      } finally {
        page.dom.window.close();
      }
    });
  }
}

test("sign out continues when optional auth storage fails but proof cleanup is verified", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "admin" });
  const page = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"),
    url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js",
    apiState,
  });
  try {
    Object.defineProperty(page.window, "localStorage", { get: () => { throw new Error("storage blocked"); }, configurable: true });
    const storage = page.window.sessionStorage;
    Object.defineProperty(page.window, "sessionStorage", { value: {
      getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage),
      removeItem(key: string) { if (key === "threefc.auth.callback") throw new Error("auth storage blocked"); storage.removeItem(key); },
    }, configurable: true });
    const button = page.document.getElementById("sign-out");
    assert(button instanceof page.window.HTMLButtonElement);
    dispatchClick(button);
    await flushAsync();
    assert.equal(apiState.session, null);
    assert.deepEqual(page.navigations, [{ url: "/sign-in", mode: "replace" }]);
  } finally {
    page.dom.window.close();
  }
});

test("sign out permits a different account to sign in without redirecting into the old account", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "admin", sessionEmail: "previous@example.com" });
  apiState.storage.set("threefc.auth.return_to", "/games/logout-fixture");
  const baseFetch = createMockFetch(apiState);
  // The general UI fixture deliberately lists all seeded leagues. This
  // account-switch scenario needs the production API's membership filtering.
  const accountScopedFetch: ReturnType<typeof createMockFetch> = async (input, init) => {
    if (new URL(String(input)).pathname === "/v1/leagues" && (init?.method ?? "GET") === "GET") {
      return createJsonResponse(200, {
        leagues: [...apiState.leagues.values()].filter((league) => mockLeagueRoleForSession(apiState, league) !== null),
      });
    }
    return baseFetch(input, init);
  };
  const dashboard = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"), url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js", apiState, fetch: accountScopedFetch,
  });
  const openedPages = [dashboard];
  try {
    assert.equal(dashboard.document.querySelectorAll("#dashboard-leagues-body tr").length, 1, "previous account has a league to clear");
    const button = dashboard.document.getElementById("sign-out");
    assert(button instanceof dashboard.window.HTMLButtonElement);
    dispatchClick(button);
    await flushAsync();
    const signIn = await bootPage({
      html: renderSignInPage("http://localhost:3001", "/setup"), url: "http://localhost:3000/sign-in",
      scriptFile: "auth-flow.js", apiState,
    });
    openedPages.push(signIn);
    assert.equal(signIn.navigations.length, 0, "revoked session must not trigger the existing-session redirect");
    const email = signIn.document.getElementById("auth-email");
    const form = signIn.document.getElementById("auth-magic-form");
    assert(email instanceof signIn.window.HTMLInputElement);
    assert(form instanceof signIn.window.HTMLFormElement);
    email.value = "next@example.com";
    dispatchSubmit(form);
    await flushAsync();
    assert.equal(apiState.pendingEmail, "next@example.com");
    const callback = await bootPage({
      html: renderMagicLinkCallbackPage("http://localhost:3001"), url: "http://localhost:3000/auth/callback?token=token-1",
      scriptFile: "auth-flow.js", apiState,
    });
    openedPages.push(callback);
    const complete = callback.document.querySelector('[data-action="complete-magic-link"]');
    assert(complete instanceof callback.window.HTMLButtonElement);
    dispatchClick(complete);
    await flushAsync();
    assert.equal(apiState.session?.email, "next@example.com");
    assert.deepEqual(callback.navigations, [{ url: "/setup", mode: "replace" }]);
    const nextDashboard = await bootPage({
      html: renderSetupHomePage("http://localhost:3001"), url: "http://localhost:3000/setup",
      scriptFile: "setup-flow.js", apiState, fetch: accountScopedFetch,
    });
    openedPages.push(nextDashboard);
    assert.equal(nextDashboard.document.getElementById("dashboard-welcome")?.textContent, "Welcome");
    assert.equal(nextDashboard.document.querySelectorAll("#dashboard-leagues-body tr").length, 0);
    assert.doesNotMatch(nextDashboard.document.body.textContent ?? "", /previous@example\.com|Three Sided Football Club/);
    const previousLeague = await accountScopedFetch("http://localhost:3001/v1/leagues/three-sided-football-club", { method: "GET" });
    assert.equal(previousLeague.status, 403, "the new account also cannot directly open the previous account's league");
  } finally {
    for (const openedPage of openedPages) openedPage.dom.window.close();
  }
});

test("sign out is available across management and game shells without extra session requests", async () => {
  const api = "http://localhost:3001";
  const cases = [
    { html: renderLeaguePage(api, "three-sided-football-club"), path: "/leagues/three-sided-football-club" },
    { html: renderSeasonPage(api, "autumn-cup", "three-sided-football-club"), path: "/leagues/three-sided-football-club/seasons/autumn-cup" },
    { html: renderSeasonPage(api, "autumn-cup"), path: "/seasons/autumn-cup" },
    // The deployed static fallback initially serves the league shell here.
    { html: renderLeaguePage(api, "three-sided-football-club"), path: "/leagues/three-sided-football-club/seasons/autumn-cup" },
    { html: renderGamePage(api, { gameId: "logout-fixture" }), path: "/games/logout-fixture" },
    { html: renderInvitePage(api, "ABCD2345"), path: "/invites/ABCD2345" },
    { html: renderJoinPage(api, "ABCD2345"), path: "/join/ABCD2345?playerId=player-ari" },
  ];
  for (const item of cases) {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "admin" });
    const baseFetch = createMockFetch(apiState);
    let sessionRequests = 0;
    let logoutRequests = 0;
    const page = await bootPage({
      html: item.html, url: `http://localhost:3000${item.path}`, scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/auth/session") sessionRequests += 1;
        if (path === "/v1/auth/logout") logoutRequests += 1;
        return baseFetch(input, init);
      },
    });
    try {
      const button = page.document.getElementById("sign-out");
      const actions = page.document.getElementById("account-actions");
      assert(button instanceof page.window.HTMLButtonElement, item.path);
      assert(actions instanceof page.window.HTMLElement, item.path);
      assert.equal(actions.hidden, false, item.path);
      assert.equal(button.disabled, false, item.path);
      assert.equal(sessionRequests, 1, `no added auth lookup on ${item.path}`);
      dispatchClick(button);
      await flushAsync();
      assert.equal(logoutRequests, 1, item.path);
      const returnTo = item.path.startsWith("/join") ? "/join?code=ABCD2345&playerId=player-ari"
        : item.path.startsWith("/invites") ? "/invites?code=ABCD2345" : null;
      assert.deepEqual(page.navigations, [{ url: returnTo ? "/sign-in?returnTo=" + encodeURIComponent(returnTo) : "/sign-in", mode: "replace" }], item.path);
    } finally {
      page.dom.window.close();
    }
  }
});

test("sign out checks the account without blocking or redirecting an anonymous join form", async () => {
  const apiState = createMockApiState();
  const paths: string[] = [];
  const page = await bootPage({
    html: renderJoinPage("http://localhost:3001", "ABCD2345"),
    url: "http://localhost:3000/join/ABCD2345", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      paths.push(new URL(String(input)).pathname);
      assert.equal(init?.cache, "no-store");
      return createJsonResponse(401, {});
    },
  });
  try {
    assert.deepEqual(paths, ["/v1/auth/session"]);
    assert.equal(page.navigations.length, 0);
    assert.equal(page.document.getElementById("account-actions")?.hasAttribute("hidden"), true);
    assert.equal(page.document.getElementById("sign-out")?.hasAttribute("disabled"), true);
  } finally {
    page.dom.window.close();
  }
});

test("sign out is offered before a signed-in player submits the initial join form", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "viewer" });
  const baseFetch = createMockFetch(apiState);
  const requests: Array<{ path: string; method: string }> = [];
  const page = await bootPage({
    html: renderJoinPage("http://localhost:3001", "ABCD2345"),
    url: "http://localhost:3000/join/ABCD2345", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
      return baseFetch(input, init);
    },
  });
  try {
    const button = page.document.getElementById("sign-out");
    assert(button instanceof page.window.HTMLButtonElement);
    assert.equal(button.disabled, false);
    assert.equal(page.document.getElementById("account-actions")?.hasAttribute("hidden"), false);
    assert.deepEqual(requests, [{ path: "/v1/auth/session", method: "GET" },
      { path: "/v1/join/ABCD2345/linked-players", method: "GET" }], "account and owned-player discovery never join or claim");
    dispatchClick(button);
    await flushAsync();
    assert.deepEqual(page.navigations, [{ url: "/sign-in?returnTo=" + encodeURIComponent("/join?code=ABCD2345"), mode: "replace" }]);
    assert.deepEqual(requests.at(-1), { path: "/v1/auth/logout", method: "POST" });
  } finally {
    page.dom.window.close();
  }
});

test("sign out session protection hides stale account data on BFCache restoration and reloads once", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "logout-fixture", role: "admin" });
  const page = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"), url: "http://localhost:3000/setup?view=leagues#current",
    scriptFile: "setup-flow.js", apiState,
  });
  try {
    const shell = page.document.querySelector('[data-ui="app-shell"]');
    assert(shell instanceof page.window.HTMLElement);
    page.window.dispatchEvent(new page.window.Event("pageshow"));
    assert.equal(shell.hidden, false);
    assert.equal(page.navigations.length, 0);
    // Another tab has signed out since this document entered the BFCache.
    apiState.session = null;
    apiState.cookieJar = "";
    const restored = new page.window.Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    page.window.dispatchEvent(restored);
    assert.equal(shell.hidden, true, "old account data disappears before the reload request");
    assert.equal(page.document.getElementById("account-revalidation-status")?.textContent, "Checking sign-in state…");
    assert.deepEqual(page.navigations, [{ url: "/setup?view=leagues#current", mode: "reload" }]);
    page.window.dispatchEvent(restored);
    assert.equal(page.navigations.length, 1);
    assert.equal(page.document.querySelectorAll("#account-revalidation-status").length, 1);
    const reloaded = await bootPage({
      html: renderSetupHomePage("http://localhost:3001"), url: "http://localhost:3000/setup?view=leagues#current",
      scriptFile: "setup-flow.js", apiState,
    });
    try {
      assert.equal(reloaded.document.getElementById("account-actions")?.hasAttribute("hidden"), true);
      assert.equal(reloaded.navigations[0]?.mode, "replace");
      assert.match(reloaded.navigations[0]?.url ?? "", /^\/sign-in\?returnTo=/);
    } finally {
      reloaded.dom.window.close();
    }
  } finally {
    page.dom.window.close();
  }
});

test("anonymous join BFCache restoration reloads before reusing the form", async () => {
  const page = await bootPage({
    html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join/ABCD2345",
    scriptFile: "setup-flow.js", apiState: createMockApiState(),
  });
  try {
    const restored = new page.window.Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    page.window.dispatchEvent(restored);
    assert.equal(page.document.querySelector('[data-ui="app-shell"]')?.hasAttribute("hidden"), false);
    assert.deepEqual(page.navigations, [{ url: "http://localhost:3000/join/ABCD2345", mode: "reload" }]);
  } finally {
    page.dom.window.close();
  }
});

test("sign-in page announces an existing-session redirect without exposing identity", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";
  const page = await bootPage({
    html: renderSignInPage("http://localhost:3001", "/setup"),
    url: "http://localhost:3000/sign-in",
    scriptFile: "auth-flow.js",
    apiState,
  });

  const status = page.document.getElementById("auth-status");
  assert(status instanceof page.window.HTMLElement);
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "Sign-in complete. Redirecting…");
  assert.doesNotMatch(page.document.body.textContent ?? "", /organizer@3fc\.football/);
});

test("sign-in request failure uses one actionable alert without duplicate status copy", async () => {
  const apiState = createMockApiState();
  const page = await bootPage({
    html: renderSignInPage("http://localhost:3001", "/setup"),
    url: "http://localhost:3000/sign-in",
    scriptFile: "auth-flow.js",
    apiState,
    fetch: async (input, init) => {
      const target = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
      if (target.pathname === "/v1/auth/session") {
        return createJsonResponse(401, { error: "unauthorized" });
      }
      return createJsonResponse(503, { message: "Please try again shortly." });
    },
  });
  const form = page.document.getElementById("auth-magic-form");
  const emailInput = page.document.getElementById("auth-email");
  assert(form instanceof page.window.HTMLFormElement);
  assert(emailInput instanceof page.window.HTMLInputElement);
  emailInput.value = "organizer@3fc.football";

  dispatchSubmit(form);
  await flushAsync();

  const status = page.document.getElementById("auth-status");
  const error = page.document.getElementById("auth-error");
  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);
  assert.equal(status.hidden, true);
  assert.equal(status.textContent, "");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "We couldn't confirm the email was sent. Check your inbox before trying again.");
});

for (const [httpStatus, expectedMessage] of [
  [400, "The sign-in link could not be sent. Please try again."],
  [429, "Too many requests. Please wait before trying again."],
  [408, "We couldn't confirm the email was sent. Check your inbox before trying again."],
] as const) {
  test(`entry sign-in distinguishes HTTP ${httpStatus} without exposing raw diagnostics`, async () => {
    const apiState = createMockApiState();
    const page = await bootPage({
      html: renderSignInPage("http://localhost:3001", "/setup"),
      url: "http://localhost:3000/sign-in", scriptFile: "auth-flow.js", apiState,
      fetch: async (input) => new URL(String(input)).pathname === "/v1/auth/session"
        ? createJsonResponse(401, {})
        : createJsonResponse(httpStatus, { error: "private-diagnostic-detail" }),
    });
    try {
      const form = page.document.getElementById("auth-magic-form");
      const email = page.document.getElementById("auth-email");
      assert(form instanceof page.window.HTMLFormElement && email instanceof page.window.HTMLInputElement);
      email.value = "player@example.com";
      dispatchSubmit(form);
      await flushAsync();
      assert.equal(page.document.getElementById("auth-error")?.textContent, expectedMessage);
      assert.equal(page.document.getElementById("auth-status")?.hidden, true);
      assert.doesNotMatch(page.document.body.textContent ?? "", /private-diagnostic-detail/);
    } finally { page.window.close(); }
  });
}

for (const responseKind of ["signed-out", "signed-in", "network-error"] as const) {
  for (const phase of ["pending", "sent"] as const) {
    test(`entry sign-in retains ${phase} feedback after a late ${responseKind} session probe`, async () => {
      const apiState = createMockApiState();
      const timers = createManualTimers();
      let settleSession: (() => void) | undefined;
      let finishSend: (() => void) | undefined;
      const requests: string[] = [];
      const page = await bootPage({
        html: renderSignInPage("http://localhost:3001", "/setup"),
        url: "http://localhost:3000/sign-in", scriptFile: "auth-flow.js", apiState, timers,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/auth/session") {
            return new Promise<Response>((resolve, reject) => {
              settleSession = () => responseKind === "network-error"
                ? reject(new Error("offline"))
                : resolve(createJsonResponse(responseKind === "signed-in" ? 200 : 401,
                  responseKind === "signed-in" ? { session: { email: "older@example.com" } } : {}));
            });
          }
          assert.equal(path, "/v1/auth/magic/start");
          requests.push(String(init?.body));
          return new Promise<Response>((resolve) => {
            finishSend = () => resolve(createJsonResponse(202, {}));
          });
        },
      });
      try {
        const form = page.document.getElementById("auth-magic-form");
        const email = page.document.getElementById("auth-email");
        const status = page.document.getElementById("auth-status");
        assert(form instanceof page.window.HTMLFormElement && email instanceof page.window.HTMLInputElement);
        assert(status instanceof page.window.HTMLElement);
        email.value = "original@example.com";
        dispatchSubmit(form);
        dispatchSubmit(form);
        assert.equal(requests.length, 1, "native double submission is latched synchronously");
        assert.equal(JSON.parse(requests[0]).email, "original@example.com");
        email.value = "edited@example.com";
        email.dispatchEvent(new page.window.Event("input", { bubbles: true }));
        assert(finishSend && settleSession);
        if (phase === "sent") { finishSend(); await flushAsync(); }
        settleSession();
        await flushAsync();
        timers.advanceBy(1000);
        await flushAsync();
        assert.equal(status.textContent, phase === "sent"
          ? "Sign-in link sent to original@example.com. Open it to continue."
          : "Sending sign-in link…");
        assert.deepEqual(page.navigations, []);
        if (phase === "pending") { finishSend(); await flushAsync(); }
        assert.equal(status.textContent, "Sign-in link sent to original@example.com. Open it to continue.");
        assert.equal(requests.length, 1);
      } finally { page.window.close(); }
    });
  }
}

for (const validEmail of [true, false]) {
  test(`entry sign-in cancels a scheduled session redirect after ${validEmail ? "sending" : "validation"}`, async () => {
    const apiState = createMockApiState();
    const timers = createManualTimers();
    let sends = 0;
    const page = await bootPage({
      html: renderSignInPage("http://localhost:3001", "/setup"),
      url: "http://localhost:3000/sign-in", scriptFile: "auth-flow.js", apiState, timers,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/auth/session") {
          return createJsonResponse(200, { session: { email: "older@example.com" } });
        }
        sends += 1;
        return createJsonResponse(202, {});
      },
    });
    try {
      assert.equal(timers.pendingCount(), 1);
      const form = page.document.getElementById("auth-magic-form");
      const email = page.document.getElementById("auth-email");
      assert(form instanceof page.window.HTMLFormElement && email instanceof page.window.HTMLInputElement);
      email.value = validEmail ? "new@example.com" : "invalid";
      dispatchSubmit(form);
      await flushAsync();
      timers.advanceBy(500);
      assert.deepEqual(page.navigations, []);
      assert.equal(sends, validEmail ? 1 : 0);
      if (!validEmail) {
        assert.equal(email.getAttribute("aria-invalid"), "true");
        assert.equal(page.document.getElementById("auth-email-notice")?.textContent, "Enter a valid email address.");
      }
    } finally { page.window.close(); }
  });
}

for (const stage of ["organiser-signout", "callback-timer", "callback-response"] as const) {
  test(`failed proof purge blocks authentication navigation: ${stage}`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "purge-fixture", role: "admin" });
    apiState.pendingEmail = "organizer@3fc.football"; apiState.pendingToken = "token-1";
    const timers = createManualTimers();
    const storage = new Map<string, string>();
    const baseFetch = createMockFetch(apiState);
    let requests = 0; let release: (() => void) | undefined;
    const organiser = stage === "organiser-signout";
    const page = await bootPage({
      html: organiser ? renderSetupHomePage("http://localhost:3001") : renderMagicLinkCallbackPage("http://localhost:3001"),
      url: organiser ? "http://localhost:3000/setup" : "http://localhost:3000/auth/callback?token=token-1",
      scriptFile: organiser ? "setup-flow.js" : "auth-flow.js", apiState, timers, sessionStorage: storage,
      fetch: async (input, init) => {
        if (["/v1/auth/logout", "/v1/auth/magic/complete"].includes(new URL(String(input)).pathname)) {
          requests++;
          if (stage === "callback-response") await new Promise<void>(resolve => { release = resolve; });
        }
        return baseFetch(input, init);
      },
    });
    try {
      const proofs = (page.window as any).ThreeFcPlayerProof;
      const retained = await proofs.create("purge-test");
      if (stage === "callback-response") { timers.advanceBy(3000); await flushAsync(); assert(release); }
      page.window.sessionStorage.removeItem = () => { throw new Error("blocked"); };
      page.window.sessionStorage.setItem = () => { throw new Error("blocked"); };
      if (organiser) (page.document.getElementById("sign-out") as HTMLButtonElement).click();
      else { assert.equal(proofs.clear(), false); if (release) release(); else timers.advanceBy(3000); }
      await flushAsync();
      assert.equal(requests, stage === "callback-response" ? 1 : 0);
      assert.deepEqual(page.navigations, []);
      assert.equal(proofs.isBlocked(), true);
      assert.ok(storage.get("threefc.player-proof.v1")!.includes(retained.secret));
      assert.ok(page.document.getElementById("player-proof-purge-recovery"));
    } finally { page.window.close(); }
  });
}

test("auth callback completes once at exactly three seconds", async () => {
  const apiState = createMockApiState();
  apiState.pendingEmail = "organizer@3fc.football";
  apiState.pendingToken = "token-1";
  const timers = createManualTimers();
  const baseFetch = createMockFetch(apiState);
  let completionRequests = 0;
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1&returnTo=%2Fsetup",
    scriptFile: "auth-flow.js",
    apiState,
    timers,
    fetch: async (input, init) => {
      const target = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
      if (target.pathname === "/v1/auth/magic/complete") {
        completionRequests += 1;
      }
      return baseFetch(input, init);
    },
  });

  assert.equal(completionRequests, 0);
  timers.advanceBy(2999);
  await flushAsync();
  assert.equal(completionRequests, 0);
  assert.equal(page.navigations.length, 0);

  timers.advanceBy(1);
  await flushAsync();
  assert.equal(completionRequests, 1);
  assert.deepEqual(page.navigations, [{ url: "/setup", mode: "replace" }]);
  assert.equal(timers.pendingCount(), 0);

});

test("manual callback activation synchronously cancels and latches the timer", async () => {
  const apiState = createMockApiState();
  apiState.pendingEmail = "organizer@3fc.football";
  apiState.pendingToken = "token-1";
  const timers = createManualTimers();
  const baseFetch = createMockFetch(apiState);
  let completionRequests = 0;
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1",
    scriptFile: "auth-flow.js",
    apiState,
    timers,
    fetch: async (input, init) => {
      const target = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
      if (target.pathname === "/v1/auth/magic/complete") {
        completionRequests += 1;
      }
      return baseFetch(input, init);
    },
  });
  const completeButton = page.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof page.window.HTMLButtonElement);
  const nestedTarget = page.document.createElement("span");
  completeButton.append(nestedTarget);

  dispatchClick(nestedTarget);
  dispatchClick(nestedTarget);
  timers.advanceBy(3000);
  await flushAsync();

  assert.equal(completionRequests, 1);
  assert.deepEqual(page.navigations, [{ url: "/setup", mode: "replace" }]);
  assert.equal(timers.pendingCount(), 0);
});

test("timer-boundary callback activation cannot send a duplicate request", async () => {
  const apiState = createMockApiState();
  apiState.pendingEmail = "organizer@3fc.football";
  apiState.pendingToken = "token-1";
  const timers = createManualTimers();
  const baseFetch = createMockFetch(apiState);
  let completionRequests = 0;
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1",
    scriptFile: "auth-flow.js",
    apiState,
    timers,
    fetch: async (input, init) => {
      const target = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
      if (target.pathname === "/v1/auth/magic/complete") {
        completionRequests += 1;
      }
      return baseFetch(input, init);
    },
  });
  const completeButton = page.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof page.window.HTMLButtonElement);

  timers.advanceBy(3000);
  dispatchClick(completeButton);
  await flushAsync();

  assert.equal(completionRequests, 1);
  assert.deepEqual(page.navigations, [{ url: "/setup", mode: "replace" }]);
});

test("transient automatic completion failure requires a manual retry", async () => {
  const apiState = createMockApiState();
  const timers = createManualTimers();
  let completionRequests = 0;
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1&returnTo=%2Fsetup",
    scriptFile: "auth-flow.js",
    apiState,
    timers,
    fetch: async () => {
      completionRequests += 1;
      return createJsonResponse(503, { error: "temporarily_unavailable" });
    },
  });

  timers.advanceBy(3000);
  await flushAsync();
  timers.advanceBy(30000);
  await flushAsync();

  const completeButton = page.document.querySelector('[data-testid="complete-magic-link"]');
  const recoveryLink = page.document.getElementById("auth-callback-recovery");
  assert(completeButton instanceof page.window.HTMLButtonElement);
  assert(recoveryLink instanceof page.window.HTMLAnchorElement);
  assert.equal(completionRequests, 1);
  assert.equal(completeButton.disabled, false);
  assert.equal(recoveryLink.hidden, false);
  assert.equal(timers.pendingCount(), 0);
  const copy = page.document.getElementById("auth-callback-copy");
  assert(copy instanceof page.window.HTMLElement);
  assert.equal(copy.hidden, true, "failure must not promise another automatic redirect");

  dispatchClick(completeButton);
  await flushAsync();
  assert.equal(completionRequests, 2);
  assert.equal(copy.hidden, true, "manual retry does not reintroduce the automatic promise");
});

test("a timed-out committed completion recovers the same session on manual retry", async () => {
  const apiState = createMockApiState();
  const timers = createManualTimers();
  let completionRequests = 0;
  let sessionCreations = 0;
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1&returnTo=%2Fsetup",
    scriptFile: "auth-flow.js",
    apiState,
    timers,
    fetch: async (_input, init) => {
      completionRequests += 1;
      if (completionRequests > 1 && apiState.session) {
        apiState.cookieJar = `threefc_session=${apiState.session.sessionId}`;
        return createJsonResponse(
          200,
          {
            status: "authenticated",
            session: apiState.session,
          },
          {
            headers: {
              "set-cookie": `${apiState.cookieJar}; Path=/; HttpOnly; SameSite=Lax`,
            },
          },
        );
      }

      sessionCreations += 1;
      apiState.session = {
        sessionId: "session-1",
        email: "organizer@3fc.football",
        createdAt: "2026-03-28T11:00:00.000Z",
        expiresAt: "2026-03-29T11:00:00.000Z",
      };
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    },
  });
  const completeButton = page.document.querySelector('[data-testid="complete-magic-link"]');
  const recoveryLink = page.document.getElementById("auth-callback-recovery");
  assert(completeButton instanceof page.window.HTMLButtonElement);
  assert(recoveryLink instanceof page.window.HTMLAnchorElement);

  timers.advanceBy(3000);
  await flushAsync();
  assert.equal(completionRequests, 1);
  assert.equal(completeButton.disabled, true);

  timers.advanceBy(14999);
  await flushAsync();
  assert.equal(completeButton.disabled, true);
  timers.advanceBy(1);
  await flushAsync();

  assert.equal(completeButton.disabled, false);
  assert.equal(recoveryLink.hidden, false);
  assert.equal(apiState.cookieJar, "");
  assert.equal(
    page.document.getElementById("auth-callback-error")?.textContent,
    "Sign in could not be completed. Please try again.",
  );
  assert.equal(page.navigations.length, 0);

  dispatchClick(completeButton);
  await flushAsync();
  assert.equal(completionRequests, 2);
  assert.equal(sessionCreations, 1);
  assert.equal(apiState.cookieJar, "threefc_session=session-1");
  assert.deepEqual(page.navigations, [{ url: "/setup", mode: "replace" }]);
});

test("missing-token and OAuth-error callback states do not start a timer", async () => {
  for (const query of ["", "?error=access_denied"]) {
    const timers = createManualTimers();
    const page = await bootPage({
      html: renderMagicLinkCallbackPage("http://localhost:3001"),
      url: `http://localhost:3000/auth/callback${query}`,
      scriptFile: "auth-flow.js",
      apiState: createMockApiState(),
      timers,
    });
    assert.equal(timers.pendingCount(), 0);
    assert.equal(page.document.querySelectorAll('[role="alert"]').length, 1);
    assert.equal(page.document.getElementById("auth-callback-error")?.hidden, false);
  }
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

  assert.equal(new URL(callbackPage.window.location.href).search, "");
  assert.equal(callbackPage.navigations.length, 0);
  assert.equal(apiState.cookieJar, "");
  assert.equal(callbackPage.document.getElementById("auth-callback-status")?.textContent, "");

  const completeButton = callbackPage.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof callbackPage.window.HTMLButtonElement);
  dispatchClick(completeButton);
  await flushAsync();

  const callbackNavigation = callbackPage.navigations.at(-1);
  assert(callbackNavigation);
  assert.equal(callbackNavigation.url, "/setup");
  assert.equal(apiState.cookieJar, "threefc_session=session-1");
});

test("auth flow rejects unsafe direct and stored return targets", async () => {
  const directState = createMockApiState();
  directState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  directState.cookieJar = "threefc_session=session-1";

  const directPage = await bootPage({
    html: renderSignInPage("http://localhost:3001", "/setup"),
    url: "http://localhost:3000/sign-in?returnTo=https%3A%2F%2Fevil.example",
    scriptFile: "auth-flow.js",
    apiState: directState,
  });
  assert.deepEqual(directPage.navigations.at(-1), { url: "/setup", mode: "replace" });

  const storedState = createMockApiState();
  storedState.pendingEmail = "organizer@3fc.football";
  storedState.pendingToken = "token-1";
  storedState.storage.set("threefc.auth.return_to", "//evil.example");
  const storedPage = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1",
    scriptFile: "auth-flow.js",
    apiState: storedState,
  });
  const completeButton = storedPage.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof storedPage.window.HTMLButtonElement);
  dispatchClick(completeButton);
  await flushAsync();
  assert.deepEqual(storedPage.navigations.at(-1), { url: "/setup", mode: "replace" });
  assert.equal(storedState.storage.has("threefc.auth.return_to"), false);
});

test("auth flow canonicalizes trailing slashes on safe return targets", async () => {
  const apiState = createMockApiState();
  apiState.session = {
    sessionId: "session-1",
    email: "organizer@3fc.football",
    createdAt: "2026-03-28T11:00:00.000Z",
    expiresAt: "2026-03-29T11:00:00.000Z",
  };
  apiState.cookieJar = "threefc_session=session-1";

  const page = await bootPage({
    html: renderSignInPage("http://localhost:3001", "/setup"),
    url: "http://localhost:3000/sign-in?returnTo=%2Fgames%2Fgame-1%2F%3Fmode%3Drun%23latest",
    scriptFile: "auth-flow.js",
    apiState,
  });

  assert.deepEqual(page.navigations.at(-1), {
    url: "/games/game-1?mode=run#latest",
    mode: "replace",
  });
});

test("auth flow never retains secret-bearing profile-link return targets after failed sign-in", async () => {
  const id = "proof-id-for-test-123456";
  for (const target of [`/link-player#proofId=${id}&secret=private-proof-secret`,
    `/link-player/?proofId=${id}&secret=private-proof-secret`, `/link-player?proofId=${id}#secret=private-proof-secret`]) {
    const apiState = createMockApiState();
    apiState.storage.set("threefc.auth.return_to", target);
    const base = createMockFetch(apiState);
    const page = await bootPage({ html: renderSignInPage("http://localhost:3001", "/setup"),
      url: `http://localhost:3000/sign-in?returnTo=${encodeURIComponent(target)}`, scriptFile: "auth-flow.js", apiState,
      fetch: (input, init) => String(input).includes("/auth/magic/start") ? Promise.resolve(createJsonResponse(503, {})) : base(input, init),
    });
    const normalizer = (page.window as unknown as { __THREEFC_NORMALIZE_RETURN_TO__: (value: string) => string | null }).__THREEFC_NORMALIZE_RETURN_TO__;
    assert.equal(normalizer(target), null);
    assert.equal(normalizer(`/link-player/?proofId=${id}`), `/link-player?proofId=${id}`);
    assert.equal(apiState.storage.has("threefc.auth.return_to"), false, "abandoned sign-in must not retain an old secret target");
    (page.document.getElementById("auth-email") as HTMLInputElement).value = "organiser@example.invalid";
    dispatchSubmit(page.document.querySelector("form") as HTMLFormElement); await flushAsync();
    assert.equal(apiState.storage.get("threefc.auth.return_to"), "/setup");
    assert.ok(![...apiState.storage.values()].some(value => value.includes("private-proof-secret")));
  }
});

test("auth callback redacts the URL while retaining recoverable state for transport retries", async () => {
  const apiState = createMockApiState();
  apiState.storage.set("threefc.auth.return_to", "/games/game-1");
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1",
    scriptFile: "auth-flow.js",
    apiState,
    fetch: (async () => {
      throw new Error("network unavailable");
    }) as ReturnType<typeof createMockFetch>,
  });

  assert.equal(new URL(page.window.location.href).search, "");
  assert.equal(
    JSON.parse(page.window.sessionStorage.getItem("threefc.auth.callback") ?? "{}").token,
    "token-1",
  );
  assert.equal(apiState.storage.get("threefc.auth.return_to"), "/games/game-1");

  const completeButton = page.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof page.window.HTMLButtonElement);
  dispatchClick(completeButton);
  await flushAsync();

  assert.equal(completeButton.disabled, false);
  assert.equal(
    page.document.getElementById("auth-callback-error")?.textContent,
    "Sign in could not be completed. Please try again.",
  );
  assert.equal(
    JSON.parse(page.window.sessionStorage.getItem("threefc.auth.callback") ?? "{}").token,
    "token-1",
  );
  assert.equal(apiState.storage.get("threefc.auth.return_to"), "/games/game-1");

  const recoveryLink = page.document.getElementById("auth-callback-recovery");
  assert(recoveryLink instanceof page.window.HTMLAnchorElement);
  recoveryLink.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  assert.equal(page.window.sessionStorage.getItem("threefc.auth.callback"), null);
});

test("auth callback recovers a redacted token after a same-tab reload", async () => {
  const apiState = createMockApiState();
  apiState.pendingEmail = "organizer@3fc.football";
  apiState.pendingToken = "token-1";
  const callbackStorage = new Map<string, string>();

  const firstPage = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1&returnTo=%2Fgames%2Fgame-1",
    scriptFile: "auth-flow.js",
    apiState,
    sessionStorage: callbackStorage,
  });
  assert.equal(new URL(firstPage.window.location.href).search, "");

  const reloadedPage = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback",
    scriptFile: "auth-flow.js",
    apiState,
    sessionStorage: callbackStorage,
  });
  const completeButton = reloadedPage.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof reloadedPage.window.HTMLButtonElement);
  dispatchClick(completeButton);
  await flushAsync();

  assert.deepEqual(reloadedPage.navigations.at(-1), { url: "/games/game-1", mode: "replace" });
  assert.equal(callbackStorage.has("threefc.auth.callback"), false);
});

test("auth callback prefers a safe invite destination and removes sensitive URL parameters", async () => {
  const apiState = createMockApiState();
  apiState.pendingEmail = "organizer@3fc.football";
  apiState.pendingToken = "token-1";
  apiState.storage.set("threefc.auth.return_to", "/games/game-1");
  const callbackStorage = new Map<string, string>([
    [
      "threefc.auth.callback",
      JSON.stringify({
        capturedAt: Date.now(),
        oauthError: true,
        returnTo: "/games/stale-game",
      }),
    ],
  ]);
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=token-1&returnTo=%2Finvites%3Fcode%3DABCD2345&unknown=secret#fragment",
    scriptFile: "auth-flow.js",
    apiState,
    sessionStorage: callbackStorage,
  });

  assert.equal(page.window.location.href, "http://localhost:3000/auth/callback");
  const completeButton = page.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof page.window.HTMLButtonElement);
  dispatchClick(completeButton);
  await flushAsync();

  assert.deepEqual(page.navigations.at(-1), { url: "/invites?code=ABCD2345", mode: "replace" });
  assert.equal(apiState.storage.has("threefc.auth.return_to"), false);
});

test("auth callback replaces credentials on the trailing-slash route", async () => {
  const apiState = createMockApiState();
  apiState.pendingEmail = "organizer@3fc.football";
  apiState.pendingToken = "token-1";
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback/?token=token-1&returnTo=%2Fgames%2Fgame-1#fragment",
    scriptFile: "auth-flow.js",
    apiState,
  });

  assert.equal(page.window.location.href, "http://localhost:3000/auth/callback");
  const completeButton = page.document.querySelector('[data-testid="complete-magic-link"]');
  assert(completeButton instanceof page.window.HTMLButtonElement);
  dispatchClick(completeButton);
  await flushAsync();

  assert.deepEqual(page.navigations.at(-1), { url: "/games/game-1", mode: "replace" });
});

test("auth callback moves focus to recovery after definitive completion failure", async () => {
  const apiState = createMockApiState();
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?token=expired-token&returnTo=%2Fsetup",
    scriptFile: "auth-flow.js",
    apiState,
    fetch: (async () =>
      createJsonResponse(401, {
        error: "invalid_or_expired_magic_link",
        message: "Invalid or expired magic link.",
      })) as ReturnType<typeof createMockFetch>,
  });

  const completeButton = page.document.querySelector('[data-testid="complete-magic-link"]');
  const recoveryLink = page.document.getElementById("auth-callback-recovery");
  assert(completeButton instanceof page.window.HTMLButtonElement);
  assert(recoveryLink instanceof page.window.HTMLAnchorElement);
  dispatchClick(completeButton);
  await flushAsync();

  assert.equal(completeButton.hidden, true);
  assert.equal(recoveryLink.hidden, false);
  assert.equal(page.document.activeElement, recoveryLink);
  assert.equal(recoveryLink.getAttribute("href"), "/sign-in?returnTo=%2Fsetup");
  assert.equal(page.window.sessionStorage.getItem("threefc.auth.callback"), null);
});

test("auth callback never combines stored credentials with a fresh non-credential envelope", async () => {
  const apiState = createMockApiState();
  const callbackStorage = new Map<string, string>([
    [
      "threefc.auth.callback",
      JSON.stringify({
        capturedAt: Date.now(),
        token: "stored-token",
        returnTo: "/games/game-1",
      }),
    ],
  ]);
  const page = await bootPage({
    html: renderMagicLinkCallbackPage("http://localhost:3001"),
    url: "http://localhost:3000/auth/callback?returnTo=%2Finvites%3Fcode%3DATTACKER#fragment",
    scriptFile: "auth-flow.js",
    apiState,
    sessionStorage: callbackStorage,
  });

  assert.equal(page.window.location.href, "http://localhost:3000/auth/callback");
  assert.equal(page.document.querySelector('[data-testid="complete-magic-link"]')?.hasAttribute("hidden"), true);
  assert.equal(
    page.document.getElementById("auth-callback-error")?.textContent,
    "Sign in failed. The callback link is incomplete.",
  );
  assert.equal(callbackStorage.has("threefc.auth.callback"), false);
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
  assert.equal(dashboard.document.getElementById("dashboard-welcome")?.textContent, "Welcome");
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

test("populated dashboard keeps leagues view-only with creation below the list", async () => {
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
  assert.equal(page.document.getElementById("dashboard-welcome")?.textContent, "Welcome");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(region.hidden, true);
  const leagueRow = page.document.querySelector("#dashboard-leagues-body tr");
  assert(leagueRow instanceof page.window.HTMLTableRowElement);
  assert.equal(leagueRow.children.length, 1);
  assert.equal(leagueRow.children[0]?.getAttribute("data-label"), "League");
  assert(leagueRow.children[0]?.querySelector('a[href="/leagues/autumn-league"]'));
  assert.equal(leagueRow.querySelectorAll("a").length, 1);
  assert.equal(leagueRow.querySelector("button"), null);
  assert.doesNotMatch(leagueRow.textContent ?? "", /autumn-league|friendly/i);

  dispatchClick(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(region.hidden, false);
  assert.equal(page.document.activeElement?.id, "league-name");

  assert.equal(page.document.querySelector('[data-action="delete-league"]'), null);
  assert.equal(apiState.leagues.has("autumn-league"), true);
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
  const activityStatus = page.document.getElementById("setup-status");
  assert(toggle instanceof page.window.HTMLButtonElement);
  assert(region instanceof page.window.HTMLElement);
  assert(activityStatus instanceof page.window.HTMLElement);
  assert.equal(activityStatus.getAttribute("data-ui"), "activity-status");
  assert.equal(activityStatus.getAttribute("data-activity"), "loading");
  assert.equal(activityStatus.getAttribute("data-state"), null);
  assert.equal(activityStatus.textContent, "Loading page…");
  assert(activityStatus.querySelector('[data-icon="loader-circle"][aria-hidden="true"]'));
  assert(activityStatus.querySelector('[data-ui="activity-message"]')?.classList.contains("sr-only"));
  assert.doesNotMatch(activityStatus.textContent ?? "", /Signed in as|Session active/);
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
  assert.equal(activityStatus.hidden, true);
  assert.equal(activityStatus.textContent, "");
});

test("dashboard uses a neutral greeting instead of guessing a name from email", async () => {
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

  assert.equal(page.document.getElementById("dashboard-welcome")?.textContent, "Welcome");
  assert.doesNotMatch(page.document.body.textContent ?? "", /\.\.\.@example.com/);
});

test("organiser shell dashboard makes no per-league authority or summary requests", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
  const requests: string[] = [];
  const baseFetch = createMockFetch(apiState);
  const page = await bootPage({
    html: renderSetupHomePage("http://localhost:3001"), url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return baseFetch(input, init);
    },
  });
  try {
    assert.deepEqual(requests, ["GET /v1/auth/session", "GET /v1/leagues"]);
    assert.equal(page.document.querySelector("#dashboard-leagues-body button"), null);
    assert.equal(page.document.querySelectorAll('#dashboard-leagues-body a[href^="/leagues/"]').length, 1);
    const list = page.document.getElementById("dashboard-leagues-body");
    const create = page.document.querySelector('[data-action="toggle-create-league"]');
    assert(list && create);
    assert(list.compareDocumentPosition(create) & page.window.Node.DOCUMENT_POSITION_FOLLOWING);
  } finally { page.dom.window.close(); }
});

for (const kind of ["league", "season"] as const) {
  test(`organiser shell ${kind} creation latches native submit and SVG clicks and preserves uncertain attempts`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
    const baseFetch = createMockFetch(apiState);
    const route = kind === "league" ? "/v1/leagues" : "/v1/leagues/three-sided-football-club/seasons";
    const attempts: Array<{ path: string; body: string; key: string | null }> = [];
    let loseResponse: (() => void) | undefined;
    let committedBody: unknown;
    const page = await bootPage({
      html: kind === "league" ? renderSetupHomePage("http://localhost:3001") : renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
      url: `http://localhost:3000/${kind === "league" ? "setup" : "leagues/three-sided-football-club"}`,
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname !== route || init?.method !== "POST") return baseFetch(input, init);
        attempts.push({ path: route, body: String(init.body), key: new Headers(init.headers).get("Idempotency-Key") });
        if (attempts.length === 1) {
          const response = await baseFetch(input, init);
          committedBody = await response.json();
          return new Promise<Response>((_resolve, reject) => { loseResponse = () => reject(new Error("lost response")); });
        }
        return createJsonResponse(201, committedBody);
      },
    });
    try {
      const form = page.document.getElementById(`create-${kind}-form`);
      const name = page.document.getElementById(`${kind}-name`);
      const submit = page.document.querySelector(`[data-action="create-${kind}"]`);
      const toggle = page.document.querySelector(`[data-action="toggle-create-${kind}"]`);
      assert(form instanceof page.window.HTMLFormElement);
      assert(name instanceof page.window.HTMLInputElement);
      assert(submit instanceof page.window.HTMLButtonElement);
      assert(toggle instanceof page.window.HTMLButtonElement);
      dispatchClick(toggle);
      name.value = "Original name";
      name.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      assert.equal(submit.type, "submit");
      form.requestSubmit(); // Native form activation, also used by Enter in the browser.
      submit.innerHTML = '<svg aria-hidden="true"><path d="M0 0h1"/></svg>';
      const path = submit.querySelector("path");
      assert(path);
      path.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
      form.requestSubmit();
      await flushAsync();
      assert.equal(attempts.length, 1);
      assert.equal(submit.disabled, true);
      assert(loseResponse);
      name.value = "Edited while pending";
      name.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      loseResponse();
      await flushAsync();
      assert.equal(submit.disabled, false);
      assert.equal(name.value, "Edited while pending");
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed.*original details/);
      form.requestSubmit();
      await flushAsync();
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[1], attempts[0]);
      assert(attempts[0].key);
      assert.equal(JSON.parse(attempts[0].body).name, "Original name");
      assert.equal(page.navigations.length, 1);
      assert.match(page.navigations[0].url, /original-name$/);
      assert.equal(submit.disabled, true, "confirmed navigation retains the latch");
    } finally { page.dom.window.close(); }
  });
}

for (const surface of ["league", "season"] as const) {
  for (const role of ["admin", "scorekeeper", "viewer", "missing", "claimed-player", "cross-league-admin", "unavailable"] as const) {
    test(`organiser shell ${surface} authority is fail-closed for ${role}`, async () => {
      const apiState = createMockApiState();
      seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: role === "admin" || role === "scorekeeper" ? role : "viewer" });
      const baseFetch = createMockFetch(apiState);
      const leaguePath = "/v1/leagues/three-sided-football-club";
      let parentReads = 0;
      let writes = 0;
      if (role === "claimed-player") {
        const player = apiState.players.get("player-ari");
        assert(player && apiState.session);
        player.claimedByUserId = apiState.session.email;
      }
      if (role === "cross-league-admin") {
        assert(apiState.session);
        grantMockLeagueAccess(apiState, "another-league", apiState.session.email, "admin");
      }
      const page = await bootPage({
        html: surface === "league" ? renderLeaguePage("http://localhost:3001", "three-sided-football-club") : renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
        url: `http://localhost:3000/leagues/three-sided-football-club${surface === "season" ? "/seasons/autumn-cup#create-game" : ""}`,
        scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (init?.method === "POST" || init?.method === "DELETE") writes += 1;
          if (path === leaguePath && (init?.method ?? "GET") === "GET") {
            parentReads += 1;
            if (role === "unavailable") return createJsonResponse(503, { error: "unavailable" });
            if (role === "missing" || role === "claimed-player") return createJsonResponse(200, apiState.leagues.get("three-sided-football-club"));
          }
          return baseFetch(input, init);
        },
      });
      try {
        assert.equal(parentReads, 1);
        if (surface === "season") {
          const link = page.document.getElementById("season-players-link");
          const permitted = role === "admin" || role === "scorekeeper";
          assert.equal(Boolean(link), permitted);
          if (permitted) {
            assert.equal(link?.textContent?.trim(), "Manage players");
            assert.equal(link?.getAttribute("href"), "/leagues/three-sided-football-club?seasonId=autumn-cup#players");
            assert.equal(link?.parentElement?.id, "season-actions");
            const menu = link?.closest('[data-ui="action-menu"]');
            assert.equal(menu?.hasAttribute("hidden"), false);
            const trigger = menu?.querySelector('button[data-action="toggle-action-menu"]');
            assert(trigger instanceof page.window.HTMLButtonElement);
            const icon = trigger.querySelector('[data-icon]');
            assert(icon);
            icon.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
            assert.equal(trigger.getAttribute("aria-expanded"), "true");
            assert.equal(page.document.querySelector('[data-action="delete-season"]')?.hasAttribute("disabled"), role !== "admin");
          }
        }
        const toggle = page.document.querySelector(`[data-action="toggle-create-${surface === "league" ? "season" : "game"}"]`);
        assert(toggle instanceof page.window.HTMLButtonElement);
        assert.equal(toggle.disabled, role !== "admin");
        assert.equal(toggle.hidden, role !== "admin");
        assert.equal(page.document.querySelectorAll("tbody [data-action^='delete-']").length, role === "admin" ? 1 : 0);
        if (role !== "admin") {
          dispatchClick(toggle);
          for (const form of page.document.querySelectorAll<HTMLFormElement>("form[data-ui='management-form']")) dispatchSubmit(form);
          assert.equal(writes, 0);
          assert.equal(toggle.getAttribute("aria-expanded"), "false");
          assert.equal(page.document.getElementById(surface === "league" ? "league-create-season-region" : "season-create-game-region")?.hidden, true);
        }
        if (surface === "season") {
          assert(page.document.querySelector('a[href="/games/shell-fixture"]'), "parent metadata failure must not prevent permitted game reads");
          assert.equal(page.document.getElementById("season-breadcrumb-name")?.textContent, "Autumn Cup");
          if (role !== "unavailable") assert.equal(page.document.getElementById("season-league-link")?.textContent, "Three Sided Football Club");
          if (role === "unavailable") {
            const error = page.document.getElementById("setup-error");
            assert(error instanceof page.window.HTMLElement);
            assert.equal(error.hidden, false);
            assert.equal(error.textContent, "League details couldn’t be loaded. Reload this page to try again.");
          }
        }
      } finally { page.dom.window.close(); }
    });
  }
}

test("organiser shell keeps authority hidden while the parent request is pending", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  let finish: (() => void) | undefined;
  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup#create-game",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/leagues/three-sided-football-club") {
        return new Promise<Response>((resolve) => { finish = () => { void baseFetch(input, init).then(resolve); }; });
      }
      return baseFetch(input, init);
    },
  });
  try {
    const toggle = page.document.querySelector('[data-action="toggle-create-game"]');
    assert(toggle instanceof page.window.HTMLButtonElement);
    assert.equal(toggle.hidden, true);
    assert.equal(toggle.disabled, true);
    assert.equal(page.document.getElementById("season-create-game-region")?.hidden, true);
    assert(finish);
    finish();
    await flushAsync();
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.disabled, false);
    assert.equal(page.document.getElementById("season-create-game-region")?.hidden, false);
  } finally { page.dom.window.close(); }
});

test("league player creation suggests verified possible matches without merging or blocking a different person", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "directory-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  const queries: URLSearchParams[] = [];
  const page = await bootPage({ html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club#players", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== "/v1/league-players") return baseFetch(input, init);
      assert.notEqual(init?.method, "POST", "suggestions do not create or combine identities");
      queries.push(url.searchParams);
      return createJsonResponse(200, { players: [{ playerId: "existing", nickname: "Kesh <script>", claimed: false,
        seasons: [{ seasonId: "autumn-cup", name: "Autumn Cup" }], hasMoreSeasons: false }], cursor: null });
    } });
  try {
    dispatchClick(page.document.getElementById("league-player-create-toggle")!);
    const input = page.document.getElementById("league-player-name") as HTMLInputElement;
    input.value = "Kesh"; input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 220)); await flushAsync();
    const suggestions = page.document.getElementById("league-player-name-matches")!;
    assert.equal(suggestions.hidden, false);
    assert.equal(suggestions.querySelector('[data-ui="player-identity"] strong')?.textContent, "Kesh <script>");
    assert.equal(suggestions.querySelector('[data-ui="player-context"]')?.textContent, "Autumn Cup");
    assert.equal(suggestions.querySelector("script"), null);
    assert.equal(queries.at(-1)?.get("query"), "Kesh");
    assert.equal(queries.at(-1)?.get("limit"), "10");
    assert.equal(queries.at(-1)?.has("seasonId"), false);
    assert.equal((page.document.getElementById("league-player-create") as HTMLButtonElement).disabled, false);
    dispatchClick(suggestions.querySelector("button")!); await flushAsync();
    assert.equal(page.document.getElementById("league-player-create-region")!.hidden, true);
    assert.equal(page.document.activeElement?.id, "league-player-search");
    assert.equal(input.value, "Kesh", "checking an existing identity preserves the creation draft");
  } finally { page.dom.window.close(); }
});

for (const refreshFails of [false, true]) test(`league directory removes deleted season scope after commit, refresh failure=${refreshFails}`, async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "directory-fixture", role: "admin" });
  const season = apiState.seasons.get("autumn-cup")!;
  const baseFetch = createMockFetch(apiState), queries: URLSearchParams[] = [];
  let reads = 0, release: ((response: Response) => void) | undefined;
  const page = await bootPage({ html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club?seasonId=autumn-cup#players", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/league-players") {
        queries.push(url.searchParams);
        if (queries.length === 1) return new Promise<Response>(resolve => { release = resolve; });
        return createJsonResponse(200, { players: [{ playerId: "remaining", nickname: "Remaining", claimed: false, seasons: [], hasMoreSeasons: false }], cursor: null });
      }
      if (url.pathname === "/v1/leagues/three-sided-football-club/seasons") {
        if (++reads > 1 && refreshFails) throw new Error("refresh failed");
        return createJsonResponse(200, { seasons: reads === 1 ? [season] : [] });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return baseFetch(input, init);
    } });
  try {
    const scope = page.document.getElementById("league-player-scope") as HTMLSelectElement;
    assert.equal(scope.value, "autumn-cup");
    Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
    dispatchClick(page.document.querySelector('#league-seasons-body [data-action="delete-season"]')!);
    await flushAsync();
    assert.equal(scope.value, "");
    assert.deepEqual([...scope.options].map(option => option.textContent), ["All league players"]);
    assert.equal(queries.at(-1)?.has("seasonId"), false);
    assert(release); release(createJsonResponse(200, { players: [{ playerId: "obsolete", nickname: "Obsolete", claimed: false, seasons: [], hasMoreSeasons: false }], cursor: "obsolete-cursor" }));
    await flushAsync();
    assert.doesNotMatch(page.document.getElementById("league-player-list")!.textContent ?? "", /Obsolete/);
    assert.match(page.document.getElementById("league-player-list")!.textContent ?? "", /Remaining/);
    assert.equal(page.document.getElementById("league-player-more")!.hidden, true);
  } finally { page.dom.window.close(); }
});

test("league directory paginates submitted search, keeps equal names distinct and moves owned exhausted-page focus", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "directory-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  const queries: URLSearchParams[] = [];
  const page = await bootPage({ html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club?seasonId=autumn-cup#players", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== "/v1/league-players") return baseFetch(input, init);
      queries.push(url.searchParams);
      const second = url.searchParams.has("cursor");
      return createJsonResponse(200, { players: [{ playerId: second ? "second" : "first", nickname: "Kesh <script>",
        claimed: second, seasons: [{ seasonId: "autumn-cup", name: "Autumn Cup" }], hasMoreSeasons: false }], cursor: second ? null : "page-two" });
    },
  });
  try {
    const list = page.document.getElementById("league-player-list")!;
    const search = page.document.getElementById("league-player-search") as HTMLInputElement;
    const more = page.document.getElementById("league-player-more") as HTMLButtonElement;
    assert.equal(queries[0].get("seasonId"), "autumn-cup");
    assert.equal(list.children.length, 1);
    assert.equal(list.querySelector("script"), null);
    search.value = "not yet submitted";
    search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    more.focus(); dispatchClick(more); await flushAsync();
    assert.equal(queries[1].get("query"), "", "cursor stays bound to submitted query, not edited text");
    assert.equal(queries[1].get("cursor"), "page-two");
    assert.equal(list.children.length, 2, "equal nicknames are not merged");
    assert.equal(more.hidden, true);
    assert.equal(page.document.activeElement, page.document.getElementById("league-player-status"));
    assert.match(list.textContent ?? "", /Linked to an account/);
    assert.match(list.textContent ?? "", /Not linked to an account/);
    page.window.location.hash = "#seasons";
    page.window.dispatchEvent(new page.window.HashChangeEvent("hashchange"));
    assert.equal(page.document.getElementById("league-players-region")!.hidden, true);
    assert.equal(page.document.querySelector<HTMLElement>('[data-testid="panel-league-seasons"]')!.hidden, false);
  } finally { page.dom.window.close(); }
});

test("league directory search automatically follows physical pages to every matching player", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "directory-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  const queries: URLSearchParams[] = [];
  const page = await bootPage({ html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club?seasonId=autumn-cup#players", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== "/v1/league-players") return baseFetch(input, init);
      if (!url.searchParams.get("query")) return createJsonResponse(200, { players: [], cursor: null });
      queries.push(url.searchParams);
      const cursor = url.searchParams.get("cursor");
      const players = cursor ? [{ playerId: cursor, nickname: "Gavin", claimed: false, seasons: [], hasMoreSeasons: false }] : [];
      return createJsonResponse(200, { players, cursor: cursor === "last" ? null : cursor ? "last" : "middle", searchIncomplete: !cursor });
    } });
  try {
    (page.document.getElementById("league-player-search") as HTMLInputElement).value = "Gavin";
    page.document.getElementById("league-player-search-form")!.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushAsync(); await flushAsync();
    assert.equal(queries.length, 3);
    assert.ok(queries.every(query => query.get("query") === "Gavin" && query.get("seasonId") === "autumn-cup"));
    assert.deepEqual([...page.document.querySelectorAll("#league-player-list > li")].map(row => row.getAttribute("data-player-id")), ["middle", "last"]);
    assert.equal((page.document.getElementById("league-player-more") as HTMLElement).hidden, true);
    assert.doesNotMatch(page.document.getElementById("league-player-status")!.textContent || "", /No players|No matches/);
  } finally { page.dom.window.close(); }
});

test("league directory creation retains original identity after ambiguous commit and later rejection", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "directory-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  const attempts: Array<{ playerId: string; nickname: string }> = [];
  const page = await bootPage({ html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club#players", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname !== "/v1/league-players") return baseFetch(input, init);
      if (init?.method !== "POST") return createJsonResponse(200, { players: [], cursor: null });
      const body = JSON.parse(String(init.body)); attempts.push(body);
      if (attempts.length === 1) throw new Error("committed response lost");
      if (attempts.length === 2) return createJsonResponse(403, { error: "forbidden", message: "private raw detail" });
      return createJsonResponse(201, { player: body });
    },
  });
  try {
    dispatchClick(page.document.getElementById("league-player-create-toggle")!);
    const name = page.document.getElementById("league-player-name") as HTMLInputElement;
    const form = page.document.getElementById("league-player-create-form")!;
    name.value = "Xavier";
    for (let index = 0; index < 3; index += 1) {
      form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true })); await flushAsync();
      if (index < 2) {
        assert.equal(name.readOnly, true);
        assert.match(page.document.getElementById("league-player-status")!.textContent ?? "", /Retry sends the same player entry/);
      }
    }
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts[1], attempts[0]); assert.deepEqual(attempts[2], attempts[0]);
    assert.deepEqual(Object.keys(attempts[0]).sort(), ["nickname", "playerId"]);
    assert.equal(name.readOnly, false); assert.equal(name.value, "");
    assert.doesNotMatch(page.document.body.textContent ?? "", /private raw detail/);
  } finally { page.dom.window.close(); }
});

test("league directory private invitation works without a game and reuses revocation and sign-out cleanup", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "directory-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  const paths: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let metadata: { proofId: string; expiresAt: string; state: string } | null = null;
  const page = await bootPage({ html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club#players", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/league-players") return createJsonResponse(200, { players: [
        { playerId: "standalone/player", nickname: "Xavier", claimed: false, seasons: [], hasMoreSeasons: false },
      ], cursor: null });
      if (!url.pathname.startsWith("/v1/player-proofs/league-invitation")) return baseFetch(input, init);
      paths.push(url.pathname); assert.equal(url.searchParams.get("leagueId"), "three-sided-football-club");
      assert.equal(url.searchParams.get("playerId"), "standalone/player"); assert.equal(url.searchParams.has("gameId"), false);
      if (init.method === "GET") return createJsonResponse(200, { invitation: metadata });
      const body = JSON.parse(String(init.body)); bodies.push(body);
      if (url.pathname.endsWith("/revoke")) return createJsonResponse(200, { revoked: true });
      metadata = { proofId: body.proofId, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), state: "pending" };
      return createJsonResponse(201, { invitation: metadata });
    },
  });
  try {
    const action = page.document.querySelector<HTMLElement>('[data-action="invite-player-profile"]')!;
    const menu = openActionMenuFor(action);
    dispatchClick(action.querySelector('[data-icon="user-round-plus"]')!); await flushAsync();
    assert.equal(bodies.length, 0, "opening is read-only");
    assert.match(page.document.getElementById("player-invitation-title")!.textContent ?? "", /Xavier/);
    const create = page.document.getElementById("player-invitation-create")!;
    dispatchClick(create); dispatchClick(create);
    for (let tick = 0; tick < 100 && bodies.length === 0; tick += 1) await new Promise(resolve => setTimeout(resolve, 2));
    await flushAsync(); assert.equal(bodies.length, 1);
    assert.deepEqual(Object.keys(bodies[0]).sort(), ["proofId", "replacesProofId", "verifier"]);
    const link = page.document.getElementById("player-invitation-link") as HTMLInputElement;
    assert.equal(new URL(link.value).pathname, "/link-player");
    assert.equal(new URL(link.value).search, "");
    assert.equal(Boolean(new URL(link.value).hash), true);
    Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
    dispatchClick(page.document.getElementById("player-invitation-revoke")!); await flushAsync();
    assert.equal(paths.at(-1), "/v1/player-proofs/league-invitation/revoke");
    assert.equal(link.value, "");
    dispatchClick(page.document.getElementById("player-invitation-close")!);
    assert.equal(page.document.activeElement, menu.trigger);
    page.window.dispatchEvent(new page.window.Event("threefc:player-proof-cleared"));
    assert.equal(page.document.getElementById("player-invitation-panel")!.hidden, true);
  } finally { page.dom.window.close(); }
});

test("league directory unavailable is not an empty result and never grants scorer creation", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "directory-fixture", role: "scorekeeper" });
  const baseFetch = createMockFetch(apiState);
  const page = await bootPage({ html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club#players", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => new URL(String(input)).pathname === "/v1/league-players"
      ? createJsonResponse(503, { error: "unavailable" }) : baseFetch(input, init),
  });
  try {
    assert.match(page.document.getElementById("league-player-status")!.textContent ?? "", /temporarily unavailable/);
    assert.doesNotMatch(page.document.getElementById("league-players-region")!.textContent ?? "", /No players found/);
    assert.equal((page.document.getElementById("league-player-create-toggle") as HTMLButtonElement).disabled, true);
  } finally { page.dom.window.close(); }
});

test("organiser shell disclosure cancellation preserves drafts, nested options and focus", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
  const page = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club", scriptFile: "setup-flow.js", apiState,
  });
  try {
    const toggle = page.document.querySelector('[data-action="toggle-create-season"]');
    const region = page.document.getElementById("league-create-season-region");
    const name = page.document.getElementById("season-name");
    const cancel = region?.querySelector('[data-action="cancel-disclosure"]');
    const options = region?.querySelector("details");
    assert(toggle instanceof page.window.HTMLButtonElement && region instanceof page.window.HTMLElement);
    assert(name instanceof page.window.HTMLInputElement && cancel instanceof page.window.HTMLButtonElement);
    assert(options instanceof page.window.HTMLDetailsElement);
    const menu = openActionMenuFor(toggle);
    dispatchClick(toggle);
    name.value = "An unfinished season";
    options.open = true;
    options.dispatchEvent(new page.window.Event("toggle"));
    assert.equal(region.hidden, false);
    cancel.focus();
    dispatchClick(cancel);
    assert.equal(region.hidden, true);
    assert.equal(page.document.activeElement, menu.trigger);
    assert.equal(interactionVisible(menu.trigger), true);
    openActionMenuFor(toggle);
    dispatchClick(toggle);
    assert.equal(name.value, "An unfinished season");
    assert.equal(options.open, true);
    name.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(region.hidden, true);
    assert.equal(page.document.activeElement, menu.trigger);
    assert.equal(interactionVisible(menu.trigger), true);
    const action = page.document.querySelector('#league-actions button');
    assert(action instanceof page.window.HTMLButtonElement);
    const { trigger, surface } = openActionMenuFor(action);
    action.focus();
    action.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(surface.hidden, true);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(page.document.activeElement, trigger);
  } finally { page.dom.window.close(); }
});

test("organiser shell displays date-only ranges without timezone shifts or missing-date filler", async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "viewer" });
  const season = apiState.seasons.get("autumn-cup");
  assert(season);
  apiState.seasons.clear();
  for (const [id, startsOn, endsOn] of [
    ["both", "2026-03-01", "2026-08-31"], ["start", "2026-03-01", null],
    ["end", null, "2026-08-31"], ["none", null, null],
  ]) apiState.seasons.set(String(id), { ...season, seasonId: String(id), name: String(id), startsOn, endsOn });
  let page: Awaited<ReturnType<typeof bootPage>> | undefined;
  try {
    page = await bootPage({
      html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
      url: "http://localhost:3000/leagues/three-sided-football-club", scriptFile: "setup-flow.js", apiState,
    });
    const dates = [...page.document.querySelectorAll('#league-seasons-body [data-label="Dates"]')].map((cell) => cell.textContent);
    assert.deepEqual(dates, ["1 Mar 2026 – 31 Aug 2026", "Starts 1 Mar 2026", "Ends 31 Aug 2026", "Dates not set"]);
  } finally {
    page?.dom.window.close();
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
  }
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
  apiState.seasons.set("autumn-2026", {
    leagueId: "autumn-league",
    seasonId: "autumn-2026",
    name: "Autumn 2026",
    slug: "autumn-2026",
    startsOn: "2026-03-01",
    endsOn: "2026-05-31",
    createdAt: "2026-03-28T11:00:01.000Z",
    updatedAt: "2026-03-28T11:00:01.000Z",
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
  const seasonsTable = leaguePage.document.querySelector('[data-testid="league-seasons-table"] table');
  const seasonRow = leaguePage.document.querySelector("#league-seasons-body tr");
  assert(seasonsTable instanceof leaguePage.window.HTMLTableElement);
  assert.deepEqual(
    [...seasonsTable.querySelectorAll("thead th")].map((heading) => heading.textContent),
    ["Season name", "Dates", "Actions"],
  );
  assert(seasonRow instanceof leaguePage.window.HTMLTableRowElement);
  assert.deepEqual(
    [...seasonRow.children].map((cell) => cell.getAttribute("data-label")),
    ["Season name", "Dates", "Actions"],
  );
  assert(seasonRow.querySelector('a[href="/leagues/autumn-league/seasons/autumn-2026"]'));
  assert.equal(seasonRow.querySelectorAll("a").length, 1);
  assert(seasonRow.querySelector('[aria-label="Delete Autumn 2026"] [data-icon="trash-2"]'));
  assert.doesNotMatch(seasonRow.textContent ?? "", /autumn-2026|friendly/i);

  assert.equal(apiState.lastOrganiserInviteRequest, null);
  assert.equal(inviteRegion.hidden, true);
  openActionMenuFor(createSeasonToggle);
  dispatchClick(createSeasonToggle);
  assert.equal(createSeasonRegion.hidden, false);
  assert.equal(leaguePage.document.activeElement?.id, "season-name");
  const leagueMenu = openActionMenuFor(inviteToggle);
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
  const cancelInvite = inviteRegion.querySelector('[data-action="cancel-disclosure"]');
  assert(cancelInvite instanceof leaguePage.window.HTMLButtonElement);
  cancelInvite.focus();
  dispatchClick(cancelInvite);
  assert.equal(inviteRegion.hidden, true);
  assert.equal(leaguePage.document.activeElement, leagueMenu.trigger);
  assert.equal(interactionVisible(leagueMenu.trigger), true);
  openActionMenuFor(inviteToggle);
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

  assert.equal(leaguePage.document.getElementById("setup-status")?.hidden, true);
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
  assert.equal(leaguePage.document.getElementById("setup-status")?.hidden, true);
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
    "",
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

for (const outcome of ["sent", "unknown", "failure"] as const) {
  for (const disclosureAction of ["close", "close and reopen", "open create season"] as const) {
    test(`pending organiser email ${outcome} remains visible after ${disclosureAction}`, async (t) => {
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
      const requestedKeys: string[] = [];
      let finishInvite: (() => Promise<void>) | undefined;
      let recoveryHref: string | undefined;
      const deferredFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
        const target = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
        if ((init.method ?? "GET").toUpperCase() === "POST" && target.pathname === "/v1/leagues/autumn-league/organiser-invites") {
          const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
          if (typeof body.email === "string" && body.email.trim()) {
            const key = readInitHeader(init, "idempotency-key");
            assert(key);
            requestedKeys.push(key);
            if (requestedKeys.length === 1) {
              return new Promise<Response>((resolveResponse) => {
                finishInvite = async () => {
                  if (outcome === "failure") {
                    resolveResponse(createJsonResponse(503, { error: "temporary_failure", message: "Temporary failure." }));
                    return;
                  }
                  const response = await defaultFetch(input, init);
                  if (outcome === "unknown") {
                    const payload = await response.json() as { inviteLink: string; emailDelivery: { status: string } };
                    recoveryHref = payload.inviteLink;
                    payload.emailDelivery.status = "unknown";
                    resolveResponse(createJsonResponse(202, payload));
                    return;
                  }
                  resolveResponse(response);
                };
              });
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
        fetch: deferredFetch,
      });
      t.after(() => page.window.close());
      const inviteToggle = page.document.querySelector('[data-testid="toggle-organiser-invite"]');
      const seasonToggle = page.document.querySelector('[data-testid="toggle-create-season"]');
      const sendButton = page.document.querySelector('[data-testid="create-organiser-invite"]');
      const inviteRegion = page.document.getElementById("league-organiser-invite-region");
      const seasonRegion = page.document.getElementById("league-create-season-region");
      const emailInput = page.document.getElementById("organiser-invite-email");
      const status = page.document.getElementById("organiser-invite-email-status");
      assert(inviteToggle instanceof page.window.HTMLButtonElement);
      assert(seasonToggle instanceof page.window.HTMLButtonElement);
      assert(sendButton instanceof page.window.HTMLButtonElement);
      assert(inviteRegion instanceof page.window.HTMLElement);
      assert(seasonRegion instanceof page.window.HTMLElement);
      assert(emailInput instanceof page.window.HTMLInputElement);
      assert(status instanceof page.window.HTMLElement);

      const assertSingleVisibleOutcome = (expected: string): void => {
        assert.equal(status.textContent, expected);
        assert.equal(status.closest("[hidden]"), null, "Invite feedback must not inherit a hidden disclosure");
        assert.equal(status.getAttribute("role"), "status");
        assert.equal(status.getAttribute("aria-live"), "polite");
        assert.equal(page.document.querySelectorAll("#organiser-invite-email-status").length, 1);
        const visibleOutcomeRegions = [...page.document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
          .filter((element) => element.closest("[hidden]") === null && element.textContent === expected);
        assert.deepEqual(visibleOutcomeRegions, [status], "The outcome must have exactly one live announcement owner");
        assert.equal(page.document.getElementById("setup-status")?.hidden, true);
        assert.equal(page.document.getElementById("setup-error")?.hidden, true);
      };

      dispatchClick(inviteToggle);
      await flushAsync();
      emailInput.value = "Coach@Example.COM";
      emailInput.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      dispatchClick(sendButton);
      await flushAsync();
      assert.equal(requestedKeys.length, 1);
      assert.equal(sendButton.disabled, true);
      assertSingleVisibleOutcome("Sending invite…");

      dispatchClick(disclosureAction === "open create season" ? seasonToggle : inviteToggle);
      assert.equal(inviteRegion.hidden, true);
      assert.equal(seasonRegion.hidden, disclosureAction !== "open create season");
      assertSingleVisibleOutcome("Sending invite…");
      if (disclosureAction === "close and reopen") {
        dispatchClick(inviteToggle);
        await flushAsync();
        assert.equal(inviteRegion.hidden, false);
        assert.equal(sendButton.disabled, true);
        assertSingleVisibleOutcome("Sending invite…");
      }

      assert(finishInvite);
      await finishInvite();
      await flushAsync();
      const expectedOutcome = outcome === "sent"
        ? "Sent to coach@example.com."
        : outcome === "unknown"
          ? "Delivery unconfirmed. Open the email-restricted recovery link."
          : "Invite failed: Temporary failure.";
      assertSingleVisibleOutcome(expectedOutcome);
      assert.equal(sendButton.disabled, false);
      assert.equal(inviteRegion.hidden, disclosureAction !== "close and reopen");

      if (inviteRegion.hidden) {
        dispatchClick(inviteToggle);
        await flushAsync();
      }
      assert.equal(inviteRegion.hidden, false);
      assert.equal(seasonRegion.hidden, true);
      assertSingleVisibleOutcome(expectedOutcome);

      const storageKey = "threefc-idempotency:organiser-invite:autumn-league-coach%40example.com";
      if (outcome === "unknown") {
        const recoveryLink = status.querySelector(".inline-recovery-link");
        assert(recoveryLink instanceof page.window.HTMLAnchorElement);
        assert.equal(recoveryLink.href, recoveryHref);
        assert.equal(recoveryLink.closest("[hidden]"), null);
      } else {
        assert.equal(status.querySelector(".inline-recovery-link"), null);
      }
      if (outcome === "failure") {
        assert.equal(emailInput.value, "Coach@Example.COM");
        assert.equal(apiState.storage.get(storageKey), requestedKeys[0]);
        dispatchClick(sendButton);
        await flushAsync();
        assert.equal(requestedKeys.length, 2);
        assert.equal(requestedKeys[1], requestedKeys[0]);
        assertSingleVisibleOutcome("Sent to coach@example.com.");
      }
      assert.equal(emailInput.value, "");
      assert.equal(apiState.storage.has(storageKey), false);
    });
  }
}

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
  assert.equal(invitePage.document.getElementById("setup-status")?.textContent, "");
  assert.equal(invitePage.document.getElementById("setup-status")?.hidden, true);
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
  assert.equal(invitePage.document.getElementById("organiser-invite-league"), null);
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
    role: "admin",
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
  apiState.games.set("game-season-finished-earlier", {
    ...scheduledGame,
    gameId: "game-season-finished-earlier",
    status: "finished",
    gameStartTs: "2026-03-28T09:30:00.000Z",
  });

  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup"),
    url: "http://localhost:3000/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const upcomingGamesBody = page.document.getElementById("season-upcoming-games-body");
  const completedGamesBody = page.document.getElementById("season-completed-games-body");
  const game = apiState.games.get("game-season-local-time");
  assert(upcomingGamesBody instanceof page.window.HTMLElement);
  assert(completedGamesBody instanceof page.window.HTMLElement);
  assert(game);
  assert((upcomingGamesBody.textContent ?? "").includes(expectedSeasonKickoff(game.gameStartTs)));
  assert.doesNotMatch(upcomingGamesBody.textContent ?? "", /game-season-local-time/);
  assert.doesNotMatch(upcomingGamesBody.textContent ?? "", /Z\b|UTC/);
  const kickoffLink = upcomingGamesBody.querySelector('a[href="/games/game-season-local-time"]');
  assert(kickoffLink instanceof page.window.HTMLAnchorElement);
  assert.equal(kickoffLink.textContent, expectedSeasonKickoff(game.gameStartTs));
  const statusChip = upcomingGamesBody.querySelector('[data-ui="status-chip"][data-status="scheduled"]');
  assert(statusChip instanceof page.window.HTMLElement);
  assert.match(statusChip.textContent ?? "", /Scheduled/);
  assert(statusChip.querySelector('[data-icon="calendar-clock"]'));
  assert.equal(upcomingGamesBody.querySelector('[data-icon="eye"]'), null);
  assert(upcomingGamesBody.querySelector('[aria-label^="Delete game at"] [data-icon="trash-2"]'));
  assert(upcomingGamesBody.querySelector('[data-status="live"] [data-icon="activity"]'));
  assert.equal(upcomingGamesBody.querySelector('[data-status="finished"]'), null);
  assert.equal(completedGamesBody.querySelector('[data-status="scheduled"]'), null);
  assert.equal(completedGamesBody.querySelectorAll('[data-status="finished"] [data-icon="circle-check"]').length, 2);
  assert.equal(completedGamesBody.querySelectorAll('button[disabled][aria-label^="Delete unavailable:"]').length, 2);
  assert.equal(completedGamesBody.querySelector('[data-action="delete-game"]'), null);
  assert.deepEqual(
    [...upcomingGamesBody.querySelectorAll('a[href^="/games/"]')].filter((link) => !link.getAttribute("aria-label")).map((link) => link.getAttribute("href")),
    ["/games/game-season-local-time", "/games/game-season-live"],
  );
  assert.deepEqual(
    [...completedGamesBody.querySelectorAll('a[href^="/games/"]')].filter((link) => !link.getAttribute("aria-label")).map((link) => link.getAttribute("href")),
    ["/games/game-season-finished", "/games/game-season-finished-earlier"],
  );
  const upcomingGamesWrap = page.document.querySelector('[data-testid="season-upcoming-games-table"]');
  const completedGamesWrap = page.document.querySelector('[data-testid="season-completed-games-table"]');
  assert(upcomingGamesWrap instanceof page.window.HTMLElement);
  assert(completedGamesWrap instanceof page.window.HTMLElement);
  assert.equal(upcomingGamesWrap.hidden, false);
  assert.equal(page.document.getElementById("season-upcoming-games-empty")?.hidden, true);
  assert.equal(completedGamesWrap.hidden, false);
  assert.equal(page.document.getElementById("season-completed-games-empty")?.hidden, true);
});

test("season game groups expose accurate empty states and preserve finished-game delete locking", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-delete-upcoming", status: "scheduled", role: "admin" });
  const upcomingGame = apiState.games.get("game-delete-upcoming");
  assert(upcomingGame);
  apiState.games.set("game-delete-completed", {
    ...upcomingGame,
    gameId: "game-delete-completed",
    status: "finished",
    gameStartTs: "2026-03-28T09:00:00.000Z",
  });

  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup"),
    url: "http://localhost:3000/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });
  let confirmations = 0;
  Object.defineProperty(page.window, "confirm", {
    value: () => {
      confirmations += 1;
      return true;
    },
    configurable: true,
  });

  const upcomingWrap = page.document.querySelector('[data-testid="season-upcoming-games-table"]');
  const completedWrap = page.document.querySelector('[data-testid="season-completed-games-table"]');
  const upcomingEmpty = page.document.getElementById("season-upcoming-games-empty");
  const completedEmpty = page.document.getElementById("season-completed-games-empty");
  assert(upcomingWrap instanceof page.window.HTMLElement);
  assert(completedWrap instanceof page.window.HTMLElement);
  assert(upcomingEmpty instanceof page.window.HTMLElement);
  assert(completedEmpty instanceof page.window.HTMLElement);
  assert.equal(upcomingWrap.hidden, false);
  assert.equal(completedWrap.hidden, false);

  const upcomingDeleteIcon = page.document.querySelector(
    '#season-upcoming-games-body [data-game-id="game-delete-upcoming"] [data-icon="trash-2"]',
  );
  assert(upcomingDeleteIcon instanceof page.window.HTMLElement);
  dispatchClick(upcomingDeleteIcon);
  await flushAsync();
  assert.equal(confirmations, 1);
  assert.equal(apiState.games.has("game-delete-upcoming"), false);
  assert.equal(upcomingWrap.hidden, true);
  assert.equal(upcomingEmpty.hidden, false);
  assert.equal(upcomingEmpty.textContent, "No upcoming games.");
  assert.equal(completedWrap.hidden, false);
  assert.equal(completedEmpty.hidden, true);
  assert(page.document.querySelector('#season-completed-games-body a[href="/games/game-delete-completed"]'));

  const completedDeleteButton = page.document.querySelector(
    '#season-completed-games-body button[disabled][aria-label^="Delete unavailable:"]',
  );
  assert(completedDeleteButton instanceof page.window.HTMLButtonElement);
  const { surface: completedActions } = openActionMenuFor(completedDeleteButton);
  assert.equal(page.document.activeElement, completedActions, "an all-disabled surface still exposes its reason to keyboard users");
  const reasonId = completedDeleteButton.getAttribute("aria-describedby");
  assert(reasonId);
  const reason = page.document.getElementById(reasonId);
  assert(reason instanceof page.window.HTMLElement);
  assert.equal(reason.textContent, "Finished games can’t be deleted.");
  assert.equal(page.window.getComputedStyle(reason).display === "none", false);
  assert.equal(completedDeleteButton.hasAttribute("data-action"), false);
  const completedDeleteIcon = completedDeleteButton.querySelector('[data-icon="trash-2"]');
  assert(completedDeleteIcon instanceof page.window.HTMLElement);
  dispatchClick(completedDeleteIcon);
  await flushAsync();
  assert.equal(confirmations, 1);
  assert.equal(apiState.games.has("game-delete-completed"), true);
  assert.equal(completedWrap.hidden, false);
  assert.equal(completedEmpty.hidden, true);
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
    assert.equal(kickoffLink.textContent, "29 Mar 2026, 3:30 am");

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
  const nestedUpcomingGame = apiState.games.get("game-season-static-fallback");
  assert(nestedUpcomingGame);
  apiState.games.set("game-season-static-finished", {
    ...nestedUpcomingGame,
    gameId: "game-season-static-finished",
    status: "finished",
    gameStartTs: "2026-03-27T10:00:00.000Z",
  });

  const page = await bootPage({
    html: renderLeaguePage("http://localhost:3001", ""),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const root = page.document.getElementById("setup-flow-root");
  const shell = page.document.querySelector('[data-testid="season-shell"]');
  const upcomingGamesBody = page.document.getElementById("season-upcoming-games-body");
  const completedGamesBody = page.document.getElementById("season-completed-games-body");
  const activityStatus = page.document.getElementById("setup-status");

  assert(shell instanceof page.window.HTMLElement);
  assert(activityStatus instanceof page.window.HTMLElement);
  assert.equal(root?.getAttribute("data-page"), "season");
  assert.equal(root?.getAttribute("data-league-id"), "three-sided-football-club");
  assert.equal(root?.getAttribute("data-season-id"), "autumn-cup");
  assert.equal(page.document.getElementById("season-title")?.textContent, "Autumn Cup");
  assert(upcomingGamesBody instanceof page.window.HTMLElement);
  assert(completedGamesBody instanceof page.window.HTMLElement);
  for (const testId of ["season-upcoming-games-table", "season-completed-games-table"]) {
    const gamesTable = page.document.querySelector(`[data-testid="${testId}"] table`);
    assert(gamesTable instanceof page.window.HTMLTableElement);
    assert.equal(gamesTable.getAttribute("data-ui"), "data-table");
    assert.equal(gamesTable.getAttribute("aria-label"), testId === "season-upcoming-games-table" ? "Upcoming games" : "Completed games");
    assert.deepEqual(
      [...gamesTable.querySelectorAll("thead th")].map((heading) => ({
        text: heading.textContent,
        scope: heading.getAttribute("scope"),
      })),
      [
        { text: "Date", scope: "col" },
        { text: "Status", scope: "col" },
        { text: "Actions", scope: "col" },
      ],
    );
  }
  assert(upcomingGamesBody.querySelector('a[href="/games/game-season-static-fallback"]'));
  assert(completedGamesBody.querySelector('a[href="/games/game-season-static-finished"]'));
  assert.equal(upcomingGamesBody.querySelector("td")?.getAttribute("data-label"), "Date");
  assert.doesNotMatch(upcomingGamesBody.textContent ?? "", /game-season-static-fallback/);
  assert.equal(activityStatus.getAttribute("data-ui"), "activity-status");
  assert.equal(activityStatus.getAttribute("role"), "status");
  assert.equal(activityStatus.getAttribute("aria-live"), "polite");
  assert(activityStatus.querySelector('[data-icon="loader-circle"][aria-hidden="true"]'));
  assert.equal(activityStatus.querySelector('[data-ui="activity-message"]')?.classList.contains("sr-only"), false);
  assert.equal(activityStatus.hidden, true);
  assert.equal(activityStatus.textContent, "");
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
  const visibleGame = apiState.games.get("game-visible");
  const foreignGame = apiState.games.get("game-foreign");
  assert(visibleGame);
  assert(foreignGame);
  apiState.games.set("game-visible-finished", {
    ...visibleGame,
    gameId: "game-visible-finished",
    status: "finished",
    gameStartTs: "2026-06-20T10:00:00.000Z",
  });
  apiState.games.set("game-foreign-finished", {
    ...foreignGame,
    gameId: "game-foreign-finished",
    status: "finished",
    gameStartTs: "2026-06-20T10:05:00.000Z",
  });

  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "winter-2026", "league-a"),
    url: "http://localhost:3000/leagues/league-a/seasons/winter-2026",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const upcomingGamesBody = page.document.getElementById("season-upcoming-games-body");
  const completedGamesBody = page.document.getElementById("season-completed-games-body");
  assert(upcomingGamesBody instanceof page.window.HTMLElement);
  assert(completedGamesBody instanceof page.window.HTMLElement);
  assert.equal(page.document.getElementById("season-title")?.textContent, "Winter 2026");
  assert(upcomingGamesBody.querySelector('a[href="/games/game-visible"]'));
  assert.equal(upcomingGamesBody.querySelector('a[href="/games/game-foreign"]'), null);
  assert(completedGamesBody.querySelector('a[href="/games/game-visible-finished"]'));
  assert.equal(completedGamesBody.querySelector('a[href="/games/game-foreign-finished"]'), null);
  assert.doesNotMatch(upcomingGamesBody.textContent ?? "", /game-visible|game-foreign/);
  assert.doesNotMatch(completedGamesBody.textContent ?? "", /game-visible-finished|game-foreign-finished/);
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
  assert.deepEqual(apiState.lastMagicLinkStartRequest, {
    email: "organizer@3fc.football",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  assert.match(signInStatus.textContent ?? "", /Sign-in link sent/);

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
  seedGoalScoringGame(apiState, { gameId: "existing-game", role: "admin" });

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

for (const stage of ["session", "game"] as const) {
  for (const committed of [false, true]) {
    test(`organiser shell game creation recovers ${stage} ${committed ? "lost response" : "network failure"} using frozen requests`, async () => {
      const apiState = createMockApiState();
      seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
      const baseFetch = createMockFetch(apiState);
      const requests: Array<{ stage: "session" | "game"; path: string; body: string; key: string | null }> = [];
      let failAttempt: (() => void) | undefined;
      let failed = false;
      let committedResponse: unknown;
      const page = await bootPage({
        html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
        url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup#create-game",
        scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (init?.method !== "POST" || !path.startsWith("/v1/leagues/")) return baseFetch(input, init);
          const requestStage = path.endsWith("/sessions") ? "session" : "game";
          requests.push({ stage: requestStage, path, body: String(init.body), key: new Headers(init.headers).get("Idempotency-Key") });
          if (requestStage === stage && !failed) {
            failed = true;
            if (committed) committedResponse = await (await baseFetch(input, init)).json();
            return new Promise<Response>((_resolve, reject) => { failAttempt = () => reject(new Error("connection lost")); });
          }
          if (requestStage === stage && committed) return createJsonResponse(201, committedResponse);
          return baseFetch(input, init);
        },
      });
      try {
        const form = page.document.getElementById("create-game-form");
        const date = page.document.getElementById("game-date");
        const kickoff = page.document.getElementById("game-kickoff");
        const length = page.document.getElementById("game-third-length");
        const submit = page.document.querySelector('[data-action="create-game"]');
        assert(form instanceof page.window.HTMLFormElement);
        assert(date instanceof page.window.HTMLInputElement && kickoff instanceof page.window.HTMLInputElement);
        assert(length instanceof page.window.HTMLSelectElement && submit instanceof page.window.HTMLButtonElement);
        date.value = "2026-09-13";
        date.dispatchEvent(new page.window.Event("change", { bubbles: true }));
        kickoff.value = "2026-09-13T09:30";
        kickoff.dispatchEvent(new page.window.Event("change", { bubbles: true }));
        length.value = "25";
        form.requestSubmit();
        form.requestSubmit();
        await flushAsync();
        assert(failAttempt);
        assert.equal(submit.disabled, true);
        date.value = "2026-09-20";
        date.dispatchEvent(new page.window.Event("change", { bubbles: true }));
        kickoff.value = "2026-09-20T11:30";
        kickoff.dispatchEvent(new page.window.Event("change", { bubbles: true }));
        length.value = "30";
        failAttempt();
        await flushAsync();
        assert.equal(submit.disabled, false);
        assert.equal(date.value, "2026-09-20");
        assert.equal(length.value, "30");
        assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed.*original details/);
        form.requestSubmit();
        await flushAsync();
        const sessionRequests = requests.filter((request) => request.stage === "session");
        const gameRequests = requests.filter((request) => request.stage === "game");
        assert.equal(sessionRequests.length, stage === "session" ? 2 : 1, "do not repeat a confirmed session write");
        assert.equal(gameRequests.length, stage === "game" ? 2 : 1);
        const retriedRequests = stage === "session" ? sessionRequests : gameRequests;
        assert.deepEqual(retriedRequests[1], retriedRequests[0]);
        assert(retriedRequests[0].key);
        assert.deepEqual(JSON.parse(sessionRequests[0].body), { sessionId: "20260913", sessionDate: "2026-09-13" });
        const gamePayload = JSON.parse(gameRequests[0].body);
        assert.equal(gamePayload.gameStartTs, new Date("2026-09-13T09:30").toISOString());
        assert.equal(gamePayload.thirdLengthMinutes, 25, "game payload must be frozen before awaiting session creation");
        assert.match(gamePayload.gameId, /^game-20260913-0930-/);
        assert.equal(page.navigations.at(-1)?.url, `/games/${gamePayload.gameId}`);
        assert.equal(apiState.sessions.size, 1);
        assert.equal([...apiState.games.keys()].filter((id) => id !== "shell-fixture").length, 1);
        assert.equal(submit.disabled, true);
      } finally { page.dom.window.close(); }
    });
  }
}

test("organiser shell definitive game rejection allows correction without repeating its confirmed session", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  let sessionPosts = 0;
  const gameBodies: string[] = [];
  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup#create-game",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path.endsWith("/sessions")) sessionPosts += 1;
      if (init?.method === "POST" && path.endsWith("/games")) {
        gameBodies.push(String(init.body));
        if (gameBodies.length === 1) return createJsonResponse(400, { error: "invalid_game", message: "Choose a supported third length." });
      }
      return baseFetch(input, init);
    },
  });
  try {
    const form = page.document.getElementById("create-game-form");
    const length = page.document.getElementById("game-third-length");
    assert(form instanceof page.window.HTMLFormElement && length instanceof page.window.HTMLSelectElement);
    form.requestSubmit();
    await flushAsync();
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Game could not be created/);
    length.value = "30";
    form.requestSubmit();
    await flushAsync();
    assert.equal(sessionPosts, 1);
    assert.equal(gameBodies.length, 2);
    assert.equal(JSON.parse(gameBodies[1]).thirdLengthMinutes, 30);
    assert.equal(page.navigations.length, 1);
  } finally { page.dom.window.close(); }
});

test("organiser shell retains a committed game attempt when later team initialisation returns conflict", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  let sessionPosts = 0;
  const games: Array<{ path: string; body: string; key: string | null }> = [];
  let committedGame: unknown;
  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup#create-game",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path.endsWith("/sessions")) sessionPosts += 1;
      if (init?.method === "POST" && path.endsWith("/games")) {
        games.push({ path, body: String(init.body), key: new Headers(init.headers).get("Idempotency-Key") });
        if (games.length === 1) {
          committedGame = await (await baseFetch(input, init)).json();
          return createJsonResponse(409, { error: "game_mutation_conflict", message: "Team setup conflict." });
        }
        return createJsonResponse(201, committedGame);
      }
      return baseFetch(input, init);
    },
  });
  try {
    const form = page.document.getElementById("create-game-form");
    const length = page.document.getElementById("game-third-length");
    assert(form instanceof page.window.HTMLFormElement && length instanceof page.window.HTMLSelectElement);
    form.requestSubmit();
    await flushAsync();
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed.*original details/);
    length.value = "30";
    form.requestSubmit();
    await flushAsync();
    assert.equal(sessionPosts, 1);
    assert.equal(games.length, 2);
    assert.deepEqual(games[1], games[0]);
    assert.equal(JSON.parse(games[1].body).thirdLengthMinutes, 20);
    assert.equal([...apiState.games.keys()].filter((id) => id !== "shell-fixture").length, 1);
    assert.equal(page.navigations.length, 1);
  } finally { page.dom.window.close(); }
});

test("organiser shell season deletion stays scoped when season IDs repeat and refresh fails after commit", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
  const original = apiState.seasons.get("autumn-cup");
  assert(original);
  const otherLeagueSeason = { ...original, leagueId: "other-league", name: "Other league season" };
  apiState.seasons.set("autumn-cup", otherLeagueSeason);
  const baseFetch = createMockFetch(apiState);
  const deletes: string[] = [];
  let listReads = 0;
  const page = await bootPage({
    html: renderLeaguePage("http://localhost:3001", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/leagues/three-sided-football-club/seasons" && (init?.method ?? "GET") === "GET") {
        if (++listReads > 1) throw new Error("refresh offline");
        return createJsonResponse(200, { seasons: [original] });
      }
      if (init?.method === "DELETE") {
        deletes.push(path);
        return new Response(null, { status: 204 });
      }
      return baseFetch(input, init);
    },
  });
  try {
    Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
    const action = page.document.querySelector('#league-seasons-body [data-action="delete-season"]');
    assert(action instanceof page.window.HTMLButtonElement);
    const icon = action.querySelector('[data-icon="trash-2"]');
    assert(icon instanceof page.window.HTMLElement);
    dispatchClick(icon);
    dispatchClick(icon);
    await flushAsync();
    assert.deepEqual(deletes, ["/v1/leagues/three-sided-football-club/seasons/autumn-cup"]);
    assert.equal(page.document.querySelector("#league-seasons-body tr"), null);
    assert.deepEqual(apiState.seasons.get("autumn-cup"), otherLeagueSeason);
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /^Season deleted\. The list could not be refreshed/);
    assert.doesNotMatch(page.document.getElementById("setup-error")?.textContent ?? "", /deletion failed/);
  } finally { page.dom.window.close(); }
});

test("organiser shell game deletion remains committed when a later game-list refresh fails", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  let listReads = 0;
  let deletes = 0;
  const page = await bootPage({
    html: renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: "http://localhost:3000/leagues/three-sided-football-club/seasons/autumn-cup",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/games") && (init?.method ?? "GET") === "GET" && ++listReads > 1) return createJsonResponse(503, {});
      if (init?.method === "DELETE") deletes += 1;
      return baseFetch(input, init);
    },
  });
  try {
    Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
    const action = page.document.querySelector('#season-upcoming-games-body [data-action="delete-game"]');
    assert(action instanceof page.window.HTMLButtonElement);
    dispatchClick(action);
    dispatchClick(action);
    await flushAsync();
    assert.equal(deletes, 1);
    assert.equal(apiState.games.has("shell-fixture"), false);
    assert.equal(page.document.querySelector("#season-upcoming-games-body tr"), null);
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /^Game deleted\. The list could not be refreshed/);
    assert.doesNotMatch(page.document.getElementById("setup-error")?.textContent ?? "", /deletion failed/);
  } finally { page.dom.window.close(); }
});

function seedManagementDeletionRows(apiState: MockApiState, kind: "season" | "game", count: number) {
  seedGoalScoringGame(apiState, { gameId: "shell-fixture", role: "admin" });
  const season = apiState.seasons.get("autumn-cup");
  const game = apiState.games.get("shell-fixture");
  assert(season && game);
  apiState.games.clear();
  if (kind === "season") apiState.seasons.clear();
  for (let index = 0; index < count; index += 1) {
    const id = `row-${index}`;
    if (kind === "season") apiState.seasons.set(id, { ...season, seasonId: id, name: `Season ${index}` });
    else apiState.games.set(id, { ...game, gameId: id, gameStartTs: `2026-09-${String(10 + index).padStart(2, "0")}T09:30:00.000Z` });
  }
  return {
    listPath: kind === "season" ? "/v1/leagues/three-sided-football-club/seasons" : "/v1/leagues/three-sided-football-club/seasons/autumn-cup/games",
    bodyId: kind === "season" ? "league-seasons-body" : "season-upcoming-games-body",
    html: kind === "season" ? renderLeaguePage("http://localhost:3001", "three-sided-football-club") : renderSeasonPage("http://localhost:3001", "autumn-cup", "three-sided-football-club"),
    url: `http://localhost:3000/leagues/three-sided-football-club${kind === "game" ? "/seasons/autumn-cup" : ""}`,
    viewPath: (id: string) => kind === "season" ? `/leagues/three-sided-football-club/seasons/${id}` : `/games/${id}`,
  };
}

test("action menus share native groups, nested trigger clicks, one-open state and natural focus exit", async () => {
  const apiState = createMockApiState();
  const fixture = seedManagementDeletionRows(apiState, "season", 2);
  const page = await bootPage({ html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState });
  try {
    const menus = [...page.document.querySelectorAll('#league-seasons-body [data-ui="action-menu"]')];
    assert.equal(menus.length, 2);
    assert.equal(page.document.querySelector('details[data-ui="more-actions"], details[data-ui="player-management"]'), null);
    const firstTrigger = menus[0].querySelector('[data-action="toggle-action-menu"]');
    const firstSurface = menus[0].querySelector('[data-ui="action-menu-surface"]');
    const secondTrigger = menus[1].querySelector('[data-action="toggle-action-menu"]');
    assert(firstTrigger instanceof page.window.HTMLButtonElement && firstSurface instanceof page.window.HTMLElement && secondTrigger instanceof page.window.HTMLButtonElement);
    assert.equal(firstSurface.hidden, true);
    assert.equal(firstSurface.getAttribute("role"), "group");
    assert.equal(firstSurface.getAttribute("aria-label"), "Actions for Season 0");
    assert.equal(firstTrigger.getAttribute("aria-label"), "Actions for Season 0");
    assert.equal(firstSurface.querySelector('[role="menuitem"]'), null);
    const icon = firstTrigger.querySelector('[data-icon="ellipsis-vertical"]');
    assert(icon instanceof page.window.HTMLElement);
    dispatchClick(icon);
    assert.equal(firstTrigger.getAttribute("aria-expanded"), "true");
    assert.equal(page.document.activeElement, firstSurface.querySelector("button"));
    const svg = page.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = page.document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.append(path);
    secondTrigger.append(svg);
    path.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const secondSurface = menus[1].querySelector('[data-ui="action-menu-surface"]');
    assert(secondSurface instanceof page.window.HTMLElement);
    assert.equal(firstSurface.hidden, true);
    assert.equal(firstTrigger.getAttribute("aria-expanded"), "false");
    assert.equal(secondSurface.hidden, false);
    assert.equal(page.document.querySelectorAll('[data-action="toggle-action-menu"][aria-expanded="true"]').length, 1);
    const action = secondSurface.querySelector("button");
    assert(action instanceof page.window.HTMLButtonElement);
    action.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(secondSurface.hidden, false, "Tab itself is not trapped or prematurely hidden");
    const outside = page.document.querySelector('[data-ui="site-nav"] a');
    assert(outside instanceof page.window.HTMLAnchorElement);
    outside.focus();
    assert.equal(secondSurface.hidden, true);
    assert.equal(page.document.activeElement, outside);
    openActionMenuFor(secondTrigger);
    action.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(secondSurface.hidden, true);
    assert.equal(page.document.activeElement, secondTrigger);
    openActionMenuFor(firstTrigger);
    outside.dispatchEvent(new page.window.Event("pointerdown", { bubbles: true }));
    outside.focus();
    assert.equal(firstSurface.hidden, true);
    assert.equal(page.document.activeElement, outside);
  } finally { page.dom.window.close(); }
});

for (const nativePopover of [false, true]) {
  test(`action menus clamp and flip within the visual viewport with ${nativePopover ? "native top-layer" : "hidden fallback"} ownership`, async () => {
    const apiState = createMockApiState();
    const fixture = seedManagementDeletionRows(apiState, "season", 1);
    const page = await bootPage({ html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState });
    try {
      const action = page.document.querySelector('#league-seasons-body [data-action="delete-season"]');
      assert(action instanceof page.window.HTMLButtonElement);
      const menu = action.closest('[data-ui="action-menu"]');
      const trigger = menu?.querySelector('[data-action="toggle-action-menu"]');
      const surface = menu?.querySelector('[data-ui="action-menu-surface"]');
      assert(menu instanceof page.window.HTMLElement && trigger instanceof page.window.HTMLButtonElement && surface instanceof page.window.HTMLElement);
      let shown = 0;
      let hidden = 0;
      Object.defineProperty(surface, "showPopover", { configurable: true, value: nativePopover ? () => { shown += 1; } : undefined });
      Object.defineProperty(surface, "hidePopover", { configurable: true, value: nativePopover ? () => { hidden += 1; } : undefined });
      const viewport = new page.window.EventTarget();
      Object.assign(viewport, { width: 320, height: 280, offsetLeft: 12, offsetTop: 40 });
      Object.defineProperty(page.window, "visualViewport", { value: viewport, configurable: true });
      let top = 270;
      Object.defineProperty(trigger, "getBoundingClientRect", { value: () => ({ left: 280, right: 328, top, bottom: top + 48, width: 48, height: 48 }) });
      Object.defineProperty(surface, "getBoundingClientRect", { value: () => ({ left: 0, right: 200, top: 0, bottom: 120, width: 200, height: 120 }) });
      openActionMenuFor(action);
      assert.equal(surface.style.left, "124px");
      assert.equal(surface.style.top, "142px", "near-bottom action flips above its trigger");
      assert.equal(surface.style.maxWidth, "304px");
      assert.equal(surface.style.maxHeight, "264px");
      assert.equal(shown, nativePopover ? 1 : 0);
      assert.equal(surface.parentElement, menu, "the original delegated event owner is preserved");
      top = -100;
      surface.dispatchEvent(new page.window.Event("scroll", { bubbles: false }));
      assert.equal(surface.hidden, false, "scrolling within the surface does not dismiss it");
      page.window.dispatchEvent(new page.window.Event("resize"));
      assert.equal(surface.hidden, true, "an offscreen trigger cannot leave an orphan action surface");
      assert.equal(hidden, nativePopover ? 1 : 0);
      top = 270;
      openActionMenuFor(action);
      menu.hidden = true;
      await flushAsync();
      assert.equal(surface.hidden, true);
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      assert.equal(hidden, nativePopover ? 2 : 0, "role hiding also dismisses the top-layer surface");
      dispatchClick(trigger);
      assert.equal(surface.hidden, true, "a hidden owner cannot be opened by synthetic activation");
    } finally { page.dom.window.close(); }
  });
}

for (const kind of ["season", "game"] as const) {
  for (const outcome of ["cancel", "rejected", "uncertain"] as const) {
    test(`action menus ${kind} deletion ${outcome} closes and returns owned focus without changing data`, async () => {
      const apiState = createMockApiState();
      const fixture = seedManagementDeletionRows(apiState, kind, 1);
      const baseFetch = createMockFetch(apiState);
      let deletes = 0;
      const page = await bootPage({ html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init) => {
          if (init?.method === "DELETE") {
            deletes += 1;
            return createJsonResponse(outcome === "rejected" ? 403 : 503, { message: "Not available" });
          }
          return baseFetch(input, init);
        },
      });
      try {
        Object.defineProperty(page.window, "confirm", { value: () => outcome !== "cancel", configurable: true });
        const action = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`);
        assert(action instanceof page.window.HTMLButtonElement);
        const { trigger, surface } = openActionMenuFor(action);
        const icon = action.querySelector('[data-icon="trash-2"]');
        assert(icon instanceof page.window.HTMLElement);
        dispatchClick(icon);
        assert.equal(surface.hidden, true, "surface closes before confirmation/pending work");
        await flushAsync();
        assert.equal(deletes, outcome === "cancel" ? 0 : 1);
        assert.equal(page.document.activeElement, trigger);
        assert.equal(trigger.getAttribute("aria-expanded"), "false");
        assert.equal(action.disabled, false);
        assert.equal(kind === "season" ? apiState.seasons.has("row-0") : apiState.games.has("row-0"), true);
        if (outcome !== "cancel") {
          assert.match(page.document.getElementById("setup-error")?.textContent ?? "", outcome === "uncertain" ? /could not be confirmed/ : /could not be deleted/);
        }
        openActionMenuFor(action);
        assert.equal(page.document.activeElement, action, "a fresh explicit retry remains available");
      } finally { page.dom.window.close(); }
    });
  }

  for (const refreshFails of [false, true]) {
    test(`action menus ${kind} pending deletion survives redraw and ${refreshFails ? "failed" : "stale"} post-commit refresh`, async () => {
      const apiState = createMockApiState();
      const fixture = seedManagementDeletionRows(apiState, kind, 2);
      const originalRows = kind === "season" ? [...apiState.seasons.values()] : [...apiState.games.values()];
      const baseFetch = createMockFetch(apiState);
      let releaseDelete: (() => void) | undefined;
      let firstDeletes = 0;
      let firstCommitted = false;
      const page = await bootPage({ html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (init?.method === "DELETE" && path.endsWith("/row-0")) {
            firstDeletes += 1;
            return new Promise<Response>((resolve) => { releaseDelete = () => { firstCommitted = true; void baseFetch(input, init).then(resolve); }; });
          }
          if (path === fixture.listPath) {
            if (firstCommitted && refreshFails) throw new Error("refresh unavailable");
            return createJsonResponse(200, { [kind === "season" ? "seasons" : "games"]: originalRows });
          }
          return baseFetch(input, init);
        },
      });
      try {
        Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
        const original = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`);
        const other = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-1"]`);
        assert(original instanceof page.window.HTMLButtonElement && other instanceof page.window.HTMLButtonElement);
        openActionMenuFor(original);
        dispatchClick(original);
        openActionMenuFor(other);
        dispatchClick(other);
        await flushAsync();
        const replacement = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`);
        assert(replacement instanceof page.window.HTMLButtonElement);
        assert.notEqual(replacement, original, "another confirmed delete causes a real list redraw");
        assert.equal(replacement.disabled, true, "pending state belongs to the entity, not its detached button");
        const { surface } = openActionMenuFor(replacement);
        assert.equal(page.document.activeElement, surface);
        dispatchClick(replacement);
        replacement.disabled = false;
        dispatchClick(replacement);
        await flushAsync();
        assert.equal(firstDeletes, 1, "entity latch protects even a stale enabled node");
        replacement.disabled = true;
        openActionMenuFor(replacement);
        assert(releaseDelete);
        releaseDelete();
        await flushAsync();
        assert.equal(kind === "season" ? apiState.seasons.has("row-0") : apiState.games.has("row-0"), false);
        assert.equal(page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`), null);
        assert.equal(page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-1"]`), null);
        assert.equal(surface.hidden, true, "removing its owner closes any pending row popover");
      } finally { page.dom.window.close(); }
    });
  }
}

for (const kind of ["season", "game"] as const) {
  for (const scenario of [
    { count: 3, index: 1, next: "row-2", refreshFails: false },
    { count: 3, index: 2, next: "row-1", refreshFails: false },
    { count: 3, index: 1, next: "row-2", refreshFails: true },
    { count: 1, index: 0, next: null, refreshFails: false },
    { count: 1, index: 0, next: null, refreshFails: true },
  ]) {
    test(`organiser shell ${kind} deletion restores logical focus: ${scenario.index}/${scenario.count}, refresh ${scenario.refreshFails ? "failed" : "succeeded"}`, async () => {
      const apiState = createMockApiState();
      const fixture = seedManagementDeletionRows(apiState, kind, scenario.count);
      const baseFetch = createMockFetch(apiState);
      let listReads = 0;
      const page = await bootPage({
        html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init) => {
          if (new URL(String(input)).pathname === fixture.listPath && (init?.method ?? "GET") === "GET") {
            if (++listReads > 1 && scenario.refreshFails) throw new Error("offline refresh");
          }
          return baseFetch(input, init);
        },
      });
      try {
        Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
        const body = page.document.getElementById(fixture.bodyId);
        const action = body?.querySelector(`[data-${kind}-id="row-${scenario.index}"]`);
        assert(body instanceof page.window.HTMLElement && action instanceof page.window.HTMLButtonElement);
        openActionMenuFor(action);
        action.focus();
        assert.equal(page.document.activeElement, action);
        dispatchClick(action);
        await flushAsync();
        assert.equal(body.querySelector(`[data-${kind}-id="row-${scenario.index}"]`), null);
        if (scenario.next) {
          assert.equal(page.document.activeElement?.getAttribute("href"), fixture.viewPath(scenario.next));
        } else {
          const heading = body.closest('[data-ui="panel"]')?.querySelector("h2");
          assert(heading);
          assert.equal(page.document.activeElement, heading);
          assert.equal(heading.getAttribute("tabindex"), "-1");
        }
      } finally { page.dom.window.close(); }
    });
  }

  for (const interaction of ["focus", "pointer"] as const) {
    test(`organiser shell ${kind} deletion does not steal focus after the user moves ${interaction}`, async () => {
      const apiState = createMockApiState();
      const fixture = seedManagementDeletionRows(apiState, kind, 2);
      const baseFetch = createMockFetch(apiState);
      let finishDelete: (() => void) | undefined;
      const page = await bootPage({
        html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init) => {
          if (init?.method === "DELETE") return new Promise<Response>((resolve) => {
            finishDelete = () => { void baseFetch(input, init).then(resolve); };
          });
          return baseFetch(input, init);
        },
      });
      try {
        Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
        const action = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`);
        const outside = page.document.querySelector('[data-ui="site-nav"] a');
        assert(action instanceof page.window.HTMLButtonElement && outside instanceof page.window.HTMLAnchorElement);
        openActionMenuFor(action);
        action.focus();
        dispatchClick(action);
        if (interaction === "focus") outside.focus();
        else outside.dispatchEvent(new page.window.Event("pointerdown", { bubbles: true }));
        assert(finishDelete);
        finishDelete();
        await flushAsync();
        if (interaction === "focus") assert.equal(page.document.activeElement, outside);
        else assert.equal(page.document.activeElement, page.document.body);
        assert.equal(page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`), null);
      } finally { page.dom.window.close(); }
    });
  }

  for (const control of ["link", "closed-more", "open-more", "delete", "surface"] as const) {
    test(`organiser shell ${kind} redraw preserves focus moved to a surviving row ${control}`, async () => {
      const apiState = createMockApiState();
      const fixture = seedManagementDeletionRows(apiState, kind, 2);
      const baseFetch = createMockFetch(apiState);
      let finishDelete: (() => void) | undefined;
      let finishSurvivorDelete: (() => void) | undefined;
      const page = await bootPage({
        html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init) => {
          if (init?.method === "DELETE") return new Promise<Response>((resolve) => {
            if (control === "surface" && new URL(String(input)).pathname.endsWith("/row-1")) {
              finishSurvivorDelete = () => resolve(createJsonResponse(403, { message: "Delete rejected" }));
            } else finishDelete = () => { void baseFetch(input, init).then(resolve); };
          });
          return baseFetch(input, init);
        },
      });
      try {
        Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
        const action = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`);
        const survivor = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-1"]`)?.closest("tr");
        assert(action instanceof page.window.HTMLButtonElement && survivor instanceof page.window.HTMLTableRowElement);
        openActionMenuFor(action);
        const survivorMenu = survivor.querySelector('[data-ui="action-menu"]');
        assert(survivorMenu instanceof page.window.HTMLElement);
        action.focus();
        dispatchClick(action);
        if (control === "surface") {
          const survivorDelete = survivorMenu.querySelector('[data-action^="delete-"]');
          assert(survivorDelete instanceof page.window.HTMLButtonElement);
          openActionMenuFor(survivorDelete);
          dispatchClick(survivorDelete);
          assert.equal(survivorDelete.disabled, true);
          assert(finishSurvivorDelete);
        }
        const shouldOpen = control === "open-more" || control === "delete" || control === "surface";
        if (shouldOpen) openActionMenuFor(survivorMenu);
        const movedFocus = control === "link" ? survivor.querySelector("a[href]")
          : control === "surface" ? survivorMenu.querySelector('[data-ui="action-menu-surface"]')
          : control === "delete" ? survivorMenu.querySelector('[data-action^="delete-"]') : survivorMenu.querySelector('[data-action="toggle-action-menu"]');
        assert(movedFocus instanceof page.window.HTMLElement);
        movedFocus.focus();
        assert.equal(page.document.activeElement, movedFocus);
        assert(finishDelete);
        finishDelete();
        finishDelete = undefined;
        await flushAsync();
        const replacementRow = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-1"]`)?.closest("tr");
        assert(replacementRow instanceof page.window.HTMLTableRowElement);
        const replacementMenu = replacementRow.querySelector('[data-ui="action-menu"]');
        assert(replacementMenu instanceof page.window.HTMLElement);
        const replacement = control === "link" ? replacementRow.querySelector("a[href]")
          : control === "surface" ? replacementMenu.querySelector('[data-ui="action-menu-surface"]')
          : control === "delete" ? replacementMenu.querySelector('[data-action^="delete-"]') : replacementMenu.querySelector('[data-action="toggle-action-menu"]');
        assert(replacement instanceof page.window.HTMLElement);
        assert.notEqual(replacement, movedFocus, "the fixture exercises a real row replacement");
        assert.equal(page.document.activeElement, replacement);
        assert.equal(replacementMenu.querySelector('[data-action="toggle-action-menu"]')?.getAttribute("aria-expanded"), String(shouldOpen));
        assert.equal((replacementMenu.querySelector('[data-ui="action-menu-surface"]') as HTMLElement).hidden, !shouldOpen);
        if (control === "surface") {
          assert.equal(replacement.getAttribute("role"), "group");
          assert.equal(replacement.querySelector("button:not(:disabled)"), null);
        }
        assert.equal(page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`), null);
      } finally {
        finishDelete?.();
        finishSurvivorDelete?.();
        await flushAsync();
        page.dom.window.close();
      }
    });
  }

  test(`organiser shell ${kind} deletion does not reinsert a confirmed row from a stale list response`, async () => {
    const apiState = createMockApiState();
    const fixture = seedManagementDeletionRows(apiState, kind, 2);
    const originalRows = kind === "season" ? [...apiState.seasons.values()] : [...apiState.games.values()];
    const baseFetch = createMockFetch(apiState);
    const page = await bootPage({
      html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === fixture.listPath && (init?.method ?? "GET") === "GET") {
          return createJsonResponse(200, { [kind === "season" ? "seasons" : "games"]: originalRows });
        }
        return baseFetch(input, init);
      },
    });
    try {
      Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
      const action = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`);
      assert(action instanceof page.window.HTMLButtonElement);
      dispatchClick(action);
      await flushAsync();
      assert.equal(page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-0"]`), null);
      assert(page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="row-1"]`));
      assert.equal(kind === "season" ? apiState.seasons.has("row-0") : apiState.games.has("row-0"), false);
    } finally { page.dom.window.close(); }
  });

  test(`organiser shell ${kind} overlapping deletion refreshes cannot overwrite a newer list`, async () => {
    const apiState = createMockApiState();
    const fixture = seedManagementDeletionRows(apiState, kind, 3);
    const originalRows = kind === "season" ? [...apiState.seasons.values()] : [...apiState.games.values()];
    const baseFetch = createMockFetch(apiState);
    let reads = 0;
    const refreshes: Array<(response: Response) => void> = [];
    const page = await bootPage({
      html: fixture.html, url: fixture.url, scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === fixture.listPath && (init?.method ?? "GET") === "GET" && ++reads > 1) {
          return new Promise<Response>((resolve) => { refreshes.push(resolve); });
        }
        return baseFetch(input, init);
      },
    });
    try {
      Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
      for (const id of ["row-0", "row-1"]) {
        const action = page.document.querySelector(`#${fixture.bodyId} [data-${kind}-id="${id}"]`);
        assert(action instanceof page.window.HTMLButtonElement);
        dispatchClick(action);
        await flushAsync();
      }
      assert.equal(refreshes.length, 2);
      const key = kind === "season" ? "seasons" : "games";
      refreshes[1](createJsonResponse(200, { [key]: [] }));
      await flushAsync();
      assert.equal(page.document.querySelectorAll(`#${fixture.bodyId} tr`).length, 0);
      // An older response contains both deleted IDs plus a row no longer in
      // the newer list. Tombstones protect IDs; the version guard protects all
      // newer list contents, not only deletions initiated by this page.
      refreshes[0](createJsonResponse(200, { [key]: originalRows }));
      await flushAsync();
      assert.equal(page.document.querySelectorAll(`#${fixture.bodyId} tr`).length, 0);
      assert.equal(kind === "season" ? apiState.seasons.has("row-0") : apiState.games.has("row-0"), false);
      assert.equal(kind === "season" ? apiState.seasons.has("row-1") : apiState.games.has("row-1"), false);
    } finally { page.dom.window.close(); }
  });
}

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
  grantMockLeagueAccess(apiState, "three-sided-football-club", apiState.session.email, "admin");
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
  assert.equal(seasonPage.document.getElementById("setup-status")?.textContent, "Game could not be created.");
});

test("league deletion persists its target before a committed cleanup failure", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "delete-pending-fixture", role: "admin" });
  const owner = apiState.session!.email;
  apiState.leagues.set("empty-delete", { leagueId: "empty-delete", name: "Private league name", slug: null,
    createdByUserId: owner, createdAt: "2026-03-28T11:00:00.000Z", updatedAt: "2026-03-28T11:00:00.000Z" });
  grantMockLeagueAccess(apiState, "empty-delete", owner, "admin");
  const key = `threefc.league-deletion.v1:${encodeURIComponent(owner)}`;
  const storage = new Map<string, string>(); const base = createMockFetch(apiState);
  let deletes = 0;
  const page = await bootPage({ html: renderLeaguePage("http://localhost:3001", "empty-delete"),
    url: "http://localhost:3000/leagues/empty-delete", scriptFile: "setup-flow.js", apiState, sessionStorage: storage,
    fetch: async (input, init = {}) => {
      if (init.method === "DELETE") {
        deletes += 1;
        assert.deepEqual(JSON.parse(String(init.body)), { expectedAccountId: owner });
        assert.deepEqual(JSON.parse(storage.get(key)!), { owner, leagueId: "empty-delete", uncertain: true });
        apiState.leagues.delete("empty-delete");
        return createJsonResponse(503, { error: "unavailable", code: "league_cleanup_pending" });
      }
      return base(input, init);
    },
  });
  try {
    Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
    dispatchClick(page.document.querySelector('[data-testid="delete-league"]')!); await flushAsync();
    assert.equal(deletes, 1);
    assert.equal(JSON.parse(storage.get(key)!).uncertain, true);
    assert.equal(storage.get(key)?.includes("Private league name"), false);
    const recovery = page.document.getElementById("league-deletion-recovery")!;
    assert.equal(recovery.hidden, false);
    assert.match(recovery.textContent ?? "", /not yet confirmed/);
    assert.equal(page.document.getElementById("setup-status")?.textContent, "");
    assert.equal(page.navigations.length, 0);
  } finally { page.dom.window.close(); }
});

for (const destination of ["home", "missing-league", "other-account", "same-subject", "same-email-other-subject"] as const) {
  test(`league deletion recovery survives committed cleanup failure on ${destination}`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "deletion-recovery-fixture", role: "admin" });
    const owner = destination === "same-email-other-subject" || destination === "same-subject" ? "original-account-subject" : apiState.session!.email;
    const key = `threefc.league-deletion.v1:${encodeURIComponent(owner)}`;
    const storage = new Map([[key, JSON.stringify({ owner, leagueId: "deleted-league", uncertain: true })]]);
    if (destination === "other-account") apiState.session!.email = "someone-else@example.com";
    if (destination === "same-email-other-subject") apiState.session!.subject = "different-account-subject";
    if (destination === "same-subject") apiState.session!.subject = owner;
    const otherAccount = destination === "other-account" || destination === "same-email-other-subject";
    const base = createMockFetch(apiState);
    let deletes = 0;
    const page = await bootPage({
      html: destination === "missing-league" ? renderLeaguePage("http://localhost:3001", "deleted-league") : renderSetupHomePage("http://localhost:3001"),
      url: destination === "missing-league" ? "http://localhost:3000/leagues/deleted-league" : "http://localhost:3000/setup",
      scriptFile: "setup-flow.js", apiState, sessionStorage: storage,
      fetch: async (input, init = {}) => {
        if (init.method === "DELETE") {
          deletes += 1;
          assert.deepEqual(JSON.parse(String(init.body)), { expectedAccountId: owner });
          return new Response(null, { status: 204 });
        }
        return base(input, init);
      },
    });
    try {
      const recovery = page.document.getElementById("league-deletion-recovery")!;
      assert.equal(recovery.hidden, otherAccount);
      assert.equal(recovery.textContent?.includes("deleted-league"), false, "no target identifier or private league name is displayed");
      if (!otherAccount) {
        dispatchClick(recovery.querySelector("button")!); await flushAsync();
        assert.equal(deletes, 1); assert.equal(storage.has(key), false);
        assert.match(recovery.textContent ?? "", /League deleted/);
      } else { assert.equal(deletes, 0); assert.equal(storage.has(key), true); }
    } finally { page.dom.window.close(); }
  });
}

test("league deletion recovery retains uncertainty after another rejection and hides on logout purge", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "deletion-recovery-fixture", role: "admin" });
  const owner = apiState.session!.email;
  const key = `threefc.league-deletion.v1:${encodeURIComponent(owner)}`;
  const storage = new Map([[key, JSON.stringify({ owner, leagueId: "deleted-league", uncertain: true })]]);
  const base = createMockFetch(apiState);
  let deletes = 0;
  const page = await bootPage({ html: renderSetupHomePage("http://localhost:3001"), url: "http://localhost:3000/setup",
    scriptFile: "setup-flow.js", apiState, sessionStorage: storage,
    fetch: async (input, init = {}) => {
      if (init.method === "DELETE") { deletes += 1; return createJsonResponse(409, { error: "conflict" }); }
      return base(input, init);
    },
  });
  try {
    const panel = page.document.getElementById("league-deletion-recovery")!;
    dispatchClick(panel.querySelector("button")!); await flushAsync();
    assert.equal(JSON.parse(storage.get(key)!).uncertain, true);
    assert.match(panel.textContent ?? "", /not yet confirmed/);
    page.window.dispatchEvent(new page.window.Event("threefc:player-proof-cleared"));
    assert.equal(panel.hidden, true);
    dispatchClick(panel.querySelector("button")!); await flushAsync();
    assert.equal(deletes, 1);
  } finally { page.dom.window.close(); }
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
  grantMockLeagueAccess(apiState, "empty-league", apiState.session.email, "admin");
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
  grantMockLeagueAccess(apiState, "three-sided-football-club", apiState.session.email, "admin");
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
  grantMockLeagueAccess(apiState, "three-sided-football-club", apiState.session.email, "admin");
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
  assert.equal(page.document.getElementById("setup-status")?.textContent, "Season could not be deleted.");
});

for (const actor of ["admin", "scorekeeper", "viewer", "claimed-viewer", "unknown"] as const) {
  test(`match roster uses viewer-safe reads and fail-closed controls for ${actor}`, async () => {
    const apiState = createMockApiState();
    const role = actor === "admin" || actor === "scorekeeper" ? actor : "viewer";
    seedGoalScoringGame(apiState, { gameId: "game-match-role", role });
    if (actor === "claimed-viewer") {
      const player = apiState.players.get("player-ari");
      assert(player);
      player.claimedByUserId = apiState.session!.email;
    }
    const original = createMockFetch(apiState);
    const playerReads: string[] = [];
    const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
      const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
      if (path.endsWith("/players")) playerReads.push(path);
      const response = await original(input, init);
      if (actor === "unknown" && path === "/v1/leagues/three-sided-football-club") {
        const league = await response.json() as Record<string, unknown>;
        delete league.access;
        return createJsonResponse(200, league);
      }
      return response;
    };
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-match-role" }), url: "http://localhost:3000/games/game-match-role", scriptFile: "setup-flow.js", apiState, fetch });
    const operator = actor === "admin" || actor === "scorekeeper";
    assert.equal(playerReads.length, operator ? 1 : 0);
    assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 3);
    assert.equal(page.document.querySelectorAll('[data-ui="roster-player"]').length, 0);
    assert.equal(page.document.querySelector('[data-testid="game-mode-run-tab"]')?.hasAttribute("hidden"), !operator);
    assert.equal(page.document.querySelector('[data-action="toggle-game-edit"]')?.hasAttribute("hidden"), actor !== "admin");
    assert.equal(page.document.querySelectorAll('[data-action="toggle-transfer"]').length, operator ? 3 : 0);
    assert.equal(page.document.querySelectorAll('[data-ui="player-initial"]:not([data-link-state="unknown"])').length, actor === "admin" ? 3 : 0);
    assert.equal(page.document.getElementById("game-league-link")?.textContent, "Three Sided Football Club");
    assert.equal(page.document.getElementById("game-season-link")?.textContent, "Autumn Cup");
    assert.equal(page.document.getElementById("game-mode-structure")?.hidden, false);
  });
}

test("malformed administrator claim metadata stays unknown rather than asserting unlinked", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-malformed-claim", role: "admin" });
  const original = createMockFetch(apiState);
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    const response = await original(input, init);
    if (path === "/v1/games/game-malformed-claim/players") {
      const body = await response.json() as { players: Array<Record<string, unknown>> };
      body.players.forEach(player => { player.access = {}; });
      return createJsonResponse(200, body);
    }
    return response;
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-malformed-claim" }), url: "http://localhost:3000/games/game-malformed-claim", scriptFile: "setup-flow.js", apiState, fetch });
  const rows = page.document.querySelectorAll('[data-ui="roster-member"]');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.querySelector('[data-ui="player-initial"]')?.getAttribute("data-link-state"), "unknown");
    assert.doesNotMatch(row.textContent ?? "", /(?:Not linked|Linked) to an account/);
    assert.equal(row.querySelector('[data-action="invite-player-profile"]'), null);
    assert.doesNotMatch(row.textContent ?? "", /Invite to link profile/);
  }
});

test("match roster keeps assigned identities beyond the candidate cap without inventing claim state", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-match-cap", role: "admin" });
  for (let index = 0; index < 23; index += 1) {
    const playerId = `player-extra-${index}`;
    const timestamp = "2026-03-28T11:00:09.000Z";
    apiState.players.set(playerId, { playerId, nickname: `Extra ${index}`, claimedByUserId: index === 22 ? "claimed@example.com" : null, createdAt: timestamp, updatedAt: timestamp });
    apiState.gamePlayers.set(`game-match-cap:${playerId}`, { gameId: "game-match-cap", playerId, createdAt: timestamp, updatedAt: timestamp });
    apiState.roster.set(`game-match-cap:${playerId}`, { gameId: "game-match-cap", playerId, teamId: "yellow", createdAt: timestamp, updatedAt: timestamp });
  }
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-match-cap" }), url: "http://localhost:3000/games/game-match-cap#teams", scriptFile: "setup-flow.js", apiState });
  assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 26);
  assert.equal(new Set([...page.document.querySelectorAll('[data-ui="roster-member"]')].map((row) => row.getAttribute("data-player-id"))).size, 26);
  assert.equal(page.document.querySelectorAll('[data-ui="roster-player"]').length, 0);
  assert.equal(page.document.querySelector('[data-player-id="player-extra-22"] [data-ui="claim-badge"]'), null);
  assert.match(page.document.getElementById("player-pool")?.textContent ?? "", /No unassigned players to show/);
  assert.doesNotMatch(page.document.getElementById("player-pool")?.textContent ?? "", /Search by name to find more players|full Unassigned list is unavailable/);
  assert.equal(page.document.getElementById("player-search"), null);
  assert.equal(page.document.querySelector('[data-player-id="player-extra-22"] [data-ui="player-initial"]')?.getAttribute("data-link-state"), "unknown");
  assert.doesNotMatch(page.document.getElementById("roster-teams")?.innerHTML ?? "", /claimed@example.com/);
  assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 26);
  const refresh = page.document.getElementById("roster-retry")!;
  assert.equal(refresh.hidden, false);
  dispatchClick(refresh); await flushAsync();
  assert.equal(page.document.querySelector('[data-player-id="player-extra-22"] [data-ui="player-initial"]')?.getAttribute("data-link-state"), "linked");
  assert.equal(refresh.hidden, false, "existing claim status remains refreshable");
  apiState.players.get("player-extra-22")!.claimedByUserId = null;
  dispatchClick(refresh); await flushAsync();
  assert.equal(page.document.querySelector('[data-player-id="player-extra-22"] [data-ui="player-initial"]')?.getAttribute("data-link-state"), "unlinked", "cached identities beyond the first page are revalidated");
  assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 26);
  assert.doesNotMatch(page.document.getElementById("roster-teams")?.innerHTML ?? "", /claimed@example.com/);
});

for (const failSecondBatch of [false, true, "malformed"]) test(`metadata recovery advances bounded batches and clears failed authority ${failSecondBatch}`, async () => {
  const apiState = createMockApiState();
  const gameId = "metadata-batches";
  seedGoalScoringGame(apiState, { gameId, role: "admin" });
  for (let index = 0; index < 48; index++) {
    const playerId = `batch-player-${index}`, timestamp = "2026-03-28T11:00:09.000Z";
    apiState.players.set(playerId, { playerId, nickname: `Person [${String(index).padStart(3, "0")}]`, claimedByUserId: null, createdAt: timestamp, updatedAt: timestamp });
    apiState.gamePlayers.set(`${gameId}:${playerId}`, { gameId, playerId, createdAt: timestamp, updatedAt: timestamp });
    apiState.roster.set(`${gameId}:${playerId}`, { gameId, playerId, teamId: "yellow", createdAt: timestamp, updatedAt: timestamp });
  }
  const base = createMockFetch(apiState), names: string[] = [];
  const timers = createManualTimers(); let authorityReads = 0;
  let fail = false;
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#teams`, scriptFile: "setup-flow.js", apiState, timers,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (/\/v1\/leagues\/[^/]+$/.test(url.pathname)) authorityReads++;
      if (url.pathname === `/v1/games/${gameId}/players` && url.searchParams.has("search")) {
        names.push(url.searchParams.get("search")!);
        if (fail) return failSecondBatch === "malformed" ? createJsonResponse(200, { players: null }) : createJsonResponse(503, { error: "unavailable" });
      }
      return base(input, init);
    } });
  try {
    const unknown = () => page.document.querySelectorAll('[data-ui="roster-member"] [data-ui="player-initial"][data-link-state="unknown"]').length;
    const retry = page.document.getElementById("roster-retry")!;
    assert.equal(unknown(), 31);
    dispatchClick(retry); await flushAsync();
    assert.equal(names.length, 20); assert.equal(unknown(), 11); assert.equal(retry.hidden, false);
    assert.match(page.document.getElementById("roster-retry-status")!.textContent!, /Some player details are still unavailable/);
    const first = new Set(names);
    if (failSecondBatch) {
      fail = true; dispatchClick(retry); await flushAsync();
      assert.equal(unknown(), 51, "a failed targeted read clears all verified authority, including earlier batches");
      assert.equal(retry.textContent, "Retry loading players");
      fail = false; dispatchClick(retry); await flushAsync();
      assert.equal(unknown(), 11);
    }
    const before = names.length;
    const beforePoll = authorityReads;
    await advanceUx10({ ...page, timers }, 15000);
    assert(authorityReads > beforePoll, "same-role authority polling occurs between recovery batches");
    dispatchClick(retry); await flushAsync();
    assert.equal(names.length - before, 11);
    assert(names.slice(before).every(name => !first.has(name)), "later retries advance to the remaining names");
    assert.equal(unknown(), 0); assert.equal(retry.hidden, false);
    assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 51);
    assert.equal(page.document.getElementById("roster-retry-status")!.textContent, "Players updated.");
  } finally { page.dom.window.close(); }
});

for (const malformed of [{ players: null }, { players: [{ playerId: "missing-name" }] }]) test(`metadata recovery rejects malformed successful responses ${JSON.stringify(malformed)}`, async () => {
  const apiState = createMockApiState(), gameId = "metadata-malformed";
  seedGoalScoringGame(apiState, { gameId, role: "admin" });
  const base = createMockFetch(apiState); let fail = false;
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#teams`, scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => fail && new URL(String(input)).pathname.endsWith("/players")
      ? createJsonResponse(200, malformed) : base(input, init) });
  try {
    assert.equal(page.document.querySelectorAll('[data-ui="player-initial"][data-link-state="unknown"]').length, 0);
    fail = true; dispatchClick(page.document.getElementById("roster-retry")!); await flushAsync();
    assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 3);
    assert.equal(page.document.querySelectorAll('[data-ui="player-initial"][data-link-state="unknown"]').length, 3);
    assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
    assert.equal(page.document.getElementById("roster-retry")!.textContent, "Retry loading players");
  } finally { page.dom.window.close(); }
});

test("match roster renders permitted teams when optional operator enrichment fails", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-match-enrichment", role: "admin" });
  const original = createMockFetch(apiState);
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    return path.endsWith("/players") ? createJsonResponse(503, { message: "Unavailable" }) : original(input, init);
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-match-enrichment" }), url: "http://localhost:3000/games/game-match-enrichment", scriptFile: "setup-flow.js", apiState, fetch });
  assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 3);
  assert.equal(page.document.querySelectorAll('[data-ui="claim-badge"]').length, 0);
  assert.match(page.document.getElementById("player-pool")?.textContent ?? "", /No unassigned players to show/);
  assert.doesNotMatch(page.document.getElementById("player-pool")?.textContent ?? "", /couldn’t be loaded/);
  assert.equal(page.document.getElementById("game-mode-structure")?.hidden, false);
  assert.doesNotMatch(page.document.getElementById("goal-timeline")?.textContent ?? "", /unavailable/);
});

for (const hash of ["teams", "players", "mode-players", "score", "run", "mode-run", "results", "final"]) {
  test(`match navigation preserves ${hash} bookmarks without arming finished corrections`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "game-match-hashes", status: "finished", role: "admin" });
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-match-hashes" }), url: `http://localhost:3000/games/game-match-hashes#${hash}`, scriptFile: "setup-flow.js", apiState });
    const isTeams = ["teams", "players", "mode-players"].includes(hash);
    assert.equal(page.window.location.hash, isTeams ? "#teams" : "#results");
    assert.equal(page.document.getElementById(isTeams ? "game-mode-players" : "game-mode-final")?.hidden, false);
    assert.equal(page.document.querySelector('[data-action="toggle-transfer"]'), null);
    assert.equal((page.document.querySelector('[data-action="save-goal"]') as HTMLButtonElement).disabled, true);
    enterFinishedCorrections(page);
    assert.equal(page.window.location.hash, "#score");
    assert.equal(page.document.getElementById("game-mode-run")?.hidden, false);
    enterFinishedCorrections(page, true);
    assert.equal(page.window.location.hash, "#teams");
    assert.equal(page.document.querySelectorAll('[data-action="toggle-transfer"]').length, 3);
  });
}

test("match player native submit latches SVG clicks and retries the frozen original after response loss", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-player-retry", role: "admin" });
  const original = createMockFetch(apiState);
  const requests: Array<{ body: string; key: string | null }> = [];
  let releaseFirst: ((response: Response) => void) | undefined;
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    if (path.endsWith("/players") && init.method === "POST") {
      requests.push({ body: String(init.body), key: readInitHeader(init, "idempotency-key") });
      if (requests.length === 1) {
        await original(input, init);
        return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      }
    }
    return original(input, init);
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-player-retry" }), url: "http://localhost:3000/games/game-player-retry#teams", scriptFile: "setup-flow.js", apiState, fetch });
  const toggle = page.document.querySelector('[data-action="toggle-player-create"]');
  const form = page.document.getElementById("player-create-form");
  const input = page.document.getElementById("player-nickname");
  const add = page.document.querySelector('[data-action="quick-create-player"]');
  assert(toggle instanceof page.window.HTMLButtonElement);
  assert(form instanceof page.window.HTMLFormElement);
  assert(input instanceof page.window.HTMLInputElement);
  assert(add instanceof page.window.HTMLButtonElement);
  dispatchClick(toggle);
  dispatchClick(page.document.getElementById("game-player-new-toggle")!);
  assert.equal(interactionVisible(toggle), false);
  input.value = "New player";
  input.focus();
  dispatchSubmit(form);
  dispatchSubmit(form);
  const icon = add.querySelector('[data-ui="icon"]');
  assert(icon);
  icon.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  // Production icons are local CSS masks. Also exercise an SVG child so the
  // delegated handler cannot regress to accepting HTMLElement targets only.
  const svg = page.document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = page.document.createElementNS("http://www.w3.org/2000/svg", "path");
  svg.append(path);
  icon.append(svg);
  path.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await flushAsync();
  assert.equal(requests.length, 1);
  assert.equal(add.disabled, true);
  assert(releaseFirst);
  releaseFirst(createJsonResponse(503, { message: "Response lost" }));
  await flushAsync();
  assert.equal(input.value, "New player");
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /original nickname/);
  assert.equal(interactionVisible(toggle), false, "pending and failed renders must not duplicate Add player");
  const cancel = page.document.querySelector('[data-action="cancel-player-create"]');
  assert(cancel instanceof page.window.HTMLButtonElement);
  cancel.focus(); dispatchClick(cancel);
  assert.equal(interactionVisible(toggle), true);
  assert.equal(page.document.activeElement, toggle);
  dispatchClick(toggle);
  assert.equal(input.value, "New player", "closing an uncertain attempt does not cancel or replace it");
  assert.equal(interactionVisible(toggle), false);
  input.value = "Next player";
  dispatchSubmit(form);
  await flushAsync();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.ok(requests[0].key);
  assert.equal([...apiState.players.values()].filter((player) => player.nickname === "New player").length, 1);
  assert.equal(input.value, "Next player");
  assert.equal(page.document.activeElement, input);
  dispatchSubmit(form);
  await flushAsync();
  assert.equal(requests.length, 3);
  assert.notEqual(requests[2].key, requests[1].key);
  assert.equal(JSON.parse(requests[2].body).nickname, "Next player");
  assert.equal(input.value, "");
});

for (const code of ["game_finished", "game_state_changed"]) {
  test(`match player ${code} rejection releases the frozen attempt without losing the draft`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "game-player-conflict", role: "scorekeeper" });
    const original = createMockFetch(apiState);
    const requests: Array<{ body: string; key: string | null }> = [];
    const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
      const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
      if (path.endsWith("/players") && init.method === "POST") {
        requests.push({ body: String(init.body), key: readInitHeader(init, "idempotency-key") });
        // The real endpoint persists business conflicts. Reusing this key would
        // replay the same rejection forever, even if the current state permits a new request.
        if (requests.at(-1)?.key === requests[0].key) {
          return createJsonResponse(409, { error: "conflict", code, message: "Game state changed." });
        }
      }
      return original(input, init);
    };
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-player-conflict" }), url: "http://localhost:3000/games/game-player-conflict#teams", scriptFile: "setup-flow.js", apiState, fetch });
    const form = page.document.getElementById("player-create-form");
    const input = page.document.getElementById("player-nickname");
    assert(form instanceof page.window.HTMLFormElement);
    assert(input instanceof page.window.HTMLInputElement);
    dispatchClick(page.document.querySelector('[data-action="toggle-player-create"]') as HTMLButtonElement);
    input.value = "Original draft";
    input.focus();
    dispatchSubmit(form);
    await flushAsync();
    assert.equal(requests.length, 1);
    assert.ok(requests[0].key);
    assert.equal(input.value, "Original draft");
    assert.equal(page.document.activeElement, input);
    assert.doesNotMatch(page.document.getElementById("setup-error")?.textContent ?? "", /unconfirmed|original nickname/);
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Game state changed/);
    input.value = "Corrected draft";
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    dispatchSubmit(form);
    await flushAsync();
    assert.equal(requests.length, 2);
    assert.notEqual(requests[1].key, requests[0].key);
    assert.notEqual(JSON.parse(requests[1].body).playerId, JSON.parse(requests[0].body).playerId);
    assert.equal(JSON.parse(requests[1].body).nickname, "Corrected draft");
    assert.equal([...apiState.players.values()].filter(player => player.nickname === "Original draft").length, 0);
    assert.equal([...apiState.players.values()].filter(player => player.nickname === "Corrected draft").length, 1);
  });
}

for (const code of ["idempotency_in_progress", "idempotency_conflict", "unknown_conflict", "malformed_conflict"]) {
  test(`match player ${code} retains the original request for uncertain recovery`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "game-player-pending", role: "admin" });
    const original = createMockFetch(apiState);
    const requests: Array<{ body: string; key: string | null }> = [];
    const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
      const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
      if (path.endsWith("/players") && init.method === "POST") {
        requests.push({ body: String(init.body), key: readInitHeader(init, "idempotency-key") });
        // Idempotency categories are in error, not the business-conflict code field.
        return createJsonResponse(409, { error: code, ...(code === "malformed_conflict" ? { code: "game_finished" } : {}), message: "Request conflict." });
      }
      return original(input, init);
    };
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-player-pending" }), url: "http://localhost:3000/games/game-player-pending#teams", scriptFile: "setup-flow.js", apiState, fetch });
    const form = page.document.getElementById("player-create-form");
    const input = page.document.getElementById("player-nickname");
    assert(form instanceof page.window.HTMLFormElement);
    assert(input instanceof page.window.HTMLInputElement);
    input.value = "Original draft";
    dispatchSubmit(form);
    await flushAsync();
    input.value = "Later draft";
    dispatchSubmit(form);
    await flushAsync();
    assert.equal(requests.length, 2);
    assert.ok(requests[0].key);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(input.value, "Later draft");
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed/);
  });
}

test("match player business conflict after response loss does not discard the earlier unresolved request", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-player-lost-conflict", role: "admin" });
  const original = createMockFetch(apiState);
  const requests: Array<{ body: string; key: string | null }> = [];
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    if (path.endsWith("/players") && init.method === "POST") {
      requests.push({ body: String(init.body), key: readInitHeader(init, "idempotency-key") });
      if (requests.length === 1) {
        await original(input, init); // Commit before losing the response.
        return createJsonResponse(503, { message: "Response unavailable." });
      }
      return createJsonResponse(409, { error: "conflict", code: "game_finished", message: "Game finished." });
    }
    return original(input, init);
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-player-lost-conflict" }), url: "http://localhost:3000/games/game-player-lost-conflict#teams", scriptFile: "setup-flow.js", apiState, fetch });
  const form = page.document.getElementById("player-create-form");
  const input = page.document.getElementById("player-nickname");
  assert(form instanceof page.window.HTMLFormElement);
  assert(input instanceof page.window.HTMLInputElement);
  input.value = "Committed draft";
  dispatchSubmit(form);
  await flushAsync();
  input.value = "Later draft";
  for (let retry = 0; retry < 2; retry += 1) {
    dispatchSubmit(form);
    await flushAsync();
  }
  assert.equal(requests.length, 3);
  assert.ok(requests[0].key);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.equal(input.value, "Later draft");
  assert.equal([...apiState.players.values()].filter(player => player.nickname === "Committed draft").length, 1);
  assert.equal([...apiState.players.values()].filter(player => player.nickname === "Later draft").length, 0);
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed/);
});

test("match player committed addition survives refresh failure and cancellation preserves the next draft", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-player-committed", role: "admin" });
  const original = createMockFetch(apiState);
  let committed = false;
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    if (committed && path.endsWith("/roster")) return createJsonResponse(503, { message: "Unavailable" });
    const response = await original(input, init);
    if (path.endsWith("/players") && init.method === "POST") committed = true;
    return response;
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-player-committed" }), url: "http://localhost:3000/games/game-player-committed#teams", scriptFile: "setup-flow.js", apiState, fetch });
  const toggle = page.document.querySelector('[data-action="toggle-player-create"]');
  const cancel = page.document.querySelector('[data-action="cancel-player-create"]');
  const form = page.document.getElementById("player-create-form");
  const input = page.document.getElementById("player-nickname");
  assert(toggle instanceof page.window.HTMLButtonElement);
  assert(cancel instanceof page.window.HTMLButtonElement);
  assert(form instanceof page.window.HTMLFormElement);
  assert(input instanceof page.window.HTMLInputElement);
  dispatchClick(toggle);
  dispatchClick(page.document.getElementById("game-player-new-toggle")!);
  assert.equal(interactionVisible(toggle), false);
  input.value = "Nico";
  dispatchSubmit(form);
  await flushAsync();
  assert.equal(input.value, "");
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /^Player added\./);
  assert.match(page.document.getElementById("player-pool")?.textContent ?? "", /Nico/);
  assert.equal(interactionVisible(toggle), false, "post-commit capability redraw retains the open form's ownership");
  input.value = "Draft";
  dispatchClick(cancel);
  assert.equal(page.document.getElementById("player-create-region")?.hidden, true);
  assert.equal(interactionVisible(toggle), true);
  assert.equal(page.document.activeElement, toggle);
  dispatchClick(toggle);
  assert.equal(input.value, "Draft");
  assert.equal(interactionVisible(toggle), false);
  assert.equal(page.document.activeElement?.id, "game-player-picker-search");
});

test("match player commit preserves retyped identical nickname and picker drafts", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-player-revisions", role: "admin" });
  const original = createMockFetch(apiState);
  let release: ((response: Response) => void) | undefined;
  let committedResponse: Response | undefined;
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    if (path.endsWith("/players") && init.method === "POST") {
      committedResponse = await original(input, init);
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return original(input, init);
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-player-revisions" }), url: "http://localhost:3000/games/game-player-revisions#teams", scriptFile: "setup-flow.js", apiState, fetch });
  const nickname = page.document.getElementById("player-nickname");
  const search = page.document.getElementById("game-player-picker-search");
  const form = page.document.getElementById("player-create-form");
  assert(nickname instanceof page.window.HTMLInputElement);
  assert(search instanceof page.window.HTMLInputElement);
  assert(form instanceof page.window.HTMLFormElement);
  for (const input of [nickname, search]) {
    input.value = "Nico";
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  }
  dispatchSubmit(form);
  await flushAsync();
  for (const input of [nickname, search]) for (const value of ["Next", "Nico"]) {
    input.value = value;
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  }
  assert(release && committedResponse);
  release(committedResponse);
  await flushAsync();
  assert.equal(nickname.value, "Nico");
  assert.equal(search.value, "Nico");
  assert.equal([...apiState.players.values()].filter((player) => player.nickname === "Nico").length, 1);
});

test("match finish refresh preserves unassigned candidates without treating pending public creation as admin claim proof", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments().map((third) => ({ ...third, startedAt: "2026-03-28T11:00:00.000Z", finishedAt: "2026-03-28T11:20:00.000Z" }));
  seedGoalScoringGame(apiState, { gameId: "game-role-provenance", role: "scorekeeper", status: "live", thirds });
  const original = createMockFetch(apiState);
  let createdId = "";
  let failRoster = false;
  let delayAuthority = false;
  let releaseAuthority: ((response: Response) => void) | undefined;
  let authorityResponse: Response | undefined;
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    if (failRoster && path.endsWith("/roster")) {
      failRoster = false;
      return createJsonResponse(503, { message: "Unavailable" });
    }
    const response = await original(input, init);
    if (path.endsWith("/players") && init.method === "POST") {
      createdId = JSON.parse(String(init.body)).playerId;
      failRoster = true;
    } else if (path.endsWith("/players") && createdId) {
      const payload = await response.json() as { players: Array<{ playerId: string }> };
      return createJsonResponse(200, { players: payload.players.filter((player) => player.playerId !== createdId) });
    } else if (delayAuthority && path === "/v1/leagues/three-sided-football-club") {
      authorityResponse = response;
      return new Promise<Response>((resolve) => { releaseAuthority = resolve; });
    }
    return response;
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-role-provenance" }), url: "http://localhost:3000/games/game-role-provenance#teams", scriptFile: "setup-flow.js", apiState, fetch });
  const nickname = page.document.getElementById("player-nickname");
  const form = page.document.getElementById("player-create-form");
  assert(nickname instanceof page.window.HTMLInputElement);
  assert(form instanceof page.window.HTMLFormElement);
  nickname.value = "Pending player";
  dispatchSubmit(form);
  await flushAsync();
  assert(createdId);
  const player = apiState.players.get(createdId);
  assert(player);
  player.claimedByUserId = "claimed-later@example.com";
  grantMockLeagueAccess(apiState, "three-sided-football-club", apiState.session!.email, "admin");
  delayAuthority = true;
  const finish = page.document.querySelector('[data-action="finish-game"]');
  assert(finish instanceof page.window.HTMLButtonElement);
  dispatchClick(finish);
  await flushAsync();
  assert(releaseAuthority && authorityResponse);
  assert.equal(page.document.querySelector('[data-action="toggle-transfer"]'), null);
  assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
  releaseAuthority(authorityResponse);
  await flushAsync();
  enterFinishedCorrections(page, true);
  const candidate = page.document.querySelector(`[data-ui="roster-player"][data-player-id="${createdId}"]`);
  assert(candidate, "Unassigned candidate is present after finish without typing a search");
  assert.equal(candidate.querySelector('[data-ui="claim-badge"]'), null);
  assert.equal(candidate.querySelector('[data-action="grant-player-access"]'), null);
});

test("match roster retry restores private actions without filtering the complete roster", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "game-retry", role: "admin" });
  const base = createMockFetch(apiState); let fail = true, reads = 0;
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-retry" }), url: "http://localhost:3000/games/game-retry#teams", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (new URL(String(input)).pathname.endsWith("/players")) { reads++; if (fail) return createJsonResponse(503, { error: "unavailable" }); }
      return base(input, init);
    } });
  try {
    assert.equal(page.document.getElementById("player-search"), null);
    assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 3);
    assert.equal(page.document.querySelectorAll('[data-ui="player-initial"][data-link-state="unknown"]').length, 3);
    const retry = page.document.getElementById("roster-retry")!; assert.equal(retry.hidden, false);
    fail = false; dispatchClick(retry); await flushAsync();
    assert.equal(reads, 2); assert.equal(retry.hidden, false);
    assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 3);
    assert.equal(page.document.querySelectorAll('[data-ui="player-initial"][data-link-state="unknown"]').length, 0);
    assert.equal(page.document.getElementById("roster-retry-status")?.textContent, "Players updated.");
  } finally { page.dom.window.close(); }
});

test("game possible-name search visibly selects the wider league scope and preserves the draft", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "picker-game", role: "admin" });
  const baseFetch = createMockFetch(apiState), queries: URLSearchParams[] = [];
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "picker-game" }),
    url: "http://localhost:3000/games/picker-game#teams", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== "/v1/league-players") return baseFetch(input, init);
      queries.push(url.searchParams);
      return createJsonResponse(200, { players: [{ playerId: "kesh", nickname: "Kesh", claimed: false, inGame: false, seasons: [], hasMoreSeasons: false }], cursor: null });
    } });
  try {
    dispatchClick(page.document.querySelector('[data-action="toggle-player-create"]')!); await flushAsync();
    dispatchClick(page.document.getElementById("game-player-new-toggle")!);
    const name = page.document.getElementById("player-nickname") as HTMLInputElement;
    name.value = "Kesh"; name.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 220)); await flushAsync();
    dispatchClick(page.document.querySelector("#game-player-name-matches button")!); await flushAsync();
    const scope = page.document.getElementById("game-player-picker-scope") as HTMLSelectElement;
    assert.equal(scope.value, "league"); assert.equal(scope.selectedOptions[0]?.textContent, "All league players");
    assert.equal(queries.at(-1)?.has("seasonId"), false);
    assert.equal(page.document.activeElement?.id, "game-player-picker-search");
    assert.equal(name.value, "Kesh"); assert.equal(page.document.getElementById("player-create-form")!.hidden, true);
  } finally { page.dom.window.close(); }
});

test("game reusable player picker starts with this season and retries the original assignment after response loss", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "picker-game", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  const queries: URLSearchParams[] = [], writes: string[] = [];
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "picker-game" }),
    url: "http://localhost:3000/games/picker-game#teams", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/league-players") {
        queries.push(url.searchParams);
        return createJsonResponse(200, { players: [
          { playerId: "player-ari", nickname: "Ari", claimed: false, inGame: true, seasons: [], hasMoreSeasons: false },
          { playerId: "reuse-kesh", nickname: "Kesh", claimed: false, inGame: false, seasons: [{ seasonId: "autumn-cup", name: "Autumn Cup" }], hasMoreSeasons: false },
        ], cursor: null });
      }
      if (url.pathname === "/v1/game-player-registrations") {
        writes.push(String(init.body));
        const body = JSON.parse(String(init.body));
        const stamp = "2026-03-28T11:00:00.000Z";
        apiState.players.set(body.playerId, { playerId: body.playerId, nickname: "Kesh", claimedByUserId: null, createdAt: stamp, updatedAt: stamp });
        apiState.gamePlayers.set(`picker-game:${body.playerId}`, { gameId: "picker-game", playerId: body.playerId, createdAt: stamp, updatedAt: stamp });
        if (body.teamId) apiState.roster.set(`picker-game:${body.playerId}`, { gameId: "picker-game", playerId: body.playerId, teamId: body.teamId, createdAt: stamp, updatedAt: stamp });
        if (writes.length === 1) throw new Error("committed response lost");
        return createJsonResponse(200, { registration: { playerId: body.playerId, alreadyInGame: true } });
      }
      return baseFetch(input, init);
    },
  });
  try {
    assert.equal(queries.length, 0, "directory loading is intentional, not a background scan");
    dispatchClick(page.document.querySelector('[data-action="toggle-player-create"]')!); await flushAsync();
    assert.equal(page.document.activeElement?.id, "game-player-picker-search");
    assert.equal(queries.length, 0, "opening an empty picker never fetches the directory");
    const search = page.document.getElementById("game-player-picker-search") as HTMLInputElement;
    search.value = "Kesh";
    dispatchSubmit(page.document.getElementById("game-player-picker-form") as HTMLFormElement); await flushAsync();
    assert.equal(queries[0].get("seasonId"), "autumn-cup"); assert.equal(queries[0].get("gameId"), "picker-game");
    assert.equal(page.document.getElementById("player-create-form")!.hidden, true);
    const list = page.document.getElementById("game-player-picker-list")!;
    assert.equal((list.querySelector('[data-player-id="player-ari"] button') as HTMLButtonElement).disabled, true);
    assert.equal(page.document.getElementById("game-player-picker-team"), null);
    const add = list.querySelector('[data-player-id="reuse-kesh"] button')!;
    assert.match(page.document.getElementById(add.getAttribute("aria-describedby")!)!.textContent ?? "", /Autumn Cup/);
    dispatchClick(list.querySelector('[data-player-id="reuse-kesh"] button')!); await flushAsync();
    assert.equal(writes.length, 1); assert.equal(search.disabled, true);
    assert.match(page.document.getElementById("game-player-picker-status")!.textContent ?? "", /Retry adding sends the same request/);
    dispatchClick(page.document.querySelector<HTMLButtonElement>('#game-player-picker-form [data-action="cancel-player-create"]')!);
    dispatchClick(page.document.querySelector<HTMLButtonElement>('[data-action="toggle-player-create"]')!);
    assert.equal(page.document.activeElement?.getAttribute("data-action"), "add-existing-player");
    assert.equal(page.document.activeElement?.textContent, "Retry adding");
    search.value = "Other"; search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    dispatchClick(list.querySelector('[data-player-id="reuse-kesh"] button')!); await flushAsync();
    assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]);
    assert.equal(JSON.parse(writes[1]).teamId, null);
    assert.equal(apiState.roster.has("picker-game:reuse-kesh"), false);
    assert.equal(page.document.querySelectorAll('[data-ui="roster-player"][data-player-id="reuse-kesh"]').length, 1);
    assert.equal((list.querySelector('[data-player-id="reuse-kesh"] button') as HTMLButtonElement).disabled, true);
    assert.equal([...apiState.gamePlayers.values()].filter(row => row.playerId === "reuse-kesh").length, 1);
    assert.equal(page.document.querySelector('label[for="player-search"]'), null);
    const scope = page.document.getElementById("game-player-picker-scope") as HTMLSelectElement;
    scope.value = "league"; scope.dispatchEvent(new page.window.Event("change", { bubbles: true })); await flushAsync();
    assert.equal(queries.at(-1)?.has("seasonId"), false);
    dispatchClick(page.document.getElementById("game-player-new-toggle")!);
    assert.equal(page.document.getElementById("player-create-form")!.hidden, false);
    assert.equal(page.document.activeElement?.id, "player-nickname");
  } finally { page.dom.window.close(); }
});

test("game reusable player picker cannot dispatch an old result during a newer search", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "picker-race", role: "admin" });
  const baseFetch = createMockFetch(apiState);
  let reads = 0, writes = 0, release: ((response: Response) => void) | undefined;
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "picker-race" }),
    url: "http://localhost:3000/games/picker-race#teams", scriptFile: "setup-flow.js", apiState, timers: createManualTimers(),
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/game-player-registrations") { writes += 1; throw new Error("response lost"); }
      if (url.pathname !== "/v1/league-players") return baseFetch(input, init);
      reads += 1;
      if (reads === 2) return new Promise<Response>(resolve => { release = resolve; });
      return createJsonResponse(200, { players: [{ playerId: "old-result", nickname: "Kesh", claimed: false, inGame: false, seasons: [], hasMoreSeasons: false }], cursor: null });
    },
  });
  try {
    dispatchClick(page.document.querySelector('[data-action="toggle-player-create"]')!); await flushAsync();
    const form = page.document.getElementById("game-player-picker-form") as HTMLFormElement;
    const search = page.document.getElementById("game-player-picker-search") as HTMLInputElement;
    search.value = "Kesh";
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true })); await flushAsync();
    const old = page.document.querySelector<HTMLButtonElement>('#game-player-picker-list [data-action="add-existing-player"]')!;
    search.value = "Gavin"; search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    assert.equal(page.document.getElementById("game-player-picker-list")!.children.length, 0);
    dispatchClick(old); await flushAsync(); assert.equal(writes, 0);
    dispatchSubmit(form); await flushAsync();
    release!(createJsonResponse(200, { players: [], cursor: null })); await flushAsync();
    assert.equal(page.document.getElementById("game-player-picker-list")!.children.length, 0);
    assert.equal(writes, 0);
  } finally { page.dom.window.close(); }
});

test("search-first picker debounces, cancels, scopes, traverses pages and recovers without empty reads", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "picker-timing", role: "admin" });
  const base = createMockFetch(apiState), timers = createManualTimers(), queries: URLSearchParams[] = [];
  let fail = false;
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "picker-timing" }), url: "http://localhost:3000/games/picker-timing#teams", scriptFile: "setup-flow.js", apiState, timers,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname !== "/v1/league-players") return base(input, init);
      queries.push(url.searchParams);
      if (fail) return createJsonResponse(503, { error: "unavailable" });
      const second = url.searchParams.has("cursor");
      return createJsonResponse(200, { players: [{ playerId: second ? "second" : "first", nickname: "Gavin", claimed: false, inGame: false, seasons: [] }], cursor: second ? null : "next" });
    } });
  try {
    const toggle = page.document.querySelector<HTMLButtonElement>('[data-action="toggle-player-create"]')!;
    const input = page.document.getElementById("game-player-picker-search") as HTMLInputElement;
    const scope = page.document.getElementById("game-player-picker-scope") as HTMLSelectElement;
    const form = page.document.getElementById("game-player-picker-form") as HTMLFormElement;
    const list = page.document.getElementById("game-player-picker-list")!;
    const type = (value: string) => { input.value = value; input.dispatchEvent(new page.window.Event("input", { bubbles: true })); };
    dispatchClick(toggle); assert.equal(queries.length, 0);
    type("Gav"); timers.advanceBy(299); await flushAsync(); assert.equal(queries.length, 0);
    type(" Gavin "); timers.advanceBy(299); await flushAsync(); assert.equal(queries.length, 0);
    timers.advanceBy(1); await flushAsync(); assert.equal(queries.length, 2); assert.equal(queries[0].get("query"), "Gavin");
    assert.equal(list.children.length, 2); assert.equal(page.document.getElementById("game-player-picker-more")!.hidden, true);
    type("Kesh"); assert.equal(list.children.length, 0); dispatchSubmit(form); await flushAsync();
    assert.equal(queries.length, 4); timers.advanceBy(300); await flushAsync(); assert.equal(queries.length, 4, "Enter cancels debounce");
    type(" "); timers.advanceBy(300); await flushAsync(); assert.equal(queries.length, 4); assert.equal(list.children.length, 0);
    scope.value = "league"; scope.dispatchEvent(new page.window.Event("change", { bubbles: true })); await flushAsync(); assert.equal(queries.length, 4);
    type("Gavin"); dispatchClick(form.querySelector('[data-action="cancel-player-create"]')!);
    timers.advanceBy(300); await flushAsync(); assert.equal(queries.length, 4); assert.equal(input.value, "Gavin");
    dispatchClick(toggle); await flushAsync(); assert.equal(queries.length, 6); assert.equal(queries.at(-1)?.has("seasonId"), false);
    fail = true; type("Failure"); timers.advanceBy(300); await flushAsync();
    const retry = page.document.getElementById("game-player-picker-retry")!; assert.equal(retry.hidden, false); assert.equal(list.children.length, 0);
    retry.focus();
    fail = false; dispatchClick(retry); await flushAsync(); assert.equal(retry.hidden, true); assert.equal(list.children.length, 2);
    assert.equal(page.document.activeElement?.id, "game-player-picker-status");
    assert.equal(queries.every(query => Boolean(query.get("query")?.trim())), true);
  } finally { page.dom.window.close(); }
});

test("closing an in-flight picker search aborts it and stale success cannot replace a scoped reopen", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "picker-close", role: "admin" });
  const base = createMockFetch(apiState); let release: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined; let reads = 0;
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "picker-close" }), url: "http://localhost:3000/games/picker-close#teams", scriptFile: "setup-flow.js", apiState, timers: createManualTimers(),
    fetch: async (input, init = {}) => {
      const url = new URL(String(input)); if (url.pathname !== "/v1/league-players") return base(input, init);
      reads++;
      if (reads === 1) { signal = init.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); }
      return createJsonResponse(200, { players: [{ playerId: "fresh", nickname: "Fresh", inGame: false, claimed: false, seasons: [] }], cursor: null });
    } });
  try {
    const toggle = page.document.querySelector<HTMLButtonElement>('[data-action="toggle-player-create"]')!;
    const search = page.document.getElementById("game-player-picker-search") as HTMLInputElement;
    const form = page.document.getElementById("game-player-picker-form") as HTMLFormElement;
    dispatchClick(toggle); search.value = "Old"; dispatchSubmit(form); await flushAsync(); assert(release && signal);
    dispatchClick(form.querySelector<HTMLButtonElement>('[data-action="cancel-player-create"]')!);
    assert.equal(signal.aborted, true); assert.equal(search.value, "Old");
    dispatchClick(toggle); await flushAsync();
    const scope = page.document.getElementById("game-player-picker-scope") as HTMLSelectElement;
    scope.value = "league"; scope.dispatchEvent(new page.window.Event("change", { bubbles: true })); await flushAsync();
    release(createJsonResponse(200, { players: [{ playerId: "obsolete", nickname: "Obsolete", inGame: false }], cursor: "obsolete-page" })); await flushAsync();
    assert.equal(reads, 3); assert.equal(page.document.querySelector('#game-player-picker-list [data-player-id="obsolete"]'), null);
    assert(page.document.querySelector('#game-player-picker-list [data-player-id="fresh"]'));
    assert.equal(page.document.getElementById("game-player-picker-more")!.hidden, true);
    assert.equal(page.document.getElementById("game-player-picker-retry")!.hidden, true);
  } finally { page.dom.window.close(); }
});

test("game page quick-creates and assigns roster players", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-1", role: "admin" });
  apiState.players.clear();
  apiState.gamePlayers.clear();
  apiState.roster.clear();
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
    joinCode: "ABCD2345",
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
  const playerCreateActions = gamePage.document.querySelector('#player-create-form [data-ui="game-details-actions"]');
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
  assert(playerCreateActions instanceof gamePage.window.HTMLElement);
  assert.equal(nicknameInput.form?.id, "player-create-form");
  assert.equal(quickCreateButton.form, nicknameInput.form);
  assert.equal(quickCreateButton.parentElement, playerCreateActions);
  assert(playerPool instanceof gamePage.window.HTMLElement);
  assert(rosterTeams instanceof gamePage.window.HTMLElement);
  assert(scoringTeamInput instanceof gamePage.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof gamePage.window.HTMLFieldSetElement);
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
  assert.equal(playerPool.querySelector(`[data-player-id="${createdPlayer.playerId}"]`), null);
  assert.equal(rosterTeams.querySelectorAll(`[data-ui="roster-member"][data-player-id="${createdPlayer.playerId}"]`).length, 1);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.value, "");
  assert.equal(scorerInput.disabled, true);
  assert.equal(scorerInput.textContent, "Choose scorer");
  assert.equal(saveGoalButton.disabled, true);
  assert.equal(goalFormNote.textContent, "");

  const redRoster = rosterTeams.querySelector('[data-ui="roster-team"][data-team-id="red"]');
  let transferButton = redRoster?.querySelector(
    `[data-action="toggle-transfer"][data-player-id="${createdPlayer.playerId}"]`,
  );
  assert(transferButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(transferButton.getAttribute("aria-label"), "Transfer Ari");
  assert.equal(transferButton.getAttribute("title"), "Transfer Ari");
  assert.equal(transferButton.textContent, "");
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
  assert.equal(transferMenu.querySelector('[data-team-id="blue"]')?.getAttribute("data-context"), "transfer");
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

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = createdPlayer.playerId;
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  dispatchClick(startThirdButton);
  await flushAsync();
  assert.equal(apiState.games.get("game-1")?.thirds[1].startedAt, "2026-03-28T11:00:10.000Z");
  assert.equal(saveGoalButton.disabled, false);
  assert.equal(goalFormNote.textContent, "");
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
    '[data-ui="player-initial"][data-link-state="unlinked"]',
  );
  const malformedRedRoster = page.document.querySelector(
    '[data-ui="roster-team"][data-team-id="red"]',
  );
  const malformedRedChip = page.document.querySelector(
    '[data-ui="team-chip"][data-player-id="player-cy"][data-team-id="red"]',
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
  assert.match(malformedRedRoster.getAttribute("style") ?? "", /^--team-color: #[0-9a-f]{6}$/i);
  assert.match(malformedRedChip.getAttribute("style") ?? "", /^--team-color: #[0-9a-f]{6}$/i);
  assert.doesNotMatch(malformedRedRoster.getAttribute("style") ?? "", /javascript:/i);
  assert.doesNotMatch(malformedRedChip.getAttribute("style") ?? "", /javascript:/i);
  assert.match(validBlueRoster.getAttribute("style") ?? "", /--team-color: #2364d2/);
  assert.equal(spacedIdTransfer.getAttribute("aria-controls"), "transfer-options-player%20one");
  assert(page.document.getElementById("transfer-options-player%20one"));
  assert.equal(unclaimedBadge.getAttribute("aria-hidden"), "true");
  assert.equal(unclaimedBadge.querySelector('[data-ui="player-linked-tick"]'), null);
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
  assert.equal(page.document.activeElement?.getAttribute("data-action"), "retry-game-updates");
  assert.equal(page.document.activeElement?.textContent, "Reload game");
  assert.equal(blueOption.disabled, true, "the uncertain team choice remains visible but cannot be resent");
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Assignment could not be confirmed/);
  assert.equal(page.document.getElementById("setup-status")?.hidden, true);
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
  assert.equal(reconciledTrigger.disabled, true);
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

for (const mode of ["replace", "revoke", "replace-storage", "revoke-storage", "replace-loss", "revoke-loss"] as const) {
  test(`confirmed invitation rotations retire only obsolete records: ${mode}`, async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "rotation", role: "admin" });
    const base = createMockFetch(apiState); let metadata: any = null; let posts = 0; let revokes = 0;
    let fail = false; let failed = false; const bodies: string[] = [];
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "rotation" }), url: "http://localhost:3000/games/rotation#teams",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/player-proofs/invitation/revoke") {
          revokes++; metadata.state = "revoked";
          if (fail && mode === "revoke-loss" && !failed) { failed = true; throw new Error("lost reply"); }
          return createJsonResponse(200, { revoked: true });
        }
        if (path !== "/v1/player-proofs/invitation") return base(input, init);
        if (init.method === "GET") return createJsonResponse(200, { invitation: metadata });
        posts++; bodies.push(String(init.body));
        const body = JSON.parse(String(init.body));
        metadata = { proofId: body.proofId, expiresAt: new Date(Date.now() + 86400_000).toISOString(), state: "pending" };
        if (fail && mode === "replace-loss" && !failed) { failed = true; throw new Error("lost reply"); }
        return createJsonResponse(201, { invitation: metadata });
      },
    });
    try {
      Object.defineProperty(page.window, "confirm", { value: () => true });
      await page.window.eval('(async()=>{const p=await ThreeFcPlayerProof.create("other");ThreeFcPlayerProof.attach(p,{proofId:p.proofId,expiresAt:new Date(Date.now()+86400000).toISOString()},"other");})()');
      const originalSet = page.window.Storage.prototype.setItem;
      Object.defineProperty(page.window.Storage.prototype, "setItem", { configurable: true,
        value: function(this: Storage, key: string, value: string) {
          if (fail && mode.endsWith("storage") && key === "threefc.player-proof.v1") {
            const rows = JSON.parse(value);
            if (mode === "revoke-storage" ? rows.length === 1 : rows.length === 2) throw new Error("cleanup blocked");
          }
          return originalSet.call(this, key, value);
        },
      });
      dispatchClick(page.document.querySelector('[data-action="invite-player-profile"][data-player-id="player-ari"]')!); await flushAsync();
      const create = page.document.getElementById("player-invitation-create") as HTMLButtonElement;
      const revoke = page.document.getElementById("player-invitation-revoke") as HTMLButtonElement;
      dispatchClick(create); await flushAsync();
      const first = metadata.proofId;
      const records = () => JSON.parse(page.window.sessionStorage.getItem("threefc.player-proof.v1") ?? "[]") as any[];
      fail = true;
      if (mode.startsWith("revoke")) {
        dispatchClick(revoke); await flushAsync();
        if (mode === "revoke-storage") {
          assert.equal(revokes, 1); assert.equal(revoke.hidden, true);
          assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /revoked.*couldn’t clear/);
          dispatchClick(create); await flushAsync(); assert.equal(posts, 1);
        } else if (mode === "revoke-loss") {
          assert.equal(records().some(row => row.proofId === first), true);
          dispatchClick(revoke); await flushAsync(); assert.equal(revokes, 2);
        }
      } else {
        dispatchClick(create); await flushAsync();
        if (mode.endsWith("storage") || mode.endsWith("loss")) {
          assert.equal(records().some(row => row.proofId === first), true);
          assert.equal(create.textContent, "Retry link creation");
          fail = false; dispatchClick(create); await flushAsync();
          assert.equal(bodies[1], bodies[2]);
        }
      }
      fail = false;
      for (let rotation = 0; rotation < 25; rotation++) {
        dispatchClick(create); await flushAsync();
        assert.equal(create.disabled, false);
        assert.deepEqual(records().map(row => row.playerId).sort(), ["other", "player-ari"]);
        if (mode.startsWith("revoke")) {
          dispatchClick(revoke); await flushAsync();
          assert.deepEqual(records().map(row => row.playerId), ["other"]);
        }
      }
      assert.equal(records().some(row => row.proofId === first), false);
    } finally { page.dom.window.close(); }
  });
}

for (const operation of ["replace", "revoke"] as const) test(`historical player alias invitations ${operation} the canonical stored proof without changing roster IDs`, async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "alias-invitation", role: "admin" });
  const base = createMockFetch(apiState);
  const invitationReads: URL[] = [];
  const writes: Array<{ path: string; body: string }> = [];
  let metadata: { proofId: string; expiresAt: string; state: string } | null = null;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "alias-invitation" }),
    url: "http://localhost:3000/games/alias-invitation#teams", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/player-proofs/league-invitation")) {
        invitationReads.push(url);
        if ((init.method ?? "GET") === "GET") return createJsonResponse(200, { invitation: metadata });
        writes.push({ path: url.href, body: String(init.body) });
        if (url.pathname.endsWith("/revoke")) return createJsonResponse(200, { revoked: true });
        const body = JSON.parse(String(init.body));
        metadata = { proofId: body.proofId, expiresAt: new Date(Date.now() + 86400_000).toISOString(), state: "pending" };
        if (writes.length === 1) throw new Error("committed replacement response lost");
        return createJsonResponse(201, { invitation: metadata });
      }
      const result = await base(input, init);
      if (url.pathname === "/v1/games/alias-invitation/players" && (init.method ?? "GET") === "GET") {
        const body = await result.json() as { players: Array<{ playerId: string }> };
        return createJsonResponse(result.status, { ...body, players: body.players.map(player => player.playerId === "player-ari"
          ? { ...player, canonicalPlayerId: "retained-ari" } : player) });
      }
      return result;
    },
  });
  try {
    const proofApi = (page.window as unknown as { ThreeFcPlayerProof: {
      create(key: string): Promise<{ proofId: string }>;
      attach(record: unknown, metadata: unknown, playerId: string): unknown;
    } }).ThreeFcPlayerProof;
    const previous = await proofApi.create("existing-league-directory-proof");
    metadata = { proofId: previous.proofId, expiresAt: new Date(Date.now() + 86400_000).toISOString(), state: "pending" };
    proofApi.attach(previous, metadata, "retained-ari");
    Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
    const open = page.document.querySelector('[data-action="invite-player-profile"][data-player-id="player-ari"]');
    assert(open instanceof page.window.HTMLButtonElement);
    dispatchClick(open); await flushAsync();
    assert.equal(invitationReads.length, 1);
    assert.equal(invitationReads[0].searchParams.get("playerId"), "retained-ari");
    assert.equal(invitationReads[0].searchParams.get("leagueId"), "three-sided-football-club");
    const control = page.document.getElementById(operation === "replace" ? "player-invitation-create" : "player-invitation-revoke")!;
    dispatchClick(control);
    for (let tick = 0; tick < 100 && writes.length === 0; tick++) await new Promise(resolve => setTimeout(resolve, 2));
    await flushAsync();
    if (operation === "replace") {
      assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /could not be confirmed/);
      dispatchClick(control); await flushAsync();
      assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1], "lost response retries preserve exact canonical path and body");
      assert.equal(JSON.parse(writes[0].body).replacesProofId, previous.proofId);
      assert.notEqual((page.document.getElementById("player-invitation-link") as HTMLInputElement).value, "");
    } else {
      assert.equal(writes.length, 1); assert.equal(JSON.parse(writes[0].body).proofId, previous.proofId);
      assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /^Private link revoked\.$/);
    }
    for (const call of invitationReads) assert.equal(call.searchParams.get("playerId"), "retained-ari");
    const stored = JSON.parse(page.window.sessionStorage.getItem("threefc.player-proof.v1") ?? "[]") as Array<{ proofId: string; playerId?: string }>;
    assert.equal(stored.some(record => record.proofId === previous.proofId), false, "confirmed operation retires prior root proof");
    if (operation === "replace") assert.equal(stored.find(record => record.proofId === metadata?.proofId)?.playerId, "retained-ari");
    assert(page.document.querySelector('[data-player-id="player-ari"]'));
    assert.equal(page.document.querySelector('[data-player-id="retained-ari"]'), null);
  } finally { page.dom.window.close(); }
});

for (const disposition of ["confirmed", "lost-response", "changed-after-loss", "replacement-loss", "replacement-disabled", "replacement-loss-then-disabled", "replacement-storage-failure", "replacement-write-barrier", "purged"] as const) {
  test(`private profile invitation panel preserves ${disposition} request ownership`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "profile-invitation", role: "admin" });
    const base = createMockFetch(apiState);
    const writes: string[] = [];
    let release: ((response: Response) => void) | undefined;
    let metadata: { proofId: string; expiresAt: string; state: string } | null = null;
    let reads = 0;
    let revokeRequests = 0;
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "profile-invitation" }),
      url: "http://localhost:3000/games/profile-invitation#teams", scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        if (disposition === "replacement-write-barrier" && init.method === "PATCH" && String(input).endsWith("/v1/games/profile-invitation")) {
          return createJsonResponse(503, { error: "unavailable" });
        }
        if (new URL(String(input)).pathname === "/v1/player-proofs/invitation/revoke") revokeRequests += 1;
        if (new URL(String(input)).pathname !== "/v1/player-proofs/invitation") return base(input, init);
        if (init.method === "GET") { reads += 1; return createJsonResponse(200, { invitation: metadata }); }
        writes.push(String(init.body));
        const body = JSON.parse(String(init.body));
        if ((disposition === "replacement-disabled" && writes.length >= 2) || (disposition === "replacement-loss-then-disabled" && writes.length > 2)) return createJsonResponse(503, { error: "unavailable", code: "claims_unavailable" });
        if (metadata?.proofId !== body.proofId) metadata = { proofId: body.proofId, expiresAt: new Date(Date.now() + 86400_000).toISOString(), state: "pending" };
        if (disposition === "purged") return new Promise<Response>(resolve => { release = resolve; });
        if (["lost-response", "changed-after-loss"].includes(disposition) && writes.length === 1) throw new Error("response lost");
        if (disposition === "changed-after-loss") return createJsonResponse(409, { error: "conflict", code: "claim_invite_changed" });
        if (disposition === "replacement-loss" && writes.length === 2) throw new Error("replacement committed; response lost");
        if (disposition === "replacement-loss" && writes.length > 2) return createJsonResponse(409, { error: "conflict", code: "claim_invite_changed" });
        if (disposition === "replacement-loss-then-disabled" && writes.length === 2) throw new Error("replacement committed; response lost");
        return createJsonResponse(201, { invitation: metadata });
      },
    });
    try {
      const open = page.document.querySelector('[data-action="invite-player-profile"][data-player-id="player-ari"]');
      assert(open instanceof page.window.HTMLButtonElement, page.document.getElementById("roster-teams")?.outerHTML ?? page.document.getElementById("setup-error")?.textContent ?? "no roster");
      const panel = page.document.getElementById("player-invitation-panel") as HTMLElement;
      const create = page.document.getElementById("player-invitation-create") as HTMLButtonElement;
      const link = page.document.getElementById("player-invitation-link") as HTMLInputElement;
      dispatchClick(open); await flushAsync();
      assert.equal(reads, 1); assert.equal(writes.length, 0, "opening does not issue a bearer invitation");
      assert.equal(panel.hidden, false);
      assert.equal(page.document.activeElement?.id, "player-invitation-title");
      assert.match(panel.textContent ?? "", /Anyone with this link can link this player to their account\. Share it privately\./);
      dispatchClick(create); dispatchClick(create);
      for (let tick = 0; tick < 100 && writes.length === 0; tick += 1) await new Promise(resolve => setTimeout(resolve, 2));
      await flushAsync(); assert.equal(writes.length, 1);
      if (disposition === "replacement-disabled" || disposition === "replacement-loss-then-disabled") {
        const originalLink = link.value;
        assert.notEqual(originalLink, "");
        Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
        dispatchClick(create); await flushAsync();
        assert.equal(writes.length, 2);
        const copy = page.document.getElementById("player-invitation-copy") as HTMLButtonElement;
        if (disposition === "replacement-loss-then-disabled") {
          dispatchClick(create); await flushAsync();
          assert.equal(writes.length, 3); assert.equal(writes[1], writes[2]);
          assert.equal(link.value, ""); assert.equal(copy.hidden, true);
          assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /could not be confirmed/);
          assert.equal(create.textContent, "Retry link creation");
        } else {
          assert.equal(link.value, originalLink); assert.equal(copy.hidden, false); assert.equal(copy.disabled, false);
          assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /existing link was not replaced/);
          assert.equal(create.textContent, "Replace private link");
          for (let repeat = 0; repeat < 24; repeat += 1) {
            dispatchClick(create); await flushAsync();
            assert.equal(JSON.parse(page.window.sessionStorage.getItem("threefc.player-proof.v1")!).length, 1,
              "definitively rejected drafts must not accumulate or evict the live proof");
            assert.equal(link.value, originalLink);
          }
          dispatchClick(page.document.getElementById("player-invitation-close")!);
          dispatchClick(open); await flushAsync();
          assert.equal(link.value, originalLink); assert.equal(copy.disabled, false);
        }
        return;
      }
      if (disposition === "replacement-write-barrier") {
        const originalLink = link.value;
        assert.notEqual(originalLink, "");
        const field = page.document.getElementById("game-edit-kickoff") as HTMLInputElement;
        field.value = "2030-04-01T10:30";
        field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
        dispatchSubmit(page.document.getElementById("game-edit-form") as HTMLFormElement); await flushAsync();
        assert.match(page.document.getElementById("game-refresh-message")?.textContent ?? "", /earlier change is unconfirmed/);
        Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
        dispatchClick(create); await flushAsync();
        assert.equal(writes.length, 1, "the write barrier prevents replacement fetch");
        assert.equal(link.value, originalLink);
        const copy = page.document.getElementById("player-invitation-copy") as HTMLButtonElement;
        assert.equal(copy.hidden, false); assert.equal(copy.disabled, false);
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /not replaced.*Reload/);
        dispatchClick(page.document.getElementById("player-invitation-close")!);
        dispatchClick(open); await flushAsync();
        assert.equal(link.value, originalLink); assert.equal(copy.disabled, false);
        dispatchClick(page.document.getElementById("player-invitation-revoke")!); await flushAsync();
        assert.equal(revokeRequests, 0);
        assert.equal(link.value, originalLink); assert.equal(copy.disabled, false);
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /Revocation was not sent/);
        return;
      }
      if (disposition === "replacement-storage-failure") {
        const originalLink = link.value;
        assert.notEqual(originalLink, "");
        Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
        Object.defineProperty(page.window.Storage.prototype, "setItem", { value: () => { throw new Error("storage unavailable"); }, configurable: true });
        dispatchClick(create); await flushAsync();
        assert.equal(writes.length, 1, "failed local proof retention never dispatches replacement");
        assert.equal(link.value, originalLink, "undispatched replacement preserves the still-active link");
        const copy = page.document.getElementById("player-invitation-copy") as HTMLButtonElement;
        assert.equal(copy.hidden, false); assert.equal(copy.disabled, false);
        dispatchClick(page.document.getElementById("player-invitation-close")!);
        dispatchClick(open); await flushAsync();
        assert.equal(link.value, originalLink); assert.equal(copy.disabled, false);
        assert.equal(writes.length, 1);
        return;
      }
      if (disposition === "replacement-loss") {
        assert.notEqual(link.value, "");
        Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
        dispatchClick(create); await flushAsync();
        assert.equal(writes.length, 2);
        assert.equal(link.value, "", "old link is hidden once replacement dispatches");
        assert.equal((page.document.getElementById("player-invitation-copy") as HTMLButtonElement).hidden, true);
        dispatchClick(create); await flushAsync();
        assert.equal(writes.length, 3); assert.equal(writes[1], writes[2]);
        assert.equal(link.value, "");
        assert.equal((page.document.getElementById("player-invitation-copy") as HTMLButtonElement).hidden, true);
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /private link changed/);
        return;
      }
      if (disposition === "lost-response" || disposition === "changed-after-loss") {
        assert.equal(create.textContent, "Retry link creation");
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /same request/);
        dispatchClick(create); await flushAsync();
        assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]);
      }
      if (disposition === "changed-after-loss") {
        assert.equal(link.value, "");
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /private link changed/);
        dispatchClick(page.document.getElementById("player-invitation-close")!);
        dispatchClick(open); await flushAsync();
        assert.equal(reads, 2); assert.equal(create.disabled, false);
        return;
      }
      if (disposition === "purged") {
        assert(release);
        (page.window as unknown as { ThreeFcPlayerProof: { clear(): void } }).ThreeFcPlayerProof.clear();
        release(createJsonResponse(201, { invitation: metadata })); await flushAsync();
        assert.equal(panel.hidden, true); assert.equal(link.value, "");
        assert.equal(page.document.getElementById("player-invitation-status")?.textContent, "");
      } else {
        assert.match(link.value, /\/link-player#proofId=[^&]+&secret=/);
        assert.doesNotMatch(writes[0], /"secret"/);
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /expires on/);
        panel.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        assert.equal(panel.hidden, true);
        assert.equal(page.document.activeElement?.getAttribute("data-action"), "toggle-action-menu");
        dispatchClick(open); await flushAsync();
        assert.equal(reads, 1, "reopening retains the link without another issuance/read");
        assert.equal(panel.hidden, false);
      }
    } finally { page.dom.window.close(); }
  });
}

for (const ownership of ["retained", "outside", "changed", "lost-then-barrier"] as const) {
  test(`private profile invitation revoke preserves ${ownership} focus`, async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "invite-revoke", role: "admin" });
    const base = createMockFetch(apiState); let release: (() => void) | undefined; let revokeWrites = 0;
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "invite-revoke" }),
      url: "http://localhost:3000/games/invite-revoke#teams", scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => {
        if (ownership === "lost-then-barrier" && init?.method === "PATCH" && String(input).endsWith("/v1/games/invite-revoke")) return createJsonResponse(503, { error: "unavailable" });
        if (new URL(String(input)).pathname === "/v1/player-proofs/invitation") return createJsonResponse(200, { invitation: {
          proofId: "existing-profile-proof-123", expiresAt: new Date(Date.now() + 86400_000).toISOString(), state: "pending",
        } });
        if (new URL(String(input)).pathname === "/v1/player-proofs/invitation/revoke") { revokeWrites += 1; return new Promise<Response>(resolve => { release = () => resolve(ownership === "lost-then-barrier"
          ? createJsonResponse(503, { error: "unavailable" }) : ownership === "changed"
          ? createJsonResponse(409, { error: "conflict", code: "claim_invite_changed" })
          : createJsonResponse(200, { revoked: true })); }); }
        return base(input, init);
      },
    });
    try {
      const open = page.document.querySelector('[data-action="invite-player-profile"][data-player-id="player-ari"]');
      assert(open instanceof page.window.HTMLButtonElement); dispatchClick(open); await flushAsync();
      const button = page.document.getElementById("player-invitation-revoke") as HTMLButtonElement;
      Object.defineProperty(page.window, "confirm", { value: (copy: string) => {
        assert.match(copy, /Anyone who received it will no longer be able to use it/); return true;
      }, configurable: true });
      button.focus(); dispatchClick(button); await flushAsync(); assert(release);
      const outside = page.document.createElement("button"); page.document.body.append(outside);
      if (ownership === "outside") outside.focus();
      release(); await flushAsync();
      if (ownership === "lost-then-barrier") {
        assert.equal(revokeWrites, 1); assert.equal(button.hidden, false);
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /Revocation could not be confirmed/);
        const field = page.document.getElementById("game-edit-kickoff") as HTMLInputElement;
        field.value = "2030-04-01T10:30"; field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
        dispatchSubmit(page.document.getElementById("game-edit-form") as HTMLFormElement); await flushAsync();
        assert.match(page.document.getElementById("game-refresh-message")?.textContent ?? "", /earlier change is unconfirmed/);
        dispatchClick(button); await flushAsync();
        assert.equal(revokeWrites, 1);
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /retry was not sent.*earlier revocation is still unconfirmed/);
        return;
      }
      assert.equal(button.hidden, true);
      assert.equal(page.document.activeElement, ownership === "outside" ? outside : page.document.getElementById("player-invitation-status"));
      if (ownership === "changed") {
        assert.match(page.document.getElementById("player-invitation-status")?.textContent ?? "", /private link changed/);
        dispatchClick(page.document.getElementById("player-invitation-close")!);
        dispatchClick(open); await flushAsync();
        assert.equal(button.hidden, false, "reopening refreshes the active link instead of retrying a stale revocation forever");
        assert.equal(button.disabled, false);
      } else assert.equal(page.document.getElementById("player-invitation-status")?.textContent, "Private link revoked.");
    } finally { page.dom.window.close(); }
  });
}

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
  const assignedPlayer = page.document.querySelector('[data-ui="roster-member"][data-player-id="player-delegate"]');
  assert(assignedPlayer);
  assert.doesNotMatch(playerPool.textContent ?? "", /delegate@3fc\.football/);
  assert.doesNotMatch(playerPool.innerHTML, /delegate@3fc\.football|data-user-id/);
  assert.equal(
    assignedPlayer.querySelector('[data-ui="player-initial"]')?.getAttribute("data-link-state"),
    "linked",
  );

  let confirmation = "";
  Object.defineProperty(page.window, "confirm", { value: (message: string) => { confirmation = message; return true; } });
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
  assert.match(confirmation, /score all games in Three Sided Football Club/);
  assert.equal(page.document.querySelector('[data-action="grant-player-access"][data-player-id="player-delegate"][data-role="scorekeeper"]'), null);
});

for (const focusDestination of ["surface", "outside"] as const) {
  test(`action menus roster redraw preserves pending surface ownership after moving to ${focusDestination}`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "game-pending-menu-focus", role: "admin" });
    for (const [id, email] of [["player-ari", "ari@example.com"], ["player-bea", "bea@example.com"]] as const) {
      const player = apiState.players.get(id);
      assert(player);
      player.claimedByUserId = email;
    }
    const baseFetch = createMockFetch(apiState);
    let releaseAccess: (() => void) | undefined;
    let writes = 0;
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "game-pending-menu-focus" }),
      url: "http://localhost:3000/games/game-pending-menu-focus#teams", scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => {
        if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/access")) {
          writes += 1;
          return new Promise<Response>((resolve) => { releaseAccess = () => { void baseFetch(input, init).then(resolve); }; });
        }
        return baseFetch(input, init);
      },
    });
    try {
      Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
      const promoteAri = page.document.querySelector('[data-action="grant-player-access"][data-player-id="player-ari"][data-role="scorekeeper"]');
      assert(promoteAri instanceof page.window.HTMLButtonElement);
      openActionMenuFor(promoteAri);
      dispatchClick(promoteAri);
      assert(releaseAccess);
      const beaAction = page.document.querySelector('[data-action="grant-player-access"][data-player-id="player-bea"]');
      assert(beaAction instanceof page.window.HTMLButtonElement);
      const { surface: pendingSurface } = openActionMenuFor(beaAction);
      const pendingActions = [...pendingSurface.querySelectorAll<HTMLButtonElement>('button[data-action="grant-player-access"]')];
      assert.deepEqual(pendingActions.map(button => [button.getAttribute("data-role"), button.textContent?.trim(), button.disabled]), [
        ["scorekeeper", "Make scorer", true], ["admin", "Make co-organiser", true],
      ]);
      assert.equal(pendingSurface.querySelector("button:not(:disabled)"), null);
      assert.equal(page.document.activeElement, pendingSurface, "the all-disabled group itself receives focus");
      const outside = page.document.querySelector('[data-ui="site-nav"] a');
      assert(outside instanceof page.window.HTMLAnchorElement);
      if (focusDestination === "outside") outside.focus();
      releaseAccess();
      releaseAccess = undefined;
      await flushAsync();
      const replacement = page.document.getElementById("player-actions-player-bea");
      assert(replacement instanceof page.window.HTMLElement);
      assert.equal(replacement, pendingSurface, "keyed roster updates retain the actual focused group instead of replacing it");
      const settledActions = [...replacement.querySelectorAll<HTMLButtonElement>('button[data-action="grant-player-access"]')];
      assert.equal(settledActions.length, pendingActions.length);
      settledActions.forEach((button, index) => assert.equal(button, pendingActions[index], "the existing native action controls survive the update"));
      assert.deepEqual(settledActions.map(button => [button.getAttribute("data-role"), button.textContent?.trim(), button.disabled]), [
        ["scorekeeper", "Make scorer", false], ["admin", "Make co-organiser", false],
      ], "pending cleanup updates real disabled state in both the open and outside-focus cases");
      const ariRow = page.document.querySelector('[data-ui="roster-member"][data-player-id="player-ari"]'); assert(ariRow);
      assert.equal(ariRow.querySelector('[data-ui="player-initial"]')?.getAttribute("data-link-state"), "linked");
      assert.match(ariRow.textContent ?? "", /Scorer/);
      assert.equal(ariRow.querySelector('[data-action="grant-player-access"][data-role="scorekeeper"]'), null);
      assert.equal(ariRow.querySelector('[data-action="grant-player-access"][data-role="admin"]')?.textContent?.trim(), "Make co-organiser");
      assert.equal(writes, 1);
      assert.equal(apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "ari@example.com")), "scorekeeper");
      assert.equal(apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "bea@example.com")), undefined);
      if (focusDestination === "surface") {
        assert.equal(page.document.activeElement, replacement);
        assert.equal(replacement.hidden, false);
        assert.equal(replacement.closest('[data-ui="action-menu"]')?.querySelector('[data-action="toggle-action-menu"]')?.getAttribute("aria-expanded"), "true");
        assert(replacement.querySelector("button:not(:disabled)"), "the completed operation releases the other player's actions");
      } else {
        assert.equal(page.document.activeElement, outside);
        assert.equal(replacement.hidden, true);
      }
    } finally {
      releaseAccess?.();
      await flushAsync();
      page.dom.window.close();
    }
  });
}

for (const outcome of ["scorer", "admin", "failure", "uncertain", "outside"] as const) {
  test(`match promotion preserves keyboard ownership after ${outcome}`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "game-promotion-focus", role: "admin" });
    const ari = apiState.players.get("player-ari");
    assert(ari);
    ari.claimedByUserId = "claimed@example.com";
    const original = createMockFetch(apiState);
    let release: ((response: Response) => void) | undefined;
    let response: Response | undefined;
    let writes = 0;
    const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
      const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
      if (path.endsWith("/access") && init.method === "POST") {
        writes += 1;
        response = outcome === "failure" ? createJsonResponse(403, { message: "Forbidden" }) : await original(input, init);
        if (outcome === "uncertain") response = createJsonResponse(503, { message: "Response lost after commit" });
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      return original(input, init);
    };
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-promotion-focus" }), url: "http://localhost:3000/games/game-promotion-focus#teams", scriptFile: "setup-flow.js", apiState, fetch });
    Object.defineProperty(page.window, "confirm", { value: () => true });
    const action = page.document.querySelector(`[data-action="grant-player-access"][data-player-id="player-ari"][data-role="${outcome === "admin" ? "admin" : "scorekeeper"}"]`);
    assert(action instanceof page.window.HTMLButtonElement);
    openActionMenuFor(action);
    action.focus();
    dispatchClick(action);
    dispatchClick(action);
    await flushAsync();
    assert.equal(writes, 1);
    const outside = page.document.querySelector('[data-ui="site-nav"] a');
    assert(outside instanceof page.window.HTMLAnchorElement);
    if (outcome === "outside") outside.focus();
    assert(release && response);
    release(response);
    await flushAsync();
    if (outcome === "uncertain") {
      assert.equal(apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "claimed@example.com")), "scorekeeper");
      assert.equal(page.document.getElementById("setup-error")?.textContent, "Access change could not be confirmed. Reload to check before trying again.");
      assert.equal(page.document.getElementById("setup-status")?.hidden, true);
      assert.equal(writes, 1);
    }
    if (outcome === "outside") assert.equal(page.document.activeElement, outside);
    else if (outcome === "uncertain") {
      assert.equal(page.document.activeElement?.getAttribute("data-action"), "retry-game-updates");
      assert.equal(page.document.activeElement?.textContent, "Reload game");
    }
    else if (outcome === "admin") {
      assert.equal(page.document.activeElement?.getAttribute("data-player-id"), "player-ari");
      assert.equal(page.document.activeElement?.querySelector('[data-player-management]'), null);
    } else {
      assert.equal(page.document.activeElement?.getAttribute("data-action"), "toggle-action-menu");
      assert.equal(page.document.activeElement?.getAttribute("aria-label"), "Actions for Ari");
      assert.equal(page.document.activeElement?.getAttribute("aria-expanded"), "false");
    }
  });
}

for (const statusCode of [403, 503]) {
  test(`match transfer distinguishes ${statusCode} rejection from uncertainty without automatic retry`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "game-transfer-outcome", role: "admin" });
    const original = createMockFetch(apiState);
    let writes = 0;
    const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
      if (init.method === "PUT") {
        writes += 1;
        return createJsonResponse(statusCode, { message: "Unavailable" });
      }
      return original(input, init);
    };
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "game-transfer-outcome" }), url: "http://localhost:3000/games/game-transfer-outcome#teams", scriptFile: "setup-flow.js", apiState, fetch });
    const toggle = page.document.querySelector('[data-action="toggle-transfer"][data-player-id="player-ari"]');
    assert(toggle instanceof page.window.HTMLButtonElement);
    dispatchClick(toggle);
    const choice = page.document.querySelector('#transfer-options-player-ari [data-team-id="blue"]');
    assert(choice instanceof page.window.HTMLButtonElement);
    dispatchClick(choice);
    dispatchClick(choice);
    await flushAsync();
    assert.equal(writes, 1);
    assert.equal(page.document.getElementById("transfer-options-player-ari")?.hidden, false);
    if (statusCode === 503) {
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed.*Reload to check before making more changes/);
      assert.equal(page.document.getElementById("setup-status")?.hidden, true);
    } else assert.equal(page.document.getElementById("setup-status")?.textContent, "Roster assignment failed.");
  });
}

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
  assert(playersTab instanceof page.window.HTMLAnchorElement);
  assert(runTab instanceof page.window.HTMLAnchorElement);
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(assistsElement instanceof page.window.HTMLElement);
  assert.equal(runMode.hidden, true);
  dispatchClick(runTab);
  assert.equal(runMode.hidden, false);

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
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
  assert.equal(goalTeamValue(scoringTeamInput), "red");
  assert.equal(goalTeamValue(concedingTeamInput), "blue");
  assert.equal(scorerInput.value, "player-ari");
  const preservedAssist = assistsElement.querySelector('input[value="player-bea"]');
  assert(preservedAssist instanceof page.window.HTMLInputElement);
  assert.equal(preservedAssist.checked, true);
});

test("game page saves metadata in overview without starting scoring", async () => {
  const apiState = createMockApiState();
  const runningThirds = createDefaultThirdTimerSegments();
  runningThirds[0] = {
    ...runningThirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-mode-save-running",
    role: "admin",
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
  assert(structureTab instanceof page.window.HTMLAnchorElement);
  assert(kickoffInput instanceof page.window.HTMLInputElement);
  assert(saveGameButton instanceof page.window.HTMLButtonElement);
  assert.equal(runMode.hidden, true);

  dispatchClick(structureTab);
  await flushAsync();
  assert.equal(structureMode.hidden, false);
  assert.equal(runMode.hidden, true);

  const edit = page.document.querySelector('[data-action="toggle-game-edit"]');
  assert(edit instanceof page.window.HTMLButtonElement);
  dispatchClick(edit);
  kickoffInput.value = "2026-03-28T10:30";
  kickoffInput.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  dispatchClick(saveGameButton);
  await flushAsync();

  assert.equal(apiState.games.get("game-mode-save-running")?.gameStartTs, new Date("2026-03-28T10:30").toISOString());
  assert.equal(structureMode.hidden, false);
  assert.equal(runMode.hidden, true);
  assert.equal(page.document.getElementById("game-edit-region")?.hidden, true);
});

test("game page mode panels advance from overview through scoring to results", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-mode-advance" });
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-mode-advance" }),
    url: "http://localhost:3000/games/game-mode-advance", scriptFile: "setup-flow.js", apiState,
  });
  const overview = page.document.getElementById("game-mode-structure");
  const teams = page.document.getElementById("game-mode-players");
  const run = page.document.getElementById("game-mode-run");
  const results = page.document.getElementById("game-mode-final");
  const teamsTab = page.document.querySelector('[data-testid="game-mode-players-tab"]');
  const resultsTab = page.document.querySelector('[data-testid="game-mode-final-tab"]');
  const score = page.document.querySelector('[data-testid="game-mode-run-tab"]');
  const start = page.document.querySelector('[data-action="start-active-third"]');
  const finish = page.document.querySelector('[data-action="finish-active-third"]');
  const finishGame = page.document.querySelector('[data-action="finish-game"]');
  assert(overview instanceof page.window.HTMLElement);
  assert(teams instanceof page.window.HTMLElement);
  assert(run instanceof page.window.HTMLElement);
  assert(results instanceof page.window.HTMLElement);
  assert(teamsTab instanceof page.window.HTMLAnchorElement);
  assert(resultsTab instanceof page.window.HTMLAnchorElement);
  assert(score instanceof page.window.HTMLAnchorElement);
  assert(start instanceof page.window.HTMLButtonElement);
  assert(finish instanceof page.window.HTMLButtonElement);
  assert(finishGame instanceof page.window.HTMLButtonElement);
  assert.equal(overview.hidden, false);
  assert.equal(page.document.getElementById("game-overview-status")?.textContent, "Scheduled");
  assert.equal(resultsTab.hidden, true);
  assert.equal(resultsTab.textContent?.trim(), "Results");
  dispatchClick(teamsTab);
  assert.equal(teams.hidden, false);
  assert.equal(page.window.location.hash, "#teams");
  assert.equal(page.document.activeElement, teams);
  dispatchClick(score);
  assert.equal(run.hidden, false);
  assert.equal(score.hidden, false, "the current scoring destination remains in stable navigation");
  assert.equal(score.getAttribute("aria-current"), "page");
  assert.equal(page.document.activeElement, run);
  assert.equal(page.window.location.hash, "#score");
  for (let third = 1; third <= 3; third += 1) {
    start.focus();
    dispatchClick(start);
    await flushAsync();
    assert.equal(apiState.games.get("game-mode-advance")?.status, "live");
    assert.equal(page.document.getElementById("game-overview-status")?.textContent, "Live");
    assert.equal(resultsTab.hidden, true);
    assert.equal(finish.disabled, false);
    finish.focus();
    dispatchClick(finish);
    await flushAsync();
    assert.equal(run.hidden, false);
    assert.equal(results.hidden, true);
  }
  assert.equal(finishGame.disabled, false);
  finishGame.focus();
  dispatchClick(finishGame);
  await flushAsync();
  assert.equal(apiState.games.get("game-mode-advance")?.status, "finished");
  assert.equal(page.document.getElementById("game-overview-status")?.textContent, "Finished");
  assert.equal(results.hidden, false);
  assert.equal(resultsTab.hidden, false);
  assert.equal(resultsTab.getAttribute("aria-current"), "page");
  assert.equal(page.window.location.hash, "#results");
  assert.equal(page.document.activeElement, results);
  assert.match(page.document.getElementById("game-result-summary")?.textContent ?? "", /Draw/);
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

  assert.equal(deleteButton.disabled, true);
  assert.equal(deleteButton.getAttribute("aria-disabled"), "true");
  assert.equal(deleteReason.hidden, false);
  const statusBefore = page.document.getElementById("setup-status")?.textContent;
  openActionMenuFor(deleteButton);
  deleteButton.focus();
  assert.notEqual(page.document.activeElement, deleteButton);
  dispatchClick(deleteButton);
  assert.equal(deleteRequests, 0);
  assert.equal(page.document.getElementById("setup-status")?.textContent, statusBefore);
});

test("action menus keep game deletion pending through timer redraws and repeated activation", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0].startedAt = "2026-03-28T11:00:00.000Z";
  seedGoalScoringGame(apiState, { gameId: "game-delete-menu-pending", status: "live", role: "admin", thirds });
  const baseFetch = createMockFetch(apiState);
  let writes = 0;
  let tick: (() => void) | undefined;
  let resolveDelete: ((response: Response) => void) | undefined;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-delete-menu-pending" }),
    url: "http://localhost:3000/games/game-delete-menu-pending", scriptFile: "setup-flow.js", apiState,
    captureInterval: callback => { tick = callback; return 1; },
    fetch: async (input, init) => {
      if (init?.method === "DELETE") {
        writes += 1;
        return new Promise<Response>(resolve => { resolveDelete = resolve; });
      }
      return baseFetch(input, init);
    },
  });
  try {
    Object.defineProperty(page.window, "confirm", { configurable: true, value: () => true });
    const action = page.document.querySelector('[data-testid="delete-game"]');
    assert(action instanceof page.window.HTMLButtonElement);
    openActionMenuFor(action);
    dispatchClick(action);
    assert.equal(writes, 1);
    assert(tick);
    tick();
    assert.equal(action.disabled, true, "timer rendering must not release the pending request");
    openActionMenuFor(action);
    dispatchClick(action);
    assert.equal(writes, 1);
    assert(resolveDelete);
    resolveDelete(createJsonResponse(503, { message: "Delete could not be confirmed" }));
    await flushAsync();
    assert.equal(action.disabled, true, "an ambiguous delete requires reload rather than another mutation");
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /deletion could not be confirmed.*Reload/);
    action.disabled = false; dispatchClick(action); await flushAsync();
    assert.equal(writes, 1, "synthetic re-enabling cannot bypass the absorbing write lock");
    assert.equal(page.navigations.length, 0);
  } finally { page.dom.window.close(); }
});

test("game page keeps early scoring unavailable until game authority has loaded", async () => {
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
  const gameStateTab = page.document.querySelector('[data-testid="game-mode-run-tab"]');

  assert(structureMode instanceof page.window.HTMLElement);
  assert(runMode instanceof page.window.HTMLElement);
  assert(gameStateTab instanceof page.window.HTMLAnchorElement);

  dispatchClick(gameStateTab);
  await flushAsync();
  assert.equal(structureMode.hidden, false);
  assert.equal(runMode.hidden, true);
  assert.equal(gameStateTab.hidden, true);
  assert.equal(gameStateTab.getAttribute("aria-disabled"), "true");

  const game = apiState.games.get("game-state-loading");
  assert(game);
  resolveGameResponse(createJsonResponse(200, game));
  await flushAsync();

  assert.equal(structureMode.hidden, false);
  assert.equal(runMode.hidden, true);
  assert.equal(gameStateTab.hidden, false);
  assert.notEqual(gameStateTab.getAttribute("aria-disabled"), "true");
  dispatchClick(gameStateTab);
  assert.equal(runMode.hidden, false);
});

test("game page opens completed live timers in overview with explicit scoring task", async () => {
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
  assert.equal(finalMode.hidden, true);
  assert.equal(page.document.getElementById("game-mode-structure")?.hidden, false);
  const score = page.document.querySelector('[data-testid="game-mode-run-tab"]');
  assert(score instanceof page.window.HTMLAnchorElement);
  dispatchClick(score);
  assert.equal(runMode.hidden, false);
  assert.equal(finishGameButton.disabled, false);
  assert.equal(finalStatus.textContent, "Live");
  assert.equal(page.document.getElementById("final-game-id-value"), null);
  assert.equal(page.document.getElementById("final-game-readiness"), null);
});

test("game page renders one full match log and aggregate player stats", async () => {
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
  const scorerStats = page.document.querySelector('[data-testid="final-scorer-stats"]');
  const assistStats = page.document.querySelector('[data-testid="final-assist-stats"]');
  const ownGoalStats = page.document.querySelector('[data-testid="final-own-goal-stats"]');
  const fullGoalLog = page.document.querySelector('[data-testid="final-full-goal-log"]');

  assert(resultSummary instanceof page.window.HTMLElement);
  assert.equal(page.document.querySelector('[data-testid^="final-team-log-"]'), null);
  assert(scorerStats instanceof page.window.HTMLElement);
  assert(assistStats instanceof page.window.HTMLElement);
  assert(ownGoalStats instanceof page.window.HTMLElement);
  assert(fullGoalLog instanceof page.window.HTMLElement);
  assert.equal(resultSummary.hidden, false);
  assert.doesNotMatch(resultSummary.textContent ?? "", /Computed|2026-03-28 22:02|Z\b|UTC/);
  assert.match(fullGoalLog.textContent ?? "", /Ari/);
  assert.match(fullGoalLog.textContent ?? "", /1"/);
  assert.match(fullGoalLog.textContent ?? "", /Assists: Bea/);
  assert.match(fullGoalLog.textContent ?? "", /Bea\s*OG/);
  assert.match(fullGoalLog.textContent ?? "", /75\+3"/);
  assert.doesNotMatch(fullGoalLog.textContent ?? "", /Conceded-only|Assists: None/);
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
    fullGoalLog.querySelector('[data-event-id="goal-1"] [data-team-id="red"]')?.getAttribute("aria-label"),
    "Scoring team: Red",
  );
  assert.equal(
    fullGoalLog.querySelector('[data-event-id="goal-3"] [data-team-id="red"]')?.getAttribute("aria-label"),
    "Conceding team: Red",
  );
  assert.equal(fullGoalLog.querySelectorAll('[data-event-id="goal-3"] [data-ui="goal-team-chip"]').length, 1);
  assert(fullGoalLog.querySelector('[data-event-id="goal-3"] [aria-label="Own goal"]'));
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
  assert.match(latestGoal.textContent ?? "", /75\+3"\s*Bea\s*OG\s*→/);
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
    if (method === "GET" && target.pathname === "/v1/games/game-goals-fail/roster") {
      const response = await defaultFetch(input, init);
      const payload = (await response.json()) as {
        teams?: Array<Record<string, unknown>>;
        roster?: unknown[];
      };
      return createJsonResponse(200, {
        ...payload,
        teams: (payload.teams ?? []).map((team) => ({
          ...team,
          conceded: 0,
          scored: 0,
        })),
      });
    }

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
  enterFinishedCorrections(page);

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
  assert.equal(error.hidden, true, "the result panel owns the partial-log failure without duplicate global copy");
  assert.equal(status.hidden, true);
  assert.match(rosterTeams.textContent ?? "", /Red/);
  assert.match(timeline.textContent ?? "", /Goal timeline unavailable/);
  assert.equal(resultSummary.hidden, false);
  assert.match(resultSummary.textContent ?? "", /Red win/);
  assert.match(resultSummary.textContent ?? "", /Goal summaries unavailable/);
  assert.doesNotMatch(resultSummary.textContent ?? "", /No goals recorded|No scorers recorded/);
  const initialRedScoreCard = page.document.querySelector('[data-ui="score-team"][data-team-id="red"]');
  const initialBlueScoreCard = page.document.querySelector('[data-ui="score-team"][data-team-id="blue"]');
  assert(initialRedScoreCard instanceof page.window.HTMLElement);
  assert(initialBlueScoreCard instanceof page.window.HTMLElement);
  assert.deepEqual(
    [...initialRedScoreCard.querySelectorAll("dl div")].map((row) =>
      row.textContent?.replace(/\s/g, ""),
    ),
    ["Conceded0", "Scored1"],
  );
  assert.deepEqual(
    [...initialBlueScoreCard.querySelectorAll("dl div")].map((row) =>
      row.textContent?.replace(/\s/g, ""),
    ),
    ["Conceded1", "Scored0"],
  );
  assert.equal(page.document.querySelector('[data-testid="final-full-goal-log"]'), null);
  assert.equal(quickCreateButton.disabled, true);
  enterFinishedCorrections(page, true);
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

  assert.equal(note.textContent, "Editing keeps the original time.");
});

for (const kind of ["create", "edit", "delete", "undo"] as const) {
  for (const firstOutcome of ["lost-response", "idempotency_in_progress", "idempotency_conflict", "goal_already_created", "malformed-conflict"] as const) {
    test(`live scoring freezes ${kind} after ${firstOutcome} through a later rejection`, async (t) => {
      const apiState = createMockApiState();
      const gameId = `frozen-${kind}-${firstOutcome}`;
      const thirds = createDefaultThirdTimerSegments();
      thirds[0].startedAt = "2026-03-28T11:00:10.000Z";
      seedGoalScoringGame(apiState, { gameId, status: "live", thirds });
      seedLiveGoalEvent(apiState, gameId, "original-goal", 30);
      seedLiveGoalEvent(apiState, gameId, "original-latest", 40);
      const baseFetch = createMockFetch(apiState);
      const requests: Array<{ method: string; path: string; body: string; key: string | null }> = [];
      let replay: unknown;
      const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
        const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
        const method = (init.method ?? "GET").toUpperCase();
        if (method !== "GET" && target.pathname.startsWith(`/v1/games/${gameId}/`)) {
          requests.push({ method, path: target.pathname, body: String(init.body ?? ""), key: readInitHeader(init, "idempotency-key") });
          if (requests.length === 1) {
            if (firstOutcome === "lost-response") {
              const committed = await baseFetch(input, init);
              assert.equal(committed.ok, true, "the lost-response case really commits");
              replay = await committed.json();
              seedLiveGoalEvent(apiState, gameId, "newer-external-goal", 50);
              return createJsonResponse(503, { error: "unavailable", message: "Response lost." });
            }
            return createJsonResponse(409, firstOutcome === "malformed-conflict"
              ? { error: "unknown", code: "game_finished", message: "Unknown conflict." }
              : { error: firstOutcome, message: "Operation not confirmed." });
          }
          if (requests.length === 2) return createJsonResponse(403, { error: "forbidden", message: "Temporary access rejection." });
          if (replay) return createJsonResponse(200, replay);
        }
        return baseFetch(input, init);
      };
      const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#score`, scriptFile: "setup-flow.js", apiState, fetch });
      t.after(() => page.window.close());
      Object.defineProperty(page.window, "confirm", { value: () => true });
      const c = liveGoalControls(page);
      c.draft();
      const assist = page.document.querySelector('#goal-assists input[value="player-bea"]');
      assert(assist instanceof page.window.HTMLInputElement);
      assist.checked = true;
      assist.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      if (kind === "edit") {
        dispatchClick(page.document.querySelector('[data-action="edit-goal"][data-event-id="original-goal"]') as HTMLButtonElement);
        c.draft();
      }
      if (kind === "create" || kind === "edit") dispatchSubmit(c.form);
      else if (kind === "delete") dispatchClick(page.document.querySelector('[data-action="delete-goal"][data-event-id="original-goal"]') as HTMLButtonElement);
      else dispatchClick(c.undo);
      await flushAsync();
      assert.equal(requests.length, 1);
      assert.equal(c.retry.hidden, false);
      assert.equal(c.retry.disabled, false);
      assert.equal(page.document.getElementById("goal-operation-recovery")?.hidden, false);
      assert.equal(c.form.contains(c.retry), false, "recovery is not a new-goal submission");
      for (const field of [c.scoring, c.conceding, c.scorer, c.ownGoal, c.save, c.cancel, c.undo]) assert.equal(field.disabled, true);
      const finishThird = page.document.querySelector('[data-action="finish-active-third"]');
      assert(finishThird instanceof page.window.HTMLButtonElement && finishThird.disabled);
      const originalScorer = c.scorer.value;
      c.choose(c.scoring, "yellow");
      assert.equal(goalTeamValue(c.scoring), "red", "a redraw cannot supersede the frozen draft");
      c.scorer.value = "";
      c.scorer.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      assert.equal(c.scorer.value, originalScorer);
      dispatchSubmit(c.form);
      dispatchClick(c.cancel);
      dispatchClick(c.undo);
      dispatchClick(finishThird);
      const otherDelete = page.document.querySelector('[data-action="delete-goal"][data-event-id="original-latest"]');
      if (otherDelete instanceof page.window.HTMLButtonElement) dispatchClick(otherDelete);
      await flushAsync();
      assert.equal(requests.length, 1, "other mutations stay blocked");
      dispatchClick(c.retry);
      await flushAsync();
      assert.equal(requests.length, 2);
      assert.equal(c.retry.hidden, false, "a later403 cannot retire an uncertain operation");
      assert.equal(c.save.disabled, true);
      assert.equal(page.document.getElementById("setup-status")?.hidden, true);
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Could not confirm/);
      dispatchClick(c.retry);
      await flushAsync();
      assert.equal(requests.length, 3);
      assert.ok(requests[0].key);
      assert.deepEqual(requests[1], requests[0]);
      assert.deepEqual(requests[2], requests[0]);
      if (kind === "undo") assert.equal(JSON.parse(requests[0].body).expectedEventId, "original-latest");
      if (kind === "edit" || kind === "delete") assert.match(requests[0].path, /\/original-goal$/);
      assert.equal(c.retry.hidden, true);
      assert.equal(page.document.getElementById("goal-operation-recovery")?.hidden, true);
      if (firstOutcome === "lost-response") {
        assert(apiState.goalEvents.has("newer-external-goal"));
        assert(page.document.querySelector('[data-ui="goal-event"][data-event-id="newer-external-goal"]'), "fresh GET replaces stale replay timeline");
      }
      if (kind === "delete") assert.equal(apiState.goalEvents.has("original-goal"), false);
      if (kind === "undo") assert.equal(apiState.goalEvents.has("original-latest"), false);
      if (kind === "delete" || kind === "undo") {
        assert.equal(goalTeamValue(c.scoring), "red", "an unrelated draft survives log changes");
        assert.equal(goalTeamValue(c.conceding), "blue");
        assert.equal(c.scorer.value, "player-ari");
        assert.equal(page.document.querySelectorAll('#goal-assists input:checked').length, 1);
      } else {
        assert.equal(goalTeamValue(c.scoring), "");
        assert.equal(goalTeamValue(c.conceding), "");
        assert.equal(c.scorer.value, "");
      }
    });
  }
}

test("live scoring submits native radios once and preserves focus ownership through a pending save", async (t) => {
  const apiState = createMockApiState();
  const gameId = "native-radio-save";
  const thirds = createDefaultThirdTimerSegments();
  thirds[0].startedAt = "2026-03-28T11:00:10.000Z";
  seedGoalScoringGame(apiState, { gameId, status: "live", thirds });
  const baseFetch = createMockFetch(apiState);
  let release: (() => void) | undefined;
  let writes = 0;
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    if (init.method === "POST" && path.endsWith("/goals")) {
      writes += 1;
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return baseFetch(input, init);
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#score`, scriptFile: "setup-flow.js", apiState, fetch });
  t.after(() => page.window.close());
  const c = liveGoalControls(page);
  assert.equal(goalTeamValue(c.scoring), "");
  assert.equal(c.conceding.disabled, true);
  assert.equal(c.scorer.disabled, true);
  assert.deepEqual([...c.scoring.querySelectorAll("input")].map((radio) => radio.value), ["red", "blue", "yellow"]);
  assert.deepEqual([...page.document.querySelectorAll('[data-ui="score-team"]')].map((team) => team.getAttribute("data-team-id")), ["red", "blue", "yellow"]);
  const red = c.scoring.querySelector('input[value="red"]');
  assert(red instanceof page.window.HTMLInputElement);
  red.focus();
  dispatchClick(red);
  assert.equal(page.document.activeElement?.getAttribute("name"), "goal-scoring-team");
  assert.equal((page.document.activeElement as HTMLInputElement).value, "red");
  assert.equal(c.conceding.querySelector('input[value="red"]')?.matches(":disabled"), true);
  c.draft();
  c.save.focus();
  const child = page.document.createElement("span");
  c.save.append(child);
  dispatchClick(child);
  dispatchSubmit(c.form);
  dispatchClick(c.save);
  await flushAsync();
  assert.equal(writes, 1, "native submit and nested click share one synchronous latch");
  assert(release);
  const outside = page.document.querySelector('a[data-game-mode="structure"]');
  assert(outside instanceof page.window.HTMLAnchorElement);
  outside.focus();
  release();
  await flushAsync();
  assert.equal(apiState.goalEvents.size, 1);
  assert.equal(page.document.activeElement, outside, "late success must not steal later focus");
  assert.equal(goalTeamValue(c.scoring), "");
  assert.equal(c.scorer.value, "");
  assert.equal(page.document.querySelector('[data-ui="goal-team-relationship"]')?.querySelectorAll('[data-ui="goal-team-chip"]').length, 2);
  assert.doesNotMatch(page.document.getElementById("goal-timeline")?.textContent ?? "", /Assists: None|conceding tally only/);
});

for (const kind of ["start", "finish", "finish-game"] as const) {
  test(`live scoring reconciles uncertain ${kind} using only reads until the original outcome is observed`, async (t) => {
    const apiState = createMockApiState();
    const gameId = `uncertain-clock-${kind}`;
    const thirds = createDefaultThirdTimerSegments();
    if (kind !== "start") thirds[0].startedAt = "2026-03-28T11:00:10.000Z";
    if (kind === "finish-game") for (const third of thirds) { third.startedAt = "2026-03-28T11:00:10.000Z"; third.finishedAt = "2026-03-28T11:00:11.000Z"; }
    seedGoalScoringGame(apiState, { gameId, status: kind === "start" ? "scheduled" : "live", thirds });
    const before = structuredClone(apiState.games.get(gameId));
    const baseFetch = createMockFetch(apiState);
    const posts: string[] = [];
    let readsAfterWrite = 0;
    const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
      const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
      if (init.method === "POST") {
        posts.push(path);
        const committed = await baseFetch(input, init);
        assert.equal(committed.ok, true);
        return createJsonResponse(503, { error: "unavailable", message: "Response lost." });
      }
      if ((init.method ?? "GET") === "GET" && path === `/v1/games/${gameId}` && posts.length > 0) {
        readsAfterWrite += 1;
        if (readsAfterWrite === 2) return createJsonResponse(503, { message: "Read unavailable." });
        if (readsAfterWrite <= 3) return createJsonResponse(200, before);
      }
      return baseFetch(input, init);
    };
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#score`, scriptFile: "setup-flow.js", apiState, fetch });
    t.after(() => page.window.close());
    const c = liveGoalControls(page);
    const action = page.document.querySelector(`[data-action="${kind === "finish-game" ? kind : `${kind}-active-third`}"]`);
    const check = page.document.querySelector('[data-action="refresh-game-state"]');
    assert(action instanceof page.window.HTMLButtonElement && check instanceof page.window.HTMLButtonElement);
    dispatchClick(action);
    await flushAsync();
    assert.equal(posts.length, 1);
    assert.equal(readsAfterWrite, 1);
    assert.equal(check.hidden, false);
    assert.equal(c.save.disabled, true);
    assert.equal(c.scoring.disabled, true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      dispatchClick(check);
      await flushAsync();
      assert.equal(posts.length, 1, "a failed or negative read never repeats a POST");
      assert.equal(check.hidden, false, "negative state does not settle the unknown write");
      assert.equal(c.save.disabled, true);
      assert.equal(page.window.location.hash, "#score");
    }
    dispatchClick(check);
    await flushAsync();
    assert.equal(posts.length, 1);
    assert.equal(check.hidden, true);
    assert.equal(page.document.getElementById("setup-error")?.hidden, true);
    if (kind === "finish-game") assert.equal(page.window.location.hash, "#results");
    else {
      const next = page.document.querySelector(`[data-action="${kind === "start" ? "finish" : "start"}-active-third"]`);
      assert(next instanceof page.window.HTMLButtonElement && !next.disabled);
      assert.equal(next.getAttribute("data-third"), kind === "start" ? "1" : "2");
    }
  });
}

for (const resultRead of ["fresh", "unavailable"] as const) {
  test(`live scoring replays finish with the same key and treats ${resultRead} result independently`, async (t) => {
    const apiState = createMockApiState();
    const gameId = `finish-replay-${resultRead}`;
    const thirds = createDefaultThirdTimerSegments().map((third) => ({ ...third, startedAt: "2026-03-28T11:00:10.000Z", finishedAt: "2026-03-28T11:00:11.000Z" }));
    seedGoalScoringGame(apiState, { gameId, status: "live", thirds, role: "admin" });
    seedLiveGoalEvent(apiState, gameId, "red-goal");
    const baseFetch = createMockFetch(apiState);
    const requests: Array<{ path: string; key: string | null }> = [];
    let replay: unknown;
    const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
      const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
      if (init.method === "POST" && path.endsWith("/finish")) {
        requests.push({ path, key: readInitHeader(init, "idempotency-key") });
        if (requests.length === 1) {
          const committed = await baseFetch(input, init);
          assert(committed.ok);
          replay = await committed.json();
          const goal = apiState.goalEvents.get("red-goal");
          const game = apiState.games.get(gameId);
          assert(goal && game);
          apiState.goalEvents.set("red-goal", { ...goal, scoringTeamId: "blue", concedingTeamId: "red", scorerPlayerId: "player-cy" });
          refreshMockFinishedResult(apiState, game, "2026-03-28T11:05:00.000Z");
          return createJsonResponse(503, { message: "Finish response lost." });
        }
        if (requests.length === 2) return createJsonResponse(403, { error: "forbidden", message: "Temporary rejection." });
        return createJsonResponse(200, replay);
      }
      if ((init.method ?? "GET") === "GET" && path === `/v1/games/${gameId}` && requests.length > 0 && (requests.length < 3 || resultRead === "unavailable")) return createJsonResponse(503, { message: "Result read unavailable." });
      return baseFetch(input, init);
    };
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#score`, scriptFile: "setup-flow.js", apiState, fetch });
    t.after(() => page.window.close());
    const finish = page.document.querySelector('[data-action="finish-game"]');
    assert(finish instanceof page.window.HTMLButtonElement);
    dispatchClick(finish);
    await flushAsync();
    assert.equal(requests.length, 1);
    assert.equal(finish.disabled, false);
    assert.equal(finish.textContent, "Retry finish game");
    dispatchClick(finish);
    await flushAsync();
    assert.equal(requests.length, 2);
    assert.equal(finish.disabled, false, "later403 must retain the same finish request");
    dispatchClick(finish);
    await flushAsync();
    assert.equal(requests.length, 3);
    assert.ok(requests[0].key);
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(requests[2], requests[0]);
    assert.equal(apiState.games.get(gameId)?.status, "finished");
    assert.equal(page.window.location.hash, "#results");
    assert.equal(finish.disabled, true);
    const result = page.document.getElementById("game-result-summary");
    assert(result instanceof page.window.HTMLElement);
    if (resultRead === "fresh") {
      assert.equal(result.querySelector('[data-testid="game-result-outcome"]')?.textContent, "Blue win");
      assert.doesNotMatch(result.textContent ?? "", /Red win/);
      assert.equal(page.document.getElementById("setup-error")?.hidden, true);
    } else {
      assert.match(result.textContent ?? "", /Result refresh required/);
      assert.match(result.textContent ?? "", /The latest match result could not be loaded/);
      assert.doesNotMatch(result.textContent ?? "", /goal change was saved/);
      assert.equal(result.querySelector('[data-testid="game-result-outcome"]'), null);
      assert.equal(page.document.querySelector('[data-ui="score-team"]'), null);
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Game finished\. The latest result could not be loaded/);
      assert.doesNotMatch(page.document.getElementById("setup-error")?.textContent ?? "", /finish failed/i);
    }
  });
}

for (const kind of ["start", "finish-game"] as const) {
  for (const navigation of ["away", "away-back"] as const) {
    test(`live scoring does not let delayed ${kind} replace ${navigation} navigation or focus`, async (t) => {
      const apiState = createMockApiState();
      const gameId = `clock-navigation-${kind}-${navigation}`;
      const thirds = createDefaultThirdTimerSegments();
      if (kind === "finish-game") for (const third of thirds) { third.startedAt = "2026-03-28T11:00:10.000Z"; third.finishedAt = "2026-03-28T11:00:11.000Z"; }
      seedGoalScoringGame(apiState, { gameId, status: kind === "start" ? "scheduled" : "live", thirds, role: "admin" });
      const baseFetch = createMockFetch(apiState);
      let release: (() => void) | undefined;
      const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
        if (init.method === "POST") await new Promise<void>((resolve) => { release = resolve; });
        return baseFetch(input, init);
      };
      const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#score`, scriptFile: "setup-flow.js", apiState, fetch });
      t.after(() => page.window.close());
      const action = page.document.querySelector(`[data-action="${kind === "start" ? "start-active-third" : kind}"]`);
      assert(action instanceof page.window.HTMLButtonElement);
      action.focus();
      dispatchClick(action);
      await flushAsync();
      assert(release);
      const teams = page.document.getElementById("game-mode-tab-players");
      assert(teams instanceof page.window.HTMLAnchorElement);
      dispatchClick(teams);
      if (navigation === "away-back") {
        const score = page.document.getElementById("game-mode-tab-run");
        assert(score instanceof page.window.HTMLAnchorElement);
        dispatchClick(score);
      }
      const expectedHash = navigation === "away" ? "#teams" : "#score";
      assert.equal(page.window.location.hash, expectedHash);
      const outside = page.document.querySelector('[data-ui="site-nav"] a');
      assert(outside instanceof page.window.HTMLAnchorElement);
      outside.focus();
      release();
      await flushAsync();
      assert.equal(page.window.location.hash, expectedHash, "late clock completion cannot choose a new destination");
      assert.equal(page.document.activeElement, outside);
      assert.equal(apiState.games.get(gameId)?.status, kind === "start" ? "live" : "finished");
    });
  }
}

test("live scoring allows any-team assists on a fresh finished own-goal correction without inventing scored totals", async (t) => {
  const apiState = createMockApiState();
  const gameId = "fresh-finished-assists";
  const thirds = createDefaultThirdTimerSegments().map((third) => ({ ...third, startedAt: "2026-03-28T11:00:10.000Z", finishedAt: "2026-03-28T11:00:11.000Z" }));
  seedGoalScoringGame(apiState, { gameId, status: "finished", thirds, role: "admin" });
  const ari = apiState.players.get("player-ari");
  const link = apiState.gamePlayers.get(`${gameId}:player-ari`);
  const roster = apiState.roster.get(`${gameId}:player-ari`);
  const game = apiState.games.get(gameId);
  assert(ari && link && roster && game);
  for (const nickname of ["Dax", "Eli"]) {
    const playerId = `player-${nickname.toLowerCase()}`;
    apiState.players.set(playerId, { ...ari, playerId, nickname });
    apiState.gamePlayers.set(`${gameId}:${playerId}`, { ...link, playerId });
    apiState.roster.set(`${gameId}:${playerId}`, { ...roster, playerId, teamId: "yellow" });
  }
  refreshMockFinishedResult(apiState, game, "2026-03-28T11:01:00.000Z");
  const baseFetch = createMockFetch(apiState);
  const payloads: Array<Record<string, unknown>> = [];
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    if (init.method === "POST" && new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname.endsWith("/goals")) payloads.push(JSON.parse(String(init.body)));
    return baseFetch(input, init);
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}`, scriptFile: "setup-flow.js", apiState, fetch });
  t.after(() => page.window.close());
  enterFinishedCorrections(page);
  const c = liveGoalControls(page);
  c.ownGoal.checked = true;
  c.ownGoal.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  c.choose(c.conceding, "red");
  c.scorer.value = "player-ari";
  c.scorer.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  assert.equal(c.scoring.hidden, false);
  assert.equal(c.scoring.disabled, true);
  assert.equal(goalTeamValue(c.scoring), "");
  assert.equal(page.document.querySelector('#goal-assists input[value="player-ari"]'), null);
  for (const playerId of ["player-bea", "player-cy", "player-dax"]) {
    const assist = page.document.querySelector(`#goal-assists input[value="${playerId}"]`);
    assert(assist instanceof page.window.HTMLInputElement);
    assert.equal(assist.disabled, false, "fresh corrections use the same assist rights as edits");
    assist.checked = true;
    assist.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  }
  assert.equal(page.document.querySelector('#goal-assists input[value="player-eli"]')?.matches(":disabled"), true);
  assert.equal(page.document.getElementById("goal-assists-summary")?.textContent, "3 selected: Bea, Cy, Dax");
  dispatchSubmit(c.form);
  await flushAsync();
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], { scoringTeamId: null, concedingTeamId: "red", scorerPlayerId: "player-ari", assistPlayerIds: ["player-bea", "player-cy", "player-dax"], ownGoal: true });
  const event = [...apiState.goalEvents.values()][0];
  assert.equal(event.ownGoal, true);
  assert.equal(event.scoringTeamId, null);
  const red = page.document.querySelector('[data-ui="score-team"][data-team-id="red"]');
  assert.deepEqual([...red!.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")), ["Conceded1", "Scored0"]);
  const relation = page.document.querySelector('[data-ui="goal-team-relationship"]');
  assert(relation);
  assert.equal(relation.querySelector('[data-ui="own-goal-marker"]')?.textContent, "OG");
  assert.equal(relation.querySelectorAll('[data-ui="goal-team-chip"]').length, 1);
  assert.equal(relation.querySelector('[data-ui="goal-team-chip"]')?.getAttribute("aria-label"), "Conceding team: Red");
  assert.equal(c.ownGoal.checked, false);
  assert.equal(page.document.querySelectorAll('#goal-assists input:checked').length, 0);
});

for (const code of ["game_finished", "game_state_changed", "goal_state_changed", "no_active_third"]) {
  test(`live scoring retires a first documented ${code} rejection and preserves an editable draft`, async (t) => {
    const apiState = createMockApiState();
    const gameId = `known-goal-${code}`;
    const thirds = createDefaultThirdTimerSegments();
    thirds[0].startedAt = "2026-03-28T11:00:10.000Z";
    seedGoalScoringGame(apiState, { gameId, status: "live", thirds });
    const baseFetch = createMockFetch(apiState);
    const keys: Array<string | null> = [];
    const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
      if (init.method === "POST" && new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname.endsWith("/goals")) {
        keys.push(readInitHeader(init, "idempotency-key"));
        if (keys.length === 1) return createJsonResponse(409, { error: "conflict", code, message: code === "no_active_third" ? "A goal can only be created while a third is running." : "The game changed." });
      }
      return baseFetch(input, init);
    };
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#score`, scriptFile: "setup-flow.js", apiState, fetch });
    t.after(() => page.window.close());
    const c = liveGoalControls(page);
    c.draft();
    dispatchSubmit(c.form);
    await flushAsync();
    assert.equal(apiState.goalEvents.size, 0);
    assert.equal(c.retry.hidden, true);
    assert.equal(c.save.disabled, false);
    assert.equal(goalTeamValue(c.scoring), "red");
    assert.equal(goalTeamValue(c.conceding), "blue");
    assert.equal(c.scorer.value, "player-ari");
    assert.equal(c.scoring.disabled, false);
    if (code === "no_active_third") assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /A goal can only be created while a third is running\./);
    c.choose(c.conceding, "yellow");
    dispatchSubmit(c.form);
    await flushAsync();
    assert.equal(apiState.goalEvents.size, 1);
    assert.equal([...apiState.goalEvents.values()][0].concedingTeamId, "yellow");
    assert.equal(keys.length, 2);
    assert.ok(keys[0] && keys[1]);
    assert.notEqual(keys[0], keys[1], "a definitive rejection permits a genuinely new request");
  });
}

test("live scoring retains a lost goal create when its retry reports no_active_third", async (t) => {
  const apiState = createMockApiState();
  const gameId = "lost-create-no-active-third";
  const thirds = createDefaultThirdTimerSegments();
  thirds[0].startedAt = "2026-03-28T11:00:10.000Z";
  seedGoalScoringGame(apiState, { gameId, status: "live", thirds });
  const baseFetch = createMockFetch(apiState);
  const requests: Array<{ path: string; key: string | null; body: string }> = [];
  let replay: unknown;
  const fetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    if (init.method === "POST" && path === `/v1/games/${gameId}/goals`) {
      requests.push({ path, key: readInitHeader(init, "idempotency-key"), body: String(init.body) });
      if (requests.length === 1) {
        const committed = await baseFetch(input, init);
        assert(committed.ok);
        replay = await committed.json();
        return createJsonResponse(503, { message: "The committed response was lost." });
      }
      if (requests.length === 2) return createJsonResponse(409, { error: "conflict", code: "no_active_third", message: "A goal can only be created while a third is running." });
      return createJsonResponse(200, replay);
    }
    return baseFetch(input, init);
  };
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId }), url: `http://localhost:3000/games/${gameId}#score`, scriptFile: "setup-flow.js", apiState, fetch });
  t.after(() => page.window.close());
  const c = liveGoalControls(page);
  c.draft();
  dispatchSubmit(c.form);
  await flushAsync();
  assert.equal(apiState.goalEvents.size, 1, "the first response really was lost after commit");
  assert.equal(c.retry.hidden, false);
  dispatchClick(c.retry);
  await flushAsync();
  assert.equal(requests.length, 2);
  assert.equal(c.retry.hidden, false);
  assert.equal(c.retry.disabled, false);
  assert.equal(c.save.disabled, true);
  assert.equal(c.scoring.disabled, true);
  assert.equal(goalTeamValue(c.scoring), "red");
  assert.equal(goalTeamValue(c.conceding), "blue");
  assert.equal(c.scorer.value, "player-ari");
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Could not confirm whether the goal was saved/);
  dispatchSubmit(c.form);
  await flushAsync();
  assert.equal(requests.length, 2, "the later conflict cannot unlock a replacement write");
  dispatchClick(c.retry);
  await flushAsync();
  assert.equal(requests.length, 3);
  assert.ok(requests[0].key);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.equal(apiState.goalEvents.size, 1);
  assert.equal(c.retry.hidden, true);
  assert.equal(goalTeamValue(c.scoring), "");
  assert.equal(c.scorer.value, "");
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
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
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
  assert.equal(goalTeamValue(scoringTeamInput), "red");
  assert.equal(goalTeamValue(concedingTeamInput), "blue");
  assert.equal(scorerInput.value, "player-ari");
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 1);

  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 1);
  assert.equal(createGoalIdempotencyKeys.length, 2);
  assert.ok(createGoalIdempotencyKeys[0]);
  assert.equal(createGoalIdempotencyKeys[0], createGoalIdempotencyKeys[1]);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
  assert.equal(scorerInput.value, "");
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.disabled, true);
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 0);

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-ari";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  const repeatedBeaAssist = page.document.querySelector('#goal-assists input[value="player-bea"]');
  assert(repeatedBeaAssist instanceof page.window.HTMLInputElement);
  repeatedBeaAssist.checked = true;
  repeatedBeaAssist.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 2);
  assert.equal(createGoalIdempotencyKeys.length, 3);
  assert.ok(createGoalIdempotencyKeys[2]);
  assert.notEqual(createGoalIdempotencyKeys[1], createGoalIdempotencyKeys[2]);
});

test("game page preserves authoritative scores and retires retry keys after rejected goal mutations", async () => {
  const apiState = createMockApiState();
  const finishedThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
    finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-goal-rejected",
    status: "finished",
    thirds: finishedThirds,
    role: "admin",
    sessionEmail: "admin@3fc.football",
  });
  apiState.goalEvents.set("goal-1", {
    gameId: "game-goal-rejected",
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
  const seededGame = apiState.games.get("game-goal-rejected");
  assert(seededGame);
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:02:00.000Z");

  const defaultFetch = createMockFetch(apiState);
  const updateKeys: Array<string | null> = [];
  const undoKeys: Array<string | null> = [];
  const deleteKeys: Array<string | null> = [];
  const rejectedFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const goalsPath = "/v1/games/game-goal-rejected/goals";

    if (method === "PATCH" && target.pathname === `${goalsPath}/goal-1`) {
      updateKeys.push(readInitHeader(init, "idempotency-key"));
      return createJsonResponse(403, {
        error: "forbidden",
        message: "Goal correction is not permitted.",
      });
    }
    if (method === "POST" && target.pathname === `${goalsPath}/undo-last`) {
      undoKeys.push(readInitHeader(init, "idempotency-key"));
      return createJsonResponse(409, {
        error: "conflict",
        code: "latest_goal_changed",
        message: "The latest goal cannot be undone.",
      });
    }
    if (method === "DELETE" && target.pathname === `${goalsPath}/goal-1`) {
      deleteKeys.push(readInitHeader(init, "idempotency-key"));
      return createJsonResponse(403, {
        error: "forbidden",
        message: "Goal deletion is not permitted.",
      });
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-goal-rejected" }),
    url: "http://localhost:3000/games/game-goal-rejected",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: rejectedFetch,
  });
  enterFinishedCorrections(page);
  Object.defineProperty(page.window, "confirm", {
    value: () => true,
    configurable: true,
  });

  const scoreboard = page.document.getElementById("live-scoreboard");
  const resultSummary = page.document.getElementById("game-result-summary");
  const status = page.document.getElementById("setup-status");
  const error = page.document.getElementById("setup-error");
  const editGoalButton = page.document.querySelector(
    '[data-action="edit-goal"][data-event-id="goal-1"]',
  );
  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const undoLastGoalButton = page.document.querySelector('[data-action="undo-last-goal"]');
  assert(scoreboard instanceof page.window.HTMLElement);
  assert(resultSummary instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);

  const assertAuthoritativeRedResult = () => {
    const redScoreCard = scoreboard.querySelector('[data-ui="score-team"][data-team-id="red"]');
    const blueScoreCard = scoreboard.querySelector('[data-ui="score-team"][data-team-id="blue"]');
    assert(redScoreCard instanceof page.window.HTMLElement);
    assert(blueScoreCard instanceof page.window.HTMLElement);
    assert.deepEqual(
      [...redScoreCard.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
      ["Conceded0", "Scored1"],
    );
    assert.deepEqual(
      [...blueScoreCard.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
      ["Conceded1", "Scored0"],
    );
    assert.match(resultSummary.textContent ?? "", /Red win/);
    assert.doesNotMatch(resultSummary.textContent ?? "", /Result may have changed|Result refresh required/);
    assert(page.document.querySelector('[data-event-id="goal-1"]'));
  };

  assertAuthoritativeRedResult();
  dispatchClick(editGoalButton);
  await flushAsync();
  setGoalTeamValue(scoringTeamInput, "blue");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "red");
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));

  dispatchClick(saveGoalButton);
  await flushAsync();
  assertAuthoritativeRedResult();
  assert.match(status.textContent ?? "", /Goal was not saved/);
  assert.match(error.textContent ?? "", /Goal correction is not permitted/);
  assert.equal(goalTeamValue(scoringTeamInput), "blue");
  assert.equal(goalTeamValue(concedingTeamInput), "red");
  assert.equal(scorerInput.value, "player-cy");
  dispatchClick(saveGoalButton);
  await flushAsync();
  assert.equal(updateKeys.length, 2);
  assert.ok(updateKeys[0]);
  assert.ok(updateKeys[1]);
  assert.notEqual(updateKeys[0], updateKeys[1]);
  assertAuthoritativeRedResult();

  dispatchClick(undoLastGoalButton);
  await flushAsync();
  assertAuthoritativeRedResult();
  assert.match(status.textContent ?? "", /latest goal was not undone/i);
  assert.equal(page.document.querySelector('[data-action="retry-goal-operation"]')?.hasAttribute("hidden"), true);
  assert.match(error.textContent ?? "", /latest goal cannot be undone/i);
  dispatchClick(undoLastGoalButton);
  await flushAsync();
  assert.equal(undoKeys.length, 2);
  assert.ok(undoKeys[0]);
  assert.ok(undoKeys[1]);
  assert.notEqual(undoKeys[0], undoKeys[1]);
  assertAuthoritativeRedResult();

  const deleteGoalButton = page.document.querySelector(
    '[data-action="delete-goal"][data-event-id="goal-1"]',
  );
  assert(deleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(deleteGoalButton);
  await flushAsync();
  assertAuthoritativeRedResult();
  assert.match(status.textContent ?? "", /goal was not deleted/i);
  assert.match(error.textContent ?? "", /Goal deletion is not permitted/);
  const retryDeleteGoalButton = page.document.querySelector(
    '[data-action="delete-goal"][data-event-id="goal-1"]',
  );
  assert(retryDeleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(retryDeleteGoalButton);
  await flushAsync();
  assert.equal(deleteKeys.length, 2);
  assert.ok(deleteKeys[0]);
  assert.ok(deleteKeys[1]);
  assert.notEqual(deleteKeys[0], deleteKeys[1]);
  assertAuthoritativeRedResult();
  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, "red");
  assert.equal(apiState.games.get("game-goal-rejected")?.result?.winnerTeamId, "red");
});

test("game page reconciles authoritative goals after replayed create, delete, and undo responses", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-goal-replay-reconcile",
    status: "live",
    thirds,
  });

  const defaultFetch = createMockFetch(apiState);
  const createKeys: Array<string | null> = [];
  const deleteKeys: Array<string | null> = [];
  const undoKeys: Array<string | null> = [];
  let createAttempts = 0;
  let deleteAttempts = 0;
  let undoAttempts = 0;
  let authoritativeGoalGets = 0;
  let createReplay: unknown = null;
  let deleteReplay: unknown = null;
  let undoReplay: unknown = null;

  const externalGoal = (
    eventId: string,
    createdAt: string,
    scoringTeamId: TeamId,
    concedingTeamId: TeamId,
    scorerPlayerId: string,
  ): MockGoalEvent => ({
    gameId: "game-goal-replay-reconcile",
    eventId,
    third: 1,
    thirdMinute: 1,
    gameMinute: 1,
    elapsedSeconds: 45,
    stoppageMinute: null,
    displayTime: "1'",
    scoringTeamId,
    concedingTeamId,
    scorerPlayerId,
    assistPlayerIds: [],
    ownGoal: false,
    createdAt,
    updatedAt: createdAt,
  });

  const replayingFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const goalsPath = "/v1/games/game-goal-replay-reconcile/goals";

    if (method === "POST" && target.pathname === goalsPath) {
      createAttempts += 1;
      createKeys.push(readInitHeader(init, "idempotency-key"));
      if (createAttempts === 1) {
        const committed = await defaultFetch(input, init);
        createReplay = await committed.json();
        apiState.goalEvents.set(
          "goal-external-create",
          externalGoal(
            "goal-external-create",
            "2026-03-28T11:01:02.000Z",
            "blue",
            "red",
            "player-cy",
          ),
        );
        return createJsonResponse(503, {
          error: "response_lost",
          message: "Goal response was lost after commit.",
        });
      }
      if (createAttempts === 2) {
        return createJsonResponse(403, {
          error: "forbidden",
          message: "Goal access expired before replay.",
        });
      }
      return createJsonResponse(201, createReplay);
    }

    if (
      method === "DELETE" &&
      target.pathname === "/v1/games/game-goal-replay-reconcile/goals/goal-1"
    ) {
      deleteAttempts += 1;
      deleteKeys.push(readInitHeader(init, "idempotency-key"));
      if (deleteAttempts === 1) {
        const committed = await defaultFetch(input, init);
        deleteReplay = await committed.json();
        apiState.goalEvents.set(
          "goal-external-delete",
          externalGoal(
            "goal-external-delete",
            "2026-03-28T11:01:03.000Z",
            "yellow",
            "blue",
            "player-bea",
          ),
        );
        return createJsonResponse(503, {
          error: "response_lost",
          message: "Delete response was lost after commit.",
        });
      }
      if (deleteAttempts === 2) {
        return createJsonResponse(403, {
          error: "forbidden",
          message: "Goal access expired before delete replay.",
        });
      }
      return createJsonResponse(200, deleteReplay);
    }

    if (
      method === "POST" &&
      target.pathname === "/v1/games/game-goal-replay-reconcile/goals/undo-last"
    ) {
      undoAttempts += 1;
      undoKeys.push(readInitHeader(init, "idempotency-key"));
      if (undoAttempts === 1) {
        const committed = await defaultFetch(input, init);
        undoReplay = await committed.json();
        apiState.goalEvents.set(
          "goal-external-undo",
          externalGoal(
            "goal-external-undo",
            "2026-03-28T11:01:04.000Z",
            "red",
            "yellow",
            "player-ari",
          ),
        );
        return createJsonResponse(503, {
          error: "response_lost",
          message: "Undo response was lost after commit.",
        });
      }
      if (undoAttempts === 2) {
        return createJsonResponse(403, {
          error: "forbidden",
          message: "Goal access expired before undo replay.",
        });
      }
      return createJsonResponse(200, undoReplay);
    }

    if (method === "GET" && target.pathname === goalsPath) {
      authoritativeGoalGets += 1;
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-goal-replay-reconcile" }),
    url: "http://localhost:3000/games/game-goal-replay-reconcile",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: replayingFetch,
  });
  Object.defineProperty(page.window, "confirm", {
    value: () => true,
    configurable: true,
  });
  authoritativeGoalGets = 0;

  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const scoreboard = page.document.getElementById("live-scoreboard");
  const status = page.document.getElementById("setup-status");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(scoreboard instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-ari";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));

  dispatchClick(saveGoalButton);
  await flushAsync();
  assert.match(scoreboard.textContent ?? "", /Scores may have changed/);
  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
  await flushAsync();
  assert.match(scoreboard.textContent ?? "", /Scores may have changed/);
  assert.equal(saveGoalButton.disabled, true);
  assert.equal(status.hidden, true);
  assert.equal(page.document.getElementById("setup-error")?.hidden, false);
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Could not confirm whether the goal was saved\. Retry with the same details\./);
  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
  await flushAsync();

  assert.equal(createAttempts, 3);
  assert.ok(createKeys[0]);
  assert.equal(createKeys[0], createKeys[1]);
  assert.equal(createKeys[1], createKeys[2]);
  assert(page.document.querySelector('[data-event-id="goal-external-create"]'));
  assert.equal(authoritativeGoalGets, 1);

  const deleteGoalButton = page.document.querySelector(
    '[data-action="delete-goal"][data-event-id="goal-1"]',
  );
  assert(deleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(deleteGoalButton);
  await flushAsync();
  assert.match(scoreboard.textContent ?? "", /Scores may have changed/);
  const retryDeleteGoalButton = page.document.querySelector(
    '[data-action="retry-goal-operation"]',
  );
  assert(retryDeleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(retryDeleteGoalButton);
  await flushAsync();
  assert.match(scoreboard.textContent ?? "", /Scores may have changed/);
  assert.equal(saveGoalButton.disabled, true);
  assert.equal(status.hidden, true);
  assert.equal(page.document.getElementById("setup-error")?.hidden, false);
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Could not confirm the deletion.*retry/i);
  const replayDeleteGoalButton = page.document.querySelector(
    '[data-action="retry-goal-operation"]',
  );
  assert(replayDeleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(replayDeleteGoalButton);
  await flushAsync();

  assert.equal(deleteAttempts, 3);
  assert.ok(deleteKeys[0]);
  assert.equal(deleteKeys[0], deleteKeys[1]);
  assert.equal(deleteKeys[1], deleteKeys[2]);
  assert.equal(page.document.querySelector('[data-event-id="goal-1"]'), null);
  assert(page.document.querySelector('[data-event-id="goal-external-delete"]'));
  assert.equal(authoritativeGoalGets, 2);

  const undoLastGoalButton = page.document.querySelector('[data-action="undo-last-goal"]');
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(undoLastGoalButton);
  await flushAsync();
  assert.match(scoreboard.textContent ?? "", /Scores may have changed/);
  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
  await flushAsync();
  assert.match(scoreboard.textContent ?? "", /Scores may have changed/);
  assert.equal(undoLastGoalButton.disabled, true);
  assert.equal(status.hidden, true);
  assert.equal(page.document.getElementById("setup-error")?.hidden, false);
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Could not confirm the undo.*retry/i);
  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
  await flushAsync();

  assert.equal(undoAttempts, 3);
  assert.ok(undoKeys[0]);
  assert.equal(undoKeys[0], undoKeys[1]);
  assert.equal(undoKeys[1], undoKeys[2]);
  assert.equal(page.document.querySelector('[data-event-id="goal-external-delete"]'), null);
  assert(page.document.querySelector('[data-event-id="goal-external-undo"]'));
  assert.equal(authoritativeGoalGets, 3);
});

test("game page hides finished scores until a lost correction response is replayed", async () => {
  const apiState = createMockApiState();
  const finishedThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
    finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-finished-lost-correction",
    status: "finished",
    thirds: finishedThirds,
    role: "admin",
    sessionEmail: "admin@3fc.football",
  });
  apiState.goalEvents.set("goal-1", {
    gameId: "game-finished-lost-correction",
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
  const seededGame = apiState.games.get("game-finished-lost-correction");
  assert(seededGame);
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:02:00.000Z");

  const defaultFetch = createMockFetch(apiState);
  const updateKeys: Array<string | null> = [];
  let updateAttempts = 0;
  let replayBody: unknown = null;
  const lostResponseFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (
      method === "PATCH" &&
      target.pathname === "/v1/games/game-finished-lost-correction/goals/goal-1"
    ) {
      updateAttempts += 1;
      updateKeys.push(readInitHeader(init, "idempotency-key"));
      if (updateAttempts === 1) {
        const committed = await defaultFetch(input, init);
        replayBody = await committed.json();
        return createJsonResponse(503, {
          error: "response_lost",
          message: "Goal update response was lost after commit.",
        });
      }
      if (updateAttempts === 2) {
        return createJsonResponse(403, {
          error: "forbidden",
          message: "Goal access expired before correction replay.",
        });
      }
      return createJsonResponse(200, replayBody);
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-finished-lost-correction" }),
    url: "http://localhost:3000/games/game-finished-lost-correction",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: lostResponseFetch,
  });
  enterFinishedCorrections(page);

  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const scoreboard = page.document.getElementById("live-scoreboard");
  const resultSummary = page.document.getElementById("game-result-summary");
  const status = page.document.getElementById("setup-status");
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(scoreboard instanceof page.window.HTMLElement);
  assert(resultSummary instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert.match(resultSummary.textContent ?? "", /Red win/);

  dispatchClick(editGoalButton);
  await flushAsync();
  setGoalTeamValue(scoringTeamInput, "blue");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "red");
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(updateAttempts, 1);
  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, "blue");
  assert.equal(apiState.games.get("game-finished-lost-correction")?.result?.winnerTeamId, "blue");
  assert.match(scoreboard.textContent ?? "", /Scores may have changed/);
  assert.equal(scoreboard.querySelector('[data-ui="score-team"]'), null);
  assert.match(resultSummary.textContent ?? "", /Result may have changed/);
  assert.doesNotMatch(resultSummary.textContent ?? "", /Red win|Blue win|Draw/);
  assert.equal(status.hidden, true);
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Retry with the same details/);
  assert.equal(goalTeamValue(scoringTeamInput), "blue");
  assert.equal(goalTeamValue(concedingTeamInput), "red");
  assert.equal(scorerInput.value, "player-cy");

  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
  await flushAsync();

  assert.equal(updateAttempts, 2);
  assert.match(scoreboard.textContent ?? "", /Scores may have changed/);
  assert.match(resultSummary.textContent ?? "", /Result may have changed/);
  assert.equal(goalTeamValue(scoringTeamInput), "blue");
  assert.equal(goalTeamValue(concedingTeamInput), "red");
  assert.equal(scorerInput.value, "player-cy");
  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
  await flushAsync();

  assert.equal(updateAttempts, 3);
  assert.ok(updateKeys[0]);
  assert.equal(updateKeys[0], updateKeys[1]);
  assert.equal(updateKeys[1], updateKeys[2]);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
  assert.equal(scorerInput.value, "");
  assert.match(resultSummary.textContent ?? "", /Blue win/);
  assert.doesNotMatch(resultSummary.textContent ?? "", /Result may have changed|Result refresh required/);
  const blueScoreCard = scoreboard.querySelector('[data-ui="score-team"][data-team-id="blue"]');
  const redScoreCard = scoreboard.querySelector('[data-ui="score-team"][data-team-id="red"]');
  assert(blueScoreCard instanceof page.window.HTMLElement);
  assert(redScoreCard instanceof page.window.HTMLElement);
  assert.deepEqual(
    [...blueScoreCard.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
    ["Conceded0", "Scored1"],
  );
  assert.deepEqual(
    [...redScoreCard.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
    ["Conceded1", "Scored0"],
  );
});

test("game page clears an open edit draft after a committed delete or undo", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments();
  thirds[0] = {
    ...thirds[0],
    startedAt: "2026-03-28T11:00:10.000Z",
  };
  seedGoalScoringGame(apiState, {
    gameId: "game-edit-draft-mutation",
    status: "live",
    thirds,
  });
  apiState.goalEvents.set("goal-1", {
    gameId: "game-edit-draft-mutation",
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
  apiState.goalEvents.set("goal-2", {
    gameId: "game-edit-draft-mutation",
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

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "game-edit-draft-mutation" }),
    url: "http://localhost:3000/games/game-edit-draft-mutation",
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
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);

  const editGoalOne = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const deleteGoalOne = page.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(editGoalOne instanceof page.window.HTMLButtonElement);
  assert(deleteGoalOne instanceof page.window.HTMLButtonElement);
  dispatchClick(editGoalOne);
  await flushAsync();
  assert.equal(goalTeamValue(scoringTeamInput), "red");
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 1);

  const refreshedDeleteGoalOne = page.document.querySelector(
    '[data-action="delete-goal"][data-event-id="goal-1"]',
  );
  assert(refreshedDeleteGoalOne instanceof page.window.HTMLButtonElement);
  dispatchClick(refreshedDeleteGoalOne);
  await flushAsync();
  assert.equal(apiState.goalEvents.has("goal-1"), false);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
  assert.equal(scorerInput.value, "");
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 0);
  assert.match(saveGoalButton.textContent ?? "", /Record goal/);

  const editGoalTwo = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-2"]');
  assert(editGoalTwo instanceof page.window.HTMLButtonElement);
  dispatchClick(editGoalTwo);
  await flushAsync();
  assert.equal(goalTeamValue(scoringTeamInput), "blue");

  dispatchClick(undoLastGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.has("goal-2"), false);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
  assert.equal(scorerInput.value, "");
  assert.match(saveGoalButton.textContent ?? "", /Record goal/);
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
    assistPlayerIds: ["player-bea", "player-cy"],
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
  const assistsDropdown = page.document.getElementById("goal-assists-dropdown");
  const assistsSummary = page.document.getElementById("goal-assists-summary");
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert(assistsDropdown instanceof page.window.HTMLDetailsElement);
  assert(assistsSummary instanceof page.window.HTMLElement);

  const editGoalButton = page.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(editGoalButton);
  await flushAsync();
  assert.equal(assistsDropdown.open, false);
  assert.equal(assistsSummary.textContent, "2 selected: Bea, Cy");
  assert.equal(assistsSummary.getAttribute("title"), "Bea, Cy");
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 2);
  assistsDropdown.open = true;
  dispatchClick(saveGoalButton);
  await flushAsync();
  assert.equal(assistsDropdown.open, true);
  assert.equal(assistsSummary.textContent, "2 selected: Bea, Cy");
  assert.equal(assistsSummary.getAttribute("title"), "Bea, Cy");
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 2);
  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
  await flushAsync();

  assert.equal(updateKeys.length, 2);
  assert.ok(updateKeys[0]);
  assert.equal(updateKeys[0], updateKeys[1]);
  assert.equal(apiState.goalEvents.get("goal-1")?.ownGoal, false);
  assert.equal(assistsDropdown.open, false);
  assert.equal(assistsSummary.textContent, "Choose assists");
  assert.equal(assistsSummary.hasAttribute("title"), false);
  assert.equal(page.document.querySelectorAll('#goal-assists input[type="checkbox"]:checked').length, 0);

  const deleteGoalButton = page.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(deleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(deleteGoalButton);
  await flushAsync();
  const retryDeleteGoalButton = page.document.querySelector('[data-action="retry-goal-operation"]');
  assert(retryDeleteGoalButton instanceof page.window.HTMLButtonElement);
  dispatchClick(retryDeleteGoalButton);
  await flushAsync();

  assert.equal(deleteKeys.length, 2);
  assert.ok(deleteKeys[0]);
  assert.equal(deleteKeys[0], deleteKeys[1]);

  dispatchClick(undoLastGoalButton);
  await flushAsync();
  dispatchClick(page.document.querySelector('[data-action="retry-goal-operation"]') as HTMLButtonElement);
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
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerSelect instanceof page.window.HTMLSelectElement);

  dispatchClick(editGoalButton);
  await flushAsync();
  assert.equal(scorerSelect.value, "player-ari");
  assert.match(scorerSelect.textContent ?? "", /Ari \(not currently rostered\)/);

  ownGoalInput.checked = true;
  ownGoalInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
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
  const patchRequests: Array<{ key: string | null; body: string }> = [];
  const staleReplayFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "PATCH" && target.pathname === "/v1/games/game-stale-correction/goals/goal-1") {
      patchCalls += 1;
      patchRequests.push({ key: readInitHeader(init, "idempotency-key"), body: String(init.body) });
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
  assert.equal(saveGoalButton.disabled, true);
  const retryGoalButton = page.document.querySelector('[data-action="retry-goal-operation"]');
  assert(retryGoalButton instanceof page.window.HTMLButtonElement);
  assert.equal(retryGoalButton.hidden, false);

  dispatchClick(retryGoalButton);
  await flushAsync();
  await flushAsync();

  assert.equal(patchCalls, 2);
  assert.ok(patchRequests[0].key);
  assert.deepEqual(patchRequests[1], patchRequests[0]);
  assert.match(timeline.textContent ?? "", /Cy\s*→/);
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
  const scoreboard = page.document.getElementById("live-scoreboard");
  const status = page.document.getElementById("setup-status");
  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert(scoreboard instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert.match(timeline.textContent ?? "", /Cy\s*→/);

  dispatchClick(editGoalButton);
  await flushAsync();
  dispatchClick(saveGoalButton);
  await flushAsync();
  await flushAsync();

  assert.equal(status.hidden, true);
  assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Goal updated, but the latest scores and goal timeline could not be loaded/);
  assert.equal(page.document.getElementById("setup-error")?.hidden, false);
  assert.equal(page.document.getElementById("setup-error")?.getAttribute("role"), "status");
  assert.equal(page.document.getElementById("setup-error")?.getAttribute("aria-live"), "polite");
  assert.match(timeline.textContent ?? "", /Goal timeline unavailable/);
  assert.doesNotMatch(timeline.textContent ?? "", /Cy\s*→/);
  assert.match(scoreboard.textContent ?? "", /Scores unavailable/);
  assert.equal(scoreboard.querySelector('[data-ui="score-team"]'), null);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
  assert.equal(scorerInput.value, "");
  assert.equal(saveGoalButton.disabled, true);
  assert.equal(undoLastGoalButton.disabled, true);
});

test("game page refreshes the finished result when a committed edit timeline reload fails", async () => {
  const apiState = createMockApiState();
  const finishedThirds = createDefaultThirdTimerSegments().map((third) => ({
    ...third,
    startedAt: `2026-03-28T11:00:0${third.third}.000Z`,
    finishedAt: `2026-03-28T11:00:1${third.third}.000Z`,
  }));
  seedGoalScoringGame(apiState, {
    gameId: "game-finished-timeline-refresh-fail",
    status: "finished",
    thirds: finishedThirds,
    role: "admin",
    sessionEmail: "admin@3fc.football",
  });
  apiState.goalEvents.set("goal-1", {
    gameId: "game-finished-timeline-refresh-fail",
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
  const seededGame = apiState.games.get("game-finished-timeline-refresh-fail");
  assert(seededGame);
  refreshMockFinishedResult(apiState, seededGame, "2026-03-28T11:02:00.000Z");
  const originalGoal = apiState.goalEvents.get("goal-1");
  assert(originalGoal);
  const staleReplayGoal = { ...originalGoal };
  const staleReplayScoreboard = recomputeMockScoreboard(apiState, seededGame);

  const defaultFetch = createMockFetch(apiState);
  let correctionCommitted = false;
  let failedGoalRefreshes = 0;
  let successfulGameRefreshes = 0;
  let resolveGameRefresh: ((response: Response) => void) | undefined;
  const partialRefreshFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();

    if (
      method === "PATCH" &&
      target.pathname === "/v1/games/game-finished-timeline-refresh-fail/goals/goal-1"
    ) {
      await defaultFetch(input, init);
      correctionCommitted = true;
      return createJsonResponse(200, {
        goal: staleReplayGoal,
        scoreboard: {
          teams: staleReplayScoreboard,
        },
        timeline: [staleReplayGoal],
      });
    }

    if (
      correctionCommitted &&
      method === "GET" &&
      target.pathname === "/v1/games/game-finished-timeline-refresh-fail/goals"
    ) {
      failedGoalRefreshes += 1;
      return createJsonResponse(503, {
        error: "unavailable",
        message: "Goal timeline could not be refreshed.",
      });
    }

    if (
      correctionCommitted &&
      method === "GET" &&
      target.pathname === "/v1/games/game-finished-timeline-refresh-fail"
    ) {
      successfulGameRefreshes += 1;
      return new Promise<Response>((resolve) => {
        resolveGameRefresh = resolve;
      });
    }

    return defaultFetch(input, init);
  };

  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", {
      gameId: "game-finished-timeline-refresh-fail",
    }),
    url: "http://localhost:3000/games/game-finished-timeline-refresh-fail",
    scriptFile: "setup-flow.js",
    apiState,
    fetch: partialRefreshFetch,
  });
  enterFinishedCorrections(page);

  const editGoalButton = page.document.querySelector(
    '[data-action="edit-goal"][data-event-id="goal-1"]',
  );
  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const timeline = page.document.getElementById("goal-timeline");
  const status = page.document.getElementById("setup-status");
  const error = page.document.getElementById("setup-error");
  const resultSummary = page.document.getElementById("game-result-summary");
  assert(editGoalButton instanceof page.window.HTMLButtonElement);
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(timeline instanceof page.window.HTMLElement);
  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);
  assert(resultSummary instanceof page.window.HTMLElement);
  assert.match(resultSummary.textContent ?? "", /Red win/);

  dispatchClick(editGoalButton);
  await flushAsync();
  setGoalTeamValue(scoringTeamInput, "blue");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "red");
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, "blue");
  assert.equal(apiState.goalEvents.get("goal-1")?.concedingTeamId, "red");
  assert.equal(apiState.goalEvents.get("goal-1")?.scorerPlayerId, "player-cy");
  assert.equal(apiState.games.get("game-finished-timeline-refresh-fail")?.result?.winnerTeamId, "blue");
  assert.equal(failedGoalRefreshes, 1);
  assert.equal(successfulGameRefreshes, 1);
  assert(resolveGameRefresh);
  assert.equal(saveGoalButton.disabled, true);
  assert.match(page.document.getElementById("live-scoreboard")?.textContent ?? "", /Refreshing scores/);
  assert.equal(page.document.querySelector('[data-ui="score-team"]'), null);

  const refreshedGame = apiState.games.get("game-finished-timeline-refresh-fail");
  assert(refreshedGame);
  resolveGameRefresh(createJsonResponse(200, refreshedGame));
  await flushAsync();

  assert.equal(failedGoalRefreshes, 1);
  assert.equal(successfulGameRefreshes, 1);
  assert.equal(status.hidden, true);
  assert.match(error.textContent ?? "", /Goal updated\. Scores refreshed; goal timeline unavailable\. Reload to try again/);
  assert.match(timeline.textContent ?? "", /Goal timeline unavailable/);
  assert.equal(resultSummary.hidden, false);
  assert.equal(
    resultSummary.querySelector('[data-testid="game-result-outcome"]')?.textContent,
    "Blue win",
  );
  assert.doesNotMatch(resultSummary.textContent ?? "", /Result refresh required/);
  const blueTeam = resultSummary.querySelector('[data-ui="result-team"][data-team-id="blue"]');
  const redTeam = resultSummary.querySelector('[data-ui="result-team"][data-team-id="red"]');
  assert(blueTeam instanceof page.window.HTMLElement);
  assert(redTeam instanceof page.window.HTMLElement);
  assert.deepEqual(
    [...blueTeam.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
    ["Conceded0", "Scored1"],
  );
  assert.deepEqual(
    [...redTeam.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
    ["Conceded1", "Scored0"],
  );
  const blueScoreCard = page.document.querySelector('[data-ui="score-team"][data-team-id="blue"]');
  const redScoreCard = page.document.querySelector('[data-ui="score-team"][data-team-id="red"]');
  assert(blueScoreCard instanceof page.window.HTMLElement);
  assert(redScoreCard instanceof page.window.HTMLElement);
  assert.deepEqual(
    [...blueScoreCard.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
    ["Conceded0", "Scored1"],
  );
  assert.deepEqual(
    [...redScoreCard.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
    ["Conceded1", "Scored0"],
  );
  assert.equal(resultSummary.querySelector('[data-testid^="final-team-log-"]'), null);
  assert(resultSummary.querySelector('[data-testid="final-goal-summary-unavailable"]'));
  assert.equal(resultSummary.querySelector('[data-testid="final-full-goal-log"]'), null);
  assert.equal(scoringTeamInput.disabled, true);
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.disabled, true);
  assert.equal(saveGoalButton.disabled, true);
  const undoLastGoalButton = page.document.querySelector('[data-action="undo-last-goal"]');
  assert(undoLastGoalButton instanceof page.window.HTMLButtonElement);
  assert.equal(undoLastGoalButton.disabled, true);
  assert.equal(timeline.querySelector('[data-action="edit-goal"]'), null);
  assert.equal(timeline.querySelector('[data-action="delete-goal"]'), null);
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
  assert.match(resultSummary.textContent ?? "", /Result unavailable/);
  assert.doesNotMatch(resultSummary.textContent ?? "", /Draw|Red win/);
  assert.equal(resultSummary.querySelectorAll('[data-ui="result-team"]').length, 0);
  assert.doesNotMatch(resultSummary.innerHTML, /javascript:/);
});

test("game page rejects malformed goal identities without fabricating complete contributions", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-malformed-goal", status: "finished" });
  seedLiveGoalEvent(apiState, "game-malformed-goal", "valid-goal");
  const game = apiState.games.get("game-malformed-goal");
  assert(game);
  refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
  const defaultFetch = createMockFetch(apiState);
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: game.gameId }),
    url: "http://localhost:3000/games/" + game.gameId, scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      const response = await defaultFetch(input, init);
      if (String(input).endsWith("/goals")) {
        const payload = await response.json() as { timeline: MockGoalEvent[] };
        return createJsonResponse(200, { ...payload, timeline: [
          ...payload.timeline, { ...payload.timeline[0], eventId: 123, scorerPlayerId: 99, assistPlayerIds: [17] },
        ] });
      }
      return response;
    },
  });
  const summary = page.document.getElementById("game-result-summary");
  assert.match(summary?.textContent ?? "", /Red win/);
  assert(summary?.querySelector('[data-testid="final-goal-summary-unavailable"]'));
  assert.equal(summary?.querySelector('[data-testid="final-full-goal-log"]'), null);
  assert.equal(summary?.querySelector('[data-testid="final-aggregate-stats"]'), null);
  assert.equal(page.document.querySelector('[data-ui="goal-event"]'), null);
  assert.equal(page.document.querySelector('[data-action="edit-goal"]'), null);
  assert.equal(page.document.getElementById("setup-error")?.hidden, true);
});

for (const yellowColor of ["javascript:alert(1)", "#00000080", "#1a2b3cff"]) {
  test("results entry preserves historical string identities and safe distinct colors: " + yellowColor, async () => {
    const apiState = createMockApiState();
    const gameId = "game-historical-identities";
    seedGoalScoringGame(apiState, { gameId, status: "finished", role: "admin" });
    const game = apiState.games.get(gameId);
    assert(game);
    ensureGameTeams(apiState, game);
    apiState.gameTeams.get(gameId + ":red")!.color = "#123";
    apiState.gameTeams.get(gameId + ":blue")!.color = "#123f";
    apiState.gameTeams.get(gameId + ":yellow")!.color = yellowColor;
    for (const playerId of ["99", "17"]) {
      apiState.players.set(playerId, {
        playerId, nickname: "Same name", claimedByUserId: null,
        createdAt: "2026-03-28T11:00:07.000Z", updatedAt: "2026-03-28T11:00:07.000Z",
      });
      apiState.gamePlayers.set(gameId + ":" + playerId, {
        gameId, playerId, createdAt: "2026-03-28T11:00:07.000Z", updatedAt: "2026-03-28T11:00:07.000Z",
      });
    }
    for (const [index, scorerPlayerId] of ["99", "99", "17", "historical-unrostered"].entries()) {
      seedLiveGoalEvent(apiState, gameId, "history-" + index, 30 + index);
      Object.assign(apiState.goalEvents.get("history-" + index)!, {
        scorerPlayerId, assistPlayerIds: scorerPlayerId === "99" ? ["17"] : [],
        scoringTeamId: index === 3 ? "yellow" : "red",
      });
    }
    refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId }),
      url: "http://localhost:3000/games/" + gameId, scriptFile: "setup-flow.js", apiState,
    });
    const log = page.document.querySelector('[data-testid="final-full-goal-log"]');
    const stats = page.document.querySelector('[data-testid="final-scorer-stats"]');
    assert(log instanceof page.window.HTMLElement && stats instanceof page.window.HTMLElement);
    assert.equal(log.querySelectorAll('[data-ui="final-goal-item"]').length, 4);
    assert.match(log.textContent ?? "", /historical-unrostered/);
    const sameNameRows = [...stats.querySelectorAll("li")].filter((row) => row.querySelector("span")?.textContent === "Same name");
    assert.deepEqual(sameNameRows.map((row) => row.querySelector("strong")?.textContent).sort(), ["1", "2"], "distinct string player IDs never merge through their shared nickname");
    assert.match(page.document.querySelector('[data-testid="final-assist-stats"]')?.textContent ?? "", /Same name\s*2/);
    const red = log.querySelector('[data-team-id="red"]')?.getAttribute("style");
    const blue = log.querySelector('[data-team-id="blue"]')?.getAttribute("style");
    const yellow = log.querySelector('[data-team-id="yellow"]')?.getAttribute("style");
    for (const value of [red, blue, yellow]) assert.match(value ?? "", /^--team-color: #[0-9a-f]{6}$/i);
    assert.equal(new Set([red, blue, yellow]).size, 3);
    if (yellowColor === "#1a2b3cff") assert.equal(yellow, "--team-color: #1a2b3c");
    assert.doesNotMatch(log.innerHTML, /javascript:|#00000080|undefined|null/);
    assert.equal(apiState.roster.has(gameId + ":99"), false, "historical identities need no current assignment");
  });
}

test("game page runs live goal scoring, corrections, undo, and delete", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "game-live-1", role: "scorekeeper" });
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
    { playerId: "player-dax", nickname: "Dax", teamId: "red" as TeamId },
    { playerId: "player-eve", nickname: "Eve", teamId: "blue" as TeamId },
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
  const assistsDropdown = gamePage.document.getElementById("goal-assists-dropdown");
  const assistsSummary = gamePage.document.getElementById("goal-assists-summary");
  const assistsElement = gamePage.document.getElementById("goal-assists");
  const saveGoalButton = gamePage.document.querySelector('[data-action="save-goal"]');
  const undoLastGoalButton = gamePage.document.querySelector('[data-action="undo-last-goal"]');
  const timeline = gamePage.document.getElementById("goal-timeline");

  assert(startThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert(scoreboard instanceof gamePage.window.HTMLElement);
  assert(scoringTeamInput instanceof gamePage.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof gamePage.window.HTMLFieldSetElement);
  assert(ownGoalInput instanceof gamePage.window.HTMLInputElement);
  assert(scorerInput instanceof gamePage.window.HTMLSelectElement);
  assert(assistsDropdown instanceof gamePage.window.HTMLDetailsElement);
  assert(assistsSummary instanceof gamePage.window.HTMLElement);
  assert(assistsElement instanceof gamePage.window.HTMLElement);
  assert(saveGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(timeline instanceof gamePage.window.HTMLElement);

  assert.match(scoreboard.textContent ?? "", /Red/);
  assert.match(timeline.textContent ?? "", /No goals yet/);
  assert.equal(scoringTeamInput.querySelector("legend")?.textContent, "Scoring team");
  assert.equal(concedingTeamInput.querySelector("legend")?.textContent, "Conceding team");
  assert.equal(assistsDropdown.open, false);
  assert.equal(assistsSummary.textContent, "Choose assists");
  assert.equal(undoLastGoalButton.disabled, true);
  for (const scoreTeam of scoreboard.querySelectorAll('[data-ui="score-team"]')) {
    assert.deepEqual(
      [...scoreTeam.querySelectorAll("dt")].map((term) => term.textContent),
      ["Conceded", "Scored"],
    );
  }

  dispatchClick(startThirdButton);
  await flushAsync();

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-ari";
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  const beaAssist = assistsElement.querySelector('input[value="player-bea"]');
  assert(beaAssist instanceof gamePage.window.HTMLInputElement);
  assistsDropdown.open = true;
  beaAssist.focus();
  beaAssist.checked = true;
  beaAssist.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  const focusedBeaAssist = assistsElement.querySelector('input[value="player-bea"]');
  const cyAssist = assistsElement.querySelector('input[value="player-cy"]');
  assert(focusedBeaAssist instanceof gamePage.window.HTMLInputElement);
  assert(cyAssist instanceof gamePage.window.HTMLInputElement);
  assert.equal(gamePage.document.activeElement, focusedBeaAssist);
  assert.equal(assistsSummary.textContent, "1 selected: Bea");
  cyAssist.checked = true;
  cyAssist.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  assert.equal(assistsSummary.textContent, "2 selected: Bea, Cy");
  assert.equal(assistsElement.querySelectorAll('input[type="checkbox"]:checked').length, 2);
  const daxAssist = assistsElement.querySelector('input[value="player-dax"]');
  assert(daxAssist instanceof gamePage.window.HTMLInputElement);
  daxAssist.checked = true;
  daxAssist.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  assert.equal(assistsSummary.textContent, "3 selected: Bea, Cy, Dax");
  assert.equal(assistsSummary.getAttribute("title"), "Bea, Cy, Dax");
  const eveAssist = assistsElement.querySelector('input[value="player-eve"]');
  assert(eveAssist instanceof gamePage.window.HTMLInputElement);
  assert.equal(eveAssist.disabled, true);
  assert.equal(assistsElement.querySelectorAll('input[type="checkbox"]:checked').length, 3);
  const assistsSummaryControl = assistsDropdown.querySelector("summary");
  assert(assistsSummaryControl instanceof gamePage.window.HTMLElement);
  assistsDropdown.dispatchEvent(new gamePage.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(assistsDropdown.open, false);
  assert.equal(gamePage.document.activeElement, assistsSummaryControl);
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, "red");
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*1/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*1/);
  assert.match(timeline.textContent ?? "", /Ari\s*→/);
  assert.deepEqual(apiState.goalEvents.get("goal-1")?.assistPlayerIds, ["player-bea", "player-cy", "player-dax"]);
  assert.match(timeline.textContent ?? "", /Assists: Bea, Cy, Dax/);
  assert.equal(undoLastGoalButton.disabled, false);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
  assert.equal(scorerInput.value, "");
  assert.equal(ownGoalInput.checked, false);
  assert.equal(concedingTeamInput.disabled, true);
  assert.equal(scorerInput.disabled, true);
  assert.equal(assistsElement.querySelectorAll('input[type="checkbox"]:checked').length, 0);
  assert.equal(assistsDropdown.open, false);
  assert.equal(assistsSummary.textContent, "Choose assists");
  const firstGoal = timeline.querySelector('[data-ui="goal-event"][data-event-id="goal-1"]');
  assert(firstGoal instanceof gamePage.window.HTMLElement);
  assert.equal(firstGoal.querySelector('[data-ui="goal-scorer"]')?.getAttribute("title"), "Ari");
  assert(
    firstGoal.querySelector(
      '[data-ui="goal-team-chip"][role="img"][data-team-id="red"][aria-label="Scoring team: Red"]',
    ),
  );
  assert.equal(firstGoal.querySelector('[data-team-id="red"]')?.textContent, "");
  assert.equal(firstGoal.querySelector('[data-team-id="red"]')?.getAttribute("title"), "Scoring team: Red");
  assert(firstGoal.querySelector('[data-ui="goal-team-arrow"]'));
  assert(
    firstGoal.querySelector(
      '[data-ui="goal-team-chip"][role="img"][data-team-id="blue"][aria-label="Conceding team: Blue"]',
    ),
  );
  assert.equal(firstGoal.querySelector('[data-team-id="blue"]')?.textContent, "");
  assert.equal(firstGoal.querySelector('[data-team-id="blue"]')?.getAttribute("title"), "Conceding team: Blue");
  assert.doesNotMatch(firstGoal.textContent ?? "", /\bRed\b|\bBlue\b/);
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
  assert.match(refreshedTimeline.textContent ?? "", /Ari\s*→/);
  assert.equal(refreshedUndoButton.disabled, false);

  const editGoalButton = gamePage.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  assert(editGoalButton instanceof gamePage.window.HTMLButtonElement);
  const editGoalIcon = editGoalButton.querySelector('[data-icon="pencil"]');
  assert(editGoalIcon instanceof gamePage.window.HTMLElement);
  dispatchClick(editGoalIcon);
  await flushAsync();
  ownGoalInput.checked = true;
  ownGoalInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.get("goal-1")?.ownGoal, true);
  assert.equal(apiState.goalEvents.get("goal-1")?.scoringTeamId, null);
  assert.match(scoreboard.querySelector('[data-team-id="red"]')?.textContent ?? "", /Scored\s*0/);
  assert.match(scoreboard.querySelector('[data-team-id="blue"]')?.textContent ?? "", /Conceded\s*1/);
  assert.match(timeline.textContent ?? "", /Cy\s*OG\s*→/);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
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
  setGoalTeamValue(scoringTeamInput, "blue");
  scoringTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "red");
  concedingTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-cy";
  scorerInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 2);
  assert.match(timeline.textContent ?? "", /Cy\s*→/);

  const deleteGoalButton = gamePage.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  assert(deleteGoalButton instanceof gamePage.window.HTMLButtonElement);
  dispatchClick(deleteGoalButton);
  await flushAsync();
  assert.equal(apiState.goalEvents.has("goal-1"), false);
  assert.equal(apiState.goalEvents.has("goal-2"), true);
  assert.match(timeline.textContent ?? "", /Cy\s*→/);
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
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(scoreboard instanceof page.window.HTMLElement);

  assert.equal(ownGoalInput.disabled, false);
  ownGoalInput.click();
  assert.equal(ownGoalInput.checked, true);
  assert.equal(scoringTeamInput.disabled, true);
  assert.equal(goalTeamValue(scoringTeamInput), "");

  setGoalTeamValue(concedingTeamInput, "blue");
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
  const gameDetailsActions = gamePage.document.querySelector('[data-ui="game-details-actions"]');
  const scoreboard = gamePage.document.getElementById("live-scoreboard");
  const goalFormNote = gamePage.document.getElementById("goal-form-note");
  const resultSummary = gamePage.document.getElementById("game-result-summary");

  assert(nicknameInput instanceof gamePage.window.HTMLInputElement);
  assert(quickCreateButton instanceof gamePage.window.HTMLButtonElement);
  assert(startThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert(finishThirdButton instanceof gamePage.window.HTMLButtonElement);
  assert(finishGameButton instanceof gamePage.window.HTMLButtonElement);
  assert(scoringTeamInput instanceof gamePage.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof gamePage.window.HTMLFieldSetElement);
  assert(scorerInput instanceof gamePage.window.HTMLSelectElement);
  assert(saveGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(undoLastGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(deleteGameButton instanceof gamePage.window.HTMLButtonElement);
  assert(statusInput instanceof gamePage.window.HTMLSelectElement);
  assert(joinCodeValue instanceof gamePage.window.HTMLElement);
  assert(joinLink instanceof gamePage.window.HTMLAnchorElement);
  assert(joinQr instanceof gamePage.window.HTMLElement);
  assert(gameDetailsActions instanceof gamePage.window.HTMLElement);
  assert.equal(gameDetailsActions.children.length, 2);
  assert.equal(gameDetailsActions.children[0]?.getAttribute("data-testid"), "save-game");
  assert.equal(gameDetailsActions.children[1]?.getAttribute("data-action"), "cancel-game-edit");
  assert.equal(gamePage.document.querySelector('[data-testid="game-mode-next-players"]')?.textContent?.trim(), "View teams");
  assert(scoreboard instanceof gamePage.window.HTMLElement);
  assert(goalFormNote instanceof gamePage.window.HTMLElement);
  assert(resultSummary instanceof gamePage.window.HTMLElement);
  assert.equal(finishGameButton.disabled, true);
  assert.equal(deleteGameButton.disabled, true);
  assert.equal(deleteGameButton.hidden, true, "Scorers do not manage game deletion");
  assert.equal(deleteGameButton.hasAttribute("aria-disabled"), false);
  assert.equal(gamePage.document.getElementById("game-delete-lock-reason")?.hidden, true);
  assert.equal(joinCodeValue.textContent, "SMOKE123");
  assert.equal(joinLink.getAttribute("href"), "http://localhost:3000/join?code=SMOKE123");
  assert.equal(joinLink.textContent, "http://localhost:3000/join?code=SMOKE123");
  const joinDetails = gamePage.document.querySelector('[data-testid="game-join-details"]');
  assert(joinDetails instanceof gamePage.window.HTMLElement);
  assert.equal(joinDetails.getAttribute("aria-label"), "Join game details");
  assert.equal(joinDetails.children[0]?.getAttribute("data-ui"), "join-qr-block");
  assert.equal(joinDetails.children[1]?.getAttribute("data-ui"), "join-copy");
  assert.equal(joinDetails.querySelectorAll("#game-join-code-value").length, 1);
  assert.equal(joinDetails.querySelectorAll("#game-join-link").length, 1);
  assert.equal(joinDetails.querySelectorAll("#game-join-qr").length, 1);
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

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new gamePage.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
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
  assert.equal(deleteGameButton.hidden, true);
  assert.equal(deleteGameButton.getAttribute("aria-disabled"), "true");
  assert.equal(deleteGameButton.getAttribute("aria-describedby"), "game-delete-lock-reason");
  assert.match(deleteGameButton.getAttribute("aria-label") ?? "", /unavailable.*finished/i);
  assert.equal(deleteGameButton.title, "Finished games cannot be deleted");
  assert.equal(gamePage.document.getElementById("game-delete-lock-reason")?.hidden, false);
  deleteGameButton.focus();
  assert.notEqual(gamePage.document.activeElement, deleteGameButton);
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
  assert.equal(lockedTransferButton, null);
  assert.equal(goalFormNote.textContent, "Ask a league organiser to correct this result.");

  const editGoalButton = gamePage.document.querySelector('[data-action="edit-goal"][data-event-id="goal-1"]');
  const deleteGoalButton = gamePage.document.querySelector('[data-action="delete-goal"][data-event-id="goal-1"]');
  const lockedAssignButton = gamePage.document.querySelector(
    `[data-action="assign-player"][data-player-id="${ari.playerId}"][data-team-id="blue"]`,
  );
  assert(editGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert(deleteGoalButton instanceof gamePage.window.HTMLButtonElement);
  assert.equal(lockedAssignButton, null);
  assert.equal(editGoalButton.disabled, true);
  assert.equal(deleteGoalButton.disabled, true);

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
  enterFinishedCorrections(page);
  enterFinishedCorrections(page, true);
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
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
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
  assert.equal(goalFormNote.textContent, "Editing keeps the original time.");
  setGoalTeamValue(scoringTeamInput, "blue");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "red");
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

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = dee.playerId;
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  assert.equal(saveGoalButton.disabled, false);
  assert.equal(goalFormNote.textContent, "");
  assert.doesNotMatch(goalFormNote.textContent ?? "", /final whistle/);
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 1);
  assert.equal([...apiState.goalEvents.values()][0]?.scorerPlayerId, dee.playerId);
  assert.equal(apiState.games.get("game-admin-finished-correction")?.result?.winnerTeamId, "red");
  assert.match(resultSummary.textContent ?? "", /Red win/);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
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
  enterFinishedCorrections(page);

  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
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
  const pendingStatus = page.document.getElementById("setup-status");
  assert(pendingStatus instanceof page.window.HTMLElement);
  assert.equal(pendingStatus.getAttribute("role"), "status");
  assert.equal(pendingStatus.getAttribute("aria-live"), "polite");
  assert.equal(pendingStatus.getAttribute("data-activity"), "loading");
  assert.equal(pendingStatus.getAttribute("data-state"), null);
  assert.equal(pendingStatus.textContent, "Saving goal…");
  assert(pendingStatus.querySelector('[data-icon="loader-circle"][aria-hidden="true"]'));
  assert(pendingStatus.querySelector('[data-ui="activity-message"]')?.classList.contains("sr-only"));

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
  const completedStatus = page.document.getElementById("setup-status");
  assert(completedStatus instanceof page.window.HTMLElement);
  assert.equal(completedStatus.textContent, "Goal recorded.");
  assert.equal(completedStatus.getAttribute("data-state"), "success");
  assert.equal(completedStatus.getAttribute("data-activity"), "message");
  assert.equal(
    completedStatus.querySelector('[data-ui="activity-message"]')?.classList.contains("sr-only"),
    false,
  );
  assert.equal(completedStatus.hidden, false, "confirmed mutations have visible feedback");
});

test("game page clears a committed finished-goal draft when timeline and result refresh fail", async () => {
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
  let failNextGoalRefresh = false;
  let failNextGameRefresh = false;
  const staleResultFetch: ReturnType<typeof createMockFetch> = async (input, init = {}) => {
    const target =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input))
        : new URL(input.url);
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "POST" && target.pathname === "/v1/games/game-create-refresh-fail/goals") {
      const response = await defaultFetch(input, init);
      failNextGoalRefresh = true;
      failNextGameRefresh = true;
      return response;
    }

    if (
      method === "GET" &&
      target.pathname === "/v1/games/game-create-refresh-fail/goals" &&
      failNextGoalRefresh
    ) {
      failNextGoalRefresh = false;
      return createJsonResponse(503, {
        error: "unavailable",
        message: "Goal refresh unavailable.",
      });
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
  enterFinishedCorrections(page);

  const scoringTeamInput = page.document.getElementById("goal-scoring-team");
  const concedingTeamInput = page.document.getElementById("goal-conceding-team");
  const scorerInput = page.document.getElementById("goal-scorer");
  const ownGoalInput = page.document.getElementById("goal-own-goal");
  const saveGoalButton = page.document.querySelector('[data-action="save-goal"]');
  const status = page.document.getElementById("setup-status");
  const error = page.document.getElementById("setup-error");
  const resultSummary = page.document.getElementById("game-result-summary");
  const scoreboard = page.document.getElementById("live-scoreboard");
  const timeline = page.document.getElementById("goal-timeline");
  assert(scoringTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(concedingTeamInput instanceof page.window.HTMLFieldSetElement);
  assert(scorerInput instanceof page.window.HTMLSelectElement);
  assert(ownGoalInput instanceof page.window.HTMLInputElement);
  assert(saveGoalButton instanceof page.window.HTMLButtonElement);
  assert(status instanceof page.window.HTMLElement);
  assert(error instanceof page.window.HTMLElement);
  assert(resultSummary instanceof page.window.HTMLElement);
  assert(scoreboard instanceof page.window.HTMLElement);
  assert(timeline instanceof page.window.HTMLElement);

  setGoalTeamValue(scoringTeamInput, "red");
  scoringTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  setGoalTeamValue(concedingTeamInput, "blue");
  concedingTeamInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  scorerInput.value = "player-ari";
  scorerInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  dispatchClick(saveGoalButton);
  await flushAsync();

  assert.equal(apiState.goalEvents.size, 1);
  assert.equal(status.hidden, true);
  assert.match(error.textContent ?? "", /neither the latest goal state nor the finished result/);
  assert.equal(error.hidden, false);
  assert.equal(status.hidden, true);
  assert.match(error.textContent ?? "", /Goal recorded, but neither.*could be refreshed\. Reload to try again/);
  assert.doesNotMatch(error.textContent ?? "", /Goal added; timeline and result refresh failed/);
  assert.match(scoreboard.textContent ?? "", /Scores unavailable/);
  assert.equal(scoreboard.querySelector('[data-ui="score-team"]'), null);
  assert.match(timeline.textContent ?? "", /Goal timeline unavailable/);
  assert.equal(resultSummary.hidden, false);
  assert.match(resultSummary.textContent ?? "", /Result refresh required/);
  assert.match(resultSummary.textContent ?? "", /The latest match result could not be loaded/);
  assert.equal(resultSummary.querySelector('[data-testid="game-result-outcome"]'), null);
  assert.equal(goalTeamValue(scoringTeamInput), "");
  assert.equal(goalTeamValue(concedingTeamInput), "");
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
  enterFinishedCorrections(page);

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
  assert.match(timeline.textContent ?? "", /Ari\s*→/);
  assert.doesNotMatch(timeline.textContent ?? "", /Cy\s*→/);
  assert.equal(status.hidden, true);
  assert.match(error.textContent ?? "", /Latest goal undone, but the finished result could not be refreshed/);
  assert.equal(error.hidden, false);
  assert.equal(error.getAttribute("role"), "status");
  assert.equal(error.getAttribute("aria-live"), "polite");
  assert.match(error.textContent ?? "", /finished result could not be refreshed/);
  const redScoreCard = page.document.querySelector('[data-ui="score-team"][data-team-id="red"]');
  const blueScoreCard = page.document.querySelector('[data-ui="score-team"][data-team-id="blue"]');
  assert(redScoreCard instanceof page.window.HTMLElement);
  assert(blueScoreCard instanceof page.window.HTMLElement);
  assert.deepEqual(
    [...redScoreCard.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
    ["Conceded0", "Scored1"],
  );
  assert.deepEqual(
    [...blueScoreCard.querySelectorAll("dl div")].map((row) => row.textContent?.replace(/\s/g, "")),
    ["Conceded1", "Scored0"],
  );
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
    joinCode: "ABCD2345",
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
    url: "http://localhost:3000/join?code=abcd2345",
    scriptFile: "setup-flow.js",
    apiState,
  });

  assert.equal(joinPage.navigations.length, 0);
  assert.equal(joinPage.document.getElementById("join-code-value")?.textContent, "ABCD2345");
  assert.equal(joinPage.document.getElementById("setup-status")?.textContent, "");
  assert.equal(joinPage.document.getElementById("setup-status")?.hidden, true);

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
  assert.match(firstJoinKey, /^join-player-ABCD2345-Cy-/);
  assert.equal(apiState.storage.has("threefc-idempotency:join-player:ABCD2345-Cy"), false);
  assert.equal(apiState.gamePlayers.has(`game-join-1:${player.playerId}`), true);
  assert.equal(joinPage.document.getElementById("join-result")?.hidden, false);
  assert.equal(joinPage.document.getElementById("join-result-player")?.textContent, "Cy");
  assert.equal(joinPage.document.getElementById("join-result-game"), null);
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
    `/link-player?proofId=${(apiState.lastPublicJoinRequest?.body.claimProof as { proofId: string }).proofId}`,
  );

  const secondJoinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""),
    url: "http://localhost:3000/join?code=abcd2345",
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
  assert.match(secondJoinKey, /^join-player-ABCD2345-Cy-/);
  assert.notEqual(secondJoinKey, firstJoinKey);
  assert.equal(apiState.players.size, 2);
  assert.equal(apiState.storage.has("threefc-idempotency:join-player:ABCD2345-Cy"), false);
});

test("join page requires explicit profile linking after a signed-in participant joins", async () => {
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
    joinCode: "BCDE2345",
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
    html: renderJoinPage("http://localhost:3001", "bcde2345"),
    url: "http://localhost:3000/join/bcde2345",
    scriptFile: "setup-flow.js",
    apiState,
  });

  const nicknameInput = joinPage.document.getElementById("join-player-nickname");
  const form = joinPage.document.getElementById("join-game-form");
  assert(nicknameInput instanceof joinPage.window.HTMLInputElement);
  assert(form instanceof joinPage.window.HTMLFormElement);

  await chooseNewJoinPlayer(joinPage);
  nicknameInput.value = "Dee";
  nicknameInput.dispatchEvent(new joinPage.window.Event("input", { bubbles: true }));
  dispatchSubmit(form);
  await flushAsync();

  const player = [...apiState.players.values()][0];
  assert(player);
  assert.equal(player.claimedByUserId, null);
  assert.equal(joinPage.document.getElementById("setup-status")?.textContent, "Joined game.");
  assert.equal(joinPage.document.getElementById("join-claim-status")?.hidden, true);
  const claimButton = joinPage.document.querySelector('[data-testid="claim-player"]');
  assert(claimButton instanceof joinPage.window.HTMLButtonElement);
  assert.equal(claimButton.disabled, false);
  dispatchClick(claimButton);
  await flushAsync();
  assert.match(joinPage.navigations.at(-1)?.url ?? "", /^\/link-player\?proofId=/);
  assert.equal(player.claimedByUserId, null, "navigation cannot claim before account confirmation");
});

test("join page offers organiser recovery for legacy sign-in returns without proof", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "returned-game", role: "viewer", sessionEmail: "delegate@3fc.football" });
  apiState.games.get("returned-game")!.joinCode = "BCDE2345";
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
  apiState.gamePlayers.set("returned-game:player-returned", {
    gameId: "returned-game", playerId: "player-returned",
    createdAt: "2026-03-28T11:00:12.000Z", updatedAt: "2026-03-28T11:00:12.000Z",
  });

  const joinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""),
    url: "http://localhost:3000/join?code=bcde2345&playerId=player-returned",
    scriptFile: "setup-flow.js",
    apiState,
  });

  await flushAsync();

  assert.equal(apiState.players.get("player-returned")?.claimedByUserId, null);
  assert.match(joinPage.document.getElementById("join-claim-status")?.textContent ?? "", /Ask the organiser for a private link/);
  assert.equal(joinPage.document.getElementById("join-result")?.hidden, false, "the authenticated exact-game context read verifies its display identity");
  assert.equal(joinPage.document.getElementById("join-result-player")?.textContent, "Dee");
  const claimButton = joinPage.document.querySelector('[data-testid="claim-player"]');
  assert(claimButton instanceof joinPage.window.HTMLButtonElement);
  assert.equal(claimButton.hidden, true);
  assert.equal(claimButton.disabled, true);

  dispatchClick(claimButton);
  await flushAsync();

  assert.equal(apiState.players.get("player-returned")?.claimedByUserId, null);
  assert.equal(joinPage.navigations.length, 0);
});

test("join page keeps committed registration when an API response omits proof metadata", async () => {
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
    joinCode: "CDEF2345",
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

    if (method === "POST" && target.pathname.startsWith("/v1/join/")) {
      const result = await defaultFetch(input, init);
      const body = await result.json() as Record<string, unknown>;
      delete body.claimProof;
      return createJsonResponse(result.status, body);
    }

    return defaultFetch(input, init);
  };

  const joinPage = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""),
    url: "http://localhost:3000/join?code=cdef2345",
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

  await chooseNewJoinPlayer(joinPage);
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
  assert.equal(joinPage.document.getElementById("setup-status")?.textContent, "Joined game.");
  assert.match(joinPage.document.getElementById("join-claim-status")?.textContent ?? "", /Ask the organiser for a private link/);
  assert.equal(nicknameInput.disabled, true);
  assert.equal(joinButton.disabled, true);

  const claimButton = joinPage.document.querySelector('[data-testid="claim-player"]');
  assert(claimButton instanceof joinPage.window.HTMLButtonElement);
  assert.equal(claimButton.hidden, true);
  assert.equal(claimButton.disabled, true);
});

test("join page preserves distinct retry keys for similar public nicknames", async () => {
  const apiState = createMockApiState();
  apiState.games.set("game-join-1", {
    gameId: "game-join-1",
    joinCode: "ABCD2345",
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

    if (method === "POST" && target.pathname === "/v1/join/ABCD2345") {
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
    html: renderJoinPage("http://localhost:3001", "abcd2345"),
    url: "http://localhost:3000/join/abcd2345",
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
    html: renderJoinPage("http://localhost:3001", "abcd2345"),
    url: "http://localhost:3000/join/abcd2345",
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
  assert.equal(apiState.storage.get("threefc-idempotency:join-player:ABCD2345-A%20B"), requestedKeys[0]);
  assert.equal(apiState.storage.get("threefc-idempotency:join-player:ABCD2345-A-B"), requestedKeys[1]);
});

function seedResultsEntry(apiState: MockApiState, gameId = "results-entry", role: MockLeagueRole = "viewer") {
  seedGoalScoringGame(apiState, { gameId, status: "finished", role });
  const game = apiState.games.get(gameId);
  assert(game);
  return refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
}

for (const item of [
  { name: "fewest conceded", counts: [[1, 0], [2, 1], [3, 2]], outcome: "win", winner: "red", expected: "Red win" },
  { name: "scored tiebreak", counts: [[3, 1], [2, 1], [1, 2]], outcome: "win", winner: "red", expected: "Red win" },
  { name: "two-way draw", counts: [[2, 1], [2, 1], [1, 2]], outcome: "draw", winner: null, expected: "Draw" },
  { name: "zero three-way draw", counts: [[0, 0], [0, 0], [0, 0]], outcome: "draw", winner: null, expected: "Draw" },
]) {
  test("results entry validates outcome and stable comparable totals: " + item.name, async () => {
    const apiState = createMockApiState();
    const game = seedResultsEntry(apiState);
    assert(game.result);
    Object.assign(game.result, { outcome: item.outcome, winnerTeamId: item.winner });
    game.result.teams = (["yellow", "red", "blue"] as const).map((teamId) => {
      const index = ["red", "blue", "yellow"].indexOf(teamId);
      const existing = game.result!.teams.find((team) => team.teamId === teamId)!;
      return { ...existing, name: "" as string, scored: item.counts[index][0], conceded: item.counts[index][1] };
    });
    const paths: string[] = [];
    const base = createMockFetch(apiState);
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: game.gameId }),
      url: "http://localhost:3000/games/" + game.gameId, scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => { paths.push(new URL(String(input)).pathname); return base(input, init); },
    });
    try {
      assert.equal(page.document.querySelector('[data-testid="game-result-outcome"]')?.textContent, item.expected);
      const teams = [...page.document.querySelectorAll('[data-ui="result-team"]')];
      assert.deepEqual(teams.map((team) => team.getAttribute("data-team-id")), ["red", "blue", "yellow"]);
      assert.deepEqual(teams.map((team) => [...team.querySelectorAll("dd")].map((count) => count.textContent)), item.counts.map(([scored, conceded]) => [String(conceded), String(scored)]));
      assert.equal(page.document.querySelectorAll('[data-testid="final-full-goal-log"]').length, 1);
      assert.match(page.document.querySelector('[data-testid="final-full-goal-log"]')?.textContent ?? "", /No goals recorded/);
      assert.equal(paths.some((path) => path === "/v1/players"), false, "viewer reads do not depend on administrative player search");
      assert.equal(page.document.querySelector('[data-action="correct-finished-result"]')?.hasAttribute("hidden"), true);
    } finally { page.dom.window.close(); }
  });
}

for (const defect of ["missing-result", "missing-team", "duplicate-team", "null-team", "negative-count", "string-count", "fraction-count", "missing-outcome", "wrong-winner", "false-draw"] as const) {
  test("results entry never invents a winner or zero for malformed results: " + defect, async () => {
    const apiState = createMockApiState();
    seedResultsEntry(apiState);
    seedLiveGoalEvent(apiState, "results-entry", "goal-valid");
    const game = refreshMockFinishedResult(apiState, apiState.games.get("results-entry")!, "2026-03-28T11:02:00.000Z");
    assert(game.result);
    const result = game.result as unknown as Record<string, unknown>;
    const teams = game.result.teams as unknown as Array<Record<string, unknown>>;
    if (defect === "missing-result") game.result = null;
    if (defect === "missing-team") teams.pop();
    if (defect === "duplicate-team") teams[1] = { ...teams[0] };
    if (defect === "null-team") teams[1] = null as unknown as Record<string, unknown>;
    if (defect === "negative-count") teams[0].conceded = -1;
    if (defect === "string-count") teams[0].scored = "1";
    if (defect === "fraction-count") teams[0].scored = 1.5;
    if (defect === "missing-outcome") delete result.outcome;
    if (defect === "wrong-winner") result.winnerTeamId = "blue";
    if (defect === "false-draw") Object.assign(result, { outcome: "draw", winnerTeamId: null });
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: game.gameId }),
      url: "http://localhost:3000/games/" + game.gameId, scriptFile: "setup-flow.js", apiState,
    });
    try {
      assert(page.document.querySelector('[data-testid="result-unavailable"]'));
      assert.equal(page.document.querySelector('[data-testid="game-result-outcome"]'), null);
      const countsValid = ["missing-outcome", "wrong-winner", "false-draw"].includes(defect);
      assert.equal(page.document.querySelectorAll('[data-ui="result-team"]').length, countsValid ? 3 : 0);
      assert.equal(page.document.querySelectorAll('[data-testid="final-full-goal-log"] [data-ui="final-goal-item"]').length, 1, "independent valid log survives an invalid result");
    } finally { page.dom.window.close(); }
  });
}

for (const defect of ["missing", "null", "object", "null-row", "duplicate-event", "cross-game", "numeric-player", "invalid-own-goal", "invented-scoring-team", "four-assists", "duplicate-assist", "self-assist", "invalid-third"] as const) {
  test("results entry does not turn partial or malformed logs into complete statistics: " + defect, async () => {
    const apiState = createMockApiState();
    seedResultsEntry(apiState);
    seedLiveGoalEvent(apiState, "results-entry", "goal-valid");
    const game = refreshMockFinishedResult(apiState, apiState.games.get("results-entry")!, "2026-03-28T11:02:00.000Z");
    const base = createMockFetch(apiState);
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: game.gameId }),
      url: "http://localhost:3000/games/" + game.gameId, scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const response = await base(input, init);
        if (!String(input).endsWith("/goals")) return response;
        const payload = await response.json() as Record<string, unknown>;
        const goal = { ...apiState.goalEvents.get("goal-valid")! } as Record<string, unknown>;
        if (defect === "missing") delete payload.timeline;
        else if (defect === "null") payload.timeline = null;
        else if (defect === "object") payload.timeline = {};
        else if (defect === "null-row") payload.timeline = [goal, null];
        else if (defect === "duplicate-event") payload.timeline = [goal, goal];
        else {
          if (defect === "cross-game") goal.gameId = "another-game";
          if (defect === "numeric-player") goal.scorerPlayerId = 99;
          if (defect === "invalid-own-goal") goal.ownGoal = "false";
          if (defect === "invented-scoring-team") Object.assign(goal, { ownGoal: true, scoringTeamId: "red" });
          if (defect === "four-assists") goal.assistPlayerIds = ["a", "b", "c", "d"];
          if (defect === "duplicate-assist") goal.assistPlayerIds = ["a", "a"];
          if (defect === "self-assist") goal.assistPlayerIds = [goal.scorerPlayerId];
          if (defect === "invalid-third") goal.third = 4;
          payload.timeline = [goal];
        }
        return createJsonResponse(200, payload);
      },
    });
    try {
      assert.equal(page.document.querySelector('[data-testid="game-result-outcome"]')?.textContent, "Red win");
      assert.equal(page.document.querySelectorAll('[data-ui="result-team"]').length, 3);
      assert(page.document.querySelector('[data-testid="final-goal-summary-unavailable"]'));
      assert.equal(page.document.querySelector('[data-testid="final-full-goal-log"]'), null);
      assert.equal(page.document.querySelector('[data-testid="final-aggregate-stats"]'), null);
      assert.equal(page.document.querySelector('[data-action="edit-goal"]'), null);
      assert.equal(page.document.getElementById("setup-error")?.hidden, true);
      assert.doesNotMatch(page.document.getElementById("game-result-summary")?.textContent ?? "", /No goals recorded|No scorers recorded/);
    } finally { page.dom.window.close(); }
  });
}

test("results entry confirmed malformed goal response still clears draft and retires replay ownership", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "malformed-commit", status: "live", thirds: [
    { third: 1, startedAt: "2026-03-28T11:00:00.000Z", finishedAt: null },
    { third: 2, startedAt: null, finishedAt: null }, { third: 3, startedAt: null, finishedAt: null },
  ] });
  const base = createMockFetch(apiState);
  let commits = 0;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "malformed-commit" }),
    url: "http://localhost:3000/games/malformed-commit#score", scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (String(input).endsWith("/goals") && init.method === "POST") {
        const response = await base(input, init);
        assert.equal(response.status, 201);
        commits += 1;
        return createJsonResponse(201, { timeline: [null], scoreboard: { teams: [null] } });
      }
      if (String(input).endsWith("/goals") && commits) return createJsonResponse(503, { error: "unavailable" });
      return base(input, init);
    },
  });
  try {
    const controls = liveGoalControls(page);
    controls.draft();
    dispatchSubmit(controls.form);
    await flushAsync();
    assert.equal(commits, 1);
    assert.equal(apiState.goalEvents.size, 1);
    assert.equal(goalTeamValue(controls.scoring), "");
    assert.equal(goalTeamValue(controls.conceding), "");
    assert.equal(controls.scorer.value, "");
    assert.equal(controls.retry.hidden, true, "malformed snapshot is not a failed committed write");
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Goal recorded, but/);
    dispatchClick(controls.retry);
    dispatchSubmit(controls.form);
    await flushAsync();
    assert.equal(commits, 1);
  } finally { page.dom.window.close(); }
});

async function chooseNewJoinPlayer(page: Awaited<ReturnType<typeof bootPage>>) {
  await flushAsync();
  const control = [...page.document.querySelectorAll("#returning-player button")].find(button => button.textContent === "Create new player");
  assert(control instanceof page.window.HTMLButtonElement, "completed signed-in discovery offers an explicit new-player action");
  assert.equal(control.disabled, false);
  assert.equal(page.document.getElementById("join-game-form")?.hidden, true, "new-player form is not the default signed-in path");
  dispatchClick(control); await flushAsync();
  assert.equal(page.document.getElementById("join-game-form")?.hidden, false);
}

function joinEntryControls(page: Awaited<ReturnType<typeof bootPage>>) {
  const form = page.document.getElementById("join-game-form");
  const nickname = page.document.getElementById("join-player-nickname");
  const button = page.document.querySelector('[data-action="join-game"]');
  const claim = page.document.querySelector('[data-action="claim-player"]');
  const another = page.document.querySelector('[data-action="join-another-player"]');
  assert(form instanceof page.window.HTMLFormElement && nickname instanceof page.window.HTMLInputElement);
  assert(button instanceof page.window.HTMLButtonElement && claim instanceof page.window.HTMLButtonElement && another instanceof page.window.HTMLButtonElement);
  return { form, nickname, button, claim, another };
}

for (const lost of ["503", "network", "malformed"] as const) {
  test("results entry freezes public join identity through blocked storage and " + lost, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "entry-join" });
    apiState.games.get("entry-join")!.joinCode = "ABCD2345";
    apiState.session = null; apiState.cookieJar = "";
    const base = createMockFetch(apiState);
    const requests: Array<{ path: string; key: string | null; body: string }> = [];
    let release: (() => void) | undefined;
    let committed: Response | undefined;
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", ""), url: "http://localhost:3000/join?code=abcd2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (!path.startsWith("/v1/join/")) return base(input, init);
        requests.push({ path, key: readInitHeader(init, "idempotency-key"), body: String(init.body) });
        if (requests.length === 1) {
          committed = await base(input, init);
          return new Promise<Response>((resolve, reject) => { release = () => {
            if (lost === "network") reject(new Error("connection lost"));
            else resolve(createJsonResponse(lost === "malformed" ? 201 : 503, lost === "malformed" ? {} : { error: "unavailable" }));
          }; });
        }
        if (requests.length === 2) return createJsonResponse(409, { error: "conflict", code: "game_finished" });
        assert(committed);
        return committed.clone();
      },
    });
    try {
      Object.defineProperty(page.window, "localStorage", { configurable: true, get: () => { throw new Error("blocked storage"); } });
      const controls = joinEntryControls(page);
      const before = apiState.players.size;
      controls.nickname.value = "First player";
      dispatchSubmit(controls.form); dispatchSubmit(controls.form);
      await flushAsync();
      assert.equal(requests.length, 1);
      assert.equal(page.document.getElementById("returning-player")?.hidden, true, "do not abandon a pending anonymous registration via generic sign-in");
      assert.equal(controls.nickname.disabled, true);
      controls.nickname.value = "Different player";
      controls.nickname.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      assert.equal(controls.nickname.value, "First player");
      assert(release); release(); await flushAsync();
      assert.equal(controls.button.textContent, "Retry join");
      assert.equal(page.document.getElementById("returning-player")?.hidden, true, "uncertain registration retains only its proof-bound recovery");
      assert.equal(page.document.getElementById("join-result")?.hidden, true);
      assert.equal(apiState.players.size, before + 1);
      dispatchSubmit(controls.form); await flushAsync();
      assert.equal(controls.nickname.disabled, true, "a later business rejection cannot disprove a previous lost commit");
      assert.equal(controls.button.textContent, "Retry join");
      dispatchSubmit(controls.form); await flushAsync();
      assert.equal(requests.length, 3);
      assert(requests[0].key);
      assert.deepEqual(requests[1], requests[0]); assert.deepEqual(requests[2], requests[0]);
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "First player");
      assert.equal(controls.form.hidden, true);
      assert.equal(controls.another.hidden, false);
      assert.equal(apiState.players.size, before + 1);
      dispatchClick(controls.another);
      assert.equal(controls.form.hidden, false);
      assert.equal(controls.nickname.disabled, false);
      assert.equal(controls.nickname.value, "");
      assert.equal(page.document.activeElement, controls.nickname);
    } finally { page.dom.window.close(); }
  });
}

test("disabled linking joins once and retains the exact request after a lost reply", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "disabled-join" });
  apiState.games.get("disabled-join")!.joinCode = "ABCD2345";
  const base = createMockFetch(apiState);
  const requests: string[] = [];
  let committed: Record<string, unknown> | null = null;
  const page = await bootPage({
    html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join/ABCD2345",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (String(input).includes("/v1/join/") && init.method === "POST") {
        requests.push(JSON.stringify([init.headers, init.body]));
        if (!committed) {
          committed = await (await base(input, init)).json() as Record<string, unknown>;
          delete committed.claimProof;
          committed.linkingUnavailable = true;
          throw new Error("lost committed reply");
        }
        return new Response(JSON.stringify(committed), { status: 201 });
      }
      return base(input, init);
    },
  });
  try {
    const controls = joinEntryControls(page);
    await chooseNewJoinPlayer(page);
    controls.nickname.value = "Still playing";
    dispatchSubmit(controls.form); await flushAsync();
    dispatchSubmit(controls.form); await flushAsync();
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    assert.equal(page.document.getElementById("join-result-player")?.textContent, "Still playing");
    assert.equal(controls.claim.hidden, true);
    assert.match(page.document.getElementById("join-claim-status")?.textContent ?? "", /temporarily unavailable/);
    dispatchSubmit(controls.form); await flushAsync();
    assert.equal(requests.length, 2);
  } finally { page.dom.window.close(); }
});

for (const cleanupFailure of [false, true]) {
  test(`disabled linking retires unissued join proofs without repeating committed registration: ${cleanupFailure}`, async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "containment-many" });
    apiState.games.get("containment-many")!.joinCode = "ABCD2345";
    const base = createMockFetch(apiState); let joins = 0; let blockCleanup = cleanupFailure;
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join/ABCD2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        if (String(input).includes("/v1/join/") && init.method === "POST") {
          joins += 1;
          const result = await (await base(input, init)).json() as Record<string, unknown>;
          delete result.claimProof; result.linkingUnavailable = true;
          return createJsonResponse(201, result);
        }
        return base(input, init);
      },
    });
    try {
      const originalSet = page.window.Storage.prototype.setItem;
      Object.defineProperty(page.window.Storage.prototype, "setItem", { configurable: true,
        value: function(this: Storage, key: string, value: string) {
          if (blockCleanup && key === "threefc.player-proof.v1" && value === "[]") throw new Error("cleanup blocked");
          return originalSet.call(this, key, value);
        },
      });
      const controls = joinEntryControls(page);
      await chooseNewJoinPlayer(page);
      controls.nickname.value = "Player 0"; dispatchSubmit(controls.form); await flushAsync();
      assert.equal(joins, 1); assert.equal(controls.form.hidden, true);
      if (cleanupFailure) {
        dispatchClick(controls.another); controls.nickname.value = "Player 1";
        dispatchSubmit(controls.form); await flushAsync();
        assert.equal(joins, 1, "failed local cleanup must never repeat or start a registration");
        assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /couldn’t clear/);
        blockCleanup = false;
      } else dispatchClick(controls.another);
      for (let index = 1; index < 25; index++) {
        controls.nickname.value = `Player ${index}`; dispatchSubmit(controls.form); await flushAsync();
        assert.equal(joins, index + 1);
        assert.equal(page.document.getElementById("join-result-player")?.textContent, `Player ${index}`);
        assert.deepEqual(JSON.parse(page.window.sessionStorage.getItem("threefc.player-proof.v1") ?? "[]"), []);
        dispatchClick(controls.another);
      }
    } finally { page.dom.window.close(); }
  });
}

test("results entry linking navigation never repeats a confirmed registration or auto-claims", async () => {
  const apiState = createMockApiState();
  seedGoalScoringGame(apiState, { gameId: "claim-recovery" });
  apiState.games.get("claim-recovery")!.joinCode = "ABCD2345";
  const base = createMockFetch(apiState);
  let joins = 0; let claims = 0;
  const page = await bootPage({
    html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join/ABCD2345",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (String(input).includes("/v1/join/") && init.method === "POST") joins += 1;
      if (String(input).endsWith("/claim")) {
        claims += 1;
        throw new Error("Joining must not make a claim request");
      }
      return base(input, init);
    },
  });
  try {
    const controls = joinEntryControls(page);
    await chooseNewJoinPlayer(page);
    controls.nickname.value = "Joined player";
    dispatchSubmit(controls.form); await flushAsync();
    assert.equal(joins, 1); assert.equal(claims, 0);
    assert.equal(page.document.getElementById("join-result-player")?.textContent, "Joined player");
    assert.equal(page.document.getElementById("setup-error")?.hidden, true);
    const child = page.document.createElement("span"); controls.claim.append(child);
    dispatchClick(child); dispatchClick(controls.claim); dispatchSubmit(controls.form);
    await flushAsync();
    assert.equal(claims, 0); assert.equal(joins, 1);
    assert.match(page.navigations.at(-1)?.url ?? "", /^\/link-player\?proofId=/);
    assert.equal(page.document.getElementById("setup-status")?.textContent, "Joined game.");
    assert.equal(page.document.getElementById("setup-error")?.hidden, true);
    assert.equal(page.document.getElementById("join-claim-status")?.hidden, true);
    assert.equal(apiState.leagueAccess.size, 1, "link navigation does not grant a new role");
    assert.equal(joins, 1);
  } finally { page.dom.window.close(); }
});

for (const probe of ["503", "408", "malformed"] as const) {
  test("results entry retains joined player when its claim session probe is unknown: " + probe, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "join-probe" });
    apiState.games.get("join-probe")!.joinCode = "ABCD2345";
    const base = createMockFetch(apiState);
    let sessionReads = 0; let joins = 0; let claims = 0;
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join/ABCD2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/auth/session" && ++sessionReads > 1) return createJsonResponse(probe === "malformed" ? 200 : Number(probe), {});
        if (path.startsWith("/v1/join/") && init.method === "POST") joins += 1;
        if (path.endsWith("/claim")) claims += 1;
        return base(input, init);
      },
    });
    try {
      const controls = joinEntryControls(page);
      await chooseNewJoinPlayer(page);
      controls.nickname.value = "Known registration";
      dispatchSubmit(controls.form); await flushAsync();
      for (let wait = 0; wait < 20 && !page.document.getElementById("setup-error")?.textContent?.includes("Sign-in could not be checked"); wait += 1) await flushAsync();
      assert.equal(joins, 1); assert.equal(claims, 0);
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "Known registration");
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Sign-in could not be checked/);
      assert.equal(controls.claim.hidden, false);
      assert.equal(controls.claim.disabled, false);
      dispatchClick(controls.claim); await flushAsync();
      assert.equal(joins, 1); assert.equal(claims, 0);
      assert.match(page.navigations.at(-1)?.url ?? "", /^\/link-player\?proofId=/);
    } finally { page.dom.window.close(); }
  });
}

for (const kind of ["join", "invites"] as const) {
  test("results entry account switching retains only reconstructed safe context: " + kind, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "account-entry" });
    const query = "?code=abcd2345&playerId=player-ari&token=not-a-real-token&error=unsafe&returnTo=https%3A%2F%2Fevil.example&code_verifier=secret#unsafe";
    const page = await bootPage({
      html: kind === "join" ? renderJoinPage("http://localhost:3001", "") : renderInvitePage("http://localhost:3001", ""),
      url: "http://localhost:3000/" + kind + query, scriptFile: "setup-flow.js", apiState,
    });
    try {
      const button = page.document.getElementById("sign-out");
      assert(button instanceof page.window.HTMLButtonElement);
      assert.equal(button.disabled, false);
      dispatchClick(button); await flushAsync();
      assert.equal(apiState.session, null);
      assert.equal(page.navigations.length, 1);
      const href = new URL(page.navigations[0].url, "http://localhost:3000");
      assert.equal(href.searchParams.get("returnTo"), "/" + kind + "?code=ABCD2345" + (kind === "join" ? "&playerId=player-ari" : ""));
      assert.doesNotMatch(page.navigations[0].url, /token|unsafe|secret|evil|code_verifier/);
      assert.equal(page.navigations[0].mode, "replace");
    } finally { page.dom.window.close(); }
  });
}

test("results entry anonymous invite redirects only to its sanitized code", async () => {
  const apiState = createMockApiState();
  const page = await bootPage({
    html: renderInvitePage("http://localhost:3001", ""),
    url: "http://localhost:3000/invites?code=abcd2345&token=not-a-real-token&playerId=unrelated#extra",
    scriptFile: "setup-flow.js", apiState,
  });
  try {
    assert.deepEqual(page.navigations, [{ url: "/sign-in?returnTo=" + encodeURIComponent("/invites?code=ABCD2345"), mode: "replace" }]);
  } finally { page.dom.window.close(); }
});

function seedEntryInvite(apiState: MockApiState) {
  seedGoalScoringGame(apiState, { gameId: "invite-entry", sessionEmail: "invitee@example.com", role: "viewer" });
  apiState.games.get("invite-entry")!.joinCode = "ABCD2345";
  apiState.leagueInvites.set("ABCD2345", {
    leagueId: "three-sided-football-club", inviteCode: "ABCD2345", kind: "email", role: "admin",
    email: "invitee@example.com", createdByUserId: "organizer@3fc.football", acceptedByUserId: null, acceptedAt: null,
    createdAt: "2026-03-28T11:00:15.000Z", updatedAt: "2026-03-28T11:00:15.000Z",
  });
}

for (const outcome of ["lost-response", "malformed", "invalid-league"] as const) {
  test("results entry invite latches and retries only its captured code: " + outcome, async () => {
    const apiState = createMockApiState();
    seedEntryInvite(apiState);
    const base = createMockFetch(apiState);
    const requests: Array<{ path: string; body: string }> = [];
    let release: (() => void) | undefined;
    let original: Response | undefined;
    const page = await bootPage({
      html: renderInvitePage("http://localhost:3001", ""), url: "http://localhost:3000/invites?code=abcd2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (!path.endsWith("/accept")) return base(input, init);
        requests.push({ path, body: String(init.body) });
        if (requests.length === 1) {
          original = await base(input, init);
          return new Promise<Response>((resolve) => { release = () => resolve(createJsonResponse(outcome === "lost-response" ? 503 : 200,
            outcome === "invalid-league" ? { access: { leagueId: { path: "../auth/callback" } } } : {})); });
        }
        if (requests.length === 2) return createJsonResponse(409, { error: "conflict", code: "invite_already_accepted" });
        assert(original); return original.clone();
      },
    });
    try {
      const button = page.document.querySelector('[data-action="accept-organiser-invite"]');
      const code = page.document.getElementById("organiser-invite-code-input");
      const form = page.document.getElementById("organiser-invite-code-form");
      assert(button instanceof page.window.HTMLButtonElement && code instanceof page.window.HTMLInputElement && form instanceof page.window.HTMLFormElement);
      button.focus();
      const child = page.document.createElement("span"); button.append(child);
      dispatchClick(child); dispatchClick(button); await flushAsync();
      assert.equal(requests.length, 1);
      code.value = "EFGH2345"; code.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      dispatchSubmit(form);
      assert.equal(page.navigations.length, 0);
      assert.equal(code.value, "ABCD2345");
      assert(release); release(); await flushAsync();
      assert.equal(button.textContent, "Retry invite");
      assert.equal(page.document.getElementById("organiser-invite-league-link")?.hidden, true);
      dispatchClick(button); await flushAsync();
      assert.equal(button.textContent, "Retry invite", "later business409 does not erase earlier uncertainty");
      dispatchClick(button); await flushAsync();
      assert.equal(requests.length, 3);
      assert.deepEqual(requests, Array(3).fill({ path: "/v1/invites/ABCD2345/accept", body: "{}" }));
      const link = page.document.getElementById("organiser-invite-league-link");
      assert(link instanceof page.window.HTMLAnchorElement);
      assert.equal(link.hidden, false);
      assert.equal(link.getAttribute("href"), "/leagues/three-sided-football-club");
      assert.equal(page.document.activeElement, link);
      assert.equal(apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "invitee@example.com")), "admin");
      dispatchClick(button); await flushAsync();
      assert.equal(requests.length, 3);
    } finally { page.dom.window.close(); }
  });
}

for (const code of ["", "bad", "JOIN0001"]) {
  test("results entry malformed join code cannot start a registration: " + (code || "missing"), async () => {
    const apiState = createMockApiState();
    let writes = 0;
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", ""), url: "http://localhost:3000/join?code=" + code,
      scriptFile: "setup-flow.js", apiState,
      fetch: async (_input, init) => { if (init?.method === "POST") writes += 1; return createJsonResponse(401, {}); },
    });
    try {
      const controls = joinEntryControls(page);
      assert.equal(controls.form.hidden, true);
      controls.nickname.value = "No registration"; dispatchSubmit(controls.form); await flushAsync();
      assert.equal(writes, 0);
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /missing or invalid/);
    } finally { page.dom.window.close(); }
  });
}

test("results entry malformed invite reveals a focusable native correction form", async () => {
  const apiState = createMockApiState(); seedEntryInvite(apiState);
  const page = await bootPage({
    html: renderInvitePage("http://localhost:3001", "bad"), url: "http://localhost:3000/invites?code=bad",
    scriptFile: "setup-flow.js", apiState,
  });
  try {
    const form = page.document.getElementById("organiser-invite-code-form");
    const code = page.document.getElementById("organiser-invite-code-input");
    assert(form instanceof page.window.HTMLFormElement && code instanceof page.window.HTMLInputElement);
    assert.equal(form.hidden, false); assert.equal(page.document.activeElement, code);
    assert.equal(code.getAttribute("aria-invalid"), "true");
    for (let ancestor: HTMLElement | null = code; ancestor; ancestor = ancestor.parentElement) {
      assert.equal(ancestor.hidden, false);
      assert.notEqual(page.window.getComputedStyle(ancestor).display, "none");
    }
    code.value = "abcd 2345"; code.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    dispatchSubmit(form);
    assert.deepEqual(page.navigations, [{ url: "/invites?code=ABCD2345", mode: "assign" }]);
  } finally { page.dom.window.close(); }
});

for (const normalizer of ["missing", "throwing"] as const) {
  test("results entry confirmed sign out fails closed when return validator is " + normalizer, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    const page = await bootPage({
      html: renderInvitePage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/invites?code=ABCD2345",
      scriptFile: "setup-flow.js", apiState,
    });
    try {
      Object.defineProperty(page.window, "__THREEFC_NORMALIZE_RETURN_TO__", { configurable: true,
        value: normalizer === "missing" ? undefined : () => { throw new Error("validator unavailable"); },
      });
      const button = page.document.getElementById("sign-out");
      assert(button instanceof page.window.HTMLButtonElement);
      dispatchClick(button); await flushAsync();
      assert.equal(apiState.session, null);
      assert.deepEqual(page.navigations, [{ url: "/sign-in", mode: "replace" }]);
      assert.doesNotMatch(page.document.getElementById("sign-out-status")?.textContent ?? "", /could not be confirmed/);
    } finally { page.dom.window.close(); }
  });
}

for (const malformed of ["wrong-player", "not-claimed"] as const) {
  test("results entry proofless legacy link cannot reach a claim response: " + malformed, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    const base = createMockFetch(apiState);
    let claims = 0;
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join?code=ABCD2345&playerId=player-ari",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => {
        if (!String(input).endsWith("/claim")) return base(input, init);
        claims += 1;
        if (claims > 1) return base(input, init);
        return createJsonResponse(200, { player: { playerId: malformed === "wrong-player" ? "other-player" : "player-ari", nickname: "Wrong response" }, claim: { claimedByCurrentUser: malformed !== "not-claimed" } });
      },
    });
    try {
      const controls = joinEntryControls(page);
      assert.equal(claims, 0); assert.equal(page.document.getElementById("join-result")?.hidden, false);
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "Ari");
      dispatchClick(controls.claim); await flushAsync();
      assert.equal(page.document.getElementById("join-result")?.hidden, false, "known display identity is not a claim of ownership");
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "Ari");
      assert.match(page.document.getElementById("join-claim-status")?.textContent ?? "", /Ask the organiser for a private link/);
      assert.equal(controls.claim.disabled, true);
      dispatchClick(controls.claim); await flushAsync();
      assert.equal(claims, 0);
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "Ari");
      assert.equal(apiState.players.get("player-ari")?.claimedByUserId, null);
      assert.equal(apiState.lastPublicJoinRequest, null);
    } finally { page.dom.window.close(); }
  });
}

test("results entry readonly report is independent of the scoring form", async () => {
  const apiState = createMockApiState();
  const game = seedResultsEntry(apiState);
  seedLiveGoalEvent(apiState, game.gameId, "readonly-goal");
  refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
  const html = renderGamePage("http://localhost:3001", { gameId: game.gameId }).replace(/<form\b[^>]*id="goal-form"[\s\S]*?<\/form>/, "");
  assert.equal(html.includes('id="goal-form"'), false, "fixture must actually omit controls rather than only hiding them");
  const page = await bootPage({ html, url: "http://localhost:3000/games/" + game.gameId, scriptFile: "setup-flow.js", apiState });
  try {
    assert.equal(page.document.querySelector('[data-testid="game-result-outcome"]')?.textContent, "Red win");
    assert.equal(page.document.querySelectorAll('[data-testid="final-full-goal-log"] [data-ui="final-goal-item"]').length, 1);
    assert.equal(page.document.getElementById("setup-error")?.hidden, true);
  } finally { page.dom.window.close(); }
});

test("results entry first definitive join rejection preserves editable name with a new request key", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "rejected-join" });
  apiState.games.get("rejected-join")!.joinCode = "ABCD2345";
  apiState.session = null; apiState.cookieJar = "";
  const base = createMockFetch(apiState);
  const keys: Array<string | null> = [];
  const page = await bootPage({
    html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join?code=ABCD2345",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (String(input).includes("/v1/join/")) {
        keys.push(readInitHeader(init, "idempotency-key"));
        if (keys.length <= 24) return createJsonResponse(404, { error: "not_found" });
      }
      return base(input, init);
    },
  });
  try {
    const controls = joinEntryControls(page);
    controls.nickname.value = "Retained name"; dispatchSubmit(controls.form); await flushAsync();
    assert.equal(controls.nickname.value, "Retained name");
    assert.equal(controls.nickname.disabled, false); assert.equal(controls.button.textContent, "Join game");
    assert.deepEqual(JSON.parse(page.window.sessionStorage.getItem("threefc.player-proof.v1") ?? "[]"), []);
    for (let repeat = 1; repeat < 24; repeat++) {
      dispatchSubmit(controls.form); await flushAsync();
      assert.equal(controls.nickname.disabled, false);
      assert.deepEqual(JSON.parse(page.window.sessionStorage.getItem("threefc.player-proof.v1") ?? "[]"), []);
    }
    dispatchSubmit(controls.form); await flushAsync();
    assert.equal(keys.length, 25); assert(keys.every(Boolean)); assert.equal(new Set(keys).size, 25);
    assert.equal(page.document.getElementById("join-result-player")?.textContent, "Retained name");
  } finally { page.dom.window.close(); }
});

for (const condition of ["cleanup-failure", "capacity"] as const) {
  test(`public join draft recovery preserves private records: ${condition}`, async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "draft-join" });
    apiState.games.get("draft-join")!.joinCode = "ABCD2345";
    apiState.session = null; apiState.cookieJar = "";
    const base = createMockFetch(apiState);
    const requests: Array<{ key: string | null; body: string }> = [];
    let blockCleanup = condition === "cleanup-failure";
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join?code=ABCD2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        if (String(input).includes("/v1/join/")) {
          requests.push({ key: readInitHeader(init, "idempotency-key"), body: String(init.body) });
          if (requests.length === 1) return createJsonResponse(404, { error: "not_found" });
        }
        return base(input, init);
      },
    });
    try {
      const originalSet = page.window.Storage.prototype.setItem;
      Object.defineProperty(page.window.Storage.prototype, "setItem", { configurable: true,
        value: function(this: Storage, key: string, value: string) {
          if (blockCleanup && key === "threefc.player-proof.v1" && value === "[]") throw new Error("cleanup blocked");
          return originalSet.call(this, key, value);
        },
      });
      if (condition === "capacity") await page.window.eval('(async()=>{for(let i=0;i<20;i++) await ThreeFcPlayerProof.create("capacity-"+i);})()');
      const before = page.window.sessionStorage.getItem("threefc.player-proof.v1");
      const controls = joinEntryControls(page);
      controls.nickname.value = "Retained player"; dispatchSubmit(controls.form); await flushAsync();
      if (condition === "capacity") {
        assert.equal(requests.length, 0);
        assert.equal(page.window.sessionStorage.getItem("threefc.player-proof.v1"), before);
        assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /too many private links.*fresh tab.*address bar/);
        assert.equal(controls.nickname.disabled, false);
      } else {
        assert.equal(requests.length, 1);
        assert.equal(controls.nickname.disabled, true);
        assert.equal(JSON.parse(page.window.sessionStorage.getItem("threefc.player-proof.v1") ?? "[]").length, 1);
        assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /couldn’t clear.*same player name/);
        blockCleanup = false;
        dispatchSubmit(controls.form); await flushAsync();
        assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
        assert.equal(page.document.getElementById("join-result-player")?.textContent, "Retained player");
      }
    } finally { page.dom.window.close(); }
  });
}

for (const outcome of ["missing", "used", "wrong-account"] as const) {
  test("results entry invite contract rejection provides actionable recovery: " + outcome, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    if (outcome === "missing") apiState.leagueInvites.clear();
    if (outcome === "used") Object.assign(apiState.leagueInvites.get("ABCD2345")!, { acceptedByUserId: "someone-else@example.com", acceptedAt: "2026-03-28T11:01:00.000Z" });
    if (outcome === "wrong-account") apiState.leagueInvites.get("ABCD2345")!.email = "someone-else@example.com";
    const page = await bootPage({
      html: renderInvitePage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/invites?code=ABCD2345",
      scriptFile: "setup-flow.js", apiState,
    });
    try {
      const button = page.document.querySelector('[data-action="accept-organiser-invite"]');
      assert(button instanceof page.window.HTMLButtonElement);
      button.focus(); dispatchClick(button); await flushAsync();
      const error = page.document.getElementById("setup-error");
      assert.match(error?.textContent ?? "", outcome === "missing" ? /could not be found/ : outcome === "used" ? /already been used/ : /different email address\. Sign out/);
      assert.doesNotMatch(error?.textContent ?? "", /expired/i, "organiser invite contract has no expiry");
      assert.equal(page.document.getElementById("organiser-invite-league-link")?.hidden, true);
      assert.equal(page.document.getElementById("setup-status")?.hidden, true);
      assert.equal(apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "invitee@example.com")), "viewer");
      if (outcome !== "wrong-account") {
        assert.equal(page.document.getElementById("organiser-invite-code-form")?.hidden, false);
        assert.equal(page.document.activeElement?.id, "organiser-invite-code-input");
      }
    } finally { page.dom.window.close(); }
  });
}

// Explicit claim confirmation focus/race coverage lives in player-proof.test.ts.
for (const operation of ["join"] as readonly string[]) {
  for (const ownership of ["retained", "outside", "navigation"] as const) {
    test(`results entry ${operation} settles focus only while ownership is ${ownership}`, async () => {
      const apiState = createMockApiState(); seedEntryInvite(apiState);
      apiState.games.get("invite-entry")!.joinCode = "ABCD2345";
      if (operation === "join") { apiState.session = null; apiState.cookieJar = ""; }
      const base = createMockFetch(apiState);
      let release: (() => void) | undefined;
      let requests = 0;
      const page = await bootPage({
        html: renderJoinPage("http://localhost:3001", "ABCD2345"),
        url: "http://localhost:3000/join?code=ABCD2345" + (operation === "claim" ? "&playerId=player-ari" : ""),
        scriptFile: "setup-flow.js", apiState,
        fetch: async (input, init = {}) => {
          if (String(input).includes(operation === "join" ? "/v1/join/" : "/claim")) {
            requests += 1;
            return new Promise<Response>((resolve) => { release = () => { void base(input, init).then(resolve); }; });
          }
          return base(input, init);
        },
      });
      try {
        const controls = joinEntryControls(page);
        if (operation === "join") { controls.nickname.value = "Focus player"; controls.nickname.focus(); dispatchSubmit(controls.form); }
        else { controls.claim.focus(); dispatchClick(controls.claim); }
        await flushAsync();
        assert.equal(requests, 1);
        const outside = page.document.createElement("button"); outside.textContent = "Other task"; page.document.body.append(outside);
        if (ownership === "outside") outside.focus();
        if (ownership === "navigation") {
          page.window.history.pushState(null, "", "#away"); page.window.dispatchEvent(new page.window.PopStateEvent("popstate"));
          page.window.history.replaceState(null, "", page.window.location.pathname + page.window.location.search);
          page.window.dispatchEvent(new page.window.PopStateEvent("popstate"));
        }
        const previousFocus = page.document.activeElement;
        assert(release); release(); await flushAsync();
        assert.equal(page.document.activeElement, ownership === "navigation" ? previousFocus : ownership === "outside" ? outside
          : operation === "join" ? page.document.getElementById("join-signin-link") : controls.another);
        assert.equal(page.document.getElementById("setup-error")?.hidden, true);
      } finally { page.dom.window.close(); }
    });
  }
}

for (const staleStatus of [401, 503]) {
  test("results entry blocks creation until the initial session probe is known: " + staleStatus, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    apiState.games.get("invite-entry")!.joinCode = "ABCD2345";
    const base = createMockFetch(apiState);
    let reads = 0;
    let release: (() => void) | undefined;
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join?code=ABCD2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => {
        if (String(input).endsWith("/auth/session") && ++reads === 1) {
          return new Promise<Response>((resolve) => { release = () => resolve(createJsonResponse(staleStatus, {})); });
        }
        return base(input, init);
      },
    });
    try {
      const controls = joinEntryControls(page);
      controls.nickname.value = "Later account"; dispatchSubmit(controls.form); await flushAsync();
      assert.equal(controls.form.hidden, true);
      assert.equal(apiState.lastPublicJoinRequest, null, "an unresolved session cannot bypass discovery by submitting the hidden form");
      assert.equal(page.document.getElementById("account-actions")?.hidden, true);
      assert.equal(reads, 1);
      assert(release); release(); await flushAsync();
      if (staleStatus === 401) {
        assert.equal(controls.form.hidden, false, "a confirmed visitor can explicitly enter a new player");
        assert.equal(page.document.getElementById("account-actions")?.hidden, true);
      } else {
        assert.equal(controls.form.hidden, true, "an unavailable session is not an anonymous result");
        const retry = [...page.document.querySelectorAll("#returning-player button")].find(button => button.textContent === "Retry");
        assert(retry instanceof page.window.HTMLButtonElement); dispatchClick(retry); await flushAsync();
        assert.equal(reads, 2);
        await chooseNewJoinPlayer(page);
        assert.equal(page.document.getElementById("account-actions")?.hidden, false);
      }
      assert.equal(apiState.lastPublicJoinRequest, null, "session resolution and explicit creation disclosure never register automatically");
    } finally { page.dom.window.close(); }
  });
}

test("results entry preserves an opaque league ID as one encoded application route component", async () => {
  const apiState = createMockApiState(); seedEntryInvite(apiState);
  const leagueId = "../auth/callback";
  apiState.leagues.set(leagueId, { ...apiState.leagues.get("three-sided-football-club")!, leagueId });
  apiState.leagueInvites.get("ABCD2345")!.leagueId = leagueId;
  const page = await bootPage({
    html: renderInvitePage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/invites?code=ABCD2345",
    scriptFile: "setup-flow.js", apiState,
  });
  try {
    const button = page.document.querySelector('[data-action="accept-organiser-invite"]');
    assert(button instanceof page.window.HTMLButtonElement);
    dispatchClick(button); await flushAsync();
    const link = page.document.getElementById("organiser-invite-league-link");
    assert(link instanceof page.window.HTMLAnchorElement);
    assert.equal(link.hidden, false);
    assert.equal(link.getAttribute("href"), "/leagues/..%2Fauth%2Fcallback");
    const target = new URL(link.href);
    assert.equal(target.origin, "http://localhost:3000");
    assert.equal(decodeURIComponent(target.pathname.split("/")[2]), leagueId);
    assert.notEqual(target.pathname, "/auth/callback");
    assert.equal(page.document.getElementById("setup-error")?.hidden, true);
  } finally { page.dom.window.close(); }
});

for (const item of [
  { name: "backslash", id: "league\\winter" },
  { name: "long", id: "league-" + "x".repeat(600) },
  { name: "reserved characters", id: "league/?#%winter" },
  { name: "surrounding spaces", id: " legacy league " },
]) {
  test("results entry invite identity accepts contract-valid " + item.name, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    apiState.leagues.set(item.id, { ...apiState.leagues.get("three-sided-football-club")!, leagueId: item.id });
    apiState.leagueInvites.get("ABCD2345")!.leagueId = item.id;
    const base = createMockFetch(apiState);
    let accepts = 0;
    const page = await bootPage({
      html: renderInvitePage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/invites?code=ABCD2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => { if (String(input).endsWith("/accept")) accepts += 1; return base(input, init); },
    });
    try {
      const normalizer = (page.window as unknown as { __THREEFC_NORMALIZE_RETURN_TO__: (path: string) => string | null }).__THREEFC_NORMALIZE_RETURN_TO__;
      if (item.name === "backslash") assert.equal(normalizer("/leagues/" + encodeURIComponent(item.id)), null, "authentication return policy must stay strict");
      Object.defineProperty(page.window, "__THREEFC_NORMALIZE_RETURN_TO__", { configurable: true, value: () => { throw new Error("ordinary links must not use auth return validation"); } });
      const button = page.document.querySelector('[data-action="accept-organiser-invite"]');
      assert(button instanceof page.window.HTMLButtonElement);
      button.focus(); dispatchClick(button); await flushAsync();
      const link = page.document.getElementById("organiser-invite-league-link");
      assert(link instanceof page.window.HTMLAnchorElement);
      assert.equal(link.hidden, false);
      assert.equal(link.textContent, "Open league");
      assert.equal(link.getAttribute("href"), "/leagues/" + encodeURIComponent(item.id));
      const target = new URL(link.href);
      assert.equal(target.origin, "http://localhost:3000");
      assert.equal(decodeURIComponent(target.pathname.slice("/leagues/".length)), item.id);
      assert.equal(target.search, ""); assert.equal(target.hash, "");
      assert.equal(page.document.getElementById("setup-status")?.textContent, "Organiser invite accepted.");
      assert.equal(page.document.getElementById("setup-error")?.hidden, true);
      assert.equal(apiState.leagueAccess.get(leagueAccessKey(item.id, "invitee@example.com")), "admin");
      assert.equal(button.hidden, true); assert.equal(button.disabled, true);
      assert.equal(page.document.activeElement, link);
      dispatchClick(button); await flushAsync(); assert.equal(accepts, 1);
    } finally { page.dom.window.close(); }
  });
}

for (const item of [
  { name: "dot", id: "." }, { name: "parent dot", id: ".." }, { name: "unpaired Unicode", id: "league-\ud800" },
]) {
  test("results entry invite identity keeps confirmed acceptance when its link is unaddressable: " + item.name, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    apiState.leagues.set(item.id, { ...apiState.leagues.get("three-sided-football-club")!, leagueId: item.id });
    apiState.leagueInvites.get("ABCD2345")!.leagueId = item.id;
    const base = createMockFetch(apiState);
    let accepts = 0;
    const page = await bootPage({
      html: renderInvitePage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/invites?code=ABCD2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init) => { if (String(input).endsWith("/accept")) accepts += 1; return base(input, init); },
    });
    try {
      const button = page.document.querySelector('[data-action="accept-organiser-invite"]');
      assert(button instanceof page.window.HTMLButtonElement);
      button.focus(); dispatchClick(button); await flushAsync();
      const link = page.document.getElementById("organiser-invite-league-link");
      assert(link instanceof page.window.HTMLAnchorElement);
      assert.equal(link.hidden, false); assert.equal(link.textContent, "Go to Home");
      assert.equal(link.getAttribute("href"), "/setup");
      assert.equal(page.document.getElementById("setup-status")?.textContent, "Organiser invite accepted. Go to Home to continue.");
      assert.equal(page.document.getElementById("setup-error")?.hidden, true);
      assert.equal(apiState.leagueAccess.get(leagueAccessKey(item.id, "invitee@example.com")), "admin");
      assert.equal(button.hidden, true); assert.equal(button.disabled, true);
      assert.equal(page.document.activeElement, link);
      dispatchClick(button); await flushAsync(); assert.equal(accepts, 1);
    } finally { page.dom.window.close(); }
  });
}

for (const item of [
  { name: "backslash", suffix: "\\historic" }, { name: "long", suffix: "x".repeat(600) },
]) {
  test("results entry historical identity preserves contract-valid " + item.name, async () => {
    const apiState = createMockApiState();
    const game = seedResultsEntry(apiState, "history-contract", "admin");
    const scorerId = "scorer-" + item.suffix; const assistId = "assist-" + item.suffix;
    const eventId = "goal-" + item.suffix;
    for (const [playerId, nickname] of [[scorerId, "Historical scorer"], [assistId, "Historical assist"]]) {
      apiState.players.set(playerId, { playerId, nickname, claimedByUserId: null, createdAt: game.createdAt, updatedAt: game.updatedAt });
      apiState.gamePlayers.set(game.gameId + ":" + playerId, { gameId: game.gameId, playerId, createdAt: game.createdAt, updatedAt: game.updatedAt });
    }
    seedLiveGoalEvent(apiState, game.gameId, eventId);
    Object.assign(apiState.goalEvents.get(eventId)!, { scorerPlayerId: scorerId, assistPlayerIds: [assistId] });
    refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: game.gameId }), url: "http://localhost:3000/games/" + game.gameId,
      scriptFile: "setup-flow.js", apiState,
    });
    try {
      const rows = [...page.document.querySelectorAll('[data-testid="final-full-goal-log"] [data-ui="final-goal-item"]')];
      assert.equal(rows.length, 1); assert.equal(rows[0].getAttribute("data-event-id"), eventId);
      assert.match(rows[0].textContent ?? "", /Historical scorer/);
      assert.match(rows[0].textContent ?? "", /Assists: Historical assist/);
      assert.match(page.document.querySelector('[data-testid="final-scorer-stats"]')?.textContent ?? "", /Historical scorer\s*1/);
      assert.match(page.document.querySelector('[data-testid="final-assist-stats"]')?.textContent ?? "", /Historical assist\s*1/);
      assert.equal(page.document.querySelector('[data-testid="final-goal-summary-unavailable"]'), null);
    } finally { page.dom.window.close(); }
  });
}

for (const item of [
  { name: "backslash", playerId: "player\\joined" }, { name: "long", playerId: "player-" + "x".repeat(600) },
]) {
  test("results entry keeps contract-valid identity without proofless claiming: " + item.name, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    apiState.games.get("invite-entry")!.joinCode = "ABCD2345";
    const base = createMockFetch(apiState);
    let joins = 0; const claimPaths: string[] = [];
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join?code=ABCD2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/join/ABCD2345") {
          joins += 1;
          const player = { playerId: item.playerId, nickname: "Joined scorer", claimedByUserId: null, createdAt: "2026-03-28T11:00:00.000Z", updatedAt: "2026-03-28T11:00:00.000Z" };
          apiState.players.set(player.playerId, player);
          apiState.gamePlayers.set("invite-entry:" + player.playerId, { gameId: "invite-entry", playerId: player.playerId, createdAt: player.createdAt, updatedAt: player.updatedAt });
          return createJsonResponse(201, { gameId: "invite-entry", joinCode: "ABCD2345", player });
        }
        if (path.endsWith("/claim")) claimPaths.push(path);
        return base(input, init);
      },
    });
    try {
      const controls = joinEntryControls(page);
      await chooseNewJoinPlayer(page);
      controls.nickname.value = "Joined scorer"; dispatchSubmit(controls.form); await flushAsync();
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "Joined scorer");
      assert.equal(page.document.getElementById("setup-status")?.textContent, "Joined game.");
      assert.equal(page.document.getElementById("setup-error")?.hidden, true);
      assert.equal(joins, 1);
      assert.deepEqual(claimPaths, []);
      assert.equal(apiState.players.get(item.playerId)?.claimedByUserId, null);
      assert.equal(controls.form.hidden, true); assert.equal(controls.claim.hidden, true);
      dispatchSubmit(controls.form); dispatchClick(controls.claim); await flushAsync();
      assert.equal(joins, 1); assert.equal(claimPaths.length, 0);
    } finally { page.dom.window.close(); }
  });
}

for (const item of [
  { name: "dot", id: "." }, { name: "parent dot", id: ".." }, { name: "unpaired Unicode", id: "goal-\ud800" },
  { name: "NUL attribute normalization", id: "goal-\u0000legacy" }, { name: "CR attribute normalization", id: "goal-\rlegacy" },
]) {
  test("results entry unaddressable event identity cannot redirect a mutation: " + item.name, async () => {
    const apiState = createMockApiState();
    const game = seedResultsEntry(apiState, "safe-event-target", "admin");
    seedLiveGoalEvent(apiState, game.gameId, item.id);
    refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
    const base = createMockFetch(apiState);
    const writes: Array<{ path: string; method: string; body: string }> = [];
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: game.gameId }), url: "http://localhost:3000/games/" + game.gameId,
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        if (init.method && init.method !== "GET") writes.push({ path: new URL(String(input)).pathname, method: init.method, body: String(init.body) });
        return base(input, init);
      },
    });
    try {
      assert.equal(page.document.querySelectorAll('[data-testid="final-full-goal-log"] [data-ui="final-goal-item"]').length, 1);
      assert.match(page.document.querySelector('[data-testid="final-scorer-stats"]')?.textContent ?? "", /Ari\s*1/);
      enterFinishedCorrections(page);
      Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
      const edit = page.document.querySelector('[data-action="edit-goal"]');
      const remove = page.document.querySelector('[data-action="delete-goal"]');
      assert(edit instanceof page.window.HTMLButtonElement && remove instanceof page.window.HTMLButtonElement);
      for (const control of [edit, remove]) {
        assert.equal(control.disabled, true);
        assert.equal(control.getAttribute("data-event-id"), "", "unavailable controls cannot contain another normalized record’s actionable ID");
        assert.match(page.document.getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent ?? "", /Editing isn’t available/);
        control.disabled = false;
        dispatchClick(control);
      }
      await flushAsync();
      assert.equal(writes.length, 0, "synthetic enabling cannot send DELETE/PATCH to a normalized collection or game path");
      assert.equal(apiState.games.has(game.gameId), true);
      assert.equal(apiState.goalEvents.has(item.id), true);
      const controls = liveGoalControls(page);
      assert.equal(controls.cancel.hidden, true, "an unaddressable event cannot become an editable draft");
      assert.equal(controls.undo.disabled, false, "expectedEventId remains valid JSON even without an individual event URL");
      dispatchClick(controls.undo); await flushAsync();
      assert.equal(writes.length, 1);
      assert.equal(writes[0].path, "/v1/games/safe-event-target/goals/undo-last");
      assert.equal(writes[0].method, "POST");
      assert.deepEqual(JSON.parse(writes[0].body), { expectedEventId: item.id });
      assert.equal(apiState.goalEvents.has(item.id), false);
      assert.equal(apiState.games.has(game.gameId), true);
    } finally { page.dom.window.close(); }
  });
}

for (const item of [
  { name: "dot", id: "." }, { name: "parent dot", id: ".." }, { name: "unpaired Unicode", id: "player-\ud800" },
]) {
  test("results entry unaddressable claim identity preserves confirmed registration: " + item.name, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    const base = createMockFetch(apiState);
    const writes: string[] = [];
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", "ABCD2345"), url: "http://localhost:3000/join?code=ABCD2345",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (init.method === "POST") writes.push(path);
        if (path === "/v1/join/ABCD2345") {
          const player = { playerId: item.id, nickname: "Registered player", claimedByUserId: null, createdAt: "2026-03-28T11:00:00.000Z", updatedAt: "2026-03-28T11:00:00.000Z" };
          apiState.players.set(player.playerId, player);
          apiState.gamePlayers.set("invite-entry:" + player.playerId, { gameId: "invite-entry", playerId: player.playerId, createdAt: player.createdAt, updatedAt: player.updatedAt });
          return createJsonResponse(201, { gameId: "invite-entry", joinCode: "ABCD2345", player });
        }
        return base(input, init);
      },
    });
    try {
      const controls = joinEntryControls(page);
      await chooseNewJoinPlayer(page);
      controls.nickname.value = "Registered player"; controls.nickname.focus(); dispatchSubmit(controls.form); await flushAsync();
      assert.deepEqual(writes, ["/v1/join/ABCD2345"], "never send a claim POST to a different normalized endpoint");
      assert.equal(apiState.gamePlayers.has("invite-entry:" + item.id), true);
      assert.equal(page.document.getElementById("join-result")?.hidden, false);
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "Registered player");
      assert.match(page.document.getElementById("join-claim-status")?.textContent ?? "", /Ask the organiser for a private link/);
      assert.doesNotMatch(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed/);
      assert.equal(controls.claim.disabled, true); assert.equal(controls.claim.hidden, true);
      assert.equal(controls.another.disabled, false); assert.equal(controls.another.hidden, false);
      assert.equal(page.document.activeElement, controls.another);
      controls.claim.disabled = false; dispatchClick(controls.claim); await flushAsync();
      assert.deepEqual(writes, ["/v1/join/ABCD2345"]);
      dispatchClick(controls.another);
      assert.equal(controls.form.hidden, false); assert.equal(controls.nickname.disabled, false);
      assert.equal(controls.nickname.value, ""); assert.equal(page.document.activeElement, controls.nickname);
    } finally { page.dom.window.close(); }
  });
}

for (const item of [
  { name: "CR and LF", original: "\r", normalized: "\n" },
  { name: "NUL and replacement character", original: "\u0000", normalized: "\ufffd" },
]) {
  test("results entry correction identity distinguishes " + item.name + " collisions", async () => {
    const apiState = createMockApiState();
    const game = seedResultsEntry(apiState, "correction-identity", "admin");
    const scorerId = "scorer-" + item.original + "legacy";
    const assistId = "assist-" + item.original + "legacy";
    const otherScorerId = "scorer-" + item.normalized + "legacy";
    const otherAssistId = "assist-" + item.normalized + "legacy";
    for (const [playerId, nickname] of [
      [scorerId, "Original scorer"], [otherScorerId, "Different scorer"],
      [assistId, "Original assist"], [otherAssistId, "Different assist"],
    ]) {
      apiState.players.set(playerId, { playerId, nickname, claimedByUserId: null, createdAt: game.createdAt, updatedAt: game.updatedAt });
      apiState.gamePlayers.set(game.gameId + ":" + playerId, { gameId: game.gameId, playerId, createdAt: game.createdAt, updatedAt: game.updatedAt });
      apiState.roster.set(game.gameId + ":" + playerId, { gameId: game.gameId, playerId, teamId: "red", createdAt: game.createdAt, updatedAt: game.updatedAt });
    }
    seedLiveGoalEvent(apiState, game.gameId, "addressable-event");
    Object.assign(apiState.goalEvents.get("addressable-event")!, { scorerPlayerId: scorerId, assistPlayerIds: [assistId] });
    refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
    const base = createMockFetch(apiState);
    const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: game.gameId }), url: "http://localhost:3000/games/" + game.gameId,
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        if (init.method === "PATCH") patches.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return base(input, init);
      },
    });
    try {
      assert.match(page.document.querySelector('[data-testid="final-full-goal-log"]')?.textContent ?? "", /Original scorer/);
      enterFinishedCorrections(page);
      const edit = page.document.querySelector('[data-action="edit-goal"]');
      assert(edit instanceof page.window.HTMLButtonElement); assert.equal(edit.disabled, false);
      dispatchClick(edit);
      const controls = liveGoalControls(page);
      const originalScorer = [...controls.scorer.options].find((option) => option.textContent === "Original scorer");
      const differentScorer = [...controls.scorer.options].find((option) => option.textContent === "Different scorer");
      assert(originalScorer && differentScorer);
      assert.equal(originalScorer.value, scorerId, "the visible scorer option must retain its exact opaque identity");
      assert.equal(differentScorer.value, otherScorerId);
      assert.equal(controls.scorer.value, scorerId, "editing must retain the recorded scorer, not a normalized collision");
      controls.scorer.selectedIndex = originalScorer.index;
      controls.scorer.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      const assists = [...page.document.querySelectorAll<HTMLInputElement>('#goal-assists input[type="checkbox"]')];
      const originalAssist = assists.find((input) => input.closest("label")?.textContent?.includes("Original assist"));
      const differentAssist = assists.find((input) => input.closest("label")?.textContent?.includes("Different assist"));
      assert(originalAssist && differentAssist);
      assert.equal(originalAssist.value, assistId);
      assert.equal(differentAssist.value, otherAssistId);
      assert.equal(originalAssist.checked, true); assert.equal(differentAssist.checked, false);
      dispatchSubmit(controls.form); await flushAsync();
      assert.equal(patches.length, 1);
      assert.equal(patches[0].path, "/v1/games/correction-identity/goals/addressable-event");
      assert.equal(patches[0].body.scorerPlayerId, scorerId, "correction JSON must not substitute the colliding rostered scorer");
      assert.deepEqual(patches[0].body.assistPlayerIds, [assistId], "correction JSON must not substitute the colliding rostered assister");
      assert.equal(apiState.goalEvents.get("addressable-event")?.scorerPlayerId, scorerId);
      assert.deepEqual(apiState.goalEvents.get("addressable-event")?.assistPlayerIds, [assistId]);
      assert.equal(controls.cancel.hidden, true);
      assert.equal(page.document.getElementById("setup-error")?.hidden, true);
    } finally { page.dom.window.close(); }
  });
}

function qaGameNavigation(page: Awaited<ReturnType<typeof bootPage>>) {
  const overview = page.document.getElementById("game-mode-tab-structure");
  const teams = page.document.getElementById("game-mode-tab-players");
  const score = page.document.getElementById("game-mode-tab-run");
  const results = page.document.getElementById("game-mode-tab-final");
  const exit = page.document.querySelector('[data-action="exit-result-correction"]');
  assert(overview instanceof page.window.HTMLAnchorElement && teams instanceof page.window.HTMLAnchorElement);
  assert(score instanceof page.window.HTMLAnchorElement && results instanceof page.window.HTMLAnchorElement);
  assert(exit instanceof page.window.HTMLButtonElement);
  return { overview, teams, score, results, exit };
}

test("qa navigation exits finished correction without a write or revoking independent team editing", async () => {
  const apiState = createMockApiState();
  const game = seedResultsEntry(apiState, "exit-correction", "admin");
  seedLiveGoalEvent(apiState, game.gameId, "unchanged-goal");
  refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
  const before = JSON.stringify({ game: apiState.games.get(game.gameId), goals: [...apiState.goalEvents.values()], roster: [...apiState.roster.values()] });
  const base = createMockFetch(apiState);
  let writes = 0;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: game.gameId }), url: `http://localhost:3000/games/${game.gameId}`,
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => { if (init.method && init.method !== "GET") writes += 1; return base(input, init); },
  });
  try {
    const nav = qaGameNavigation(page);
    assert.equal(interactionVisible(nav.score), false);
    enterFinishedCorrections(page, true);
    enterFinishedCorrections(page);
    assert.equal(nav.score.textContent?.trim(), "Correction");
    assert.equal(interactionVisible(nav.score), true);
    assert.equal(nav.score.getAttribute("aria-current"), "page");
    assert.equal(page.document.querySelectorAll('[data-action="select-game-mode"][data-game-mode="run"]').length, 1);
    assert.equal([...page.document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Back to game"), false);
    const controls = liveGoalControls(page); controls.draft();
    const assist = page.document.querySelector('#goal-assists input[value="player-bea"]');
    assert(assist instanceof page.window.HTMLInputElement); assist.checked = true;
    assist.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    nav.exit.focus(); dispatchClick(nav.exit);
    assert.equal(page.window.location.hash, "#results");
    assert.equal(page.document.activeElement, page.document.getElementById("game-mode-final"));
    assert.equal(interactionVisible(nav.score), false);
    assert.equal(controls.save.disabled, true); assert.equal(controls.undo.disabled, true);
    assert.equal(goalTeamValue(controls.scoring), ""); assert.equal(controls.scorer.value, "");
    assert.equal(page.document.querySelectorAll('#goal-assists input:checked').length, 0);
    const correct = page.document.querySelector('[data-action="correct-finished-result"]');
    assert(correct instanceof page.window.HTMLButtonElement); assert.equal(interactionVisible(correct), true);
    for (const legacyHash of ["#score", "#mode-run"]) {
      page.window.history.pushState(null, "", legacyHash);
      page.window.dispatchEvent(new page.window.PopStateEvent("popstate"));
      assert.equal(page.window.location.hash, "#results", "history must not re-arm a disarmed correction");
      assert.equal(controls.save.disabled, true);
    }
    dispatchClick(nav.teams);
    assert.equal(page.document.querySelectorAll('[data-action="toggle-transfer"]').length, 3, "exiting result correction does not revoke separately requested roster editing");
    dispatchClick(nav.results); dispatchClick(correct);
    assert.equal(page.window.location.hash, "#score");
    assert.equal(goalTeamValue(controls.scoring), ""); assert.equal(controls.scorer.value, "");
    controls.draft();
    assert.equal(controls.save.disabled, false, "only explicit correction entry re-arms scoring");
    assert.equal(writes, 0);
    assert.equal(JSON.stringify({ game: apiState.games.get(game.gameId), goals: [...apiState.goalEvents.values()], roster: [...apiState.roster.values()] }), before);
  } finally { page.dom.window.close(); }
});

test("qa navigation cannot exit a pending or uncertain correction and preserves its exact retry", async () => {
  const apiState = createMockApiState();
  const game = seedResultsEntry(apiState, "exit-unresolved", "admin");
  seedLiveGoalEvent(apiState, game.gameId, "original-goal");
  refreshMockFinishedResult(apiState, game, "2026-03-28T11:02:00.000Z");
  const base = createMockFetch(apiState);
  let release: (() => void) | undefined;
  let replay: unknown;
  const requests: Array<{ path: string; body: string; key: string | null }> = [];
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: game.gameId }), url: `http://localhost:3000/games/${game.gameId}`,
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (init.method === "PATCH") {
        requests.push({ path: new URL(String(input)).pathname, body: String(init.body), key: readInitHeader(init, "idempotency-key") });
        if (requests.length === 1) {
          const response = await base(input, init); assert.equal(response.ok, true); replay = await response.json();
          return new Promise<Response>((resolve) => { release = () => resolve(createJsonResponse(503, { error: "unavailable" })); });
        }
        return createJsonResponse(200, replay);
      }
      return base(input, init);
    },
  });
  try {
    enterFinishedCorrections(page);
    const nav = qaGameNavigation(page); const controls = liveGoalControls(page);
    const edit = page.document.querySelector('[data-action="edit-goal"]');
    assert(edit instanceof page.window.HTMLButtonElement); dispatchClick(edit);
    controls.scorer.value = "player-bea"; controls.scorer.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    dispatchSubmit(controls.form); await flushAsync();
    assert.equal(requests.length, 1); assert.equal(nav.exit.disabled, true);
    const reason = page.document.getElementById(nav.exit.getAttribute("aria-describedby") ?? "");
    assert(reason instanceof page.window.HTMLElement); assert.equal(interactionVisible(reason), true);
    assert.ok(reason.textContent?.trim());
    nav.exit.disabled = false; dispatchClick(nav.exit);
    assert.equal(page.window.location.hash, "#score", "the handler guards synthetic activation while pending");
    assert(release); release(); await flushAsync();
    assert.equal(nav.exit.disabled, true); assert.equal(controls.retry.disabled, false);
    nav.exit.disabled = false; dispatchClick(nav.exit);
    assert.equal(page.window.location.hash, "#score");
    assert.equal(controls.retry.hidden, false); assert.equal(controls.retry.disabled, false);
    dispatchClick(nav.results);
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Could not confirm/);
    dispatchClick(nav.score);
    assert.equal(controls.scorer.value, "player-bea");
    dispatchClick(controls.retry); await flushAsync();
    assert.equal(requests.length, 2); assert.ok(requests[0].key); assert.deepEqual(requests[1], requests[0]);
    assert.equal(apiState.goalEvents.get("original-goal")?.scorerPlayerId, "player-bea");
    assert.equal(nav.exit.disabled, false); nav.exit.focus(); dispatchClick(nav.exit);
    assert.equal(page.window.location.hash, "#results");
    assert.equal(requests.length, 2);
  } finally { page.dom.window.close(); }
});

test("qa navigation permits exiting a definitively rejected correction without resubmission", async () => {
  const apiState = createMockApiState(); seedResultsEntry(apiState, "exit-rejected", "admin");
  const base = createMockFetch(apiState); let writes = 0;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "exit-rejected" }), url: "http://localhost:3000/games/exit-rejected",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (init.method === "POST" && new URL(String(input)).pathname.endsWith("/goals")) { writes += 1; return createJsonResponse(400, { error: "validation_error", message: "Choose a valid scorer." }); }
      return base(input, init);
    },
  });
  try {
    enterFinishedCorrections(page); const nav = qaGameNavigation(page); const controls = liveGoalControls(page);
    controls.draft(); dispatchSubmit(controls.form); await flushAsync();
    assert.equal(writes, 1); assert.equal(nav.exit.disabled, false);
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Choose a valid scorer/);
    dispatchClick(nav.exit); assert.equal(page.window.location.hash, "#results");
    assert.equal(writes, 1); assert.equal(apiState.goalEvents.size, 0);
  } finally { page.dom.window.close(); }
});

for (const role of ["viewer", "scorekeeper"] as const) {
  test("qa navigation correction links and synthetic actions remain locked for finished " + role, async () => {
    const apiState = createMockApiState(); seedResultsEntry(apiState, "exit-role", role);
    const base = createMockFetch(apiState); let writes = 0;
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "exit-role" }), url: "http://localhost:3000/games/exit-role#score",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => { if (init.method && init.method !== "GET") writes += 1; return base(input, init); },
    });
    try {
      const nav = qaGameNavigation(page); const controls = liveGoalControls(page);
      const correct = page.document.querySelector('[data-action="correct-finished-result"]');
      assert(correct instanceof page.window.HTMLButtonElement);
      assert.equal(interactionVisible(nav.score), false); assert.equal(interactionVisible(nav.exit), false);
      assert.equal(interactionVisible(correct), false);
      correct.disabled = false; dispatchClick(correct); nav.exit.disabled = false; dispatchClick(nav.exit); dispatchClick(nav.score);
      dispatchSubmit(controls.form);
      assert.equal(page.window.location.hash, "#results"); assert.equal(controls.save.disabled, true); assert.equal(writes, 0);
    } finally { page.dom.window.close(); }
  });
}

test("qa navigation clears completed roster feedback only when changing destination", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "feedback-complete", role: "admin" });
  const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "feedback-complete" }), url: "http://localhost:3000/games/feedback-complete#teams", scriptFile: "setup-flow.js", apiState });
  try {
    const nav = qaGameNavigation(page);
    const transfer = page.document.querySelector('[data-action="toggle-transfer"][data-player-id="player-ari"]');
    assert(transfer instanceof page.window.HTMLButtonElement); dispatchClick(transfer);
    const choice = page.document.querySelector('#transfer-options-player-ari [data-team-id="blue"]');
    assert(choice instanceof page.window.HTMLButtonElement); dispatchClick(choice); await flushAsync();
    const status = page.document.getElementById("setup-status"); assert(status instanceof page.window.HTMLElement);
    assert.match(status.textContent ?? "", /Ari assigned to Blue/); assert.equal(interactionVisible(status), true);
    dispatchClick(nav.teams); assert.equal(interactionVisible(status), true, "reselecting the current destination retains useful confirmation");
    dispatchClick(nav.score); assert.equal(interactionVisible(status), false);
    assert.doesNotMatch(status.textContent ?? "", /assigned to/);
    dispatchClick(nav.teams); assert.equal(interactionVisible(status), false, "old confirmation is not resurrected on return");
  } finally { page.dom.window.close(); }
});

for (const outcome of ["success", "success-returned", "rejected", "uncertain", "refresh-failed"] as const) {
  test("qa navigation late assignment " + outcome + " retains truthful feedback without stealing the new destination", async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "feedback-late", role: "admin" });
    const base = createMockFetch(apiState); let release: (() => void) | undefined; let committed = false; let writes = 0;
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "feedback-late" }), url: "http://localhost:3000/games/feedback-late#teams",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        if (init.method === "PUT") {
          writes += 1;
          return new Promise<Response>((resolve) => { release = () => { void (async () => {
            if (outcome === "rejected") { resolve(createJsonResponse(403, { error: "forbidden", message: "Assignment is not allowed." })); return; }
            const response = await base(input, init); committed = response.ok;
            resolve(outcome === "uncertain" ? createJsonResponse(503, { error: "unavailable" }) : response);
          })(); }; });
        }
        if (committed && outcome === "refresh-failed" && new URL(String(input)).pathname.endsWith("/roster")) return createJsonResponse(503, { error: "unavailable" });
        return base(input, init);
      },
    });
    try {
      const nav = qaGameNavigation(page);
      const transfer = page.document.querySelector('[data-action="toggle-transfer"][data-player-id="player-ari"]');
      assert(transfer instanceof page.window.HTMLButtonElement); dispatchClick(transfer);
      const choice = page.document.querySelector('#transfer-options-player-ari [data-team-id="blue"]');
      assert(choice instanceof page.window.HTMLButtonElement); choice.focus(); dispatchClick(choice); await flushAsync();
      assert.equal(writes, 1);
      dispatchClick(nav.score);
      const run = page.document.getElementById("game-mode-run"); assert(run instanceof page.window.HTMLElement);
      assert.equal(page.document.activeElement, run);
      if (outcome === "success-returned") dispatchClick(nav.teams);
      const selectedPanel = outcome === "success-returned" ? page.document.getElementById("game-mode-players") : run;
      const status = page.document.getElementById("setup-status"); assert(status instanceof page.window.HTMLElement);
      assert.equal(status.getAttribute("data-activity"), "loading"); assert.equal(interactionVisible(status), true);
      assert(release); release(); await flushAsync();
      assert.equal(page.window.location.hash, outcome === "success-returned" ? "#teams" : "#score");
      assert.equal(page.document.activeElement, selectedPanel); assert.equal(writes, 1);
      const error = page.document.getElementById("setup-error"); assert(error instanceof page.window.HTMLElement);
      if (outcome === "success" || outcome === "success-returned") {
        assert.equal(interactionVisible(status), false); assert.equal(interactionVisible(error), false);
        assert.doesNotMatch(status.textContent ?? "", /assigned to/);
      } else {
        assert.equal(interactionVisible(error), true);
        assert.match(error.textContent ?? "", outcome === "rejected" ? /Assignment is not allowed/
          : outcome === "uncertain" ? /Assignment could not be confirmed/ : /Assignment was saved, but/);
        dispatchClick(nav.overview); assert.equal(interactionVisible(error), true, "navigation does not erase recovery instructions");
      }
    } finally { page.dom.window.close(); }
  });
}

for (const close of ["Cancel", "Escape"] as const) {
  test("qa navigation Add player disclosure remains singular through redraw and " + close, async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "player-disclosure", role: "admin" });
    const page = await bootPage({ html: renderGamePage("http://localhost:3001", { gameId: "player-disclosure" }), url: "http://localhost:3000/games/player-disclosure#teams", scriptFile: "setup-flow.js", apiState });
    try {
      const nav = qaGameNavigation(page);
      const toggle = page.document.querySelector('[data-action="toggle-player-create"]');
      const cancel = page.document.querySelector('[data-action="cancel-player-create"]');
      const input = page.document.getElementById("player-nickname");
      const form = page.document.getElementById("player-create-form");
      assert(toggle instanceof page.window.HTMLButtonElement && cancel instanceof page.window.HTMLButtonElement);
      assert(input instanceof page.window.HTMLInputElement && form instanceof page.window.HTMLFormElement);
      dispatchClick(toggle); assert.equal(interactionVisible(toggle), false);
      assert.equal(page.document.activeElement?.id, "game-player-picker-search");
      dispatchClick(page.document.getElementById("game-player-new-toggle")!);
      assert.equal(page.document.activeElement, input);
      input.value = "Consecutive player"; dispatchSubmit(form); await flushAsync();
      assert.equal(input.value, ""); assert.equal(interactionVisible(toggle), false, "a capability redraw cannot reveal a duplicate entry action");
      input.value = "Next draft"; input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      dispatchClick(nav.overview); dispatchClick(nav.teams);
      assert.equal(interactionVisible(toggle), false); assert.equal(interactionVisible(form), true); assert.equal(input.value, "Next draft");
      if (close === "Cancel") { cancel.focus(); dispatchClick(cancel); }
      else { input.focus(); input.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }
      assert.equal(interactionVisible(form), false); assert.equal(interactionVisible(toggle), true); assert.equal(page.document.activeElement, toggle);
      dispatchClick(toggle); assert.equal(interactionVisible(toggle), false); assert.equal(input.value, "Next draft"); assert.equal(page.document.activeElement?.id, "game-player-picker-search");
      assert.equal([...apiState.players.values()].filter((player) => player.nickname === "Consecutive player").length, 1);
      assert.equal([...apiState.players.values()].filter((player) => player.nickname === "Next draft").length, 0);
      await flushAsync(); // An empty picker reopens without a directory request.
    } finally { page.dom.window.close(); }
  });
}

for (const pending of ["patch", "refresh"] as const) {
  test("qa navigation delayed metadata " + pending + " preserves later destination and focus", async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "metadata-navigation", role: "admin" });
    const base = createMockFetch(apiState); let release: (() => void) | undefined; let committed = false; let held = false; let writes = 0;
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "metadata-navigation" }), url: "http://localhost:3000/games/metadata-navigation#overview",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (init.method === "PATCH") {
          writes += 1;
          if (pending === "patch") return new Promise<Response>((resolve) => { release = () => { void base(input, init).then((response) => { committed = response.ok; resolve(response); }); }; });
          const response = await base(input, init); committed = response.ok; return response;
        }
        if (pending === "refresh" && committed && !held && path === "/v1/games/metadata-navigation") {
          held = true;
          return new Promise<Response>((resolve) => { release = () => { void base(input, init).then(resolve); }; });
        }
        return base(input, init);
      },
    });
    try {
      const nav = qaGameNavigation(page);
      const toggle = page.document.querySelector('[data-action="toggle-game-edit"]');
      const input = page.document.getElementById("game-edit-kickoff");
      const form = page.document.getElementById("game-edit-form");
      assert(toggle instanceof page.window.HTMLButtonElement && input instanceof page.window.HTMLInputElement && form instanceof page.window.HTMLFormElement);
      dispatchClick(toggle); input.value = "2026-03-28T10:30"; input.focus();
      input.dispatchEvent(new page.window.Event("input", { bubbles: true })); dispatchSubmit(form); await flushAsync();
      assert.equal(writes, 1); assert(release);
      dispatchClick(nav.teams);
      if (pending === "refresh") dispatchClick(nav.overview);
      const outside = page.document.querySelector('[data-ui="site-nav"] a'); assert(outside instanceof page.window.HTMLAnchorElement); outside.focus();
      release(); await flushAsync();
      assert.equal(committed, true); assert.equal(writes, 1);
      assert.equal(apiState.games.get("metadata-navigation")?.gameStartTs, new Date("2026-03-28T10:30").toISOString());
      assert.equal(page.window.location.hash, pending === "patch" ? "#teams" : "#overview");
      assert.equal(page.document.activeElement, outside);
      assert.equal(page.document.getElementById("game-edit-region")?.hidden, false, "a late settlement cannot dismiss the form after newer navigation");
      const status = page.document.getElementById("setup-status"); assert(status instanceof page.window.HTMLElement);
      assert.equal(interactionVisible(status), false); assert.doesNotMatch(status.textContent ?? "", /Game saved/);
      assert.equal(page.document.getElementById("setup-error")?.hidden, true);
    } finally { page.dom.window.close(); }
  });
}

test("qa navigation metadata success restores a reusable Edit game control and focus", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "metadata-success", role: "admin" });
  const base = createMockFetch(apiState); let writes = 0;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "metadata-success" }), url: "http://localhost:3000/games/metadata-success#overview",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => { if (init.method === "PATCH") writes += 1; return base(input, init); },
  });
  try {
    const toggle = page.document.querySelector('[data-action="toggle-game-edit"]');
    const input = page.document.getElementById("game-edit-kickoff");
    const form = page.document.getElementById("game-edit-form");
    const region = page.document.getElementById("game-edit-region");
    assert(toggle instanceof page.window.HTMLButtonElement && input instanceof page.window.HTMLInputElement);
    assert(form instanceof page.window.HTMLFormElement && region instanceof page.window.HTMLElement);
    toggle.focus(); dispatchClick(toggle);
    assert.equal(page.document.activeElement, input);
    input.value = "2026-03-28T10:30";
    input.dispatchEvent(new page.window.Event("input", { bubbles: true })); dispatchSubmit(form); await flushAsync();
    assert.equal(writes, 1);
    assert.equal(apiState.games.get("metadata-success")?.gameStartTs, new Date("2026-03-28T10:30").toISOString());
    assert.equal(region.hidden, true);
    assert.equal(toggle.disabled, false, "settlement must clear the pending lock before focus restoration");
    assert.equal(interactionVisible(toggle), true); assert.equal(page.document.activeElement, toggle);
    const status = page.document.getElementById("setup-status"); assert(status instanceof page.window.HTMLElement);
    assert.equal(status.textContent, "Game saved."); assert.equal(interactionVisible(status), true);
    dispatchClick(toggle);
    assert.equal(region.hidden, false); assert.equal(page.document.activeElement, input); assert.equal(input.disabled, false);
    assert.equal(input.value, "2026-03-28T10:30");
    assert.equal(writes, 1, "reopening a saved form never resubmits it");
  } finally { page.dom.window.close(); }
});

test("qa navigation an older assignment cannot clear newer goal activity feedback", async () => {
  const apiState = createMockApiState();
  const thirds = createDefaultThirdTimerSegments(); thirds[0].startedAt = "2026-03-28T11:00:10.000Z";
  seedGoalScoringGame(apiState, { gameId: "feedback-ownership", status: "live", role: "admin", thirds });
  const base = createMockFetch(apiState);
  let releaseAssignment: (() => void) | undefined; let releaseGoal: (() => void) | undefined;
  let assignments = 0; let goals = 0;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "feedback-ownership" }), url: "http://localhost:3000/games/feedback-ownership#teams",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (init.method === "PUT") {
        assignments += 1;
        return new Promise<Response>((resolve) => { releaseAssignment = () => { void base(input, init).then(resolve); }; });
      }
      if (init.method === "POST" && new URL(String(input)).pathname.endsWith("/goals")) {
        goals += 1;
        return new Promise<Response>((resolve) => { releaseGoal = () => { void base(input, init).then(resolve); }; });
      }
      return base(input, init);
    },
  });
  try {
    const nav = qaGameNavigation(page);
    const transfer = page.document.querySelector('[data-action="toggle-transfer"][data-player-id="player-ari"]');
    assert(transfer instanceof page.window.HTMLButtonElement); dispatchClick(transfer);
    const choice = page.document.querySelector('#transfer-options-player-ari [data-team-id="blue"]');
    assert(choice instanceof page.window.HTMLButtonElement); choice.focus(); dispatchClick(choice); await flushAsync();
    assert.equal(assignments, 1); assert(releaseAssignment);
    dispatchClick(nav.score);
    const controls = liveGoalControls(page); controls.draft();
    // The scorer stays on Red when Ari's pending transfer commits.
    controls.scorer.value = "player-bea"; controls.scorer.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    controls.scorer.focus(); dispatchSubmit(controls.form); await flushAsync();
    assert.equal(goals, 1); assert(releaseGoal);
    const status = page.document.getElementById("setup-status"); assert(status instanceof page.window.HTMLElement);
    assert.equal(status.textContent, "Saving goal…"); assert.equal(status.getAttribute("data-activity"), "loading");
    assert.equal(interactionVisible(status), true);
    releaseAssignment(); await flushAsync();
    assert.equal(apiState.roster.get("feedback-ownership:player-ari")?.teamId, "blue");
    assert.equal(apiState.goalEvents.size, 0, "the newer goal is still pending when the earlier assignment settles");
    assert.equal(status.textContent, "Saving goal…", "navigation-only ownership must not clear a newer operation's activity");
    assert.equal(status.getAttribute("data-activity"), "loading"); assert.equal(interactionVisible(status), true);
    assert.equal(controls.save.disabled, true); assert.equal(assignments, 1); assert.equal(goals, 1);
    releaseGoal(); await flushAsync();
    assert.equal(apiState.goalEvents.size, 1);
    assert.equal([...apiState.goalEvents.values()][0].scorerPlayerId, "player-bea");
    assert.equal(status.textContent, "Goal recorded."); assert.equal(status.getAttribute("data-state"), "success");
    assert.equal(interactionVisible(status), true);
    assert.equal(page.document.getElementById("setup-error")?.hidden, true);
    assert.equal(assignments, 1); assert.equal(goals, 1);
  } finally { page.dom.window.close(); }
});

function seedUx09Registration(apiState: MockApiState, gameId: string, playerId: string, nickname: string, updatedAt = "2026-03-28T10:00:00.000Z") {
  apiState.players.set(playerId, { playerId, nickname, claimedByUserId: null, createdAt: updatedAt, updatedAt });
  apiState.gamePlayers.set(`${gameId}:${playerId}`, { gameId, playerId, createdAt: updatedAt, updatedAt });
}

function ux09PlayerRows(page: Awaited<ReturnType<typeof bootPage>>, selector: string, playerId: string) {
  return [...page.document.querySelectorAll(selector)].filter(row => row.getAttribute("data-player-id") === playerId);
}

for (const identity of ["duplicate-name", "backslash", "long", "reserved", "literal-percent", "plus-space"] as const) {
  test(`ux09 returned player lookup preserves exact ${identity} identity without automatic claiming`, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    const playerId = identity === "backslash" ? "returned\\player" : identity === "long" ? "returned-" + "x".repeat(600)
      : identity === "reserved" ? "returned/player?#%" : identity === "literal-percent" ? "returned%2Fplayer%ZZ"
        : identity === "plus-space" ? "returned+player name" : "same-name-second";
    seedUx09Registration(apiState, "invite-entry", playerId, "Ari");
    const base = createMockFetch(apiState); const reads: string[] = []; const writes: string[] = [];
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", ""),
      url: "http://localhost:3000/join?code=abcd2345&playerId=" + encodeURIComponent(playerId),
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const target = new URL(String(input)); const path = target.pathname;
        if (path.startsWith("/v1/join/")) { reads.push(path + target.search); assert.equal(init.method, "GET"); assert.equal(init.cache, "no-store"); }
        if (init.method === "POST") writes.push(path);
        return base(input, init);
      },
    });
    try {
      const controls = joinEntryControls(page);
      assert.deepEqual(reads, ["/v1/join/ABCD2345/player-context?" + new URLSearchParams({ playerId }).toString()]);
      assert.equal(writes.length, 0, "a verified display name is not authorization to claim automatically");
      assert.equal(page.document.getElementById("join-result")?.hidden, false);
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "Ari");
      assert.equal(controls.claim.hidden, true); assert.equal(controls.claim.disabled, true);
      assert.equal(controls.form.hidden, true);
      dispatchClick(controls.claim); dispatchClick(controls.claim); await flushAsync();
      assert.deepEqual(writes, []);
      assert.equal(apiState.players.get(playerId)?.claimedByUserId, null);
      assert.equal(apiState.players.get("player-ari")?.claimedByUserId, null, "a same-name registration is never substituted");
      assert.match(page.document.getElementById("join-claim-status")?.textContent ?? "", /Ask the organiser for a private link/);
    } finally { page.dom.window.close(); }
  });
}

for (const malformed of ["player-id", "join-code", "missing-game", "blank-game", "blank-name", "missing-player"] as const) {
  test(`ux09 returned player rejects ${malformed} context without authorizing a claim`, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    const base = createMockFetch(apiState); let writes = 0;
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", ""), url: "http://localhost:3000/join?code=ABCD2345&playerId=player-ari",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        if (init.method === "POST") writes += 1;
        const response = await base(input, init);
        if (!new URL(String(input)).pathname.startsWith("/v1/join/")) return response;
        const body = await response.json() as Record<string, unknown>;
        const player = body.player as Record<string, unknown>;
        if (malformed === "player-id") player.playerId = "player-bea";
        if (malformed === "join-code") body.joinCode = "BCDE2345";
        if (malformed === "missing-game") delete body.gameId;
        if (malformed === "blank-game") body.gameId = " ";
        if (malformed === "blank-name") player.nickname = " ";
        if (malformed === "missing-player") body.player = null;
        return createJsonResponse(200, body);
      },
    });
    try {
      const controls = joinEntryControls(page);
      const retry = page.document.querySelector('[data-action="retry-join-context"]');
      assert(retry instanceof page.window.HTMLButtonElement);
      assert.equal(page.document.getElementById("join-result")?.hidden, true);
      assert.equal(controls.claim.hidden, true); assert.equal(controls.claim.disabled, true);
      assert.equal(interactionVisible(retry), true); assert.equal(retry.disabled, false);
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /player details couldn’t be loaded/);
      controls.claim.hidden = false; controls.claim.disabled = false; dispatchClick(controls.claim); await flushAsync();
      assert.equal(writes, 0, "synthetic control activation cannot bypass exact context verification");
      assert.equal(apiState.players.get("player-ari")?.claimedByUserId, null);
    } finally { page.dom.window.close(); }
  });
}

test("ux09 globally known but nonlinked player remains unavailable for this join code", async () => {
  const apiState = createMockApiState(); seedEntryInvite(apiState);
  seedUx09Registration(apiState, "different-game", "not-in-this-game", "Ari");
  const base = createMockFetch(apiState); let reads = 0; let writes = 0;
  const page = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""), url: "http://localhost:3000/join?code=ABCD2345&playerId=not-in-this-game",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (new URL(String(input)).pathname.startsWith("/v1/join/")) reads += 1;
      if (init.method === "POST") writes += 1;
      return base(input, init);
    },
  });
  try {
    const controls = joinEntryControls(page);
    assert.equal(reads, 1); assert.equal(writes, 0);
    assert.equal(page.document.getElementById("join-result")?.hidden, true);
    assert.equal(interactionVisible(controls.claim), false);
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /couldn’t be found for this join link/);
    const retry = page.document.querySelector('[data-action="retry-join-context"]');
    assert(retry instanceof page.window.HTMLButtonElement); assert.equal(interactionVisible(retry), false);
    controls.claim.disabled = false; dispatchClick(controls.claim); await flushAsync();
    assert.equal(writes, 0); assert.equal(apiState.players.get("not-in-this-game")?.claimedByUserId, null);
    assert.equal(apiState.players.get("player-ari")?.claimedByUserId, null);
  } finally { page.dom.window.close(); }
});

test("ux09 failed context lookup retries one GET and never joins or claims automatically", async () => {
  const apiState = createMockApiState(); seedEntryInvite(apiState);
  const base = createMockFetch(apiState); let reads = 0; let writes = 0; let release: (() => void) | undefined;
  const page = await bootPage({
    html: renderJoinPage("http://localhost:3001", ""), url: "http://localhost:3000/join?code=ABCD2345&playerId=player-ari",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      if (init.method === "POST") writes += 1;
      if (!new URL(String(input)).pathname.startsWith("/v1/join/")) return base(input, init);
      reads += 1;
      assert.equal(init.method, "GET"); assert.equal(init.cache, "no-store");
      if (reads === 1) return createJsonResponse(503, { error: "unavailable" });
      return new Promise<Response>(resolve => { release = () => { void base(input, init).then(resolve); }; });
    },
  });
  try {
    const controls = joinEntryControls(page);
    const retry = page.document.querySelector('[data-action="retry-join-context"]');
    assert(retry instanceof page.window.HTMLButtonElement);
    assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(interactionVisible(retry), true);
    retry.focus(); dispatchClick(retry); dispatchClick(retry); await flushAsync();
    assert.equal(reads, 2); assert.equal(retry.disabled, true); assert(release);
    assert.equal(controls.claim.disabled, true);
    release(); await flushAsync();
    assert.equal(reads, 2); assert.equal(writes, 0);
    assert.equal(page.document.getElementById("join-result-player")?.textContent, "Ari");
    assert.equal(page.document.getElementById("join-result")?.hidden, false);
    assert.equal(interactionVisible(controls.claim), false); assert.equal(controls.claim.disabled, true);
    assert.equal(page.document.activeElement, controls.another);
    assert.equal(interactionVisible(retry), false);
    assert.equal(page.document.getElementById("setup-error")?.hidden, true);
  } finally { page.dom.window.close(); }
});

for (const outcome of ["success", "failure"] as const) {
  test(`ux09 late ${outcome} lookup cannot replace a newer registration awaiting explicit linking`, async () => {
    const apiState = createMockApiState(); seedEntryInvite(apiState);
    const base = createMockFetch(apiState); const writes: string[] = []; let release: (() => void) | undefined;
    const page = await bootPage({
      html: renderJoinPage("http://localhost:3001", ""), url: "http://localhost:3000/join?code=ABCD2345&playerId=player-ari",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (init.method === "POST") writes.push(path);
        if (path === "/v1/join/ABCD2345/player-context" && new URL(String(input)).searchParams.get("playerId") === "player-ari") {
          return new Promise<Response>(resolve => { release = () => {
            if (outcome === "failure") resolve(createJsonResponse(503, { error: "unavailable" }));
            else void base(input, init).then(resolve);
          }; });
        }
        return base(input, init);
      },
    });
    try {
      const controls = joinEntryControls(page); assert(release);
      assert.equal(interactionVisible(controls.another), true); assert.equal(controls.another.disabled, false);
      dispatchClick(controls.another); assert.equal(page.document.activeElement, controls.nickname);
      controls.nickname.value = "New registration"; dispatchSubmit(controls.form); await flushAsync();
      const created = [...apiState.players.values()].find(player => player.nickname === "New registration"); assert(created);
      assert.equal(created.claimedByUserId, null, "joining cannot claim without explicit account confirmation");
      assert.deepEqual(writes, ["/v1/join/ABCD2345"]);
      release(); await flushAsync();
      assert.equal(page.document.getElementById("join-result-player")?.textContent, "New registration");
      assert.equal(page.document.getElementById("setup-status")?.textContent, "Joined game.");
      assert.equal(page.document.getElementById("setup-error")?.hidden, true);
      assert.equal(controls.form.hidden, true); assert.equal(controls.claim.hidden, false);
      assert.equal(apiState.players.get("player-ari")?.claimedByUserId, null); assert.equal(writes.length, 1);
    } finally { page.dom.window.close(); }
  });
}

for (const enrichment of ["capped", "failed", "empty", "public-metadata"] as const) {
  test(`ux09 complete Unassigned survives ${enrichment} private search without inventing access`, async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "ux09-roster", role: "admin" });
    for (let index = 0; index < 24; index += 1) {
      seedUx09Registration(apiState, "ux09-roster", `unassigned-${index}`, index < 2 ? "Same name" : `Unassigned ${index}`);
      seedUx09Registration(apiState, "ux09-roster", `assigned-${index}`, `Assigned ${index}`, "2026-03-28T12:00:00.000Z");
      apiState.roster.set(`ux09-roster:assigned-${index}`, { gameId: "ux09-roster", playerId: `assigned-${index}`, teamId: "yellow", createdAt: "2026-03-28T12:00:00.000Z", updatedAt: "2026-03-28T12:00:00.000Z" });
    }
    const base = createMockFetch(apiState); let searches = 0; let returnedSearchPlayers = 0;
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "ux09-roster" }), url: "http://localhost:3000/games/ux09-roster#teams",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/games/ux09-roster/players") {
          searches += 1;
          if (enrichment === "failed") return createJsonResponse(503, { error: "unavailable" });
          if (enrichment === "empty") return createJsonResponse(200, { players: [] });
          // A valid capped operator response can contain only recently added
          // assigned players. Its page must not define the Unassigned list.
          const game = apiState.games.get("ux09-roster")!;
          const body = { players: Array.from({ length: 20 }, (_, index) =>
            gamePlayerResponse(apiState, game, apiState.players.get(`assigned-${index}`)!)) };
          returnedSearchPlayers = body.players.length;
          return createJsonResponse(200, body);
        }
        const response = await base(input, init);
        if (path.endsWith("/roster") && enrichment === "public-metadata") {
          const body = await response.json() as { unassignedPlayers: Array<Record<string, unknown>> };
          body.unassignedPlayers = body.unassignedPlayers.map(player => ({ ...player, email: "private@example.com", claimedByUserId: "private@example.com", access: { userId: "private@example.com", role: "viewer" } }));
          return createJsonResponse(200, body);
        }
        return response;
      },
    });
    try {
      const pool = page.document.getElementById("player-pool"); assert(pool instanceof page.window.HTMLElement);
      assert.equal(searches, 1); if (enrichment === "capped" || enrichment === "public-metadata") assert.equal(returnedSearchPlayers, 20);
      assert.equal(pool.querySelectorAll('[data-ui="roster-player"]').length, 24);
      assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 27);
      for (let index = 0; index < 24; index += 1) assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', `unassigned-${index}`).length, 1);
      assert.equal([...pool.querySelectorAll("strong")].filter(name => name.textContent === "Same name").length, 2);
      assert.equal(pool.querySelector('[data-ui="claim-badge"]'), null);
      assert.equal(pool.querySelector('[data-action="grant-player-access"]'), null);
      assert.doesNotMatch(pool.textContent ?? "", /private@example|couldn’t be loaded|full Unassigned list is unavailable|Search by name to find more players/);
      assert.equal(page.document.getElementById("player-search"), null, "complete Unassigned does not require a search to reveal a joined player");
    } finally { page.dom.window.close(); }
  });
}

test("ux09 assigning a public Unassigned player stays single through a stale Unassigned refresh", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "ux09-assignment", role: "admin" });
  seedUx09Registration(apiState, "ux09-assignment", "public-joined", "Joined player");
  const base = createMockFetch(apiState); let staleUnassigned: unknown; let assignments = 0; let release: (() => void) | undefined;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "ux09-assignment" }), url: "http://localhost:3000/games/ux09-assignment#teams",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/players")) return createJsonResponse(503, { error: "unavailable" });
      if (init.method === "PUT") {
        assignments += 1;
        return new Promise<Response>(resolve => { release = () => { void base(input, init).then(resolve); }; });
      }
      if (path.endsWith("/roster")) {
        const response = await base(input, init); const payload = await response.json() as Record<string, unknown>;
        // Assignment reads are strongly consistent after a confirmed PUT.
        // Defensively inject a stale optional Unassigned projection; the
        // current backend normally filters assigned IDs from that collection.
        if (assignments) payload.unassignedPlayers = staleUnassigned;
        else staleUnassigned = payload.unassignedPlayers;
        return createJsonResponse(200, payload);
      }
      return base(input, init);
    },
  });
  try {
    const rows = ux09PlayerRows(page, '[data-ui="roster-player"]', "public-joined"); assert.equal(rows.length, 1);
    const choice = rows[0].querySelector('[data-action="assign-player"][data-team-id="yellow"]');
    assert(choice instanceof page.window.HTMLButtonElement);
    choice.focus(); dispatchClick(choice); dispatchClick(choice); await flushAsync(); assert.equal(assignments, 1); assert(release);
    release(); await flushAsync();
    assert.equal(apiState.roster.get("ux09-assignment:public-joined")?.teamId, "yellow");
    assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', "public-joined").length, 0);
    const assigned = ux09PlayerRows(page, '[data-ui="roster-member"]', "public-joined"); assert.equal(assigned.length, 1);
    assert.equal(assigned[0].closest('[data-ui="roster-team"]')?.getAttribute("data-team-id"), "yellow");
    assert.match(assigned[0].textContent ?? "", /Joined player/);
    assert.equal(assignments, 1, "a stale complete Unassigned snapshot must not resurrect a duplicate player card");
  } finally { page.dom.window.close(); }
});

for (const field of ["missing", "null", "object", "bad-player"] as const) {
  test(`ux09 ${field} Unassigned DTO preserves honest search fallback and assigned rows`, async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "ux09-fallback", role: "admin" });
    seedUx09Registration(apiState, "ux09-fallback", "fallback-player", "Searchable player");
    const base = createMockFetch(apiState);
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "ux09-fallback" }), url: "http://localhost:3000/games/ux09-fallback#teams",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const response = await base(input, init);
        if (!new URL(String(input)).pathname.endsWith("/roster")) return response;
        const body = await response.json() as Record<string, unknown>;
        if (field === "missing") delete body.unassignedPlayers;
        if (field === "null") body.unassignedPlayers = null;
        if (field === "object") body.unassignedPlayers = {};
        if (field === "bad-player") body.unassignedPlayers = [{ playerId: "bogus", nickname: null }];
        return createJsonResponse(200, body);
      },
    });
    try {
      assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 3);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', "fallback-player").length, 1);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', "bogus").length, 0);
      const pool = page.document.getElementById("player-pool"); assert(pool);
      assert.match(pool.textContent ?? "", /The full Unassigned list is unavailable/);
      assert.doesNotMatch(pool.textContent ?? "", /No unassigned players to show/);
    } finally { page.dom.window.close(); }
  });
}

for (const actor of ["viewer", "finished-scorekeeper"] as const) {
  test(`ux09 public Unassigned data preserves ${actor} presentation and mutation locks`, async () => {
    const apiState = createMockApiState();
    seedGoalScoringGame(apiState, { gameId: "ux09-locks", role: actor === "viewer" ? "viewer" : "scorekeeper", status: actor === "viewer" ? "scheduled" : "finished" });
    seedUx09Registration(apiState, "ux09-locks", "locked-unassigned", "Joined player");
    const base = createMockFetch(apiState); let searches = 0; let writes = 0;
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "ux09-locks" }), url: "http://localhost:3000/games/ux09-locks#teams",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        if (new URL(String(input)).pathname.endsWith("/players")) searches += 1;
        if (init.method && init.method !== "GET") writes += 1;
        return base(input, init);
      },
    });
    try {
      assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 3);
      const pool = page.document.getElementById("player-pool"); assert(pool instanceof page.window.HTMLElement);
      assert.equal(interactionVisible(pool), actor !== "viewer");
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', "locked-unassigned").length, actor === "viewer" ? 0 : 1);
      if (actor === "viewer") assert.equal(searches, 0, "public context never becomes an administrative player-search capability");
      assert.equal(page.document.querySelector('[data-action="assign-player"]'), null);
      assert.equal(page.document.querySelector('[data-action="toggle-transfer"]'), null);
      assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
      const create = page.document.querySelector('[data-action="quick-create-player"]');
      assert(create instanceof page.window.HTMLButtonElement); assert.equal(create.disabled, true);
      assert.equal(writes, 0);
    } finally { page.dom.window.close(); }
  });
}

test("ux09 unavailable complete roster and failed search never claim an empty Unassigned list", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "ux09-unavailable", role: "admin" });
  seedUx09Registration(apiState, "ux09-unavailable", "not-proven-empty", "Unseen player");
  const base = createMockFetch(apiState);
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "ux09-unavailable" }), url: "http://localhost:3000/games/ux09-unavailable#teams",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/players")) return createJsonResponse(503, { error: "unavailable" });
      const response = await base(input, init);
      if (!path.endsWith("/roster")) return response;
      const body = await response.json() as Record<string, unknown>; delete body.unassignedPlayers;
      return createJsonResponse(200, body);
    },
  });
  try {
    assert.equal(page.document.querySelectorAll('[data-ui="roster-member"]').length, 3);
    const pool = page.document.getElementById("player-pool"); assert(pool);
    assert.match(pool.textContent ?? "", /Unassigned players couldn’t be loaded/);
    assert.match(pool.textContent ?? "", /The full Unassigned list is unavailable/);
    assert.doesNotMatch(pool.textContent ?? "", /No unassigned players to show|No teams found/);
    assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
  } finally { page.dom.window.close(); }
});

test("ux09 committed player survives search acknowledgement while complete roster refresh is unavailable", async () => {
  const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "ux09-created-overlay", role: "admin" });
  const base = createMockFetch(apiState); let creates = 0; let searches = 0;
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "ux09-created-overlay" }), url: "http://localhost:3000/games/ux09-created-overlay#teams",
    scriptFile: "setup-flow.js", apiState,
    fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/roster") && creates > 0) return createJsonResponse(503, { error: "unavailable" });
      if (path.endsWith("/players") && init.method === "POST") creates += 1;
      if (path.endsWith("/players") && (!init.method || init.method === "GET")) searches += 1;
      return base(input, init);
    },
  });
  try {
    const toggle = page.document.querySelector('[data-action="toggle-player-create"]');
    const form = page.document.getElementById("player-create-form");
    const nickname = page.document.getElementById("player-nickname");
    const retry = page.document.getElementById("roster-retry");
    assert(toggle instanceof page.window.HTMLButtonElement && form instanceof page.window.HTMLFormElement);
    assert(nickname instanceof page.window.HTMLInputElement && retry instanceof page.window.HTMLButtonElement);
    assert.equal(page.document.querySelectorAll('[data-ui="roster-player"]').length, 0, "the last complete public snapshot is known empty");
    dispatchClick(toggle); nickname.value = "Newly added"; dispatchSubmit(form); await flushAsync();
    const created = [...apiState.players.values()].find(player => player.nickname === "Newly added"); assert(created);
    assert.equal(creates, 1); assert.equal(searches, 1);
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /^Player added\./);
    assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', created.playerId).length, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      dispatchClick(retry); await flushAsync();
      const rows = ux09PlayerRows(page, '[data-ui="roster-player"]', created.playerId);
      assert.equal(rows.length, 1, "private search acknowledgement cannot retire a public-roster overlay the stale complete list still needs");
      const choice = rows[0].querySelector('[data-action="assign-player"][data-team-id="red"]');
      assert(choice instanceof page.window.HTMLButtonElement); assert.equal(choice.disabled, false);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', created.playerId).length, 0);
    }
    assert.equal(searches, 3); assert.equal(creates, 1);
    assert.equal([...apiState.players.values()].filter(player => player.nickname === "Newly added").length, 1);
  } finally { page.dom.window.close(); }
});

for (const collision of ["CR-LF", "NUL-replacement"] as const) {
  test(`ux09 public roster ${collision} identities assign and transfer the intended player exactly`, async () => {
    const apiState = createMockApiState(); seedGoalScoringGame(apiState, { gameId: "ux09-opaque-roster", role: "admin" });
    const intendedId = collision === "CR-LF" ? "opaque-\ridentity" : "opaque-\u0000identity";
    const otherId = collision === "CR-LF" ? "opaque-\nidentity" : "opaque-\ufffdidentity";
    seedUx09Registration(apiState, "ux09-opaque-roster", intendedId, "Intended registration");
    seedUx09Registration(apiState, "ux09-opaque-roster", otherId, "Different registration");
    const base = createMockFetch(apiState);
    const writes: Array<{ path: string; body: string }> = [];
    const page = await bootPage({
      html: renderGamePage("http://localhost:3001", { gameId: "ux09-opaque-roster" }), url: "http://localhost:3000/games/ux09-opaque-roster#teams",
      scriptFile: "setup-flow.js", apiState,
      fetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/players")) return createJsonResponse(200, { players: [] });
        if (init.method === "PUT") writes.push({ path, body: String(init.body) });
        return base(input, init);
      },
    });
    try {
      const pool = page.document.getElementById("player-pool"); assert(pool instanceof page.window.HTMLElement);
      assert.equal(pool.querySelectorAll('[data-ui="roster-player"]').length, 2);
      // Choose as a person would, by the displayed name. Before the fix, parsed
      // attributes changed this card's identity to the distinct other player.
      const intendedCard = [...pool.querySelectorAll('[data-ui="roster-player"]')]
        .find(card => card.querySelector("strong")?.textContent === "Intended registration");
      assert(intendedCard instanceof page.window.HTMLElement);
      assert.equal(intendedCard.querySelector('[data-ui="claim-badge"]'), null);
      const assign = intendedCard.querySelector('[data-action="assign-player"][data-team-id="red"]');
      assert(assign instanceof page.window.HTMLButtonElement);
      assign.focus(); dispatchClick(assign); await flushAsync();
      const exactPath = "/v1/games/ux09-opaque-roster/roster/" + encodeURIComponent(intendedId);
      assert.deepEqual(writes, [{ path: exactPath, body: JSON.stringify({ teamId: "red" }) }]);
      assert.equal(apiState.roster.get("ux09-opaque-roster:" + intendedId)?.teamId, "red");
      assert.equal(apiState.roster.has("ux09-opaque-roster:" + otherId), false);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', intendedId).length, 0);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', otherId).length, 1);
      let members = ux09PlayerRows(page, '[data-ui="roster-member"]', intendedId); assert.equal(members.length, 1);
      const transfer = members[0].querySelector('[data-action="toggle-transfer"]');
      assert(transfer instanceof page.window.HTMLButtonElement);
      assert.equal(transfer.getAttribute("data-player-id"), intendedId);
      assert.equal(page.document.activeElement, transfer, "assignment redraw restores focus to this exact identity");
      dispatchClick(transfer);
      members = ux09PlayerRows(page, '[data-ui="roster-member"]', intendedId); assert.equal(members.length, 1);
      const menu = members[0].querySelector('[data-ui="transfer-menu"]'); assert(menu instanceof page.window.HTMLElement);
      assert.equal(interactionVisible(menu), true);
      const blue = menu.querySelector('[data-action="assign-player"][data-team-id="blue"]');
      assert(blue instanceof page.window.HTMLButtonElement); assert.equal(blue.getAttribute("data-player-id"), intendedId);
      assert.equal(page.document.activeElement, blue);
      dispatchClick(blue); await flushAsync();
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[1], { path: exactPath, body: JSON.stringify({ teamId: "blue" }) });
      assert.equal(apiState.roster.get("ux09-opaque-roster:" + intendedId)?.teamId, "blue");
      assert.equal(apiState.roster.has("ux09-opaque-roster:" + otherId), false);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', intendedId).length, 1);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', otherId).length, 1);
      assert.equal(page.document.activeElement?.getAttribute("data-action"), "toggle-transfer");
      assert.equal(page.document.activeElement?.getAttribute("data-player-id"), intendedId);
      assert.equal(page.document.activeElement?.getAttribute("aria-expanded"), "false");
    } finally { page.dom.window.close(); }
  });
}

function seedUx10Game(apiState: MockApiState, status: MockGame["status"] = "live", role: MockLeagueRole = "admin") {
  const thirds = createDefaultThirdTimerSegments();
  if (status === "live") thirds[0].startedAt = "2026-03-28T11:00:10.000Z";
  seedGoalScoringGame(apiState, { gameId: "ux10-match", status, role, thirds });
}

async function bootUx10Page(apiState: MockApiState, options: {
  mode?: string;
  fetch?: ReturnType<typeof createMockFetch>;
  captureInterval?: (callback: () => void) => number;
  captureClearInterval?: (id: number) => void;
} = {}) {
  const timers = createManualTimers();
  const page = await bootPage({
    html: renderGamePage("http://localhost:3001", { gameId: "ux10-match" }),
    url: "http://localhost:3000/games/ux10-match#" + (options.mode ?? "score"),
    scriptFile: "setup-flow.js", apiState, timers, fetch: options.fetch,
    captureInterval: options.captureInterval, captureClearInterval: options.captureClearInterval,
  });
  Object.defineProperty(page.window, "confirm", { value: () => true, configurable: true });
  return { ...page, timers };
}

function closeUx10Page(page: Awaited<ReturnType<typeof bootUx10Page>>) {
  page.window.dispatchEvent(new page.window.Event("pagehide"));
  page.dom.window.close();
}

test("ux10 a committed new player stays assignment-disabled until post-create reads settle", async () => {
  const apiState = createMockApiState();
  seedUx10Game(apiState, "scheduled");
  const base = createMockFetch(apiState);
  let createdPlayerId: string | undefined;
  let creates = 0;
  let heldRoster = false;
  let releaseRoster: (() => void) | undefined;
  const assignments: Array<{ method: string; path: string; body: unknown }> = [];
  const page = await bootUx10Page(apiState, { mode: "teams", fetch: async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (init.method === "POST" && path === "/v1/games/ux10-match/players") {
      creates += 1;
      createdPlayerId = (JSON.parse(String(init.body)) as { playerId: string }).playerId;
    }
    if (init.method === "PUT") assignments.push({ method: init.method, path, body: JSON.parse(String(init.body)) });
    const response = await base(input, init);
    if (init.method === "GET" && path === "/v1/games/ux10-match/roster" && createdPlayerId && !heldRoster) {
      heldRoster = true;
      return new Promise<Response>(resolve => { releaseRoster = () => resolve(response); });
    }
    return response;
  } });
  try {
    const toggle = page.document.querySelector('[data-action="toggle-player-create"]');
    const form = page.document.getElementById("player-create-form");
    const nickname = page.document.getElementById("player-nickname");
    const add = page.document.querySelector('[data-action="quick-create-player"]');
    assert(toggle instanceof page.window.HTMLButtonElement && form instanceof page.window.HTMLFormElement);
    assert(nickname instanceof page.window.HTMLInputElement && add instanceof page.window.HTMLButtonElement);
    toggle.click(); nickname.value = "Bea"; nickname.focus(); dispatchSubmit(form); await flushAsync();
    assert.equal(creates, 1); assert(createdPlayerId && releaseRoster);
    assert.equal(apiState.players.get(createdPlayerId)?.nickname, "Bea", "creation is already committed while its follow-up read is held");
    const rows = ux09PlayerRows(page, '[data-ui="roster-player"]', createdPlayerId);
    assert.equal(rows.length, 1);
    const row = rows[0]; assert(row instanceof page.window.HTMLElement); assert.equal(interactionVisible(row), true);
    const blue = row.querySelector('[data-action="assign-player"][data-team-id="blue"]');
    assert(blue instanceof page.window.HTMLButtonElement);
    assert.equal(blue.disabled, true, "a visible new card must not advertise an assignment click the busy handler will ignore");
    assert.equal(add.disabled, true);
    const existingTransfer = page.document.querySelector('[data-action="toggle-transfer"][data-player-id="player-ari"]');
    assert(existingTransfer instanceof page.window.HTMLButtonElement); assert.equal(existingTransfer.disabled, true);
    blue.click(); await flushAsync(); assert.equal(assignments.length, 0);

    releaseRoster(); releaseRoster = undefined; await flushAsync();
    const settledRow = ux09PlayerRows(page, '[data-ui="roster-player"]', createdPlayerId)[0];
    assert(settledRow);
    assert.equal(settledRow.querySelector('[data-action="assign-player"][data-team-id="blue"]'), blue,
      "post-create completion must re-enable the actual preserved button, not depend on replacing the row");
    assert.equal(blue.disabled, false); assert.equal(add.disabled, false); assert.equal(existingTransfer.disabled, false);
    blue.focus(); blue.click(); await flushAsync();
    assert.deepEqual(assignments, [{ method: "PUT", path: `/v1/games/ux10-match/roster/${encodeURIComponent(createdPlayerId)}`, body: { teamId: "blue" } }]);
    assert.equal(apiState.roster.get(`ux10-match:${createdPlayerId}`)?.teamId, "blue");
    assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', createdPlayerId).length, 0);
    const assigned = ux09PlayerRows(page, '[data-ui="roster-member"]', createdPlayerId);
    assert.equal(assigned.length, 1); assert.equal(assigned[0].closest('[data-ui="roster-team"]')?.getAttribute("data-team-id"), "blue");
    assert.equal(creates, 1);
  } finally {
    releaseRoster?.();
    await flushAsync();
    closeUx10Page(page);
  }
});

test("ux10 a scheduled external join appears at the 15-second public roster refresh without changing local drafts", async () => {
  const apiState = createMockApiState();
  seedUx10Game(apiState, "scheduled");
  apiState.games.get("ux10-match")!.joinCode = "ABCD2345";
  const base = createMockFetch(apiState);
  const observerRequests: Array<{ method: string; path: string }> = [];
  const page = await bootUx10Page(apiState, { mode: "teams", fetch: async (input, init = {}) => {
    observerRequests.push({ method: init.method ?? "GET", path: new URL(String(input)).pathname });
    return base(input, init);
  } });
  try {
    const rosterReads = () => observerRequests.filter(request => request.path === "/v1/games/ux10-match/roster").length;
    const initialRosterReads = rosterReads(); assert(initialRosterReads > 0);
    assert.equal(page.document.querySelectorAll('[data-ui="roster-player"]').length, 0);
    const toggle = page.document.querySelector('[data-action="toggle-player-create"]');
    const region = page.document.getElementById("player-create-region");
    const nickname = page.document.getElementById("player-nickname");
    const search = page.document.getElementById("game-player-picker-search");
    assert(toggle instanceof page.window.HTMLButtonElement && region instanceof page.window.HTMLElement);
    assert(nickname instanceof page.window.HTMLInputElement && search instanceof page.window.HTMLInputElement);
    toggle.click(); nickname.value = "Keep this local draft";
    nickname.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    search.value = "Cy"; search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    search.focus(); search.setSelectionRange(0, 1);

    // A separate client uses the real fixture join route after the observer's
    // complete initial roster read. It is not an observer-page mutation.
    const joined = await base("http://localhost:3001/v1/join/ABCD2345", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "ux10-external-cy" },
      body: JSON.stringify({ nickname: "Cy" }),
    });
    assert.equal(joined.status, 201);
    const receipt = await joined.json() as { gameId: string; player: { playerId: string; nickname: string } };
    assert.equal(receipt.gameId, "ux10-match"); assert.equal(receipt.player.nickname, "Cy");
    assert(apiState.gamePlayers.has(`ux10-match:${receipt.player.playerId}`));
    assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', receipt.player.playerId).length, 0);

    await advanceUx10(page, 14999);
    assert.equal(rosterReads(), initialRosterReads, "scheduled roster polling must not run before 15 seconds");
    assert.equal(observerRequests.filter(request => request.path === "/v1/games/ux10-match/players").length, 1,
      "picker queries do not filter or refresh private roster enrichment");
    assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', receipt.player.playerId).length, 0);
    assert.equal(page.document.activeElement, search);

    await advanceUx10(page, 1);
    assert.equal(rosterReads(), initialRosterReads + 1);
    const rows = ux09PlayerRows(page, '[data-ui="roster-player"]', receipt.player.playerId);
    assert.equal(rows.length, 1);
    const row = rows[0]; assert(row instanceof page.window.HTMLElement);
    assert.equal(interactionVisible(row), true); assert.equal(row.querySelector("strong")?.textContent, "Cy");
    assert.equal(page.document.getElementById("player-nickname"), nickname); assert.equal(nickname.value, "Keep this local draft");
    assert.equal(page.document.getElementById("game-player-picker-search"), search); assert.equal(search.value, "Cy");
    assert.equal(page.document.activeElement, search); assert.equal(search.selectionStart, 0); assert.equal(search.selectionEnd, 1);
    assert.equal(region.hidden, false); assert.equal(interactionVisible(toggle), false);
    assert.equal(page.window.location.hash, "#teams"); assert.equal(page.document.getElementById("setup-status")?.hidden, true);
    const refreshDetails = page.document.getElementById("roster-retry");
    assert(refreshDetails instanceof page.window.HTMLButtonElement);
    assert.equal(refreshDetails.hidden, false, "a new public row must retain a private-metadata recovery path");
    assert.equal(refreshDetails.textContent, "Refresh player details");
    assert.equal(row.querySelector('[data-ui="player-initial"]')?.getAttribute("data-link-state"), "unknown");
    refreshDetails.click(); await flushAsync();
    assert.equal(observerRequests.filter(request => request.path === "/v1/games/ux10-match/players").length, 2);
    const enriched = ux09PlayerRows(page, '[data-ui="roster-player"]', receipt.player.playerId)[0];
    assert.equal(enriched.querySelector('[data-ui="player-initial"]')?.getAttribute("data-link-state"), "unlinked");
    assert(enriched.querySelector('[data-action="toggle-action-menu"]'), "new player account actions are restored");
    assert.equal(refreshDetails.hidden, false);
    assert.equal(search.value, "Cy"); assert.equal(nickname.value, "Keep this local draft");
    assert.deepEqual(observerRequests.filter(request => request.method !== "GET"), [], "a read refresh never joins, claims or assigns for the observing page");
  } finally { closeUx10Page(page); }
});

async function advanceUx10(page: Awaited<ReturnType<typeof bootUx10Page>>, milliseconds: number) {
  const target = page.timers.elapsedMilliseconds() + milliseconds;
  let steps = 0;
  do {
    assert(++steps <= 100, "Refresh timers must stay bounded within a finite virtual interval");
    const remaining = target - page.timers.elapsedMilliseconds();
    const next = page.timers.pendingDelays()[0];
    page.timers.advanceBy(next === undefined ? remaining : Math.min(remaining, next));
    await flushAsync();
  } while (page.timers.elapsedMilliseconds() < target);
}

function setUx10Visible(page: Awaited<ReturnType<typeof bootUx10Page>>, visible: boolean) {
  Object.defineProperty(page.document, "hidden", { value: !visible, configurable: true });
  Object.defineProperty(page.document, "visibilityState", { value: visible ? "visible" : "hidden", configurable: true });
  page.document.dispatchEvent(new page.window.Event("visibilitychange"));
}

function ux10Scores(page: Awaited<ReturnType<typeof bootUx10Page>>) {
  return [...page.document.querySelectorAll('#live-scoreboard [data-ui="score-team"]')].map(card => ({
    teamId: card.getAttribute("data-team-id"),
    values: [...card.querySelectorAll("dl > div")].map(row => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]),
  }));
}

test("ux10 two clients observe goal creation correction and deletion without navigation or background writes", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState);
  const base = createMockFetch(apiState); const observerWrites: string[] = [];
  const writer = await bootUx10Page(apiState);
  const observer = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    if (init.method && init.method !== "GET") observerWrites.push(String(input));
    return base(input, init);
  } });
  try {
    const draft = liveGoalControls(writer); draft.draft();
    const assist = writer.document.querySelector('#goal-assists input[value="player-cy"]'); assert(assist instanceof writer.window.HTMLInputElement);
    assist.checked = true; assist.dispatchEvent(new writer.window.Event("change", { bubbles: true }));
    dispatchSubmit(draft.form); await flushAsync();
    const eventId = [...apiState.goalEvents.keys()][0]; assert(eventId);
    assert.equal(observer.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
    const observerFocus = observer.document.getElementById("goal-own-goal"); assert(observerFocus instanceof observer.window.HTMLInputElement); observerFocus.focus();
    await advanceUx10(observer, 4999);
    assert.equal(observer.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
    await advanceUx10(observer, 1);
    assert.equal(observer.document.querySelectorAll('[data-ui="goal-event"]').length, 1);
    assert.equal(observer.document.querySelector('[data-ui="goal-event"]')?.getAttribute("data-event-id"), eventId);
    assert.match(observer.document.getElementById("goal-timeline")?.textContent ?? "", /Ari[\s\S]*Assists: Cy/);
    assert.deepEqual(ux10Scores(observer), ux10Scores(writer));
    assert.equal(observer.document.activeElement, observerFocus);
    const edit = writer.document.querySelector('[data-action="edit-goal"]'); assert(edit instanceof writer.window.HTMLButtonElement);
    dispatchClick(edit); draft.scorer.value = "player-bea"; draft.scorer.dispatchEvent(new writer.window.Event("change", { bubbles: true }));
    dispatchSubmit(draft.form); await flushAsync(); await advanceUx10(observer, 5000);
    assert.equal(apiState.goalEvents.get(eventId)?.scorerPlayerId, "player-bea");
    assert.equal(observer.document.querySelector('[data-ui="goal-scorer"]')?.textContent, "Bea");
    const remove = writer.document.querySelector('[data-action="delete-goal"]'); assert(remove instanceof writer.window.HTMLButtonElement);
    dispatchClick(remove); await flushAsync(); await advanceUx10(observer, 5000);
    assert.equal(apiState.goalEvents.size, 0); assert.equal(observer.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
    assert.deepEqual(ux10Scores(observer), ux10Scores(writer));
    assert.equal(observer.window.location.hash, "#score"); assert.equal(observer.navigations.length, 0);
    assert.equal(observerWrites.length, 0);
  } finally { closeUx10Page(writer); closeUx10Page(observer); }
});

test("ux10 two clients observe clock transitions and finished own-goal result without automatic correction", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState, "scheduled");
  const writer = await bootUx10Page(apiState); const observer = await bootUx10Page(apiState);
  try {
    const start = writer.document.querySelector('[data-action="start-active-third"]');
    const finishThird = writer.document.querySelector('[data-action="finish-active-third"]');
    const finishGame = writer.document.querySelector('[data-action="finish-game"]');
    assert(start instanceof writer.window.HTMLButtonElement && finishThird instanceof writer.window.HTMLButtonElement && finishGame instanceof writer.window.HTMLButtonElement);
    dispatchClick(start); await flushAsync(); await advanceUx10(observer, 15000);
    assert.equal(observer.document.getElementById("game-overview-status")?.textContent, "Live");
    const draft = liveGoalControls(writer);
    draft.ownGoal.checked = true; draft.ownGoal.dispatchEvent(new writer.window.Event("change", { bubbles: true }));
    draft.choose(draft.conceding, "blue"); draft.scorer.value = "player-cy"; draft.scorer.dispatchEvent(new writer.window.Event("change", { bubbles: true }));
    dispatchSubmit(draft.form); await flushAsync();
    dispatchClick(finishThird); await flushAsync(); await advanceUx10(observer, 5000);
    assert.equal(observer.document.querySelector('[data-action="start-active-third"]')?.textContent, "Start Third 2");
    for (const third of [2, 3]) {
      assert.equal(start.textContent, "Start Third " + third);
      dispatchClick(start); await flushAsync(); dispatchClick(finishThird); await flushAsync();
    }
    dispatchClick(finishGame); await flushAsync(); await advanceUx10(observer, 5000);
    assert.equal(apiState.games.get("ux10-match")?.status, "finished");
    assert.equal(observer.document.getElementById("game-overview-status")?.textContent, "Finished");
    assert.equal(observer.window.location.hash, "#score", "a remote finish does not navigate the active scoring task");
    const correction = observer.document.querySelector('[data-action="correct-finished-result"]'); assert(correction instanceof observer.window.HTMLButtonElement);
    assert.equal(correction.hidden, false, "correction still requires deliberate opt-in");
    const observerControls = liveGoalControls(observer); assert.equal(observerControls.save.disabled, true);
    assert.equal(observer.document.getElementById("finished-correction-actions")?.hidden, true);
    const results = observer.document.querySelector('[data-game-mode="final"][data-ui="game-mode-tab"]') ?? observer.document.querySelector('[data-testid="game-mode-final-tab"]');
    assert(results instanceof observer.window.HTMLElement); dispatchClick(results);
    assert.equal(observer.document.querySelector('[data-testid="game-result-outcome"]')?.textContent, "Draw");
    assert.match(observer.document.querySelector('[data-testid="final-own-goal-stats"]')?.textContent ?? "", /Cy/);
    assert.deepEqual(apiState.games.get("ux10-match")?.result?.teams.map(team => [team.teamId, team.scored, team.conceded]), [["red", 0, 0], ["yellow", 0, 0], ["blue", 0, 1]]);
    assert.equal(observer.navigations.length, 0);
  } finally { closeUx10Page(writer); closeUx10Page(observer); }
});

test("ux10 full refresh preserves a dirty metadata form while updating read-only overview", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState, "scheduled");
  const page = await bootUx10Page(apiState, { mode: "overview" });
  try {
    const toggle = page.document.querySelector('[data-action="toggle-game-edit"]'); const input = page.document.getElementById("game-edit-kickoff");
    assert(toggle instanceof page.window.HTMLButtonElement && input instanceof page.window.HTMLInputElement);
    dispatchClick(toggle); input.value = "2026-03-29T13:45"; input.dispatchEvent(new page.window.Event("input", { bubbles: true })); input.focus();
    apiState.games.get("ux10-match")!.gameStartTs = "2026-03-30T03:00:00.000Z";
    await advanceUx10(page, 15000);
    assert.equal(input.value, "2026-03-29T13:45"); assert.equal(page.document.activeElement, input);
    assert.equal(page.document.getElementById("game-edit-region")?.hidden, false);
    assert.equal(page.document.getElementById("game-overview-kickoff")?.textContent, expectedSeasonKickoff("2026-03-30T03:00:00.000Z"));
    assert.equal(page.window.location.hash, "#overview"); assert.equal(page.navigations.length, 0);
  } finally { closeUx10Page(page); }
});

test("ux10 refresh preserves open assists focus and exact draft when a selected player moves teams", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState);
  const page = await bootUx10Page(apiState);
  try {
    const controls = liveGoalControls(page); controls.draft();
    const details = page.document.getElementById("goal-assists-dropdown"); const assist = page.document.querySelector('#goal-assists input[value="player-cy"]');
    assert(details instanceof page.window.HTMLDetailsElement && assist instanceof page.window.HTMLInputElement);
    details.open = true; assist.checked = true; assist.dispatchEvent(new page.window.Event("change", { bubbles: true })); assist.focus();
    seedLiveGoalEvent(apiState, "ux10-match", "remote-first");
    await advanceUx10(page, 5000);
    assert.equal(page.document.activeElement, assist); assert.equal(details.open, true);
    assert.equal(controls.scorer.value, "player-ari"); assert.equal(assist.checked, true);
    apiState.roster.get("ux10-match:player-ari")!.teamId = "yellow";
    await advanceUx10(page, 10000);
    assert.equal(controls.scorer.value, "player-ari", "remote team movement cannot silently change the chosen identity");
    assert.equal(goalTeamValue(controls.scoring), "red"); assert.equal(goalTeamValue(controls.conceding), "blue");
    assert.equal(page.document.querySelector<HTMLInputElement>('#goal-assists input[value="player-cy"]')?.checked, true);
    assert.equal(details.open, true); assert.equal(page.document.activeElement?.getAttribute("value"), "player-cy");
    assert.equal(controls.save.disabled, true);
    assert.match((page.document.getElementById("goal-form-note")?.textContent ?? "") + (page.document.getElementById("game-refresh-message")?.textContent ?? ""), /changed|review|choose|team|roster/i);
    dispatchSubmit(controls.form); await flushAsync(); assert.equal(apiState.goalEvents.size, 1);
  } finally { closeUx10Page(page); }
});

for (const change of ["edited", "deleted"] as const) {
  test(`ux10 externally ${change} goal keeps the correction draft but blocks stale submission`, async () => {
    const apiState = createMockApiState(); seedUx10Game(apiState); seedLiveGoalEvent(apiState, "ux10-match", "editing-original");
    const page = await bootUx10Page(apiState);
    try {
      const edit = page.document.querySelector('[data-action="edit-goal"]'); assert(edit instanceof page.window.HTMLButtonElement); dispatchClick(edit);
      const controls = liveGoalControls(page); controls.scorer.value = "player-bea"; controls.scorer.dispatchEvent(new page.window.Event("change", { bubbles: true })); controls.scorer.focus();
      if (change === "deleted") apiState.goalEvents.delete("editing-original");
      else Object.assign(apiState.goalEvents.get("editing-original")!, { scorerPlayerId: "player-cy", scoringTeamId: "blue", concedingTeamId: "yellow", updatedAt: "2026-03-28T11:02:00.000Z" });
      await advanceUx10(page, 5000);
      assert.equal(controls.scorer.value, "player-bea"); assert.equal(goalTeamValue(controls.scoring), "red");
      assert.equal(controls.cancel.hidden, false); assert.equal(controls.save.disabled, true); assert.equal(page.document.activeElement, controls.scorer);
      assert.match((page.document.getElementById("goal-form-note")?.textContent ?? "") + (page.document.getElementById("game-refresh-message")?.textContent ?? ""), /changed|removed|deleted|review/i);
      dispatchSubmit(controls.form); await flushAsync();
      assert.equal(apiState.goalEvents.get("editing-original")?.scorerPlayerId, change === "deleted" ? undefined : "player-cy");
      assert.equal(page.window.location.hash, "#score");
    } finally { closeUx10Page(page); }
  });
}

test("ux10 delayed pre-write goal read cannot roll back a confirmed local goal", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
  let holdNext = false; let release: (() => void) | undefined; let heldSignal: AbortSignal | null | undefined;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    if (holdNext && init.method === "GET" && new URL(String(input)).pathname.endsWith("/goals")) {
      holdNext = false; heldSignal = init.signal;
      const snapshot = await base(input, init);
      return new Promise<Response>(resolve => { release = () => resolve(snapshot); });
    }
    return base(input, init);
  } });
  try {
    holdNext = true; await advanceUx10(page, 5000); assert(release);
    const controls = liveGoalControls(page); controls.draft(); dispatchSubmit(controls.form); await flushAsync();
    assert.equal(apiState.goalEvents.size, 1);
    const eventId = [...apiState.goalEvents.keys()][0];
    assert.equal(page.document.querySelector('[data-ui="goal-event"]')?.getAttribute("data-event-id"), eventId);
    assert.equal(heldSignal?.aborted, true, "a local mutation invalidates and aborts earlier background ownership");
    release(); await flushAsync();
    assert.equal(page.document.querySelector('[data-ui="goal-event"]')?.getAttribute("data-event-id"), eventId);
    assert.equal(page.document.querySelectorAll('[data-ui="goal-event"]').length, 1);
    assert.equal(goalTeamValue(controls.scoring), "");
    assert.equal(page.document.getElementById("setup-status")?.textContent, "Goal recorded.");
    assert.equal(page.window.location.hash, "#score");
  } finally { closeUx10Page(page); }
});

for (const kind of ["create", "edit", "delete", "undo"] as const) {
  test(`ux10 background refresh cannot settle an uncertain ${kind} or change its exact retry`, async () => {
    const apiState = createMockApiState(); seedUx10Game(apiState);
    if (kind !== "create") seedLiveGoalEvent(apiState, "ux10-match", "original-goal");
    const base = createMockFetch(apiState);
    const writes: Array<{ method: string; path: string; body: string; key: string | null }> = [];
    let committed: Response | undefined;
    const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname; const method = init.method ?? "GET";
      if (path.includes("/goals") && method !== "GET") {
        writes.push({ method, path, body: String(init.body), key: readInitHeader(init, "idempotency-key") });
        if (writes.length === 1) { committed = await base(input, init); return createJsonResponse(503, { error: "unavailable" }); }
        assert(committed); return committed.clone();
      }
      return base(input, init);
    } });
    try {
      const controls = liveGoalControls(page);
      if (kind === "create") { controls.draft(); dispatchSubmit(controls.form); }
      if (kind === "edit") {
        const edit = page.document.querySelector('[data-action="edit-goal"]'); assert(edit instanceof page.window.HTMLButtonElement); dispatchClick(edit);
        controls.scorer.value = "player-bea"; controls.scorer.dispatchEvent(new page.window.Event("change", { bubbles: true })); dispatchSubmit(controls.form);
      }
      if (kind === "delete") { const remove = page.document.querySelector('[data-action="delete-goal"]'); assert(remove instanceof page.window.HTMLButtonElement); dispatchClick(remove); }
      if (kind === "undo") dispatchClick(controls.undo);
      await flushAsync(); assert.equal(writes.length, 1); assert(writes[0].key);
      const originalDraft = { scoring: goalTeamValue(controls.scoring), conceding: goalTeamValue(controls.conceding), scorer: controls.scorer.value };
      assert.equal(controls.retry.hidden, false);
      seedLiveGoalEvent(apiState, "ux10-match", "newer-other-client-goal", 55);
      await advanceUx10(page, 15000);
      assert.equal(writes.length, 1, "read freshness never submits another goal mutation");
      assert.equal(controls.retry.hidden, false); assert.equal(controls.save.disabled, true);
      assert.deepEqual({ scoring: goalTeamValue(controls.scoring), conceding: goalTeamValue(controls.conceding), scorer: controls.scorer.value }, originalDraft);
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Could not confirm/);
      dispatchClick(controls.retry); await flushAsync();
      assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
      if (kind === "undo") assert.equal(JSON.parse(writes[1].body).expectedEventId, "original-goal");
      if (kind === "edit" || kind === "delete") assert.equal(writes[1].path, "/v1/games/ux10-match/goals/original-goal");
      assert.equal(apiState.goalEvents.has("newer-other-client-goal"), true);
      assert.equal(controls.retry.hidden, true);
    } finally { closeUx10Page(page); }
  });
}

test("ux10 background positive clock read does not settle an unresolved explicit clock check", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState, "scheduled"); const base = createMockFetch(apiState);
  let lost = false; let failReconciliation = false; let posts = 0;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (init.method === "POST" && path.endsWith("/thirds/1/start")) {
      posts += 1; await base(input, init); lost = true; failReconciliation = true; return createJsonResponse(503, { error: "unavailable" });
    }
    if (failReconciliation && init.method === "GET" && path === "/v1/games/ux10-match") {
      failReconciliation = false; return createJsonResponse(503, { error: "unavailable" });
    }
    return base(input, init);
  } });
  try {
    const start = page.document.querySelector('[data-action="start-active-third"]'); const check = page.document.querySelector('[data-action="refresh-game-state"]');
    assert(start instanceof page.window.HTMLButtonElement && check instanceof page.window.HTMLButtonElement);
    dispatchClick(start); await flushAsync(); assert(lost); assert.equal(posts, 1); assert.equal(check.hidden, false);
    await advanceUx10(page, 15000);
    assert.equal(posts, 1); assert.equal(check.hidden, false, "only the explicit Check clock interaction may settle this operation");
    assert.equal(liveGoalControls(page).save.disabled, true);
    dispatchClick(check); await flushAsync(); assert.equal(posts, 1); assert.equal(check.hidden, true);
    assert.equal(page.document.querySelector('[data-action="finish-active-third"]')?.textContent, "Finish Third 1");
    seedLiveGoalEvent(apiState, "ux10-match", "after-clock-recovery"); await advanceUx10(page, 15000);
    assert.equal(page.document.querySelector('[data-ui="goal-event"]')?.getAttribute("data-event-id"), "after-clock-recovery",
      "explicit clock GET recovery must also release any refresh barrier owned by that clock operation");
    assert.equal(posts, 1);
  } finally { closeUx10Page(page); }
});

test("ux10 failed background reads retain truthful stale data and explicit retry recovers", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); seedLiveGoalEvent(apiState, "ux10-match", "known-goal");
  const base = createMockFetch(apiState); let fail = false; let failingReads = 0; let writes = 0;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    if (init.method && init.method !== "GET") writes += 1;
    if (fail && new URL(String(input)).pathname.endsWith("/goals")) { failingReads += 1; return createJsonResponse(503, { error: "unavailable" }); }
    return base(input, init);
  } });
  try {
    const previous = ux10Scores(page); fail = true; await advanceUx10(page, 5000);
    const notice = page.document.getElementById("game-refresh-notice"); const retry = page.document.querySelector('[data-action="retry-game-updates"]');
    assert(notice instanceof page.window.HTMLElement && retry instanceof page.window.HTMLButtonElement);
    assert.equal(interactionVisible(notice), true); assert.match(notice.textContent ?? "", /update|refresh|connect|latest|try/i);
    assert.equal(failingReads, 1); if (ux10Scores(page).length) assert.deepEqual(ux10Scores(page), previous);
    assert.doesNotMatch(page.document.getElementById("goal-timeline")?.textContent ?? "", /No goals yet/);
    fail = false; seedLiveGoalEvent(apiState, "ux10-match", "new-goal", 55);
    retry.focus(); dispatchClick(retry); dispatchClick(retry); await flushAsync();
    assert.equal(page.document.querySelectorAll('[data-ui="goal-event"]').length, 2);
    assert.equal(interactionVisible(notice), false); assert.equal(writes, 0);
  } finally { closeUx10Page(page); }
});

test("ux10 one hung refresh times out without overlapping until its fetch actually settles", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
  let armed = false; let held = 0; let signal: AbortSignal | null | undefined; let release: (() => void) | undefined;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    if (armed && new URL(String(input)).pathname === "/v1/games/ux10-match") {
      held += 1; signal = init.signal; const snapshot = await base(input, init);
      return new Promise<Response>(resolve => { release = () => resolve(snapshot); });
    }
    return base(input, init);
  } });
  try {
    apiState.games.get("ux10-match")!.gameStartTs = "2030-04-01T10:00:00.000Z";
    armed = true; await advanceUx10(page, 5000); assert.equal(held, 1); assert(release); assert(signal);
    await advanceUx10(page, 11999); assert.equal(signal.aborted, false); assert.equal(held, 1);
    await advanceUx10(page, 1); assert.equal(signal.aborted, true);
    const notice = page.document.getElementById("game-refresh-notice"); assert(notice instanceof page.window.HTMLElement); assert.equal(interactionVisible(notice), true);
    await advanceUx10(page, 60000); assert.equal(held, 1, "abort does not imply actual fetch settlement");
    const retry = page.document.querySelector('[data-action="retry-game-updates"]'); assert(retry instanceof page.window.HTMLButtonElement);
    dispatchClick(retry); await flushAsync(); assert.equal(held, 1);
    seedLiveGoalEvent(apiState, "ux10-match", "after-timeout");
    apiState.games.get("ux10-match")!.gameStartTs = "2040-04-01T10:00:00.000Z";
    const observedTitles: string[] = [];
    const observer = new page.window.MutationObserver(() => { observedTitles.push(page.document.getElementById("game-title")?.textContent ?? ""); });
    observer.observe(page.document.getElementById("game-title")!, { childList: true, subtree: true });
    armed = false; release(); await flushAsync();
    assert.equal(observedTitles.includes(expectedLocalDateHeading("2030-04-01T10:00:00.000Z")), false, "the expired batch never renders before its queued replacement");
    assert.equal(page.document.querySelector('[data-ui="goal-event"]')?.getAttribute("data-event-id"), "after-timeout");
    assert.equal(page.document.getElementById("game-title")?.textContent, expectedLocalDateHeading("2040-04-01T10:00:00.000Z"));
    assert.equal(interactionVisible(notice), false);
    observer.disconnect();
  } finally { closeUx10Page(page); }
});

test("ux10 repeated failures back off within one bounded scheduled refresh", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState); let fail = false; let reads = 0;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    if (fail && new URL(String(input)).pathname === "/v1/games/ux10-match") { reads += 1; return createJsonResponse(503, { error: "unavailable" }); }
    return base(input, init);
  } });
  try {
    fail = true; await advanceUx10(page, 5000); assert.equal(reads, 1);
    let previousDelay = 5000;
    for (const expectedReads of [2, 3, 4, 5]) {
      const delays = page.timers.pendingDelays(); assert.equal(delays.length, 1);
      const delay = delays[0]; assert(delay >= previousDelay && delay <= 60000); previousDelay = delay;
      await advanceUx10(page, delay - 1); assert.equal(reads, expectedReads - 1);
      await advanceUx10(page, 1); assert.equal(reads, expectedReads);
    }
    assert(page.timers.pendingDelays()[0] <= 60000); assert.equal(page.timers.pendingCount(), 1);
  } finally { closeUx10Page(page); }
});

test("ux10 hidden and page lifecycle stop scheduling and foreground refresh runs once", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState); const reads: string[] = [];
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => { reads.push(new URL(String(input)).pathname); return base(input, init); } });
  try {
    const initial = reads.length; setUx10Visible(page, false);
    await advanceUx10(page, 60000); assert.equal(reads.length, initial); assert.equal(page.timers.pendingCount(), 0);
    seedLiveGoalEvent(apiState, "ux10-match", "while-hidden");
    setUx10Visible(page, true); page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
    assert.equal(page.document.querySelector('[data-ui="goal-event"]')?.getAttribute("data-event-id"), "while-hidden");
    assert.equal(reads.slice(initial).filter(path => path === "/v1/auth/session").length, 2, "full refresh checks session before reading and again before applying");
    assert.equal(reads.slice(initial).filter(path => path.endsWith("/goals")).length, 1);
    assert.equal(page.timers.pendingCount(), 1);
    page.window.dispatchEvent(new page.window.PageTransitionEvent("pagehide", { persisted: true })); const afterHide = reads.length;
    await advanceUx10(page, 60000); assert.equal(reads.length, afterHide); assert.equal(page.timers.pendingCount(), 0);
    page.window.dispatchEvent(new page.window.PageTransitionEvent("pageshow", { persisted: true })); await flushAsync();
    assert.equal(reads.length, afterHide, "BFCache recovery belongs to the existing account reload boundary, not the polling coordinator");
    assert.deepEqual(page.navigations, [{ url: "/games/ux10-match#score", mode: "reload" }]);
    assert.equal(page.timers.pendingCount(), 0);
  } finally { closeUx10Page(page); }
});

test("ux10 live cadence separates frequent game reads from serial full capability and roster reads", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
  const paths: string[] = []; let observe = false; let active = 0; let peak = 0;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    if (!observe) return base(input, init);
    active += 1; peak = Math.max(peak, active); paths.push(new URL(String(input)).pathname);
    try { return await base(input, init); } finally { active -= 1; }
  } });
  try {
    observe = true; await advanceUx10(page, 5000);
    assert.equal(paths.filter(path => path.endsWith("/goals")).length, 1);
    assert.equal(paths.filter(path => path === "/v1/auth/session").length, 1, "even a short batch checks the current session before apply");
    assert.equal(paths.filter(path => path.endsWith("/roster")).length, 0);
    await advanceUx10(page, 5000);
    assert.equal(paths.filter(path => path.endsWith("/goals")).length, 2);
    assert.equal(paths.filter(path => path === "/v1/auth/session").length, 2);
    await advanceUx10(page, 5000);
    assert.equal(paths.filter(path => path.endsWith("/goals")).length, 3);
    assert.equal(paths.filter(path => path === "/v1/auth/session").length, 4, "the full batch adds both its initial and final session probes");
    assert.equal(paths.filter(path => path === "/v1/leagues/three-sided-football-club").length, 1);
    assert.equal(paths.filter(path => path.endsWith("/roster")).length, 1);
    assert.equal(peak, 1, "the background batch issues one request at a time"); assert.equal(active, 0);
    assert.equal(page.timers.pendingCount(), 1);
  } finally { closeUx10Page(page); }
});

for (const change of ["viewer", "expired", "different-account", "different-session"] as const) {
  test(`ux10 ${change} refresh clears private authority without transferring the existing draft`, async () => {
    const apiState = createMockApiState(); seedUx10Game(apiState);
    apiState.players.get("player-ari")!.claimedByUserId = "private-player@example.com";
    const base = createMockFetch(apiState); let writes = 0;
    const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
      if (init.method && init.method !== "GET") writes += 1;
      return base(input, init);
    } });
    try {
      const controls = liveGoalControls(page); controls.draft(); controls.scorer.focus();
      assert(page.document.querySelector('[data-action="grant-player-access"]'), "fixture initially has genuinely verified administrator enrichment");
      if (change === "viewer") grantMockLeagueAccess(apiState, "three-sided-football-club", apiState.session!.email, "viewer");
      else if (change === "expired") { apiState.session = null; apiState.cookieJar = ""; }
      else {
        const email = change === "different-account" ? "another-organiser@example.com" : apiState.session!.email;
        apiState.session = { ...apiState.session!, sessionId: "replacement-session", email };
        apiState.cookieJar = "threefc_session=replacement-session";
        grantMockLeagueAccess(apiState, "three-sided-football-club", email, "admin");
      }
      await advanceUx10(page, 15000);
      assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
      assert.equal(page.document.querySelector('[data-ui="claim-badge"]'), null);
      assert.equal(controls.scorer.value, "player-ari", "draft contents are not silently discarded on authority loss");
      assert.equal(goalTeamValue(controls.scoring), "red"); assert.equal(goalTeamValue(controls.conceding), "blue");
      assert.equal(controls.save.disabled, true);
      controls.save.disabled = false; dispatchSubmit(controls.form); await flushAsync();
      assert.equal(writes, 0, "reenabling a DOM control cannot reuse prior session authority");
      assert.equal(apiState.goalEvents.size, 0);
      assert.doesNotMatch(page.document.getElementById("roster-teams")?.innerHTML ?? "", /private-player@example/);
      if (change !== "viewer") {
        const notice = page.document.getElementById("game-refresh-notice"); assert(notice instanceof page.window.HTMLElement);
        assert.equal(interactionVisible(notice), true); assert.match(notice.textContent ?? "", /sign|account|session|reload/i);
      }
    } finally { closeUx10Page(page); }
  });
}

test("ux10 a viewer receives refreshed public teams without operator search or mutation controls", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState, "live", "viewer"); const base = createMockFetch(apiState);
  const paths: string[] = [];
  const page = await bootUx10Page(apiState, { mode: "teams", fetch: async (input, init = {}) => { paths.push(new URL(String(input)).pathname); return base(input, init); } });
  try {
    apiState.roster.get("ux10-match:player-ari")!.teamId = "yellow";
    await advanceUx10(page, 15000);
    const row = ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari"); assert.equal(row.length, 1);
    assert.equal(row[0].closest('[data-ui="roster-team"]')?.getAttribute("data-team-id"), "yellow");
    assert.equal(paths.filter(path => path === "/v1/players" || path === "/v1/games/ux10-match/players").length, 0);
    assert.equal(page.document.querySelector('[data-action="assign-player"]'), null);
    assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
    assert.equal(page.window.location.hash, "#teams");
  } finally { closeUx10Page(page); }
});

test("ux10 refresh preserves a finished correction opt-in and its unchanged historical draft", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); seedLiveGoalEvent(apiState, "ux10-match", "historical-goal");
  const game = apiState.games.get("ux10-match")!; game.status = "finished"; refreshMockFinishedResult(apiState, game, "2026-03-28T11:04:00.000Z");
  const page = await bootUx10Page(apiState, { mode: "results" });
  try {
    enterFinishedCorrections(page);
    const edit = page.document.querySelector('[data-action="edit-goal"]'); assert(edit instanceof page.window.HTMLButtonElement); dispatchClick(edit);
    const controls = liveGoalControls(page); controls.scorer.value = "player-bea"; controls.scorer.dispatchEvent(new page.window.Event("change", { bubbles: true })); controls.scorer.focus();
    await advanceUx10(page, 15000);
    assert.equal(page.window.location.hash, "#score"); assert.equal(page.document.getElementById("finished-correction-actions")?.hidden, false);
    assert.equal(controls.scorer.value, "player-bea"); assert.equal(controls.save.disabled, false); assert.equal(controls.cancel.hidden, false);
    assert.equal(page.document.activeElement, controls.scorer);
    assert.equal(apiState.goalEvents.get("historical-goal")?.scorerPlayerId, "player-ari");
  } finally { closeUx10Page(page); }
});

test("ux10 background finished snapshot cannot retire a lost finish request or rotate its key", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const game = apiState.games.get("ux10-match")!;
  for (const third of game.thirds) { third.startedAt = "2026-03-28T11:00:10.000Z"; third.finishedAt = "2026-03-28T11:00:11.000Z"; }
  const base = createMockFetch(apiState); const requests: Array<{ path: string; key: string | null }> = [];
  let cached: Response | undefined; let failReconciliation = false;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (init.method === "POST" && path.endsWith("/finish")) {
      requests.push({ path, key: readInitHeader(init, "idempotency-key") });
      if (requests.length === 1) { cached = await base(input, init); failReconciliation = true; return createJsonResponse(503, { error: "unavailable" }); }
      assert(cached); return cached.clone();
    }
    if (failReconciliation && path === "/v1/games/ux10-match") { failReconciliation = false; return createJsonResponse(503, { error: "unavailable" }); }
    return base(input, init);
  } });
  try {
    const finish = page.document.querySelector('[data-action="finish-game"]'); assert(finish instanceof page.window.HTMLButtonElement);
    dispatchClick(finish); await flushAsync(); assert.equal(requests.length, 1); assert(requests[0].key);
    assert.equal(apiState.games.get("ux10-match")?.status, "finished");
    await advanceUx10(page, 15000);
    assert.equal(requests.length, 1); assert.equal(finish.textContent, "Retry finish game"); assert.equal(finish.disabled, false);
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed/);
    dispatchClick(finish); await flushAsync(); assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
    assert.equal(finish.textContent, "Game finished");
  } finally { closeUx10Page(page); }
});

test("ux10 hidden held read is discarded and foreground keeps later navigation and focus", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
  let holdNext = false; let release: (() => void) | undefined; let signal: AbortSignal | null | undefined; let held = 0;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    if (holdNext && new URL(String(input)).pathname.endsWith("/goals")) {
      holdNext = false; held += 1; signal = init.signal; const snapshot = await base(input, init);
      return new Promise<Response>(resolve => { release = () => resolve(snapshot); });
    }
    return base(input, init);
  } });
  try {
    seedLiveGoalEvent(apiState, "ux10-match", "discarded-hidden-snapshot"); holdNext = true;
    await advanceUx10(page, 5000); assert(release); assert(signal);
    setUx10Visible(page, false); assert.equal(signal.aborted, true);
    apiState.goalEvents.delete("discarded-hidden-snapshot"); seedLiveGoalEvent(apiState, "ux10-match", "fresh-foreground", 55);
    setUx10Visible(page, true); page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
    assert.equal(held, 1);
    const navigation = qaGameNavigation(page); dispatchClick(navigation.teams); dispatchClick(navigation.score); dispatchClick(navigation.teams);
    const search = qaGameNavigation(page).teams; search.focus();
    const appliedIds: string[] = [];
    const observer = new page.window.MutationObserver(() => {
      for (const row of page.document.querySelectorAll('[data-ui="goal-event"]')) appliedIds.push(row.getAttribute("data-event-id") ?? "");
    });
    observer.observe(page.document.getElementById("goal-timeline")!, { childList: true, subtree: true });
    release(); await flushAsync();
    assert.equal(appliedIds.includes("discarded-hidden-snapshot"), false, "an invalidated batch must not briefly render before its replacement");
    assert.equal(page.document.querySelector('[data-ui="goal-event"]')?.getAttribute("data-event-id"), "fresh-foreground");
    assert.equal(page.window.location.hash, "#teams"); assert.equal(page.document.activeElement, search);
    assert.equal(page.timers.pendingCount(), 1); observer.disconnect();
  } finally { closeUx10Page(page); }
});

for (const authority of ["different-session", "viewer"] as const) {
  test(`ux10 a late pre-finish administrator read cannot reverse a newer ${authority} decision`, async () => {
    const apiState = createMockApiState(); seedUx10Game(apiState);
    const game = apiState.games.get("ux10-match")!;
    for (const third of game.thirds) { third.startedAt = "2026-03-28T11:00:10.000Z"; third.finishedAt = "2026-03-28T11:00:11.000Z"; }
    apiState.players.get("player-ari")!.claimedByUserId = "private-player@example.com";
    const base = createMockFetch(apiState); let holdAccess = false; let release: (() => void) | undefined;
    let privateReads = 0; let writes = 0;
    const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (init.method && init.method !== "GET") writes += 1;
      if (path === "/v1/games/ux10-match/players") privateReads += 1;
      if (init.method === "POST" && path.endsWith("/finish")) holdAccess = true;
      if (holdAccess && init.method === "GET" && path === "/v1/leagues/three-sided-football-club") {
        holdAccess = false; const oldAdmin = await base(input, init);
        return new Promise<Response>(resolve => { release = () => resolve(oldAdmin); });
      }
      return base(input, init);
    } });
    try {
      assert(page.document.querySelector('[data-action="grant-player-access"]'));
      const finish = page.document.querySelector('[data-action="finish-game"]'); assert(finish instanceof page.window.HTMLButtonElement);
      dispatchClick(finish); await flushAsync(); assert(release); assert.equal(writes, 1);
      if (authority === "viewer") grantMockLeagueAccess(apiState, game.leagueId, apiState.session!.email, "viewer");
      else {
        apiState.session = { ...apiState.session!, sessionId: "new-account-session" };
        apiState.cookieJar = "threefc_session=new-account-session";
      }
      page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
      const readsAfterDecision = privateReads;
      assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
      release(); await flushAsync();
      assert.equal(privateReads, readsAfterDecision, "a held old administrator response cannot authorize a new private player lookup");
      assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
      assert.equal(page.document.querySelector('[data-ui="claim-badge"]'), null);
      const correct = page.document.querySelector('[data-action="correct-finished-result"]'); assert(correct instanceof page.window.HTMLButtonElement);
      assert.equal(interactionVisible(correct), false);
      correct.hidden = false; correct.disabled = false; dispatchClick(correct);
      assert.equal(page.document.getElementById("finished-correction-actions")?.hidden, true);
      assert.equal(liveGoalControls(page).save.disabled, true); assert.equal(writes, 1);
      assert.doesNotMatch(page.document.getElementById("roster-teams")?.innerHTML ?? "", /private-player@example/);
    } finally { closeUx10Page(page); }
  });
}

test("ux10 a changed session cannot use the unresolved clock read to settle the old account operation", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState, "scheduled"); const base = createMockFetch(apiState);
  let posts = 0; let gameReads = 0; let failReconciliation = false;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (init.method === "POST" && path.endsWith("/thirds/1/start")) {
      posts += 1; await base(input, init); failReconciliation = true; return createJsonResponse(503, { error: "unavailable" });
    }
    if (init.method === "GET" && path === "/v1/games/ux10-match") {
      gameReads += 1;
      if (failReconciliation) { failReconciliation = false; return createJsonResponse(503, { error: "unavailable" }); }
    }
    return base(input, init);
  } });
  try {
    const start = page.document.querySelector('[data-action="start-active-third"]'); const check = page.document.querySelector('[data-action="refresh-game-state"]');
    assert(start instanceof page.window.HTMLButtonElement && check instanceof page.window.HTMLButtonElement);
    dispatchClick(start); await flushAsync(); assert.equal(posts, 1); assert.equal(check.hidden, false);
    apiState.session = { ...apiState.session!, sessionId: "replacement-session" }; apiState.cookieJar = "threefc_session=replacement-session";
    page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
    const readsAtLock = gameReads;
    assert.match(page.document.getElementById("game-refresh-message")?.textContent ?? "", /sign-in changed/);
    check.disabled = false; dispatchClick(check); await flushAsync();
    assert.equal(gameReads, readsAtLock, "synthetic enabling cannot cause a reconciliation GET under a new session");
    assert.equal(posts, 1); assert.equal(check.hidden, false, "an account lock does not retire the old unresolved operation");
    assert.equal(liveGoalControls(page).save.disabled, true);
  } finally { closeUx10Page(page); }
});

for (const defect of ["missing-third", "invalid-third-order", "inconsistent-winner"] as const) {
  test(`ux10 ${defect} rejects the complete refresh batch without presenting mixed snapshots`, async () => {
    const apiState = createMockApiState(); seedUx10Game(apiState); seedLiveGoalEvent(apiState, "ux10-match", "last-known-goal");
    const base = createMockFetch(apiState); let corrupt = false;
    let originalResult: GameResult | undefined;
    const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
      const response = await base(input, init);
      if (corrupt && init.method === "GET" && new URL(String(input)).pathname === "/v1/games/ux10-match") {
        const game = await response.json() as MockGame & { timer?: { thirds: Array<ThirdTimerSegment & { status: string }> } };
        if (defect === "missing-third") { game.thirds = game.thirds.slice(0, 2); if (game.timer) game.timer.thirds = game.timer.thirds.slice(0, 2); }
        else if (defect === "invalid-third-order") {
          game.thirds[1].startedAt = "2026-03-28T11:00:20.000Z";
          if (game.timer) Object.assign(game.timer.thirds[1], { startedAt: "2026-03-28T11:00:20.000Z", status: "running" });
        } else if (game.result) {
          originalResult = structuredClone(game.result);
          game.result.outcome = "win"; game.result.winnerTeamId = "blue";
        }
        return createJsonResponse(200, game);
      }
      return response;
    } });
    try {
      const oldTitle = page.document.getElementById("game-title")?.textContent;
      const oldStatus = page.document.getElementById("game-overview-status")?.textContent;
      const oldScores = ux10Scores(page);
      const game = apiState.games.get("ux10-match")!; game.gameStartTs = "2031-04-01T10:00:00.000Z";
      seedLiveGoalEvent(apiState, "ux10-match", "unaccepted-remote-goal", 55);
      apiState.roster.get("ux10-match:player-ari")!.teamId = "yellow";
      if (defect === "inconsistent-winner") {
        for (const third of game.thirds) { third.startedAt = "2026-03-28T11:00:10.000Z"; third.finishedAt = "2026-03-28T11:00:11.000Z"; }
        game.status = "finished"; refreshMockFinishedResult(apiState, game, "2026-03-28T11:04:00.000Z");
      }
      corrupt = true; page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
      if (defect === "inconsistent-winner") {
        // Assert outside fetch: an assertion thrown inside a read would itself
        // become a caught transport failure and could make this test pass.
        assert(originalResult, "the actual successful GET supplied a finished result to corrupt");
        assert.equal(originalResult.comparator, "fewest_conceded_then_most_scored");
        assert.equal(originalResult.winnerTeamId, "red", "only a valid baseline winner is changed to the wrong, but valid-enum, team");
      }
      const notice = page.document.getElementById("game-refresh-notice"); assert(notice instanceof page.window.HTMLElement);
      assert.equal(interactionVisible(notice), true); assert.match(notice.textContent ?? "", /Updates unavailable/);
      assert.equal(page.document.getElementById("game-title")?.textContent, oldTitle);
      assert.equal(page.document.getElementById("game-overview-status")?.textContent, oldStatus);
      assert.deepEqual(ux10Scores(page), oldScores);
      assert.deepEqual([...page.document.querySelectorAll('[data-ui="goal-event"]')].map(row => row.getAttribute("data-event-id")), ["last-known-goal"]);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari")[0]?.closest('[data-ui="roster-team"]')?.getAttribute("data-team-id"), "red");
      assert.equal(page.window.location.hash, "#score");
    } finally { closeUx10Page(page); }
  });
}

for (const lifecycle of ["hidden", "pagehide"] as const) {
  test(`ux10 ${lifecycle} during a goal write prevents its late completion from restarting clock ticks`, async () => {
    const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
    const activeIntervals = new Set<number>(); let createdIntervals = 0; let release: (() => void) | undefined;
    const page = await bootUx10Page(apiState, {
      captureInterval: () => { const id = ++createdIntervals; activeIntervals.add(id); return id; },
      captureClearInterval: id => { activeIntervals.delete(id); },
      fetch: async (input, init = {}) => {
        if (init.method === "POST" && new URL(String(input)).pathname.endsWith("/goals")) {
          const committed = await base(input, init); return new Promise<Response>(resolve => { release = () => resolve(committed); });
        }
        return base(input, init);
      },
    });
    try {
      assert.equal(activeIntervals.size, 1);
      const controls = liveGoalControls(page); controls.draft(); dispatchSubmit(controls.form); await flushAsync(); assert(release);
      if (lifecycle === "hidden") setUx10Visible(page, false);
      else page.window.dispatchEvent(new page.window.Event("pagehide"));
      assert.equal(activeIntervals.size, 0); const createdAtHide = createdIntervals;
      release(); await flushAsync();
      assert.equal(apiState.goalEvents.size, 1); assert.equal(controls.retry.hidden, true);
      assert.equal(createdIntervals, createdAtHide, "mutation refresh/finally rendering cannot resurrect a suspended one-second clock interval");
      assert.equal(activeIntervals.size, 0); assert.equal(page.timers.pendingCount(), 0);
    } finally { closeUx10Page(page); }
  });
}

test("ux10 visibility and repeated focus signals coalesce while the foreground authority read is pending", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
  let armed = false; let release: (() => void) | undefined; const reads: string[] = [];
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (armed) {
      reads.push(path);
      if (path === "/v1/auth/session" && !release) {
        const response = await base(input, init); return new Promise<Response>(resolve => { release = () => resolve(response); });
      }
    }
    return base(input, init);
  } });
  try {
    setUx10Visible(page, false); armed = true; setUx10Visible(page, true);
    page.window.dispatchEvent(new page.window.Event("focus")); page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
    assert(release); assert.deepEqual(reads, ["/v1/auth/session"]);
    release(); await flushAsync();
    assert.equal(reads.filter(path => path === "/v1/auth/session").length, 2, "coalesced foreground work is one full batch with a pre-apply session fence");
    assert.equal(reads.filter(path => path === "/v1/games/ux10-match").length, 1);
    assert.equal(reads.filter(path => path.endsWith("/goals")).length, 1);
    assert.equal(reads.filter(path => path.endsWith("/roster")).length, 1);
    assert.equal(page.timers.pendingCount(), 1);
  } finally { closeUx10Page(page); }
});

test("ux10 foreground signals during initial game loading cannot start a competing refresh", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
  let gameReads = 0; let release: (() => void) | undefined;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    if (init.method === "GET" && new URL(String(input)).pathname === "/v1/games/ux10-match") {
      gameReads += 1;
      if (gameReads === 1) { const response = await base(input, init); return new Promise<Response>(resolve => { release = () => resolve(response); }); }
    }
    return base(input, init);
  } });
  try {
    assert(release); assert.equal(gameReads, 1);
    page.window.dispatchEvent(new page.window.Event("focus")); setUx10Visible(page, false); setUx10Visible(page, true); await flushAsync();
    assert.equal(gameReads, 1); assert.equal(page.timers.pendingCount(), 0);
    release(); await flushAsync();
    assert.equal(page.document.getElementById("game-overview-status")?.textContent, "Live");
    assert.equal(gameReads, 2, "foreground revalidation is queued until initial loading completes, never overlapped with it");
    assert.equal(page.timers.pendingCount(), 1);
  } finally { closeUx10Page(page); }
});

test("ux10 removing the game root stops the remaining recurring refresh", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState); let reads = 0;
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => { reads += 1; return base(input, init); } });
  try {
    page.document.getElementById("setup-flow-root")?.remove(); await flushAsync();
    const readsAtRemoval = reads; await advanceUx10(page, 60000);
    assert.equal(reads, readsAtRemoval); assert.equal(page.timers.pendingCount(), 0);
  } finally { closeUx10Page(page); }
});

test("ux10 uncertain metadata is reload-required and cannot be superseded by a changed same-path payload", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState, "scheduled"); const base = createMockFetch(apiState);
  const writes: Array<{ path: string; method: string; body: string }> = [];
  const page = await bootUx10Page(apiState, { mode: "overview", fetch: async (input, init = {}) => {
    if (init.method && init.method !== "GET") {
      writes.push({ path: new URL(String(input)).pathname, method: init.method, body: String(init.body) });
      const result = await base(input, init); return writes.length === 1 ? createJsonResponse(503, { error: "unavailable" }) : result;
    }
    return base(input, init);
  } });
  try {
    const toggle = page.document.querySelector('[data-action="toggle-game-edit"]'); const field = page.document.getElementById("game-edit-kickoff"); const form = page.document.getElementById("game-edit-form");
    assert(toggle instanceof page.window.HTMLButtonElement && field instanceof page.window.HTMLInputElement && form instanceof page.window.HTMLFormElement);
    const previousOverview = page.document.getElementById("game-overview-kickoff")?.textContent;
    dispatchClick(toggle); field.value = "2030-04-01T10:30"; field.dispatchEvent(new page.window.Event("input", { bubbles: true })); dispatchSubmit(form); await flushAsync();
    assert.equal(writes.length, 1); assert.equal(field.value, "2030-04-01T10:30"); assert.equal(page.document.getElementById("game-edit-region")?.hidden, false);
    const uncertainty = page.document.getElementById("setup-error")?.textContent; assert.match(uncertainty ?? "", /could not be confirmed/);
    apiState.games.get("ux10-match")!.gameStartTs = "2031-04-01T10:30:00.000Z";
    page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync(); await advanceUx10(page, 15000);
    assert.equal(writes.length, 1); assert.equal(field.value, "2030-04-01T10:30");
    assert.equal(page.document.getElementById("game-overview-kickoff")?.textContent, previousOverview);
    assert.equal(page.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
    assert.equal(page.document.getElementById("setup-error")?.textContent, uncertainty);
    const save = form.querySelector('[data-action="save-game"]');
    assert(save instanceof page.window.HTMLButtonElement);
    assert.equal(save.disabled, true, "there is no safe replay contract for ambiguous metadata writes");
    assert.equal(field.disabled, true);
    const originalRequest = structuredClone(writes[0]);
    assert.equal(JSON.parse(originalRequest.body).gameStartTs, new Date("2030-04-01T10:30").toISOString());
    // A changed body at the same method/path must not release the old write's
    // uncertainty, even if a consumer synthetically enables the native controls.
    field.disabled = false; field.value = "2032-04-01T10:30";
    field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    save.disabled = false; dispatchSubmit(form); await flushAsync();
    assert.equal(writes.length, 1, "same-path success is impossible because the changed write never reaches transport");
    assert.deepEqual(writes[0], originalRequest);
    apiState.games.get("ux10-match")!.gameStartTs = "2032-04-01T10:30:00.000Z";
    await advanceUx10(page, 15000);
    assert.equal(page.document.getElementById("game-overview-kickoff")?.textContent, previousOverview);
    assert.equal(writes.length, 1);
    const reload = page.document.querySelector('[data-action="retry-game-updates"]');
    assert(reload instanceof page.window.HTMLButtonElement);
    assert.equal(interactionVisible(reload), true); assert.equal(reload.textContent, "Reload game");
    const cancel = form.querySelector('[data-action="cancel-game-edit"]'); assert(cancel instanceof page.window.HTMLButtonElement);
    cancel.focus(); dispatchClick(cancel);
    assert.equal(page.document.getElementById("game-edit-region")?.hidden, true);
    assert.equal(page.document.activeElement, reload, "Cancel must restore visible recovery, not the now-hidden edit trigger");
    dispatchClick(reload); await flushAsync();
    assert.deepEqual(page.navigations, [{ url: "/games/ux10-match#overview", mode: "reload" }]);
    assert.equal(writes.length, 1, "recovery is a reload, not a second metadata mutation");
  } finally { closeUx10Page(page); }
});

test("ux10 uncertain assignment is reload-required and cannot be superseded by another team choice", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
  const writes: Array<{ path: string; method: string; body: string }> = [];
  const page = await bootUx10Page(apiState, { mode: "teams", fetch: async (input, init = {}) => {
    if (init.method && init.method !== "GET") {
      writes.push({ path: new URL(String(input)).pathname, method: init.method, body: String(init.body) });
      const response = await base(input, init); return writes.length === 1 ? createJsonResponse(503, { error: "unavailable" }) : response;
    }
    return base(input, init);
  } });
  try {
    const goalDraft = liveGoalControls(page); goalDraft.draft();
    const transfer = page.document.querySelector('[data-action="toggle-transfer"][data-player-id="player-ari"]'); assert(transfer instanceof page.window.HTMLButtonElement); dispatchClick(transfer);
    const yellow = page.document.querySelector('[data-action="assign-player"][data-player-id="player-ari"][data-team-id="yellow"]');
    const blue = page.document.querySelector('[data-action="assign-player"][data-player-id="player-ari"][data-team-id="blue"]');
    assert(yellow instanceof page.window.HTMLButtonElement && blue instanceof page.window.HTMLButtonElement);
    dispatchClick(yellow); await flushAsync(); assert.equal(writes.length, 1); assert.equal(apiState.roster.get("ux10-match:player-ari")?.teamId, "yellow");
    const uncertainty = page.document.getElementById("setup-error")?.textContent; assert.match(uncertainty ?? "", /Assignment could not be confirmed/);
    seedLiveGoalEvent(apiState, "ux10-match", "remote-during-assignment-uncertainty");
    page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync(); await advanceUx10(page, 15000);
    const rows = ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari"); assert.equal(rows.length, 1);
    assert.equal(rows[0].closest('[data-ui="roster-team"]')?.getAttribute("data-team-id"), "red");
    assert.equal(page.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
    assert.equal(page.document.getElementById("setup-error")?.textContent, uncertainty); assert.equal(writes.length, 1);
    assert.equal([...page.document.querySelectorAll<HTMLButtonElement>('[data-action="assign-player"]')].some(button => !button.disabled), false);
    const root = page.document.getElementById("setup-flow-root"); assert(root);
    if (!blue.isConnected) root.append(blue);
    blue.disabled = false; dispatchClick(blue); await flushAsync();
    assert.equal(goalDraft.scorer.value, "player-ari"); assert.equal(goalDraft.save.disabled, true);
    goalDraft.save.disabled = false; dispatchSubmit(goalDraft.form); await flushAsync();
    assert.equal(writes.length, 1, "a new body at the same assignment path cannot settle the uncertain Yellow write");
    assert.deepEqual(JSON.parse(writes[0].body), { teamId: "yellow" });
    assert.equal(apiState.roster.get("ux10-match:player-ari")?.teamId, "yellow", "the mock committed only the original assignment");
    assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari").length, 1);
    assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari")[0].closest('[data-ui="roster-team"]')?.getAttribute("data-team-id"), "red");
    await advanceUx10(page, 15000);
    assert.equal(page.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
    assert.equal(page.document.getElementById("game-refresh-notice")?.hidden, false);
    assert.equal(page.document.querySelector('[data-action="retry-game-updates"]')?.textContent, "Reload game");
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed|reload/i);
    assert.equal(writes.length, 1);
  } finally { closeUx10Page(page); }
});

test("ux10 uncertain access is reload-required and cannot be superseded by a different role at the same path", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState);
  apiState.players.get("player-ari")!.claimedByUserId = "ari-access@example.com";
  apiState.players.get("player-bea")!.claimedByUserId = "bea-access@example.com";
  const base = createMockFetch(apiState); const writes: Array<{ path: string; method: string; body: string }> = [];
  const page = await bootUx10Page(apiState, { mode: "teams", fetch: async (input, init = {}) => {
    if (init.method && init.method !== "GET") {
      writes.push({ path: new URL(String(input)).pathname, method: init.method, body: String(init.body) });
      const response = await base(input, init);
      return writes.length === 1 ? createJsonResponse(503, { error: "unavailable" }) : response;
    }
    return base(input, init);
  } });
  try {
    const scorer = page.document.querySelector('[data-action="grant-player-access"][data-player-id="player-ari"][data-role="scorekeeper"]');
    const admin = page.document.querySelector('[data-action="grant-player-access"][data-player-id="player-ari"][data-role="admin"]');
    const otherAdmin = page.document.querySelector('[data-action="grant-player-access"][data-player-id="player-bea"][data-role="admin"]');
    assert(scorer instanceof page.window.HTMLButtonElement && admin instanceof page.window.HTMLButtonElement && otherAdmin instanceof page.window.HTMLButtonElement);
    openActionMenuFor(scorer); dispatchClick(scorer); await flushAsync();
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].body), { userId: "ari-access@example.com", role: "scorekeeper" });
    assert.equal(apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "ari-access@example.com")), "scorekeeper");
    assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Access change could not be confirmed/);
    // Keep a real action reference: a lock may remove private actions entirely,
    // so reattach that formerly-authorized control to challenge delegated guards.
    const root = page.document.getElementById("setup-flow-root"); assert(root);
    if (!admin.isConnected) root.append(admin);
    admin.hidden = false; admin.disabled = false; dispatchClick(admin); await flushAsync();
    if (!otherAdmin.isConnected) root.append(otherAdmin);
    otherAdmin.hidden = false; otherAdmin.disabled = false; dispatchClick(otherAdmin); await flushAsync();
    assert.equal(writes.length, 1);
    assert.equal(apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "ari-access@example.com")), "scorekeeper");
    assert.equal(apiState.leagueAccess.get(leagueAccessKey("three-sided-football-club", "bea-access@example.com")), undefined);
    seedLiveGoalEvent(apiState, "ux10-match", "remote-during-access-uncertainty");
    page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync(); await advanceUx10(page, 15000);
    assert.equal(page.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
    const reload = page.document.querySelector('[data-action="retry-game-updates"]');
    assert(reload instanceof page.window.HTMLButtonElement);
    assert.equal(interactionVisible(reload), true); assert.equal(reload.textContent, "Reload game");
    assert.equal(writes.length, 1);
  } finally { closeUx10Page(page); }
});

for (const heldAt of ["full-game", "full-roster", "short-goals"] as const) {
  test(`ux10 an account switch during ${heldAt} is fenced before any remote snapshot is applied`, async () => {
    const apiState = createMockApiState(); seedUx10Game(apiState);
    apiState.players.get("player-ari")!.claimedByUserId = "private-player@example.com";
    seedLiveGoalEvent(apiState, "ux10-match", "known-before-switch");
    const base = createMockFetch(apiState); const reads: string[] = []; let writes = 0;
    let observe = false; let held = false; let release: (() => void) | undefined;
    const heldPath = heldAt === "full-game" ? "/v1/games/ux10-match" : "/v1/games/ux10-match/" + (heldAt === "full-roster" ? "roster" : "goals");
    const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (init.method && init.method !== "GET") writes += 1;
      if (observe) {
        reads.push(path);
        if (!held && path === heldPath) {
          held = true; const snapshot = await base(input, init);
          return new Promise<Response>(resolve => { release = () => resolve(snapshot); });
        }
      }
      return base(input, init);
    } });
    let observer: MutationObserver | undefined;
    try {
      const controls = liveGoalControls(page); controls.draft(); controls.scorer.focus();
      const beforeTitle = page.document.getElementById("game-title")?.textContent;
      const beforeScores = ux10Scores(page);
      const proofStore = (page.window as unknown as { ThreeFcPlayerProof: { create(operation: string): Promise<{ proofId: string; secret: string }> } }).ThreeFcPlayerProof;
      const retainedProof = await proofStore.create(`account-switch-${heldAt}`);
      assert(page.window.sessionStorage.getItem("threefc.player-proof.v1")?.includes(retainedProof.secret));
      assert(page.document.querySelector('[data-action="grant-player-access"]'));
      const appliedIds: string[] = []; const appliedTitles: Array<string | null> = [];
      observer = new page.window.MutationObserver(() => {
        appliedIds.push(...[...page.document.querySelectorAll('[data-ui="goal-event"]')].map(row => row.getAttribute("data-event-id") ?? ""));
        appliedTitles.push(page.document.getElementById("game-title")?.textContent ?? null);
      });
      observer.observe(page.document.getElementById("setup-flow-root")!, { childList: true, subtree: true, characterData: true });
      apiState.games.get("ux10-match")!.gameStartTs = "2031-04-01T10:00:00.000Z";
      seedLiveGoalEvent(apiState, "ux10-match", "must-not-apply-after-account-switch", 55);
      apiState.roster.get("ux10-match:player-ari")!.teamId = "yellow";
      observe = true;
      if (heldAt === "short-goals") await advanceUx10(page, 5000);
      else { page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync(); }
      assert(release, "the account changes after match reads have begun, not before the batch's first session check");
      assert.equal(reads.filter(path => path === "/v1/auth/session").length, heldAt === "short-goals" ? 0 : 1);
      assert.equal(page.document.getElementById("game-title")?.textContent, beforeTitle);
      apiState.session = { ...apiState.session!, sessionId: "new-admin-session", email: "new-admin@example.com" };
      apiState.cookieJar = "threefc_session=new-admin-session";
      grantMockLeagueAccess(apiState, "three-sided-football-club", "new-admin@example.com", "admin");
      release(); await flushAsync();
      assert.equal(page.window.sessionStorage.getItem("threefc.player-proof.v1"), null, "detected cookie switch purges retained bearer proofs");
      assert.equal(reads.filter(path => path === "/v1/auth/session").length, heldAt === "short-goals" ? 1 : 2);
      assert.equal(reads.at(-1), "/v1/auth/session", "the final session response fences all already-staged match and authority reads");
      assert.equal(appliedIds.includes("must-not-apply-after-account-switch"), false, "the invalid batch must not render even transiently");
      assert(appliedTitles.every(title => title === beforeTitle));
      assert.equal(page.document.getElementById("game-title")?.textContent, beforeTitle);
      assert.deepEqual(ux10Scores(page), beforeScores);
      assert.deepEqual([...page.document.querySelectorAll('[data-ui="goal-event"]')].map(row => row.getAttribute("data-event-id")), ["known-before-switch"]);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari")[0]?.closest('[data-ui="roster-team"]')?.getAttribute("data-team-id"), "red");
      assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
      assert.equal(page.document.querySelector('[data-ui="claim-badge"]'), null);
      assert.equal(controls.scorer.value, "player-ari"); assert.equal(goalTeamValue(controls.scoring), "red"); assert.equal(goalTeamValue(controls.conceding), "blue");
      assert.equal(controls.save.disabled, true);
      controls.save.disabled = false; dispatchSubmit(controls.form); await flushAsync();
      assert.equal(writes, 0, "another valid administrator account cannot inherit this page's draft authority");
      assert.equal(page.window.location.hash, "#score"); assert.equal(page.navigations.length, 0);
      assert.match(page.document.getElementById("game-refresh-message")?.textContent ?? "", /sign-in changed/);
      assert.equal(page.document.querySelector('[data-action="retry-game-updates"]')?.textContent, "Reload game");
    } finally { observer?.disconnect(); release?.(); await flushAsync(); closeUx10Page(page); }
  });
}

for (const finalProbe of ["unavailable", "malformed", "expired"] as const) {
  test(`ux10 a ${finalProbe} final session probe cannot apply staged administrator authority or match data`, async () => {
    const apiState = createMockApiState(); seedUx10Game(apiState, "live", "viewer");
    apiState.players.get("player-ari")!.claimedByUserId = "private-player@example.com";
    const base = createMockFetch(apiState); let observe = false; let sessionReads = 0; let writes = 0;
    const page = await bootUx10Page(apiState, { mode: "teams", fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (init.method && init.method !== "GET") writes += 1;
      if (observe && path === "/v1/auth/session" && ++sessionReads === 2) {
        if (finalProbe === "malformed") return createJsonResponse(200, { authenticated: true, session: { email: apiState.session!.email } });
        return createJsonResponse(finalProbe === "expired" ? 401 : 503, { error: finalProbe === "expired" ? "unauthorized" : "unavailable" });
      }
      return base(input, init);
    } });
    let observer: MutationObserver | undefined;
    try {
      const beforeTitle = page.document.getElementById("game-title")?.textContent;
      const beforeScores = ux10Scores(page); const appliedGoals: string[] = []; const visibleAuthority: boolean[] = [];
      const create = page.document.querySelector('[data-action="toggle-player-create"]');
      assert(create instanceof page.window.HTMLButtonElement);
      assert.equal(interactionVisible(create), false);
      observer = new page.window.MutationObserver(() => {
        appliedGoals.push(...[...page.document.querySelectorAll('[data-ui="goal-event"]')].map(row => row.getAttribute("data-event-id") ?? ""));
        visibleAuthority.push(interactionVisible(create));
      });
      observer.observe(page.document.getElementById("setup-flow-root")!, { childList: true, subtree: true, attributes: true });
      grantMockLeagueAccess(apiState, "three-sided-football-club", apiState.session!.email, "admin");
      apiState.games.get("ux10-match")!.gameStartTs = "2031-04-01T10:00:00.000Z";
      seedLiveGoalEvent(apiState, "ux10-match", "unverified-session-goal", 55);
      apiState.roster.get("ux10-match:player-ari")!.teamId = "yellow";
      observe = true; page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
      assert.equal(sessionReads, 2, "a failed end probe must be exercised after the successful beginning probe");
      assert.equal(appliedGoals.includes("unverified-session-goal"), false);
      assert.equal(visibleAuthority.includes(true), false, "staged administrator controls must never become usable before identity verification");
      assert.equal(interactionVisible(create), false);
      assert.equal(page.document.querySelector('[data-action="grant-player-access"]'), null);
      assert.equal(page.document.querySelector('[data-ui="claim-badge"]'), null);
      assert.equal(page.document.getElementById("game-title")?.textContent, beforeTitle);
      assert.deepEqual(ux10Scores(page), beforeScores);
      assert.equal(page.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
      assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari")[0]?.closest('[data-ui="roster-team"]')?.getAttribute("data-team-id"), "red");
      assert.equal(page.document.getElementById("game-refresh-notice")?.hidden, false);
      const controls = liveGoalControls(page); controls.save.disabled = false; dispatchSubmit(controls.form); await flushAsync();
      assert.equal(writes, 0); assert.equal(page.window.location.hash, "#teams");
    } finally { observer?.disconnect(); closeUx10Page(page); }
  });
}

test("ux10 authority-only refresh fences a changed session without retiring a frozen goal retry", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
  const writes: Array<{ path: string; method: string; body: string; key: string | null }> = [];
  let observe = false; let release: (() => void) | undefined; const reads: string[] = [];
  const page = await bootUx10Page(apiState, { fetch: async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (init.method && init.method !== "GET") {
      writes.push({ path, method: init.method, body: String(init.body), key: readInitHeader(init, "idempotency-key") });
      await base(input, init); return createJsonResponse(503, { error: "unavailable" });
    }
    if (observe) {
      reads.push(path);
      if (path === "/v1/leagues/three-sided-football-club" && !release) {
        const response = await base(input, init); return new Promise<Response>(resolve => { release = () => resolve(response); });
      }
    }
    return base(input, init);
  } });
  try {
    const controls = liveGoalControls(page); controls.draft(); dispatchSubmit(controls.form); await flushAsync();
    assert.equal(writes.length, 1); assert(writes[0].key); assert.equal(apiState.goalEvents.size, 1);
    const original = structuredClone(writes[0]);
    assert.equal(controls.retry.hidden, false); assert.equal(controls.retry.disabled, false);
    observe = true; page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
    assert(release); assert.deepEqual(reads, ["/v1/auth/session", "/v1/leagues/three-sided-football-club"]);
    apiState.session = { ...apiState.session!, sessionId: "replacement-admin-session", email: "replacement-admin@example.com" };
    apiState.cookieJar = "threefc_session=replacement-admin-session";
    grantMockLeagueAccess(apiState, "three-sided-football-club", "replacement-admin@example.com", "admin");
    release(); await flushAsync();
    assert.deepEqual(reads, ["/v1/auth/session", "/v1/leagues/three-sided-football-club", "/v1/auth/session"], "frozen writes skip presentation reads, not the final session boundary");
    assert.equal(controls.scorer.value, "player-ari"); assert.equal(goalTeamValue(controls.scoring), "red");
    assert.equal(controls.retry.hidden, false); assert.equal(controls.retry.disabled, true);
    controls.retry.disabled = false; dispatchClick(controls.retry); await flushAsync();
    assert.equal(writes.length, 1); assert.deepEqual(writes[0], original);
    assert.equal(page.document.querySelectorAll('[data-ui="goal-event"]').length, 0);
    assert.match(page.document.getElementById("game-refresh-message")?.textContent ?? "", /sign-in changed/);
  } finally { release?.(); await flushAsync(); closeUx10Page(page); }
});

test("ux10 Escape from reload-locked metadata restores the visible recovery control without a write", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState, "scheduled"); const base = createMockFetch(apiState); let writes = 0;
  const page = await bootUx10Page(apiState, { mode: "overview", fetch: async (input, init = {}) => {
    if (init.method && init.method !== "GET") { writes += 1; await base(input, init); return createJsonResponse(503, { error: "unavailable" }); }
    return base(input, init);
  } });
  try {
    const toggle = page.document.querySelector('[data-action="toggle-game-edit"]'); const form = page.document.getElementById("game-edit-form");
    const field = page.document.getElementById("game-edit-kickoff"); const region = page.document.getElementById("game-edit-region");
    assert(toggle instanceof page.window.HTMLButtonElement && form instanceof page.window.HTMLFormElement && field instanceof page.window.HTMLInputElement && region instanceof page.window.HTMLElement);
    dispatchClick(toggle); field.value = "2030-04-01T10:30"; field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    dispatchSubmit(form); await flushAsync(); assert.equal(writes, 1);
    const cancel = form.querySelector('[data-action="cancel-game-edit"]'); const reload = page.document.querySelector('[data-action="retry-game-updates"]');
    assert(cancel instanceof page.window.HTMLButtonElement && reload instanceof page.window.HTMLButtonElement);
    cancel.focus(); cancel.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(region.hidden, true); assert.equal(field.value, "2030-04-01T10:30"); assert.equal(interactionVisible(toggle), false);
    assert.equal(interactionVisible(reload), true); assert.equal(page.document.activeElement, reload);
    assert.equal(writes, 1); assert.equal(page.navigations.length, 0);
  } finally { closeUx10Page(page); }
});

test("ux10 reload-locked finished correction can exit without discarding its draft or enabling correction again", async () => {
  const apiState = createMockApiState(); seedUx10Game(apiState);
  const game = apiState.games.get("ux10-match")!; game.status = "finished"; refreshMockFinishedResult(apiState, game, "2026-03-28T11:04:00.000Z");
  apiState.players.get("player-ari")!.claimedByUserId = "ari-access@example.com";
  const base = createMockFetch(apiState); let writes = 0; let release: (() => void) | undefined;
  const page = await bootUx10Page(apiState, { mode: "results", fetch: async (input, init = {}) => {
    if (init.method && init.method !== "GET") {
      writes += 1; await base(input, init);
      return new Promise<Response>(resolve => { release = () => resolve(createJsonResponse(503, { error: "unavailable" })); });
    }
    return base(input, init);
  } });
  try {
    enterFinishedCorrections(page); const controls = liveGoalControls(page); controls.draft();
    dispatchClick(qaGameNavigation(page).teams);
    const grant = page.document.querySelector('[data-action="grant-player-access"][data-player-id="player-ari"][data-role="scorekeeper"]');
    assert(grant instanceof page.window.HTMLButtonElement); openActionMenuFor(grant); dispatchClick(grant); await flushAsync();
    assert.equal(writes, 1); assert(release); assert.equal(apiState.leagueAccess.get(leagueAccessKey(game.leagueId, "ari-access@example.com")), "scorekeeper");
    dispatchClick(qaGameNavigation(page).score);
    assert.equal(page.window.location.hash, "#score"); release(); await flushAsync();
    const exit = page.document.querySelector('[data-action="exit-result-correction"]');
    assert(exit instanceof page.window.HTMLButtonElement); assert.equal(exit.disabled, false, "leaving this view makes no request and cannot clear the separate legacy-write lock");
    dispatchClick(exit); await flushAsync();
    assert.equal(page.window.location.hash, "#results"); assert.equal(page.document.getElementById("finished-correction-actions")?.hidden, true);
    assert.equal(controls.scorer.value, "player-ari"); assert.equal(goalTeamValue(controls.scoring), "red"); assert.equal(goalTeamValue(controls.conceding), "blue");
    const correct = page.document.querySelector('[data-action="correct-finished-result"]');
    assert(correct instanceof page.window.HTMLButtonElement); assert.equal(correct.disabled, true);
    correct.disabled = false; dispatchClick(correct); await flushAsync();
    assert.equal(page.window.location.hash, "#results"); assert.equal(page.document.getElementById("finished-correction-actions")?.hidden, true);
    assert.equal(controls.save.disabled, true); assert.equal(writes, 1);
    assert.equal(page.document.querySelector('[data-action="retry-game-updates"]')?.textContent, "Reload game");
  } finally { release?.(); await flushAsync(); closeUx10Page(page); }
});

for (const scenario of ["failed-read", "malformed-read", "delayed-pre-confirmation-read", "remote-unassignment"] as const) {
  test(`ux10 confirmed assignment overlay yields to later authoritative roster after ${scenario}`, async () => {
    const delayedBeforeWrite = scenario === "delayed-pre-confirmation-read";
    const apiState = createMockApiState(); seedUx10Game(apiState); const base = createMockFetch(apiState);
    const writes: Array<{ path: string; body: string }> = []; let rosterReads = 0; let failNextRoster = false;
    let holdBeforeWrite = false; let release: (() => void) | undefined; let heldSignal: AbortSignal | null | undefined;
    const page = await bootUx10Page(apiState, { mode: "teams", fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (init.method === "PUT") {
        writes.push({ path, body: String(init.body) });
        const confirmed = await base(input, init); failNextRoster = true; return confirmed;
      }
      if (path === "/v1/games/ux10-match/roster") {
        rosterReads += 1;
        if (holdBeforeWrite) {
          holdBeforeWrite = false; heldSignal = init.signal; const snapshot = await base(input, init);
          return new Promise<Response>(resolve => { release = () => resolve(snapshot); });
        }
        if (failNextRoster) {
          failNextRoster = false;
          return createJsonResponse(scenario === "malformed-read" ? 200 : 503, { error: "unavailable" });
        }
      }
      return base(input, init);
    } });
    let observer: MutationObserver | undefined;
    try {
      if (delayedBeforeWrite) {
        holdBeforeWrite = true; page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
        assert(release); assert(heldSignal); assert.equal(heldSignal.aborted, false);
      }
      const transfer = page.document.querySelector('[data-action="toggle-transfer"][data-player-id="player-ari"]');
      assert(transfer instanceof page.window.HTMLButtonElement); dispatchClick(transfer);
      const blue = page.document.querySelector('[data-action="assign-player"][data-player-id="player-ari"][data-team-id="blue"]');
      assert(blue instanceof page.window.HTMLButtonElement); dispatchClick(blue); await flushAsync();
      assert.equal(writes.length, 1); assert.deepEqual(writes[0], { path: "/v1/games/ux10-match/roster/player-ari", body: JSON.stringify({ teamId: "blue" }) });
      assert.equal(apiState.roster.get("ux10-match:player-ari")?.teamId, "blue");
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Assignment was saved.*latest roster could not be loaded/);
      const currentTeam = () => ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari")[0]?.closest('[data-ui="roster-team"]')?.getAttribute("data-team-id");
      assert.equal(currentTeam(), "blue", "a failed follow-up read must not erase a confirmed local assignment");
      if (delayedBeforeWrite) {
        assert.equal(heldSignal?.aborted, true, "the local PUT invalidates the previously captured full batch");
        const observedTeams: Array<string | null | undefined> = [];
        observer = new page.window.MutationObserver(() => { observedTeams.push(currentTeam()); });
        observer.observe(page.document.getElementById("roster-teams")!, { childList: true, subtree: true });
        release!(); await flushAsync();
        assert.equal(observedTeams.includes("red"), false, "the old pre-confirmation response cannot briefly repaint the original team");
        assert.equal(currentTeam(), "blue");
        observer.disconnect(); observer = undefined;
      }
      // A second client has now made a newer authoritative assignment. It need
      // not first echo this page's Blue overlay to supersede that confirmed data.
      if (scenario === "remote-unassignment") apiState.roster.delete("ux10-match:player-ari");
      else apiState.roster.get("ux10-match:player-ari")!.teamId = "yellow";
      const readsBeforeFreshBatch = rosterReads;
      page.window.dispatchEvent(new page.window.Event("focus")); await flushAsync();
      assert.equal(rosterReads, readsBeforeFreshBatch + 1);
      if (scenario === "remote-unassignment") {
        assert.equal(currentTeam(), undefined, "a valid roster which no longer assigns the player also retires the confirmed overlay");
        assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari").length, 0);
        assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', "player-ari").length, 1);
      } else {
        assert.equal(currentTeam(), "yellow", "a completed, generation-valid full read retires the confirmed local overlay even when the current team differs");
        assert.equal(ux09PlayerRows(page, '[data-ui="roster-member"]', "player-ari").length, 1);
        assert.equal(ux09PlayerRows(page, '[data-ui="roster-player"]', "player-ari").length, 0);
      }
      assert.equal(writes.length, 1); assert.equal(page.navigations.length, 0);
      assert.equal(page.window.location.hash, "#teams");
    } finally { observer?.disconnect(); release?.(); await flushAsync(); closeUx10Page(page); }
  });
}

for (const outcome of ["uncertain-owned", "uncertain-outside", "uncertain-score-nav", "confirmed-owned", "confirmed-outside", "confirmed-score-nav"] as const) {
  test(`ux10 overlapping ambiguous metadata and clock preserve recovery after ${outcome} settlement`, async () => {
    const clockConfirmed = outcome.startsWith("confirmed");
    const focusDestination = outcome.endsWith("outside") ? "elsewhere" : outcome.endsWith("score-nav") ? "score-nav" : "clock";
    const apiState = createMockApiState(); seedUx10Game(apiState, "scheduled"); const base = createMockFetch(apiState);
    const writes: Array<{ path: string; method: string; body: string; key: string | null }> = [];
    let releaseMetadata: (() => void) | undefined; let releaseClock: (() => void) | undefined; let gameReads = 0;
    const page = await bootUx10Page(apiState, { mode: "overview", fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (init.method && init.method !== "GET") {
        writes.push({ path, method: init.method, body: String(init.body), key: readInitHeader(init, "idempotency-key") });
        const response = await base(input, init);
        return new Promise<Response>(resolve => {
          const release = () => resolve(init.method !== "PATCH" && clockConfirmed ? response : createJsonResponse(503, { error: "unavailable" }));
          if (init.method === "PATCH") releaseMetadata = release;
          else releaseClock = release;
        });
      }
      if (path === "/v1/games/ux10-match") gameReads += 1;
      return base(input, init);
    } });
    try {
      const toggle = page.document.querySelector('[data-action="toggle-game-edit"]');
      const field = page.document.getElementById("game-edit-kickoff"); const form = page.document.getElementById("game-edit-form");
      const status = page.document.getElementById("game-edit-status"); const thirdLength = page.document.getElementById("game-edit-third-length");
      assert(toggle instanceof page.window.HTMLButtonElement && field instanceof page.window.HTMLInputElement && form instanceof page.window.HTMLFormElement);
      assert(status instanceof page.window.HTMLSelectElement && thirdLength instanceof page.window.HTMLSelectElement);
      dispatchClick(toggle); field.value = "2030-04-01T10:30"; field.dispatchEvent(new page.window.Event("input", { bubbles: true }));
      thirdLength.value = "25"; thirdLength.dispatchEvent(new page.window.Event("change", { bubbles: true }));
      field.focus(); dispatchSubmit(form); await flushAsync(); assert(releaseMetadata); assert.equal(writes.length, 1);
      dispatchClick(qaGameNavigation(page).score);
      const start = page.document.querySelector('[data-action="start-active-third"]');
      const check = page.document.querySelector('[data-action="refresh-game-state"]');
      assert(start instanceof page.window.HTMLButtonElement && check instanceof page.window.HTMLButtonElement);
      assert.equal(start.disabled, false); start.focus(); dispatchClick(start); await flushAsync();
      assert(releaseClock); assert.equal(writes.length, 2);
      assert.equal(writes[1].path, "/v1/games/ux10-match/thirds/1/start"); assert.equal(writes[1].method, "POST");
      const originalWrites = structuredClone(writes); const readsBeforeSettlement = gameReads;
      assert(apiState.games.get("ux10-match")?.thirds[0].startedAt, "the clock write really committed before its response was lost");
      releaseMetadata(); await flushAsync();
      assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /Game changes could not be confirmed/);
      let outside: HTMLElement | undefined;
      if (focusDestination === "elsewhere") {
        dispatchClick(qaGameNavigation(page).teams);
        const search = qaGameNavigation(page).teams;
        outside = search; outside.focus();
      } else if (focusDestination === "score-nav") {
        outside = qaGameNavigation(page).teams; outside.focus();
      }
      releaseClock(); await flushAsync();
      assert.equal(gameReads, readsBeforeSettlement, "the locked clock owner must not initiate an implicit reconciliation GET");
      const reload = page.document.querySelector('[data-action="retry-game-updates"]');
      assert(reload instanceof page.window.HTMLButtonElement);
      assert.equal(interactionVisible(reload), true); assert.equal(reload.textContent, "Reload game");
      if (!clockConfirmed) {
        assert.match(page.document.getElementById("setup-error")?.textContent ?? "", /could not be confirmed.*Reload/);
        assert.doesNotMatch(page.document.getElementById("setup-error")?.textContent ?? "", /Check the clock|retry finishing/);
      }
      assert.equal(start.disabled, true); assert.equal(check.hidden, clockConfirmed); assert.equal(check.disabled, true);
      if (!clockConfirmed) assert.equal(start.getAttribute("data-third"), "1", "the unresolved clock still targets its original third");
      assert.equal(field.value, "2030-04-01T10:30", "the earlier ambiguous metadata draft is not lost to clock completion");
      assert.equal(status.value, "scheduled", "a confirmed clock start must not replace the ambiguous status draft with Live");
      assert.equal(thirdLength.value, "25", "the full ambiguous metadata draft survives settlement");
      if (focusDestination === "clock") {
        assert.equal(page.document.activeElement, reload, "the only actionable recovery must receive the clock operation's retained focus");
        assert.equal(page.window.location.hash, "#score");
      } else {
        assert.equal(page.document.activeElement, outside); assert.equal(page.window.location.hash, focusDestination === "score-nav" ? "#score" : "#teams");
      }
      check.disabled = false; dispatchClick(check); start.disabled = false; dispatchClick(start); await flushAsync();
      assert.equal(gameReads, readsBeforeSettlement); assert.deepEqual(writes, originalWrites);
      assert.equal(check.hidden, clockConfirmed, "synthetic recovery cannot change whether the original clock operation was confirmed");
      assert.equal(page.navigations.length, 0);
    } finally { releaseMetadata?.(); releaseClock?.(); await flushAsync(); closeUx10Page(page); }
  });
}
