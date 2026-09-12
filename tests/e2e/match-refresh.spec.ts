import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderGamePage } from "../../app/dist/ui/layout.js";

// Two isolated clients run production-built markup, styles and controllers.
// Only their shared transport is fictional. Unknown/external requests abort;
// no QA, AWS, email or real accounts are used. Build first, then use the owned
// repository guard, THREEFC_SKIP_WEB_SERVER=1 and exactly one browser worker.
const origin = "https://3fc.refresh.fixture.test";
const gameId = "fictional-refresh-match";
const leagueId = "fictional-refresh-league";
const seasonId = "fictional-refresh-season";
const gamePath = `/games/${gameId}`;
const apiPath = `/v1${gamePath}`;
const now = "2026-09-13T00:05:00.000Z";
const kickoff = "2026-09-13T00:00:00.000Z";
const teamIds = ["red", "blue", "yellow"] as const;
type TeamId = (typeof teamIds)[number];
type Status = "scheduled" | "live" | "finished";
type Role = "admin" | "scorekeeper" | "viewer";
type Client = "author" | "observer";
type Player = { playerId: string; nickname: string; createdAt: string; updatedAt: string };
type Goal = {
  gameId: string; eventId: string; third: number; thirdMinute: number; gameMinute: number;
  elapsedSeconds: number; stoppageMinute: number | null; displayTime: string;
  scoringTeamId: TeamId | null; concedingTeamId: TeamId; scorerPlayerId: string;
  assistPlayerIds: string[]; ownGoal: boolean; createdAt: string; updatedAt: string;
};
type RecordedRequest = { client: Client; method: string; path: string; query: string; body: Record<string, unknown> | null; serialized: string | null; key?: string };
const assets = new Map(["player-proof.js", "player-consolidation.js", "player-presentation-browser.js", "styles.css", "icons.css", "setup-flow.js", "auth-flow.js", "modal.js"].map(name => [
  `/ui/${name}`, readFileSync(resolve("app/dist/ui", name), "utf8"),
]));
function snapshot<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function sharedBackend(status: Status = "live") {
  const players: Player[] = Array.from({ length: 20 }, (_, index) => ({
    playerId: `fictional-player-${index + 1}`,
    nickname: index === 0 ? "Alexandra Francesca Montgomery-Williams"
      : index === 6 ? "Ibrahim O’Connell-Rodríguez"
        : index === 12 ? "Morgan Alexandra Montgomery-Williams"
          : index === 1 || index === 7 ? "Sam" : `Community Player ${index + 1}`,
    createdAt: kickoff, updatedAt: kickoff,
  }));
  const assignments = new Map<string, TeamId>(players.slice(0, 18).map((player, index) => [player.playerId, teamIds[Math.floor(index / 6)]]));
  const goals: Goal[] = [];
  let sequence = 0;
  function appendGoal(input: Partial<Goal> = {}) {
    const third = input.third ?? 1;
    const elapsedSeconds = 240;
    const thirdMinute = 5;
    const goal: Goal = { gameId, eventId: `fictional-refresh-goal-${++sequence}`, third, thirdMinute,
      gameMinute: (third - 1) * 20 + thirdMinute, elapsedSeconds, stoppageMinute: null,
      displayTime: `${(third - 1) * 20 + thirdMinute}′`, scoringTeamId: "red", concedingTeamId: "blue",
      scorerPlayerId: players[0].playerId, assistPlayerIds: [], ownGoal: false,
      createdAt: new Date(Date.parse(kickoff) + sequence * 1000).toISOString(), updatedAt: now, ...input };
    goals.push(goal);
    return goal;
  }
  if (status !== "scheduled") appendGoal();
  const teams = () => teamIds.map((teamId, index) => ({ gameId, teamId,
    name: ["Red", "Blue", "Yellow"][index], color: ["#d83b36", "#2364d2", "#e0a612"][index],
    scored: goals.filter(goal => !goal.ownGoal && goal.scoringTeamId === teamId).length,
    conceded: goals.filter(goal => goal.concedingTeamId === teamId).length,
    createdAt: kickoff, updatedAt: now,
  }));
  function result() {
    const ordered = teams().sort((a, b) => a.conceded - b.conceded || b.scored - a.scored);
    const winners = ordered.filter(team => team.conceded === ordered[0].conceded && team.scored === ordered[0].scored);
    return { winnerTeamId: winners.length > 1 ? null : winners[0].teamId,
      outcome: winners.length > 1 ? "draw" : "win", comparator: "fewest_conceded_then_most_scored", computedAt: now,
      teams: teams().map(team => ({ ...team, rank: ordered.findIndex(entry => entry.conceded === team.conceded && entry.scored === team.scored) + 1,
        outcome: winners.some(entry => entry.teamId === team.teamId) ? winners.length > 1 ? "draw" : "win" : "loss" })),
    };
  }
  const game = { gameId, leagueId, seasonId, sessionId: "20260913", joinCode: "ABCDEFGH", status,
    gameStartTs: kickoff, thirdLengthMinutes: 20, createdAt: kickoff, updatedAt: now,
    thirds: [1, 2, 3].map(third => ({ third,
      startedAt: status === "finished" || (status === "live" && third === 1)
        ? new Date(Date.parse(kickoff) + (third - 1) * 20 * 60_000).toISOString() : null,
      finishedAt: status === "finished" ? new Date(Date.parse(kickoff) + third * 20 * 60_000).toISOString() : null,
    })),
    finishedAt: status === "finished" ? now : null, result: status === "finished" ? result() : null,
  };
  const requests: RecordedRequest[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const failReads = new Map<Client, Set<string>>();
  const lostGoalResponses = new Set<Client>();
  const replays = new Map<string, { serialized: string | null; status: number; json: unknown }>();
  const goalPayload = (extra = {}) => ({ ...extra, timeline: snapshot(goals), scoreboard: { teams: teams() } });
  const roster = () => ({ teams: teams(),
    roster: [...assignments].map(([playerId, teamId]) => ({ gameId, playerId, teamId,
      player: players.find(player => player.playerId === playerId), createdAt: kickoff, updatedAt: now })),
    unassignedPlayers: players.filter(player => !assignments.has(player.playerId)),
  });

  async function install(page: Page, client: Client, role: Role = "admin") {
    page.on("pageerror", error => { errors.push(`${client}: ${error.message}`); });
    // Pause before navigation. Only explicit test clock advances can trigger the
    // real controller's five/fifteen-second schedule; wall time cannot race it.
    await page.clock.install({ time: new Date(Date.parse(now) - 60_000) });
    await page.clock.pauseAt(new Date(now));
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.origin !== origin) { unexpected.push(`${client}: external ${url.origin}${url.pathname}`); return route.abort(); }
      const asset = assets.get(url.pathname);
      if (method === "GET" && asset !== undefined) return route.fulfill({ body: asset, contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
      if (method === "GET" && url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
      if (method === "GET" && url.pathname === gamePath) return route.fulfill({ body: renderGamePage(origin, { gameId }), contentType: "text/html" });
      const serialized = request.postData();
      const body = serialized ? request.postDataJSON() as Record<string, unknown> : null;
      const key = request.headers()["idempotency-key"];
      requests.push({ client, method, path: url.pathname, query: url.search, body, serialized, key });
      const reject = (status: number, message: string, code?: string) => route.fulfill({ status, headers: { "cache-control": "no-store" },
        json: { error: status === 503 ? "unavailable" : status === 409 ? "conflict" : status === 403 ? "forbidden" : "rejected", message, ...(code ? { code } : {}) } });
      const read = (json: unknown) => route.fulfill({ headers: { "cache-control": "no-store" }, json: snapshot(json) });
      if (method === "GET") {
        if (failReads.get(client)?.has(url.pathname)) return reject(503, "The latest match read is unavailable.");
        if (url.pathname === "/v1/auth/session") return read({ authenticated: true,
          session: { sessionId: `fictional-${client}-session`, email: `${client}@refresh.fixture.example.com`, userId: `fictional-${client}` } });
        if (url.pathname === `/v1/leagues/${leagueId}`) return read({ leagueId, name: "Fictional Community Football League", access: { role } });
        if (url.pathname === `/v1/leagues/${leagueId}/seasons/${seasonId}`) return read({ leagueId, seasonId, name: "Spring and Summer Community Season 2026–2027", startsOn: "2026-09-01", endsOn: "2027-02-28" });
        if (url.pathname === apiPath) return read(game);
        if (url.pathname === `${apiPath}/goals`) return read(goalPayload());
        if (url.pathname === `${apiPath}/roster`) return read(roster());
        if (url.pathname === `${apiPath}/teams`) return read({ teams: teams() });
        if (url.pathname === "/v1/league-players" && url.searchParams.get("leagueId") === leagueId) return role === "viewer" ? reject(403, "Operator access required.")
          : read({ players: players.filter(player => player.nickname.toLocaleLowerCase().includes((url.searchParams.get("query") ?? "").toLocaleLowerCase()))
            .map(player => ({ ...player, claimed: player.playerId === players[0].playerId, inGame: true, seasons: [], hasMoreSeasons: false })), cursor: null });
        if (url.pathname === `${apiPath}/players`) return role === "viewer" ? reject(403, "Operator access required.")
          : read({ players: players.filter(player => player.nickname.toLocaleLowerCase().includes((url.searchParams.get("search") ?? "").toLocaleLowerCase())).slice(0, 20)
            .map(player => player.playerId === players[0].playerId ? { ...player, access: { userId: "fictional-claimed-account", role: null } } : player) });
      }
      if (role === "viewer") return reject(403, "This account cannot change the game.");
      const replayId = key ? `${client}:${method}:${url.pathname}:${key}` : null;
      const previous = replayId ? replays.get(replayId) : undefined;
      if (previous) return previous.serialized === serialized ? route.fulfill({ status: previous.status, json: previous.json }) : reject(409, "Original request required.");
      const goalRoute = new RegExp(`^${apiPath}/goals(?:/([^/]+))?$`).exec(url.pathname);
      const clockRoute = new RegExp(`^${apiPath}/thirds/([123])/(start|finish)$`).exec(url.pathname);
      const assignmentRoute = new RegExp(`^${apiPath}/roster/([^/]+)$`).exec(url.pathname);
      let json: unknown;
      let responseStatus = 200;
      let goalWrite = false;
      if (goalRoute && ["POST", "PATCH", "DELETE"].includes(method)) {
        if (!key) return reject(400, "Goal writes need an idempotency key.");
        const eventId = goalRoute[1];
        goalWrite = true;
        if (method === "POST" && eventId === "undo-last") {
          if (body?.expectedEventId !== goals.at(-1)?.eventId) return reject(409, "The latest goal changed.", "latest_goal_changed");
          json = goalPayload({ deletedEventId: goals.pop()?.eventId });
        } else if (method === "DELETE" && eventId) {
          const index = goals.findIndex(goal => goal.eventId === eventId);
          if (index < 0) return reject(404, "Goal unavailable.");
          goals.splice(index, 1);
          json = goalPayload({ deletedEventId: eventId });
        } else if ((method === "POST" && !eventId) || (method === "PATCH" && eventId)) {
          const existing = eventId ? goals.find(goal => goal.eventId === eventId) : undefined;
          if (eventId && !existing) return reject(404, "Goal unavailable.");
          const active = game.thirds.find(third => third.startedAt && !third.finishedAt);
          if (!active && game.status !== "finished") return reject(409, "Start a third first.", "no_active_third");
          const fields = { ownGoal: body?.ownGoal === true, scoringTeamId: body?.ownGoal === true ? null : body?.scoringTeamId as TeamId,
            concedingTeamId: body?.concedingTeamId as TeamId, scorerPlayerId: String(body?.scorerPlayerId ?? ""),
            assistPlayerIds: Array.isArray(body?.assistPlayerIds) ? body.assistPlayerIds.map(String) : [], updatedAt: now };
          if (assignments.get(fields.scorerPlayerId) !== (fields.ownGoal ? fields.concedingTeamId : fields.scoringTeamId)
            || !teamIds.includes(fields.concedingTeamId) || (!fields.ownGoal && fields.scoringTeamId === fields.concedingTeamId)
            || fields.assistPlayerIds.length > 3 || new Set(fields.assistPlayerIds).size !== fields.assistPlayerIds.length
            || fields.assistPlayerIds.includes(fields.scorerPlayerId) || fields.assistPlayerIds.some(id => !assignments.has(id))) return reject(400, "Review the selected players.");
          const goal = existing ? Object.assign(existing, fields) : appendGoal({ ...fields, third: active?.third ?? 3 });
          json = goalPayload({ goal: snapshot(goal) }); responseStatus = existing ? 200 : 201;
        } else { unexpected.push(`${client}: ${method} ${url.pathname}`); return route.abort(); }
        if (game.status === "finished") game.result = result();
      } else if (method === "POST" && clockRoute) {
        const third = game.thirds[Number(clockRoute[1]) - 1];
        if (clockRoute[2] === "start") { third.startedAt = now; game.status = "live"; }
        else third.finishedAt = now;
        json = snapshot(game);
      } else if (method === "POST" && url.pathname === `${apiPath}/finish`) {
        if (!game.thirds.every(third => third.finishedAt)) return reject(409, "Finish all thirds first.");
        game.status = "finished"; game.finishedAt = now; game.result = result(); json = snapshot(game);
      } else if (method === "PUT" && assignmentRoute) {
        const playerId = decodeURIComponent(assignmentRoute[1]);
        const teamId = body?.teamId as TeamId;
        if (!players.some(player => player.playerId === playerId) || !teamIds.includes(teamId)) return reject(400, "Player/team unavailable.");
        assignments.set(playerId, teamId);
        json = { gameId, playerId, teamId, createdAt: kickoff, updatedAt: now };
      } else if (method === "POST" && url.pathname === `${apiPath}/players`) {
        const player = { playerId: String(body?.playerId), nickname: String(body?.nickname), createdAt: now, updatedAt: now };
        if (!players.some(entry => entry.playerId === player.playerId)) players.push(player);
        json = player; responseStatus = 201;
      } else if (method === "PATCH" && url.pathname === apiPath) {
        if (typeof body?.gameStartTs === "string") game.gameStartTs = body.gameStartTs;
        if (typeof body?.thirdLengthMinutes === "number") game.thirdLengthMinutes = body.thirdLengthMinutes;
        if (["scheduled", "live", "finished"].includes(String(body?.status))) game.status = body?.status as Status;
        json = snapshot(game);
      } else { unexpected.push(`${client}: ${method} ${url.pathname}`); return route.abort(); }
      if (replayId) replays.set(replayId, { serialized, status: responseStatus, json: snapshot(json) });
      if (goalWrite && lostGoalResponses.delete(client)) return reject(503, "Goal response lost after commit.");
      return route.fulfill({ status: responseStatus, json });
    });
  }
  return { players, assignments, goals, game, requests, unexpected, errors, failReads, lostGoalResponses, install,
    writes: (client?: Client) => requests.filter(request => request.method !== "GET" && (!client || request.client === client)) };
}
type Backend = ReturnType<typeof sharedBackend>;

async function clients(browser: Browser, backend: Backend, width = 390, colorScheme: "light" | "dark" = "dark", observerRole: Role = "admin") {
  const contexts = await Promise.all([browser.newContext({ viewport: { width, height: 900 }, colorScheme }), browser.newContext({ viewport: { width, height: 900 }, colorScheme })]);
  const close = async () => { await Promise.all(contexts.map(context => context.close())); };
  try {
    const author = await contexts[0].newPage();
    const observer = await contexts[1].newPage();
    await backend.install(author, "author"); await backend.install(observer, "observer", observerRole);
    return { author, observer, close };
  } catch (error) { await close(); throw error; }
}
async function open(page: Page, mode = "score") {
  await page.goto(`${origin}${gamePath}#${mode}`);
  await expect(page.locator("#game-season-link")).toHaveText("Spring and Summer Community Season 2026–2027");
  await expect(page.locator('[data-ui="roster-member"]')).toHaveCount(18);
  await expect(page.locator("#game-refresh-notice")).toBeHidden();
}
async function refresh(page: Page, milliseconds = 5_100) {
  // Advance to the next observation instant without racing intermediate clock
  // ticks against intercepted fetch/body consumption. The real due poll runs
  // once, then UI assertions await its completed production render.
  await page.clock.fastForward(milliseconds);
}
const radio = (page: Page, group: "scoring" | "conceding", team: TeamId) => page.locator(`#goal-${group}-team input[value="${team}"]`);
const events = (page: Page) => page.locator('#goal-timeline [data-ui="goal-event"]');
async function draft(page: Page, backend: Backend, scorerIndex = 0) {
  await radio(page, "scoring", "red").check(); await radio(page, "conceding", "blue").check();
  await page.locator("#goal-scorer").selectOption(backend.players[scorerIndex].playerId);
  await expect(page.getByTestId("add-goal")).toBeEnabled();
}
async function recordGoal(page: Page, backend: Backend) {
  const count = backend.goals.length;
  await draft(page, backend); await page.getByTestId("add-goal").click();
  await expect(events(page)).toHaveCount(count + 1);
  await expect(page.locator("#goal-scorer")).toHaveValue("");
}
function clean(backend: Backend) { expect(backend.unexpected).toEqual([]); expect(backend.errors).toEqual([]); }
async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true }); await testInfo.attach(name, { path, contentType: "image/png" });
}
async function recoveryGeometry(page: Page) {
  const geometry = await page.locator("#game-refresh-notice").evaluate(element => {
    const box = element.getBoundingClientRect();
    const button = element.querySelector("button")!.getBoundingClientRect();
    const message = element.querySelector("p")!;
    return { width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      left: box.left, right: box.right, buttonWidth: button.width, buttonHeight: button.height,
      messageFits: message.scrollWidth <= message.clientWidth + 1 };
  });
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.buttonWidth).toBeGreaterThanOrEqual(44); expect(geometry.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.messageFits).toBe(true);
}

