import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = readFileSync(resolve(process.cwd(), "src/ui/player-consolidation.js"), "utf8");
const account = { sessionId: "session-one", subject: "account-one", email: "owner@example.com" };
const profiles = [
  { playerId: "p1", nickname: "Kesh", claimed: false, games: [{ gameId: "g1", kickoffAt: "2026-09-01T10:00:00Z" }] },
  { playerId: "p2", nickname: "Kesh", claimed: false, games: [{ gameId: "g2", kickoffAt: "2026-09-08T10:00:00Z" }] },
];
const proposal = (overrides = {}) => ({ proposalId: "proposal-consolidation-123", leagueId: "league", leagueName: "Winter league", nickname: "Kesh",
  retainedPlayerId: "p1", status: "ready", profiles, blockers: [], requiresApproval: false, canApprove: false, canCommit: true, ...overrides });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); }
function boot(approval: boolean, fetcher: typeof fetch, stored?: unknown) {
  const dom = new JSDOM(`<body data-api-base-url="https://api.example.com">${approval
    ? '<section id="consolidation-approval"><h1>Review profiles to combine</h1></section>'
    : '<div id="league-player-combine-host"></div><ul id="league-player-list"><li data-player-id="p1">Kesh</li><li data-player-id="p2">Kesh</li></ul>'}</body>`,
  { url: `https://example.com/${approval ? "combine-players?proposalId=proposal-consolidation-123" : "leagues/league#players"}`, runScripts: "outside-only", pretendToBeVisual: true });
  Object.defineProperty(dom.window, "crypto", { value: webcrypto });
  dom.window.fetch = fetcher; dom.window.AbortController = AbortController;
  if (stored) dom.window.sessionStorage.setItem("threefc.consolidation.v1:account-one", JSON.stringify(stored));
  dom.window.eval(script);
  return dom;
}
function named(dom: JSDOM, text: string) {
  const control = [...dom.window.document.querySelectorAll("button")].find(node => node.textContent === text);
  assert(control, `Missing button ${text}`); return control;
}

test("consolidation selection preserves duplicate identities and explicit preview", async () => {
  const writes: unknown[] = [];
  const dom = boot(false, async (input, init) => {
    if (String(input).endsWith("/auth/session")) return response({ authenticated: true, session: account });
    const body = JSON.parse(String(init?.body)); writes.push(body);
    return response({ proposal: proposal({ proposalId: body.proposalId, retainedPlayerId: body.retainedPlayerId, nickname: body.nickname }) });
  });
  try {
    const players = new Map(profiles.map((p, index) => [p.playerId, { ...p, seasons: [{ name: index ? "Summer" : "Winter" }] }]));
    const api = (dom.window as unknown as { ThreeFcConsolidation: { initializeLeague: (options: unknown) => { refreshRows: () => void } } }).ThreeFcConsolidation;
    api.initializeLeague({ leagueId: "league", canManage: () => true, getPlayer: (id: string) => players.get(id) }).refreshRows();
    named(dom, "Combine profiles").click(); await flush();
    for (const checkbox of dom.window.document.querySelectorAll<HTMLInputElement>("[data-consolidation-select]")) checkbox.click();
    assert.equal(writes.length, 0, "selection is not a mutation");
    const keep = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Profile to keep"]')!;
    assert.equal(keep.options.length, 2); assert.match(keep.options[0].text, /Winter/); assert.match(keep.options[1].text, /Summer/);
    named(dom, "Review profiles").click(); await flush();
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as { expectedAccountId: string }).expectedAccountId, account.subject);
    assert.deepEqual((writes[0] as { playerIds: string[] }).playerIds, ["p1", "p2"]);
    assert.match(dom.window.document.body.textContent ?? "", /Existing game records will be kept/);
    assert.equal(dom.window.document.querySelector<HTMLElement>('[data-ui="consolidation-editor"]')!.hidden, true);
    for (const input of dom.window.document.querySelectorAll("[data-consolidation-select]")) assert.equal(input.closest("label")!.hidden, true);
    named(dom, "Close preview").click();
    assert.equal(dom.window.document.activeElement, named(dom, "Combine profiles"));
    named(dom, "Combine profiles").click(); await flush();
    assert.equal(dom.window.document.querySelector<HTMLElement>('[data-ui="consolidation-editor"]')!.hidden, true);
    assert.equal(dom.window.document.activeElement?.getAttribute("aria-label"), "Combine player profiles");
    assert.equal(writes.length, 1, "closing and reopening preview does not submit or discard the proposal");
  } finally { dom.window.close(); }
});

test("owner approval is explicit and never commits automatically", async () => {
  const paths: string[] = [];
  const dom = boot(true, async (input, init) => {
    const path = String(input);
    if (path.endsWith("/auth/session")) return response({ authenticated: true, session: account });
    if (init?.method === "POST") { paths.push(path); return response({ proposal: proposal({ canCommit: false }) }); }
    return response({ proposal: proposal({ status: "pending_approval", requiresApproval: true, canApprove: true, canCommit: false }) });
  });
  try {
    await flush(); assert.equal(paths.length, 0);
    assert.match(dom.window.document.body.textContent ?? "", /Confirming with owner@example.com/);
    named(dom, "Approve these profiles").click(); await flush();
    assert.equal(paths.length, 1); assert.match(paths[0], /\/approve$/);
    assert.match(dom.window.document.body.textContent ?? "", /organiser can now combine/);
  } finally { dom.window.close(); }
});

