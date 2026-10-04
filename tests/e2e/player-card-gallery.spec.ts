import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_CONDITIONS, COMMON_MILESTONES, RARE_MILESTONES, milestoneOrdinal, milestoneThreshold } from '@3fc/contracts';

const freshness = { status: 'ready', coverage: 'complete', revision: 'r1', computedAt: '2026-10-03T10:00:00.000Z' };
const totals = { played: 10, goals: 5, assists: 3, ownGoals: 0, wins: 3, draws: 2, losses: 5, goalsPerGame: .5 };
const latest = { gameId: 'game-one', seasonId: 'winter', kickoffAt: '2026-10-02T10:00:00.000Z', finishedAt: '2026-10-02T11:00:00.000Z', teamId: 'red', outcome: 'win', goals: 2, assists: 1, ownGoals: 0, scored: 3, conceded: 1 };
const performance = { player: { playerId: 'player-one', displayName: 'Alex Rivera', hasPortrait: false }, league: { leagueId: 'league-one', name: 'Three-sided football' }, seasons: [{ seasonId: 'winter', name: 'Winter 2026' }], selectedSeasonId: 'winter', latest, season: totals, career: totals, freshness, capabilities: { editProfile: true, achievements: true } };
const counts: Record<string, number> = { goal: 5, played: 10, assist: 3, wins: 3, draw: 2, 'double-threat': 1 };
const catalogue = { ruleVersion: 1, achievements: ACHIEVEMENT_DEFINITIONS, conditions: ACHIEVEMENT_CONDITIONS, milestones: { common: COMMON_MILESTONES, rare: RARE_MILESTONES, commonRepeatEvery: 100, rareRepeatEvery: 10, legendaryRepeatEvery: 1, epicRepeatEvery: 1 } };
function achievements(scope: string, earned = true) {
  const scopeFields = { scope, seasonId: scope === 'season' ? 'winter' : null };
  const unlock = (id: string, ordinal: number, threshold: number) => ({ id: `${scope}-${id}-${ordinal}`, achievementId: id, ordinal, threshold, earnedAt: latest.finishedAt, gameId: latest.gameId, ...scopeFields });
  const progress = ACHIEVEMENT_DEFINITIONS.map(def => {
    const count = earned ? counts[def.id] ?? 0 : 0, ordinal = milestoneOrdinal(def.rarity, count);
    return { achievementId: def.id, count, ordinal, nextThreshold: milestoneThreshold(def.rarity, ordinal + 1), assessability: 'complete', currentRun: ['on-fire','helping-hand','unbeaten-run'].includes(def.id) ? 0 : null, highest: ordinal ? unlock(def.id, ordinal, milestoneThreshold(def.rarity, ordinal)) : null };
  });
  const honours = progress.flatMap(p => p.highest ? [p.highest] : []);
  return { ...scopeFields, playerId: 'player-one', leagueId: 'league-one', progress, honours, firstUnlocks: honours.map(a => ({ ...a, id: `${scope}-${a.achievementId}-1`, ordinal: 1, threshold: 1 })), latestUnlocks: honours, freshness };
}
async function mock(page: Page, options: { empty?: boolean; name?: string; portrait?: string } = {}) {
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url()); let body: unknown;
    if (url.pathname === '/v1/auth/session') body = { authenticated: true, session: { sessionId: 'synthetic-session', subject: 'synthetic-user', email: 'private@example.invalid' } };
    else if (url.pathname === '/v1/player-profile') body = { ...performance, player: { ...performance.player, displayName: options.name ?? performance.player.displayName, hasPortrait: Boolean(options.portrait) } };
    else if (url.pathname === '/v1/player-history') body = { matches: [latest], cursor: null, freshness };
    else if (url.pathname === '/v1/achievement-catalogue') body = catalogue;
    else if (url.pathname === '/v1/player-achievements') body = achievements(url.searchParams.get('scope')!, !options.empty);
    else if (url.pathname === '/v1/player-unlocks') body = { unlocks: achievements(url.searchParams.get('scope')!, !options.empty).honours, cursor: null, freshness };
    else if (url.pathname === '/v1/player-portrait' && options.portrait) { await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(options.portrait, 'base64') }); return; }
    else { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}