for (const [width, theme] of [[320, "light"], [390, "dark"]] as const) {
  test(`two clients receive goals clocks and finished results without navigation ${theme} ${width}`, async ({ browser }, testInfo) => {
    const backend = sharedBackend(); const pair = await clients(browser, backend, width, theme);
    const { author, observer } = pair;
    try {
      await open(author); await open(observer);
      await recordGoal(author, backend);
      await refresh(observer); await expect(events(observer)).toHaveCount(2);
      await expect(observer.locator('#live-scoreboard [data-team-id="red"] dl div').filter({ has: observer.locator("dt", { hasText: "Scored" }) }).locator("dd")).toHaveText("2");
      await expect(observer).toHaveURL(`${origin}${gamePath}#score`);
      const latest = backend.goals.at(-1)!;
      await author.locator(`[data-action="edit-goal"][data-event-id="${latest.eventId}"]`).click();
      await author.locator("#goal-scorer").selectOption(backend.players[1].playerId);
      await author.getByTestId("add-goal").click();
      await expect(author.locator("#goal-scorer")).toHaveValue("");
      await refresh(observer);
      await expect(observer.locator(`[data-ui="goal-event"][data-event-id="${latest.eventId}"] [data-ui="goal-scorer"]`)).toHaveText("Sam");
      author.once("dialog", dialog => dialog.accept());
      await author.locator(`[data-action="delete-goal"][data-event-id="${latest.eventId}"]`).click();
      await expect(events(author)).toHaveCount(1);
      await refresh(observer); await expect(events(observer)).toHaveCount(1);
      for (const third of [1, 2, 3]) {
        await author.locator('[data-action="finish-active-third"]').click();
        await expect(author.locator('[data-action="finish-active-third"]')).toBeDisabled();
        await refresh(observer); await expect(observer.locator('[data-action="finish-active-third"]')).toBeDisabled();
        if (third < 3) {
          await author.locator('[data-action="start-active-third"]').click();
          await expect(author.locator("#timer-third-label")).toHaveText(`Third ${third + 1}`);
          await refresh(observer); await expect(observer.locator("#timer-third-label")).toHaveText(`Third ${third + 1}`);
        }
      }
      await author.locator('[data-action="finish-game"]').click();
      await expect(author.getByTestId("game-mode-final")).toBeVisible();
      await refresh(observer); await expect(observer.locator('[data-action="finish-game"]')).toHaveText("Game finished");
      await expect(observer).toHaveURL(`${origin}${gamePath}#score`);
      await expect(observer.getByTestId("game-mode-run")).toBeVisible();
      await expect(observer.getByTestId("game-mode-run-tab")).toHaveAttribute("aria-current", "page");
      await expect(observer.getByTestId("game-mode-run-tab")).not.toContainText("Correction");
      await expect(observer.locator("#finished-correction-actions")).toBeHidden();
      await expect(observer.getByTestId("add-goal")).toBeDisabled();
      await expect(observer.locator("#goal-form-note")).toContainText(/finished/i);
      await capture(observer, testInfo, `remote-finished-score-${theme}-${width}`);
      await observer.getByTestId("game-mode-final-tab").click();
      await expect(observer.getByTestId("game-result-outcome")).toHaveText("Red win");
      await expect(observer.getByTestId("game-mode-run-tab")).toBeHidden();
      await expect(observer.locator('[data-action="correct-finished-result"]')).toBeVisible();
      expect(backend.writes("observer")).toHaveLength(0);
      await expect(observer.locator("#setup-status")).toBeHidden(); clean(backend);
    } finally { await pair.close(); }
  });
}

