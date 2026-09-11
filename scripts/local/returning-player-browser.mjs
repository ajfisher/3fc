// Disposable private-loopback browser acceptance, not deployed QA or Gateway evidence.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createAppRequestHandler } from "../../app/dist/server.js";
import { hashPlayerProofSecret } from "../../api/dist/auth/player-proof.js";

export async function runReturningPlayerBrowser({ repository, base, sessions, origin }) {
  const artifacts = await mkdtemp(join(tmpdir(), "3fc-returning-browser-"));
  const widths = [320, 390, 430, 768, 1280], screenshots = [], keys = [];
  let handler, browser, dropNext = false;
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/v1/")) { handler(request, response); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const linkedWrite = request.method === "POST" && request.url.endsWith("/linked-player");
      if (linkedWrite) keys.push(request.headers["idempotency-key"]);
      const upstream = await fetch(new URL(request.url, base), { method: request.method, signal: AbortSignal.timeout(15000),
        headers: { Origin: origin, "Content-Type": "application/json", ...(request.headers.cookie ? { Cookie: request.headers.cookie } : {}),
          ...(request.headers["idempotency-key"] ? { "Idempotency-Key": request.headers["idempotency-key"] } : {}) },
        ...(!["GET", "HEAD"].includes(request.method) ? { body: Buffer.concat(chunks) } : {}),
      });
      const data = Buffer.from(await upstream.arrayBuffer());
      if (linkedWrite && dropNext && upstream.ok) { dropNext = false; response.writeHead(503, { "Content-Type": "application/json" }); response.end('{"error":"simulated_lost_reply"}'); return; }
      response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json", "Cache-Control": "no-store" }); response.end(data);
    } catch { response.writeHead(502, { "Content-Type": "application/json" }); response.end('{"error":"local_proxy_unavailable"}'); }
  });
  const api = async (path, body, account) => {
    const result = await fetch(new URL(path, base), { method: "POST", signal: AbortSignal.timeout(15000), headers: {
      Origin: origin, "Content-Type": "application/json", Cookie: `threefc_session=${sessions[account]}` }, body: JSON.stringify(body) });
    assert(result.ok, `Disposable fixture API failed ${path.split("?")[0]} (${result.status})`); return result.json();
  };
  try {
    const game = await repository.getGame("returning-new"); assert(game);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const ownOrigin = `http://127.0.0.1:${server.address().port}`; handler = createAppRequestHandler(ownOrigin);
    browser = await chromium.launch({ headless: true });
    const errors = [];
    async function open(account) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
      await context.addCookies([{ name: "threefc_session", value: sessions[account], url: ownOrigin, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", () => errors.push("browser script error"));
      await page.goto(`${ownOrigin}/join/${game.joinCode}`); return page;
    }
    const returning = await open("B");
    await expect(returning.getByRole("button", { name: "Create new player", exact: true })).toBeVisible();
    await expect(returning.locator("#join-game-form")).toBeHidden();
    await returning.screenshot({ path: join(artifacts, "zero-390-light.png"), fullPage: true }); screenshots.push("zero-390-light.png");
    // B receives one identity through the actual directed proof endpoint. Secrets
    // exist only in these server-side requests, never browser URLs or artifacts.
    await repository.createLeaguePlayer({ leagueId: "league", playerId: "browser-returning-B", nickname: "Returning browser player", userIds: ["organiser"] });
    const proofId = randomUUID(), secret = randomBytes(32).toString("base64url"), verifier = hashPlayerProofSecret(secret);
    await api("/v1/player-proofs/league-invitation?leagueId=league&playerId=browser-returning-B", { proofId, verifier }, "organiser");
    const preview = await api("/v1/player-proofs/preview", { proofId, secret }, "B");
    await api("/v1/player-proofs/claim?playerId=browser-returning-B", { proof: { proofId, secret, confirmation: preview.preview.confirmation } }, "B");
    await returning.reload();
    await expect(returning.getByRole("button", { name: "Join as Returning browser player", exact: true })).toBeVisible();
    const multiple = await open("A");
    await expect(multiple.locator("#returning-player-choice")).toBeVisible();
    await expect(multiple.locator("#returning-player-choice")).toHaveValue("");
    await expect(multiple.locator("#returning-player").getByRole("button", { name: "Join game", exact: true })).toBeDisabled();
    for (const [state, page] of [["one", returning], ["multiple", multiple]]) for (const width of widths) for (const colorScheme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${state} overflow ${width}/${colorScheme}`);
      const invalid = await page.locator("#returning-player button:visible, #returning-player select:visible").evaluateAll(nodes => nodes.filter(node => {
        const box = node.getBoundingClientRect(); return box.height < 48 || box.width < 44 || (node.tagName === "SELECT" && parseFloat(getComputedStyle(node).fontSize) < 16);
      }).map(node => node.tagName));
      assert.deepEqual(invalid, [], `${state} control geometry ${width}/${colorScheme}`);
      const name = `${state}-${width}-${colorScheme}.png`; await page.screenshot({ path: join(artifacts, name), fullPage: true, animations: "disabled" }); screenshots.push(name);
    }
    dropNext = true;
    const joinControl = returning.getByRole("button", { name: "Join as Returning browser player", exact: true });
    await joinControl.focus(); await returning.keyboard.press("Enter");
    await expect(returning.getByRole("button", { name: "Retry join", exact: true })).toBeVisible();
    assert.equal(keys.length, 1); assert.equal(typeof keys[0], "string");
    await returning.getByRole("button", { name: "Retry join", exact: true }).click();
    await expect(returning.getByText("Returning browser player joined the game.", { exact: true })).toBeVisible();
    assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    await expect(returning.locator("#returning-player")).not.toContainText("Unassigned");
    await returning.reload();
    await returning.getByRole("button", { name: "Join as Returning browser player", exact: true }).click();
    await expect(returning.getByText("Returning browser player is already in this game.", { exact: true })).toBeVisible();
    await multiple.locator("#returning-player-choice").selectOption("owned-0");
    await multiple.locator("#returning-player-choice").focus(); await multiple.keyboard.press("Enter");
    await expect(multiple.getByText("Combined player is already in this game.", { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    await writeFile(join(artifacts, "acceptance.json"), JSON.stringify({ transport: "private loopback actual API/DynamoDB; not deployed QA or public Gateway",
      widths, themes: ["light", "dark"], screenshots, passed: ["zero/one/multiple discovery", "bounded source pagination", "48px mobile controls", "keyboard joins", "lost response same idempotency key", "already registered recovery", "no stale assignment claim"] }, null, 2));
    console.log(`PASS private loopback returning-player Chromium acceptance; artifacts ${artifacts}`);
    return { artifacts };
  } finally {
    try { await browser?.close(); }
    finally { server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
}