for (const width of [320, 390, 430, 1280]) for (const colorScheme of ['light', 'dark'] as const) {
  test(`gallery collection and detail ${width}px ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme }); await mock(page);
    await page.goto('/achievements?leagueId=league-one&playerId=player-one&seasonId=winter');
    await expect(page.locator('#achievement-grid > *')).toHaveCount(23);
    await expect(page.locator('body')).not.toContainText('private@example.invalid');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#achievement-search').fill('clutch'); await expect(page.locator('#achievement-grid > *')).toHaveCount(1);
    await page.locator('#achievement-open-clutch').click(); await expect(page.locator('#achievement-detail')).toBeVisible();
    await expect(page.locator('#achievement-detail-rule')).toContainText('final minute');
    await page.keyboard.press('Escape'); await expect(page.locator('#achievement-detail')).not.toBeVisible();
    await expect(page.locator('#achievement-open-clutch')).toBeFocused(); await expect(page.locator('#achievement-search')).toHaveValue('clutch');
    await page.locator('#achievement-reset').click(); await expect(page.locator('#achievement-grid > *')).toHaveCount(23);
    await page.locator('#achievement-earned').selectOption('earned'); await expect(page.locator('#achievement-grid > *')).toHaveCount(6);
    if (width === 390) await page.screenshot({ path: `/tmp/3fc-gallery-${colorScheme}.png`, fullPage: true });
  });
}
test('both Club Card sides export 1200 by 1560 PNG with five honours and focus return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 }); await mock(page);
  await page.goto('/player?leagueId=league-one&playerId=player-one&seasonId=winter');
  await page.locator('#player-card').click(); await expect(page.locator('#club-card-dialog')).toBeVisible();
  for (const side of ['front', 'honours']) {
    await expect(page.locator('#club-card-download')).toBeEnabled();
    const pending = page.waitForEvent('download'); await page.locator('#club-card-download').click(); const download = await pending;
    const png = await readFile((await download.path())!); expect(png.subarray(1, 4).toString()).toBe('PNG'); expect(png.readUInt32BE(16)).toBe(1200); expect(png.readUInt32BE(20)).toBe(1560);
    await download.saveAs(`/tmp/3fc-card-${side}.png`);
    await expect(page.locator('#club-card-art')).not.toContainText('private@example.invalid');
    if (side === 'front') await page.locator('#club-card-flip').click();
  }
  await expect(page.locator('#club-card-honours-links')).toHaveCount(0);
  await expect(page.locator('#club-card-gallery')).toHaveText('All achievements');
  await expect(page.locator('#club-card-gallery')).toHaveAttribute('href', /scope=season/);
  await expect(page.locator('#club-card-flip')).toHaveText('Statistics');
  await expect(page.locator('#club-card-art')).toContainText('TOP ACHIEVEMENTS');
  expect(await page.locator('#club-card-art .badge-art').evaluateAll(nodes => nodes.map(node => ({ css: getComputedStyle(node).width, width: (node as SVGSVGElement).width.baseVal.value })))).toEqual(Array(5).fill({ css: 'auto', width: 160 }));
  await page.keyboard.press('Escape'); await expect(page.locator('#player-card')).toBeFocused();
});
test('native file sharing is invoked during user activation with a prepared PNG', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'canShare', { value: () => true }); Object.defineProperty(navigator, 'share', { value: async (data: ShareData) => { (window as unknown as { shared: unknown }).shared = { active: navigator.userActivation.isActive, type: data.files?.[0].type, size: data.files?.[0].size }; } }); });
  await mock(page); await page.goto('/player?leagueId=league-one&playerId=player-one'); await page.locator('#player-card').click();
  await expect(page.locator('#club-card-share')).toBeEnabled(); await page.locator('#club-card-share').click();
  expect(await page.evaluate(() => (window as unknown as { shared: unknown }).shared)).toMatchObject({ active: true, type: 'image/png' });
});
test('contextless gallery and empty card are honest, with keyboard usable at enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); await mock(page, { empty: true, name: 'Alexandra Riverstone Fernández-Williams' });
  await page.goto('/achievements'); await expect(page.locator('#achievement-grid > *')).toHaveCount(23); await expect(page.locator('#achievement-earned-field')).not.toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/player?leagueId=league-one&playerId=player-one'); await page.locator('#player-card').click(); await page.locator('#club-card-flip').click();
  await expect(page.locator('#club-card-art')).toContainText(/first|next|honours|story/i); await expect(page.locator('#club-card-honours-links')).toHaveCount(0);
  await expect(page.locator('#club-card-download')).toBeEnabled();
});

test('the authorised portrait is embedded in the actual exported PNG', async ({ page }) => {
  const portrait = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512; const context = canvas.getContext('2d')!; context.fillStyle = '#d9b769'; context.fillRect(0, 0, 512, 512); return canvas.toDataURL('image/png').split(',')[1]; });
  await mock(page, { portrait }); await page.goto('/player?leagueId=league-one&playerId=player-one');
  await expect(page.locator('#player-avatar img')).toBeVisible(); await page.locator('#player-card').click();
  await expect(page.locator('#club-card-download')).toBeEnabled();
  const pending = page.waitForEvent('download'); await page.locator('#club-card-download').click(); const downloaded = await pending;
  const png = await readFile((await downloaded.path())!);
  const pixel = await page.evaluate(async bytes => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })); const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1560; const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); const result = Array.from(context.getImageData(600, 450, 1, 1).data); bitmap.close(); return result; }, Array.from(png));
  expect(pixel).toEqual([217, 183, 105, 255]);
});


test('card title and close stay aligned at enlarged text on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); await mock(page, { name: 'Alexandra Riverstone Fernández-Williams' });
  await page.goto('/player?leagueId=league-one&playerId=player-one');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#player-card').click();
  const header = page.locator('#club-card-dialog > header');
  await expect(header).toHaveCSS('align-items', 'center');
  expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.locator('#club-card-close').click(); await expect(page.locator('#player-card')).toBeFocused();
});
