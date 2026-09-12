import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectTeamTotalAlignment } from "./team-total-assertions.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { hashPlayerProofSecret } from "../../api/dist/auth/player-proof.js";
import {
  renderGamePage, renderInvitePage, renderJoinPage, renderMagicLinkCallbackPage,
  renderSetupHomePage, renderSignInPage, renderPlayerLinkPage,
} from "../../app/dist/ui/layout.js";

// Production-built pages, CSS and controllers; only transport is fictional.
// Unknown/external requests are aborted. This sends no email, touches no QA/AWS
// data and proves neither backend auth guarantees nor physical-device behaviour.
// Build first. Run with THREEFC_SKIP_WEB_SERVER=1, one worker and the repo guard.
const origin = "https://3fc.fixture.test";
const gameId = "fictional-results-game";
const leagueId = "fictional-results-league";
const seasonId = "fictional-results-season";
const gamePath = `/games/${gameId}`;
const apiPath = `/v1${gamePath}`;
const joinCode = "ABCDEFGH";
const joinContextPath = `/v1/join/${joinCode}/player-context`;
const inviteCode = "JKLMNPQR";
const nickname = "Alexandra Francesca Montgomery-Williams";
const recipient = "alexandra.montgomery-williams@fictional-community.example.com";
const now = "2026-09-13T02:00:00.000Z";
const kickoff = "2026-09-13T00:00:00.000Z";
const teamIds = ["red", "blue", "yellow"] as const;
type TeamId = (typeof teamIds)[number];
type Role = "admin" | "scorekeeper" | "viewer";
type ResultKind = "win" | "tiebreak" | "two-draw" | "draw" | "zero" | "bad-count" | "bad-winner" | "duplicate" | "missing";
type LogKind = "valid" | "unavailable" | "missing" | "null-row" | "duplicate" | "cross-game";
type Goal = {
  gameId: string; eventId: string; third: number; thirdMinute: number; gameMinute: number;
  elapsedSeconds: number; stoppageMinute: number | null; displayTime: string;
  scoringTeamId: TeamId | null; concedingTeamId: TeamId; scorerPlayerId: string;
  assistPlayerIds: string[]; ownGoal: boolean; createdAt: string; updatedAt: string;
};
type RequestRecord = { method: string; path: string; query: string; body: Record<string, unknown> | null; serialized: string | null; privateBodyFingerprint?: string; key?: string };
type Operation = "join" | "claim" | "preview" | "invite" | "magic" | "complete" | "logout";
type Plan = { kind: Operation; gate?: ReturnType<typeof deferred>; status?: number; commit?: boolean; malformed?: boolean; message?: string; code?: string };
type LookupPlan = { gate?: ReturnType<typeof deferred>; status?: number; payload?: unknown };
type Options = { authenticated?: boolean; role?: Role; result?: ResultKind; log?: LogKind; sessionGate?: ReturnType<typeof deferred>; inviteLeagueId?: string;
  contextPlayers?: Array<{ playerId: string; nickname: string }> };
const assets = new Map(["player-presentation-browser.js", "styles.css", "icons.css", "setup-flow.js", "auth-flow.js", "modal.js", "player-proof.js", "player-consolidation.js", "returning-player.js"].map(name => [
  `/ui/${name}`, readFileSync(resolve("app/dist/ui", name), "utf8"),
]));

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function snapshot<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

async function installPausedClock(page: Page) {
  // install() alone keeps advancing with wall time. Pause on the blank page,
  // before app navigation can schedule the callback's exact three-second timer.
  // The earlier seed leaves pauseAt() a future instant even across tool latency.
  await page.clock.install({ time: new Date(Date.parse(now) - 60_000) });
  await page.clock.pauseAt(new Date(now));
}

