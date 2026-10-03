import { z } from 'zod';
import { TEAM_IDS, validateAssistPlayerIds } from '@3fc/contracts';

const identifier = z.string().min(1).refine(value => value.trim().length > 0);
const instant = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const goalSchema = z.object({
  eventId: identifier, scorerPlayerId: identifier, assistPlayerIds: z.array(identifier),
  scoringTeamId: z.enum(TEAM_IDS).nullable(), concedingTeamId: z.enum(TEAM_IDS), ownGoal: z.boolean(),
  third: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(), elapsedSeconds: seconds.nullable(),
  createdAt: instant, timing: z.enum(['live', 'post_completion', 'unknown'])
}).strict().superRefine((goal, context) => {
  try { validateAssistPlayerIds(goal.scorerPlayerId, goal.assistPlayerIds); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid credited assists' }); }
  if (goal.ownGoal ? goal.scoringTeamId !== null : goal.scoringTeamId === null || goal.scoringTeamId === goal.concedingTeamId)
    context.addIssue({ code: 'custom', message: 'Invalid goal team context' });
  if (goal.timing === 'live' && (goal.third === null || goal.elapsedSeconds === null))
    context.addIssue({ code: 'custom', message: 'Live timing requires a third and elapsed time' });
});

/** Normalised canonical completed-match facts. Raw storage records are not this interface.
 * The adapter must prove live provenance; post-completion/unknown timestamps are never inferred live.
 * Event-time scorer/team credit can differ from the final roster after corrections. */
export const matchFactsSchema = z.object({
  gameId: identifier, leagueId: identifier, seasonId: identifier,
  kickoffAt: instant, finishedAt: instant, sourceRevision: identifier,
  thirdLengthMinutes: z.union([z.literal(20), z.literal(25), z.literal(30)]),
  thirdEndsSeconds: z.tuple([seconds.nullable(), seconds.nullable(), seconds.nullable()]),
  roster: z.array(z.object({ playerId: identifier, teamId: z.enum(TEAM_IDS) }).strict()),
  goals: z.array(goalSchema)
}).strict().superRefine((match, context) => {
  if (match.finishedAt < match.kickoffAt) context.addIssue({ code: 'custom', message: 'Match finishes before kickoff' });
  if (new Set(match.roster.map(player => player.playerId)).size !== match.roster.length)
    context.addIssue({ code: 'custom', message: 'Duplicate or conflicting canonical roster' });
  if (new Set(match.goals.map(goal => goal.eventId)).size !== match.goals.length)
    context.addIssue({ code: 'custom', message: 'Duplicate canonical goal' });
  for (const goal of match.goals) {
    if (goal.timing !== 'live' || goal.third === null || goal.elapsedSeconds === null) continue;
    const end = match.thirdEndsSeconds[goal.third - 1];
    if (end === null || goal.elapsedSeconds > end || goal.createdAt > match.finishedAt)
      context.addIssue({ code: 'custom', message: 'Live timing must be evidenced within a completed third' });
  }
});
export type MatchFacts = z.infer<typeof matchFactsSchema>;
export type MatchGoal = z.infer<typeof goalSchema>;
export type TimingEvidence = MatchGoal['timing'];
