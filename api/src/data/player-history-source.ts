import { GetItemCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { TEAM_IDS, type TeamId } from '@3fc/contracts';
import { leaders, type MatchFacts, type MatchGoal } from '../achievements/evaluate.js';
import { matchFactsSchema } from '../achievements/facts.js';
import { goalSk, goalAuditSk } from './keys.js';
import { readHistoryReadiness } from './player-history-readiness.js';
import { PlayerIdentityPlanner, identityCondition, identityGameSk, identityTombstoneSk, type IdentitySnapshot } from './player-identity.js';
import { historyBody, historyHash, historyKey, historySourceKey, historySourceVersion,
  PlayerHistoryError, type HistoryClient, type HistoryContext, type HistoryItem, type HistoryPage } from './player-history-model.js';

const text = z.string().min(1).refine(value => value.trim().length > 0);
const instant = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const team = z.enum(TEAM_IDS);
function fail(message: string): never { throw new PlayerHistoryError('history_unavailable', message); }
function invalidCursor(): never { throw new PlayerHistoryError('invalid_cursor', 'Invalid source continuation.'); }
const parts = { roster: ['ROSTER#', 'roster'], goals: ['GOAL#', 'goal'], audits: ['AUDIT#GOAL#', 'goalAudit'], teams: ['TEAM#', 'gameTeam'] } as const;
export type HistoryGamePart = keyof typeof parts;
export interface HistoryGameReference { playerId: string; gameId: string; leagueId: string; seasonId: string; gameStartTs: string }
const referenceSchema = z.object({ playerId: text, gameId: text, leagueId: text, seasonId: text, gameStartTs: instant });

/** Internal, strongly consistent source reader. Cursors are server checkpoints, not authorisation.
 * Each call issues at most one bounded query; callers must persist and exhaust every continuation. */
export class HistorySource {
  constructor(private readonly client: HistoryClient, private readonly tableName: string) {}

  private async get(pk: string, sk: string): Promise<HistoryItem | null> {
    if (Buffer.byteLength(pk) > 2048 || Buffer.byteLength(sk) > 1024) fail('Source key exceeds its storage budget.');
    const result = await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem };
    return result.Item ?? null;
  }

  async captureContext(leagueId: string, playerId: string): Promise<HistoryContext> {
    text.parse(leagueId); text.parse(playerId);
    const planner = new PlayerIdentityPlanner(this.client, this.tableName);
    const control = await planner.readControl(); planner.requireDirectory(control);
    const readiness = await readHistoryReadiness(this.client, this.tableName);
    const identity = await planner.resolve(playerId);
    const pk = `LEAGUE#${leagueId}`, league = await this.get(pk, 'METADATA');
    if (!league || historyBody<{ leagueId: string }>(league, pk, 'METADATA', 'league').leagueId !== leagueId) fail('League is unavailable.');
    const live = await planner.liveScope('league', [leagueId]);
    const sourceKey = historySourceKey(leagueId), source = await this.get(sourceKey.pk, sourceKey.sk);
    if (!source) fail('History source writers are not ready.');
    const revision = z.object({ leagueId: text, version: z.literal(historySourceVersion), revision: text })
      .parse(historyBody(source, sourceKey.pk, sourceKey.sk, 'playerHistorySource'));
    if (revision.leagueId !== leagueId) fail('History source scope mismatch.');
    const snapshot = (item: HistoryItem, value: unknown): IdentitySnapshot<unknown> => ({ pk: item.pk!.S!, sk: item.sk!.S!, item, value });
    return { leagueId, playerId: identity.root.value.playerId, members: [...identity.root.value.members],
      displayName: identity.root.value.displayName, sourceRevision: revision.revision,
      readinessRevision: readiness.value.revision, ruleVersion: readiness.value.ruleVersion,
      identityWriteVersion: identity.root.value.writeVersion, identityEpoch: control.value.epoch,
      checks: [identityCondition(this.tableName, control), identityCondition(this.tableName, identity.root),
        ...(identity.original.pk === identity.root.pk ? [] : [identityCondition(this.tableName, identity.original)]),
        identityCondition(this.tableName, snapshot(league, null)), live, identityCondition(this.tableName, snapshot(source, revision)),
        identityCondition(this.tableName, readiness)] };
  }

  private async page(pk: string, prefix: string, entityType: string, binding: string, cursor: string | undefined, limit: number): Promise<HistoryPage<HistoryItem>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('Source page limit must be between one and 100.');
    let after: string | undefined;
    if (cursor !== undefined) {
      if (cursor.length > 8192) invalidCursor();
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (decoded.version !== 1 || decoded.binding !== binding || decoded.pk !== pk || decoded.prefix !== prefix
          || typeof decoded.sk !== 'string' || !decoded.sk.startsWith(prefix) || Buffer.byteLength(decoded.sk) > 1024) invalidCursor();
        after = decoded.sk;
      } catch { invalidCursor(); }
    }
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } },
      ...(after ? { ExclusiveStartKey: historyKey(pk, after) } : {}) })) as QueryCommandOutput;
    const items = result.Items ?? [];
    if (!Array.isArray(items) || items.length > limit) fail('Malformed source page.');
    let previous = after;
    for (const item of items) {
      const sk = item.sk?.S;
      if (item.pk?.S !== pk || !sk?.startsWith(prefix) || Buffer.byteLength(sk) > 1024 || (previous && Buffer.compare(Buffer.from(sk), Buffer.from(previous)) <= 0)) fail('Source page ordering is invalid.');
      historyBody(item, pk, sk, entityType); previous = sk;
    }
    const key = result.LastEvaluatedKey;
    if (!key || Object.keys(key).length === 0) return { items, cursor: null };
    const sk = key.sk?.S;
    if (key.pk?.S !== pk || !sk?.startsWith(prefix) || Buffer.byteLength(sk) > 1024
      || (after && Buffer.compare(Buffer.from(sk), Buffer.from(after)) <= 0)
      || (previous && Buffer.compare(Buffer.from(sk), Buffer.from(previous)) < 0)) fail('Source continuation did not advance.');
    return { items, cursor: Buffer.from(JSON.stringify({ version: 1, binding, pk, prefix, sk })).toString('base64url') };
  }

  async memberGamesPage(context: HistoryContext, memberId: string, cursor?: string, limit = 50): Promise<HistoryPage<HistoryGameReference>> {
    if (!context.members.includes(memberId)) fail('Player is outside the captured identity closure.');
    const pk = `PLAYER#${memberId}`;
    const page = await this.page(pk, 'GAME#', 'playerGameMembership', historyHash(context.leagueId, context.playerId,
      context.sourceRevision, context.identityWriteVersion, context.identityEpoch), cursor, limit);
    const references = page.items.map(item => {
      const value = referenceSchema.parse(historyBody(item, pk, item.sk!.S!, 'playerGameMembership'));
      if (value.playerId !== memberId || item.sk!.S !== identityGameSk(value.gameId)) fail('Malformed reverse game reference.');
      return value;
    });
    return { items: references.filter(value => value.leagueId === context.leagueId), cursor: page.cursor };
  }

  gameMetadata(gameId: string): Promise<HistoryItem | null> { text.parse(gameId); return this.get(`GAME#${gameId}`, 'METADATA'); }

  /** Reverse references preserve association, not live timestamps or existence. */
  async disposition(reference: HistoryGameReference): Promise<{ kind: 'skip' } | { kind: 'finished'; game: HistoryItem }> {
    const ref = referenceSchema.parse(reference);
    let deleted = false;
    for (const [kind, ids] of [['league', [ref.leagueId]], ['season', [ref.leagueId, ref.seasonId]], ['game', [ref.gameId]]] as const) {
      const sk = identityTombstoneSk(kind, [...ids]), item = await this.get('PLAYER_IDENTITY_TOMBSTONE', sk);
      if (!item) continue;
      const value = z.object({ kind: z.literal(kind), ids: z.array(text), game: z.unknown().optional() })
        .parse(historyBody(item, 'PLAYER_IDENTITY_TOMBSTONE', sk, 'playerIdentityTombstone'));
      if (JSON.stringify(value.ids) !== JSON.stringify(ids)) fail('Tombstone scope mismatch.');
      if (kind === 'game') {
        const context = z.object({ gameId: text, leagueId: text, seasonId: text, gameStartTs: instant }).parse(value.game);
        if (context.gameId !== ref.gameId || context.leagueId !== ref.leagueId || context.seasonId !== ref.seasonId)
          fail('Deleted game scope mismatch.');
      }
      deleted = true;
    }
    if (deleted) return { kind: 'skip' };
    const game = await this.gameMetadata(ref.gameId);
    if (!game) fail('Referenced game is missing without deletion evidence.');
    const value = z.object({ gameId: text, leagueId: text, seasonId: text, gameStartTs: instant,
      status: z.enum(['scheduled', 'live', 'finished']) }).parse(historyBody(game, `GAME#${ref.gameId}`, 'METADATA', 'game'));
    if (value.gameId !== ref.gameId || value.leagueId !== ref.leagueId || value.seasonId !== ref.seasonId)
      fail('Referenced game scope mismatch.');
    return value.status === 'finished' ? { kind: 'finished', game } : { kind: 'skip' };
  }
  async gamePartitionPage(gameId: string, part: HistoryGamePart, cursor?: string, limit = 50): Promise<HistoryPage<HistoryItem>> {
    text.parse(gameId);
    if (!Object.hasOwn(parts, part)) fail('Unknown game source partition.');
    const [prefix, type] = parts[part];
    return this.page(`GAME#${gameId}`, prefix, type, historyHash(gameId, part), cursor, limit);
  }
}