async function installFixture(page: Page, options: Options = {}) {
  const players = Array.from({ length: 19 }, (_, index) => ({
    playerId: index === 18 ? "historical/player.with-string-id" : `fictional-player-${index + 1}`,
    nickname: index === 0 ? nickname : index === 1 || index === 7 ? "Sam"
      : index === 6 ? "Ibrahim O’Connell-Rodríguez"
        : index === 12 ? "Morgan Alexandra Montgomery-Williams"
          : index === 18 ? "Former player Francesca Montgomery-Williams" : `Fictional Player ${index + 1}`,
    createdAt: kickoff, updatedAt: kickoff,
  }));
  const assignments = new Map(players.slice(0, 18).map((player, index) => [player.playerId, teamIds[Math.floor(index / 6)]]));
  const goals: Goal[] = [];
  function goal(scoringTeamId: TeamId | null, concedingTeamId: TeamId, scorerIndex: number, assists: number[] = []) {
    const third = Math.min(3, Math.floor(goals.length / 3) + 1);
    const thirdMinute = goals.length + 2;
    goals.push({ gameId, eventId: `fictional-goal-${goals.length + 1}`, third, thirdMinute,
      gameMinute: (third - 1) * 20 + thirdMinute, elapsedSeconds: (thirdMinute - 1) * 60,
      stoppageMinute: null, displayTime: `${(third - 1) * 20 + thirdMinute}′`,
      scoringTeamId, concedingTeamId, scorerPlayerId: players[scorerIndex].playerId,
      assistPlayerIds: assists.map(index => players[index].playerId), ownGoal: scoringTeamId === null,
      createdAt: new Date(Date.parse(kickoff) + goals.length * 60_000).toISOString(), updatedAt: now });
  }
  if (options.result !== "zero") {
    goal("red", "blue", 0, [6, 12]);
    goal("red", "blue", 1, [7]);
    goal("blue", "yellow", 6, [0]);
    goal("blue", "yellow", 7, [12]);
    goal("yellow", "blue", 12);
    goal(null, "yellow", 13);
    // The existing historical log permits string IDs absent from today's roster.
    goal("red", "blue", 18, [6]);
  }
  const liveTeams = teamIds.map((teamId, index) => ({ gameId, teamId,
    name: ["Red", "Blue", "Yellow"][index], color: ["#d83b36", "#2364d2", "#e0a612"][index],
    scored: goals.filter(goal => !goal.ownGoal && goal.scoringTeamId === teamId).length,
    conceded: goals.filter(goal => goal.concedingTeamId === teamId).length,
    createdAt: kickoff, updatedAt: now,
  }));
  function resultPayload() {
    const teams = snapshot(liveTeams);
    if (options.result === "tiebreak" || options.result === "two-draw") {
      teams.forEach((team, index) => { team.conceded = index === 2 ? 3 : 1; team.scored = index === 0 || options.result === "two-draw" && index === 1 ? 3 : index === 1 ? 2 : 1; });
    }
    if (options.result === "draw") teams.forEach(team => { team.conceded = 1; team.scored = 2; });
    const ordered = [...teams].sort((a, b) => a.conceded - b.conceded || b.scored - a.scored);
    const leading = teams.filter(team => team.conceded === ordered[0].conceded && team.scored === ordered[0].scored);
    const result = { outcome: leading.length > 1 ? "draw" : "win", winnerTeamId: leading.length > 1 ? null : leading[0].teamId,
      comparator: "fewest_conceded_then_most_scored", computedAt: now,
      teams: teams.map(team => ({ ...team, rank: ordered.findIndex(other => other.conceded === team.conceded && other.scored === team.scored) + 1,
        outcome: leading.some(other => other.teamId === team.teamId) ? leading.length > 1 ? "draw" : "win" : "loss" })),
    };
    if (options.result === "bad-count") result.teams[0].conceded = -1;
    if (options.result === "bad-winner") result.winnerTeamId = null;
    if (options.result === "duplicate") result.teams[2] = snapshot(result.teams[0]);
    if (options.result === "missing") result.teams.pop();
    return result;
  }
  const game = { gameId, leagueId, seasonId, sessionId: "20260913", joinCode, status: "finished",
    gameStartTs: kickoff, thirdLengthMinutes: 20, createdAt: kickoff, updatedAt: now, finishedAt: now,
    thirds: [1, 2, 3].map(third => ({ third, startedAt: new Date(Date.parse(kickoff) + (third - 1) * 20 * 60_000).toISOString(), finishedAt: new Date(Date.parse(kickoff) + third * 20 * 60_000).toISOString() })),
    result: resultPayload(),
  };
  const state = { authenticated: options.authenticated ?? true, role: options.role ?? "admin", joined: 0, claimed: 0, accepted: 0 };
  const requests: RequestRecord[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const plans: Plan[] = [];
  const lookupPlans: LookupPlan[] = [];
  const joinIdentities = new Map(players.map(player => [player.playerId, snapshot(player)]));
  joinIdentities.set("fictional-existing-player", { playerId: "fictional-existing-player", nickname, createdAt: now, updatedAt: now });
  for (const player of options.contextPlayers ?? []) joinIdentities.set(player.playerId, { ...player, createdAt: now, updatedAt: now });
  const joinReplays = new Map<string, { serialized: string | null; payload: unknown }>();
  const proofs = new Map<string, { playerId: string; verifier: string; expiresAt: string; linked: boolean }>();
  let sessionGate = options.sessionGate;
  page.on("pageerror", error => { errors.push(error.message); });
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(`External ${url.origin}${url.pathname}`); return route.abort(); }
    const method = request.method();
    const asset = assets.get(url.pathname);
    if (method === "GET" && asset !== undefined) return route.fulfill({ body: asset, contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
    if (method === "GET" && url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    if (method === "GET" && !url.pathname.startsWith("/v1/")) {
      let html: string | undefined;
      if (url.pathname === gamePath) html = renderGamePage(origin, { gameId });
      if (url.pathname === "/join" || url.pathname === `/join/${joinCode}`) html = renderJoinPage(origin, url.searchParams.get("code") ?? (url.pathname === "/join" ? "" : joinCode));
      if (url.pathname === "/invites" || url.pathname === `/invites/${inviteCode}`) html = renderInvitePage(origin, url.searchParams.get("code") ?? (url.pathname === "/invites" ? "" : inviteCode));
      if (url.pathname === "/sign-in") html = renderSignInPage(origin, url.searchParams.get("returnTo") ?? "/setup");
      if (url.pathname === "/auth/callback") html = renderMagicLinkCallbackPage(origin);
      if (url.pathname === "/setup") html = renderSetupHomePage(origin);
      if (url.pathname === "/link-player") html = renderPlayerLinkPage(origin);
      if (html !== undefined) return route.fulfill({ contentType: "text/html", body: html });
    }
    const serialized = request.postData();
    const body = serialized ? request.postDataJSON() as Record<string, unknown> : null;
    // Keep proof secrets out of test assertion output and captured request lists.
    const privateRequest = url.pathname.startsWith("/v1/player-proofs/");
    const record: RequestRecord = { method, path: url.pathname, query: url.search, body: privateRequest ? null : body, serialized: privateRequest ? null : serialized,
      ...(privateRequest && serialized !== null ? { privateBodyFingerprint: createHash("sha256").update(serialized).digest("hex") } : {}),
      key: request.headers()["idempotency-key"] };
    requests.push(record);
    const reject = (status: number, message: string, code?: string) => route.fulfill({ status, json: {
      error: status === 503 ? "unavailable" : status === 409 ? "conflict" : status === 403 ? "forbidden" : status === 404 ? "not_found" : "rejected",
      message, ...(code ? { code } : {}),
    } });
    if (method === "GET") {
      if (url.pathname === "/v1/auth/session") {
        const authenticated = state.authenticated;
        const gate = sessionGate; sessionGate = undefined;
        if (gate) await gate.promise;
        return route.fulfill({ status: authenticated ? 200 : 401, headers: { "cache-control": "no-store" }, json: authenticated
          ? { authenticated: true, session: { sessionId: "fictional-auth-session", email: recipient, userId: "fictional-account" } } : { error: "unauthorized" } });
      }
      if (url.pathname === joinContextPath) {
        if (!state.authenticated) return reject(401, "Sign in to identify this player.");
        // The API accepts the opaque ID in one query value, not a decoded route
        // segment. Decode raw query values once, with strict malformed handling.
        let ids: string[];
        try {
          ids = url.search.slice(1).split("&").flatMap(part => {
            const separator = part.indexOf("=");
            const key = separator < 0 ? part : part.slice(0, separator);
            const value = separator < 0 ? "" : part.slice(separator + 1);
            return decodeURIComponent(key.replace(/\+/g, " ")) === "playerId"
              ? [decodeURIComponent(value.replace(/\+/g, " "))] : [];
          });
        } catch { return reject(400, "This player link is invalid."); }
        if (ids.length !== 1 || !ids[0].trim()) return reject(400, "This player link is invalid.");
        const plan = lookupPlans.shift();
        if (plan?.gate) await plan.gate.promise;
        if (plan?.status) return reject(plan.status, "Player details could not be loaded.");
        const player = joinIdentities.get(ids[0]);
        if (!player) return reject(404, "Player not found for this join code.");
        return route.fulfill({ headers: { "cache-control": "no-store" }, json: plan?.payload ?? { gameId, joinCode, player } });
      }
      if (url.pathname === `/v1/join/${joinCode}/linked-players`) {
        if (!state.authenticated) return reject(401, "Sign in to continue.");
        return route.fulfill({ json: { accountId: recipient, gameId, leagueId, players: [], cursor: null, complete: true } });
      }
      if (url.pathname === "/v1/leagues") return route.fulfill({ json: { leagues: [] } });
      if (url.pathname === `/v1/leagues/${leagueId}`) return route.fulfill({ json: { leagueId, name: "Fictional Community Football League", access: { role: state.role } } });
      if (url.pathname === `/v1/leagues/${leagueId}/seasons/${seasonId}`) return route.fulfill({ json: { leagueId, seasonId, name: "Fictional Spring Season", startsOn: "2026-09-01", endsOn: "2027-02-28" } });
      if (url.pathname === apiPath) return route.fulfill({ json: game });
      if (url.pathname === `${apiPath}/teams`) return route.fulfill({ json: { teams: liveTeams } });
      if (url.pathname === `${apiPath}/roster`) return route.fulfill({ json: { teams: liveTeams, roster: players.slice(0, 18).map(player => ({ gameId, playerId: player.playerId, teamId: assignments.get(player.playerId), player, createdAt: kickoff, updatedAt: kickoff })), unassignedPlayers: players.slice(18) } });
      if (url.pathname === `${apiPath}/players` && state.role !== "viewer") return route.fulfill({ json: { players } });
      if (url.pathname === `${apiPath}/goals`) {
        if (options.log === "unavailable") return reject(503, "Goal details unavailable.");
        let timeline: unknown = snapshot(goals);
        if (options.log === "null-row") timeline = [null, ...goals];
        if (options.log === "duplicate") timeline = [...goals, goals[0]];
        if (options.log === "cross-game") timeline = [{ ...goals[0], gameId: "another-fictional-game" }, ...goals.slice(1)];
        return route.fulfill({ json: { ...(options.log === "missing" ? {} : { timeline }), scoreboard: { teams: liveTeams } } });
      }
    }
    const kind: Operation | null = method !== "POST" ? null
      : url.pathname === `/v1/join/${joinCode}` ? "join"
        : url.pathname === "/v1/player-proofs/claim" ? "claim"
          : url.pathname === "/v1/player-proofs/preview" ? "preview"
          : url.pathname === `/v1/invites/${inviteCode}/accept` ? "invite"
            : url.pathname === "/v1/auth/magic/start" ? "magic"
              : url.pathname === "/v1/auth/magic/complete" ? "complete"
                : url.pathname === "/v1/auth/logout" ? "logout" : null;
    if (!kind) { unexpected.push(`${method} ${url.pathname}`); return route.abort(); }
    let proof: { playerId: string; verifier: string; expiresAt: string; linked: boolean } | undefined;
    if (kind === "preview" || kind === "claim") {
      if (!state.authenticated) return reject(401, "Sign in to continue.");
      const supplied = (kind === "claim" ? body?.proof : body) as { proofId?: string; secret?: string; confirmation?: string } | undefined;
      proof = proofs.get(String(supplied?.proofId));
      if (!proof || typeof supplied?.secret !== "string" || hashPlayerProofSecret(supplied.secret) !== proof.verifier || Date.parse(proof.expiresAt) <= Date.now()) return reject(400, "This private link is invalid or expired.", "invalid_claim_proof");
      if (kind === "claim" && (url.searchParams.get("playerId") !== proof.playerId || supplied.confirmation !== `bound-${recipient}-${supplied.proofId}`)) return reject(403, "Review this player again.", "account_changed");
    }
    if (kind === "join" && !record.key) return reject(400, "An idempotency key is required.");
    if (kind === "join" && record.key && joinReplays.has(record.key)) {
      const replay = joinReplays.get(record.key)!;
      return replay.serialized === serialized ? route.fulfill({ status: 201, json: replay.payload }) : reject(409, "The retry payload changed.");
    }
    const planIndex = plans.findIndex(plan => plan.kind === kind);
    const plan = planIndex >= 0 ? plans.splice(planIndex, 1)[0] : undefined;
    if (plan?.gate) await plan.gate.promise;
    if (plan?.status && !plan.commit) return reject(plan.status, plan.message ?? "The operation could not be confirmed.", plan.code);
    let payload: unknown = {};
    if (kind === "join") {
      const claimProof = body?.claimProof as { proofId?: string; verifier?: string } | undefined;
      if (!claimProof?.proofId || !claimProof.verifier) return reject(400, "Private proof required.");
      state.joined += 1;
      const player = { playerId: `fictional-joined-player-${state.joined}`, nickname: String(body?.nickname ?? ""), createdAt: now, updatedAt: now };
      joinIdentities.set(player.playerId, player);
      const expiresAt = new Date(Date.now() + 86400_000).toISOString();
      proofs.set(claimProof.proofId, { playerId: player.playerId, verifier: claimProof.verifier, expiresAt, linked: false });
      payload = { gameId, joinCode, player, link: { gameId, playerId: player.playerId }, claimProof: { proofId: claimProof.proofId, expiresAt } };
      joinReplays.set(record.key!, { serialized, payload: snapshot(payload) });
    }
    if (kind === "claim") {
      state.claimed += 1;
      const playerId = proof!.playerId; proof!.linked = true;
      payload = { player: joinIdentities.get(playerId) ?? { playerId, nickname, createdAt: now, updatedAt: now }, claim: { claimedByCurrentUser: true } };
    }
    if (kind === "preview") payload = { preview: { proofId: body!.proofId, expiresAt: proof!.expiresAt, player: joinIdentities.get(proof!.playerId),
      league: { leagueId, name: "Fictional Community Football League" }, confirmation: `bound-${recipient}-${body!.proofId}`, alreadyLinked: proof!.linked }, account: { id: recipient, email: recipient } };
    if (kind === "invite") {
      state.accepted = 1;
      const acceptedLeagueId = options.inviteLeagueId ?? leagueId;
      payload = { invite: { leagueId: acceptedLeagueId, inviteCode }, access: { leagueId: acceptedLeagueId, role: "admin" } };
    }
    if (kind === "magic") payload = { ok: true };
    if (kind === "complete") { state.authenticated = true; payload = { session: { sessionId: "fictional-auth-session", email: recipient, userId: "fictional-account" } }; }
    if (kind === "logout") {
      state.authenticated = false;
      return route.fulfill({ status: 204, headers: { "cache-control": "no-store" }, body: "" });
    }
    if (plan?.status) return reject(plan.status, plan.message ?? "The operation could not be confirmed.", plan.code);
    return route.fulfill({ status: kind === "join" ? 201 : 200, json: plan?.malformed ? {} : payload });
  });
  return { state, players, goals, game, requests, plans, lookupPlans, unexpected, errors,
    writes: (kind?: Operation) => requests.filter(request => request.method === "POST" && (!kind || (
      kind === "join" ? request.path.startsWith("/v1/join/") : kind === "claim" ? request.path.endsWith("/claim")
        : kind === "preview" ? request.path.endsWith("/preview") : kind === "invite" ? request.path.endsWith("/accept") : kind === "logout" ? request.path.endsWith("/logout")
          : request.path.endsWith(kind === "magic" ? "/magic/start" : "/magic/complete")
    ))),
  };
}
type Fixture = Awaited<ReturnType<typeof installFixture>>;

function expectClean(fixture: Fixture) {
  expect(fixture.unexpected, "All requests must stay inside the explicit fictional transport").toEqual([]);
  expect(fixture.errors, "No browser controller exception").toEqual([]);
}

async function openResults(page: Page) {
  await page.goto(`${origin}${gamePath}#results`);
  await expect(page.getByTestId("game-mode-final")).toBeVisible();
  await expect(page.locator("#game-title")).not.toHaveText("Game");
  await expect(page.locator("#game-result-summary")).toBeVisible();
  // This breadcrumb is resolved after the initial roster/player/goal reads.
  // Waiting for it prevents a partial-data assertion passing on loading UI.
  await expect(page.locator("#game-season-link")).toHaveText("Fictional Spring Season");
}

async function openFullLog(page: Page) {
  const log = page.getByTestId("final-full-goal-log");
  await expect(log).toHaveCount(1);
  const summary = log.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(log).toHaveAttribute("open", "");
  return log;
}

async function expectGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const visible = [...document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, summary")]
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true }));
    const targets = [...new Set(visible.map(element => element.matches('input[type="radio"], input[type="checkbox"]') ? element.closest("label") ?? element : element))];
    const names = [...document.querySelectorAll<HTMLElement>('[data-ui="final-goal-item"] strong, [data-ui="final-stat-list"] span, #join-result-player, #auth-status')]
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true }));
    return { width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      targets: targets.flatMap(element => {
        const box = element.getBoundingClientRect();
        return box.width < 44 * zoom - 0.5 || box.height < 44 * zoom - 0.5 || box.left < -0.5 || box.right > innerWidth + 0.5
          ? [{ name: element.getAttribute("aria-label") || element.textContent?.trim() || element.id, width: box.width, height: box.height, left: box.left, right: box.right }] : [];
      }),
      clipped: names.flatMap(element => getComputedStyle(element).textOverflow === "ellipsis" || element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 ? [element.textContent] : []),
    };
  });
  expect(geometry.scroll, "No horizontal page scrolling").toBeLessThanOrEqual(geometry.width);
  expect(geometry.targets, "Visible controls have at least 44px targets and remain on canvas").toEqual([]);
  expect(geometry.clipped, "Names and current feedback remain readable without ellipsis").toEqual([]);
}

