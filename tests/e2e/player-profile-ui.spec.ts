import { test, expect, type Page } from '@playwright/test';

const freshness = { status: 'ready', coverage: 'complete', revision: 'revision-1', computedAt: '2026-10-03T10:00:00.000Z' };
const matches = Array.from({ length: 21 }, (_, i) => ({ gameId: `game-${21 - i}`, seasonId: 'winter', kickoffAt: `2026-09-${String(28 - i).padStart(2, '0')}T10:00:00.000Z`, finishedAt: `2026-09-${String(28 - i).padStart(2, '0')}T11:00:00.000Z`, teamId: 'red', outcome: i < 7 ? 'win' : i < 14 ? 'draw' : 'loss', goals: i === 0 ? 2 : i === 1 ? 3 : 0, assists: i === 0 ? 1 : 0, ownGoals: 0, scored: 3, conceded: 2 }));
const performance = {
  player: { playerId: 'player-one', displayName: 'Alex Rivera', hasPortrait: false }, league: { leagueId: 'league-one', name: 'Three-sided football' },
  seasons: [{ seasonId: 'winter', name: 'Winter 2026' }], selectedSeasonId: 'winter', latest: matches[0],
  season: { played: 21, goals: 5, assists: 1, ownGoals: 0, wins: 7, draws: 7, losses: 7, goalsPerGame: 5 / 21 },
  career: { played: 24, goals: 10, assists: 4, ownGoals: 0, wins: 8, draws: 8, losses: 8, goalsPerGame: 10 / 24 },
  freshness, capabilities: { editProfile: true, achievements: false },
};
async function mockApi(page: Page, profile = performance) {
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === '/v1/auth/session') body = { authenticated: true, session: { sessionId: 'synthetic-session', subject: 'synthetic-user', email: 'private@example.invalid' } };
    else if (url.pathname === '/v1/player-profile') body = profile;
    else if (url.pathname === '/v1/player-history') body = { matches: url.searchParams.has('cursor') ? matches.slice(20) : matches.slice(0, 20), cursor: url.searchParams.has('cursor') ? null : 'next-page', freshness };
    else if (url.pathname === '/v1/owner-player-profile') body = { playerId: 'player-one', displayName: 'Alex Rivera', email: 'private@example.invalid', hasPortrait: false, revision: 'a'.repeat(64) };
    else { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
  });
}

