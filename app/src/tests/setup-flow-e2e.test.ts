import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { JSDOM } from "jsdom";

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
        createdAt: now,
        updatedAt: now,
      };
      state.games.set(gameId, game);
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
