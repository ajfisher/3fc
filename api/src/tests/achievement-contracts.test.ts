import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_RULE_VERSION, milestoneOrdinal,
  milestoneThreshold, selectCardHonours,
  type AchievementId, type AchievementRarity, type AchievementScopeContext, type AchievementUnlock,
  type PlayerAchievements, type PlayerHistoryPage, type PlayerPerformance, type PlayerUnlockPage
} from '@3fc/contracts';

function unlock(achievementId: AchievementId, ordinal = 1, extra: Partial<Omit<AchievementUnlock, "scope" | "seasonId">> & (AchievementScopeContext | { scope?: never; seasonId?: never }) = {}): AchievementUnlock {
  const rarity = ACHIEVEMENT_DEFINITIONS.find(value => value.id === achievementId)!.rarity;
  return { id: `${achievementId}-${ordinal}`, achievementId, ordinal,
    threshold: milestoneThreshold(rarity, ordinal),
    gameId: 'game-1', earnedAt: '2026-09-20T10:00:00.000Z', ...extra,
    ...(extra.scope === 'season' ? { scope: 'season' as const, seasonId: extra.seasonId }
      : { scope: 'career' as const, seasonId: null }) };
}

test('launch catalogue contains the approved 23 unique classes and trusted vector artwork', () => {
  assert.equal(ACHIEVEMENT_RULE_VERSION, 1);
  assert.deepEqual(ACHIEVEMENT_DEFINITIONS.map(value => value.id).sort(), [
    'goal', 'played', 'assist', 'wins', 'draw', 'own-goal', 'defence', 'desperate-defence',
    'momentum-play', 'clutch', 'hail-mary', 'speedy', 'message-sent', 'hat-trick',
    'master-provider', 'double-threat', 'triple-threat', 'lockdown', 'comeback-crew',
    'team-engine', 'on-fire', 'helping-hand', 'unbeaten-run'
  ].sort());
  assert.deepEqual(Object.fromEntries(['Common', 'Rare', 'Legendary', 'Epic'].map(rarity =>
    [rarity, ACHIEVEMENT_DEFINITIONS.filter(value => value.rarity === rarity).length])),
  { Common: 3, Rare: 12, Legendary: 7, Epic: 1 });
  for (const value of ACHIEVEMENT_DEFINITIONS) {
    assert.ok(value.rule.length > 20);
    assert.match(value.icon, /<(path|g|circle|text)/);
    assert.doesNotMatch(value.icon, /<script|onload|href=|foreignObject/i);
  }
});

test('milestones earn their first star at one and extend at the agreed boundaries', () => {
  const cases: [AchievementRarity, number[]][] = [
    ['Common', [1, 5, 10, 25, 50, 100, 150, 200, 300, 400]],
    ['Rare', [1, 3, 5, 10, 15, 20, 30, 40, 50]],
    ['Legendary', [1, 2, 3, 4, 5, 6]], ['Epic', [1, 2, 3, 4, 5, 6]]
  ];
  for (const [rarity, thresholds] of cases) {
    assert.equal(milestoneOrdinal(rarity, 0), 0);
    thresholds.forEach((threshold, index) => {
      assert.equal(milestoneThreshold(rarity, index + 1), threshold);
      assert.equal(milestoneOrdinal(rarity, threshold - 1), index);
      assert.equal(milestoneOrdinal(rarity, threshold), index + 1);
    });
  }
  assert.equal(milestoneOrdinal('Common', 10000), 106);
  assert.equal(milestoneThreshold('Common', 106), 10000);
  assert.equal(milestoneOrdinal('Rare', 10000), 1004);
  assert.equal(milestoneThreshold('Rare', 1004), 10000);
});

