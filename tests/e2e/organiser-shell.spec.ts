import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderLeaguePage, renderSeasonPage, renderSetupHomePage } from "../../app/dist/ui/layout.js";
import { expectActionSurfaceFits } from "./action-menu-helpers.js";

// Real production markup, CSS, icons and controller; only transport/data is fake.
// No QA requests, email, credentials, real games or local API workers are used.
// Run only after the app build and with THREEFC_SKIP_WEB_SERVER=1 --workers=1.
const origin = "https://3fc.fixture.test";
const leagueId = "fixture-community-league";
const seasonId = "fixture-spring-season";
const leagueName = "North Harbour Community Three Sided Football League";
const seasonName = "Spring and Summer Community Season 2026–2027";
const leaguePath = `/leagues/${leagueId}`;
const seasonPath = `${leaguePath}/seasons/${seasonId}`;
const apiLeaguePath = `/v1${leaguePath}`;
const apiSeasonPath = `/v1${seasonPath}`;
const assets = new Map(["styles.css", "icons.css", "setup-flow.js", "auth-flow.js"].map(name => [
  `/ui/${name}`, readFileSync(resolve("app/dist/ui", name), "utf8"),
]));

type Role = "admin" | "scorekeeper" | "viewer" | "unknown";
type FixtureRequest = { method: string; path: string; body: Record<string, unknown> | null; key?: string };
type FixtureSeason = { leagueId: string; seasonId: string; name: string; slug: string | null; startsOn: string | null; endsOn: string | null };
type FixtureOptions = { role?: Role; empty?: boolean; delayAuthority?: boolean; parentUnavailable?: boolean; dynamicSeason?: boolean; largeGameList?: boolean };

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function installFixture(page: Page, options: FixtureOptions = {}) {
  const requests: FixtureRequest[] = [];
  const unexpected: string[] = [];
  const authority = deferred();
  const role = options.role ?? "admin";
  const league = {
    leagueId, name: leagueName, slug: leagueId, createdByUserId: "fictional-organiser",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const seasons: FixtureSeason[] = [
    { leagueId, seasonId, name: seasonName, slug: seasonId, startsOn: "2026-09-06", endsOn: "2027-02-28" },
    { leagueId, seasonId: "fixture-dates-pending", name: "Sunday Community Season — Dates To Be Announced", slug: null, startsOn: null, endsOn: null },
  ];
  const games = [
    // Deliberately unordered. Kickoffs include a Melbourne date boundary.
    { gameId: "fixture-scheduled", leagueId, seasonId, gameStartTs: "2026-09-12T23:30:00.000Z", status: "scheduled" },
    { gameId: "fixture-finished-older", leagueId, seasonId, gameStartTs: "2026-08-29T23:30:00.000Z", status: "finished" },
    { gameId: "fixture-live", leagueId, seasonId, gameStartTs: "2026-09-05T23:30:00.000Z", status: "live" },
    { gameId: "fixture-finished-newer", leagueId, seasonId, gameStartTs: "2026-08-30T23:30:00.000Z", status: "finished" },
  ];
  if (options.largeGameList) games.push(...Array.from({ length: 20 }, (_, index) => ({
    gameId: `fixture-later-game-${index}`, leagueId, seasonId,
    gameStartTs: new Date(Date.UTC(2026, 9, 4 + index * 7, 0, 30)).toISOString(), status: "scheduled",
  })));
  const createdLeagues = new Map<string, typeof league>();
  const createdSeasons = new Map<string, (typeof seasons)[number]>();

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`External request: ${url.origin}${url.pathname}`);
      return route.abort();
    }
    const asset = assets.get(url.pathname);
    if (asset !== undefined) return route.fulfill({ body: asset, contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    if (!url.pathname.startsWith("/v1/")) {
      if (url.pathname === "/setup") return route.fulfill({ contentType: "text/html", body: renderSetupHomePage(origin) });
      const nested = /^\/leagues\/([^/]+)\/seasons\/([^/]+)$/.exec(url.pathname);
      if (nested) return route.fulfill({ contentType: "text/html", body: options.dynamicSeason
        ? renderLeaguePage(origin, nested[1]) : renderSeasonPage(origin, nested[2], nested[1]) });
      const legacy = /^\/seasons\/([^/]+)$/.exec(url.pathname);
      if (legacy) return route.fulfill({ contentType: "text/html", body: renderSeasonPage(origin, legacy[1]) });
      const leagueRoute = /^\/leagues\/([^/]+)$/.exec(url.pathname);
      if (leagueRoute) return route.fulfill({ contentType: "text/html", body: renderLeaguePage(origin, leagueRoute[1]) });
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }

    const method = request.method();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    requests.push({ method, path: url.pathname, body, key: request.headers()["idempotency-key"] });
    if (method === "GET" && url.pathname === "/v1/auth/session") {
      return route.fulfill({ headers: { "cache-control": "no-store" }, json: { authenticated: true, session: { email: "organiser.fixture@example.com" } } });
    }
    if (method === "GET" && url.pathname === "/v1/leagues") {
      return route.fulfill({ json: { leagues: options.empty ? [] : [league] } });
    }
    if (method === "GET" && url.pathname === apiLeaguePath) {
      if (options.delayAuthority) await authority.promise;
      if (options.parentUnavailable) return route.fulfill({ status: 503, json: { error: "unavailable" } });
      return route.fulfill({ json: { ...league, ...(role === "unknown" ? {} : { access: { role } }) } });
    }
    if (method === "GET" && url.pathname === `${apiLeaguePath}/seasons`) {
      return route.fulfill({ json: { seasons: options.empty ? [] : seasons } });
    }
    if (method === "GET" && (url.pathname === apiSeasonPath || url.pathname === `/v1/seasons/${seasonId}`)) {
      return route.fulfill({ json: seasons[0] });
    }
    if (method === "GET" && url.pathname === `${apiSeasonPath}/games`) {
      return route.fulfill({ json: { games: options.empty ? [] : games } });
    }
    if (method === "POST" && url.pathname === "/v1/leagues" && body) {
      const created = { ...league, leagueId: String(body.leagueId), name: String(body.name), slug: String(body.slug) };
      createdLeagues.set(created.leagueId, created);
      return route.fulfill({ status: 201, json: created });
    }
    if (method === "POST" && url.pathname === `${apiLeaguePath}/seasons` && body && role === "admin") {
      const created = { ...seasons[0], seasonId: String(body.seasonId), name: String(body.name), slug: String(body.slug) };
      createdSeasons.set(created.seasonId, created);
      return route.fulfill({ status: 201, json: created });
    }
    if (method === "POST" && url.pathname === `${apiLeaguePath}/organiser-invites` && body?.email === null && role === "admin") {
      return route.fulfill({ status: 201, json: {
        inviteCode: "FICTIONAL-ORGANISER-INVITE",
        inviteLink: `${origin}/invites/FICTIONAL-ORGANISER-INVITE`,
      } });
    }
    const createdLeagueRoute = /^\/v1\/leagues\/([^/]+)(\/seasons)?$/.exec(url.pathname);
    if (method === "GET" && createdLeagueRoute && createdLeagues.has(createdLeagueRoute[1])) {
      return route.fulfill({ json: createdLeagueRoute[2] ? { seasons: [] } : { ...createdLeagues.get(createdLeagueRoute[1]), access: { role: "admin" } } });
    }
    const createdSeasonRoute = new RegExp(`^${apiLeaguePath}/seasons/([^/]+)(/games)?$`).exec(url.pathname);
    if (method === "GET" && createdSeasonRoute && createdSeasons.has(createdSeasonRoute[1])) {
      return route.fulfill({ json: createdSeasonRoute[2] ? { games: [] } : createdSeasons.get(createdSeasonRoute[1]) });
    }
    unexpected.push(`${method} ${url.pathname}`);
    return route.abort();
  });
  return { requests, unexpected, releaseAuthority: authority.release };
}

