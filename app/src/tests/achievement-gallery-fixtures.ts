import { ACHIEVEMENT_CONDITIONS, ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_RULE_VERSION, COMMON_MILESTONES, RARE_MILESTONES, milestoneOrdinal, milestoneThreshold, type AchievementId, type AchievementScopeContext, type AchievementUnlock, type PlayerAchievements } from '@3fc/contracts';
import { performance } from './player-profile-fixtures.js';
export const catalogueResponse = { ruleVersion: ACHIEVEMENT_RULE_VERSION, achievements: ACHIEVEMENT_DEFINITIONS, conditions: ACHIEVEMENT_CONDITIONS,
  milestones: { common: [...COMMON_MILESTONES], rare: [...RARE_MILESTONES], commonRepeatEvery: 100, rareRepeatEvery: 10, legendaryRepeatEvery: 1, epicRepeatEvery: 1 } };
export function unlock(id: AchievementId, ordinal = 1, scope: AchievementScopeContext = { scope: 'season', seasonId: 'winter' }): AchievementUnlock {
  const rarity = ACHIEVEMENT_DEFINITIONS.find(d => d.id === id)!.rarity;
  return { id: `${scope.scope}-${id}-${ordinal}`, achievementId: id, ordinal, threshold: milestoneThreshold(rarity, ordinal), earnedAt: `2026-06-${String(ordinal).padStart(2, '0')}T12:00:00Z`, gameId: `game-${ordinal}`, ...scope };
}
export function personal(scope: AchievementScopeContext = { scope: 'season', seasonId: 'winter' }, counts: Partial<Record<AchievementId, number>> = { goal: 1 }): PlayerAchievements {
  const progress = ACHIEVEMENT_DEFINITIONS.map(def => {
    const count = counts[def.id] ?? 0, ordinal = milestoneOrdinal(def.rarity, count);
    return { achievementId: def.id, count, ordinal, nextThreshold: milestoneThreshold(def.rarity, ordinal + 1), assessability: 'complete' as const,
      currentRun: def.id in ACHIEVEMENT_CONDITIONS.streakAppearances ? 0 : null, highest: ordinal ? unlock(def.id, ordinal, scope) : null };
  });
  return { playerId: performance.player.playerId, leagueId: performance.league.leagueId, ...scope, progress,
    honours: progress.flatMap(p => p.highest ? [p.highest] : []), firstUnlocks: progress.filter(p => p.highest).map(p => unlock(p.achievementId, 1, scope)), latestUnlocks: [], freshness: performance.freshness };
}