test('invalid counts, ordinals and overflowing thresholds fail explicitly', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => milestoneOrdinal('Common', value));
    assert.throws(() => milestoneThreshold('Common', value));
  }
  assert.throws(() => milestoneThreshold('Epic', 0));
  assert.throws(() => milestoneThreshold('Common', Number.MAX_SAFE_INTEGER));
  assert.equal(milestoneThreshold('Legendary', Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('card ranking prioritises rarity, then stars, date and stable class ID, capped at five', () => {
  const awards = [unlock('goal', 9), unlock('wins', 2), unlock('draw', 2),
    unlock('clutch', 2, { earnedAt: '2026-09-21T10:00:00.000Z' }),
    unlock('own-goal', 1), unlock('lockdown', 1), unlock('played', 10), unlock('defence', 1)];
  const snapshot = structuredClone(awards);
  assert.deepEqual(selectCardHonours(awards).map(value => value.achievementId),
    ['lockdown', 'own-goal', 'clutch', 'draw', 'wins']);
  assert.deepEqual(selectCardHonours(awards), selectCardHonours([...awards].reverse()));
  assert.deepEqual(awards, snapshot, 'selection must not mutate the ledger');
});

test('card picks highest per class and merges matching season/career milestones with both labels', () => {
  const career = unlock('goal', 3, { id: 'career-goal' });
  const season = unlock('goal', 3, { id: 'season-goal', scope: 'season', seasonId: 'winter' });
  const awards = [unlock('goal', 2), season, career];
  const selected = selectCardHonours(awards);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].ordinal, 3);
  assert.deepEqual(selected[0].scopes, ['season', 'career']);
  assert.deepEqual(selected, selectCardHonours([...awards].reverse()));
  assert.equal(awards.length, 3, 'original scope records remain available to the gallery');
});

test('distinct milestones and different earning matches never acquire false combined scopes', () => {
  const high = unlock('goal', 3);
  const lower = unlock('goal', 2, { scope: 'season', seasonId: 'winter' });
  assert.deepEqual(selectCardHonours([high, lower])[0].scopes, ['career']);
  const otherGame = unlock('goal', 3, { id: 'season', scope: 'season', seasonId: 'winter', gameId: 'game-2' });
  assert.deepEqual(selectCardHonours([high, otherGame])[0].scopes, ['career']);
  assert.deepEqual(selectCardHonours([otherGame, high]), selectCardHonours([high, otherGame]));
  const later = unlock('goal', 3, { id: 'newer', earnedAt: '2026-09-21T10:00:00.000Z' });
  assert.equal(selectCardHonours([high, later])[0].id, 'newer');
});

test('empty and small collections remain usable without filling badge slots', () => {
  assert.deepEqual(selectCardHonours([]), []);
  assert.equal(selectCardHonours([unlock('played')]).length, 1);
});

test('unavailable projection contracts carry no fabricated totals, progress or private account fields', () => {
  const freshness = { status: 'unavailable', coverage: 'unknown', revision: null, computedAt: null } as const;
  const profile: PlayerPerformance = {
    player: { playerId: 'player', displayName: 'Player', hasPortrait: false },
    league: { leagueId: 'league', name: 'League' }, seasons: [], selectedSeasonId: null,
    latest: null, season: null, career: null, freshness,
    capabilities: { editProfile: false, achievements: false }
  };
  const achievements: PlayerAchievements = { playerId: 'player', leagueId: 'league',
    scope: 'career', seasonId: null, progress: null, honours: null, firstUnlocks: null, latestUnlocks: null, freshness };
  const history: PlayerHistoryPage = { matches: null, cursor: null, freshness };
  const unlocks: PlayerUnlockPage = { unlocks: null, cursor: null, freshness };
  assert.equal(profile.career, null);
  assert.equal(achievements.progress, null);
  assert.equal(history.matches, null);
  assert.equal(unlocks.unlocks, null);
  // Runtime response allow-list validation belongs to the route slice; these are type contracts.
  type PrivateField = Extract<keyof PlayerPerformance['player'], 'email' | 'userId' | 'claimedByUserId'>;
  const noPrivateKeys: [PrivateField] extends [never] ? true : false = true;
  assert.equal(noPrivateKeys, true);
});

// These negative examples must fail compilation: a scope determines its season ID.
// @ts-expect-error A season unlock must identify its season.
const missingSeason: AchievementUnlock = { ...unlock('goal'), scope: 'season', seasonId: null };
// @ts-expect-error Career progress cannot be attached to one season.
const careerSeason: PlayerAchievements = { playerId: 'p', leagueId: 'l', scope: 'career', seasonId: 'winter', progress: null, honours: null, firstUnlocks: null, latestUnlocks: null, freshness: { status: 'unavailable', coverage: 'unknown', revision: null, computedAt: null } };
void missingSeason;
void careerSeason;
