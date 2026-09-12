import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderGamePage } from "../../app/dist/ui/layout.js";

// Production-built HTML/CSS/controller with fictional, fully intercepted data.
// No API server, AWS, email, QA account or real match is used. Build first; run
// with THREEFC_SKIP_WEB_SERVER=1 and one worker under the repository guard.
const origin = "https://3fc.fixture.test";
const gameId = "fictional-live-scoring";
const leagueId = "fictional-scoring-league";
const seasonId = "fictional-scoring-season";
const gamePath = `/games/${gameId}`;
const apiPath = `/v1${gamePath}`;
const now = "2026-09-13T01:05:00.000Z";
const kickoff = "2026-09-13T00:00:00.000Z";
const teamIds = ["red", "blue", "yellow"] as const;
type TeamId = (typeof teamIds)[number];
type Status = "scheduled" | "live" | "finished";
type Role = "admin" | "scorekeeper" | "viewer" | "unknown";
type RequestRecord = { method: string; path: string; body: Record<string, unknown> | null; key?: string };
type Goal = {
  gameId: string; eventId: string; third: number; thirdMinute: number; gameMinute: number;
  elapsedSeconds: number; stoppageMinute: number | null; displayTime: string;
  scoringTeamId: TeamId | null; concedingTeamId: TeamId; scorerPlayerId: string;
  assistPlayerIds: string[]; ownGoal: boolean; createdAt: string; updatedAt: string;
};
type Options = { status?: Status; role?: Role; emptyGoals?: boolean; unavailableGoals?: boolean; malformedColors?: boolean; stoppage?: boolean };
type Plan = { kind: "goal" | "clock"; gate?: ReturnType<typeof deferred>; status?: number; commit?: boolean; failGoalRead?: boolean; failGameRead?: boolean };
const assets = new Map(["player-proof.js", "player-consolidation.js", "player-presentation-browser.js", "styles.css", "icons.css", "setup-flow.js", "auth-flow.js", "modal.js"].map(name => [
  `/ui/${name}`, readFileSync(resolve("app/dist/ui", name), "utf8"),
]));

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function snapshot<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