async function expectGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, summary")]
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true }));
    return {
      viewport: innerWidth,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      offCanvasTargets: visible.flatMap(element => {
        const { left, right } = element.getBoundingClientRect();
        return left < -0.1 || right > innerWidth + 0.1
          ? [{ label: element.getAttribute("aria-label") || element.textContent?.trim() || element.id, left, right }] : [];
      }),
      narrowPrimaryCells: [...document.querySelectorAll<HTMLElement>('[data-ui="data-table"] tbody tr > td:first-child')]
        .filter(element => element.checkVisibility({ checkVisibilityCSS: true }))
        .flatMap(element => {
          const { width } = element.getBoundingClientRect();
          return width < Math.min(160, innerWidth * 0.4) ? [{ text: element.textContent?.trim(), width }] : [];
        }),
      smallTargets: visible.flatMap(element => {
        const { width, height } = element.getBoundingClientRect();
        return width < 43.9 || height < 43.9
          ? [{ label: element.getAttribute("aria-label") || element.textContent?.trim() || element.id, width, height }] : [];
      }),
      fragmentedStatuses: [...document.querySelectorAll<HTMLElement>('[data-ui="status-chip"]')]
        .filter(element => element.checkVisibility({ checkVisibilityCSS: true }))
        .flatMap(element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const problems = [];
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            if (range.getClientRects().length !== 1) problems.push(element.textContent?.trim());
          }
          const icon = element.querySelector<HTMLElement>('[data-ui="icon"]');
          if (icon && icon.getBoundingClientRect().width < icon.getBoundingClientRect().height - 0.1) {
            problems.push(`${element.textContent?.trim()} icon shrank`);
          }
          return problems;
        }),
    };
  });
  expect(geometry.overflow, "The page must not require horizontal scrolling").toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.offCanvasTargets, "Actions must not extend beyond the viewport").toEqual([]);
  expect(geometry.narrowPrimaryCells, "The primary name/date column must retain usable reading width").toEqual([]);
  expect(geometry.smallTargets, "Visible interactive controls need at least a 44×44px effective target").toEqual([]);
  expect(geometry.fragmentedStatuses, "Short status words and their icons must remain intact").toEqual([]);
}

