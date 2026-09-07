import { expect, type Locator, type Page } from "@playwright/test";

/** Assert the real browser surface, not merely the presence of `hidden`. */
export async function expectActionSurfaceFits(page: Page, surface: Locator) {
  await expect(surface).toBeVisible();
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  const viewport = await page.evaluate(() => ({
    left: visualViewport?.offsetLeft ?? 0,
    top: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? innerWidth,
    height: visualViewport?.height ?? innerHeight,
  }));
  expect(bounds!.x).toBeGreaterThanOrEqual(viewport.left - 1);
  expect(bounds!.y).toBeGreaterThanOrEqual(viewport.top - 1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.left + viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.top + viewport.height + 1);
  await expect(surface).toHaveAttribute("role", "group");
  await expect(surface).toHaveAttribute("aria-label", /\S/);
  // A bounding box can fit while an ancestor clips or covers the surface.
  // Trial clicks perform browser hit-testing without activating any mutation.
  for (const action of await surface.locator('button:not(:disabled):not([aria-disabled="true"]), a[href]:not([aria-disabled="true"])').all()) {
    await action.click({ trial: true, timeout: 5_000 });
  }
}