async function installScoringFixture(page: Page, options: Options = {}) {
  await page.clock.setFixedTime(new Date(now));
  const role = options.role ?? "admin";
  const status = options.status ?? "live";
  const players = Array.from({ length: 18 }, (_, index) => ({
    playerId: `fictional-player-${String(index + 1).padStart(2, "0")}`,
    nickname: index === 0 ? "Alexandra Francesca Montgomery-Williams"
      : index === 6 ? "Ibrahim O’Connell-Rodríguez"
        : index === 12 ? "Morgan Alexandra Montgomery-Williams"
          : index === 1 || index === 7 ? "Sam" : `Fictional Player ${index + 1}`,
    createdAt: kickoff, updatedAt: kickoff,
  }));
  const assignment = new Map(players.map((player, index) => [player.playerId, teamIds[Math.floor(index / 6)]]));
  let sequence = 0;
  const goals: Goal[] = [];
  function appendGoal(input: Partial<Goal> = {}) {
    sequence += 1;
    const third = input.third ?? 3;
    const elapsedSeconds = input.elapsedSeconds ?? 300;
    const thirdMinute = Math.floor(elapsedSeconds / 60) + 1;
    const goal: Goal = {
      gameId, eventId: `fictional-goal-${sequence}`, third, thirdMinute,
      gameMinute: (third - 1) * 20 + thirdMinute, elapsedSeconds, stoppageMinute: null,
      displayTime: `${(third - 1) * 20 + thirdMinute}′`,
      scoringTeamId: "red", concedingTeamId: "blue", scorerPlayerId: players[0].playerId,
      assistPlayerIds: [], ownGoal: false,
      createdAt: new Date(Date.parse(kickoff) + sequence * 60_000).toISOString(), updatedAt: now,
      ...input,
    };
    goals.push(goal);
    return goal;
  }
  if (!options.emptyGoals && status !== "scheduled") {
    appendGoal({ third: 1, elapsedSeconds: 180, assistPlayerIds: [players[6].playerId] });
    appendGoal({ third: 2, elapsedSeconds: 60, scoringTeamId: "blue", concedingTeamId: "red", scorerPlayerId: players[6].playerId, assistPlayerIds: [players[12].playerId] });
    appendGoal({ third: 3, scoringTeamId: null, concedingTeamId: "yellow", scorerPlayerId: players[12].playerId, ownGoal: true });
  }
  const scoreboardTeams = () => teamIds.map((teamId, index) => ({
    gameId, teamId, name: ["Red", "Blue", "Yellow"][index],
    color: options.malformedColors ? ["not-a-colour", null, "#ffffff"][index] : ["#d83b36", "#2364d2", "#e0a612"][index],
    scored: goals.filter(goal => !goal.ownGoal && goal.scoringTeamId === teamId).length,
    conceded: goals.filter(goal => goal.concedingTeamId === teamId).length,
    createdAt: kickoff, updatedAt: now,
  }));
  function finalResult() {
    const ordered = [...scoreboardTeams()].sort((a, b) => a.conceded - b.conceded || b.scored - a.scored);
    const tied = ordered[0].conceded === ordered[1].conceded && ordered[0].scored === ordered[1].scored;
    return {
      winnerTeamId: tied ? null : ordered[0].teamId, outcome: tied ? "draw" : "win",
      comparator: "fewest_conceded_then_most_scored", computedAt: now,
      teams: scoreboardTeams().map(team => ({ ...team, rank: ordered.findIndex(candidate => candidate.teamId === team.teamId) + 1,
        outcome: tied && team.conceded === ordered[0].conceded && team.scored === ordered[0].scored ? "draw" : !tied && team.teamId === ordered[0].teamId ? "win" : "loss" })),
    };
  }
  const game = {
    gameId, leagueId, seasonId, sessionId: "20260913", joinCode: "FICTIONALJOIN", status,
    gameStartTs: kickoff, thirdLengthMinutes: 20, createdAt: kickoff, updatedAt: now,
    thirds: [1, 2, 3].map(third => ({ third,
      startedAt: status === "scheduled" ? null : third === 3 && status === "live"
        ? new Date(Date.parse(now) - (options.stoppage ? 21 * 60 + 45 : 5 * 60) * 1000).toISOString()
        : new Date(Date.parse(kickoff) + (third - 1) * 20 * 60_000).toISOString(),
      finishedAt: status === "scheduled" || (third === 3 && status === "live") ? null
        : new Date(Date.parse(kickoff) + third * 20 * 60_000).toISOString(),
    })),
    finishedAt: status === "finished" ? now : null,
    result: status === "finished" ? finalResult() : null,
  };
  const requests: RequestRecord[] = [];
  const unexpected: string[] = [];
  const plans: Plan[] = [];
  const replays = new Map<string, { body: string; status: number; json: unknown }>();
  let failedGoalReads = options.unavailableGoals ? Infinity : 0;
  let failedGameReads = 0;
  const goalPayload = (extra: Record<string, unknown> = {}) => ({ ...extra, timeline: snapshot(goals), scoreboard: { teams: scoreboardTeams() } });
  const publicRoster = () => players.map(player => ({ gameId, playerId: player.playerId, teamId: assignment.get(player.playerId), player, createdAt: kickoff, updatedAt: kickoff }));

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(`External ${url.origin}${url.pathname}`); return route.abort(); }
    const asset = assets.get(url.pathname);
    if (request.method() === "GET" && asset !== undefined) return route.fulfill({ body: asset, contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
    if (request.method() === "GET" && url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    if (request.method() === "GET" && url.pathname === gamePath) return route.fulfill({ body: renderGamePage(origin, { gameId }), contentType: "text/html" });
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    const record: RequestRecord = { method, path: url.pathname, body, key: request.headers()["idempotency-key"] };
    requests.push(record);
    const reject = (code: number, message: string) => route.fulfill({ status: code, json: { error: code === 503 ? "unavailable" : "rejected", message } });
    if (method === "GET" && url.pathname === "/v1/auth/session") return route.fulfill({ headers: { "cache-control": "no-store" }, json: { authenticated: true, session: { sessionId: "fictional-scoring-session", email: "scoring.fixture@example.com", userId: "fictional-scorekeeper" } } });
    if (method === "GET" && url.pathname === `/v1/leagues/${leagueId}`) return role === "unknown"
      ? reject(503, "League access could not be loaded.")
      : route.fulfill({ json: { leagueId, name: "Fictional Community Football League", access: { role } } });
    if (method === "GET" && url.pathname === `/v1/leagues/${leagueId}/seasons/${seasonId}`) return route.fulfill({ json: { leagueId, seasonId, name: "Fictional Spring Season", startsOn: "2026-09-01", endsOn: "2027-02-28" } });
    if (method === "GET" && url.pathname === apiPath) return failedGameReads-- > 0 ? reject(503, "Result refresh unavailable.") : route.fulfill({ json: game });
    if (method === "GET" && url.pathname === `${apiPath}/teams`) return route.fulfill({ json: { teams: scoreboardTeams() } });
    if (method === "GET" && url.pathname === `${apiPath}/roster`) return route.fulfill({ json: { teams: scoreboardTeams(), roster: publicRoster() } });
    if (method === "GET" && url.pathname === `${apiPath}/players`) return role === "admin" || role === "scorekeeper"
      ? route.fulfill({ json: { players: players.filter(player => player.nickname.toLowerCase().includes((url.searchParams.get("search") ?? "").toLowerCase())) } })
      : reject(403, "Operator access is required.");
    if (method === "GET" && url.pathname === `${apiPath}/goals`) return failedGoalReads-- > 0 ? reject(503, "Goal details unavailable.") : route.fulfill({ json: goalPayload() });

    const goalRoute = new RegExp(`^${apiPath}/goals(?:/([^/]+))?$`).exec(url.pathname);
    const thirdRoute = new RegExp(`^${apiPath}/thirds/([123])/(start|finish)$`).exec(url.pathname);
    const isGoalWrite = Boolean(goalRoute && ["POST", "PATCH", "DELETE"].includes(method));
    const isClockWrite = method === "POST" && (Boolean(thirdRoute) || url.pathname === `${apiPath}/finish`);
    if (!isGoalWrite && !isClockWrite) { unexpected.push(`${method} ${url.pathname}`); return route.abort(); }
    if ((role !== "admin" && role !== "scorekeeper") || (game.status === "finished" && role !== "admin")) return reject(403, "Scoring access is required.");
    if (isGoalWrite && !record.key) return reject(400, "An idempotency key is required.");
    const replayKey = record.key ? `${method} ${url.pathname} ${record.key}` : null;
    const serializedBody = JSON.stringify(body);
    const replay = replayKey ? replays.get(replayKey) : null;
    if (replay) return replay.body !== serializedBody ? reject(409, "The retry payload changed.") : route.fulfill({ status: replay.status, json: replay.json });
    const planIndex = plans.findIndex(plan => plan.kind === (isGoalWrite ? "goal" : "clock"));
    const plan = planIndex >= 0 ? plans.splice(planIndex, 1)[0] : undefined;
    if (plan?.gate) await plan.gate.promise;
    if (plan?.status && !plan.commit) return reject(plan.status, plan.status === 400 ? "Choose valid goal details." : "The response could not be confirmed.");
    let json: unknown;
    let responseStatus = 200;
    if (isGoalWrite && goalRoute) {
      const eventId = goalRoute[1];
      if (method === "POST" && eventId === "undo-last") {
        if (body?.expectedEventId !== goals.at(-1)?.eventId) return reject(409, "The latest goal changed.");
        const removed = goals.pop();
        json = goalPayload({ deletedEventId: removed?.eventId });
      } else if (method === "DELETE" && eventId) {
        const index = goals.findIndex(goal => goal.eventId === eventId);
        if (index < 0) return reject(404, "Goal not found.");
        goals.splice(index, 1);
        json = goalPayload({ deletedEventId: eventId });
      } else if ((method === "POST" && !eventId) || (method === "PATCH" && eventId)) {
        const existing = eventId ? goals.find(goal => goal.eventId === eventId) : undefined;
        if (eventId && !existing) return reject(404, "Goal not found.");
        if (game.status !== "finished" && !game.thirds.some(third => third.startedAt && !third.finishedAt)) return reject(409, "Start a third before recording a goal.");
        const input = { ...existing, ...body };
        const scorer = String(input.scorerPlayerId ?? "");
        const assists = Array.isArray(input.assistPlayerIds) ? input.assistPlayerIds.map(String) : [];
        const ownGoal = input.ownGoal === true;
        const scoringTeamId = ownGoal ? null : input.scoringTeamId as TeamId;
        const concedingTeamId = input.concedingTeamId as TeamId;
        if (!teamIds.includes(concedingTeamId) || (!ownGoal && (!teamIds.includes(scoringTeamId as TeamId) || scoringTeamId === concedingTeamId))
          || assignment.get(scorer) !== (ownGoal ? concedingTeamId : scoringTeamId)
          || assists.length > 3 || new Set(assists).size !== assists.length || assists.includes(scorer) || assists.some(id => !assignment.has(id))) return reject(400, "Choose valid goal details.");
        const fields = { scoringTeamId, concedingTeamId, scorerPlayerId: scorer, assistPlayerIds: assists, ownGoal, updatedAt: now };
        const goal = existing ? Object.assign(existing, fields) : appendGoal({ ...fields, third: game.thirds.find(third => third.startedAt && !third.finishedAt)?.third ?? 3 });
        json = goalPayload({ goal: snapshot(goal) });
        responseStatus = existing ? 200 : 201;
      } else { unexpected.push(`${method} ${url.pathname}`); return route.abort(); }
      if (game.status === "finished") game.result = finalResult();
    } else if (thirdRoute) {
      const third = game.thirds[Number(thirdRoute[1]) - 1];
      if (thirdRoute[2] === "start") {
        if (third.startedAt) return reject(409, "Third already started.");
        third.startedAt = now;
        game.status = "live";
      } else {
        if (!third.startedAt || third.finishedAt) return reject(409, "Third is not running.");
        third.finishedAt = now;
      }
      json = snapshot(game);
    } else {
      if (!game.thirds.every(third => third.finishedAt)) return reject(409, "Finish all thirds first.");
      game.status = "finished"; game.finishedAt = now; game.result = finalResult();
      json = snapshot(game);
    }
    if (replayKey) replays.set(replayKey, { body: serializedBody, status: responseStatus, json: snapshot(json) });
    if (plan?.failGoalRead) failedGoalReads = 1;
    if (plan?.failGameRead) failedGameReads = 1;
    if (plan?.status) return reject(plan.status, "The response could not be confirmed.");
    return route.fulfill({ status: responseStatus, json });
  });
  return { requests, unexpected, players, goals, game, plans, appendGoal,
    mutations: () => requests.filter(request => request.method !== "GET") };
}