async function expectSharedShell(page: Page, title: string) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", "/setup");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page.getByText("organiser.fixture@example.com", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Performance", exact: true })).toHaveCount(0);
  const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
  if ((page.viewportSize()?.width ?? 1280) < 768 && await breadcrumbs.count()) {
    // The header retains Home. Its duplicate breadcrumb link must be genuinely
    // hidden, not a visually hidden off-screen keyboard stop.
    await expect(breadcrumbs.getByRole("link", { name: "Home", exact: true })).toHaveCount(0);
    await expect(breadcrumbs.locator('a[href="/setup"]')).toBeHidden();
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

const leagueActions = (page: Page) => page.locator('[data-action="toggle-action-menu"][aria-controls="league-actions"]');

async function chooseLeagueAction(page: Page, action: "toggle-create-season" | "toggle-organiser-invite") {
  const trigger = leagueActions(page);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#league-actions")).toBeVisible();
  const item = page.getByTestId(action);
  await item.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#league-actions")).toBeHidden();
}

test.use({ timezoneId: "Australia/Melbourne" });

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [320, 390, 430, 768, 1280]) {
    test(`organiser lists and focused forms ${colorScheme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const fixture = await installFixture(page);
      const shouldCapture = width === 390 || (width === 1280 && colorScheme === "dark");

      await page.goto(`${origin}/setup`);
      await expectSharedShell(page, "Welcome");
      const leagues = page.getByRole("table", { name: "Leagues", exact: true });
      await expect(leagues.getByRole("link", { name: leagueName, exact: true })).toBeVisible();
      await expect(leagues.getByRole("columnheader")).toHaveCount(1);
      await expect(leagues.locator("button")).toHaveCount(0);
      const createLeague = page.getByTestId("toggle-create-league");
      await expect(createLeague).toHaveText("Create a new league");
      await expect(page.locator("#dashboard-create-league-region")).toBeHidden();
      expect((await createLeague.boundingBox())!.y).toBeGreaterThanOrEqual((await leagues.boundingBox())!.y + (await leagues.boundingBox())!.height);
      await expectGeometry(page);
      if (shouldCapture) await capture(page, testInfo, `home-${colorScheme}-${width}`);

      await createLeague.focus();
      await page.keyboard.press("Enter");
      const leagueInput = page.getByLabel("League name", { exact: true });
      await expect(leagueInput).toBeFocused();
      await leagueInput.fill("Sunday community draft");
      const leagueForm = page.getByRole("form", { name: "Create league", exact: true });
      const options = leagueForm.locator("summary");
      await options.focus();
      await page.keyboard.press("Enter");
      await expect(leagueForm.getByLabel("Friendly URL", { exact: true })).toBeVisible();
      await expect(page.locator("#dashboard-create-league-region")).toBeVisible();
      await expect(createLeague).toHaveAttribute("aria-expanded", "true");
      await expectGeometry(page);
      await leagueForm.getByRole("button", { name: "Cancel", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#dashboard-create-league-region")).toBeHidden();
      await expect(createLeague).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(leagueInput).toHaveValue("Sunday community draft");
      await page.keyboard.press("Escape");
      await expect(createLeague).toBeFocused();

      await leagues.getByRole("link", { name: leagueName, exact: true }).click();
      await expectSharedShell(page, leagueName);
      const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
      await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText(leagueName);
      const seasons = page.getByRole("table", { name: "Seasons", exact: true });
      const seasonLink = seasons.getByRole("link", { name: seasonName, exact: true });
      await expect(seasonLink).toHaveAttribute("href", seasonPath);
      const expectedDates = await page.evaluate(() => ["2026-09-06", "2027-02-28"].map(value => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`))).join(" – "));
      await expect(seasons.getByRole("cell", { name: expectedDates, exact: true })).toBeVisible();
      await expect(seasons.getByRole("cell", { name: "Dates not set", exact: true })).toBeVisible();
      await expect(page.getByTestId("toggle-create-season")).toHaveText("Create season");
      await expect(page.getByTestId("toggle-organiser-invite")).toHaveText("Invite organiser");
      await expect(page.getByTestId("toggle-create-season")).toBeHidden();
      await expect(page.getByTestId("toggle-organiser-invite")).toBeHidden();
      await expect(page.getByTestId("delete-league")).toBeHidden();
      await expectGeometry(page);
      if (shouldCapture) await capture(page, testInfo, `league-${colorScheme}-${width}`);
      const more = leagueActions(page);
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("delete-league")).toBeVisible();
      await expect(page.getByTestId("toggle-create-season")).toBeFocused();
      await expect(page.locator("#league-actions").getByRole("button")).toHaveText(["Create season", "Invite organiser", "Delete league"]);
      await expectActionSurfaceFits(page, page.locator("#league-actions"));
      await expectGeometry(page);
      if (shouldCapture) await capture(page, testInfo, `league-actions-${colorScheme}-${width}`);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("delete-league")).toBeHidden();
      await expect(more).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Season name", { exact: true })).toBeFocused();
      await expect(page.locator("#league-actions")).toBeHidden();
      await page.getByRole("form", { name: "Create season", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.locator("#league-create-season-region")).toBeHidden();
      await expect(more).toBeFocused();

      await seasonLink.click();
      await expectSharedShell(page, seasonName);
      const seasonBreadcrumbs = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
      await expect(seasonBreadcrumbs.getByRole("link", { name: leagueName, exact: true })).toHaveAttribute("href", leaguePath);
      await expect(seasonBreadcrumbs.locator('[aria-current="page"]')).toHaveText(seasonName);
      const upcoming = page.getByRole("table", { name: "Upcoming games", exact: true });
      const completed = page.getByRole("table", { name: "Completed games", exact: true });
      await expect(upcoming.locator("tbody tr")).toHaveCount(2);
      await expect(completed.locator("tbody tr")).toHaveCount(2);
      await expect(upcoming.locator("tbody a").first()).toHaveAttribute("href", "/games/fixture-live");
      await expect(upcoming.locator("tbody a").nth(1)).toHaveAttribute("href", "/games/fixture-scheduled");
      await expect(completed.locator("tbody a").first()).toHaveAttribute("href", "/games/fixture-finished-newer");
      await expect(upcoming.locator('[data-ui="status-chip"]')).toHaveText(["Live", "Scheduled"]);
      await expect(completed.locator('[data-ui="status-chip"]')).toHaveText(["Finished", "Finished"]);
      const expectedKickoff = await page.evaluate(() => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date("2026-09-12T23:30:00.000Z")));
      await expect(upcoming.locator("tbody a").nth(1)).toHaveText(expectedKickoff);
      expect((await completed.boundingBox())!.y).toBeGreaterThan((await upcoming.boundingBox())!.y);
      await expect(page.getByTestId("toggle-create-game")).toHaveText("Create game");
      await expect(page.locator("#season-create-game-region")).toBeHidden();
      await expectGeometry(page);
      if (shouldCapture) await capture(page, testInfo, `season-${colorScheme}-${width}`);

      const finishedRow = completed.locator("tbody tr").first();
      const finishedMore = finishedRow.locator('[data-action="toggle-action-menu"]');
      await finishedMore.scrollIntoViewIfNeeded();
      const rowHeight = (await finishedRow.boundingBox())!.height;
      const dateWidth = (await finishedRow.locator("td").first().boundingBox())!.width;
      await finishedMore.focus();
      await page.keyboard.press("Enter");
      const finishedDelete = finishedRow.locator('[data-ui="action-menu-surface"] button');
      await expect(finishedDelete).toBeVisible();
      await expect(finishedDelete).toBeDisabled();
      await expect(finishedRow.getByText(/Finished games (?:can’t|cannot) be deleted\./)).toBeVisible();
      const finishedSurface = finishedRow.locator('[data-ui="action-menu-surface"]');
      await expect(finishedSurface).toBeFocused();
      await expectActionSurfaceFits(page, finishedSurface);
      expect((await finishedRow.boundingBox())!.height).toBeCloseTo(rowHeight, 1);
      expect((await finishedRow.locator("td").first().boundingBox())!.width).toBeCloseTo(dateWidth, 1);
      await expectGeometry(page);
      if (width === 320 && colorScheme === "dark") await capture(page, testInfo, "season-finished-action-menu-dark-320");
      await page.keyboard.press("Escape");
      await expect(finishedDelete).toBeHidden();
      await expect(finishedMore).toBeFocused();

      const createGame = page.getByTestId("toggle-create-game");
      await createGame.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Game date", { exact: true })).toBeFocused();
      const gameForm = page.getByRole("form", { name: "Create game", exact: true });
      await page.getByLabel("Game date", { exact: true }).fill("2026-10-04");
      await page.getByLabel("Third length", { exact: true }).selectOption("25");
      await expectGeometry(page);
      await gameForm.getByRole("button", { name: "Cancel", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#season-create-game-region")).toBeHidden();
      await expect(createGame).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Game date", { exact: true })).toHaveValue("2026-10-04");
      await expect(page.getByLabel("Third length", { exact: true })).toHaveValue("25");
      expect(fixture.requests.filter(request => request.path === apiLeaguePath)).toHaveLength(2); // One league read on each page, no fan-out.
      expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

test("simulated 200% CSS zoom preserves organiser reading and actions", async ({ page }, testInfo) => {
  // This is a deterministic reflow proxy: 768 physical pixels / CSS zoom 2.
  // It is not evidence of a physical browser zoom, mobile keyboard or device.
  testInfo.annotations.push({ type: "coverage", description: "Simulated CSS zoom only; physical-device/browser zoom remains separate acceptance." });
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installFixture(page);
  for (const surface of [
    { path: "/setup", title: "Welcome", table: "Leagues" },
    { path: leaguePath, title: leagueName, table: "Seasons" },
    { path: seasonPath, title: seasonName, table: "Upcoming games" },
  ]) {
    await page.goto(`${origin}${surface.path}`);
    await expectSharedShell(page, surface.title);
    await expect(page.getByRole("table", { name: surface.table, exact: true })).toBeVisible();
    await page.locator("html").evaluate(element => { element.style.zoom = "2"; });
    await expectGeometry(page);
    const trigger = page.locator('[data-action="toggle-action-menu"]').first();
    if (await trigger.count()) {
      await trigger.click();
      await expectActionSurfaceFits(page, page.locator('[data-ui="action-menu-surface"]:visible'));
      await expectGeometry(page);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
  }
  await page.getByTestId("toggle-create-game").click();
  await expect(page.getByLabel("Game date", { exact: true })).toBeFocused();
  await expectGeometry(page);
  await capture(page, testInfo, "season-simulated-css-zoom-200-dark-768");
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("game-list action menus keep rows stable and dismiss without stealing destination focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installFixture(page, { largeGameList: true });
  await page.goto(`${origin}${seasonPath}`);
  const rows = page.getByRole("table", { name: "Upcoming games", exact: true }).locator("tbody tr");
  const first = rows.first();
  const trigger = first.locator('[data-action="toggle-action-menu"]');
  await expect(trigger).toBeVisible();
  await trigger.scrollIntoViewIfNeeded();
  const height = (await first.boundingBox())!.height;
  await trigger.locator('[data-icon="ellipsis-vertical"]').click();
  const surface = first.locator('[data-ui="action-menu-surface"]');
  const action = surface.locator('[data-action="delete-game"]');
  await expect(action).toBeFocused();
  await expectActionSurfaceFits(page, surface);
  expect((await first.boundingBox())!.height).toBeCloseTo(height, 1);
  await capture(page, testInfo, "game-list-kebab-open-dark-320");

  const secondTrigger = rows.nth(1).locator('[data-action="toggle-action-menu"]');
  await secondTrigger.click();
  await expect(surface).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-ui="action-menu-surface"]:visible')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(secondTrigger).toBeFocused();

  await trigger.click();
  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(first.locator("a")).toBeFocused();
  await expect(surface).toBeHidden();
  await trigger.click();
  await page.getByTestId("toggle-create-game").click();
  await expect(surface).toBeHidden();
  await expect(page.getByLabel("Game date", { exact: true })).toBeFocused();
  await page.getByRole("form", { name: "Create game", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();

  // Native confirmation cancellation must not send a deletion or leave focus
  // on a hidden action. The fixture deliberately implements no DELETE route.
  let confirmations = 0;
  page.on("dialog", async dialog => { confirmations += 1; await dialog.dismiss(); });
  await trigger.click();
  await action.locator('[data-ui="icon"]').click();
  await expect(surface).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(confirmations).toBe(1);
  await trigger.click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(surface).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // The detached popup must not follow the viewport after its row leaves view.
  const scrolledTrigger = (await trigger.boundingBox())!;
  expect(scrolledTrigger.y + scrolledTrigger.height).toBeLessThanOrEqual(0);
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("action surfaces retain viewport positioning without native Popover methods", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: undefined });
    Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value: undefined });
  });
  const fixture = await installFixture(page, { largeGameList: true });
  await page.goto(`${origin}${seasonPath}`);
  const row = page.getByRole("table", { name: "Upcoming games", exact: true }).locator("tbody tr").nth(10);
  const trigger = row.locator('[data-action="toggle-action-menu"]');
  await trigger.scrollIntoViewIfNeeded();
  const height = (await row.boundingBox())!.height;
  await trigger.click();
  await expectActionSurfaceFits(page, row.locator('[data-ui="action-menu-surface"]'));
  expect((await row.boundingBox())!.height).toBeCloseTo(height, 1);
  await expectGeometry(page);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.locator("html").evaluate(element => { element.style.zoom = "2"; });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expectActionSurfaceFits(page, row.locator('[data-ui="action-menu-surface"]'));
  await page.keyboard.press("Escape");
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("organiser invitation opens intentionally and reuses its fictional share link", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installFixture(page);
  await page.goto(`${origin}${leaguePath}`);
  await expectSharedShell(page, leagueName);
  await expect(page.getByRole("table", { name: "Seasons", exact: true })).toBeVisible();
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  await chooseLeagueAction(page, "toggle-create-season");
  await page.getByLabel("Season name", { exact: true }).fill("Keep the season draft");
  await chooseLeagueAction(page, "toggle-organiser-invite");
  const form = page.getByRole("form", { name: "Invite organiser", exact: true });
  await expect(form).toBeVisible();
  await expect(page.locator("#league-create-season-region")).toBeHidden();
  await expect(page.getByLabel("Organiser email", { exact: true })).toBeFocused();
  await expect(page.locator("#organiser-share-invite-code")).toHaveText("FICTIONAL-ORGANISER-INVITE");
  await expect(page.locator("#organiser-share-invite-link")).toHaveAttribute("href", `${origin}/invites/FICTIONAL-ORGANISER-INVITE`);
  await expect(form.getByText("Only this email address can accept.", { exact: true })).toBeVisible();
  await page.getByLabel("Organiser email", { exact: true }).fill("recipient.fixture@example.com");
  await expectGeometry(page);
  await capture(page, testInfo, "league-invite-expanded-dark-390");
  await form.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(form).toBeHidden();
  await expect(leagueActions(page)).toBeFocused();
  await chooseLeagueAction(page, "toggle-organiser-invite");
  await expect(form).toBeVisible();
  await expect(page.getByLabel("Organiser email", { exact: true })).toHaveValue("recipient.fixture@example.com");
  await expect(page.locator("#organiser-share-invite-code")).toHaveText("FICTIONAL-ORGANISER-INVITE");
  const writes = fixture.requests.filter(request => request.method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ method: "POST", path: `${apiLeaguePath}/organiser-invites`, body: { email: null } });
  expect(writes[0].key).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(leagueActions(page)).toBeFocused();
  await chooseLeagueAction(page, "toggle-create-season");
  await expect(page.getByLabel("Season name", { exact: true })).toHaveValue("Keep the season draft");
  expect(fixture.unexpected).toEqual([]);
});

