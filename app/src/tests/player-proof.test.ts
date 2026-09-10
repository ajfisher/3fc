import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderPlayerLinkPage, renderSignInPage } from "../ui/layout.js";

const script = readFileSync(resolve(process.cwd(), "src/ui/player-proof.js"), "utf8");
const proofId = "proof-id-for-test-123456";
const secret = Buffer.alloc(32, 17).toString("base64url");
const origin = "https://qa.3fc.football";
const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
const calls: Array<{ path: string; body: any }> = [];
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
const previewResponse = (playerId = "xavier") => response(200, { preview: { proofId, expiresAt,
  player: { playerId, nickname: "Xavier" }, league: { name: "League" }, confirmation: "bound-confirmation", alreadyLinked: false },
  account: { id: "account-A", email: "A@example.com" } });
const accountPreview = (id: string, email = "same@example.com") => response(200, {
  preview: { proofId, expiresAt, player: { playerId: "xavier", nickname: "Xavier" },
    league: { name: "League" }, confirmation: `confirmation-${id}`, alreadyLinked: false }, account: { id, email },
});
async function settle() { for (let i = 0; i < 15; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }

function page(input: { url: string; html?: string; storage?: Map<string, string>; channel?: unknown;
  fetch?: (path: string, body: any) => unknown; blockedStorage?: boolean }) {
  const dom = new JSDOM(input.html ?? renderPlayerLinkPage(origin), { url: input.url, runScripts: "outside-only", pretendToBeVisual: true });
  const storage = input.storage ?? new Map<string, string>();
  Object.defineProperty(dom.window, "crypto", { value: webcrypto });
  Object.defineProperty(dom.window, "TextEncoder", { value: TextEncoder });
  Object.defineProperty(dom.window, "sessionStorage", { value: {
    getItem(key: string) { return storage.get(key) ?? null; },
    setItem(key: string, value: string) { if (input.blockedStorage) throw new Error("blocked"); storage.set(key, value); },
    removeItem(key: string) { storage.delete(key); },
  } });
  if (input.channel) Object.defineProperty(dom.window, "BroadcastChannel", { value: input.channel });
  Object.defineProperty(dom.window, "fetch", { value: async (url: URL, options: { body?: string }) => {
    assert.equal(dom.window.location.hash, "", "fragment is scrubbed before a request starts");
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(options.body ?? "{}");
    calls.push({ path, body });
    if (input.fetch) return input.fetch(path, body);
    return response(200, { preview: { proofId, expiresAt, player: { playerId: "xavier", nickname: "Xavier" },
      league: { leagueId: "league", name: "Melbourne 3FC" }, confirmation: "opaque-account-B-binding", alreadyLinked: false },
      account: { id: "account-B", email: "account-B@example.com" } });
  } });
  dom.window.eval(script);
  return { dom, storage, document: dom.window.document, proof: (dom.window as any).ThreeFcPlayerProof };
}

for (const path of ["/link-player", "/link-player/"]) {
  test(`private player link scrubs ${path}, pairs account display and requires one explicit confirmation`, async (t) => {
    calls.length = 0;
    const view = page({ url: `${origin}${path}#proofId=${proofId}&secret=${secret}`, fetch: (path) =>
      path.endsWith("/claim") ? response(200, { player: { playerId: "xavier" }, claim: { claimedByCurrentUser: true } })
        : response(200, { preview: { proofId, expiresAt, player: { playerId: "xavier", nickname: "Xavier" }, league: { name: "Melbourne 3FC" },
          confirmation: "paired-binding", alreadyLinked: false }, account: { id: "account-B", email: "B@example.com" } }),
    });
    t.after(() => view.dom.window.close());
    await settle();
    assert.equal(view.dom.window.location.hash, "");
    assert.equal(view.dom.window.location.search, `?proofId=${proofId}`);
    assert.equal(view.document.getElementById("player-link-account")?.textContent, "B@example.com");
    assert.equal(view.document.getElementById("player-link-name")?.textContent, "Xavier");
    assert.equal(calls.filter((call) => call.path.endsWith("/claim")).length, 0);
    const button = view.document.getElementById("player-link-confirm") as HTMLButtonElement;
    button.click(); button.click();
    await settle();
    assert.equal(calls.filter((call) => call.path.endsWith("/claim")).length, 1);
    assert.equal(calls.at(-1)?.body.proof.confirmation, "paired-binding");
    assert.equal(button.hidden, true);
    assert.equal(view.document.getElementById("player-link-status")?.textContent, "Player linked to B@example.com.");
    assert.ok(!view.document.documentElement.innerHTML.includes(secret));
    assert.equal(view.document.querySelector('meta[name="referrer"]')?.getAttribute("content"), "no-referrer");
  });
}

test("private player proof is persisted before use, reused for a retry and purged on sign-out", async (t) => {
  const view = page({ url: `${origin}/sign-in`, html: renderSignInPage(origin, "/setup") });
  t.after(() => view.dom.window.close());
  const first = await view.proof.create("join:one-key");
  assert.match(first.verifier, /^[a-f0-9]{64}$/);
  assert.ok(view.storage.get("threefc.player-proof.v1")?.includes(first.secret));
  assert.deepEqual(await view.proof.create("join:one-key"), first);
  assert.equal(view.dom.window.localStorage.length, 0);
  view.proof.clear();
  assert.equal(view.storage.size, 0);
  assert.equal(await view.proof.read(first.proofId), null);
});

test("private player link with missing or blocked storage offers real recovery without consuming proof", async (t) => {
  for (const blockedStorage of [false, true]) {
    calls.length = 0;
    const view = page({ url: `${origin}/link-player?proofId=${proofId}${blockedStorage ? `#secret=${secret}` : ""}`, blockedStorage });
    t.after(() => view.dom.window.close());
    await settle();
    assert.equal(calls.length, 0);
    assert.equal((view.document.getElementById("player-link-confirm") as HTMLButtonElement).hidden, true);
    assert.match(view.document.getElementById("player-link-status")?.textContent ?? "", /Reopen the private link/);
    assert.equal(view.document.querySelectorAll('[role="alert"]:not([hidden])').length, 1);
  }
});

test("private proof draft retirement is exact and capacity never evicts live records", async (t) => {
  const view = page({ url: `${origin}/sign-in`, html: renderSignInPage(origin, "/setup") });
  t.after(() => view.dom.window.close());
  const live = await view.proof.create("live");
  view.proof.attach(live, { proofId: live.proofId, expiresAt }, "player");
  const draft = await view.proof.create("draft");
  assert.throws(() => view.proof.discardDraft({ ...draft, secret: "wrong" }));
  assert.throws(() => view.proof.discardDraft(live));
  view.proof.discardDraft(draft);
  assert.equal(await view.proof.read(draft.proofId), null);
  assert.equal((await view.proof.read(live.proofId)).secret, live.secret);
  for (let index = 0; index < 19; index += 1) await view.proof.create(`held-${index}`);
  const before = view.storage.get("threefc.player-proof.v1");
  await assert.rejects(view.proof.create("overflow"), /proof_storage_full/);
  assert.equal(view.storage.get("threefc.player-proof.v1"), before);
  assert.equal((await view.proof.read(live.proofId)).secret, live.secret);
});

test("private player link preserves the exact request after an uncertain acceptance", async (t) => {
  const attempts: unknown[] = [];
  const view = page({ url: `${origin}/link-player#proofId=${proofId}&secret=${secret}`, fetch: (path, body) => {
    if (path.endsWith("/claim")) { attempts.push(body); throw new Error("response lost"); }
    return response(200, { preview: { proofId, expiresAt, player: { playerId: "xavier", nickname: "Xavier" }, league: { name: "League" },
      confirmation: "same-binding", alreadyLinked: false }, account: { id: "account-A", email: "A@example.com" } });
  } });
  t.after(() => view.dom.window.close());
  await settle();
  const button = view.document.getElementById("player-link-confirm") as HTMLButtonElement;
  button.click(); await settle();
  assert.equal(button.disabled, false);
  button.click(); await settle();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.match(view.document.getElementById("player-link-status")?.textContent ?? "", /could not be confirmed/);
});

for (const scenario of ["retry", "reload", "recapture", "same-account", "preview-401", "claim-401"] as const) {
  test(`private player retained account boundary ${scenario}`, async (t) => {
    calls.length = 0;
    let account = "A";
    let signedIn = true;
    let email = "same@example.com";
    const fetch = (path: string) => path.endsWith("/claim")
      ? response(signedIn ? 409 : 401, { code: "claim_confirmation_changed" })
      : signedIn ? accountPreview(account, email) : response(401, {});
    let view = page({ url: `${origin}/link-player#proofId=${proofId}&secret=${secret}`, fetch });
    t.after(() => view.dom.window.close());
    await settle();
    assert.equal(JSON.parse(view.storage.get("threefc.player-proof.v1")!)[0].accountId, "A");
    const click = (id: string) => { const button = view.document.getElementById(id) as HTMLButtonElement; button.focus(); button.click(); };
    if (scenario === "claim-401") signedIn = false;
    click("player-link-confirm"); await settle();
    if (scenario !== "same-account") account = "B";
    if (scenario === "preview-401") signedIn = false;
    if (scenario === "reload" || scenario === "recapture") {
      const storage = view.storage;
      view.dom.window.close();
      view = page({ url: `${origin}/link-player?proofId=${proofId}${scenario === "recapture" ? `#secret=${secret}` : ""}`, storage, fetch });
    } else if (scenario !== "claim-401") {
      if (scenario === "same-account") {
        // A changed email label or renewed confirmation is not another account.
        email = "renamed@example.com";
      }
      click("player-link-retry");
    }
    await settle();
    if (scenario === "same-account") {
      assert.equal((view.document.getElementById("player-link-confirm") as HTMLButtonElement).hidden, false);
      assert.equal(JSON.parse(view.storage.get("threefc.player-proof.v1")!)[0].accountId, "A");
    } else {
      assert.equal(view.storage.has("threefc.player-proof.v1"), false);
      assert.equal(await view.proof.read(proofId), null);
      assert.equal((view.document.getElementById("player-link-confirm") as HTMLButtonElement).hidden, true);
      assert.match(view.document.getElementById("player-link-status")?.textContent ?? "", /reopen the private link/i);
      assert.equal(calls.filter(call => call.path.endsWith("/claim")).length, 1);
    }
  });
}

test("private player proof can hand off from the sign-in tab without any secret in its return URL", async (t) => {
  const channels = new Set<Channel>();
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(_name: string) { channels.add(this); }
    postMessage(data: unknown) { for (const channel of channels) if (channel !== this) queueMicrotask(() => channel.onmessage?.({ data })); }
    close() { channels.delete(this); this.onmessage = null; }
  }
  const source = page({ url: `${origin}/sign-in`, html: renderSignInPage(origin, "/setup"), channel: Channel });
  t.after(() => { source.proof.clear(); source.dom.window.close(); });
  const record = await source.proof.create("join:handoff");
  const target = page({ url: origin + source.proof.destination(record.proofId), channel: Channel,
    fetch: () => response(401, { error: "unauthorized" }) });
  t.after(() => { target.proof.clear(); target.dom.window.close(); });
  await settle();
  assert.ok(target.storage.get("threefc.player-proof.v1")?.includes(record.secret));
  const signIn = target.document.getElementById("player-link-signin") as HTMLAnchorElement;
  assert.equal(signIn.hidden, false);
  assert.ok(!signIn.href.includes(record.secret));
  assert.ok(signIn.href.includes(record.proofId));
});

test("private player binding reaches original holders and cannot be downgraded by handoff", async (t) => {
  const channels = new Set<Channel>();
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(_name: string) { channels.add(this); }
    postMessage(data: unknown) { for (const channel of channels) if (channel !== this) queueMicrotask(() => channel.onmessage?.({ data })); }
    close() { channels.delete(this); this.onmessage = null; }
  }
  const stamp = Date.now();
  const storage = new Map([["threefc.player-proof.v1", JSON.stringify([{ proofId, secret, createdAt: stamp, expiresAt: stamp + 7 * 86400_000 }])]]);
  const source = page({ url: `${origin}/sign-in`, html: renderSignInPage(origin, "/setup"), storage, channel: Channel });
  const recipient = page({ url: `${origin}/link-player?proofId=${proofId}`, channel: Channel, fetch: () => accountPreview("A") });
  t.after(() => { source.proof.clear(); source.dom.window.close(); recipient.dom.window.close(); });
  await settle();
  assert.equal((await source.proof.read(proofId)).accountId, "A", "original unbound holder receives binding");
  // attach receives an older unbound object but must retain its stored binding.
  source.proof.attach({ proofId, secret, createdAt: stamp, expiresAt: stamp + 7 * 86400_000 }, { proofId, expiresAt }, "xavier");
  assert.equal((await source.proof.read(proofId)).accountId, "A");
  recipient.dom.window.dispatchEvent(new recipient.dom.window.Event("pagehide"));
  recipient.dom.window.close();
  const other = page({ url: `${origin}/link-player?proofId=${proofId}`, channel: Channel, fetch: () => accountPreview("B") });
  t.after(() => other.dom.window.close());
  await settle();
  assert.equal(other.storage.has("threefc.player-proof.v1"), false, "B cannot adopt A's handed-off capability");
  assert.equal(source.storage.has("threefc.player-proof.v1"), false, "mismatch purges the original holder too");
  assert.equal((other.document.getElementById("player-link-confirm") as HTMLButtonElement).hidden, true);
});

test("private player preview cannot overwrite a binding received while it was pending", async (t) => {
  let channel: any;
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(_name: string) { channel = this; }
    postMessage(_data: unknown) {}
    close() {}
  }
  let release: ((value: unknown) => void) | undefined;
  const view = page({ url: `${origin}/link-player#proofId=${proofId}&secret=${secret}`, channel: Channel,
    fetch: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => view.dom.window.close());
  await settle(); assert(release);
  channel.onmessage({ data: { version: 1, type: "bound", proofId, accountId: "A" } });
  release(accountPreview("B")); await settle();
  assert.equal(view.storage.has("threefc.player-proof.v1"), false);
  assert.equal((view.document.getElementById("player-link-confirm") as HTMLButtonElement).hidden, true);
});

test("private player handoff retains binding received before an older unbound response", async (t) => {
  let channel: any;
  let handoff: any;
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(_name: string) { channel = this; }
    postMessage(data: any) { if (data.type === "request") handoff = data; }
    close() {}
  }
  const view = page({ url: `${origin}/link-player?proofId=${proofId}`, channel: Channel, fetch: () => accountPreview("B") });
  t.after(() => view.dom.window.close());
  await settle(); assert(handoff);
  channel.onmessage({ data: { version: 1, type: "bound", proofId, accountId: "A" } });
  const stamp = Date.now();
  channel.onmessage({ data: { ...handoff, type: "response", record: { proofId, secret, createdAt: stamp, expiresAt: stamp + 7 * 86400_000 } } });
  await settle();
  assert.equal(view.storage.has("threefc.player-proof.v1"), false);
  assert.equal((view.document.getElementById("player-link-confirm") as HTMLButtonElement).hidden, true);
  assert.match(view.document.getElementById("player-link-status")?.textContent ?? "", /account changed/);
});

for (const stage of ["preview", "claim"] as const) for (const focus of ["owned", "outside"] as const) {
  test(`private player bound ${stage}401 offers sign-in and preserves ${focus} focus`, async (t) => {
    let release: ((value: unknown) => void) | undefined;
    let rechecking = false;
    const view = page({ url: `${origin}/link-player#proofId=${proofId}&secret=${secret}`, fetch: (path) => {
      if (path.endsWith("/claim")) return stage === "claim" ? new Promise(resolve => { release = resolve; }) : response(409, {});
      if (rechecking) return new Promise(resolve => { release = resolve; });
      return accountPreview("A");
    } });
    t.after(() => view.dom.window.close());
    await settle();
    const confirm = view.document.getElementById("player-link-confirm") as HTMLButtonElement;
    confirm.focus(); confirm.click(); await settle();
    if (stage === "preview") {
      rechecking = true;
      const retry = view.document.getElementById("player-link-retry") as HTMLButtonElement;
      retry.focus(); retry.click(); await settle();
    }
    assert(release);
    const outside = view.document.createElement("button"); view.document.body.append(outside);
    if (focus === "outside") outside.focus();
    release(response(401, {})); await settle();
    const signIn = view.document.getElementById("player-link-signin") as HTMLAnchorElement;
    assert.equal(signIn.hidden, false);
    assert.equal(view.document.activeElement, focus === "outside" ? outside : signIn);
    assert.equal(view.storage.has("threefc.player-proof.v1"), false);
    assert.ok(!signIn.href.includes(secret));
    assert.equal((view.document.getElementById("account-actions") as HTMLElement).hidden, true);
  });
}

for (const outcome of ["success", "rejected", "wrong-player", "not-claimed"] as const) {
  for (const focus of ["retained", "outside"] as const) {
    test(`private player confirmation ${outcome} preserves ${focus} focus`, async (t) => {
      let release: ((result: unknown) => void) | undefined;
      const view = page({ url: `${origin}/link-player#proofId=${proofId}&secret=${secret}`,
        fetch: (path) => path.endsWith("/claim") ? new Promise(resolve => { release = resolve; }) : previewResponse() });
      t.after(() => view.dom.window.close());
      await settle();
      const button = view.document.getElementById("player-link-confirm") as HTMLButtonElement;
      button.focus(); button.click(); await settle(); assert(release);
      const outside = view.document.createElement("button"); view.document.body.append(outside);
      if (focus === "outside") outside.focus();
      release(outcome === "rejected" ? response(409, {}) : response(200, {
        player: { playerId: outcome === "wrong-player" ? "someone-else" : "xavier" },
        claim: { claimedByCurrentUser: outcome !== "not-claimed" },
      }));
      await settle();
      assert.equal(view.document.activeElement, focus === "outside" ? outside
        : view.document.getElementById(outcome === "success" ? "player-link-status" : outcome === "rejected" ? "player-link-retry" : "player-link-confirm"));
      assert.equal(button.hidden, outcome === "success" || outcome === "rejected");
      if (outcome === "wrong-player" || outcome === "not-claimed") {
        assert.match(view.document.getElementById("player-link-status")?.textContent ?? "", /could not be confirmed/);
      }
    });
  }
}

for (const stage of ["preview", "claim"] as const) {
  test(`private player purge fences a late ${stage} response`, async (t) => {
    let release: ((result: unknown) => void) | undefined;
    const view = page({ url: `${origin}/link-player#proofId=${proofId}&secret=${secret}`,
      fetch: (path) => path.endsWith(stage === "preview" ? "/preview" : "/claim")
        ? new Promise(resolve => { release = resolve; }) : previewResponse() });
    t.after(() => view.dom.window.close());
    await settle();
    if (stage === "claim") { (view.document.getElementById("player-link-confirm") as HTMLButtonElement).click(); await settle(); }
    assert(release); view.proof.clear();
    release(stage === "preview" ? previewResponse() : response(200, { player: { playerId: "xavier" }, claim: { claimedByCurrentUser: true } }));
    await settle();
    assert.equal(view.storage.has("threefc.player-proof.v1"), false);
    assert.equal((view.document.getElementById("player-link-details") as HTMLElement).hidden, true);
    assert.equal((view.document.getElementById("player-link-confirm") as HTMLElement).hidden, true);
    assert.doesNotMatch(view.document.getElementById("player-link-status")?.textContent ?? "", /Player linked/);
    assert.equal(await view.proof.read(proofId), null);
  });
}

for (const playerId of [".", "..", "player-\ud800", "player\\legacy", "player-" + "x".repeat(600)]) {
  test(`private player confirmation safely addresses ${playerId.length > 50 ? "long" : JSON.stringify(playerId)} identity`, async (t) => {
    const targets: string[] = [];
    const view = page({ url: `${origin}/link-player#proofId=${proofId}&secret=${secret}`,
      fetch: (path) => {
        if (path.endsWith("/preview")) return previewResponse(playerId);
        targets.push(path); return response(503, {});
      } });
    t.after(() => view.dom.window.close());
    await settle(); (view.document.getElementById("player-link-confirm") as HTMLButtonElement).click(); await settle();
    assert.deepEqual(targets, playerId === "." || playerId === ".." || playerId.includes("\ud800") ? []
      : [`/v1/players/${encodeURIComponent(playerId)}/claim`]);
  });
}