async function expectResultLabelsFit(page: Page) {
  await expectTeamTotalAlignment(page, '[data-ui="result-team"]');
  const measurements = await page.locator('[data-ui="result-team-list"]').evaluate(list => {
    const labels = [...list.querySelectorAll("dt")].map(label => {
      const range = document.createRange();
      range.selectNodeContents(label);
      const rectangles = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      const cell = label.parentElement!.getBoundingClientRect();
      return { text: label.textContent, cell: { left: cell.left, right: cell.right, top: cell.top, bottom: cell.bottom },
        rectangles: rectangles.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })) };
    });
    const overlaps: string[] = [];
    for (let left = 0; left < labels.length; left += 1) {
      for (let right = left + 1; right < labels.length; right += 1) {
        if (labels[left].rectangles.some(a => labels[right].rectangles.some(b =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5))) {
          overlaps.push(`${left}:${labels[left].text} overlaps ${right}:${labels[right].text}`);
        }
      }
    }
    return { labels, overlaps };
  });
  expect(measurements.labels).toHaveLength(6);
  for (const label of measurements.labels) {
    // Element boxes alone can fit while their text spills into the next column.
    expect(label.rectangles, `${label.text} remains a complete, unfragmented label`).toHaveLength(1);
    const text = label.rectangles[0];
    expect(text.left, `${label.text} starts within its own totals cell`).toBeGreaterThanOrEqual(label.cell.left - 0.5);
    expect(text.right, `${label.text} ends within its own totals cell`).toBeLessThanOrEqual(label.cell.right + 0.5);
    expect(text.top).toBeGreaterThanOrEqual(label.cell.top - 0.5);
    expect(text.bottom).toBeLessThanOrEqual(label.cell.bottom + 0.5);
  }
  expect(measurements.overlaps, "Adjacent team/total labels do not overlap").toEqual([]);
}

async function expectMatchHeadingWordsFit(page: Page) {
  const heading = page.locator("#game-title");
  await expect(heading).toBeVisible();
  const measurements = await heading.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node instanceof Text) nodes.push(node);
    const content = nodes.map(node => node.data).join("");
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, words: ["Sunday", "September"].map(word => {
      const start = content.indexOf(word);
      const end = start + word.length;
      const range = document.createRange();
      let offset = 0;
      if (start >= 0) for (const node of nodes) {
        const next = offset + node.data.length;
        if (start >= offset && start < next) range.setStart(node, start - offset);
        if (end > offset && end <= next) range.setEnd(node, end - offset);
        offset = next;
      }
      return { word, occurrences: content.split(word).length - 1,
        rectangles: start < 0 ? [] : [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
          .map(rect => ({ left: rect.left, right: rect.right })) };
    }) };
  });
  for (const word of measurements.words) {
    expect(word.occurrences, `The fixture contains the complete word ${word.word}`).toBe(1);
    expect(word.rectangles, `${word.word} stays on one line instead of being fragmented beside the kebab`).toHaveLength(1);
    expect(word.rectangles[0].left).toBeGreaterThanOrEqual(measurements.left - 0.5);
    expect(word.rectangles[0].right, `${word.word} fits the title's actual available width`).toBeLessThanOrEqual(measurements.right + 0.5);
  }
}

async function expectJoinReceipt(page: Page) {
  const name = page.locator("#join-result-player");
  await expect(name).toBeVisible();
  const receipt = await name.evaluate(element => {
    const panel = element.closest('[data-layout="auth"]')!;
    return { nameWidth: element.getBoundingClientRect().width, panelWidth: panel.getBoundingClientRect().width,
      nameFont: getComputedStyle(element).fontFamily, bodyFont: getComputedStyle(document.body).fontFamily };
  });
  expect(receipt.panelWidth).toBeGreaterThan(0);
  expect(receipt.nameWidth, "The confirmed player name gets over 70% of the panel, not the old half-width ID column").toBeGreaterThan(receipt.panelWidth * 0.7);
  expect(receipt.nameFont, "A person's name uses the body font").toBe(receipt.bodyFont);
  expect(receipt.nameFont, "Reference-ID monospace styling must not return").not.toMatch(/mono|menlo|monaco/i);
}

