import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { ACHIEVEMENT_DEFINITIONS, milestoneThreshold, type AchievementId, type AchievementUnlock, type PlayerAchievements } from '@3fc/contracts';
import { buildClubCardModel, renderClubCardSvg, validCardPortrait } from '../ui/player-card-art.js';
import { performance } from './player-profile-fixtures.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=';
function award(id: AchievementId, ordinal = 1): AchievementUnlock {
  return { id: `${id}/${ordinal}`, achievementId: id, ordinal, threshold: milestoneThreshold(ACHIEVEMENT_DEFINITIONS.find(d => d.id === id)!.rarity, ordinal), scope: 'season', seasonId: 'winter', earnedAt: performance.latest.finishedAt, gameId: performance.latest.gameId };
}
function achievements(honours: AchievementUnlock[] = []): PlayerAchievements { return { playerId: performance.player.playerId, leagueId: performance.league.leagueId, scope: 'season', seasonId: 'winter', honours, firstUnlocks: [], latestUnlocks: honours, progress: [], freshness: performance.freshness }; }

test('front uses the authoritative selected totals and last-game contribution, and excludes account data', () => {
  const source = { ...performance, email: 'private@example.test', preferences: { email: true } };
  const season = buildClubCardModel({ performance: source, period: 'season', portraitDataUrl: null, achievements: null });
  assert.deepEqual(season.stats, [{ label: 'PLAYED', value: '1' }, { label: 'WINS', value: '1' }, { label: 'DRAWS', value: '0' }, { label: 'GOALS', value: '2' }, { label: 'ASSISTS', value: '1' }]);
  const last = buildClubCardModel({ performance: source, period: 'last', portraitDataUrl: null, achievements: null });
  assert.deepEqual(last.stats.map(s => s.value), ['2', '1', 'WIN']); assert.equal(last.stats.length, 3);
  for (const period of ['season', 'career', 'last'] as const) {
    const card = renderClubCardSvg(buildClubCardModel({ performance: source, period, portraitDataUrl: null, achievements: null }), 'front');
    assert(!card.includes('OWN GOALS')); assert(!card.includes('GOALS / GAME'));
  }
  const svg = renderClubCardSvg(season, 'front'); assert(!svg.includes('private@example')); assert(!JSON.stringify(season).includes('preferences')); assert(svg.includes('width="1200" height="1560"'));
});
test('five honour classes rank by rarity and highest milestone; repeated tiers do not inflate extras', () => {
  const honours = [award('goal', 8), award('goal', 1), award('played', 9), award('assist', 8), award('wins', 3), award('draw', 2), award('own-goal', 1), award('lockdown', 1)];
  const model = buildClubCardModel({ performance, period: 'season', portraitDataUrl: null, achievements: achievements(honours) });
  assert.deepEqual(model.honours.map(a => a.achievementId), ['lockdown', 'own-goal', 'wins', 'draw', 'played']); assert.equal(model.additionalHonours, 2);
  const reverse = new JSDOM(renderClubCardSvg(model, 'honours'), { contentType: 'image/svg+xml' });
  assert.equal(reverse.window.document.querySelectorAll('svg.badge-art').length, 5); assert.match(reverse.window.document.documentElement.textContent!, /TOP ACHIEVEMENTS/); assert.match(reverse.window.document.documentElement.textContent!, /\+2 OTHER ACHIEVEMENTS/); reverse.window.close();
});
test('last-game identical scope awards merge and earlier-game milestones do not appear', () => {
  const season = award('goal', 2), career: AchievementUnlock = { ...season, id: 'career-goal', scope: 'career', seasonId: null };
  const input = achievements([season]); input.latestUnlocks = [season, career, { ...award('wins'), gameId: 'older' }];
  const model = buildClubCardModel({ performance, period: 'last', portraitDataUrl: null, achievements: input });
  assert.equal(model.honours.length, 1); assert.deepEqual(model.honours[0].scopes, ['season', 'career']);
  assert.match(renderClubCardSvg(model, 'honours'), /SEASON \+ CAREER/);
});
test('unknown or mismatched honours stay unavailable while confirmed empty remains inviting', () => {
  for (const a of [null, { ...achievements(), honours: null }, { ...achievements(), freshness: { ...performance.freshness, revision: 'other' } }, { ...achievements(), playerId: 'other' }]) {
    const model = buildClubCardModel({ performance, period: 'season', portraitDataUrl: null, achievements: a });
    assert.equal(model.honoursState, 'unavailable'); assert(!renderClubCardSvg(model, 'honours').includes('YOUR NEXT STORY AWAITS'));
  }
  assert.match(renderClubCardSvg(buildClubCardModel({ performance, period: 'season', portraitDataUrl: null, achievements: achievements() }), 'honours'), /YOUR NEXT STORY AWAITS/);
});
test('incomplete totals and missing selected portrait cannot produce a shareable record', () => {
  for (const p of [{ ...performance, freshness: { ...performance.freshness, coverage: 'partial' as const } }, { ...performance, player: { ...performance.player, hasPortrait: true } }, { ...performance, season: null }]) {
    assert.equal(buildClubCardModel({ performance: p, period: 'season', portraitDataUrl: null, achievements: null }).exportable, false);
  }
  assert.equal(buildClubCardModel({ performance: { ...performance, player: { ...performance.player, hasPortrait: true } }, period: 'season', portraitDataUrl: png, achievements: null }).exportable, true);
});
test('text and portrait handling reject injected SVG/URLs and keep rendered output valid XML', () => {
  for (const value of ['https://evil.test/photo.png', 'data:image/svg+xml,<svg onload="alert(1)"/>', 'data:image/png;base64,c2NyaXB0', png + '" onload="x']) assert.equal(validCardPortrait(value), false);
  assert.equal(validCardPortrait(png), true);
  const model = buildClubCardModel({ performance: { ...performance, player: { ...performance.player, displayName: '<script>&"\u0001' } }, period: 'season', portraitDataUrl: 'https://evil.test', achievements: null });
  const dom = new JSDOM(renderClubCardSvg(model, 'front'), { contentType: 'image/svg+xml' });
  assert.equal(dom.window.document.querySelector('script'), null); assert.equal(dom.window.document.querySelector('image'), null); assert.match(dom.window.document.documentElement.textContent!, /<script>&"/); dom.window.close();
});
test('compact large stars and bounded large figures retain uncertainty when additional honours exist', () => {
  const a = achievements(ACHIEVEMENT_DEFINITIONS.map(d => award(d.id, 7))); a.progress = [{ achievementId: 'goal', count: 1, ordinal: 1, nextThreshold: 5, assessability: 'partial', currentRun: null, highest: award('goal') }];
  const model = buildClubCardModel({ performance: { ...performance, season: { ...performance.season, goals: Number.MAX_SAFE_INTEGER } }, period: 'season', portraitDataUrl: null, achievements: a });
  assert.match(renderClubCardSvg(model, 'honours'), /Some history cannot be assessed/); assert.match(renderClubCardSvg(model, 'honours'), /7 milestone/);
  assert.match(renderClubCardSvg(model, 'front'), /textLength="85" lengthAdjust="spacingAndGlyphs"/);
});
test('last-game label follows the viewer local day across midnight, matching profile dates', () => {
  const prior = process.env.TZ;
  try {
    process.env.TZ = 'Australia/Melbourne';
    const model = buildClubCardModel({ performance: { ...performance, latest: { ...performance.latest, kickoffAt: '2026-06-01T15:30:00Z' } }, period: 'last', portraitDataUrl: null, achievements: null });
    assert.equal(model.periodLabel, '2 June 2026');
  } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});