test("remote reads preserve actual goal controls open assists focus and scroll", async ({ browser }, testInfo) => {
  const backend = sharedBackend(); const pair = await clients(browser, backend);
  const { author, observer } = pair;
  try {
    await open(author); await open(observer); await draft(observer, backend);
    await observer.locator("#goal-assists-dropdown > summary").click();
    const selectedAssist = observer.locator(`#goal-assists input[value="${backend.players[6].playerId}"]`);
    await selectedAssist.check(); await selectedAssist.focus();
    const preserved = await observer.evaluateHandle(() => {
      const list = document.getElementById("goal-assists")!;
      list.scrollTop = 100;
      return { scorer: document.getElementById("goal-scorer"), radio: document.querySelector('#goal-scoring-team input:checked'),
        assist: document.activeElement, list, scroll: list.scrollTop, dropdown: document.getElementById("goal-assists-dropdown"), windowScroll: scrollY };
    });
    expect(await preserved.evaluate(value => value.scroll)).toBeGreaterThan(0);
    await recordGoal(author, backend); await refresh(observer, 15_100);
    await expect(events(observer)).toHaveCount(2);
    expect(await preserved.evaluate(value => ({ scorer: value.scorer === document.getElementById("goal-scorer"),
      radio: value.radio === document.querySelector('#goal-scoring-team input:checked'), focus: value.assist === document.activeElement,
      assistConnected: value.assist?.isConnected, list: value.list === document.getElementById("goal-assists"),
      scroll: value.list.scrollTop === value.scroll, windowScroll: Math.abs(scrollY - value.windowScroll) < 2,
      open: (value.dropdown as HTMLDetailsElement).open }))).toEqual({ scorer: true, radio: true, focus: true, assistConnected: true, list: true, scroll: true, windowScroll: true, open: true });
    await expect(observer.locator("#goal-scorer")).toHaveValue(backend.players[0].playerId);
    await expect(selectedAssist).toBeChecked(); await expect(observer.locator("#setup-status")).toBeHidden();
    expect(backend.writes("observer")).toHaveLength(0);
    await capture(observer, testInfo, "remote-goal-preserved-assists-dark-390");
    await preserved.dispose(); clean(backend);
  } finally { await pair.close(); }
});