async function expectCallbackCopyHidden(page: Page) {
  const copy = page.locator("#auth-callback-copy");
  await expect(copy).toHaveCount(1);
  await expect(copy).toBeHidden();
  // Assert computed presentation, not an old string or just the hidden attribute.
  await expect(copy).toHaveCSS("display", "none");
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  expect(new URL(page.url()).searchParams.has("token"), "Callback credentials are scrubbed before evidence").toBe(false);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function expectNoFiller(page: Page) {
  await expect(page.locator("body")).not.toContainText(/for scoring access|so the organiser can make you a scorer|finish your account creation|Join the league setup team|Your context|Permissions follow|Your week with 3FC|Assists: None|Conceded-only own goal/);
  await expect(page.getByRole("link", { name: /Performance|Share result|View game/ })).toHaveCount(0);
}

test.use({ timezoneId: "Australia/Melbourne", locale: "en-AU" });

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [320, 390, 430, 768, 1280]) {
    test(`results and existing entry screens ${colorScheme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const fixture = await installFixture(page);
      await openResults(page);
      await expect(page.getByRole("heading", { name: "Match summary", exact: true })).toBeVisible();
      await expect(page.getByTestId("game-result-outcome")).toHaveText("Red win");
      await expect(page.locator('[data-ui="result-team"]')).toHaveCount(3);
      expect(await page.locator('[data-ui="result-team"]').evaluateAll(elements => elements.map(element => element.getAttribute("data-team-id")))).toEqual(teamIds);
      await expect(page.locator('[data-ui="final-team-log"]')).toHaveCount(0);
      await expect(page.locator("#final-game-status")).toBeHidden();
      const log = await openFullLog(page);
      await expect(log.locator('[data-ui="final-goal-item"]')).toHaveCount(fixture.goals.length);
      await expect(log).toContainText(nickname);
      await expect(log.locator('[data-ui="third-indicator"][aria-label="Third 3 of 3"]')).toHaveCount(1);
      const chips = await log.locator('[data-ui="goal-team-chip"]').evaluateAll(elements => elements.map(element => ({
        text: element.textContent?.trim(), name: element.getAttribute("aria-label"), title: element.getAttribute("title"),
      })));
      expect(chips).toHaveLength(fixture.goals.length * 2 - 1);
      for (const chip of chips) {
        expect(chip.text, "AJ's goal relationships remain dot-only").toBe("");
        expect(chip.name).toMatch(/^(Scoring|Conceding) team: (Red|Blue|Yellow)$/);
        expect(chip.title).toBe(chip.name);
      }
      await expectNoFiller(page);
      await expectGeometry(page);
      await capture(page, testInfo, `results-${colorScheme}-${width}`);

      fixture.state.authenticated = false;
      await page.goto(`${origin}/join?code=${joinCode}`);
      await expect(page.getByRole("heading", { name: "Join game", exact: true })).toHaveCount(1);
      await expect(page.getByLabel("Player name", { exact: true })).toBeVisible();
      await expect(page.getByText("Use the name the scorekeeper expects.", { exact: true })).toBeVisible();
      await page.getByLabel("Player name", { exact: true }).fill(nickname);
      await page.getByLabel("Player name", { exact: true }).press("Enter");
      await expect(page.locator("#join-result-player")).toHaveText(nickname);
      await expect(page.locator("#join-signin-link")).toBeVisible();
      await expect(page.locator("#join-result-game")).toBeHidden();
      await expectJoinReceipt(page);
      await expectNoFiller(page);
      await expectGeometry(page);
      await capture(page, testInfo, `joined-${colorScheme}-${width}`);

      fixture.state.authenticated = true;
      await page.goto(`${origin}/invites?code=${inviteCode}`);
      await expect(page.getByRole("heading", { name: "Organiser invite", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Accept invite", exact: true })).toBeEnabled();
      await expect(page.locator("#organiser-invite-league-link")).toBeHidden();
      await expect(page.locator("body")).not.toContainText("Pending");
      await expectNoFiller(page);
      await expectGeometry(page);
      await capture(page, testInfo, `invite-${colorScheme}-${width}`);

      fixture.state.authenticated = false;
      await page.goto(`${origin}/sign-in`);
      await expect(page.getByRole("heading", { name: "Sign in to 3FC", exact: true })).toBeVisible();
      await page.getByLabel("Email address", { exact: true }).fill(recipient);
      await page.getByLabel("Email address", { exact: true }).press("Enter");
      await expect(page.locator("#auth-status")).toContainText(recipient);
      await expect(page.getByRole("button", { name: "Send sign-in link", exact: true })).toBeEnabled();
      await expectNoFiller(page);
      await expectGeometry(page);
      await capture(page, testInfo, `sign-in-sent-${colorScheme}-${width}`);

      await page.goto(`${origin}/auth/callback`);
      await expect(page.locator("#auth-callback-error")).toBeVisible();
      await expect(page.locator("#auth-callback-recovery")).toBeVisible();
      await expectCallbackCopyHidden(page);
      await expectGeometry(page);
      await capture(page, testInfo, `callback-incomplete-${colorScheme}-${width}`);
      expectClean(fixture);
    });
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [390, 768]) {
    test(`results and entry simulated CSS zoom 200 ${colorScheme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const fixture = await installFixture(page);
      await openResults(page);
      await openFullLog(page);
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      await expectGeometry(page);
      await expectMatchHeadingWordsFit(page);
      await expectResultLabelsFit(page);
      await capture(page, testInfo, `results-simulated-css-zoom-200-${colorScheme}-${width}`);
      fixture.state.authenticated = false;
      await page.goto(`${origin}/join?code=${joinCode}`);
      await page.getByLabel("Player name", { exact: true }).fill(nickname);
      await page.getByLabel("Player name", { exact: true }).press("Enter");
      await expect(page.locator("#join-signin-link")).toBeVisible();
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      await expectJoinReceipt(page);
      await expectGeometry(page);
      await capture(page, testInfo, `joined-simulated-css-zoom-200-${colorScheme}-${width}`);
      await page.goto(`${origin}/sign-in`);
      await page.getByLabel("Email address", { exact: true }).fill(recipient);
      await page.getByLabel("Email address", { exact: true }).press("Enter");
      await expect(page.locator("#auth-status")).toContainText(recipient);
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      await expectGeometry(page);
      await capture(page, testInfo, `entry-simulated-css-zoom-200-${colorScheme}-${width}`);
      expectClean(fixture);
    });
  }
  test(`results short landscape and keyboard correction ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.emulateMedia({ colorScheme });
    const fixture = await installFixture(page);
    await openResults(page);
    await openFullLog(page);
    await expectGeometry(page);
    await capture(page, testInfo, `results-landscape-${colorScheme}`);
    const correct = page.getByRole("button", { name: "Correct result", exact: true });
    await correct.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("game-mode-run")).toBeVisible();
    await expect(page.locator("#goal-form")).toBeVisible();
    await expect(page).toHaveURL(/#score$/);
    expect(fixture.writes()).toEqual([]);
    expectClean(fixture);
  });
}

for (const result of ["tiebreak", "two-draw", "draw", "zero"] as const) {
  test(`stored result ${result} is reported without inventing a new calculation`, async ({ page }) => {
    const fixture = await installFixture(page, { result });
    await openResults(page);
    await expect(page.getByTestId("game-result-outcome")).toHaveText(result === "tiebreak" ? "Red win" : "Draw");
    for (const team of fixture.game.result.teams) {
      const row = page.locator(`[data-ui="result-team"][data-team-id="${team.teamId}"]`);
      await expect(row.locator("dt")).toHaveText(["Conceded", "Scored"]);
      await expect(row.locator("dd")).toHaveText([String(team.conceded), String(team.scored)]);
    }
    const log = await openFullLog(page);
    if (result === "zero") {
      await expect(log).toContainText("No goals recorded.");
      await expect(page.getByTestId("final-own-goal-stats")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("final-scorer-stats").getByText("Sam", { exact: true })).toHaveCount(2);
      await expect(page.getByTestId("final-own-goal-stats")).toContainText(fixture.players[13].nickname);
      await expect(page.getByTestId("final-scorer-stats")).not.toContainText(fixture.players[13].nickname);
      await expect(log).toContainText(fixture.players[18].nickname);
    }
    expectClean(fixture);
  });
}

for (const result of ["bad-count", "bad-winner", "duplicate", "missing"] as const) {
  test(`malformed stored ${result} is unavailable rather than a zero or draw`, async ({ page }) => {
    const fixture = await installFixture(page, { result });
    await openResults(page);
    await expect(page.getByTestId("result-unavailable")).toBeVisible();
    await expect(page.getByTestId("game-result-outcome")).toHaveCount(0);
    await expect(page.locator("#game-result-summary")).not.toContainText("Draw");
    expectClean(fixture);
  });
}

for (const log of ["unavailable", "missing", "null-row", "duplicate", "cross-game"] as const) {
  test(`independently valid totals survive ${log} log without fabricated contributions`, async ({ page }) => {
    const fixture = await installFixture(page, { log });
    await openResults(page);
    await expect(page.getByTestId("game-result-outcome")).toHaveText("Red win");
    await expect(page.locator('[data-ui="result-team"]')).toHaveCount(3);
    await expect(page.getByTestId("final-goal-summary-unavailable")).toBeVisible();
    await expect(page.locator("#setup-error"), "The Results partial-data outcome is not duplicated globally").toBeHidden();
    await expect(page.getByTestId("final-aggregate-stats")).toHaveCount(0);
    await expect(page.getByTestId("final-full-goal-log")).toHaveCount(0);
    await expect(page.locator("#game-result-summary")).not.toContainText(/No goals recorded|No scorers recorded|No assists recorded/);
    expectClean(fixture);
  });
}

test("ACL viewer reads results without operator lookup or correction affordance", async ({ page }) => {
  const fixture = await installFixture(page, { role: "viewer" });
  await openResults(page);
  await expect(page.getByTestId("game-result-outcome")).toHaveText("Red win");
  await expect(page.getByRole("button", { name: "Correct result", exact: true })).toBeHidden();
  await openFullLog(page);
  expect(fixture.requests.some(request => request.path === `${apiPath}/players`)).toBe(false);
  expect(fixture.writes()).toEqual([]);
  expectClean(fixture);
});

test("missing join context offers recovery without a functioning blank-code submission", async ({ page }) => {
  const fixture = await installFixture(page, { authenticated: false });
  await page.goto(`${origin}/join`);
  await expect(page.locator("#setup-error")).toBeVisible();
  await expect(page.locator("#setup-error")).toContainText(/organiser|join link/i);
  const join = page.locator('[data-action="join-game"]');
  expect(await join.isVisible() && await join.isEnabled()).toBe(false);
  expect(fixture.writes()).toEqual([]);
  expectClean(fixture);
});

for (const malformed of [false, true]) {
  test(`join ${malformed ? "malformed successful response" : "lost response"} retries original proof-bound identity`, async ({ page }) => {
    const fixture = await installFixture(page, { authenticated: false });
    const gate = deferred();
    fixture.plans.push({ kind: "join", gate, commit: true, ...(malformed ? { malformed: true } : { status: 503 }) });
    await page.goto(`${origin}/join?code=${joinCode}`);
    await page.getByLabel("Player name", { exact: true }).fill(nickname);
    await page.getByLabel("Player name", { exact: true }).press("Enter");
    await expect(page.locator('[data-action="join-game"]')).toBeDisabled();
    await expect.poll(() => fixture.writes("join").length).toBe(1);
    await page.locator("#join-game-form").evaluate(form => { (form as HTMLFormElement).requestSubmit(); });
    expect(fixture.writes("join")).toHaveLength(1);
    gate.release();
    await expect(page.getByRole("button", { name: "Retry join", exact: true })).toBeEnabled();
    await expect(page.locator("#setup-error")).toContainText(/could not be confirmed/i);
    await expect(page.locator("#join-player-nickname")).toBeDisabled();
    // A changed DOM value is adversarial script input, not a second authorised draft.
    await page.locator("#join-player-nickname").evaluate(input => { (input as HTMLInputElement).value = "Changed draft must not be sent"; });
    await page.getByRole("button", { name: "Retry join", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#join-result-player")).toHaveText(nickname);
    expect(fixture.state.joined).toBe(1);
    expect(fixture.writes("join")).toHaveLength(2);
    expect(fixture.writes("join")[1].serialized).toBe(fixture.writes("join")[0].serialized);
    expect(fixture.writes("join")[1].key).toBe(fixture.writes("join")[0].key);
    expect(fixture.writes("claim")).toHaveLength(0);
    expectClean(fixture);
  });
}

test("confirmed join survives claim failure and retry only claims that player", async ({ page }) => {
  const fixture = await installFixture(page);
  fixture.plans.push({ kind: "claim", status: 503 });
  await page.goto(`${origin}/join?code=${joinCode}`);
  await page.getByRole("button", { name: "Create new player", exact: true }).click();
  await page.getByLabel("Player name", { exact: true }).fill(nickname);
  await page.getByLabel("Player name", { exact: true }).press("Enter");
  await expect(page.locator("#join-result-player")).toHaveText(nickname);
  await expect(page.locator('[data-action="join-game"]')).toBeDisabled();
  expect(fixture.writes("claim")).toHaveLength(0);
  const claim = page.locator('[data-action="claim-player"]');
  await expect(claim).toBeEnabled();
  await claim.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#player-link-name")).toHaveText(nickname);
  await expect(page.locator("#player-link-account")).toHaveText(recipient);
  expect(fixture.writes("claim")).toHaveLength(0);
  const confirm = page.locator("#player-link-confirm");
  await confirm.click();
  await expect(page.locator("#player-link-status")).toContainText("Linking could not be confirmed.");
  await expect(confirm).toBeEnabled();
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#player-link-status")).toHaveText(`Player linked to ${recipient}.`);
  expect(fixture.writes("join")).toHaveLength(1);
  expect(fixture.writes("claim")).toHaveLength(2);
  expect(fixture.writes("claim")[1].path).toBe(fixture.writes("claim")[0].path);
  expect(fixture.writes("claim")[0].query).toBe("?playerId=fictional-joined-player-1");
  expect(fixture.writes("claim")[1].query).toBe(fixture.writes("claim")[0].query);
  expect(fixture.writes("claim")[0].privateBodyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(fixture.writes("claim")[1].privateBodyFingerprint).toBe(fixture.writes("claim")[0].privateBodyFingerprint);
  expect(fixture.writes("claim").every(request => request.body === null && request.serialized === null)).toBe(true);
  await expectNoFiller(page);
  expectClean(fixture);
});

test("blocked proof storage prevents a new anonymous registration", async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) Object.defineProperty(Storage.prototype, method, {
      configurable: true, value() { throw new DOMException("Fictional blocked storage", "SecurityError"); },
    });
  });
  const fixture = await installFixture(page, { authenticated: false });
  await page.goto(`${origin}/join?code=${joinCode}`);
  await page.getByLabel("Player name", { exact: true }).fill(nickname);
  await page.getByLabel("Player name", { exact: true }).press("Enter");
  await expect(page.locator("#setup-error")).toContainText(/storage|save|browser/i);
  expect(fixture.writes("join")).toHaveLength(0);
  expect(fixture.writes("claim")).toHaveLength(0);
  expectClean(fixture);
});

test("unknown sign-in state does not expose an anonymous join form", async ({ page }) => {
  const fixture = await installFixture(page);
  await page.route(`${origin}/v1/auth/session`, route => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  await page.goto(`${origin}/join?code=${joinCode}`);
  await expect(page.getByLabel("Player name", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(fixture.writes()).toHaveLength(0);
  expectClean(fixture);
});

for (const { status, code } of [
  { status: 400, code: "invalid_claim_proof" },
  { status: 403, code: "account_changed" },
  { status: 404, code: "claim_proof_unavailable" },
  { status: 409, code: "claim_profile_changed" },
]) {
  test(`private proof preview rejection ${status} never enables account linking`, async ({ page }) => {
    const fixture = await installFixture(page);
    await page.goto(`${origin}/join?code=${joinCode}`);
    await page.getByRole("button", { name: "Create new player", exact: true }).click();
    await page.getByLabel("Player name", { exact: true }).fill(nickname);
    await page.getByLabel("Player name", { exact: true }).press("Enter");
    await expect(page.getByTestId("claim-player")).toBeEnabled();
    fixture.plans.push({ kind: "preview", status, code });
    await page.getByTestId("claim-player").click();
    await expect(page.locator("#player-link-status")).toHaveAttribute("role", "alert");
    await expect(page.locator("#player-link-confirm")).toBeHidden();
    await expect(page.locator("#player-link-details")).toBeHidden();
    if (status !== 403) {
      await expect(page.locator("#player-link-status")).toHaveText("This player link is no longer available. Ask the organiser for a new link.");
      await expect(page.locator("#player-link-retry")).toBeHidden();
    }
    expect(fixture.writes("claim")).toHaveLength(0);
    expect(fixture.writes("preview")).toHaveLength(1);
    expect(fixture.writes("preview")[0].body).toBeNull();
    expectClean(fixture);
  });
}

test("anonymous proof survives same-tab sign-in and still requires named account confirmation", async ({ page }) => {
  const fixture = await installFixture(page, { authenticated: false });
  await page.goto(`${origin}/join?code=${joinCode}`);
  await page.getByLabel("Player name", { exact: true }).fill(nickname);
  await page.getByLabel("Player name", { exact: true }).press("Enter");
  const signIn = page.getByTestId("join-signin-link");
  await expect(signIn).toBeVisible();
  const signInUrl = new URL(await signIn.getAttribute("href") ?? "", origin);
  const returnPath = signInUrl.searchParams.get("returnTo")!;
  expect(new URL(returnPath, origin).pathname).toBe("/link-player");
  expect([...new URL(returnPath, origin).searchParams.keys()]).toEqual(["proofId"]);
  await signIn.click();
  await page.getByLabel("Email address", { exact: true }).fill(recipient);
  await page.getByRole("button", { name: "Send sign-in link", exact: true }).click();
  await expect(page.locator("#auth-status")).toContainText(recipient);
  await page.goto(`${origin}/auth/callback?token=fictional-unusable-proof-handoff&returnTo=${encodeURIComponent(returnPath)}`);
  await page.getByTestId("complete-magic-link").click();
  await expect(page.locator("#player-link-name")).toHaveText(nickname);
  await expect(page.locator("#player-link-account")).toHaveText(recipient);
  expect(fixture.writes("claim")).toHaveLength(0);
  const confirm = page.locator("#player-link-confirm");
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#player-link-status")).toHaveText(`Player linked to ${recipient}.`);
  expect(fixture.writes("join")).toHaveLength(1);
  expect(fixture.writes("claim")).toHaveLength(1);
  expectClean(fixture);
});

test("an explicit new join after confirmation creates a distinct player even with the same name", async ({ page }) => {
  const fixture = await installFixture(page, { authenticated: false });
  await page.goto(`${origin}/join?code=${joinCode}`);
  await page.getByLabel("Player name", { exact: true }).fill(nickname);
  await page.getByLabel("Player name", { exact: true }).press("Enter");
  await expect(page.locator("#join-signin-link")).toBeVisible();
  await page.getByRole("button", { name: "Join another player", exact: true }).click();
  const name = page.getByLabel("Player name", { exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("");
  await name.fill(nickname);
  await name.press("Enter");
  await expect(page.locator("#join-signin-link")).toBeVisible();
  expect(fixture.state.joined).toBe(2);
  expect(fixture.writes("join")).toHaveLength(2);
  expect(fixture.writes("join")[1].key).not.toBe(fixture.writes("join")[0].key);
  expect(fixture.writes("claim")).toHaveLength(0);
  expectClean(fixture);
});

for (const width of [320, 390]) {
  test(`proofless claim-return names the verified player and requires private recovery ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 320 ? "light" : "dark" });
    const fixture = await installFixture(page);
    await page.goto(`${origin}/join?code=${joinCode}&playerId=fictional-existing-player`);
    const claim = page.getByTestId("claim-player");
    await expect(claim).toBeHidden();
    await expect(page.locator("#join-result-player")).toHaveText(nickname);
    await expect(page.locator("#join-claim-status")).toContainText("Ask the organiser for a private link");
    await expectJoinReceipt(page);
    await expectGeometry(page);
    expect(fixture.requests.filter(request => request.path === joinContextPath && request.query === "?playerId=fictional-existing-player")).toHaveLength(1);
    expect(fixture.writes()).toHaveLength(0);
    await capture(page, testInfo, `claim-proofless-recovery-${width}`);
    expectClean(fixture);
  });
}

