import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderGamePage } from "../../app/dist/ui/layout.js";
import { expectActionSurfaceFits } from "./action-menu-helpers.js";

// Built production renderer/controller/styles, with all transport intercepted.
// These fictional accounts and rosters never contact QA, send email or use AWS.
// Build the app first, then run with THREEFC_SKIP_WEB_SERVER=1 --workers=1.
const origin = "https://3fc.fixture.test";
const gameId = "fixture-match";
const leagueId = "fixture-community-league";
const seasonId = "fixture-community-season";
const gamePath = `/games/${gameId}`;
const apiGamePath = `/v1${gamePath}`;
const leagueName = "North Harbour Community Three Sided Football League";
const seasonName = "Spring and Summer Community Season 2026–2027";
const kickoff = "2026-09-12T23:30:00.000Z";
const timestamp = "2026-09-01T00:00:00.000Z";
const teamIds = ["red", "blue", "yellow"] as const;
type TeamId = (typeof teamIds)[number];
type GameStatus = "scheduled" | "live" | "finished";
type Actor = "admin" | "scorekeeper" | "viewer" | "combined" | "player-only" | "cross-league" | "unknown";
type Player = { playerId: string; nickname: string; createdAt: string; updatedAt: string };
type RecordedRequest = { method: string; path: string; search: string; body: Record<string, unknown> | null; key?: string };
type FixtureOptions = {
  actor?: Actor; status?: GameStatus; largeRoster?: boolean; playersUnavailable?: boolean;
  delayAuthority?: boolean; failCreateOnce?: boolean; failTransferOnce?: boolean;
};
const assets = new Map(["styles.css", "icons.css", "setup-flow.js", "auth-flow.js", "modal.js"].map(name => [
  `/ui/${name}`, readFileSync(resolve("app/dist/ui", name), "utf8"),
]));

