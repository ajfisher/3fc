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
  const control = [...dom.window.document.querySelectorAll("button")].find(node => node.textContent === text && !node.closest("[hidden]"));
  assert(control, `Missing button ${text}`); return control;
}
function initialize(dom: JSDOM, options: Record<string, unknown> = {}) {
  const api = (dom.window as unknown as { ThreeFcConsolidation: { initializeLeague: (options: unknown) => { refreshRows: () => void } } }).ThreeFcConsolidation;
  return api.initializeLeague({ leagueId: "league", canManage: () => true, getPlayer: (id: string) => profiles.find(player => player.playerId === id), ...options });
}
function selectPlayers(dom: JSDOM, ids = ["p1", "p2"]) {
  for (const id of ids) dom.window.document.querySelector<HTMLInputElement>(`[data-consolidation-select][data-player-id="${id}"]`)!.click();
}

test("selection is one accessible table, preserves selected game enrichment across filters, and uses honest missing history", async () => {
  const dom = boot(false, async () => response({ authenticated: true, session: account }));
  let players: Array<Record<string, unknown>> = profiles.map(({ games: _games, ...player }) => player);
  try {
    const ui = initialize(dom, { getPlayers: () => players }); ui.refreshRows();
    named(dom, "Combine profiles").click(); await flush();
    assert.equal(dom.window.document.querySelectorAll('[data-ui="consolidation-selection-table"] tbody tr').length, 2);
    assert.equal(dom.window.document.querySelectorAll('[data-ui="consolidation-selections"]').length, 0);
    assert.match(dom.window.document.querySelector('tbody')!.textContent!, /Game history unavailable/);
    assert.equal(dom.window.document.querySelector('[data-consolidation-select]')!.getAttribute("aria-label"), "Select Kesh");
    selectPlayers(dom, ["p1"]);
    players = profiles.map(player => ({ ...player, gamesIncomplete: player.playerId === "p2" })); ui.refreshRows();
    assert.doesNotMatch(dom.window.document.querySelector('tbody')!.textContent!, /Game history unavailable/);
    assert.match(dom.window.document.querySelector('tbody')!.textContent!, /Some games are unavailable/);
    const checkbox = dom.window.document.querySelector<HTMLInputElement>('[data-consolidation-select][data-player-id="p1"]')!;
    const description = dom.window.document.getElementById(checkbox.getAttribute('aria-describedby')!)!;
    assert.match(description.textContent!, /2026/);
    assert.match(dom.window.document.querySelector<HTMLOptionElement>('#consolidation-retained option')!.textContent!, /2026/);
    assert.equal(dom.window.document.querySelector('[data-ui="consolidation-selected-count"]')!.textContent, '1 profile selected');
    players = [players[1]]; ui.refreshRows();
    const selected = dom.window.document.querySelector('tr[data-player-id="p1"]')!;
    assert.equal(selected.querySelectorAll('ul li').length, 1, "selected row keeps newly loaded dates after filtering");
    assert.equal(dom.window.document.querySelectorAll('tr[data-player-id="p1"]').length, 1);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('[data-player-id="p1"][type="checkbox"]')!.checked, true);
  } finally { dom.window.close(); }
});

test("two consecutive combines start fresh selections and proposal IDs without a stale success panel", async () => {
  const extra = profiles.map((player, index) => ({ ...player, playerId: `p${index + 3}`, nickname: `Player ${index + 3}` }));
  let players = [...profiles, ...extra]; const previews: Array<{proposalId: string; playerIds: string[]}> = [];
  let current = proposal(); let commits = 0;
  const dom = boot(false, async (input, init) => {
    if (String(input).endsWith('/auth/session')) return response({ authenticated: true, session: account });
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith('/commit')) { commits += 1; current = { ...current, status: 'committed', canCommit: false }; }
    else { previews.push(body); current = proposal({ ...body, profiles: players.filter(player => body.playerIds.includes(player.playerId)) }); }
    return response({ proposal: current });
  });
  try {
    initialize(dom, { getPlayers: () => players, onCommitted: async () => {
      const removed = current.profiles.filter(player => player.playerId !== current.retainedPlayerId).map(player => player.playerId);
      players = players.filter(player => !removed.includes(player.playerId));
    } }).refreshRows();
    named(dom, 'Combine profiles').click(); await flush(); selectPlayers(dom);
    named(dom, 'Review profiles').click(); await flush(); named(dom, 'Combine profiles').click(); await flush();
    assert.match(dom.window.document.body.textContent!, /Profiles combined as Kesh/);
    assert.equal(dom.window.document.querySelector('[aria-label="Profiles to combine"]'), null, 'success does not render obsolete proposal details');
    assert.equal(dom.window.document.querySelectorAll('[data-consolidation-select]:checked').length, 0);
    named(dom, 'Combine more').click();
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('#consolidation-name')!.value, '');
    assert.equal(dom.window.document.querySelectorAll('tr[data-player-id="p2"]').length, 0);
    selectPlayers(dom, ['p3', 'p4']); named(dom, 'Review profiles').click(); await flush();
    named(dom, 'Combine profiles').click(); await flush();
    assert.equal(commits, 2); assert.equal(previews.length, 2);
    assert.notEqual(previews[0].proposalId, previews[1].proposalId);
    assert.deepEqual(previews[1].playerIds, ['p3', 'p4']);
    named(dom, 'Back to players').click();
    assert.equal(dom.window.document.querySelector<HTMLElement>('#league-player-list')!.hidden, false);
    assert.equal(dom.window.document.activeElement, named(dom, 'Combine profiles'));
  } finally { dom.window.close(); }
});