test("uncertain consolidation approval retains the exact request and preserves outside focus", async () => {
  const bodies: string[] = []; let release: (() => void) | undefined;
  const dom = boot(true, async (input, init) => {
    if (String(input).endsWith("/auth/session")) return response({ authenticated: true, session: account });
    if (init?.method === "POST") {
      bodies.push(String(init.body));
      if (bodies.length === 1) return new Promise<Response>((_, reject) => { release = () => reject(new Error("lost reply")); });
      return response({ proposal: proposal({ canCommit: false }) });
    }
    return response({ proposal: proposal({ status: "pending_approval", requiresApproval: true, canApprove: true, canCommit: false }) });
  });
  try {
    await flush(); named(dom, "Approve these profiles").focus(); named(dom, "Approve these profiles").click(); await flush();
    const outside = dom.window.document.createElement("button"); outside.textContent = "Elsewhere"; dom.window.document.body.append(outside); outside.focus();
    assert(release); release(); await flush();
    assert.equal(dom.window.document.activeElement, outside);
    named(dom, "Retry this request").click(); await flush();
    assert.deepEqual(bodies, [bodies[0], bodies[0]]);
    assert.equal(JSON.parse(bodies[0]).expectedAccountId, account.subject);
  } finally { dom.window.close(); }
});

for (const uncertainFirst of [false, true]) test(`account-changed POST retires private proposal after ${uncertainFirst ? "uncertain retry" : "fresh preflight"}`, async () => {
  let posts = 0;
  const dom = boot(true, async (input, init) => {
    if (String(input).endsWith("/auth/session")) return response({ authenticated: true, session: account });
    if (init?.method === "POST") {
      posts += 1;
      assert.equal(JSON.parse(String(init.body)).expectedAccountId, account.subject);
      if (uncertainFirst && posts === 1) throw new Error("lost response");
      return response({ error: "forbidden", code: "account_changed" }, 403);
    }
    return response({ proposal: proposal({ status: "pending_approval", requiresApproval: true, canApprove: true, canCommit: false }) });
  });
  try {
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /Kesh/);
    named(dom, "Approve these profiles").click(); await flush();
    if (uncertainFirst) { named(dom, "Retry this request").click(); await flush(); }
    const text = dom.window.document.body.textContent ?? "";
    assert.match(text, /Your sign-in changed/);
    assert.doesNotMatch(text, /Kesh|owner@example.com|Approve these profiles|Retry this request|Check proposal/);
    const retained = JSON.parse(dom.window.sessionStorage.getItem("threefc.consolidation.v1:account-one")!);
    assert.equal(retained.body.expectedAccountId, account.subject);
    assert.equal(retained.uncertain, uncertainFirst);
  } finally { dom.window.close(); }
});

test("signed-out proposal offers only a nonsecret sign-in return", async () => {
  const dom = boot(true, async () => response({ error: "unauthorized" }, 401));
  try {
    await flush(); const link = dom.window.document.querySelector<HTMLAnchorElement>("a")!;
    assert(link); assert.match(link.href, /sign-in\?returnTo=/);
    assert.equal(new URL(link.href).searchParams.get("returnTo"), "/combine-players?proposalId=proposal-consolidation-123");
    assert.equal(dom.window.document.querySelectorAll('input[type="checkbox"]').length, 0);
  } finally { dom.window.close(); }
});

for (const phase of ["restore", "load", "mutation"] as const) test(`consolidation ${phase} preflight cannot resume after purge`, async () => {
  let sessions = 0, posts = 0, reads = 0; let release: ((value: Response) => void) | undefined;
  const deferredAt = phase === "restore" ? 1 : phase === "load" ? 2 : 3;
  const dom = boot(true, async (input, init) => {
    if (String(input).endsWith("/auth/session")) {
      sessions += 1;
      if (sessions === deferredAt) return new Promise<Response>(resolve => { release = resolve; });
      return response({ authenticated: true, session: account });
    }
    if (init?.method === "POST") posts += 1; else reads += 1;
    return response({ proposal: proposal({ status: "pending_approval", canApprove: true, canCommit: false, requiresApproval: true }) });
  });
  try {
    await flush();
    if (phase === "mutation") { named(dom, "Approve these profiles").click(); await flush(); }
    assert(release);
    dom.window.dispatchEvent(new dom.window.Event("threefc:player-proof-cleared"));
    release(response({ authenticated: true, session: account })); await flush();
    assert.equal(posts, 0); assert.equal(reads, phase === "mutation" ? 1 : 0);
    assert.equal(dom.window.sessionStorage.getItem("threefc.consolidation.v1:account-one"), null);
  } finally { dom.window.close(); }
});

for (const destination of ["other-proposal", "other-league"] as const) test(`consolidation ${destination} links explicitly to earlier uncertainty`, async () => {
  let posts = 0;
  const earlier = { path: "/v1/player-consolidations/commit", leagueId: "previous-league", uncertain: true,
    body: { proposalId: "previous-proposal-123", expectedAccountId: account.subject } };
  const dom = boot(destination === "other-proposal", async (input, init) => {
    if (init?.method === "POST") posts += 1;
    return response({ authenticated: true, session: account });
  }, earlier);
  try {
    if (destination === "other-league") {
      const api = (dom.window as unknown as { ThreeFcConsolidation: { initializeLeague: (options: unknown) => unknown } }).ThreeFcConsolidation;
      api.initializeLeague({ leagueId: "new-league", canManage: () => true, getPlayer: () => null });
      named(dom, "Combine profiles").click();
    }
    await flush();
    assert.equal([...dom.window.document.querySelectorAll("button")].some(node => node.textContent === "Retry this request"), false);
    const link = dom.window.document.querySelector<HTMLAnchorElement>('a[href*="previous-proposal-123"]');
    assert(link); assert.equal(link.textContent, "Open earlier proposal"); assert.equal(posts, 0);
    assert.deepEqual(JSON.parse(dom.window.sessionStorage.getItem("threefc.consolidation.v1:account-one")!), earlier);
  } finally { dom.window.close(); }
});
