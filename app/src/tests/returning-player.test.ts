import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = readFileSync(resolve(process.cwd(), "src/ui/returning-player.js"), "utf8");
const account = { sessionId: "session-A", subject: "account-A", email: "a@example.invalid" };
const player = (id = "one") => ({ playerId: id, nickname: "Xavier", registeredPlayerId: null, team: null, seasons: [{ seasonId: "winter", name: "Winter" }] });
const page = (players: unknown[], extra = {}) => ({ accountId: account.subject, gameId: "game", leagueId: "league", players, cursor: null, complete: true, ...extra });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
function boot(fetcher: typeof fetch, saved?: unknown) {
  const dom = new JSDOM('<body data-api-base-url="https://api.example.invalid"><section id="returning-player"></section></body>',
    { url: "https://3fc.example/join/CODE1234", runScripts: "outside-only", pretendToBeVisual: true });
  Object.defineProperty(dom.window, "crypto", { value: webcrypto }); dom.window.fetch = fetcher; dom.window.AbortController = AbortController;
  if (saved) dom.window.sessionStorage.setItem("threefc.returning-join.v1:account-A:CODE1234", JSON.stringify(saved));
  dom.window.eval(script); const creations: unknown[] = []; let locked = false;
  const api = (dom.window as unknown as { ThreeFcReturningPlayer: { initialize: (options: unknown) => { start: () => void } } }).ThreeFcReturningPlayer;
  api.initialize({ joinCode: "CODE1234", onSession() {}, onCreate: (value: unknown) => creations.push(value), onLock: () => { locked = true; } }).start();
  return { dom, creations, isLocked: () => locked };
}
function button(dom: JSDOM, label: string) {
  const found = [...dom.window.document.querySelectorAll("button")].find(control => control.textContent === label);
  assert(found, `Missing ${label}`); return found;
}

test("browser-history restoration reloads without reviving a pending join", async () => {
  let posts = 0;
  const { dom } = boot(async (input, init) => {
    if (init?.method === "POST") posts++;
    return reply(String(input).endsWith("/auth/session") ? { authenticated: true, session: account } : page([player()]));
  });
  try {
    await flush(); const navigations: unknown[][] = [];
    (dom.window as any).__THREEFC_NAVIGATE__ = (...args: unknown[]) => navigations.push(args);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide", { persisted: true }));
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow", { persisted: true }));
    assert.deepEqual(navigations, [[dom.window.location.href, "reload"]]);
    assert.equal(posts, 0);
  } finally { dom.window.close(); }
});

test("single linked player joins explicitly without proof and preserves original registration/team", async () => {
  const posts: RequestInit[] = [];
  const { dom } = boot(async (input, init) => {
    if (String(input).endsWith("/auth/session")) return reply({ authenticated: true, session: account });
    if (init?.method === "POST") { posts.push(init); return reply({ accountId: account.subject, gameId: "game", joinCode: "CODE1234",
      player: { playerId: "historical-one", nickname: "Xavier" }, link: { gameId: "game", playerId: "historical-one" }, alreadyRegistered: true, team: null }); }
    assert.equal(new URL(String(input)).searchParams.get("limit"), "20");
    return reply(page([{ ...player(), registeredPlayerId: "historical-one", team: { teamId: "blue", name: "Blue", color: null } }]));
  });
  try {
    await flush(); assert.equal(posts.length, 0); assert.match(dom.window.document.body.textContent!, /Already in Blue/);
    assert.equal(button(dom, "Join as Xavier").getAttribute("data-variant"), "primary");
    assert.equal(button(dom, "Create new player").getAttribute("data-variant"), "secondary");
    button(dom, "Join as Xavier").click(); await flush(); assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(String(posts[0].body)), { playerId: "one", expectedAccountId: "account-A" });
    assert.match(dom.window.document.body.textContent!, /Xavier is already in this game/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /Team: Blue|Unassigned|Already in Blue/);
    assert.equal(dom.window.sessionStorage.length, 0);
  } finally { dom.window.close(); }
});

test("partial directory cannot become zero or single identity until explicit pagination completes", async () => {
  let reads = 0;
  const { dom } = boot(async input => String(input).endsWith("/auth/session") ? reply({ authenticated: true, session: account })
    : reply(++reads <= 4 ? page(reads === 1 ? [player()] : [], { cursor: `next-${reads}`, complete: false }) : page([player("two")])));
  try {
    await flush(); assert.equal(reads, 4); assert.doesNotMatch(dom.window.document.body.textContent!, /Join as|Create new player/);
    button(dom, "Load more players").click(); await flush();
    const select = dom.window.document.querySelector("select")!; assert.equal(select.options.length, 3); assert.equal(select.value, "");
    assert.equal(button(dom, "Join game").disabled, true);
    select.value = "two"; select.dispatchEvent(new dom.window.Event("change")); assert.equal(button(dom, "Join game").disabled, false);
  } finally { dom.window.close(); }
});

