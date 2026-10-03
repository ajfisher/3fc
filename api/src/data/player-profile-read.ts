import { GetItemCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_RULE_VERSION, TEAM_IDS,
  type AchievementScopeContext, type AchievementUnlock, type PlayerPerformance, type PlayerHistoryPage,
  type PlayerAchievements, type PlayerUnlockPage, type ProjectionFreshness, type PlayerAppearance, type PlayerTotals } from '@3fc/contracts';
import { progressFor, publicUnlock, type AchievementAccumulator } from '../achievements/evaluate.js';
import { identityCondition, PlayerIdentityError } from './player-identity.js';
import { PlayerProfileAccess, type ProfileAccessSnapshot } from './player-profile-access.js';
import { getProfileSeasonDefault } from './player-profile-season.js';
import { historyReadinessSchema } from './player-history-readiness.js';
import { PlayerHistoryStore } from './player-history-store.js';
import { IdentityReadCache } from './identity-read-cache.js';
import { historyJobKey } from './player-history-coordinator.js';
import { historyBody, historyKey, historyPartition, PlayerHistoryError,
  type HistoryClient, type HistoryItem, type HistoryPublication } from './player-history-model.js';

const text = z.string().min(1), integer = z.number().int().nonnegative().safe();
const instant = z.string().datetime({ offset: true });
const achievementIds = ACHIEVEMENT_DEFINITIONS.map(def => def.id) as [typeof ACHIEVEMENT_DEFINITIONS[number]['id'], ...typeof ACHIEVEMENT_DEFINITIONS[number]['id'][]];
export const appearanceSchema = z.object({ gameId: text, seasonId: text, kickoffAt: instant, finishedAt: instant,
  teamId: z.enum(TEAM_IDS), outcome: z.enum(['win', 'draw', 'loss']), goals: integer, assists: integer, ownGoals: integer,
  scored: integer, conceded: integer }).strict();
export const totalsSchema = z.object({ played: integer, goals: integer, assists: integer, ownGoals: integer,
  wins: integer, draws: integer, losses: integer, goalsPerGame: z.number().finite().nonnegative() }).strict();
const unlockFields = { id: text, achievementId: z.enum(achievementIds), ordinal: integer.min(1), threshold: integer.min(1), earnedAt: instant, gameId: text };
export const unlockSchema = z.discriminatedUnion('scope', [
  z.object({ ...unlockFields, scope: z.literal('season'), seasonId: text }).strict(),
  z.object({ ...unlockFields, scope: z.literal('career'), seasonId: z.null() }).strict()
]);
export const freshnessSchema = z.object({ status: z.enum(['ready', 'updating', 'unavailable']),
  coverage: z.enum(['complete', 'partial', 'unknown']), revision: text.nullable(), computedAt: instant.nullable() }).strict();
export const progressSchema = z.object({ achievementId: z.enum(achievementIds), count: integer, ordinal: integer,
  nextThreshold: integer.min(1), assessability: z.enum(['complete', 'partial']), currentRun: integer.nullable(), highest: unlockSchema.nullable() }).strict();
const publicationSchema = z.object({ generation: text, leagueId: text, playerId: text, sourceRevision: text,
  readinessRevision: text.optional(), ruleVersion: integer.optional(), identityWriteVersion: text, identityEpoch: text,
  calculatedAt: instant, latest: appearanceSchema.nullable(), seasons: z.array(z.object({ seasonId: text, lastPlayedAt: instant }).strict()).max(256),
  previousGeneration: text.nullable() }).strict();
export interface ProfileReadInput { leagueId: string; playerId: string; userId: string; userIds?: string[]; viewerPlayerId?: string }
export interface ProfileFeatureFlags { profiles: boolean; achievements: boolean; ownerEditing: boolean }
export const profileFeatureFlags = (): ProfileFeatureFlags => ({ profiles: process.env.PLAYER_PROFILES_ENABLED === 'true',
  achievements: process.env.PLAYER_ACHIEVEMENTS_ENABLED === 'true', ownerEditing: process.env.PLAYER_OWNER_EDITING_ENABLED === 'true' });
export interface ProfileAccessReader {
  authorize(input: ProfileReadInput): Promise<ProfileAccessSnapshot>;
  assertCurrent(checks: TransactWriteItem[], projectionChecks?: TransactWriteItem[]): Promise<void>;
}
interface View { grant: ProfileAccessSnapshot; publication: HistoryPublication | null; checks: TransactWriteItem[]; freshness: ProjectionFreshness }
const unavailable = () => new PlayerHistoryError('history_unavailable', 'Player history is unavailable.');
const safeTotals = (value: PlayerTotals) => totalsSchema.parse({ played: value.played, goals: value.goals, assists: value.assists,
  ownGoals: value.ownGoals, wins: value.wins, draws: value.draws, losses: value.losses, goalsPerGame: value.goalsPerGame });