const teamRadio = (page: Page, group: "scoring" | "conceding", team: TeamId) => page.locator(`#goal-${group}-team input[type="radio"][value="${team}"]`);
const assist = (page: Page, playerId: string) => page.locator(`#goal-assists input[type="checkbox"][value="${playerId}"]`);
const latestGoals = (page: Page) => page.locator('#goal-timeline [data-ui="goal-event"]');
const retryGoal = (page: Page) => page.locator('[data-action="retry-goal-operation"]');

async function openScoring(page: Page, fixture: Awaited<ReturnType<typeof installScoringFixture>>) {
  await page.goto(`${origin}${gamePath}${fixture.game.status === "finished" ? "" : "#score"}`);
  await expect(page.locator("#game-title")).not.toHaveText("Game");
  await expect(page.locator('[data-ui="roster-member"]')).toHaveCount(18);
  if (fixture.game.status === "finished") {
    await expect(page.getByTestId("game-mode-final")).toBeVisible();
    await page.locator('[data-action="correct-finished-result"]').click();
  }
  await expect(page.getByTestId("game-mode-run")).toBeVisible();
  await expect(page.locator("#goal-form")).toBeVisible();
}

async function normalDraft(page: Page, fixture: Awaited<ReturnType<typeof installScoringFixture>>) {
  await teamRadio(page, "scoring", "red").check();
  await teamRadio(page, "conceding", "blue").check();
  await page.locator("#goal-scorer").selectOption(fixture.players[0].playerId);
  await expect(page.getByTestId("add-goal")).toBeEnabled();
}