test("scheduled refresh preserves metadata and Add player drafts search caret and disclosures", async ({ browser }, testInfo) => {
  const backend = sharedBackend("scheduled"); const pair = await clients(browser, backend, 320, "light");
  const { author, observer } = pair;
  try {
    await open(author, "teams"); await open(observer, "overview");
    await observer.locator('[data-action="toggle-game-edit"]').click();
    const kickoffInput = observer.locator("#game-edit-kickoff");
    await kickoffInput.fill("2026-09-14T10:30");
    const metadata = await kickoffInput.elementHandle();
    await observer.getByTestId("game-mode-players-tab").click();
    await observer.locator('[data-action="toggle-player-create"]').click();
    await observer.locator("#game-player-new-toggle").click();
    await observer.locator("#player-nickname").fill("Keep this local player draft");
    await observer.locator("#game-player-picker-search").fill("Arrival");
    await observer.clock.runFor(200);
    await observer.locator("#game-player-picker-search").evaluate((input: HTMLInputElement) => { input.focus(); input.setSelectionRange(2, 5); });
    const draftNodes = await observer.evaluateHandle(() => ({ name: document.getElementById("player-nickname"), search: document.getElementById("game-player-picker-search") }));
    await author.locator('[data-action="toggle-player-create"]').click();
    await author.locator("#game-player-new-toggle").click();
    await author.locator("#player-nickname").fill("Arrival Alexandra Francesca Montgomery-Williams");
    await author.locator('[data-action="quick-create-player"]').click();
    await expect(author.locator("#player-nickname")).toHaveValue("");
    await refresh(observer, 15_100);
    await expect(observer.locator('[data-ui="roster-player"]')).toHaveCount(3);
    await expect(observer.locator('[data-ui="roster-player"]').filter({ hasText: "Arrival Alexandra Francesca Montgomery-Williams" })).toHaveCount(1);
    await expect(observer.locator("#player-create-region")).toBeVisible();
    await expect(observer.locator('[data-action="toggle-player-create"]')).toBeHidden();
    await expect(observer.locator("#player-nickname")).toHaveValue("Keep this local player draft");
    expect(await draftNodes.evaluate(value => ({ name: value.name === document.getElementById("player-nickname"),
      search: value.search === document.activeElement, start: (value.search as HTMLInputElement).selectionStart,
      end: (value.search as HTMLInputElement).selectionEnd }))).toEqual({ name: true, search: true, start: 2, end: 5 });
    await capture(observer, testInfo, "remote-arrival-preserved-drafts-light-320");
    const arrival = observer.locator('[data-ui="roster-player"]').filter({ hasText: "Arrival Alexandra Francesca Montgomery-Williams" });
    await expect(arrival.locator('[data-ui="player-initial"]')).toHaveAttribute("data-link-state", "unknown");
    await observer.getByRole("button", { name: "Refresh player details", exact: true }).click();
    await expect(arrival.locator('[data-ui="player-initial"]')).toHaveAttribute("data-link-state", "unlinked");
    await expect(arrival.locator('[data-action="toggle-action-menu"]')).toBeVisible();
    await expect(observer.locator("#roster-retry")).toBeHidden();
    await expect(observer.locator("#player-nickname")).toHaveValue("Keep this local player draft");
    await observer.getByTestId("game-mode-structure-tab").click();
    // Opening Add player intentionally closes the other transient disclosure.
    // Its hidden metadata draft and native field still survive the refresh.
    await expect(observer.locator("#game-edit-region")).toBeHidden();
    await observer.locator('[data-action="toggle-game-edit"]').click();
    await expect(observer.locator("#game-edit-region")).toBeVisible();
    await expect(kickoffInput).toHaveValue("2026-09-14T10:30");
    expect(await metadata!.evaluate(element => element === document.getElementById("game-edit-kickoff"))).toBe(true);
    expect(backend.writes("observer")).toHaveLength(0); await metadata!.dispose(); await draftNodes.dispose(); clean(backend);
  } finally { await pair.close(); }
});