test("confirmed combine remains successful while refresh is pending and after refresh fails", async () => {
  let current = proposal(); let rejectRefresh: ((reason: Error) => void) | undefined; let commits = 0;
  const dom = boot(false, async (input, init) => {
    if (String(input).endsWith('/auth/session')) return response({ authenticated: true, session: account });
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith('/commit')) { commits += 1; current = { ...current, status: 'committed', canCommit: false }; }
    else current = proposal({ ...body });
    return response({ proposal: current });
  });
  try {
    initialize(dom, { onCommitted: () => new Promise<void>((_resolve, reject) => { rejectRefresh = reject; }) }).refreshRows();
    named(dom, 'Combine profiles').click(); await flush(); selectPlayers(dom);
    named(dom, 'Review profiles').click(); await flush(); named(dom, 'Combine profiles').click(); await flush();
    assert.match(dom.window.document.body.textContent!, /Profiles combined as Kesh/);
    assert.equal(named(dom, 'Combine more').disabled, true);
    assert.equal(dom.window.sessionStorage.getItem('threefc.consolidation.v1:account-one'), null);
    assert(rejectRefresh); rejectRefresh(new Error('directory offline')); await flush();
    assert.match(dom.window.document.body.textContent!, /Profiles combined as Kesh.*player list couldn’t refresh/);
    assert.equal(named(dom, 'Combine more').disabled, false);
    assert.equal([...dom.window.document.querySelectorAll('button')].some(button => button.textContent === 'Retry this request'), false);
    assert.equal(commits, 1);
  } finally { dom.window.close(); }
});

test("Back keeps draft but creates a new proposal; pending approval Cancel keeps a separate resumable reference", async () => {
  const writes: Array<{proposalId: string; nickname: string}> = []; let pending = false;
  const dom = boot(false, async (input, init) => {
    if (String(input).endsWith('/auth/session')) return response({ authenticated: true, session: account });
    const body = JSON.parse(String(init?.body)); writes.push(body);
    return response({ proposal: proposal({ ...body, status: pending ? 'pending_approval' : 'ready', canCommit: !pending, requiresApproval: pending }) });
  });
  try {
    initialize(dom).refreshRows(); named(dom, 'Combine profiles').click(); await flush(); selectPlayers(dom);
    const name = dom.window.document.querySelector<HTMLInputElement>('#consolidation-name')!;
    name.value = 'Kesh retained'; name.dispatchEvent(new dom.window.Event('input'));
    named(dom, 'Review profiles').click(); await flush();
    assert.equal([...dom.window.document.querySelectorAll('button')].some(button => button.textContent === 'Check proposal'), false);
    named(dom, 'Back').click(); assert.equal(name.value, 'Kesh retained');
    assert.equal(dom.window.document.querySelectorAll('[data-consolidation-select]:checked').length, 2);
    pending = true; named(dom, 'Review profiles').click(); await flush();
    assert.notEqual(writes[0].proposalId, writes[1].proposalId); assert.equal(writes[1].nickname, 'Kesh retained');
    named(dom, 'Check approval'); named(dom, 'Cancel').click();
    const deferred = dom.window.document.querySelector<HTMLAnchorElement>('[data-ui="consolidation-pending-links"] a')!;
    assert.equal(new URL(deferred.href).searchParams.get('proposalId'), writes[1].proposalId);
    assert.equal(deferred.closest('[hidden]'), null);
    assert.equal(dom.window.document.querySelectorAll('[data-consolidation-select]:checked').length, 0);
    assert.equal(writes.length, 2);
    dom.window.dispatchEvent(new dom.window.Event('threefc:player-proof-cleared'));
    assert.equal(dom.window.document.querySelector('[data-ui="consolidation-pending-links"] a'), null);
  } finally { dom.window.close(); }
});