for (const width of [320, 390, 430, 1280]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`profile grid and history at ${width}px ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme }); await mockApi(page);
      await page.goto('/player?leagueId=league-one&playerId=player-one&seasonId=winter');
      await expect(page.locator('#player-name')).toHaveText('Alex Rivera');
      await expect(page.locator('#player-stats')).toContainText('21');
      await expect(page.locator('#player-history-list > li')).toHaveCount(20);
      await expect(page.locator('#player-latest')).not.toBeVisible();
      await expect(page.locator('body')).not.toContainText('private@example.invalid');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('#player-history-more').click();
      await expect(page.locator('#player-history-list > li')).toHaveCount(21);
      await page.locator('#player-period label').filter({ hasText: 'Career' }).click();
      await expect(page.locator('#player-stats')).toContainText('24');
      await expect(page.locator('#player-latest')).not.toBeVisible();
      await expect(page.locator('#player-history-list')).toBeVisible();
      await page.locator('#player-period label').filter({ hasText: 'Last game' }).click();
      await expect(page.locator('#player-stats')).toContainText('2');
      await expect(page.locator('#player-latest')).toBeVisible();
      await expect(page.locator('#player-latest')).toContainText('Team: 3 scored, 2 conceded');
      await expect(page.locator('#player-latest')).not.toContainText('assists');
      await expect(page.locator('#player-history-list')).not.toBeVisible();
      await expect(page.locator('#player-stats > div').first()).toHaveCSS('text-align', 'center');
      await expect(page.locator('[data-ui=panel] #player-card')).toBeVisible();
      if (width === 390) await page.screenshot({ path: `/tmp/3fc-profile-${colorScheme}.png`, fullPage: true });
    });
  }
}

test('owner settings are separate and crop can be dismissed with focus restored', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 }); await mockApi(page);
  await page.goto('/player-settings?leagueId=league-one&playerId=player-one');
  await expect(page.locator('#owner-name')).toHaveValue('Alex Rivera');
  await expect(page.locator('#owner-email')).toHaveValue('private@example.invalid');
  await expect(page.locator('#owner-email')).toHaveAttribute('readonly', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400; const c = canvas.getContext('2d')!; c.fillStyle = '#125f45'; c.fillRect(0, 0, 600, 400); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.locator('#owner-photo-file').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#portrait-crop-dialog')).toBeVisible();
  await page.locator('#portrait-crop-zoom').focus(); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape'); await expect(page.locator('#portrait-crop-dialog')).not.toBeVisible();
  await expect(page.locator('#owner-photo-file')).toBeFocused();
});


test('long names and enlarged text retain keyboard period controls without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mockApi(page, { ...performance, player: { ...performance.player, displayName: 'Alexandra Riverstone Fernández-Williams' } });
  await page.goto('/player?leagueId=league-one&playerId=player-one');
  await expect(page.locator('#player-name')).toContainText('Alexandra');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const seasonField = page.locator('[data-ui=field]').filter({ has: page.locator('#player-season') });
  await expect(seasonField).toBeVisible();
  await page.locator('input[name=player-period][value=season]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('input[name=player-period][value=career]')).toBeChecked();
  await expect(page.locator('#player-stats')).toContainText('24');
  await expect(seasonField).not.toBeVisible();
});

test('existing private portrait is visible on both profile and scoped owner settings', async ({ page }) => {
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512; const c = canvas.getContext('2d')!; c.fillStyle = '#d9b769'; c.fillRect(0, 0, 512, 512); return canvas.toDataURL('image/png').split(',')[1]; });
  await mockApi(page, { ...performance, player: { ...performance.player, hasPortrait: true } });
  await page.route('**/v1/player-portrait?*', route => route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: Buffer.from(png, 'base64') }));
  await page.route('**/v1/owner-player-profile?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ playerId: 'player-one', displayName: 'Alex Rivera', email: 'private@example.invalid', hasPortrait: true, revision: 'a'.repeat(64) }) }));
  await page.goto('/player?leagueId=league-one&playerId=player-one&seasonId=winter');
  await expect(page.locator('#player-avatar img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.locator('#player-edit').click();
  await expect(page.locator('#owner-photo-preview')).toBeVisible();
  await expect(page.locator('#owner-photo-preview')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.locator('#owner-photo-remove')).toBeVisible();
});

test('photo selection survives focus verification, then crops, previews and uploads on Save portrait', async ({ page }) => {
  await mockApi(page);
  let uploaded: Buffer | null = null, saves = 0, holdFocusCheck = false, checks = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/auth/session', async route => {
    if (holdFocusCheck) { checks++; await pending; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, session: { sessionId: 'synthetic-session', subject: 'synthetic-user', email: 'private@example.invalid' } }) });
  });
  const owner = () => ({ playerId: 'player-one', displayName: 'Alex Rivera', hasPortrait: Boolean(uploaded), revision: (uploaded ? 'b' : 'a').repeat(64) });
  await page.route('**/v1/owner-player-profile?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...owner(), email: 'private@example.invalid' }) }));
  await page.route('**/v1/owner-player-portrait?*', async route => {
    expect(route.request().method()).toBe('PUT');
    const body = route.request().postDataJSON(); expect(body.contentType).toBe('image/png');
    uploaded = Buffer.from(body.base64, 'base64'); saves++;
    expect(uploaded.readUInt32BE(16)).toBe(512); expect(uploaded.readUInt32BE(20)).toBe(512);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(owner()) });
  });
  await page.route('**/v1/player-portrait?*', route => route.fulfill({ status: 200, contentType: 'image/png', body: uploaded! }));
  await page.goto('/player-settings?leagueId=league-one&playerId=player-one');
  await expect(page.locator('#owner-name')).toHaveValue('Alex Rivera');
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400; const c = canvas.getContext('2d')!; c.fillStyle = '#125f45'; c.fillRect(0, 0, 600, 400); return canvas.toDataURL('image/png').split(',')[1]; });
  holdFocusCheck = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => checks).toBe(1);
  await page.locator('#owner-photo-file').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#portrait-crop-dialog')).not.toBeVisible();
  holdFocusCheck = false; release();
  await expect(page.locator('#portrait-crop-dialog')).toBeVisible();
  await page.locator('#portrait-crop-confirm').click();
  await expect(page.locator('#owner-photo-preview')).toBeVisible();
  await expect(page.locator('#owner-photo-preview')).toHaveAttribute('alt', 'Selected player portrait, not yet saved');
  expect(saves).toBe(0);
  await expect(page.locator('#owner-status')).toContainText('Save portrait');
  await page.locator('#owner-photo-save').click();
  await expect(page.locator('#owner-status')).toContainText('Save confirmed');
  expect(saves).toBe(1);
  await expect(page.locator('#owner-photo-preview')).toHaveAttribute('alt', 'Current player portrait');
});

test('My profile opens the single owned profile and multiple leagues show keyboard-accessible choices', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 }); await mockApi(page);
  let multiple = false;
  await page.route('**/v1/my-player-profiles?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    profiles: [{ playerId: 'player-one', displayName: 'Alex Rivera', leagueId: 'league-one', leagueName: 'Three-sided football' },
      ...(multiple ? [{ playerId: 'player-two', displayName: 'Alex Rivera', leagueId: 'league-two', leagueName: 'Second league' }] : [])], cursor: null, complete: true,
  }) }));
  await page.goto('/player'); await expect(page.locator('#player-name')).toHaveText('Alex Rivera');
  await expect(page.locator('[data-ui=site-nav]').getByRole('link', { name: 'My profile' })).toHaveAttribute('href', '/player');
  multiple = true; await page.goto('/player');
  await expect(page.locator('#player-access a')).toHaveCount(2);
  await expect(page.locator('#player-content')).not.toBeVisible();
  const second = page.locator('#player-access a').nth(1); await second.focus(); await expect(second).toBeFocused();
  await expect(second).toContainText('Second league');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