for (const control of ["transfer", "actions"] as const) test(`remote roster changes preserve the engaged ${control} nodes while other rows update`, async ({ browser }, testInfo) => {
  const backend = sharedBackend(); const pair = await clients(browser, backend);
  const { author, observer } = pair;
  try {
    await open(author, "teams"); await open(observer, "teams");
    const playerId = backend.players[0].playerId;
    const row = observer.locator(`[data-ui="roster-member"][data-player-id="${playerId}"]`);
    const trigger = row.locator(`[data-action="${control === "transfer" ? "toggle-transfer" : "toggle-action-menu"}"]`);
    await trigger.click();
    const surface = row.locator(`[data-ui="${control === "transfer" ? "transfer-menu" : "action-menu-surface"}"]`);
    await expect(surface).toBeVisible();
    const focused = control === "transfer" ? surface.locator('[data-team-id="yellow"]') : surface.getByRole("button", { name: "Make scorer", exact: true });
    await focused.focus();
    const preserved = await row.evaluateHandle((element, kind) => ({ row: element,
      trigger: element.querySelector(`[data-action="${kind === "transfer" ? "toggle-transfer" : "toggle-action-menu"}"]`),
      surface: element.querySelector(`[data-ui="${kind === "transfer" ? "transfer-menu" : "action-menu-surface"}"]`),
      active: document.activeElement, scroll: scrollY }), control);
    const movedId = backend.players[2].playerId;
    await author.locator(`[data-action="toggle-transfer"][data-player-id="${movedId}"]`).click();
    await author.locator(`[data-action="assign-player"][data-player-id="${movedId}"][data-team-id="yellow"]`).click();
    await expect(author.locator(`[data-ui="roster-team"][data-team-id="yellow"] [data-ui="roster-member"][data-player-id="${movedId}"]`)).toBeVisible();
    const arrivalId = backend.players[18].playerId;
    await author.locator(`[data-ui="roster-player"][data-player-id="${arrivalId}"] [data-action="assign-player"][data-team-id="red"]`).click();
    await expect(author.locator('[data-ui="roster-member"]')).toHaveCount(19);
    await refresh(observer, 15_100);
    await expect(observer.locator(`[data-ui="roster-team"][data-team-id="yellow"] [data-ui="roster-member"][data-player-id="${movedId}"]`)).toHaveCount(1);
    await expect(observer.locator('[data-ui="roster-member"]')).toHaveCount(19);
    await expect(observer.locator(`[data-ui="roster-player"][data-player-id="${arrivalId}"]`)).toHaveCount(0);
    await expect(surface).toBeVisible(); await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(focused).toBeFocused();
    expect(await preserved.evaluate(value => ({ row: value.row.isConnected, trigger: value.trigger?.isConnected,
      surface: value.surface?.isConnected, focus: value.active === document.activeElement,
      scroll: Math.abs(scrollY - value.scroll) < 2 }))).toEqual({ row: true, trigger: true, surface: true, focus: true, scroll: true });
    expect(backend.writes("observer")).toHaveLength(0); await expect(observer.locator("#setup-status")).toBeHidden();
    await capture(observer, testInfo, `remote-roster-preserved-${control}-dark-390`);
    await preserved.dispose(); clean(backend);
  } finally { await pair.close(); }
});