async function installMatchFixture(page: Page, options: FixtureOptions = {}) {
  const actor = options.actor ?? "admin";
  const status = options.status ?? "scheduled";
  const isAdmin = actor === "admin" || actor === "combined";
  const isOperator = isAdmin || actor === "scorekeeper";
  const readable = actor !== "player-only" && actor !== "cross-league";
  const role = isAdmin ? "admin" : actor === "scorekeeper" ? "scorekeeper" : "viewer";
  const perTeam = options.largeRoster ? 8 : 5;
  const players: Player[] = Array.from({ length: 2 + perTeam * 3 }, (_, index) => ({
    playerId: `fixture-player-${String(index + 1).padStart(2, "0")}`,
    nickname: index === 0 ? "Morgan Alexandra Montgomery-Williams"
      : index === 1 ? "Ibrahim O’Connell-Rodríguez"
        : index === 2 || index === 2 + perTeam ? "Sam"
          : index === 3 ? "Alexandra Francesca Montgomery-Williams"
            : `Community Player ${String(index + 1).padStart(2, "0")}`,
    createdAt: timestamp, updatedAt: timestamp,
  }));
  const assignments = new Map<string, TeamId>(players.slice(2).map((player, index) => [player.playerId, teamIds[Math.floor(index / perTeam)]]));
  const initialPlayerIndices = new Map(players.map((player, index) => [player.playerId, index]));
  const teams = teamIds.map((teamId, index) => ({
    gameId, teamId, name: ["Red", "Blue", "Yellow"][index], color: ["#d43d3d", "#377cd6", "#e1b52c"][index],
    scored: status === "scheduled" ? 0 : status === "live" ? [1, 0, 0][index] : [2, 1, 0][index],
    conceded: status === "scheduled" ? 0 : status === "live" ? [0, 1, 0][index] : [0, 1, 2][index],
    createdAt: timestamp, updatedAt: timestamp,
  }));
  const goals = [
    { scoringTeamId: "red", concedingTeamId: "blue", scorerPlayerId: players[2].playerId, third: 1, thirdMinute: 5, gameMinute: 5, elapsedSeconds: 240, displayTime: "5" },
    { scoringTeamId: "red", concedingTeamId: "yellow", scorerPlayerId: players[3].playerId, third: 2, thirdMinute: 4, gameMinute: 24, elapsedSeconds: 180, displayTime: "24" },
    { scoringTeamId: "blue", concedingTeamId: "yellow", scorerPlayerId: players[2 + perTeam].playerId, third: 3, thirdMinute: 7, gameMinute: 47, elapsedSeconds: 360, displayTime: "47" },
  ].slice(0, status === "finished" ? 3 : status === "live" ? 1 : 0).map((goal, index) => ({
    ...goal, eventId: `fixture-goal-${index + 1}`, gameId, ownGoal: false, assistPlayerIds: [], stoppageMinute: null,
    createdAt: `2026-09-13T00:${String(index * 10).padStart(2, "0")}:00.000Z`, updatedAt: timestamp,
  }));
  const game = {
    gameId, leagueId, seasonId, sessionId: "20260913", joinCode: "FICTIONALJOIN", status,
    gameStartTs: kickoff, thirdLengthMinutes: 20, createdAt: timestamp, updatedAt: timestamp,
    thirds: [1, 2, 3].map((third, index) => ({
      third,
      startedAt: status === "finished" ? new Date(Date.parse(kickoff) + index * 20 * 60_000).toISOString()
        : status === "live" && third === 1 ? new Date(Date.now() - 5 * 60_000).toISOString() : null,
      finishedAt: status === "finished" ? new Date(Date.parse(kickoff) + third * 20 * 60_000).toISOString() : null,
    })),
    finishedAt: status === "finished" ? "2026-09-13T00:30:00.000Z" : null,
    result: status === "finished" ? {
      winnerTeamId: "red", outcome: "win", comparator: "fewest_conceded_then_most_scored", computedAt: "2026-09-13T00:30:00.000Z",
      teams: teams.map((team, index) => ({ ...team, rank: index + 1, outcome: index === 0 ? "win" : "loss" })),
    } : null,
  };
  const requests: RecordedRequest[] = [];
  const unexpected: string[] = [];
  let createFailures = options.failCreateOnce ? 1 : 0;
  let transferFailures = options.failTransferOnce ? 1 : 0;
  let releaseAuthority: () => void = () => {};
  const authority = new Promise<void>(resolve => { releaseAuthority = resolve; });
  const publicRoster = () => [...assignments].map(([playerId, teamId]) => ({
    gameId, playerId, teamId, player: players.find(player => player.playerId === playerId), createdAt: timestamp, updatedAt: timestamp,
  }));
  const operatorPlayers = (search: string) => players.filter(player => player.nickname.toLowerCase().includes(search.toLowerCase())).slice(0, 20).map(player => {
    const index = initialPlayerIndices.get(player.playerId);
    // Match the API: safe roster DTOs omit claims; only an admin's bounded
    // player-search result includes access metadata for a claimed identity.
    return isAdmin && index !== undefined && (index % 4 === 0 || (actor === "combined" && index === 2))
      ? { ...player, access: { userId: `private-fixture-user-${index}`, role: actor === "combined" && index === 2 ? "admin" : null } }
      : player;
  });

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`External request ${url.origin}${url.pathname}`);
      return route.abort();
    }
    const asset = assets.get(url.pathname);
    if (asset !== undefined) return route.fulfill({ body: asset, contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    if (request.method() === "GET" && url.pathname === gamePath) return route.fulfill({ contentType: "text/html", body: renderGamePage(origin, { gameId }) });
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    requests.push({ method, path: url.pathname, search: url.searchParams.get("search") ?? "", body, key: request.headers()["idempotency-key"] });
    if (method === "GET" && url.pathname === "/v1/auth/session") {
      return route.fulfill({ headers: { "cache-control": "no-store" }, json: { authenticated: true, session: { email: "match.fixture@example.com", userId: "fictional-account" } } });
    }
    const forbidden = () => route.fulfill({ status: 403, json: { error: "forbidden", code: "league_access_required", message: "Access to this league is required." } });
    if (!readable && url.pathname.startsWith("/v1/")) return forbidden();
    if (method === "GET" && url.pathname === apiGamePath) return route.fulfill({ json: game });
    if (method === "GET" && url.pathname === `/v1/leagues/${leagueId}`) {
      if (options.delayAuthority) await authority;
      if (actor === "unknown") return route.fulfill({ status: 503, json: { error: "unavailable" } });
      return route.fulfill({ json: { leagueId, name: leagueName, access: { role } } });
    }
    if (method === "GET" && url.pathname === `/v1/leagues/${leagueId}/seasons/${seasonId}`) {
      return route.fulfill({ json: { leagueId, seasonId, name: seasonName, startsOn: "2026-09-01", endsOn: "2027-02-28" } });
    }
    if (method === "GET" && url.pathname === `${apiGamePath}/roster`) return route.fulfill({ json: { teams, roster: publicRoster() } });
    if (method === "GET" && url.pathname === `${apiGamePath}/teams`) return route.fulfill({ json: { teams } });
    if (method === "GET" && url.pathname === `${apiGamePath}/players`) {
      if (!isOperator) return forbidden();
      if (options.playersUnavailable) return route.fulfill({ status: 503, json: { error: "unavailable", message: "Player search is unavailable." } });
      return route.fulfill({ json: { players: operatorPlayers(url.searchParams.get("search") ?? "") } });
    }
    if (method === "GET" && url.pathname === `${apiGamePath}/goals`) return route.fulfill({ json: { timeline: goals, scoreboard: { teams } } });
    if (method === "POST" && url.pathname === `${apiGamePath}/players` && body) {
      if (!isOperator || (status === "finished" && !isAdmin)) return forbidden();
      if (createFailures-- > 0) return route.fulfill({ status: 503, json: { error: "unavailable", message: "Player creation could not be confirmed." } });
      const player = { playerId: String(body.playerId), nickname: String(body.nickname), createdAt: timestamp, updatedAt: timestamp };
      if (!players.some(existing => existing.playerId === player.playerId)) players.unshift(player);
      return route.fulfill({ status: 201, json: player });
    }
    const assignment = new RegExp(`^${apiGamePath}/roster/([^/]+)$`).exec(url.pathname);
    if (method === "PUT" && assignment && body) {
      if (!isOperator || (status === "finished" && !isAdmin)) return forbidden();
      if (transferFailures-- > 0) return route.fulfill({ status: 503, json: { error: "unavailable", message: "Transfer could not be confirmed." } });
      const playerId = decodeURIComponent(assignment[1]);
      if (!players.some(player => player.playerId === playerId) || !teamIds.includes(body.teamId as TeamId)) return route.fulfill({ status: 400, json: { error: "invalid_assignment" } });
      assignments.set(playerId, body.teamId as TeamId);
      return route.fulfill({ json: { gameId, playerId, teamId: body.teamId, createdAt: timestamp, updatedAt: timestamp } });
    }
    unexpected.push(`${method} ${url.pathname}`);
    return route.abort();
  });
  return { actor, requests, unexpected, players, assignments, releaseAuthority };
}