test("zero linked identities requires explicit new-player choice", async () => {
  const { dom, creations } = boot(async input => String(input).endsWith("/auth/session") ? reply({ authenticated: true, session: account }) : reply(page([])));
  try { await flush(); assert.equal(creations.length, 0); assert.match(dom.window.document.body.textContent!, /Ask the organiser for a profile link/);
    button(dom, "Create new player").click(); assert.equal(creations.length, 1);
  } finally { dom.window.close(); }
});

for (const status of [401, 503]) test(`initial session ${status} distinguishes anonymous from unavailable`, async () => {
  const { dom, creations } = boot(async () => reply({ error: "unavailable" }, status));
  try { await flush(); assert.equal(creations.length, status === 401 ? 1 : 0);
    if (status === 503) assert.equal(button(dom, "Retry").disabled, false);
  } finally { dom.window.close(); }
});

test("uncertain returning join retries frozen account/player/key after reload", async () => {
  let saved: unknown; const requests: RequestInit[] = [];
  const run = (stored?: unknown) => boot(async (input, init) => {
    if (String(input).endsWith("/auth/session")) return reply({ authenticated: true, session: account });
    if (init?.method === "POST") { requests.push(init); throw new Error("lost response"); }
    return reply(page([player()]));
  }, stored);
  const first = run();
  try { await flush(); button(first.dom, "Join as Xavier").click(); await flush();
    saved = JSON.parse(first.dom.window.sessionStorage.getItem("threefc.returning-join.v1:account-A:CODE1234")!);
  } finally { first.dom.window.close(); }
  const second = run(saved);
  try { await flush(); button(second.dom, "Retry join").click(); await flush();
    assert.equal(requests.length, 2); assert.equal(requests[0].body, requests[1].body);
    assert.deepEqual({ ...requests[0].headers }, { ...requests[1].headers });
  } finally { second.dom.window.close(); }
});

test("empty source streams complete automatically within four sequential pages", async () => {
  let reads = 0;
  const { dom } = boot(async input => String(input).endsWith("/auth/session") ? reply({ authenticated: true, session: account })
    : reply(++reads < 4 ? page(reads === 1 ? [player()] : [], { cursor: `next-${reads}`, complete: false }) : page([])));
  try { await flush(); assert.equal(reads, 4); assert(button(dom, "Join as Xavier"));
    assert.doesNotMatch(dom.window.document.body.textContent!, /Load more players/);
  } finally { dom.window.close(); }
});

for (const cleanupFails of [false, true]) test(`malformed saved context offers verified cleanup${cleanupFails ? " with storage failure" : ""} without a new join`, async () => {
  let posts = 0;
  const { dom } = boot(async (input, init) => {
    if (init?.method === "POST") posts++;
    return String(input).endsWith("/auth/session") ? reply({ authenticated: true, session: account }) : reply(page([player()]));
  }, { joinCode: "CODE1234", nickname: "Xavier", body: { playerId: "one", expectedAccountId: account.subject }, idempotencyKey: "frozen-key", uncertain: true });
  try { await flush(); assert.equal(posts, 0);
    assert.doesNotMatch(dom.window.document.body.textContent!, /Retry join/);
    assert.match(dom.window.document.body.textContent!, /saved join request can’t be recovered/);
    if (cleanupFails) Object.defineProperty(dom.window.Storage.prototype, "removeItem", { value: () => { throw new Error("blocked storage"); } });
    button(dom, "Clear saved request").click(); await flush(); assert.equal(posts, 0);
    if (cleanupFails) { assert.match(dom.window.document.body.textContent!, /couldn’t clear/);
      button(dom, "Clear saved request").click(); await flush(); assert.equal(posts, 0);
      assert.doesNotMatch(dom.window.document.body.textContent!, /Join as Xavier/);
    } else { assert.equal(dom.window.sessionStorage.length, 0); assert(button(dom, "Join as Xavier")); }
  } finally { dom.window.close(); }
});

for (const phase of ["session", "post"] as const) test(`account invalidation during ${phase} hides details and fences late responses`, async () => {
  let sessions = 0, posts = 0; let release: ((value: Response) => void) | undefined;
  const { dom, isLocked } = boot(async (input, init) => {
    if (String(input).endsWith("/auth/session")) {
      if (++sessions === 2 && phase === "session") return new Promise(resolve => { release = resolve; });
      return reply({ authenticated: true, session: account });
    }
    if (init?.method === "POST") { posts++; return reply({ code: "account_changed" }, 403); }
    return reply(page([player()]));
  });
  try { await flush(); button(dom, "Join as Xavier").click(); await flush();
    if (phase === "session") { assert(release); dom.window.dispatchEvent(new dom.window.Event("threefc:player-proof-cleared")); release(reply({ authenticated: true, session: account })); await flush(); }
    assert(isLocked()); assert.doesNotMatch(dom.window.document.body.textContent!, /Xavier/); assert.equal(posts, phase === "post" ? 1 : 0);
    if (phase === "session") assert.equal(dom.window.sessionStorage.length, 0);
  } finally { dom.window.close(); }
});