test("a remote transfer retains the drafted scorer and assists but blocks an invalid save", async ({ browser }, testInfo) => {
  const backend = sharedBackend(); const pair = await clients(browser, backend);
  const { author, observer } = pair;
  try {
    await open(author, "teams"); await open(observer); await draft(observer, backend);
    await observer.locator("#goal-assists-dropdown > summary").click();
    const assist = observer.locator(`#goal-assists input[value="${backend.players[6].playerId}"]`);
    await assist.check(); await assist.focus();
    const assistNode = await assist.elementHandle();
    await author.locator(`[data-action="toggle-transfer"][data-player-id="${backend.players[0].playerId}"]`).click();
    await author.locator(`[data-action="assign-player"][data-player-id="${backend.players[0].playerId}"][data-team-id="yellow"]`).click();
    await expect(author.locator(`[data-ui="roster-team"][data-team-id="yellow"] [data-player-id="${backend.players[0].playerId}"]`).first()).toBeVisible();
    await refresh(observer, 15_100);
    await expect(observer.locator("#goal-scorer")).toHaveValue(backend.players[0].playerId);
    await expect(assist).toBeChecked(); await expect(assist).toBeFocused();
    expect(await assistNode!.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true);
    await expect(observer.locator("#goal-assists-dropdown")).toHaveAttribute("open", "");
    await expect(observer.getByTestId("add-goal")).toBeDisabled();
    await expect(observer.locator("#goal-form-note")).toContainText(/changed|review/i);
    await observer.locator("#goal-form").dispatchEvent("submit");
    expect(backend.writes("observer")).toHaveLength(0);
    await capture(observer, testInfo, "remote-transfer-invalid-draft-dark-390"); await assistNode!.dispose(); clean(backend);
  } finally { await pair.close(); }
});