async function expectOnlyMode(page: Page, mode: "structure" | "players" | "run" | "final") {
  await expect(page.locator('[data-ui="game-mode-panel"]:visible')).toHaveCount(1);
  await expect(page.getByTestId(`game-mode-${mode}`)).toBeVisible();
}

async function expectReady(page: Page) {
  const expectedTitle = await page.evaluate(value => new Intl.DateTimeFormat(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(new Date(value)), kickoff);
  await expect(page.locator("#game-title")).toHaveText(expectedTitle);
  await expect(page.locator('[data-ui="roster-member"]')).toHaveCount(15);
  await expect(page.getByTestId("game-mode-players-tab")).toContainText("Teams");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}

async function expectMatchGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, summary")]
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true }));
    return {
      width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      badTargets: controls.flatMap(element => {
        const box = element.getBoundingClientRect();
        const minimum = element.matches('[data-action="assign-player"], [data-action="toggle-transfer"], [data-action="quick-create-player"]') ? 48 : 44;
        return box.width < minimum - 0.1 || box.height < minimum - 0.1 || box.left < -0.1 || box.right > innerWidth + 0.1
          ? [{ action: element.getAttribute("aria-label") || element.textContent?.trim() || element.id, width: box.width, height: box.height, left: box.left, right: box.right, minimum }] : [];
      }),
      narrowNames: [...document.querySelectorAll<HTMLElement>('[data-ui="roster-member-main"]')]
        .filter(element => element.checkVisibility({ checkVisibilityCSS: true }))
        .flatMap(element => element.getBoundingClientRect().width < 110 ? [element.textContent?.trim()] : []),
      narrowNameFields: [...document.querySelectorAll<HTMLElement>("#player-nickname")]
        .filter(element => element.checkVisibility({ checkVisibilityCSS: true }))
        .flatMap(element => {
          const width = element.getBoundingClientRect().width;
          return width < Math.min(240, innerWidth - 96) ? [width] : [];
        }),
    };
  });
  expect(geometry.scroll, "No horizontal page scrolling").toBeLessThanOrEqual(geometry.width);
  expect(geometry.badTargets, "44px controls; 48px repeated match-day actions; no clipped targets").toEqual([]);
  expect(geometry.narrowNames, "Player names retain reading space beside transfer controls").toEqual([]);
  expect(geometry.narrowNameFields, "The Add player input retains usable full-row reading width").toEqual([]);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function displayedPlayers(page: Page) {
  return page.locator('#game-mode-players [data-ui="roster-player"][data-player-id], #game-mode-players [data-ui="roster-member"][data-player-id]');
}

