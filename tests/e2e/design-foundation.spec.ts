import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderComponentShowcasePage,
  renderGamePage,
  renderInvitePage,
  renderJoinPage,
  renderMagicLinkCallbackPage,
} from "../../app/dist/ui/layout.js";

// These browser fixtures use the built renderers and local assets, not QA or
// the fake-email/database-dependent M2 workflow. Build the app before running.
const styles = readFileSync(resolve("app/dist/ui/styles.css"), "utf8");
const icons = readFileSync(resolve("app/dist/ui/icons.css"), "utf8");
const modalScript = readFileSync(resolve("app/dist/ui/modal.js"), "utf8");
const setupScript = readFileSync(resolve("app/dist/ui/setup-flow.js"), "utf8");

async function mount(page: Page, html: string) {
  await page.route("**/*", (route) => route.abort());
  await page.setContent(html.replace(/<link[^>]+>/g, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
  await page.addStyleTag({ content: styles + icons });
}

async function expectNoOverflow(page: Page, width: number) {
  const layout = await page.evaluate(expectedWidth => ({
    scroll: document.documentElement.scrollWidth,
    inner: innerWidth,
    overflowing: [...document.querySelectorAll<HTMLElement>("body *")].filter(element => {
      const box = element.getBoundingClientRect();
      return box.width && (box.right > expectedWidth || element.scrollWidth > element.clientWidth + 1);
    }).map(element => ({tag:element.tagName,id:element.id,ui:element.dataset.ui,right:element.getBoundingClientRect().right,scroll:element.scrollWidth,client:element.clientWidth})),
  }),width);
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(width);
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [320, 390, 430, 768, 1280]) {
    test(`foundation ${colorScheme} at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await mount(page, renderComponentShowcasePage("http://fixture.invalid"));
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
      await expect(page.locator("body")).toHaveCSS("font-size", "16px");
      await expect(page.locator("body")).toHaveCSS("background-color", colorScheme === "light" ? "rgb(245, 246, 242)" : "rgb(19, 27, 24)");
      for (const hidden of await page.locator("[hidden]").all()) {
        await expect(hidden).toHaveCSS("display", "none");
      }
      const controls = page.locator('[data-testid="fixture-button-variants"] button, [data-ui="icon-button"], [data-ui="icon-link"], [data-ui="input"], [data-testid="fixture-team-choices"] label');
      for (const control of await controls.all()) {
        if (!await control.isVisible()) continue;
        const box = await control.boundingBox();
        expect(box?.height, await control.getAttribute("aria-label") || await control.textContent() || "Visible control").toBeGreaterThanOrEqual(44);
      }
      for (const field of await page.locator('[data-ui="input"]').all()) {
        if (await field.isVisible()) await expect(field).toHaveCSS("font-size", "16px");
      }
      await expect(page.getByTestId("fixture-feedback-states").getByText("Player added.", { exact:true })).toBeVisible();
      await expect(page.getByTestId("fixture-feedback-states").getByText(/couldn’t confirm whether the goal was saved/)).toBeVisible();
      const button = page.getByRole("button", { name:"Primary example", exact:true });
      await button.focus();
      await expect(button).toHaveCSS("outline-style", "solid");
      await expect(button).toHaveCSS("outline-width", "3px");
    });
  }
}

test("hidden entry states stay hidden and modal icon-child clicks preserve focus", async ({ page }) => {
  await page.setViewportSize({ width:390, height:844 });
  for (const html of [renderJoinPage("http://fixture.invalid", "ABCDEFGH"), renderInvitePage("http://fixture.invalid", ""), renderInvitePage("http://fixture.invalid", "ABCDEFGH"), renderMagicLinkCallbackPage("http://fixture.invalid")]) {
    await mount(page, html);
    for (const hidden of await page.locator("[hidden]").all()) await expect(hidden).toHaveCSS("display", "none");
  }
  await mount(page, renderComponentShowcasePage("http://fixture.invalid"));
  await page.addScriptTag({content:modalScript});
  const trigger = page.getByRole("button", { name:"Open example edit prompt", exact:true });
  await trigger.locator('[data-ui="icon"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", {name:"Cancel", exact:true})).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button").last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", {name:"Cancel", exact:true})).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("hidden-rule mutation exposes the original display override in Chromium", async ({ page }) => {
  await mount(page, renderInvitePage("http://fixture.invalid", "ABCDEFGH"));
  const hiddenForm = page.locator('[data-ui="auth-form"][hidden]').first();
  await expect(hiddenForm).toHaveCSS("display", "none");
  await page.locator("style").evaluateAll((sheets) => sheets.forEach((sheet) => {
    sheet.textContent = sheet.textContent!.replace(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/, "");
  }));
  await expect(hiddenForm).toHaveCSS("display", "grid");
});

async function mountRunningGame(page: Page) {
  const now = new Date().toISOString();
  const teams = ["Red", "Blue", "Yellow"].map((name, index) => ({
    teamId: name.toLowerCase(), name, color: ["#d93838", "#2461d1", "#e5bd24"][index], scored: index + 1, conceded: 3 - index,
  }));
  const players = Array.from({length:18}, (_, index) => ({playerId:`player-${index}`, nickname:index === 0 ? "Alexandra Montgomery-Williams" : `Fixture Player ${index + 1}`, claimedByUserId:index === 0 ? "fixture-user" : null}));
  const payloads: Record<string, unknown> = {
    "/v1/auth/session": {authenticated:true,session:{sessionId:"fixture-session", email:"fixture@example.invalid", createdAt:now, expiresAt:"2099-01-01T00:00:00Z"}},
    "/v1/games/fixture-game": {gameId:"fixture-game", leagueId:"fixture-league", seasonId:"fixture-season", status:"live", gameStartTs:now, thirdLengthMinutes:25, thirds:[1,2,3].map(third => ({third, status:third===1 ? "running" : "not_started", startedAt:third===1 ? now:null, finishedAt:null}))},
    "/v1/leagues/fixture-league": {leagueId:"fixture-league",name:"Fixture league",access:{role:"admin"}},
    "/v1/leagues/fixture-league/seasons/fixture-season": {leagueId:"fixture-league",seasonId:"fixture-season",name:"Fixture season"},
    "/v1/games/fixture-game/players": {players},
    "/v1/games/fixture-game/roster": {teams, roster:players.map((player,index)=>({playerId:player.playerId,teamId:teams[index%3].teamId,player}))},
    "/v1/games/fixture-game/goals": {timeline:[],scoreboard:{teams}},
  };
  const unexpected: string[] = [];
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().isNavigationRequest() && path === "/games/fixture-game") {
      await route.fulfill({contentType:"text/html",body:renderGamePage("http://fixture.invalid",{gameId:"fixture-game"}).replace(/<link[^>]+>/g, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")});
    } else if (route.request().method() === "GET" && path in payloads) {
      await route.fulfill({json:payloads[path]});
    } else {
      unexpected.push(`${route.request().method()} ${path}`);
      await route.abort();
    }
  });
  await page.goto("http://fixture.invalid/games/fixture-game#score");
  await page.addStyleTag({content:styles+icons});
  await page.addScriptTag({content:setupScript});
  await expect(page.locator('[data-ui="score-team"]')).toHaveCount(3);
  await expect(page.getByTestId("game-mode-run")).toBeVisible();
  await expect(page).toHaveURL("http://fixture.invalid/games/fixture-game#score");
  return unexpected;
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`current scoring and roster ${colorScheme} remain readable on phones and tablets`, async ({page}, testInfo) => {
    await page.emulateMedia({colorScheme});
    await page.setViewportSize({width:320,height:900});
    const unexpected = await mountRunningGame(page);
    await expect(page.getByTestId("start-third")).toBeDisabled();
    await expect(page.getByTestId("finish-third")).toBeEnabled();
    const scoringTeam = page.getByTestId("goal-scoring-team").getByRole("radio", {name:"Red",exact:true});
    const concedingTeam = page.getByTestId("goal-conceding-team").getByRole("radio", {name:"Blue",exact:true});
    await scoringTeam.check();
    await concedingTeam.check();
    await expect(scoringTeam).toBeChecked();
    await expect(concedingTeam).toBeChecked();
    await page.getByTestId("goal-scorer").selectOption("player-0");
    await page.getByTestId("add-goal").focus();
    await expect(page.getByTestId("add-goal")).toHaveCSS("outline-width","3px");
    for (const scale of [100,200]) {
      await page.evaluate(value => document.documentElement.style.fontSize = `${value}%`,scale);
      await expectNoOverflow(page,320);
      // Word fragmentation is a reflow failure even when the page fits.
      const assistText = page.locator("#goal-assists-summary");
      const assistWidth = await assistText.evaluate(element => element.getBoundingClientRect().width);
      const longestWordWidth = await assistText.evaluate(element => {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        context.font = getComputedStyle(element).font;
        return Math.max(...element.textContent!.split(/\s+/).map(word => context.measureText(word).width));
      });
      expect(assistWidth).toBeGreaterThanOrEqual(longestWordWidth);
      for (const row of await page.locator('[data-ui="score-team"] dl > div').all()) {
        const label = await row.locator("dt").boundingBox();
        const value = await row.locator("dd").boundingBox();
        expect(label!.x + label!.width <= value!.x || label!.y + label!.height <= value!.y).toBeTruthy();
      }
      await page.screenshot({path:testInfo.outputPath(`scoring-${colorScheme}-${scale}.png`),fullPage:true});
      await page.getByTestId("run-primary-scoring").screenshot({path:testInfo.outputPath(`goal-entry-${colorScheme}-${scale}.png`)});
    }
    await page.evaluate(()=>document.documentElement.style.fontSize = "100%");
    await expect(page.getByTestId("game-mode-players-tab")).toHaveAttribute("href", "#teams");
    await page.getByTestId("game-mode-players-tab").click();
    await expect(page).toHaveURL("http://fixture.invalid/games/fixture-game#teams");
    await expect(page.getByTestId("game-mode-players")).toBeVisible();
    for (const width of [320,768]) {
      for (const scale of [100,200]) {
        await page.setViewportSize({width,height:900});
        await page.evaluate(value => document.documentElement.style.fontSize = `${value}%`,scale);
        await expectNoOverflow(page,width);
        await page.screenshot({path:testInfo.outputPath(`roster-${colorScheme}-${width}-${scale}.png`),fullPage:true});
      }
    }
    expect(unexpected).toEqual([]);
  });
}

test("foundation accommodates enlarged text without page overflow", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await mount(page, renderComponentShowcasePage("http://fixture.invalid"));
  await page.addStyleTag({content:"html { font-size: 200%; }"});
  await expectNoOverflow(page,390);
  await expect(page.getByRole("heading",{name:"Design fixtures"})).toBeVisible();
});