test("a remotely edited goal does not replace the open correction draft", async ({ browser }, testInfo) => {
  const backend = sharedBackend(); const pair = await clients(browser, backend);
  const { author, observer } = pair;
  try {
    await open(author); await open(observer);
    const id = backend.goals[0].eventId;
    await observer.locator(`[data-action="edit-goal"][data-event-id="${id}"]`).click();
    await observer.locator("#goal-assists-dropdown > summary").click();
    const assist = observer.locator(`#goal-assists input[value="${backend.players[6].playerId}"]`);
    await assist.check(); await assist.focus();
    await author.locator(`[data-action="edit-goal"][data-event-id="${id}"]`).click();
    await author.locator("#goal-scorer").selectOption(backend.players[1].playerId);
    await author.getByTestId("add-goal").click();
    await expect(author.locator("#goal-scorer")).toHaveValue("");
    await refresh(observer);
    await expect(observer.locator(`[data-ui="goal-event"][data-event-id="${id}"] [data-ui="goal-scorer"]`)).toHaveText("Sam");
    await expect(observer.locator("#goal-scorer")).toHaveValue(backend.players[0].playerId);
    await expect(assist).toBeChecked(); await expect(observer.getByTestId("add-goal")).toBeDisabled();
    await expect(observer.locator("#goal-form-note")).toContainText(/changed|review/i);
    await observer.locator("#goal-form").dispatchEvent("submit");
    expect(backend.writes("observer")).toHaveLength(0);
    await capture(observer, testInfo, "remote-edited-goal-preserved-draft-dark-390"); clean(backend);
  } finally { await pair.close(); }
});

