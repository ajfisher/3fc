import { createHash } from 'node:crypto';
import {
  ACHIEVEMENT_CONDITIONS as rules, ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_RULE_VERSION,
  milestoneOrdinal, milestoneThreshold, TEAM_IDS,
  type AchievementId, type AchievementProgress, type AchievementScope, type AchievementScopeContext,
  type AchievementUnlock, type PlayerAppearance, type PlayerTotals, type TeamId
} from '@3fc/contracts';
import { matchFactsSchema, type MatchFacts, type MatchGoal } from './facts.js';
export type { MatchFacts, MatchGoal, TimingEvidence } from './facts.js';

export type AwardEvidence = AchievementUnlock & { ruleVersion: number; sourceRevision: string };
type AccumulatorContext = AchievementScopeContext & { playerId: string; leagueId: string; ruleVersion: number };
type StreakId = keyof typeof rules.streakAppearances;
export interface AchievementAccumulator {
  context: AccumulatorContext | null;
  cursor: { kickoffAt: string; gameId: string; sourceRevision: string } | null;
  totals: PlayerTotals;
  counts: Record<AchievementId, number>;
  uncertain: AchievementId[];
  runs: Record<StreakId, number>;
  highest: Partial<Record<AchievementId, AwardEvidence>>;
  latest: PlayerAppearance | null;
}
const zeroCounts = () => Object.fromEntries(ACHIEVEMENT_DEFINITIONS.map(def => [def.id, 0])) as Record<AchievementId, number>;
export function emptyTotals(): PlayerTotals {
  return { played: 0, goals: 0, assists: 0, ownGoals: 0, wins: 0, draws: 0, losses: 0, goalsPerGame: 0 };
}
export function emptyAccumulator(): AchievementAccumulator {
  return { context: null, cursor: null, totals: emptyTotals(), counts: zeroCounts(), uncertain: [],
    runs: { 'on-fire': 0, 'helping-hand': 0, 'unbeaten-run': 0 }, highest: {}, latest: null };
}
type Scores = Record<TeamId, { scored: number; conceded: number }>;
const emptyScores = (): Scores => ({ red: { scored: 0, conceded: 0 }, blue: { scored: 0, conceded: 0 }, yellow: { scored: 0, conceded: 0 } });
/** Canonical comparator: fewest conceded, then most scored; only tied first teams draw. */
export function leaders(scores: Scores): TeamId[] {
  const sorted = [...TEAM_IDS].sort((a, b) => scores[a].conceded - scores[b].conceded || scores[b].scored - scores[a].scored);
  const first = scores[sorted[0]];
  return sorted.filter(team => scores[team].conceded === first.conceded && scores[team].scored === first.scored);
}
function addGoal(scores: Scores, goal: MatchGoal) {
  scores[goal.concedingTeamId].conceded++;
  if (!goal.ownGoal && goal.scoringTeamId) scores[goal.scoringTeamId].scored++;
}
const isOutright = (winners: TeamId[], team: TeamId) => winners.length === 1 && winners[0] === team;
const scopeContext = (scope: AchievementScope, seasonId: string): AchievementScopeContext =>
  scope === 'season' ? { scope, seasonId } : { scope, seasonId: null };
export function stableUnlockId(playerId: string, leagueId: string, scope: AchievementScopeContext, id: AchievementId, ordinal: number): string {
  return createHash('sha256').update(JSON.stringify([playerId, leagueId, scope.scope, scope.seasonId, id, ordinal])).digest('hex');
}

/** One completed canonical match, in strict kickoff/game-ID order. Persist checkpoints between
 * bounded pages. Duplicate, changed or earlier facts must rebuild from an earlier checkpoint;
 * they must never be applied atop already-counted contributions. Transaction fencing is the worker's job. */
