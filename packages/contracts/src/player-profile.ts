import type { AchievementProgress, AchievementUnlock } from './achievements.js';
import type { TeamId } from './index.js';
export interface PlayerTotals {
  played: number; goals: number; assists: number; ownGoals: number;
  wins: number; draws: number; losses: number; goalsPerGame: number;
}
export interface PlayerAppearance {
  gameId: string; seasonId: string; kickoffAt: string; finishedAt: string;
  teamId: TeamId; outcome: 'win' | 'draw' | 'loss'; goals: number; assists: number;
  ownGoals: number; scored: number; conceded: number;
}
/** Null data means unavailable, while empty arrays/zero totals mean confirmed empty history.
 * Partial/updating data is a confirmed subset, never a claim of complete coverage. */
export interface ProjectionFreshness {
  status: 'ready' | 'updating' | 'unavailable';
  coverage: 'complete' | 'partial' | 'unknown';
  revision: string | null;
  computedAt: string | null;
}
export interface PlayerPerformance {
  player: { playerId: string; displayName: string; hasPortrait: boolean };
  league: { leagueId: string; name: string };
  seasons: Array<{ seasonId: string; name: string }>;
  selectedSeasonId: string | null;
  latest: PlayerAppearance | null;
  season: PlayerTotals | null;
  career: PlayerTotals | null;
  freshness: ProjectionFreshness;
  capabilities: { editProfile: boolean; achievements: boolean };
}
export interface PlayerHistoryPage { matches: PlayerAppearance[] | null; cursor: string | null; freshness: ProjectionFreshness }
export interface PlayerAchievements {
  playerId: string; leagueId: string; scope: 'season' | 'career'; seasonId: string | null;
  progress: AchievementProgress[] | null; honours: AchievementUnlock[] | null;
  latestUnlocks: AchievementUnlock[] | null; freshness: ProjectionFreshness;
}
export interface PlayerUnlockPage { unlocks: AchievementUnlock[] | null; cursor: string | null; freshness: ProjectionFreshness }
export interface OwnerPlayerProfile { playerId: string; displayName: string; email: string; hasPortrait: boolean; revision: string }