for (const identity of [
  { label: "slash", playerId: "fictional/linked-player", otherId: "fictional%2Flinked-player", width: 320, theme: "light" },
  { label: "literal percent", playerId: "fictional%linked-player", otherId: "fictional-linked-player", width: 390, theme: "dark" },
  { label: "percent-encoded text and query delimiters", playerId: "fictional%2Flinked+player?team=red&name=#1", otherId: "fictional/linked+player?team=red&name=#1", width: 390, theme: "dark" },
] as const) {
  test(`claim context query preserves ${identity.label} identity without a write`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: identity.width, height: 900 });
    await page.emulateMedia({ colorScheme: identity.theme });
    const fixture = await installFixture(page, { contextPlayers: [
      { playerId: identity.playerId, nickname },
      { playerId: identity.otherId, nickname: "Different existing player" },
    ] });
    const entryQuery = new URLSearchParams({ code: joinCode, playerId: identity.playerId });
    await page.goto(`${origin}/join?${entryQuery.toString()}`);
    const claim = page.getByTestId("claim-player");
    await expect(claim).toBeHidden();
    await expect(page.locator("#join-result-player")).toBeVisible();
    await expect(page.locator("#join-result-player")).toHaveText(nickname);
    await expect(page.locator("#join-claim-status")).toContainText("Ask the organiser for a private link");
    await expect(page.locator("body")).not.toContainText("Different existing player");
    await expect(page.getByRole("button", { name: "Retry lookup", exact: true })).toBeHidden();
    const reads = fixture.requests.filter(request => request.method === "GET" && request.path.startsWith(`/v1/join/${joinCode}/`));
    expect(reads).toHaveLength(1);
    expect(reads[0].path).toBe(joinContextPath);
    expect(reads[0].query).toBe(`?${new URLSearchParams({ playerId: identity.playerId }).toString()}`);
    expect(new URLSearchParams(reads[0].query).getAll("playerId")).toEqual([identity.playerId]);
    expect(fixture.writes()).toHaveLength(0);
    await expectJoinReceipt(page);
    await expectGeometry(page);
    await page.getByRole("button", { name: "Join another player", exact: true }).focus();
    await capture(page, testInfo, `claim-query-identity-${identity.label.replaceAll(" ", "-")}-${identity.width}`);
    await expect(page.getByRole("button", { name: "Join another player", exact: true })).toBeFocused();
    expect(fixture.writes()).toHaveLength(0);
    expectClean(fixture);
  });
}