export function applyAppearance(previous: AchievementAccumulator, rawMatch: MatchFacts, playerId: string, scope: AchievementScope): {
  state: AchievementAccumulator; appearance: PlayerAppearance | null; unlocks: AwardEvidence[];
} {
  if (!playerId.trim() || (scope !== 'season' && scope !== 'career')) throw new Error('Invalid player or achievement scope');
  const match = matchFactsSchema.parse(rawMatch);
  const context: AccumulatorContext = { ...scopeContext(scope, match.seasonId), playerId, leagueId: match.leagueId, ruleVersion: ACHIEVEMENT_RULE_VERSION };
  if (previous.context && (previous.context.playerId !== context.playerId || previous.context.leagueId !== context.leagueId
    || previous.context.scope !== context.scope || previous.context.seasonId !== context.seasonId
    || previous.context.ruleVersion !== context.ruleVersion)) throw new Error('Accumulator context mismatch; rebuild required');
  if (previous.cursor && (match.gameId === previous.cursor.gameId || match.kickoffAt < previous.cursor.kickoffAt ||
    (match.kickoffAt === previous.cursor.kickoffAt && match.gameId <= previous.cursor.gameId))) throw new Error('Duplicate or out-of-order match; rebuild required');
  const state = structuredClone(previous);
  state.context = context;
  state.cursor = { kickoffAt: match.kickoffAt, gameId: match.gameId, sourceRevision: match.sourceRevision };
  const membership = match.roster.find(player => player.playerId === playerId);
  if (!membership) return { state, appearance: null, unlocks: [] };
  const team = membership.teamId, final = emptyScores();
  const goals = [...match.goals].sort((a, b) => (a.third ?? 4) - (b.third ?? 4)
    || (a.elapsedSeconds ?? 0) - (b.elapsedSeconds ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId));
  for (const goal of goals) addGoal(final, goal);
  const winners = leaders(final), outcome = winners.includes(team) ? winners.length === 1 ? 'win' : 'draw' : 'loss';
  const personal = goals.filter(goal => goal.scorerPlayerId === playerId && !goal.ownGoal);
  // Preserve credited assists, including cross-team and own-goal assists, as the scoring API does.
  const assists = goals.filter(goal => goal.assistPlayerIds.includes(playerId));
  const ownGoals = goals.filter(goal => goal.scorerPlayerId === playerId && goal.ownGoal).length;
  const appearance: PlayerAppearance = { gameId: match.gameId, seasonId: match.seasonId, kickoffAt: match.kickoffAt, finishedAt: match.finishedAt,
    teamId: team, outcome, goals: personal.length, assists: assists.length, ownGoals, scored: final[team].scored, conceded: final[team].conceded };
  const occurrences = zeroCounts(), uncertain = new Set(state.uncertain);
  occurrences.goal = personal.length; occurrences.assist = assists.length; occurrences['own-goal'] = ownGoals;
  occurrences.played = 1; occurrences.wins = outcome === 'win' ? 1 : 0; occurrences.draw = outcome === 'draw' ? 1 : 0;
  occurrences['hat-trick'] = personal.length >= rules.hatTrickGoals ? 1 : 0;
  occurrences['master-provider'] = assists.length >= rules.masterProviderAssists ? 1 : 0;
  occurrences['double-threat'] = personal.length > 0 && assists.length > 0 ? 1 : 0;
  occurrences.lockdown = final[team].conceded === 0 ? 1 : 0;

  // Unknown provenance includes potentially synthetic third/time fields. Never trust those
  // fields to narrow the uncertainty to just one opening/closing badge.
  if (personal.some(goal => goal.timing === 'unknown')) {
    for (const id of ['message-sent', 'speedy', 'clutch', 'momentum-play'] as const) uncertain.add(id);
    if (personal.some(goal => goal.timing === 'unknown' && goal.scoringTeamId && isOutright(winners, goal.scoringTeamId))) uncertain.add('hail-mary');
  }
  const positionReliable = goals.every(goal => goal.timing === 'live');
  const scores = emptyScores();
  const unknownConceded = emptyScores();
  for (const goal of goals.filter(goal => goal.timing !== 'live')) unknownConceded[goal.concedingTeamId].conceded++;
  const ambiguousOrder = new Set<string>();
  for (let i = 1; i < goals.length; i++) {
    if (goals[i].third === goals[i - 1].third && goals[i].elapsedSeconds === goals[i - 1].elapsedSeconds && goals[i].createdAt === goals[i - 1].createdAt) {
      ambiguousOrder.add(goals[i].eventId); ambiguousOrder.add(goals[i - 1].eventId);
    }
  }
  for (const third of [1, 2, 3] as const) {
    const before = leaders(scores), startConceded = scores[team].conceded;
    const startingScores = structuredClone(scores);
    const defenceEligible = startConceded - Math.min(...TEAM_IDS.filter(id => id !== team).map(id => scores[id].conceded)) < rules.defenceDeficitExclusive;
    for (const goal of goals.filter(goal => goal.third === third)) {
      const pre = leaders(scores);
      if (goal.timing === 'live') addGoal(scores, goal);
      if (goal.scorerPlayerId !== playerId || goal.ownGoal || goal.timing !== 'live') continue;
      const opening = goal.elapsedSeconds! < rules.openingSecondsExclusive;
      const closing = goal.elapsedSeconds! >= match.thirdLengthMinutes * 60 - rules.closingSecondsBeforeRegulationEnd;
      if (opening) occurrences[third === 1 ? 'message-sent' : 'speedy']++;
      if (closing) occurrences[third === 3 ? 'clutch' : 'momentum-play']++;
      // A corrected final roster can differ from the original scoring team. The goal must
      // take ITS scoring team into the lead, and that team must ultimately win outright.
      const scoringTeam = goal.scoringTeamId!;
      if (third === 3 && closing && isOutright(winners, scoringTeam)) {
        if (!positionReliable || ambiguousOrder.has(goal.eventId)) uncertain.add('hail-mary');
        else if (!isOutright(pre, scoringTeam) && isOutright(leaders(scores), scoringTeam)) occurrences['hail-mary']++;
      }
    }
    if (scores[team].conceded === startConceded) {
      // Unknown concessions by opponents can only improve our defensive starting margin.
      // Preserve provable clean thirds instead of making a whole match unknown needlessly.
      if (unknownConceded[team].conceded === 0 && defenceEligible) occurrences.defence++;
      else {
        const bestOpponentStartingConceded = Math.min(...TEAM_IDS.filter(id => id !== team)
          .map(id => startingScores[id].conceded + unknownConceded[id].conceded));
        if (startConceded - bestOpponentStartingConceded < rules.defenceDeficitExclusive) uncertain.add('defence');
      }
    }
    if (positionReliable) {
      if (third === 3 && outcome === 'win') {
        if (isOutright(before, team) && scores[team].conceded === startConceded) occurrences['desperate-defence'] = 1;
        if (!before.includes(team)) occurrences['comeback-crew'] = 1;
      }
    }
  }
  if (!positionReliable) {
    if (outcome === 'win') { uncertain.add('desperate-defence'); uncertain.add('comeback-crew'); }
  }
  const hasGoalsEveryThird = [1, 2, 3].every(third => personal.some(goal => goal.third === third && goal.timing === 'live'));
  const hasAssistsEveryThird = [1, 2, 3].every(third => assists.some(goal => goal.third === third && goal.timing === 'live'));
  occurrences['triple-threat'] = hasGoalsEveryThird ? 1 : 0;
  occurrences['team-engine'] = hasGoalsEveryThird && hasAssistsEveryThird ? 1 : 0;
  if (!occurrences['triple-threat'] && personal.some(goal => goal.timing === 'unknown')) uncertain.add('triple-threat');
  if (!occurrences['team-engine'] && personal.concat(assists).some(goal => goal.timing === 'unknown')) uncertain.add('team-engine');

  for (const [id, qualifies] of [['on-fire', personal.length > 0], ['helping-hand', assists.length > 0], ['unbeaten-run', outcome !== 'loss']] as const) {
    state.runs[id] = qualifies ? state.runs[id] + 1 : 0;
    if (state.runs[id] === rules.streakAppearances[id]) { occurrences[id] = 1; state.runs[id] = 0; }
  }
  const unlocks: AwardEvidence[] = [];
  for (const def of ACHIEVEMENT_DEFINITIONS) {
    const from = milestoneOrdinal(def.rarity, state.counts[def.id]);
    state.counts[def.id] += occurrences[def.id];
    const to = milestoneOrdinal(def.rarity, state.counts[def.id]);
    for (let ordinal = from + 1; ordinal <= to; ordinal++) {
      const award: AwardEvidence = { ...scopeContext(scope, match.seasonId),
        id: stableUnlockId(playerId, match.leagueId, scopeContext(scope, match.seasonId), def.id, ordinal), achievementId: def.id,
        ordinal, threshold: milestoneThreshold(def.rarity, ordinal), earnedAt: match.finishedAt, gameId: match.gameId,
        ruleVersion: ACHIEVEMENT_RULE_VERSION, sourceRevision: match.sourceRevision };
      unlocks.push(award); state.highest[def.id] = award;
    }
  }
  state.uncertain = [...uncertain].sort();
  state.totals.played++; state.totals.goals += personal.length; state.totals.assists += assists.length; state.totals.ownGoals += ownGoals;
  state.totals.wins += outcome === 'win' ? 1 : 0; state.totals.draws += outcome === 'draw' ? 1 : 0; state.totals.losses += outcome === 'loss' ? 1 : 0;
  state.totals.goalsPerGame = state.totals.goals / state.totals.played; state.latest = appearance;
  return { state, appearance, unlocks };
}
/** Explicit safe projection: evidence revisions and any future internal fields stay out. */
export function publicUnlock(award: AchievementUnlock): AchievementUnlock {
  const { id, achievementId, ordinal, threshold, earnedAt, gameId } = award;
  return { id, achievementId, ordinal, threshold, earnedAt, gameId, ...scopeContext(award.scope, award.seasonId ?? '') };
}
export function progressFor(state: AchievementAccumulator): AchievementProgress[] {
  return ACHIEVEMENT_DEFINITIONS.map(def => {
    const ordinal = milestoneOrdinal(def.rarity, state.counts[def.id]);
    return { achievementId: def.id, count: state.counts[def.id], ordinal, nextThreshold: milestoneThreshold(def.rarity, ordinal + 1),
      assessability: state.uncertain.includes(def.id) ? 'partial' : 'complete',
      currentRun: def.id in state.runs ? state.runs[def.id as StreakId] : null,
      highest: state.highest[def.id] ? publicUnlock(state.highest[def.id]!) : null };
  });
}