const safeAppearance = (value: PlayerAppearance) => appearanceSchema.parse({ gameId: value.gameId, seasonId: value.seasonId,
  kickoffAt: value.kickoffAt, finishedAt: value.finishedAt, teamId: value.teamId, outcome: value.outcome, goals: value.goals,
  assists: value.assists, ownGoals: value.ownGoals, scored: value.scored, conceded: value.conceded });
const safeUnlock = (value: AchievementUnlock) => unlockSchema.parse(publicUnlock(value));

/** Safe reads only. Internal generation/checkpoint/source snapshots never leave this service.
 * Every successful response finishes with one transaction that checks authority and the
 * exact publication/source/readiness snapshots together. No request scans history. */
export class PlayerProfileReadService {
  private readonly store: PlayerHistoryStore;
  constructor(private readonly client: HistoryClient, private readonly tableName: string,
    private readonly access: ProfileAccessReader = new PlayerProfileAccess(client, tableName),
    private readonly flags: ProfileFeatureFlags = profileFeatureFlags()) { this.store = new PlayerHistoryStore(client, tableName); }
  private async get(pk: string, sk: string): Promise<HistoryItem | null> {
    return (await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
  }
  private check(item: HistoryItem | null, pk: string, sk: string): TransactWriteItem {
    return identityCondition(this.tableName, { pk, sk, item, value: null });
  }
  private async view(input: ProfileReadInput, achievement = false): Promise<View> {
    if (!this.flags.profiles || (achievement && !this.flags.achievements))
      throw new PlayerIdentityError('player_profiles_disabled', 404, 'Player profiles are unavailable.');
    const grant = await this.access.authorize(input), leagueId = grant.league.leagueId, playerId = grant.player.playerId;
    const pk = `LEAGUE#${leagueId}`, publicationPk = historyPartition(leagueId, playerId);
    const settled = await Promise.allSettled([this.get(pk, 'HISTORY_SOURCE'), this.get('PLAYER_HISTORY', 'CONTROL'), this.get(publicationPk, 'PUBLISHED')]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    const [source, readiness, published] = settled.map(result => (result as PromiseFulfilledResult<HistoryItem | null>).value);
    const checks = [this.check(source, pk, 'HISTORY_SOURCE'), this.check(readiness, 'PLAYER_HISTORY', 'CONTROL'), this.check(published, publicationPk, 'PUBLISHED')];
    let publication: HistoryPublication | null = null;
    const freshness: ProjectionFreshness = { status: 'unavailable', coverage: 'unknown', revision: null, computedAt: null };
    try {
      if (published) publication = publicationSchema.parse(historyBody(published, publicationPk, 'PUBLISHED', 'playerHistoryPublication'));
      if (publication && (publication.leagueId !== leagueId || publication.playerId !== playerId)) throw unavailable();
      if (source && readiness) {
        const revision = z.object({ version: z.literal(1), leagueId: z.literal(leagueId), revision: text }).strict()
          .parse(historyBody(source, pk, 'HISTORY_SOURCE', 'playerHistorySource')).revision;
        const ready = historyReadinessSchema.parse(historyBody(readiness, 'PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness'));
        if (ready.manifest.tableName !== this.tableName) throw unavailable();
        freshness.revision = revision;
        if (publication?.sourceRevision === revision && publication.readinessRevision === ready.revision && publication.ruleVersion === ACHIEVEMENT_RULE_VERSION) {
          freshness.status = 'ready'; freshness.coverage = 'complete'; freshness.computedAt = publication.calculatedAt;
        } else {
          freshness.status = 'updating';
          const job = await this.get(pk, historyJobKey(playerId));
          if (job) {
            const value = historyBody<{ status?: string; requestedRevision?: string }>(job, pk, historyJobKey(playerId), 'playerHistoryJob');
            if (value.status === 'failed' && value.requestedRevision === revision) freshness.status = 'unavailable';
          }
        }
      }
    } catch (error) {
      if (!(error instanceof z.ZodError || error instanceof PlayerHistoryError)) throw error;
      publication = null; freshness.status = 'unavailable'; freshness.coverage = 'unknown'; freshness.computedAt = null;
    }
    return { grant, publication, checks, freshness };
  }
  private finish(view: View): Promise<void> { return this.access.assertCurrent(view.grant.checks, view.checks); }
  private async summary(view: View, scope: AchievementScopeContext) {
    const summary = await this.store.getSummary(view.grant.league.leagueId, view.grant.player.playerId, scope);
    if (!summary) throw unavailable();
    const state = summary.state, context = state.context;
    if (context && (context.playerId !== view.grant.player.playerId || context.leagueId !== view.grant.league.leagueId
      || context.scope !== scope.scope || context.seasonId !== scope.seasonId || context.ruleVersion !== ACHIEVEMENT_RULE_VERSION)) throw unavailable();
    const knownAppearances = scope.scope === 'career' ? Boolean(view.publication?.latest || view.publication?.seasons.length)
      : Boolean(view.publication?.seasons.some(value => value.seasonId === scope.seasonId));
    if ((!context && (state.totals.played !== 0 || knownAppearances)) || (knownAppearances && state.totals.played === 0)) throw unavailable();
    safeTotals(state.totals);
    const totals = state.totals;
    if (totals.wins + totals.draws + totals.losses !== totals.played
      || totals.goalsPerGame !== (totals.played ? totals.goals / totals.played : 0)
      || (!totals.played && (totals.goals || totals.assists || totals.ownGoals))) throw unavailable();
    for (const def of ACHIEVEMENT_DEFINITIONS) integer.parse(state.counts[def.id]);
    for (const id of state.uncertain) if (!achievementIds.includes(id)) throw unavailable();
    for (const key of Object.keys(state.highest)) if (!achievementIds.includes(key as typeof achievementIds[number])) throw unavailable();
    const maps = [state.highest, (state as AchievementAccumulator & { first?: Partial<Record<string, AchievementUnlock>> }).first];
    for (const [index, map] of maps.entries()) if (map !== undefined) for (const [id, raw] of Object.entries(map)) {
      if (!raw) throw unavailable(); const value = safeUnlock(raw);
      if (value.achievementId !== id || value.scope !== scope.scope || value.seasonId !== scope.seasonId || (index === 1 && value.ordinal !== 1)) throw unavailable();
    }
    return summary;
  }
  private async season(leagueId: string, seasonId: string, client: HistoryClient = this.client): Promise<{ seasonId: string; name: string }> {
    const pk = `LEAGUE#${leagueId}`, sk = `SEASON#${seasonId}`;
    const item = (await client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item;
    if (!item) throw new PlayerIdentityError('season_not_found', 404, 'The selected season is unavailable.');
    const value = z.object({ leagueId: z.literal(leagueId), seasonId: z.literal(seasonId), name: text })
      .parse(historyBody(item, pk, sk, 'season'));
    return { seasonId: value.seasonId, name: value.name };
  }
  async performance(input: ProfileReadInput & { seasonId?: string }): Promise<PlayerPerformance> {
    const deadlineMs = Date.now() + 6000;
    const view = await this.view(input), { grant, publication } = view;
    let selectedSeasonId = input.seasonId ?? (view.freshness.status === 'ready' ? publication?.latest?.seasonId : null) ?? null;
    const seasons = new Map<string, { seasonId: string; name: string }>();
    if (input.seasonId !== undefined) seasons.set(input.seasonId, await this.season(grant.league.leagueId, input.seasonId));
    let season: PlayerTotals | null = null, career: PlayerTotals | null = null, latest: PlayerAppearance | null = null;
    if (view.freshness.status === 'ready' && publication) {
      const fallback = await getProfileSeasonDefault(this.client, this.tableName, grant.league.leagueId);
      view.checks.push(identityCondition(this.tableName, fallback));
      const currentFallback = fallback.value?.sourceRevision === publication.sourceRevision && fallback.value.readinessRevision === publication.readinessRevision ? fallback.value : null;
      if (!selectedSeasonId) {
        if (!currentFallback) { view.freshness = { ...view.freshness, status: 'updating', coverage: 'unknown', computedAt: null }; }
        else selectedSeasonId = currentFallback.season?.seasonId ?? null;
      }
      const ids = [...new Set([...publication.seasons.map(value => value.seasonId), ...(currentFallback?.season ? [currentFallback.season.seasonId] : []), ...(selectedSeasonId ? [selectedSeasonId] : [])])];
      if (ids.length > 258) throw unavailable();
      // Three bounded batches cover the maximum catalog; the cache settles every
      // sibling request on failure and retries unprocessed keys within one deadline.
      const cache = new IdentityReadCache(this.client, this.tableName, { deadlineMs, deadlineError: unavailable() });
      await cache.prefetch(ids.filter(id => !seasons.has(id)).map(id => ({ pk: `LEAGUE#${grant.league.leagueId}`, sk: `SEASON#${id}` })));
      for (const id of ids) if (!seasons.has(id)) seasons.set(id, await this.season(grant.league.leagueId, id, cache));
      if (view.freshness.status === 'ready') {
        const summary = await this.summary(view, { scope: 'career', seasonId: null });
        career = safeTotals(summary.state.totals);
        if (selectedSeasonId) {
          const selected = await this.summary(view, { scope: 'season', seasonId: selectedSeasonId });
          season = safeTotals(selected.state.totals);
        }
        latest = publication.latest ? safeAppearance(publication.latest) : null;
      }
    }
    await this.finish(view);
    return { player: { playerId: grant.player.playerId, displayName: grant.player.displayName, hasPortrait: grant.player.hasPortrait },
      league: { leagueId: grant.league.leagueId, name: grant.league.name }, seasons: [...seasons.values()].sort((a, b) => a.seasonId < b.seasonId ? -1 : a.seasonId > b.seasonId ? 1 : 0),
      selectedSeasonId, latest, season, career, freshness: view.freshness,
      capabilities: { editProfile: grant.owner && this.flags.ownerEditing, achievements: this.flags.achievements } };
  }
  async history(input: ProfileReadInput & { seasonId?: string; cursor?: string }): Promise<PlayerHistoryPage> {
    const view = await this.view(input), { grant } = view;
    if (input.seasonId !== undefined) await this.season(grant.league.leagueId, input.seasonId);
    let matches: PlayerAppearance[] | null = null, cursor: string | null = null;
    if (view.freshness.status === 'ready') {
      const page = await this.store.pageMatches({ leagueId: grant.league.leagueId, playerId: grant.player.playerId, seasonId: input.seasonId, cursor: input.cursor, limit: 20 });
      if (!page) throw unavailable(); matches = page.items.map(safeAppearance);
      if (input.seasonId !== undefined && matches.some(value => value.seasonId !== input.seasonId)) throw unavailable();
      cursor = page.cursor;
    } else if (input.cursor) throw new PlayerHistoryError('history_changed', 'Player history changed. Start again from the first page.');
    await this.finish(view); return { matches, cursor, freshness: view.freshness };
  }
  async achievements(input: ProfileReadInput & { scope: AchievementScopeContext }): Promise<PlayerAchievements> {
    const view = await this.view(input, true), { grant, publication } = view;
    if (input.scope.scope === 'season') await this.season(grant.league.leagueId, input.scope.seasonId);
    let progress: PlayerAchievements['progress'] = null, honours: AchievementUnlock[] | null = null,
      firstUnlocks: AchievementUnlock[] | null = null, latestUnlocks: AchievementUnlock[] | null = null;
    if (view.freshness.status === 'ready' && publication) {
      const summary = await this.summary(view, input.scope);
      progress = progressFor(summary.state).map(value => progressSchema.parse(value));
      honours = Object.values(summary.state.highest).map(value => safeUnlock(value!));
      const first = (summary.state as AchievementAccumulator & { first?: Partial<Record<string, AchievementUnlock>> }).first;
      firstUnlocks = first === undefined ? null : Object.values(first).map(value => safeUnlock(value!));
      latestUnlocks = [];
      if (publication.latest) {
        const scopes: AchievementScopeContext[] = [{ scope: 'career', seasonId: null }, { scope: 'season', seasonId: publication.latest.seasonId }];
        for (const scope of scopes) {
          const latestState = scope.scope === input.scope.scope && scope.seasonId === input.scope.seasonId ? summary
            : await this.summary(view, scope);
          latestUnlocks.push(...Object.values(latestState.state.highest).filter(value => value?.gameId === publication.latest!.gameId).map(value => safeUnlock(value!)));
        }
      }
      if (honours.length > 23 || (firstUnlocks?.length ?? 0) > 23 || latestUnlocks.length > 46) throw unavailable();
    }
    await this.finish(view);
    return { playerId: grant.player.playerId, leagueId: grant.league.leagueId, ...input.scope,
      progress, honours, firstUnlocks, latestUnlocks, freshness: view.freshness };
  }
  async unlocks(input: ProfileReadInput & { scope: AchievementScopeContext; cursor?: string }): Promise<PlayerUnlockPage> {
    const view = await this.view(input, true), { grant } = view;
    if (input.scope.scope === 'season') await this.season(grant.league.leagueId, input.scope.seasonId);
    let unlocks: AchievementUnlock[] | null = null, cursor: string | null = null;
    if (view.freshness.status === 'ready') {
      const page = await this.store.pageAwards({ leagueId: grant.league.leagueId, playerId: grant.player.playerId, scope: input.scope, cursor: input.cursor, limit: 20 });
      if (!page) throw unavailable(); unlocks = page.items.map(safeUnlock);
      if (unlocks.some(value => value.scope !== input.scope.scope || value.seasonId !== input.scope.seasonId)) throw unavailable();
      cursor = page.cursor;
    } else if (input.cursor) throw new PlayerHistoryError('history_changed', 'Player history changed. Start again from the first page.');
    await this.finish(view); return { unlocks, cursor, freshness: view.freshness };
  }
}