async function expectReset(page: Page) {
  await expect(page.locator('#goal-scoring-team input:checked, #goal-conceding-team input:checked, #goal-assists input:checked')).toHaveCount(0);
  await expect(page.locator("#goal-scorer")).toHaveValue("");
  await expect(page.locator("#goal-own-goal")).not.toBeChecked();
  await expect(page.getByTestId("goal-assists-dropdown")).not.toHaveAttribute("open", "");
}

async function expectGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const visible = [...document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, summary")]
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true }));
    const targets = [...new Set(visible.map(element => element.matches('input[type="radio"], input[type="checkbox"]') ? element.closest("label") ?? element : element))];
    return {
      width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      badTargets: targets.flatMap(element => {
        const rect = element.getBoundingClientRect();
        const minimum = element.closest('[data-ui="run-console"]') ? 48 * zoom : 44 * zoom;
        return rect.width < minimum - 0.5 || rect.height < minimum - 0.5 || rect.left < -0.5 || rect.right > innerWidth + 0.5
          ? [{ text: element.getAttribute("aria-label") || element.textContent?.trim() || element.id, width: rect.width, height: rect.height, left: rect.left, right: rect.right }] : [];
      }),
      clippedNames: [...document.querySelectorAll<HTMLElement>('[data-ui="goal-scorer"], [data-ui="assist-summary"]')]
        .filter(element => element.checkVisibility({ checkVisibilityCSS: true }))
        .flatMap(element => element.scrollWidth > element.clientWidth + 1 || getComputedStyle(element).textOverflow === "ellipsis" ? [element.textContent] : []),
    };
  });
  expect(geometry.scroll, "No horizontal page scrolling").toBeLessThanOrEqual(geometry.width);
  expect(geometry.badTargets, "Native labels/controls remain fully on canvas with usable targets").toEqual([]);
  expect(geometry.clippedNames, "Goal and selected-assist names must not be ellipsised or clipped").toEqual([]);
}

async function expectScoreAndGoalAlignment(page: Page) {
  const geometry = await page.evaluate(() => {
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const center = (rect: DOMRect) => rect.left + rect.width / 2;
    const textRect = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return { rect: range.getBoundingClientRect(), fragments: range.getClientRects().length };
    };
    return {
      zoom,
      teams: [...document.querySelectorAll<HTMLElement>('#live-scoreboard [data-ui="score-team"]')].map(team => {
        const swatch = team.querySelector('[data-ui="team-swatch"]')!.getBoundingClientRect();
        const name = textRect(team.querySelector("header strong")!);
        const headerLeft = Math.min(swatch.left, name.rect.left);
        const headerRight = Math.max(swatch.right, name.rect.right);
        return { id: team.dataset.teamId, headingOffset: (headerLeft + headerRight) / 2 - center(team.getBoundingClientRect()),
          totals: [...team.querySelectorAll("dt, dd")].map(element => {
            const text = textRect(element);
            const cell = element.parentElement!.getBoundingClientRect();
            return { text: element.textContent, offset: center(text.rect) - center(cell), fragments: text.fragments };
          }),
        };
      }),
      rows: [...document.querySelectorAll<HTMLElement>('#goal-timeline [data-ui="goal-event"]')].map(row => {
        const style = getComputedStyle(row);
        return { latest: row.dataset.state === "latest", padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft] };
      }),
    };
  });
  expect(geometry.teams).toHaveLength(3);
  for (const team of geometry.teams) {
    expect(Math.abs(team.headingOffset), `${team.id} dot and heading are centered as one unit`).toBeLessThanOrEqual(1.5 * geometry.zoom);
    for (const total of team.totals) {
      expect(total.fragments, `${team.id} ${total.text} remains unfragmented`).toBe(1);
      expect(Math.abs(total.offset), `${team.id} ${total.text} is centered in its total column`).toBeLessThanOrEqual(1.5 * geometry.zoom);
    }
  }
  expect(geometry.rows.length).toBeGreaterThan(1);
  expect(geometry.rows.filter(row => row.latest)).toHaveLength(1);
  for (const row of geometry.rows) expect(row.padding, "Latest highlighting must not change the shared goal-row inset").toEqual(geometry.rows[0].padding);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.use({ timezoneId: "Australia/Melbourne", locale: "en-AU" });

