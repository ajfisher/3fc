// Private loopback browser acceptance over the actual local API/DynamoDB harness.
// This is not public API Gateway, deployed QA, or physical-device evidence.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createAppRequestHandler } from "../../app/dist/server.js";

export async function runConsolidationBrowser({ repository, base, sessions, origin }) {
  const artifacts = await mkdtemp(join(tmpdir(), "3fc-consolidation-browser-"));
  let browser;
  let handler;
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/v1/")) { handler(request, response); return; }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(new URL(request.url, base), {
        method: request.method, signal: AbortSignal.timeout(15000),
        headers: { Origin: origin, "Content-Type": "application/json", ...(request.headers.cookie ? { Cookie: request.headers.cookie } : {}) },
        ...(!["GET", "HEAD"].includes(request.method) ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json", "Cache-Control": "no-store" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(502, { "Content-Type": "application/json" }); response.end('{"error":"local_proxy_unavailable"}'); }
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const ownOrigin = `http://127.0.0.1:${server.address().port}`;
    handler = createAppRequestHandler(ownOrigin);
    for (const [index, suffix] of ["a", "b"].entries()) {
      await repository.createLeaguePlayer({ leagueId: "league", playerId: `browser-${suffix}`,
        nickname: `Browser fixture ${suffix.toUpperCase()}`, userIds: ["organiser"] });
      await repository.createGame({ gameId: `browser-game-${suffix}`, leagueId: "league", seasonId: "season",
        sessionId: randomUUID(), gameStartTs: `2026-09-${index ? "08" : "01"}T09:30:00.000Z` });
      await repository.addExistingLeaguePlayer({ gameId: `browser-game-${suffix}`, playerId: `browser-${suffix}`, userIds: ["organiser"] });
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    await context.addCookies([{ name: "threefc_session", value: sessions.organiser, url: ownOrigin, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const failures = [];
    page.on("pageerror", () => failures.push("Unexpected browser script error"));
    await page.goto(`${ownOrigin}/leagues/league#players`);
    const search = page.locator("#league-player-search");
    await search.fill("Browser fixture"); await search.press("Enter");
    await expect(page.locator("#league-player-list > li[data-player-id]")).toHaveCount(2);
    await page.getByRole("button", { name: "Combine profiles", exact: true }).click();
    for (const id of ["browser-a", "browser-b"]) {
      const checkbox = page.locator(`[data-consolidation-select][data-player-id="${id}"]`);
      await expect(checkbox).toBeEnabled(); await checkbox.focus(); await page.keyboard.press("Space"); await expect(checkbox).toBeChecked();
    }
    const panel = page.getByRole("region", { name: "Combine player profiles", exact: true });
    await expect(panel.locator('[data-ui="consolidation-selection-table"] tbody ul li')).toHaveCount(2);
    await panel.getByLabel("Player name", { exact: true }).focus(); await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "Combine profiles", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Combine profiles", exact: true }).click();
    await expect(panel.getByLabel("Player name", { exact: true })).toHaveValue("");
    for (const id of ["browser-a", "browser-b"]) await page.locator(`[data-consolidation-select][data-player-id="${id}"]`).check();
    await expect(panel.getByLabel("Player name", { exact: true })).toHaveValue("Browser fixture A");
    const captures = [];
    for (const width of [320, 390, 430, 768, 1280]) for (const colorScheme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      const fields = await panel.locator('[data-ui="field"] [data-ui="input"]').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(), field = node.closest('[data-ui="field"]').getBoundingClientRect();
        return { height: box.height, width: box.width, fieldWidth: field.width, font: parseFloat(getComputedStyle(node).fontSize) };
      }));
      assert.equal(fields.length, 2);
      for (const field of fields) assert(field.height >= 48 && Math.abs(field.width - field.fieldWidth) <= 2 && field.font >= 16,
        `Full-width 48px/16px editor control at ${width}/${colorScheme}: ${JSON.stringify(field)}`);
      const labels = await page.locator('[data-consolidation-select]').evaluateAll(nodes => nodes.map(node => node.closest("label").getBoundingClientRect().height));
      assert(labels.every(height => height >= 44), `Checkbox effective labels at ${width}/${colorScheme}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Editor overflow at ${width}/${colorScheme}`);
      const name = `selection-${width}-${colorScheme}.png`;
      await page.screenshot({ path: join(artifacts, name), fullPage: true, animations: "disabled" }); captures.push(name);
    }
    await page.getByRole("button", { name: "Review profiles", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Keep Browser fixture A", exact: true })).toBeVisible();
    await expect(panel.locator('[data-ui="consolidation-editor"]')).toBeHidden();
    assert.equal(await page.locator('[data-consolidation-select]:visible').count(), 0);
    for (const width of [320, 390, 430, 768, 1280]) for (const colorScheme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Page overflow at ${width}/${colorScheme}`);
      const tooSmall = await panel.locator("button:visible").evaluateAll(buttons => buttons.filter(button => {
        const box = button.getBoundingClientRect(); return box.width < 44 || box.height < 44;
      }).map(button => button.textContent));
      assert.deepEqual(tooSmall, [], `Consolidation touch targets at ${width}/${colorScheme}`);
      const name = `preview-${width}-${colorScheme}.png`;
      await page.screenshot({ path: join(artifacts, name), fullPage: true, animations: "disabled" }); captures.push(name);
    }
    await panel.getByRole("button", { name: "Combine profiles", exact: true }).click();
    await expect(panel.getByText("Profiles combined as Browser fixture A.", { exact: true })).toBeVisible();
    await expect(page.locator("#league-player-list > li[data-player-id]")).toHaveCount(1);
    assert.equal(await page.locator('#league-player-list > li[data-player-id="browser-a"]').count(), 1);

    // A second task must not inherit the first committed proposal or require a reload.
    for (const suffix of ["c", "d"]) await repository.createLeaguePlayer({ leagueId: "league", playerId: `browser-${suffix}`,
      nickname: `Second fixture ${suffix.toUpperCase()}`, userIds: ["organiser"] });
    await panel.getByRole("button", { name: "Combine more", exact: true }).click();
    await search.fill("Second fixture"); await search.press("Enter");
    for (const id of ["browser-c", "browser-d"]) await page.locator(`[data-consolidation-select][data-player-id="${id}"]`).check();
    await page.getByRole("button", { name: "Review profiles", exact: true }).click();
    await panel.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.locator('[data-consolidation-select]:checked')).toHaveCount(2);
    await page.getByRole("button", { name: "Review profiles", exact: true }).click();
    await panel.getByRole("button", { name: "Combine profiles", exact: true }).click();
    await expect(panel.getByText("Profiles combined as Second fixture C.", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Back to players", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(page.locator("#league-player-list > li[data-player-id]")).toHaveCount(1);

    // claim-a/b are disposable fixtures claimed through the actual proof API by
    // the parent harness. Their earlier stale preview has never been committed.
    const proposalId = randomUUID();
    await repository.previewPlayerConsolidation({ proposalId, leagueId: "league", playerIds: ["claim-a", "claim-b"],
      retainedPlayerId: "claim-a", nickname: "Browser approved player", userIds: ["organiser"] });
    await page.goto(`${ownOrigin}/combine-players?proposalId=${proposalId}`);
    const approvalLink = page.getByLabel("Player approval link", { exact: true });
    await expect(approvalLink).toBeVisible();
    for (const width of [320, 390]) for (const colorScheme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      const field = await approvalLink.evaluate(node => {
        const box = node.getBoundingClientRect(), parent = node.closest('[data-ui="field"]').getBoundingClientRect();
        return { height: box.height, width: box.width, fieldWidth: parent.width, font: parseFloat(getComputedStyle(node).fontSize), readonly: node.readOnly };
      });
      assert(field.readonly && field.height >= 48 && Math.abs(field.width - field.fieldWidth) <= 2 && field.font >= 16,
        `Approval link field geometry at ${width}/${colorScheme}: ${JSON.stringify(field)}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Approval sharing overflow at ${width}/${colorScheme}`);
      const name = `organiser-approval-${width}-${colorScheme}.png`;
      await page.screenshot({ path: join(artifacts, name), fullPage: true, animations: "disabled" }); captures.push(name);
    }
    const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    await ownerContext.addCookies([{ name: "threefc_session", value: sessions.A, url: ownOrigin, httpOnly: true, sameSite: "Lax" }]);
    const owner = await ownerContext.newPage(); owner.setDefaultTimeout(15000);
    owner.on("pageerror", () => failures.push("Unexpected owner browser script error"));
    await owner.goto(`${ownOrigin}/combine-players?proposalId=${proposalId}`);
    await expect(owner.getByRole("button", { name: "Approve these profiles", exact: true })).toBeVisible();
    assert.equal((await repository.getPlayerConsolidation({ proposalId, userIds: ["organiser"] })).status, "pending_approval");
    await owner.screenshot({ path: join(artifacts, "owner-approval-390-light.png"), fullPage: true, animations: "disabled" });
    await owner.getByRole("button", { name: "Approve these profiles", exact: true }).click();
    await expect(owner.getByText("Approval recorded. The organiser can now combine these profiles.", { exact: true })).toBeVisible();
    assert.equal((await repository.getPlayerConsolidation({ proposalId, userIds: ["organiser"] })).status, "ready");
    await page.goto(`${ownOrigin}/combine-players?proposalId=${proposalId}`);
    await page.getByRole("button", { name: "Combine profiles", exact: true }).click();
    await expect(page.getByText("Profiles combined as Browser approved player.", { exact: true })).toBeVisible();
    assert.equal((await repository.getPlayerConsolidation({ proposalId, userIds: ["organiser"] })).status, "committed");
    assert.deepEqual(failures, []);
    await writeFile(join(artifacts, "acceptance.json"), JSON.stringify({ transport: "private loopback proxy to actual local API/DynamoDB; not public Gateway or deployed QA",
      widths: [320, 390, 430, 768, 1280], themes: ["light", "dark"], screenshots: [...captures, "owner-approval-390-light.png"],
      passed: ["two selected profiles preview", "no horizontal overflow", "44px consolidation buttons", "explicit unclaimed commit and one directory identity", "separate owner approval before organiser commit"] }, null, 2));
    console.log(`PASS private loopback Chromium consolidation acceptance; artifacts ${artifacts}`);
    return { artifacts };
  } finally {
    try { await browser?.close(); }
    finally { server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
}