for (const width of [320, 390]) for (const theme of ["light", "dark"] as const) {
  test(`stale reads retain known scores and Retry updates recovers ${theme} ${width}`, async ({ browser }, testInfo) => {
    const backend = sharedBackend(); const pair = await clients(browser, backend, width, theme);
    const { author, observer } = pair;
    try {
      await open(author); await open(observer);
      const scoreText = await observer.locator("#live-scoreboard").innerText();
      const logText = await events(observer).allTextContents();
      backend.failReads.set("observer", new Set([`${apiPath}/goals`]));
      await recordGoal(author, backend); await refresh(observer);
      await expect(observer.locator("#game-refresh-notice")).toBeVisible();
      await expect(observer.locator("#game-refresh-message")).toContainText(/updates.*unavailable|last loaded|out of date/i);
      await expect(observer.locator("#game-refresh-message")).toHaveAttribute("role", "status");
      expect(await observer.locator("#live-scoreboard").innerText()).toBe(scoreText);
      expect(await events(observer).allTextContents()).toEqual(logText);
      await expect(observer).toHaveURL(`${origin}${gamePath}#score`);
      await expect(observer.locator("#setup-status")).toBeHidden();
      await recoveryGeometry(observer); await capture(observer, testInfo, `refresh-unavailable-${theme}-${width}`);
      backend.failReads.delete("observer");
      const retry = observer.getByRole("button", { name: "Retry updates", exact: true });
      await retry.focus(); await observer.keyboard.press("Enter");
      await expect(events(observer)).toHaveCount(2);
      await expect(observer.locator("#game-refresh-notice")).toBeHidden();
      await expect(observer.locator("#setup-status")).toBeHidden();
      expect(backend.writes("observer")).toHaveLength(0); clean(backend);
    } finally { await pair.close(); }
  });
}

test("an observed committed goal never confirms another client's unresolved save", async ({ browser }) => {
  const backend = sharedBackend(); const pair = await clients(browser, backend);
  const { author, observer } = pair;
  try {
    await open(author); await open(observer); await draft(author, backend);
    backend.lostGoalResponses.add("author");
    await author.getByTestId("add-goal").click();
    await expect(author.locator('[data-action="retry-goal-operation"]')).toBeVisible();
    const original = backend.writes("author").find(request => request.path === `${apiPath}/goals`)!;
    await refresh(observer); await expect(events(observer)).toHaveCount(2);
    await refresh(author, 15_100);
    await expect(author.locator('[data-action="retry-goal-operation"]')).toBeVisible();
    await expect(author.locator("#goal-scorer")).toHaveValue(backend.players[0].playerId);
    expect(backend.writes("author")).toHaveLength(1);
    await author.locator('[data-action="retry-goal-operation"]').click();
    await expect(author.locator('[data-action="retry-goal-operation"]')).toBeHidden();
    expect(backend.goals).toHaveLength(2);
    const writes = backend.writes("author"); expect(writes).toHaveLength(2);
    expect(writes[1].key).toBe(original.key); expect(writes[1].serialized).toBe(original.serialized);
    expect(backend.writes("observer")).toHaveLength(0); clean(backend);
  } finally { await pair.close(); }
});

test("a finished viewer receives corrections without closing the full match log", async ({ browser }, testInfo) => {
  const backend = sharedBackend("finished"); const pair = await clients(browser, backend, 390, "dark", "viewer");
  const { author, observer } = pair;
  try {
    await open(author, "results"); await open(observer, "results");
    const log = observer.getByTestId("final-full-goal-log");
    await log.locator("summary").click(); await log.locator("summary").focus();
    const preserved = await log.evaluateHandle(element => ({ log: element, summary: element.querySelector("summary"), scroll: scrollY }));
    await author.locator('[data-action="correct-finished-result"]').click();
    await recordGoal(author, backend);
    await refresh(observer, 15_100);
    await expect(observer.locator('[data-ui="final-goal-item"]')).toHaveCount(2);
    await expect(log).toHaveAttribute("open", "");
    expect(await preserved.evaluate(value => ({ log: value.log === document.querySelector('[data-testid="final-full-goal-log"]'),
      focus: value.summary === document.activeElement, scroll: Math.abs(scrollY - value.scroll) < 2 }))).toEqual({ log: true, focus: true, scroll: true });
    await expect(observer).toHaveURL(`${origin}${gamePath}#results`);
    await expect(observer.getByTestId("game-mode-run-tab")).toBeHidden();
    await expect(observer.locator('[data-action="correct-finished-result"]')).toBeHidden();
    expect(backend.writes("observer")).toHaveLength(0);
    expect(backend.requests.some(request => request.client === "observer" && request.path === `${apiPath}/players`)).toBe(false);
    await capture(observer, testInfo, "remote-correction-viewer-open-log-dark-390");
    await preserved.dispose(); clean(backend);
  } finally { await pair.close(); }
});