test("duplicate nicknames and a forged query name do not change the exact claim target", async ({ page }) => {
  const fixture = await installFixture(page);
  const duplicate = fixture.players[7];
  expect(duplicate.nickname).toBe(fixture.players[1].nickname);
  await page.goto(`${origin}/join?code=${joinCode}&playerId=${duplicate.playerId}&nickname=Forged%20name`);
  const claim = page.getByTestId("claim-player");
  await expect(claim).toBeHidden();
  await expect(page.locator("#join-result-player")).toHaveText("Sam");
  await expect(page.locator("body")).not.toContainText("Forged name");
  await expect(page.locator("#join-claim-status")).toContainText("Ask the organiser for a private link");
  await claim.dispatchEvent("click");
  expect(fixture.writes()).toHaveLength(0);
  expectClean(fixture);
});

test("sign-in return resolves the named claim context without automatically claiming it", async ({ page }) => {
  const fixture = await installFixture(page, { authenticated: false });
  const returnPath = `/join?code=${joinCode}&playerId=fictional-existing-player`;
  await page.goto(`${origin}${returnPath}`);
  await expect(page.locator("#join-result")).toBeHidden();
  await page.goto(`${origin}/sign-in?returnTo=${encodeURIComponent(returnPath)}`);
  await expect(page.getByRole("heading", { name: "Sign in to 3FC", exact: true })).toBeVisible();
  await page.getByLabel("Email address", { exact: true }).fill(recipient);
  await page.getByRole("button", { name: "Send sign-in link", exact: true }).click();
  await expect(page.locator("#auth-status")).toContainText(recipient);
  await page.goto(`${origin}/auth/callback?token=fictional-unused-context-token&returnTo=${encodeURIComponent(returnPath)}`);
  await page.getByTestId("complete-magic-link").click();
  await expect(page).toHaveURL(`${origin}${returnPath}`);
  await expect(page.locator("#join-result-player")).toHaveText(nickname);
  await expect(page.getByTestId("claim-player")).toBeHidden();
  await expect(page.locator("#join-claim-status")).toContainText("Ask the organiser for a private link");
  expect(fixture.writes("magic")).toHaveLength(1);
  expect(fixture.writes("complete")).toHaveLength(1);
  expect(fixture.writes("claim")).toHaveLength(0);
  expect(fixture.writes("join")).toHaveLength(0);
  expectClean(fixture);
});

