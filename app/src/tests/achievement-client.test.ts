import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayerClient, parseAchievementCatalogue, parsePlayerAchievements, parsePlayerUnlocks, PlayerClientError } from '../ui/player-client.js';
import { catalogueResponse, personal, unlock } from './achievement-gallery-fixtures.js';

test('catalogue requires the enabled version and all approved rules while discarding arbitrary server artwork', () => {
  const source = { ...catalogueResponse, achievements: catalogueResponse.achievements.map(d => ({ ...d, icon: '<script>bad()</script>' })) };
  const result = parseAchievementCatalogue(source);
  assert.equal(result.achievements.length, 23); assert.equal(JSON.stringify(result).includes('script'), false); assert.equal('icon' in result.achievements[0], false);
  assert.throws(() => parseAchievementCatalogue({ ...source, ruleVersion: 2 }), (error: unknown) => error instanceof PlayerClientError && error.code === 'catalogue_changed');
  assert.throws(() => parseAchievementCatalogue({ ...source, achievements: source.achievements.slice(1) }), PlayerClientError);
  assert.throws(() => parseAchievementCatalogue({ ...source, achievements: source.achievements.map((d, index) => index ? d : { ...d, rule: 'Different rule' }) }), PlayerClientError);
  assert.throws(() => parseAchievementCatalogue({ ...source, conditions: { ...source.conditions, closingSecondsBeforeRegulationEnd: 120 } }), PlayerClientError);
});

test('achievement validation checks arithmetic, scope, class uniqueness and safe projections without inventing missing data', () => {
  const source = personal();
  assert.deepEqual(parsePlayerAchievements({ ...source, email: 'private@example.com' }), source);
  assert.equal(parsePlayerAchievements({ ...source, progress: null, honours: null, firstUnlocks: null, latestUnlocks: null }).progress, null);
  assert.throws(() => parsePlayerAchievements({ ...source, progress: source.progress!.map((p, index) => index ? p : { ...p, nextThreshold: 2 }) }), PlayerClientError);
  assert.throws(() => parsePlayerAchievements({ ...source, progress: source.progress!.map((p, index) => index === 1 ? source.progress![0] : p) }), PlayerClientError);
  assert.throws(() => parsePlayerAchievements({ ...source, firstUnlocks: [unlock('goal', 2)] }), PlayerClientError);
  assert.throws(() => parsePlayerAchievements({ ...source, honours: [unlock('goal', 1, { scope: 'career', seasonId: null })] }), PlayerClientError);
  const mixed = { ...source, latestUnlocks: [unlock('goal'), unlock('goal', 1, { scope: 'career', seasonId: null })] };
  assert.equal(parsePlayerAchievements(mixed).latestUnlocks?.length, 2);
  assert.throws(() => parsePlayerUnlocks({ unlocks: [unlock('goal'), unlock('goal')], cursor: null, freshness: source.freshness }), PlayerClientError);
});

test('career requests omit season and unlock pages must match their requested scope', async () => {
  const urls: URL[] = [];
  const client = createPlayerClient({ baseUrl: 'https://3fc.football', fetch: async url => {
    const parsed = new URL(String(url)); urls.push(parsed);
    return new Response(JSON.stringify(parsed.pathname.endsWith('player-unlocks') ? { unlocks: [unlock('goal')], cursor: null, freshness: personal().freshness } : personal({ scope: 'career', seasonId: null })));
  } });
  await client.achievements({ leagueId: 'league', playerId: 'player/root' }, { scope: 'career', seasonId: null });
  assert.equal(urls[0].searchParams.get('scope'), 'career'); assert.equal(urls[0].searchParams.has('seasonId'), false);
  await assert.rejects(client.unlocks({ leagueId: 'league', playerId: 'player/root' }, { scope: 'career', seasonId: null }), PlayerClientError);
});