for (const role of ["scorekeeper", "viewer", "unknown"] as const) {
  test(`${role} reads remain useful without management controls`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await installFixture(page, { role });
    await page.goto(`${origin}${leaguePath}`);
    await expectSharedShell(page, leagueName);
    await expect(page.getByRole("table", { name: "Seasons", exact: true })).toBeVisible();
    await expect(page.getByTestId("toggle-create-season")).toBeHidden();
    await expect(page.getByTestId("toggle-organiser-invite")).toBeHidden();
    await expect(page.getByTestId("delete-league")).toBeHidden();
    await expect(page.getByTestId("create-season")).toBeDisabled();
    await expect(page.locator('[data-ui="more-actions"]:visible')).toHaveCount(0);
    await page.goto(`${origin}${seasonPath}#create-game`);
    await expectSharedShell(page, seasonName);
    await expect(page.getByRole("table", { name: "Upcoming games", exact: true })).toBeVisible();
    await expect(page.getByTestId("toggle-create-game")).toBeHidden();
    await expect(page.getByTestId("create-game")).toBeDisabled();
    await expect(page.getByTestId("delete-season")).toBeHidden();
    await expect(page.locator("#season-create-game-region")).toBeHidden();
    await expect(page.locator('[data-ui="more-actions"]:visible')).toHaveCount(0);
    await expectGeometry(page);
    expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
    expect(fixture.requests.filter(request => request.path === apiLeaguePath)).toHaveLength(2);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("authority is computed-hidden until the bounded parent read resolves", async ({ page }) => {
  const fixture = await installFixture(page, { delayAuthority: true });
  await page.goto(`${origin}${seasonPath}#create-game`);
  await expect.poll(() => fixture.requests.filter(request => request.path === apiLeaguePath).length).toBe(1);
  await expect(page.getByTestId("toggle-create-game")).toBeHidden();
  await expect(page.getByTestId("create-game")).toBeDisabled();
  await expect(page.locator("#season-create-game-region")).toBeHidden();
  fixture.releaseAuthority();
  await expect(page.getByTestId("toggle-create-game")).toBeVisible();
  await expect(page.getByTestId("toggle-create-game")).toBeEnabled();
  await expect(page.locator("#season-create-game-region")).toBeVisible();
  await expect(page.getByLabel("Game date", { exact: true })).toBeFocused();
  expect(fixture.requests.filter(request => request.path === apiLeaguePath)).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test("league loading starts neutral with creation and invitation controls hidden", async ({ page }) => {
  const fixture = await installFixture(page, { delayAuthority: true });
  await page.goto(`${origin}${leaguePath}`);
  await expect.poll(() => fixture.requests.filter(request => request.path === apiLeaguePath).length).toBe(1);
  await expect(page.getByRole("heading", { level: 1, name: "League", exact: true })).toBeVisible();
  await expect(page.getByTestId("toggle-create-season")).toBeHidden();
  await expect(page.getByTestId("toggle-organiser-invite")).toBeHidden();
  await expect(page.getByTestId("create-season")).toBeDisabled();
  await expect(page.getByTestId("create-organiser-invite")).toBeDisabled();
  await expect(page.getByTestId("delete-league")).toBeHidden();
  await expect(page.getByText("No seasons yet.", { exact: true })).toBeHidden();
  fixture.releaseAuthority();
  await expectSharedShell(page, leagueName);
  await expect(leagueActions(page)).toBeVisible();
  await expect(page.getByTestId("toggle-create-season")).toBeHidden();
  await expect(page.getByTestId("toggle-organiser-invite")).toBeHidden();
  await expect(page.getByRole("table", { name: "Seasons", exact: true })).toBeVisible();
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("unavailable parent authority does not hide permitted season data or enable hash-driven creation", async ({ page }) => {
  const fixture = await installFixture(page, { parentUnavailable: true });
  await page.goto(`${origin}${seasonPath}#create-game`);
  await expect(page.getByRole("table", { name: "Upcoming games", exact: true })).toBeVisible();
  await expect(page.getByTestId("toggle-create-game")).toBeHidden();
  await expect(page.getByTestId("create-game")).toBeDisabled();
  await expect(page.locator("#season-create-game-region")).toBeHidden();
  expect(fixture.requests.filter(request => request.path === apiLeaguePath)).toHaveLength(1);
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("empty pages announce real absences without stealing focus or reopening a cancelled draft", async ({ page }) => {
  const fixture = await installFixture(page, { empty: true });
  await page.goto(`${origin}/setup`);
  await expect(page.getByText("No leagues to show.", { exact: true })).toBeVisible();
  await expect(page.locator("#dashboard-create-league-region")).toBeVisible();
  await expect(page.getByLabel("League name", { exact: true })).not.toBeFocused();
  await page.getByLabel("League name", { exact: true }).fill("Keep this name");
  await page.getByRole("form", { name: "Create league", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#dashboard-create-league-region")).toBeHidden();
  await expect(page.getByTestId("toggle-create-league")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("League name", { exact: true })).toHaveValue("Keep this name");
  await page.goto(`${origin}${leaguePath}`);
  await expect(page.getByText("No seasons yet.", { exact: true })).toBeVisible();
  await expect(page.locator("#league-create-season-region")).toBeHidden();
  await page.goto(`${origin}${seasonPath}`);
  await expect(page.getByText("No upcoming games.", { exact: true })).toBeVisible();
  await expect(page.getByText("No completed games.", { exact: true })).toBeVisible();
  await expect(page.locator("#season-create-game-region")).toBeHidden();
  expect(fixture.unexpected).toEqual([]);
});

test("native Enter creates a league and a season once with existing scoped destinations", async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto(`${origin}/setup`);
  await expect(page.getByRole("table", { name: "Leagues", exact: true }).getByRole("link", { name: leagueName, exact: true })).toBeVisible();
  await page.getByTestId("toggle-create-league").click();
  await page.getByLabel("League name", { exact: true }).fill("Fictional Sunday League");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${origin}/leagues/fictional-sunday-league`);
  await expect(page.getByRole("heading", { level: 1, name: "Fictional Sunday League", exact: true })).toBeVisible();
  const leagueWrites = fixture.requests.filter(request => request.method === "POST" && request.path === "/v1/leagues");
  expect(leagueWrites).toHaveLength(1);
  expect(leagueWrites[0].body).toMatchObject({ leagueId: "fictional-sunday-league", name: "Fictional Sunday League" });
  expect(leagueWrites[0].key).toBeTruthy();

  await page.goto(`${origin}${leaguePath}`);
  await chooseLeagueAction(page, "toggle-create-season");
  await expect(page.getByLabel("Season name", { exact: true })).toBeFocused();
  await page.getByLabel("Season name", { exact: true }).fill("Fictional Autumn Season");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${origin}${leaguePath}/seasons/fictional-autumn-season`);
  await expect(page.getByRole("heading", { level: 1, name: "Fictional Autumn Season", exact: true })).toBeVisible();
  const seasonWrites = fixture.requests.filter(request => request.method === "POST" && request.path === `${apiLeaguePath}/seasons`);
  expect(seasonWrites).toHaveLength(1);
  expect(seasonWrites[0].body).toMatchObject({ seasonId: "fictional-autumn-season", name: "Fictional Autumn Season" });
  expect(seasonWrites[0].key).toBeTruthy();
  expect(fixture.unexpected).toEqual([]);
});

for (const variant of ["static-nested", "legacy-season"] as const) {
  test(`${variant} renders the same useful season shell`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await installFixture(page, { dynamicSeason: variant === "static-nested" });
    await page.goto(`${origin}${variant === "static-nested" ? seasonPath : `/seasons/${seasonId}`}#create-game`);
    await expectSharedShell(page, seasonName);
    await expect(page.getByRole("navigation", { name: "Breadcrumb", exact: true }).getByRole("link", { name: leagueName, exact: true })).toHaveAttribute("href", leaguePath);
    await expect(page.getByRole("table", { name: "Upcoming games", exact: true })).toBeVisible();
    await expect(page.getByRole("form", { name: "Create game", exact: true })).toBeVisible();
    await expect(page.getByLabel("Game date", { exact: true })).toBeFocused();
    await page.getByRole("form", { name: "Create game", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("#season-create-game-region")).toBeHidden();
    await expect(page.getByTestId("toggle-create-game")).toBeFocused();
    await expectGeometry(page);
    expect(fixture.requests.filter(request => request.path === apiLeaguePath)).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);
  });
}