const rawGoalSchema = z.object({ gameId: text, eventId: text, scorerPlayerId: text, assistPlayerIds: z.array(text),
  scoringTeamId: team.nullable(), concedingTeamId: team, ownGoal: z.boolean(),
  // Legacy timing is optional evidence, not a prerequisite for valid aggregate credit.
  third: z.unknown().optional(), elapsedSeconds: z.unknown().optional(),
  gameMinute: z.unknown().optional(), thirdMinute: z.unknown().optional(),
  timingProvenance: z.object({ version: z.literal(1), kind: z.enum(['live', 'post_completion']) }).optional() });

/** Assemble only after ALL four partitions have been exhausted. A partial collection can never
 * establish zero events; callers must persist page-completion markers and fence sourceRevision
 * before publishing. This bounded pure adapter deliberately does not fetch or repair missing data. */
export function assembleMatchFacts(input: {
  context: HistoryContext; game: HistoryItem; roster: readonly HistoryItem[]; goals: readonly HistoryItem[];
  audits: readonly HistoryItem[]; teams: readonly HistoryItem[]; canonicalIds: ReadonlyMap<string, string>;
}): MatchFacts | null {
  if (input.roster.length + input.goals.length + input.audits.length + input.teams.length > 10000) fail('Game source exceeds assembly budget.');
  const metadata = z.object({ gameId: text, leagueId: text, seasonId: text, gameStartTs: instant,
    status: z.enum(['scheduled', 'live', 'finished']), finishedAt: instant.nullish(), thirdLengthMinutes: z.union([z.literal(20), z.literal(25), z.literal(30)]),
    thirds: z.unknown().optional(),
    result: z.unknown().optional() }).parse(historyBody(input.game, input.game.pk!.S!, 'METADATA', 'game'));
  const pk = `GAME#${metadata.gameId}`;
  if (input.game.pk?.S !== pk || metadata.leagueId !== input.context.leagueId) fail('Game scope mismatch.');
  if (metadata.status !== 'finished') return null;
  const canonical = (id: string) => { const result = input.canonicalIds.get(id); if (!result?.trim()) fail('Unresolved canonical player.'); return result; };
  const roster = input.roster.map(item => {
    const value = z.object({ gameId: text, playerId: text, teamId: team }).parse(historyBody(item, pk, item.sk!.S!, 'roster'));
    if (value.gameId !== metadata.gameId || item.sk?.S !== `ROSTER#${value.teamId}#${value.playerId}`) fail('Malformed roster identity.');
    return { playerId: canonical(value.playerId), teamId: value.teamId };
  });
  const thirdSchema = z.object({ third: z.union([z.literal(1), z.literal(2), z.literal(3)]), startedAt: instant, finishedAt: instant });
  const thirdRows = Array.isArray(metadata.thirds) ? metadata.thirds : [];
  const thirds = ([1, 2, 3] as const).map(number => {
    const candidates = thirdRows.filter(value => value && typeof value === 'object' && value.third === number);
    if (candidates.length !== 1) return null;
    const parsed = thirdSchema.safeParse(candidates[0]);
    if (!parsed.success || parsed.data.finishedAt < parsed.data.startedAt
      || (metadata.finishedAt && parsed.data.finishedAt > metadata.finishedAt)) return null;
    return parsed.data;
  });
  // Contradictory or overlapping third intervals cannot establish live provenance.
  if (thirds.some((value, index) => value && thirds.slice(0, index).some(prior => prior && prior.finishedAt > value.startedAt))) thirds.fill(null);
  // Older finished matches may lack finalisation metadata. Only a complete,
  // unambiguous clock history can supply their recorded end of play; never use
  // migration time or row updatedAt as the historical achievement date.
  const finishedAt = metadata.finishedAt
    ?? (thirdRows.length === 3 && thirds.every(Boolean) ? thirds[2]!.finishedAt : null);
  if (!finishedAt) fail('Incomplete finished match metadata.');
  const ends = thirds.map(third => {
    if (!third) return null;
    const elapsed = Math.floor((Date.parse(third.finishedAt) - Date.parse(third.startedAt)) / 1000);
    return elapsed;
  }) as [number | null, number | null, number | null];
  const creationAudits = new Map<string, { createdAt: string | null; after: Record<string, unknown> | null }[]>();
  for (const item of input.audits) {
    const value = z.object({ auditId: text, gameId: text, eventId: text, action: z.enum(['goal_created', 'goal_updated', 'goal_deleted', 'goal_undo_last']),
      after: z.unknown().optional() }).parse(historyBody(item, pk, item.sk!.S!, 'goalAudit'));
    if (value.gameId !== metadata.gameId || !item.sk?.S?.startsWith('AUDIT#GOAL#') || !item.sk.S.endsWith(`#${value.auditId}`)) fail('Malformed goal audit.');
    // Audits are optional timing evidence. A damaged legacy timestamp cannot
    // invalidate otherwise consistent goal credit and final aggregate statistics.
    const parsedAt = instant.safeParse(item.createdAt?.S);
    const createdAt = parsedAt.success && item.sk.S === goalAuditSk(item.createdAt!.S!, value.auditId) ? parsedAt.data : null;
    const after = z.record(z.string(), z.unknown()).safeParse(value.after);
    // Count damaged creation records too: a second unusable creation audit must
    // not make another record appear to be unique original timing evidence.
    if (value.action === 'goal_created') creationAudits.set(value.eventId, [...(creationAudits.get(value.eventId) ?? []),
      { createdAt, after: after.success ? after.data : null }]);
  }
  const goals: MatchGoal[] = input.goals.map(item => {
    const raw = rawGoalSchema.parse(historyBody(item, pk, item.sk!.S!, 'goal'));
    if (raw.gameId !== metadata.gameId || !item.sk?.S?.startsWith(`GOAL#`) || !item.sk.S.endsWith(`#${raw.eventId}`)) fail('Malformed goal identity.');
    const thirdNumber = raw.third === 1 || raw.third === 2 || raw.third === 3 ? raw.third : null;
    const elapsed = nonnegative.safeParse(raw.elapsedSeconds), gameMinute = nonnegative.safeParse(raw.gameMinute);
    const thirdMinute = nonnegative.safeParse(raw.thirdMinute);
    const keyTimingProof = thirdNumber !== null && elapsed.success && gameMinute.success
      && item.sk.S === goalSk(thirdNumber, gameMinute.data, elapsed.data, raw.eventId);
    const parsedCreatedAt = instant.safeParse(item.createdAt?.S);
    const createdAt = parsedCreatedAt.success ? parsedCreatedAt.data : null;
    const audits = creationAudits.get(raw.eventId) ?? [];
    const audit = audits.length === 1 ? audits[0] : null;
    const auditAfter = audit?.after;
    const third = thirdNumber ? thirds[thirdNumber - 1] : null;
    const intervalProof = keyTimingProof && third && elapsed.success && createdAt !== null
      && createdAt >= third.startedAt && createdAt <= third.finishedAt
      && Math.floor((Date.parse(createdAt) - Date.parse(third.startedAt)) / 1000) === elapsed.data;
    const auditProof = thirdMinute.success && audit && createdAt !== null && audit.createdAt === createdAt && auditAfter && auditAfter.eventId === raw.eventId
      && ['third', 'elapsedSeconds', 'gameMinute', 'thirdMinute'].every(key =>
        raw[key as keyof typeof raw] !== undefined && auditAfter[key] === raw[key as keyof typeof raw]);
    const timing = raw.timingProvenance?.kind === 'post_completion' || (createdAt !== null && createdAt > finishedAt!) ? 'post_completion'
      // A legacy creation at the exact completion instant may be a finished-game insertion.
      : intervalProof && (raw.timingProvenance?.kind === 'live' || (createdAt !== null && createdAt < finishedAt! && auditProof)) ? 'live' : 'unknown';
    return { eventId: raw.eventId, scorerPlayerId: canonical(raw.scorerPlayerId), assistPlayerIds: raw.assistPlayerIds.map(canonical),
      scoringTeamId: raw.scoringTeamId, concedingTeamId: raw.concedingTeamId, ownGoal: raw.ownGoal,
      createdAt, timing, third: timing === 'live' ? thirdNumber : null, elapsedSeconds: timing === 'live' && elapsed.success ? elapsed.data : null };
  });
  const totals: Record<TeamId, { scored: number; conceded: number }> = { red: { scored: 0, conceded: 0 }, blue: { scored: 0, conceded: 0 }, yellow: { scored: 0, conceded: 0 } };
  for (const goal of goals) { totals[goal.concedingTeamId].conceded++; if (!goal.ownGoal && goal.scoringTeamId) totals[goal.scoringTeamId].scored++; }
  const storedTeams = input.teams.map(item => {
    // Legacy teams were created before counters existed. An exhausted empty
    // current goal stream proves zero, but cannot excuse a present bad value
    // or reconstruct missing counters in a match containing scored events.
    const counter = goals.length === 0 ? nonnegative.default(0) : nonnegative;
    const value = z.object({ gameId: text, teamId: team, scored: counter, conceded: counter }).parse(historyBody(item, pk, item.sk!.S!, 'gameTeam'));
    if (value.gameId !== metadata.gameId || item.sk?.S !== `TEAM#${value.teamId}`) fail('Malformed team record.');
    return value;
  });
  if (storedTeams.length !== 3 || new Set(storedTeams.map(value => value.teamId)).size !== 3) fail('All three team totals are required.');
  for (const value of storedTeams) if (value.scored !== totals[value.teamId].scored || value.conceded !== totals[value.teamId].conceded) fail('Goal history and team totals disagree.');
  const winners = leaders(totals);
  // With all goals and all three stored totals agreeing, the canonical
  // comparator is assessable even when a legacy result was never saved.
  // A present result remains independent evidence and must agree exactly.
  if (metadata.result !== null && metadata.result !== undefined) {
    const result = z.object({ winnerTeamId: team.nullable(), outcome: z.enum(['win', 'draw']), comparator: z.literal('fewest_conceded_then_most_scored'),
      teams: z.array(z.object({ teamId: team, scored: nonnegative, conceded: nonnegative, outcome: z.enum(['win', 'draw', 'loss']) })) }).parse(metadata.result);
    if (result.winnerTeamId !== (winners.length === 1 ? winners[0] : null) || result.outcome !== (winners.length === 1 ? 'win' : 'draw')
      || result.teams.length !== 3 || new Set(result.teams.map(value => value.teamId)).size !== 3) fail('Stored final result disagrees with goals.');
    for (const value of result.teams) if (value.scored !== totals[value.teamId].scored || value.conceded !== totals[value.teamId].conceded
      || value.outcome !== (winners.includes(value.teamId) ? winners.length === 1 ? 'win' : 'draw' : 'loss')) fail('Stored team result disagrees with goals.');
  }
  return matchFactsSchema.parse({ gameId: metadata.gameId, leagueId: metadata.leagueId, seasonId: metadata.seasonId,
    kickoffAt: metadata.gameStartTs, finishedAt, sourceRevision: input.context.sourceRevision,
    thirdLengthMinutes: metadata.thirdLengthMinutes, thirdEndsSeconds: ends, roster, goals });
}