test("a failed identity lookup retries only the read before showing named proof recovery", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installFixture(page);
  fixture.lookupPlans.push({ status: 503 }, { status: 503 });
  await page.goto(`${origin}/join?code=${joinCode}&playerId=fictional-existing-player`);
  const retry = page.getByRole("button", { name: "Retry lookup", exact: true });
  await expect(page.locator("#setup-error")).toHaveText("The player details couldn’t be loaded. Retry lookup or sign in again.");
  await expect(page.getByTestId("claim-player")).toBeDisabled();
  await expect(page.locator("#join-result")).toBeHidden();
  await expect(retry).toBeEnabled();
  await expect(page.getByTestId("join-signin-link")).toBeVisible();
  await expectGeometry(page);
  await capture(page, testInfo, "claim-lookup-retry-dark-320");
  expect(fixture.writes()).toHaveLength(0);
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(retry).toBeFocused();
  await expect(retry).toBeEnabled();
  await expect(page.getByTestId("claim-player")).toBeDisabled();
  expect(fixture.writes()).toHaveLength(0);
  await page.keyboard.press("Enter");
  await expect(page.locator("#join-result-player")).toHaveText(nickname);
  await expect(page.getByTestId("claim-player")).toBeHidden();
  await expect(retry).toBeHidden();
  await expect(page.getByRole("button", { name: "Join another player", exact: true })).toBeFocused();
  await expect(page.locator("#setup-error")).toBeHidden();
  expect(fixture.requests.filter(request => request.path === joinContextPath && request.query === "?playerId=fictional-existing-player")).toHaveLength(3);
  expect(fixture.writes()).toHaveLength(0);
  expectClean(fixture);
});

for (const invalid of ["missing player", "different player", "different code", "malformed player"] as const) {
  test(`claim lookup ${invalid} cannot expose an unverified identity or enable a write`, async ({ page }) => {
    const fixture = await installFixture(page);
    const playerId = invalid === "missing player" ? "fictional-other-game-player" : "fictional-existing-player";
    if (invalid !== "missing player") fixture.lookupPlans.push({ payload: {
      gameId, joinCode: invalid === "different code" ? "23456789" : joinCode,
      player: { playerId: invalid === "different player" ? "fictional-unrequested-player" : playerId,
        nickname: invalid === "malformed player" ? null : "Unverified name", createdAt: now, updatedAt: now },
    } });
    await page.goto(`${origin}/join?code=${joinCode}&playerId=${playerId}`);
    await expect(page.locator("#setup-error")).toHaveText(invalid === "missing player"
      ? "This player couldn’t be found for this join link. Ask the organiser for help."
      : "The player details couldn’t be loaded. Retry lookup or sign in again.");
    await expect(page.locator("#join-result")).toBeHidden();
    await expect(page.getByTestId("claim-player")).toBeDisabled();
    await expect(page.locator("body")).not.toContainText("Unverified name");
    await page.getByTestId("claim-player").dispatchEvent("click");
    expect(fixture.writes()).toHaveLength(0);
    expectClean(fixture);
  });
}

test("Join another player cancels a delayed lookup without replacing its new draft or focus", async ({ page }) => {
  const fixture = await installFixture(page);
  const gate = deferred();
  fixture.lookupPlans.push({ gate });
  try {
    const lookupPath = joinContextPath;
    await page.goto(`${origin}/join?code=${joinCode}&playerId=fictional-existing-player`);
    await expect.poll(() => fixture.requests.filter(request => request.path === lookupPath && request.query === "?playerId=fictional-existing-player").length).toBe(1);
    await expect(page.locator("#join-result")).toBeHidden();
    await expect(page.getByTestId("claim-player")).toBeDisabled();
    await page.getByRole("button", { name: "Join another player", exact: true }).click();
    const input = page.getByLabel("Player name", { exact: true });
    await expect(input).toBeFocused();
    await input.fill("Keep this new player draft");
    const response = page.waitForResponse(candidate => {
      const url = new URL(candidate.url());
      return url.pathname === lookupPath && url.search === "?playerId=fictional-existing-player";
    });
    gate.release();
    await (await response).finished();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keep this new player draft");
    await expect(page.locator("#join-result")).toBeHidden();
    await expect(page.locator("#join-claim-actions")).toBeHidden();
    await expect(page.getByRole("button", { name: "Join game", exact: true })).toBeEnabled();
    expect(fixture.writes()).toHaveLength(0);
    expectClean(fixture);
  } finally { gate.release(); }
});

test("an old lookup cannot replace a new confirmed join awaiting explicit linking", async ({ page }) => {
  const fixture = await installFixture(page);
  const lookupGate = deferred();
  fixture.lookupPlans.push({ gate: lookupGate });
  try {
    await page.goto(`${origin}/join?code=${joinCode}&playerId=fictional-existing-player`);
    await expect.poll(() => fixture.requests.filter(request => request.path === joinContextPath).length).toBe(1);
    await page.getByRole("button", { name: "Join another player", exact: true }).click();
    await page.getByLabel("Player name", { exact: true }).fill("A different new player");
    await page.getByLabel("Player name", { exact: true }).press("Enter");
    await expect(page.locator("#join-result-player")).toHaveText("A different new player");
    const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname === joinContextPath);
    lookupGate.release();
    await (await response).finished();
    await expect(page.locator("#join-result-player")).toHaveText("A different new player");
    await expect(page.getByTestId("claim-player")).toBeEnabled();
    await expect(page.getByTestId("claim-player")).toHaveText("Link player profile");
    expect(fixture.writes("join")).toHaveLength(1);
    expect(fixture.writes("claim")).toHaveLength(0);
    expectClean(fixture);
  } finally { lookupGate.release(); }
});

test("malformed invite reveals and focuses native code correction", async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto(`${origin}/invites?code=bad`);
  const input = page.getByLabel("Invite code", { exact: true });
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.fill(inviteCode);
  await input.press("Enter");
  await expect(page).toHaveURL(`${origin}/invites?code=${inviteCode}`);
  await expect(page.getByRole("button", { name: "Accept invite", exact: true })).toBeEnabled();
  expect(fixture.writes()).toHaveLength(0);
  expectClean(fixture);
});

for (const rejection of [
  { status: 403, code: "invite_email_mismatch", message: "This organiser invite was issued for a different email address.", visible: "This invite is for a different email address. Sign out and use the email it was sent to." },
  { status: 404, message: "Invite not found.", visible: "This invite could not be found. Check the code or ask the organiser for another invite." },
  { status: 409, code: "invite_already_accepted", message: "This organiser invite has already been accepted.", visible: "This invite has already been used. Ask the organiser for another invite." },
]) {
  test(`invite contract rejection ${rejection.status} has no invented league or expiry`, async ({ page }) => {
    const fixture = await installFixture(page);
    fixture.plans.push({ kind: "invite", ...rejection });
    await page.goto(`${origin}/invites?code=${inviteCode}`);
    await page.getByRole("button", { name: "Accept invite", exact: true }).click();
    await expect(page.locator("#setup-error")).toContainText(rejection.visible);
    await expect(page.locator("#organiser-invite-league-link")).toBeHidden();
    await expect(page.locator("body")).not.toContainText(/expired|Pending|fictional-results-league/i);
    expect(fixture.state.accepted).toBe(0);
    expectClean(fixture);
  });
}