test("scoring is a stable native navigation destination with no redundant return action", async ({ page }) => {
  const fixture = await installScoringFixture(page, { status: "scheduled" });
  await page.goto(`${origin}${gamePath}#overview`);
  const entry = page.getByTestId("game-mode-nav").getByRole("link", { name: "Score game", exact: true });
  const overview = page.getByTestId("game-mode-structure-tab");
  await expect(entry).toHaveAttribute("href", "#score");
  await expect(page.getByRole("button", { name: "Score game", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to game", exact: true })).toHaveCount(0);
  await entry.click();
  await expect(page.getByTestId("game-mode-run")).toBeVisible();
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute("aria-current", "page");
  await overview.click();
  await expect(page.getByTestId("game-mode-structure")).toBeVisible();
  await expect(entry).toBeVisible();
  await expect(entry).not.toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page.getByTestId("game-mode-run")).toBeVisible();
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page.getByTestId("game-mode-structure")).toBeVisible();
  await expect(entry).toBeVisible();
  expect(fixture.mutations()).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [320, 390, 430, 768, 1280]) {
    test(`live scoring native form and readable goals ${colorScheme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const fixture = await installScoringFixture(page, { malformedColors: true, stoppage: true });
      await openScoring(page, fixture);
      for (const [group, legend] of [["scoring", "Scoring team"], ["conceding", "Conceding team"]] as const) {
        const fieldset = page.locator(`#goal-${group}-team`);
        await expect(fieldset).toHaveJSProperty("tagName", "FIELDSET");
        await expect(fieldset.locator("legend")).toHaveText(legend);
        await expect(fieldset.locator(`input[type="radio"][name="goal-${group}-team"]`)).toHaveCount(3);
        await expect(fieldset.locator("select")).toHaveCount(0);
      }
      await expect(page.locator('#live-scoreboard [data-ui="score-team"]')).toHaveCount(3);
      await expect(page.getByTestId("run-match-summary").getByTestId("live-scoreboard")).toBeVisible();
      await expect(page.getByTestId("run-match-summary").getByTestId("timer-display")).toBeVisible();
      await expect(page.getByTestId("add-goal")).toHaveAttribute("type", "submit");
      await expect(page.getByTestId("add-goal")).toHaveText("Record goal");
      await expect(page.getByTestId("run-latest-goals")).toHaveJSProperty("tagName", "SECTION");
      await expect(page.getByTestId("run-latest-goals").getByTestId("undo-last-goal")).toHaveText("Undo last goal");
      expect(await page.locator('#live-scoreboard [data-ui="score-team"]').evaluateAll(elements => elements.map(element => element.getAttribute("data-team-id")))).toEqual(teamIds);
      await expect(page.locator("#timer-phase-label")).toHaveText("Stoppage");
      await expect(latestGoals(page)).toHaveCount(3);
      await expectScoreAndGoalAlignment(page);
      await expect(page.getByTestId("goal-timeline")).not.toContainText(/Assists: None|conceding tally only/);
      for (const chip of await page.locator('#goal-timeline [data-ui="goal-team-chip"]').all()) {
        await expect(chip).toHaveAttribute("aria-label", /^(Scoring|Conceding) team: (Red|Blue|Yellow)$/);
        await expect(chip).toHaveText("");
      }
      await expect(page.locator('#goal-timeline [data-ui="third-indicator"][aria-label="Third 1 of 3"]')).toBeVisible();
      await normalDraft(page, fixture);
      await page.getByTestId("goal-assists-dropdown").locator("summary").click();
      await assist(page, fixture.players[6].playerId).check();
      await assist(page, fixture.players[12].playerId).check();
      await expectGeometry(page);
      await capture(page, testInfo, `live-scoring-${colorScheme}-${width}`);
      expect(fixture.mutations()).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
  test(`live scoring enlarged text and short landscape ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 768, height: 700 });
    await page.emulateMedia({ colorScheme });
    const fixture = await installScoringFixture(page);
    await openScoring(page, fixture);
    await page.locator("html").evaluate(element => { element.style.zoom = "2"; });
    await normalDraft(page, fixture);
    await page.getByTestId("goal-assists-dropdown").locator("summary").click();
    await assist(page, fixture.players[12].playerId).check();
    await expectGeometry(page);
    await expectScoreAndGoalAlignment(page);
    await capture(page, testInfo, `live-scoring-simulated-css-zoom-200-${colorScheme}-768`);
    await page.locator("html").evaluate(element => { element.style.zoom = "1"; });
    await page.setViewportSize({ width: 640, height: 360 });
    await page.locator("#goal-scorer").focus();
    await expect(page.locator("#goal-scorer")).toBeFocused();
    const unobscured = await page.locator("#goal-scorer").evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.top >= 0 && rect.bottom <= innerHeight && (hit === element || element.contains(hit));
    });
    expect(unobscured, "Short-viewport focus is not covered by score/clock content").toBe(true);
    await expectGeometry(page);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("keyboard native submission records cross-team assists, enforces three and resets focus", async ({ page }) => {
  const fixture = await installScoringFixture(page, { emptyGoals: true, role: "scorekeeper" });
  await openScoring(page, fixture);
  await teamRadio(page, "scoring", "red").focus();
  await page.keyboard.press("Space");
  await expect(teamRadio(page, "scoring", "red")).toBeChecked();
  await teamRadio(page, "conceding", "blue").focus();
  await page.keyboard.press("Space");
  await page.locator("#goal-scorer").selectOption(fixture.players[0].playerId);
  const summary = page.getByTestId("goal-assists-dropdown").locator("summary");
  await summary.focus(); await page.keyboard.press("Enter");
  const chosen = [fixture.players[1], fixture.players[6], fixture.players[12]];
  for (const player of chosen) { await assist(page, player.playerId).focus(); await page.keyboard.press("Space"); }
  await expect(page.locator('#goal-assists input:checked')).toHaveCount(3);
  await expect(assist(page, fixture.players[7].playerId)).toBeDisabled();
  await expect(assist(page, fixture.players[0].playerId)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(summary).toBeFocused();
  await page.getByTestId("add-goal").focus(); await page.keyboard.press("Enter");
  await expect(latestGoals(page)).toHaveCount(1);
  expect(fixture.mutations()).toHaveLength(1);
  expect(fixture.mutations()[0].body).toEqual({ scoringTeamId: "red", concedingTeamId: "blue", scorerPlayerId: fixture.players[0].playerId, ownGoal: false, assistPlayerIds: chosen.map(player => player.playerId) });
  await expectReset(page);
  await expect(teamRadio(page, "scoring", "red")).toBeFocused();
  expect(fixture.unexpected).toEqual([]);
});

test("own goal records a null scoring team and only the conceding tally", async ({ page }) => {
  const fixture = await installScoringFixture(page, { emptyGoals: true });
  await openScoring(page, fixture);
  await page.locator("#goal-own-goal").check();
  await expect(page.locator('#goal-scoring-team input:enabled')).toHaveCount(0);
  await teamRadio(page, "conceding", "blue").check();
  await page.locator("#goal-scorer").selectOption(fixture.players[6].playerId);
  await page.getByTestId("goal-assists-dropdown").locator("summary").click();
  await assist(page, fixture.players[12].playerId).check();
  await page.getByTestId("add-goal").click();
  await expect(latestGoals(page)).toHaveCount(1);
  expect(fixture.mutations()[0].body).toEqual({ ownGoal: true, scoringTeamId: null, concedingTeamId: "blue", scorerPlayerId: fixture.players[6].playerId, assistPlayerIds: [fixture.players[12].playerId] });
  await expect(page.locator('[data-ui="score-team"][data-team-id="blue"]')).toContainText(/Conceded\s*1/);
  for (const teamId of teamIds) await expect(page.locator(`[data-ui="score-team"][data-team-id="${teamId}"]`)).toContainText(/Scored\s*0/);
  await expect(latestGoals(page).locator('[data-ui="goal-team-chip"]')).toHaveCount(1);
  await expect(latestGoals(page).locator('[data-ui="own-goal-marker"]')).toBeVisible();
  await expectReset(page);
  expect(fixture.unexpected).toEqual([]);
});

test("pending submit is latched and a later navigation keeps its focus", async ({ page }) => {
  const fixture = await installScoringFixture(page, { emptyGoals: true });
  await openScoring(page, fixture); await normalDraft(page, fixture);
  const gate = deferred(); fixture.plans.push({ kind: "goal", gate });
  try {
    await page.getByTestId("add-goal").click();
    await expect.poll(() => fixture.mutations().length).toBe(1);
    await expect(page.getByTestId("add-goal")).toBeDisabled();
    await expect(page.getByTestId("finish-third")).toBeDisabled();
    await page.keyboard.press("Enter");
    expect(fixture.mutations()).toHaveLength(1);
    await page.getByTestId("game-mode-players-tab").click();
    await expect(page.getByTestId("game-mode-players")).toBeFocused();
    gate.release();
    await expect.poll(() => fixture.goals.length).toBe(1);
    await expect(page.locator("#setup-status")).toBeHidden();
    await expectReset(page);
    await expect(page.getByTestId("game-mode-players")).toBeVisible();
    await expect(page.getByTestId("game-mode-players")).toBeFocused();
    expect(fixture.mutations()).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);
  } finally { gate.release(); }
});

test("unconfirmed committed goal retries the same identity and refreshes newer events", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installScoringFixture(page, { emptyGoals: true });
  await openScoring(page, fixture); await normalDraft(page, fixture);
  fixture.plans.push({ kind: "goal", commit: true, status: 503 });
  await page.getByTestId("add-goal").click();
  await expect(retryGoal(page)).toBeVisible();
  await expect(retryGoal(page)).toBeFocused();
  await expect(page.getByTestId("add-goal")).toBeDisabled();
  await expect(page.getByTestId("undo-last-goal")).toBeDisabled();
  await expect(page.getByTestId("finish-third")).toBeDisabled();
  expect(fixture.goals).toHaveLength(1);
  const first = snapshot(fixture.mutations()[0]);
  fixture.appendGoal({ scoringTeamId: "yellow", concedingTeamId: "red", scorerPlayerId: fixture.players[12].playerId });
  await expectGeometry(page);
  await capture(page, testInfo, "live-scoring-unconfirmed-dark-320");
  await retryGoal(page).click();
  await expect(latestGoals(page)).toHaveCount(2);
  expect(fixture.mutations()).toHaveLength(2);
  expect(fixture.mutations()[1]).toEqual(first);
  expect(first.key).toBeTruthy();
  expect(fixture.goals).toHaveLength(2);
  await expect(page.locator('[data-ui="score-team"][data-team-id="yellow"]')).toContainText(/Scored\s*1/);
  await expectReset(page);
  expect(fixture.unexpected).toEqual([]);
});

test("a definite rejected save keeps the draft and usable retry focus", async ({ page }) => {
  const fixture = await installScoringFixture(page, { emptyGoals: true });
  await openScoring(page, fixture); await normalDraft(page, fixture);
  fixture.plans.push({ kind: "goal", status: 400 });
  await page.getByTestId("add-goal").click();
  await expect(page.locator("#setup-error")).toBeVisible();
  await expect(teamRadio(page, "scoring", "red")).toBeChecked();
  await expect(teamRadio(page, "conceding", "blue")).toBeChecked();
  await expect(page.locator("#goal-scorer")).toHaveValue(fixture.players[0].playerId);
  await expect(page.getByTestId("add-goal")).toBeEnabled();
  await expect(page.getByTestId("add-goal")).toBeFocused();
  await expect(retryGoal(page)).toBeHidden();
  expect(fixture.goals).toHaveLength(0);
  await page.keyboard.press("Enter");
  await expect(latestGoals(page)).toHaveCount(1);
  expect(fixture.mutations()).toHaveLength(2);
  expect(fixture.unexpected).toEqual([]);
});

test("older goal edit, deletion cancel/confirm and undo retain their event targets", async ({ page }) => {
  const fixture = await installScoringFixture(page);
  await openScoring(page, fixture);
  const oldest = fixture.goals[0].eventId;
  await page.locator(`[data-action="edit-goal"][data-event-id="${oldest}"] [data-ui="icon"]`).click();
  await expect(page.getByTestId("add-goal")).toHaveText("Save changes");
  await page.locator("#goal-scorer").selectOption(fixture.players[1].playerId);
  await page.getByTestId("add-goal").click();
  await expect(page.locator(`#goal-timeline [data-event-id="${oldest}"] [data-ui="goal-scorer"]`)).toHaveText("Sam");
  expect(fixture.mutations()[0].path).toBe(`${apiPath}/goals/${oldest}`);
  expect(fixture.mutations()[0].method).toBe("PATCH");
  const deletion = page.locator(`[data-action="delete-goal"][data-event-id="${oldest}"]`);
  page.once("dialog", dialog => dialog.dismiss());
  await deletion.locator('[data-ui="icon"]').click();
  expect(fixture.mutations()).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await deletion.locator('[data-ui="icon"]').click();
  await expect(latestGoals(page)).toHaveCount(2);
  expect(fixture.mutations()[1].path).toBe(`${apiPath}/goals/${oldest}`);
  expect(fixture.mutations()[1].method).toBe("DELETE");
  const expectedEventId = fixture.goals.at(-1)?.eventId;
  await page.getByTestId("undo-last-goal").click();
  await expect(latestGoals(page)).toHaveCount(1);
  expect(fixture.mutations()[2].body).toEqual({ expectedEventId });
  expect(fixture.unexpected).toEqual([]);
});

test("unconfirmed undo retries its original event without removing a newer goal", async ({ page }) => {
  const fixture = await installScoringFixture(page);
  await openScoring(page, fixture);
  const originalLatest = fixture.goals.at(-1)?.eventId;
  fixture.plans.push({ kind: "goal", commit: true, status: 503 });
  await page.getByTestId("undo-last-goal").click();
  await expect(retryGoal(page)).toHaveText("Retry undo");
  const newer = fixture.appendGoal({ scoringTeamId: "yellow", concedingTeamId: "red", scorerPlayerId: fixture.players[12].playerId });
  await retryGoal(page).click();
  await expect(page.locator(`#goal-timeline [data-ui="goal-event"][data-event-id="${newer.eventId}"]`)).toBeVisible();
  await expect(page.locator(`#goal-timeline [data-ui="goal-event"][data-event-id="${originalLatest}"]`)).toHaveCount(0);
  expect(fixture.mutations()).toHaveLength(2);
  expect(fixture.mutations()[1]).toEqual(fixture.mutations()[0]);
  expect(fixture.mutations()[0].body).toEqual({ expectedEventId: originalLatest });
  expect(fixture.unexpected).toEqual([]);
});

test("finished correction has an explicit zero-write exit and cannot be rearmed by browser history", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installScoringFixture(page, { status: "finished" });
  await openScoring(page, fixture);
  const correction = page.getByTestId("game-mode-nav").getByRole("link", { name: "Correction", exact: true });
  await expect(correction).toHaveAttribute("href", "#score");
  await expect(correction).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#finished-correction-actions").getByRole("heading", { name: "Correct result", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Score game", exact: true })).toHaveCount(0);
  await page.getByTestId("game-mode-players-tab").click();
  await expect(correction).toBeVisible();
  await correction.click();
  const exit = page.getByRole("button", { name: "Exit correction", exact: true });
  await exit.focus();
  await expectGeometry(page);
  await capture(page, testInfo, "finished-correction-exit-dark-320");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("game-mode-final")).toBeVisible();
  await expect(page.getByTestId("game-mode-final")).toBeFocused();
  await expect(page).toHaveURL(`${origin}${gamePath}#results`);
  await expect(page.getByTestId("game-mode-run-tab")).toBeHidden();
  await expect(page.locator('[data-action="correct-finished-result"]')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("game-mode-final")).toBeVisible();
  await expect(page.getByTestId("game-mode-run-tab")).toBeHidden();
  await page.locator('[data-action="correct-finished-result"]').click();
  await expect(correction).toBeVisible();
  expect(fixture.mutations()).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("pending and uncertain correction protects retry ownership until a confirmed exit", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installScoringFixture(page, { status: "finished" });
  await openScoring(page, fixture);
  await normalDraft(page, fixture);
  const gate = deferred();
  fixture.plans.push({ kind: "goal", gate, status: 503, commit: true });
  await page.getByTestId("add-goal").click();
  await expect.poll(() => fixture.mutations().length).toBe(1);
  const exit = page.getByRole("button", { name: "Exit correction", exact: true });
  await expect(exit).toBeDisabled();
  await page.getByTestId("game-mode-final-tab").click();
  await expect(page.getByTestId("game-mode-final")).toBeVisible();
  await page.getByRole("link", { name: "Correction", exact: true }).click();
  gate.release();
  await expect(retryGoal(page)).toBeEnabled();
  await expect(exit).toBeDisabled();
  const reasonIds = (await exit.getAttribute("aria-describedby"))?.trim().split(/\s+/) ?? [];
  expect(reasonIds.length, "Blocked exit has an associated readable reason").toBeGreaterThan(0);
  for (const id of reasonIds) await expect(page.locator(`[id="${id}"]`)).toBeVisible();
  await exit.dispatchEvent("click");
  await expect(page.getByTestId("game-mode-run")).toBeVisible();
  const messageBox = await page.locator('#live-scoreboard > [data-ui="empty-note"]').boundingBox();
  const scoreboardBox = await page.locator("#live-scoreboard").boundingBox();
  expect(messageBox).not.toBeNull(); expect(scoreboardBox).not.toBeNull();
  expect(Math.abs(messageBox!.width - scoreboardBox!.width), "Recovery occupies the full scoreboard, not one empty team column").toBeLessThan(2);
  await expectGeometry(page);
  await capture(page, testInfo, "finished-correction-unconfirmed-dark-390");
  await page.getByTestId("game-mode-final-tab").click();
  await page.getByRole("link", { name: "Correction", exact: true }).click();
  await retryGoal(page).click();
  await expect(exit).toBeEnabled();
  await expect(retryGoal(page)).toBeHidden();
  expect(fixture.mutations()).toHaveLength(2);
  expect(fixture.mutations()[1]).toEqual(fixture.mutations()[0]);
  expect(fixture.goals).toHaveLength(4);
  await exit.click();
  await expect(page.getByTestId("game-mode-final")).toBeVisible();
  expect(fixture.mutations()).toHaveLength(2);
  expect(fixture.goals).toHaveLength(4);
  expect(fixture.unexpected).toEqual([]);
});

test("fresh finished correction permits assists and clears a committed draft when reads fail", async ({ page }) => {
  const fixture = await installScoringFixture(page, { status: "finished" });
  await openScoring(page, fixture); await normalDraft(page, fixture);
  await page.getByTestId("goal-assists-dropdown").locator("summary").click();
  await expect(assist(page, fixture.players[12].playerId)).toBeEnabled();
  await assist(page, fixture.players[12].playerId).check();
  fixture.plans.push({ kind: "goal", failGoalRead: true, failGameRead: true });
  await page.getByTestId("add-goal").click();
  await expect(page.locator("#setup-error")).toBeVisible();
  await expectReset(page);
  expect(fixture.goals).toHaveLength(4);
  expect(fixture.mutations()).toHaveLength(1);
  expect(fixture.mutations()[0].body?.assistPlayerIds).toEqual([fixture.players[12].playerId]);
  await expect(page.locator("#setup-error")).not.toContainText(/was not saved|save failed/i);
  expect(fixture.unexpected).toEqual([]);
});

test("third controls preserve explicit game finalisation and browser history", async ({ page }) => {
  const fixture = await installScoringFixture(page, { status: "scheduled" });
  await openScoring(page, fixture);
  await expect(page.getByTestId("add-goal")).toBeDisabled();
  for (const third of [1, 2, 3]) {
    await page.getByTestId("start-third").click();
    await expect(page.locator("#timer-third-label")).toContainText(String(third));
    await expect(page.getByTestId("finish-third")).toBeEnabled();
    await page.getByTestId("finish-third").click();
    await expect(page.getByTestId(third === 3 ? "finish-game" : "start-third")).toBeEnabled();
  }
  await expect(page.getByTestId("game-mode-run")).toBeVisible();
  await expect(page.getByTestId("game-mode-final-tab")).toBeHidden();
  await page.getByTestId("finish-game").click();
  await expect(page.getByTestId("game-mode-final")).toBeVisible();
  await expect(page.getByTestId("game-mode-final-tab")).toBeVisible();
  expect(fixture.mutations().map(request => request.path)).toEqual([1, 2, 3].flatMap(third => [`${apiPath}/thirds/${third}/start`, `${apiPath}/thirds/${third}/finish`]).concat(`${apiPath}/finish`));
  await page.getByTestId("game-mode-players-tab").click();
  await page.goBack();
  await expect(page.getByTestId("game-mode-final")).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("delayed third response does not steal a later Teams destination", async ({ page }) => {
  const fixture = await installScoringFixture(page, { status: "scheduled" });
  await openScoring(page, fixture);
  const gate = deferred(); fixture.plans.push({ kind: "clock", gate });
  try {
    await page.getByTestId("start-third").click();
    await expect.poll(() => fixture.mutations().length).toBe(1);
    await page.getByTestId("game-mode-players-tab").click();
    await expect(page.getByTestId("game-mode-players")).toBeFocused();
    gate.release();
    await expect.poll(() => fixture.game.thirds[0]?.startedAt).toBe(now);
    await expect(page.locator("#setup-status")).toBeHidden();
    await expect(page).toHaveURL(`${origin}${gamePath}#teams`);
    await expect(page.getByTestId("game-mode-players")).toBeFocused();
    expect(fixture.unexpected).toEqual([]);
  } finally { gate.release(); }
});

test("lost clock response uses GET recovery without replaying the start POST", async ({ page }) => {
  const fixture = await installScoringFixture(page, { status: "scheduled" });
  await openScoring(page, fixture);
  fixture.plans.push({ kind: "clock", commit: true, status: 503, failGameRead: true });
  await page.getByTestId("start-third").click();
  const refresh = page.locator('[data-action="refresh-game-state"]');
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(page.getByTestId("finish-third")).toBeEnabled();
  await expect(refresh).toBeHidden();
  expect(fixture.mutations()).toHaveLength(1);
  expect(fixture.requests.filter(request => request.method === "GET" && request.path === apiPath).length).toBeGreaterThan(1);
  expect(fixture.unexpected).toEqual([]);
});

for (const state of ["unknown-authority", "unavailable-timeline"] as const) {
  test(`scoring is fail-closed with ${state}`, async ({ page }) => {
    const fixture = await installScoringFixture(page, state === "unknown-authority" ? { role: "unknown" } : { unavailableGoals: true });
    await page.goto(`${origin}${gamePath}#score`);
    await expect(page.locator('[data-ui="roster-member"]')).toHaveCount(18);
    if (state === "unavailable-timeline") await expect(page.locator("#setup-error")).toBeVisible();
    else await expect(page.getByTestId("game-mode-structure")).toBeVisible();
    await expect(page.locator('#goal-form input:enabled, #goal-form select:enabled, #goal-form button[type="submit"]:enabled')).toHaveCount(0);
    expect(fixture.mutations()).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