test.use({ timezoneId: "Australia/Melbourne", locale: "en-AU" });

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [320, 390, 430, 768, 1280]) {
    test(`match overview and seventeen-player teams ${colorScheme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const fixture = await installMatchFixture(page);
      await page.goto(`${origin}${gamePath}`);
      await expectReady(page);
      await expectOnlyMode(page, "structure");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator("#game-overview-status")).toHaveText("Scheduled");
      await expect(page.locator("#game-overview-third-length")).toContainText("20");
      await expect(page.locator("#game-overview-kickoff")).not.toHaveText(/Loading|fixture-match/);
      await expect(page.locator("#game-edit-region")).toBeHidden();
      await expect(page.getByTestId("game-mode-nav").getByRole("link")).toHaveCount(2);
      await expect(page.getByTestId("game-mode-structure-tab")).toHaveAttribute("href", "#overview");
      await expect(page.getByTestId("game-mode-players-tab")).toHaveAttribute("href", "#teams");
      await expect(page.getByTestId("game-mode-final-tab")).toBeHidden();
      await expect(page.getByTestId("game-mode-nav").getByTestId("game-mode-run-tab")).toHaveCount(0);
      await expect(page.locator('[data-action="toggle-game-edit"]')).toBeVisible();
      await expect(page.getByTestId("game-join-code-value")).toHaveText("FICTIONALJOIN");
      await expectMatchGeometry(page);
      if (width === 390 || (width === 1280 && colorScheme === "dark")) await capture(page, testInfo, `match-overview-${colorScheme}-${width}`);

      const editGame = page.locator('[data-action="toggle-game-edit"]');
      await editGame.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Kickoff time", { exact: true })).toBeFocused();
      await page.getByTestId("game-edit-third-length").selectOption("25");
      await expectMatchGeometry(page);
      if (width === 390 && colorScheme === "dark") await capture(page, testInfo, "match-edit-game-dark-390");
      await page.locator("#game-edit-form").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.locator("#game-edit-region")).toBeHidden();
      await expect(editGame).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("game-edit-third-length")).toHaveValue("25");
      await expect(page.locator("#game-overview-third-length")).toHaveText("20 minutes");
      await page.keyboard.press("Escape");
      await expect(editGame).toBeFocused();

      await page.getByTestId("game-mode-players-tab").focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${origin}${gamePath}#teams`);
      await expectOnlyMode(page, "players");
      await expect(page.getByTestId("game-mode-players")).toBeFocused();
      await expect(page.getByLabel("Search players", { exact: true })).toHaveCount(1);
      await expect(page.locator("#player-pool-title")).toHaveText("Unassigned");
      await expect(page.locator('#player-pool [data-ui="roster-player"][data-player-id]')).toHaveCount(2);
      await expect(displayedPlayers(page)).toHaveCount(17);
      const identities = await displayedPlayers(page).evaluateAll(elements => elements.map(element => element.getAttribute("data-player-id")));
      expect(new Set(identities).size).toBe(17);
      for (const teamId of teamIds) await expect(page.locator(`[data-ui="roster-team"][data-team-id="${teamId}"] [data-ui="roster-member"]`)).toHaveCount(5);
      await expect(page.locator('[data-ui="roster-member"] strong').filter({ hasText: /^Sam$/ })).toHaveCount(2);
      expect(await page.locator("body").innerHTML()).not.toContain("private-fixture-user-");
      await expect(page.locator("#player-create-region")).toBeHidden();
      await expectMatchGeometry(page);
      if (width === 390 || width === 768 || (width === 1280 && colorScheme === "dark")) await capture(page, testInfo, `match-teams-${colorScheme}-${width}`);

      const create = page.locator('[data-action="toggle-player-create"]');
      await create.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Player name", { exact: true })).toBeFocused();
      await page.getByLabel("Player name", { exact: true }).fill("Unsent player draft");
      await expectMatchGeometry(page);
      if (width === 390 || (width === 320 && colorScheme === "dark")) await capture(page, testInfo, `match-add-player-${colorScheme}-${width}`);
      await page.locator("#player-create-form").getByRole("button", { name: "Cancel", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#player-create-region")).toBeHidden();
      await expect(create).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Player name", { exact: true })).toHaveValue("Unsent player draft");
      await page.keyboard.press("Escape");
      await expect(create).toBeFocused();
      expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

for (const status of ["scheduled", "live", "finished"] as const) {
  test(`${status} match opens its readable default destination`, async ({ page }, testInfo) => {
    const fixture = await installMatchFixture(page, { status });
    await page.goto(`${origin}${gamePath}`);
    await expectReady(page);
    await expectOnlyMode(page, status === "finished" ? "final" : "structure");
    if (status === "finished") {
      await expect(page.getByTestId("game-mode-final-tab")).toHaveAttribute("href", "#results");
      await expect(page.getByTestId("game-mode-nav").getByRole("link")).toHaveCount(3);
      await expect(page.getByTestId("game-mode-final-tab")).toHaveAttribute("aria-current", "page");
      await expect(page.locator('[data-action="correct-finished-result"]')).toBeVisible();
      await capture(page, testInfo, "match-finished-default-results");
    }
    expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("match navigation, scoring task and browser history restore destination focus", async ({ page }) => {
  const fixture = await installMatchFixture(page, { status: "live" });
  await page.goto(`${origin}${gamePath}`);
  await expectReady(page);
  await page.getByTestId("game-mode-players-tab").click();
  await expect(page.getByTestId("game-mode-players")).toBeFocused();
  await page.getByTestId("game-mode-structure-tab").click();
  await expect(page).toHaveURL(`${origin}${gamePath}#overview`);
  await expect(page.getByTestId("game-mode-structure")).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(`${origin}${gamePath}#teams`);
  await expect(page.getByTestId("game-mode-players")).toBeFocused();
  await page.goForward();
  await expect(page.getByTestId("game-mode-structure")).toBeFocused();
  await page.getByTestId("game-mode-run-tab").click();
  await expect(page).toHaveURL(`${origin}${gamePath}#score`);
  await expectOnlyMode(page, "run");
  await expect(page.getByTestId("game-mode-run")).toBeFocused();
  await page.getByTestId("game-mode-run").getByRole("button", { name: "Back to game", exact: true }).click();
  await expect(page).toHaveURL(`${origin}${gamePath}#overview`);
  await expect(page.getByTestId("game-mode-structure")).toBeFocused();
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const [hash, mode, status] of [
  ["structure", "structure", "live"], ["mode-structure", "structure", "live"],
  ["players", "players", "live"], ["mode-players", "players", "live"],
  ["run", "run", "live"], ["mode-run", "run", "live"],
  ["final", "final", "finished"], ["mode-final", "final", "finished"],
] as const) {
  test(`legacy #${hash} retains its permitted match destination`, async ({ page }) => {
    const fixture = await installMatchFixture(page, { status });
    await page.goto(`${origin}${gamePath}#${hash}`);
    await expectReady(page);
    await expectOnlyMode(page, mode);
    expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const actor of ["viewer", "scorekeeper", "combined", "unknown"] as const) {
  test(`${actor} uses only the match capabilities and reads it actually has`, async ({ page }) => {
    const fixture = await installMatchFixture(page, { actor });
    await page.goto(`${origin}${gamePath}#teams`);
    await expectReady(page);
    await expectOnlyMode(page, "players");
    const operator = actor === "scorekeeper" || actor === "combined";
    await expect(displayedPlayers(page)).toHaveCount(operator ? 17 : 15);
    await expect(page.locator('[data-action="toggle-transfer"]')).toHaveCount(operator ? 15 : 0);
    if (operator) await expect(page.locator('[data-action="toggle-player-create"]')).toBeVisible();
    else await expect(page.locator('[data-action="toggle-player-create"]')).toBeHidden();
    if (actor !== "combined") {
      await expect(page.locator('[data-ui="claim-badge"]')).toHaveCount(0);
      await expect(page.locator('[data-action="grant-player-access"]')).toHaveCount(0);
    }
    const searches = fixture.requests.filter(request => request.path === `${apiGamePath}/players`);
    expect(searches).toHaveLength(operator ? 1 : 0);
    await page.getByTestId("game-mode-structure-tab").click();
    if (actor === "combined") await expect(page.locator('[data-action="toggle-game-edit"]')).toBeVisible();
    else await expect(page.locator('[data-action="toggle-game-edit"]')).toBeHidden();
    if (operator) await expect(page.getByTestId("game-mode-run-tab")).toBeVisible();
    else await expect(page.getByTestId("game-mode-run-tab")).toBeHidden();
    expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const actor of ["player-only", "cross-league"] as const) {
  test(`${actor} identity does not grant access to this league's match`, async ({ page }) => {
    const fixture = await installMatchFixture(page, { actor });
    await page.goto(`${origin}${gamePath}#score`);
    await expect(page.locator("#setup-error")).toBeVisible();
    await expect(page.locator("#game-title")).toHaveText("Game");
    await expect(page.getByTestId("game-mode-run-tab")).toBeHidden();
    await expect(page.locator('[data-action="toggle-game-edit"]')).toBeHidden();
    await expect(page.locator('[data-action="toggle-player-create"]')).toBeHidden();
    await expect(displayedPlayers(page)).toHaveCount(0);
    expect(fixture.requests.filter(request => request.path.startsWith(`${apiGamePath}/`))).toEqual([]);
    expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("unknown authority cannot briefly expose match administration or scoring", async ({ page }) => {
  const fixture = await installMatchFixture(page, { delayAuthority: true });
  await page.goto(`${origin}${gamePath}#score`);
  await expect.poll(() => fixture.requests.some(request => request.path === `/v1/leagues/${leagueId}`)).toBe(true);
  await expect(page.getByTestId("game-mode-run-tab")).toBeHidden();
  await expect(page.locator('[data-action="toggle-game-edit"]')).toBeHidden();
  await expect(page.locator('[data-action="toggle-player-create"]')).toBeHidden();
  await expect(page.getByTestId("save-game")).toBeDisabled();
  fixture.releaseAuthority();
  await expectReady(page);
  await expectOnlyMode(page, "run");
  expect(fixture.unexpected).toEqual([]);
});

test("match and player actions use the same keyboard-friendly kebab surfaces", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installMatchFixture(page);
  await page.goto(`${origin}${gamePath}#overview`);
  await expectReady(page);
  const header = page.locator('[data-ui="hero"] [data-ui="action-menu"]');
  const headerTrigger = header.locator('[data-action="toggle-action-menu"]');
  await headerTrigger.focus();
  await page.keyboard.press("Space");
  const headerSurface = header.locator('[data-ui="action-menu-surface"]');
  const create = page.getByTestId("create-another-game");
  await expect(create).toBeFocused();
  await expect(create).toHaveAttribute("href", `/leagues/${leagueId}/seasons/${seasonId}#create-game`);
  await expectActionSurfaceFits(page, headerSurface);
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("delete-game")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(headerTrigger).toBeFocused();
  await expect(headerSurface).toBeHidden();

  await page.getByTestId("game-mode-players-tab").click();
  const player = page.locator(`[data-ui="roster-player"][data-player-id="${fixture.players[0].playerId}"]`);
  const playerTrigger = player.locator('[data-action="toggle-action-menu"]');
  await playerTrigger.scrollIntoViewIfNeeded();
  const height = (await player.boundingBox())!.height;
  await playerTrigger.locator('[data-icon="ellipsis-vertical"]').click();
  const playerSurface = player.locator('[data-ui="action-menu-surface"]');
  await expect(playerSurface.locator('[data-action="grant-player-access"]').first()).toBeFocused();
  await expect(playerSurface.locator('[data-action="grant-player-access"]')).toHaveCount(2);
  await expectActionSurfaceFits(page, playerSurface);
  expect((await player.boundingBox())!.height).toBeCloseTo(height, 1);
  await expectMatchGeometry(page);
  await capture(page, testInfo, "player-kebab-open-dark-320");
  await page.keyboard.press("Escape");
  await expect(playerTrigger).toBeFocused();
  await expect(playerSurface).toBeHidden();
  await expect(page.locator('[data-ui="more-actions"], details[data-ui="player-management"]')).toHaveCount(0);
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("assigned-player action surfaces fit without native Popover support", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: undefined });
    Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value: undefined });
  });
  const fixture = await installMatchFixture(page);
  await page.goto(`${origin}${gamePath}#teams`);
  await expectReady(page);
  const member = page.locator(`[data-ui="roster-member"][data-player-id="${fixture.players[4].playerId}"]`);
  const trigger = member.locator('[data-action="toggle-action-menu"]');
  for (const zoom of [1, 2]) {
    await page.locator("html").evaluate((element, scale) => { element.style.zoom = String(scale); }, zoom);
    await trigger.scrollIntoViewIfNeeded();
    const height = (await member.boundingBox())!.height;
    await trigger.click();
    await expectActionSurfaceFits(page, member.locator('[data-ui="action-menu-surface"]'));
    expect((await member.boundingBox())!.height).toBeCloseTo(height, 1);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("finished match action menu retains an accessible inert delete reason", async ({ page }) => {
  const fixture = await installMatchFixture(page, { status: "finished" });
  await page.goto(`${origin}${gamePath}`);
  await expectReady(page);
  await page.locator('[data-ui="hero"] [data-action="toggle-action-menu"]').click();
  const surface = page.locator('[data-ui="hero"] [data-ui="action-menu-surface"]');
  await expect(page.getByTestId("create-another-game")).toBeFocused();
  await expect(page.getByTestId("delete-game")).toBeDisabled();
  await expect(page.getByTestId("delete-game")).toHaveAttribute("aria-describedby", "game-delete-lock-reason");
  await expect(page.locator("#game-delete-lock-reason")).toBeVisible();
  await expectActionSurfaceFits(page, surface);
  await page.keyboard.press("Escape");
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("native player entry preserves a failed draft and supports consecutive additions", async ({ page }) => {
  const fixture = await installMatchFixture(page, { failCreateOnce: true });
  await page.goto(`${origin}${gamePath}#teams`);
  await expectReady(page);
  await page.locator('[data-action="toggle-player-create"]').click();
  const input = page.getByLabel("Player name", { exact: true });
  await input.fill("Fictional Late Arrival");
  await page.keyboard.press("Enter");
  await expect(page.locator("#setup-error")).toBeVisible();
  await expect(input).toHaveValue("Fictional Late Arrival");
  await expect(page.getByTestId("quick-create-player")).toBeEnabled();
  await input.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('#player-pool [data-ui="roster-player"]')).toHaveCount(3);
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  const retries = fixture.requests.filter(request => request.method === "POST");
  expect(retries).toHaveLength(2);
  expect(retries[1].body).toEqual(retries[0].body);
  expect(retries[1].key).toBe(retries[0].key);
  expect(retries[0].key).toBeTruthy();
  await input.fill("Another Fictional Arrival");
  await page.keyboard.press("Enter");
  await expect(page.locator('#player-pool [data-ui="roster-player"]')).toHaveCount(4);
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  expect(fixture.requests.filter(request => request.method === "POST")).toHaveLength(3);
  expect(fixture.unexpected).toEqual([]);
});

test("transfer offers only alternatives, keeps failures open and collapses after success", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installMatchFixture(page, { failTransferOnce: true });
  await page.goto(`${origin}${gamePath}#teams`);
  await expectReady(page);
  const playerId = fixture.players[2].playerId;
  const trigger = page.locator(`[data-action="toggle-transfer"][data-player-id="${playerId}"]`);
  await trigger.focus();
  await page.keyboard.press("Enter");
  let menu = page.locator('[data-ui="transfer-menu"]:visible');
  await expect(menu).toHaveCount(1);
  await expect(menu.locator('[data-action="assign-player"]')).toHaveCount(2);
  await expect(menu.locator('[data-team-id="red"]')).toHaveCount(0);
  await expect(menu.locator('[data-team-id="blue"]')).toBeFocused();
  await expectMatchGeometry(page);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-ui="transfer-menu"]:visible')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  const otherTrigger = page.locator(`[data-action="toggle-transfer"][data-player-id="${fixture.players[3].playerId}"]`);
  await otherTrigger.click();
  await expect(page.locator('[data-ui="transfer-menu"]:visible')).toHaveCount(1);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(otherTrigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(otherTrigger).toBeFocused();
  await trigger.locator('[data-ui="icon"]').click();
  menu = page.locator('[data-ui="transfer-menu"]:visible');
  await page.setViewportSize({ width: 320, height: 900 });
  await expectMatchGeometry(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await menu.locator('[data-team-id="blue"]').click();
  await expect(page.locator("#setup-error")).toBeVisible();
  await expect(page.locator("#setup-error")).toHaveText("Assignment could not be confirmed. Retry this team choice or reload to check.");
  await expect(page.locator("#setup-status")).toBeHidden();
  await expect(page.locator("#setup-error")).not.toContainText("failed");
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-team-id="blue"]')).toBeEnabled();
  await expect(menu.locator('[data-team-id="blue"]')).toBeFocused();
  expect(fixture.assignments.get(playerId)).toBe("red");
  await capture(page, testInfo, "match-transfer-failed-dark-390");
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-ui="roster-team"][data-team-id="blue"] [data-ui="roster-member"][data-player-id="${playerId}"]`)).toHaveCount(1);
  await expect(page.locator('[data-ui="transfer-menu"]:visible')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(displayedPlayers(page)).toHaveCount(17);
  expect(fixture.requests.filter(request => request.method === "PUT")).toHaveLength(2);
  expect(fixture.unexpected).toEqual([]);
});

test("a capped player search never drops assigned identities or invents claim state", async ({ page }) => {
  const fixture = await installMatchFixture(page, { largeRoster: true });
  await page.goto(`${origin}${gamePath}#teams`);
  await expect(page.locator('[data-ui="roster-member"]')).toHaveCount(24);
  await expect(displayedPlayers(page)).toHaveCount(26);
  await expect(page.getByText("Search by name to find more players.", { exact: true })).toBeVisible();
  for (const player of fixture.players.slice(20)) {
    const member = page.locator(`[data-ui="roster-member"][data-player-id="${player.playerId}"]`);
    await expect(member).toContainText(player.nickname);
    await expect(member.locator('[data-ui="claim-badge"]')).toHaveCount(0);
  }
  const target = fixture.players.at(-1)!;
  await page.getByLabel("Search players", { exact: true }).fill(target.nickname);
  await expect.poll(() => fixture.requests.filter(request => request.path === `${apiGamePath}/players` && request.search === target.nickname).length).toBe(1);
  await expect(page.locator('[data-ui="roster-member"]')).toHaveCount(1);
  await expect(page.locator('[data-ui="roster-member"]')).toHaveAttribute("data-player-id", target.playerId);
  await page.getByLabel("Search players", { exact: true }).fill("");
  await expect(page.locator('[data-ui="roster-member"]')).toHaveCount(24);
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("missing private enrichment leaves the public roster readable without unclaimed assertions", async ({ page }) => {
  const fixture = await installMatchFixture(page, { playersUnavailable: true });
  await page.goto(`${origin}${gamePath}#teams`);
  await expectReady(page);
  await expect(displayedPlayers(page)).toHaveCount(15);
  await expect(page.locator('[data-ui="claim-badge"]')).toHaveCount(0);
  await expect(page.getByText("Unassigned players couldn’t be loaded. Try searching again.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-ui="roster-member"] strong').filter({ hasText: /^Sam$/ })).toHaveCount(2);
  expect(fixture.unexpected).toEqual([]);
});

test("finished teams and result corrections require an explicit administrator action", async ({ page }) => {
  const fixture = await installMatchFixture(page, { status: "finished" });
  await page.goto(`${origin}${gamePath}`);
  await expectReady(page);
  await expectOnlyMode(page, "final");
  await page.getByTestId("game-mode-players-tab").click();
  await expect(page.locator('[data-action="toggle-transfer"]')).toHaveCount(0);
  await expect(page.locator('[data-action="toggle-player-create"]')).toBeHidden();
  await page.locator('[data-action="edit-finished-teams"]').click();
  await expect(page.locator('[data-action="toggle-transfer"]')).toHaveCount(15);
  await expect(page.locator('[data-action="toggle-player-create"]')).toBeVisible();
  await page.getByTestId("game-mode-final-tab").click();
  await page.locator('[data-action="correct-finished-result"]').click();
  await expectOnlyMode(page, "run");
  await expect(page.getByTestId("game-mode-run")).toBeFocused();
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("a finished match stays read-only for a league scorekeeper", async ({ page }) => {
  const fixture = await installMatchFixture(page, { actor: "scorekeeper", status: "finished" });
  await page.goto(`${origin}${gamePath}#score`);
  await expectReady(page);
  await expectOnlyMode(page, "final");
  await expect(page.getByTestId("game-mode-run-tab")).toBeHidden();
  await expect(page.locator('[data-action="correct-finished-result"]')).toBeHidden();
  await page.getByTestId("game-mode-players-tab").click();
  await expect(displayedPlayers(page)).toHaveCount(17);
  await expect(page.locator('[data-action="edit-finished-teams"]')).toBeHidden();
  await expect(page.locator('[data-action="toggle-transfer"]')).toHaveCount(0);
  await expect(page.locator('[data-action="toggle-player-create"]')).toBeHidden();
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("enlarged roster text retains names and controls at phone width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installMatchFixture(page);
  await page.goto(`${origin}${gamePath}#teams`);
  await expectReady(page);
  await page.locator('[data-action="toggle-player-create"]').click();
  await page.getByLabel("Player name", { exact: true }).fill("Alexandra Francesca — unsent draft");
  // Deterministic 200% text-size fixture; not a claim of physical browser/device
  // zoom or software-keyboard coverage. Snapshot sizes before changing ancestors.
  await page.evaluate(() => {
    const sizes = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,p,label,strong,span,a,button,input,select,summary")]
      .map(element => ({ element, size: Number.parseFloat(getComputedStyle(element).fontSize) }));
    for (const { element, size } of sizes) element.style.fontSize = `${size * 2}px`;
  });
  await expectMatchGeometry(page);
  const escapedInitials = await page.locator('[data-ui="roster-player"] [data-ui="avatar"]').evaluateAll(avatars => avatars.flatMap(avatar => {
    const text = avatar.querySelector("span");
    if (!text) return ["Missing initials"];
    const range = document.createRange();
    range.selectNodeContents(text);
    const outer = avatar.getBoundingClientRect();
    const lines = [...range.getClientRects()];
    return lines.length !== 1 || lines.some(line => line.left < outer.left || line.right > outer.right || line.top < outer.top || line.bottom > outer.bottom)
      ? [text.textContent] : [];
  }));
  expect(escapedInitials, "Enlarged initials remain on one line inside their avatar").toEqual([]);
  await capture(page, testInfo, "match-teams-enlarged-text-200-dark-390");
  expect(fixture.unexpected).toEqual([]);
});
