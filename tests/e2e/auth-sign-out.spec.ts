import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderSetupHomePage, renderSignInPage } from "../../app/dist/ui/layout.js";

// Browser transport fixtures never contact QA, send email, or use real accounts.
// Backend revocation is proved separately by local/Lambda/service tests.
const origin = "https://3fc.fixture.test";
const assets = new Map(["styles.css", "icons.css", "setup-flow.js", "auth-flow.js"].map(name => [
  `/ui/${name}`, readFileSync(resolve("app/dist/ui", name), "utf8"),
]));

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [320, 390, 1280]) {
    test(`sign out keyboard pending/retry and cookie navigation ${colorScheme} ${width}`, async ({ page, context }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await context.addCookies([{ name: "threefc_session", value: "fictional-session", url: origin, httpOnly: true, secure: true, sameSite: "Lax" }]);
      let loggedOut = false;
      let logoutRequests = 0;
      let releaseFailure: () => void = () => {};
      const failureReleased = new Promise<void>(resolve => { releaseFailure = resolve; });
      const unexpected: string[] = [];
      await page.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
        const asset = assets.get(url.pathname);
        if (asset !== undefined) return route.fulfill({ body: asset, contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
        if (url.pathname === "/setup") return route.fulfill({ contentType: "text/html", body: renderSetupHomePage(origin) });
        if (url.pathname === "/sign-in") return route.fulfill({ contentType: "text/html", body: renderSignInPage(origin, "/setup") });
        if (url.pathname === "/v1/auth/session") {
          const authenticated = !loggedOut && (request.headers().cookie ?? "").includes("threefc_session=fictional-session");
          return route.fulfill({ status: authenticated ? 200 : 401, headers: { "cache-control": "no-store" }, contentType: "application/json", body: JSON.stringify(authenticated ? { authenticated: true, session: { sessionId: "fictional-sign-out-session", email: "fixture@example.com" } } : { error: "unauthorized" }) });
        }
        if (url.pathname === "/v1/leagues") return route.fulfill({ json: { leagues: [] } });
        if (url.pathname === "/v1/auth/logout" && request.method() === "POST") {
          logoutRequests += 1;
          expect(request.postData()).toBeNull();
          if (logoutRequests === 1) {
            await failureReleased;
            return route.fulfill({ status: 503, json: { error: "logout_unavailable" } });
          }
          loggedOut = true;
          return route.fulfill({ status: 204, headers: { "cache-control": "no-store", "set-cookie": "threefc_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT" }, body: "" });
        }
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      });
      await page.goto(`${origin}/setup`);
      const button = page.getByRole("button", { name: "Sign out", exact: true });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await page.getByLabel("League name", { exact: true }).fill("Retain my draft");
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toBeDisabled();
      await expect(page.locator("#sign-out-status")).toHaveText("Signing out…");
      await page.keyboard.press("Enter");
      expect(logoutRequests).toBe(1);
      releaseFailure();
      await expect(button).toBeEnabled();
      await expect(button).toBeFocused();
      await expect(page.locator("#sign-out-status")).toBeVisible();
      await expect(page.locator("#sign-out-status")).toHaveText("Sign out could not be confirmed. Please try again.");
      await expect(page.getByLabel("League name", { exact: true })).toHaveValue("Retain my draft");
      const dimensions = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.inner);
      if (width === 320) await page.screenshot({ path: testInfo.outputPath(`sign-out-${colorScheme}-retry-320.png`), fullPage: true });
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${origin}/sign-in`);
      await expect(page.getByRole("heading", { name: "Sign in to 3FC" })).toBeVisible();
      expect((await context.cookies(origin)).some(cookie => cookie.name === "threefc_session")).toBe(false);
      expect(logoutRequests).toBe(2);
      // A fresh protected-page visit cannot bounce back into a cached session.
      await page.goto(`${origin}/setup`);
      await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
      expect(unexpected).toEqual([]);
    });
  }
}