test("uncertain preview cannot be cancelled, escaped or replaced and retries its immutable request", async () => {
  const writes: string[] = []; const phases: string[] = [];
  const dom = boot(false, async (input, init) => {
    if (String(input).endsWith('/auth/session')) return response({ authenticated: true, session: account });
    writes.push(String(init?.body)); if (writes.length === 1) throw new Error('response lost');
    return response({ proposal: proposal(JSON.parse(String(init?.body))) });
  });
  try {
    initialize(dom, { onTaskState: (state: {phase: string}) => phases.push(state.phase) }).refreshRows();
    named(dom, 'Combine profiles').click(); await flush(); selectPlayers(dom); named(dom, 'Review profiles').click(); await flush();
    assert.equal(named(dom, 'Cancel').disabled, true);
    assert.equal(phases.at(-1), 'review');
    named(dom, 'Cancel').click();
    const panel = dom.window.document.querySelector<HTMLElement>('section[aria-label="Combine player profiles"]')!;
    panel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(panel.hidden, false);
    for (const checkbox of dom.window.document.querySelectorAll<HTMLInputElement>('[data-consolidation-select]')) assert.equal(checkbox.disabled, true);
    named(dom, 'Retry this request').click(); await flush();
    assert.deepEqual(writes, [writes[0], writes[0]]);
    named(dom, 'Back').click(); assert.equal(dom.window.document.querySelectorAll('[data-consolidation-select]:checked').length, 2);
  } finally { dom.window.close(); }
});

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
    selectPlayers(dom);
    assert.equal(writes.length, 0, "selection is not a mutation");
    const keep = dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Profile to keep"]')!;
    assert.equal(keep.options.length, 2); assert.match(keep.options[0].text, /Winter/); assert.match(keep.options[1].text, /Summer/);
    named(dom, "Review profiles").click(); await flush();
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as { expectedAccountId: string }).expectedAccountId, account.subject);
    assert.deepEqual((writes[0] as { playerIds: string[] }).playerIds, ["p1", "p2"]);
    assert.match(dom.window.document.body.textContent ?? "", /Existing game records will be kept/);
    assert.equal(dom.window.document.querySelector<HTMLElement>('[data-ui="consolidation-editor"]')!.hidden, true);
    for (const input of dom.window.document.querySelectorAll("[data-consolidation-select]")) assert(input.closest("[hidden]"));
    named(dom, "Back").click();
    assert.equal(dom.window.document.querySelector<HTMLElement>('[data-ui="consolidation-editor"]')!.hidden, false);
    assert.equal(dom.window.document.querySelectorAll("[data-consolidation-select]:checked").length, 2);
    named(dom, "Cancel").click();
    assert.equal(dom.window.document.activeElement, named(dom, "Combine profiles"));
    named(dom, "Combine profiles").click(); await flush();
    assert.equal(dom.window.document.querySelector<HTMLElement>('[data-ui="consolidation-editor"]')!.hidden, false);
    assert.equal(dom.window.document.querySelectorAll("[data-consolidation-select]:checked").length, 0);
    assert.equal(writes.length, 1, "back and cancel do not mutate a settled server proposal");
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

test("failed approval refresh keeps its actionable error instead of overwriting it with waiting copy", async () => {
  let reads = 0;
  const dom = boot(true, async input => {
    if (String(input).endsWith('/auth/session')) return response({ authenticated: true, session: account });
    reads += 1;
    if (reads === 2) return response({ error: 'unavailable' }, 503);
    return response({ proposal: proposal({ status: 'pending_approval', requiresApproval: true, canCommit: false }) });
  });
  try {
    await flush(); named(dom, 'Check approval').click(); await flush();
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Couldn’t load the proposal/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /Waiting for player approval/);
    assert.equal(named(dom, 'Check approval').disabled, false);
    named(dom, 'Check approval').click(); await flush();
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    assert.match(dom.window.document.body.textContent!, /Waiting for player approval/);
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