test("invite pending latch and uncertain same-code retry reach only the returned league", async ({ page }) => {
  const fixture = await installFixture(page);
  const gate = deferred();
  fixture.plans.push({ kind: "invite", gate, commit: true, status: 503 });
  await page.goto(`${origin}/invites?code=${inviteCode}`);
  const accept = page.locator('[data-action="accept-organiser-invite"]');
  await accept.focus();
  await page.keyboard.press("Enter");
  await expect(accept).toBeDisabled();
  await expect.poll(() => fixture.writes("invite").length).toBe(1);
  await accept.dispatchEvent("click");
  expect(fixture.writes("invite")).toHaveLength(1);
  gate.release();
  await expect(page.getByRole("button", { name: "Retry invite", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Retry invite", exact: true })).toBeFocused();
  await expect(page.locator("#setup-error")).toContainText(/could not be confirmed/i);
  await expect(page.locator("#organiser-invite-league-link")).toBeHidden();
  await page.getByRole("button", { name: "Retry invite", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open league", exact: true })).toHaveAttribute("href", `/leagues/${leagueId}`);
  await expect(page.getByRole("link", { name: "Open league", exact: true })).toBeFocused();
  expect(fixture.writes("invite")).toHaveLength(2);
  expect(fixture.writes("invite")[0].path).toBe(fixture.writes("invite")[1].path);
  expectClean(fixture);
});

for (const acceptedLeague of [
  { kind: "backslash", id: "fictional\\community-league", label: "Open league", status: "Organiser invite accepted." },
  { kind: "dot segment", id: "..", label: "Go to Home", status: "Organiser invite accepted. Go to Home to continue." },
]) {
  test(`accepted invite with ${acceptedLeague.kind} identity stays confirmed without another write`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ colorScheme: "dark" });
    const fixture = await installFixture(page, { inviteLeagueId: acceptedLeague.id });
    await page.goto(`${origin}/invites?code=${inviteCode}`);
    const accept = page.locator('[data-action="accept-organiser-invite"]');
    await accept.focus();
    await page.keyboard.press("Enter");
    const continuation = page.locator("#organiser-invite-league-link");
    const expectedPath = acceptedLeague.kind === "backslash" ? `/leagues/${encodeURIComponent(acceptedLeague.id)}` : "/setup";
    await expect(page.locator("#setup-status")).toHaveText(acceptedLeague.status);
    await expect(page.locator("#setup-error")).toBeHidden();
    await expect(continuation).toHaveText(acceptedLeague.label);
    await expect(continuation).toHaveAttribute("href", expectedPath);
    await expect(continuation).toBeFocused();
    // Check the browser-resolved destination as well as the raw attribute:
    // an opaque backslash must not become a path separator or external origin.
    const destination = new URL(await continuation.evaluate(element => (element as HTMLAnchorElement).href));
    expect(destination.origin).toBe(origin);
    expect(destination.pathname).toBe(expectedPath);
    expect(destination.search).toBe("");
    expect(destination.hash).toBe("");
    if (acceptedLeague.kind === "backslash") {
      expect(destination.pathname).toContain("%5C");
      expect(decodeURIComponent(destination.pathname.slice("/leagues/".length))).toBe(acceptedLeague.id);
    }
    await expect(accept).toBeHidden();
    await expect(accept).toBeDisabled();
    await expect(page.getByRole("button", { name: "Retry invite", exact: true })).toHaveCount(0);
    await accept.dispatchEvent("click");
    expect(fixture.state.accepted).toBe(1);
    expect(fixture.writes("invite")).toHaveLength(1);
    await expectGeometry(page);
    await capture(page, testInfo, `invite-accepted-${acceptedLeague.kind.replaceAll(" ", "-")}-dark-320`);
    expectClean(fixture);
  });
}

test("account switching retains reconstructed entry context without copying credential-like fields", async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto(`${origin}/join?code=${joinCode}&playerId=fictional-existing-player&token=fictional-unusable&returnTo=https%3A%2F%2Foutside.invalid&unknown=discard#discard`);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to 3FC", exact: true })).toBeVisible();
  const url = new URL(page.url());
  expect(url.pathname).toBe("/sign-in");
  const returnTo = new URL(url.searchParams.get("returnTo")!, origin);
  expect(returnTo.pathname).toBe("/join");
  expect([...returnTo.searchParams.entries()].sort()).toEqual([["code", joinCode], ["playerId", "fictional-existing-player"]]);
  expect(returnTo.hash).toBe("");
  expect(page.url()).not.toContain("fictional-unusable");
  expect(fixture.writes("logout")).toHaveLength(1);
  expectClean(fixture);
});

test("late anonymous session probe cannot erase captured sign-in recipient or pending ownership", async ({ page }) => {
  const sessionGate = deferred();
  const sendGate = deferred();
  const fixture = await installFixture(page, { authenticated: false, sessionGate });
  fixture.plans.push({ kind: "magic", gate: sendGate });
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Email address", { exact: true }).fill(recipient);
  await page.getByLabel("Email address", { exact: true }).press("Enter");
  await expect(page.getByTestId("send-magic-link")).toBeDisabled();
  await expect.poll(() => fixture.writes("magic").length).toBe(1);
  await page.locator("#auth-magic-form").evaluate(form => { (form as HTMLFormElement).requestSubmit(); });
  expect(fixture.writes("magic")).toHaveLength(1);
  await page.locator("#auth-email").evaluate(input => { (input as HTMLInputElement).value = "edited-address@example.com"; });
  const sessionResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/auth/session");
  sessionGate.release();
  await (await sessionResponse).finished();
  await expect(page.locator("#auth-status")).toContainText(/Sending/i);
  sendGate.release();
  await expect(page.locator("#auth-status")).toContainText(recipient);
  await expect(page.locator("#auth-status")).not.toContainText("edited-address@example.com");
  await expect(page.locator("#auth-error")).toBeHidden();
  expect(fixture.writes("magic")[0].body?.email).toBe(recipient);
  expectClean(fixture);
});

test("native email validation and uncertain send preserve a recoverable recipient", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await installFixture(page, { authenticated: false });
  fixture.plans.push({ kind: "magic", status: 503 });
  await page.goto(`${origin}/sign-in`);
  const email = page.getByLabel("Email address", { exact: true });
  await email.fill("not-an-email");
  await email.press("Enter");
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#auth-email-notice")).toHaveText("Enter a valid email address.");
  expect(fixture.writes("magic")).toHaveLength(0);
  await email.fill(recipient);
  await email.press("Enter");
  await expect(page.locator("#auth-error")).toHaveText("We couldn't confirm the email was sent. Check your inbox before trying again.");
  await expect(page.locator("#auth-status")).toBeHidden();
  await expect(email).toHaveValue(recipient);
  await expect(page.getByRole("button", { name: "Send sign-in link", exact: true })).toBeEnabled();
  await expectGeometry(page);
  await capture(page, testInfo, "sign-in-send-unconfirmed-dark-320");
  expect(fixture.writes("magic")).toHaveLength(1);
  expectClean(fixture);
});

test("late authenticated session redirect cannot take over a newer sign-in submission", async ({ page }) => {
  await installPausedClock(page);
  const sessionGate = deferred();
  const fixture = await installFixture(page, { sessionGate });
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Email address", { exact: true }).fill(recipient);
  await page.getByLabel("Email address", { exact: true }).press("Enter");
  await expect(page.locator("#auth-status")).toContainText(recipient);
  const sessionResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/auth/session");
  sessionGate.release();
  await (await sessionResponse).finished();
  await page.clock.runFor(1000);
  await expect(page).toHaveURL(`${origin}/sign-in`);
  await expect(page.locator("#auth-status")).toContainText(recipient);
  expect(fixture.writes("magic")).toHaveLength(1);
  expectClean(fixture);
});

for (const manual of [false, true]) {
  test(`magic-link ${manual ? "manual" : "three-second automatic"} completion scrubs and submits once`, async ({ page }) => {
    await installPausedClock(page);
    const fixture = await installFixture(page, { authenticated: false });
    const gate = deferred();
    fixture.plans.push({ kind: "complete", gate });
    // Explicitly non-credential fixture string. Never use a real magic link here.
    await page.goto(`${origin}/auth/callback?token=fictional-no-authority-token&returnTo=${encodeURIComponent(`/join?code=${joinCode}`)}`);
    await expect(page).toHaveURL(`${origin}/auth/callback`);
    const complete = page.getByTestId("complete-magic-link");
    await expect(complete).toBeEnabled();
    await expect(page.locator("#auth-callback-copy")).toBeVisible();
    await page.clock.runFor(2999);
    expect(fixture.writes("complete")).toHaveLength(0);
    if (manual) { await complete.focus(); await page.keyboard.press("Enter"); }
    else await page.clock.runFor(1);
    await expect(complete).toBeDisabled();
    await expectCallbackCopyHidden(page);
    await expect.poll(() => fixture.writes("complete").length).toBe(1);
    await page.clock.runFor(4000);
    await complete.dispatchEvent("click");
    expect(fixture.writes("complete")).toHaveLength(1);
    gate.release();
    await expect(page).toHaveURL(`${origin}/join?code=${joinCode}`);
    await expect(page.getByRole("heading", { name: "Join game", exact: true })).toBeVisible();
    expectClean(fixture);
  });
}

for (const status of [503, 401]) {
  test(`callback ${status === 503 ? "transient retry" : "expired recovery"} removes imminent-redirect copy`, async ({ page }) => {
    await installPausedClock(page);
    const fixture = await installFixture(page, { authenticated: false });
    fixture.plans.push({ kind: "complete", status });
    await page.goto(`${origin}/auth/callback?token=fictional-no-authority-token`);
    await expect(page).toHaveURL(`${origin}/auth/callback`);
    await page.clock.runFor(3000);
    await expect(page.locator("#auth-callback-error")).toBeVisible();
    await expectCallbackCopyHidden(page);
    await expect(page.locator("#auth-callback-recovery")).toBeVisible();
    if (status === 401) {
      await expect(page.getByTestId("complete-magic-link")).toBeHidden();
      await expect(page.locator("#auth-callback-recovery")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Sign in to 3FC", exact: true })).toBeVisible();
    } else {
      const complete = page.getByTestId("complete-magic-link");
      const retryGate = deferred();
      fixture.plans.push({ kind: "complete", gate: retryGate });
      await expect(complete).toBeEnabled();
      await complete.focus();
      await page.keyboard.press("Enter");
      await expect(complete).toBeDisabled();
      await expect.poll(() => fixture.writes("complete").length).toBe(2);
      await expectCallbackCopyHidden(page);
      await expect(page.locator("#auth-callback-error")).toBeHidden();
      retryGate.release();
      await expect(page).toHaveURL(`${origin}/setup`);
      expect(fixture.writes("complete")).toHaveLength(2);
    }
    expectClean(fixture);
  });
}
