import type { MyPlayerProfilesPage } from './data/my-player-profiles.js';
import { z } from 'zod';
import { ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_RULE_VERSION, ACHIEVEMENT_CONDITIONS, COMMON_MILESTONES, RARE_MILESTONES,
  type AchievementScopeContext, type PlayerPerformance, type PlayerHistoryPage, type PlayerAchievements, type PlayerUnlockPage } from '@3fc/contracts';
import type { AuthSessionRecord } from './auth/magic-link.js';
import { PlayerIdentityError } from './data/player-identity.js';
import { PlayerHistoryError } from './data/player-history-model.js';
import type { PlayerAccessPage } from './data/player-profile-access.js';
import { appearanceSchema, totalsSchema, freshnessSchema, unlockSchema, progressSchema, profileFeatureFlags,
  type ProfileReadInput, type ProfileFeatureFlags } from './data/player-profile-read.js';

export interface PlayerProfileRepository {
  listMyPlayerProfiles(input: { userId: string; userIds?: string[]; cursor?: string }): Promise<MyPlayerProfilesPage>;
  getPlayerPerformance(input: ProfileReadInput & { seasonId?: string }): Promise<PlayerPerformance>;
  getPlayerHistory(input: ProfileReadInput & { seasonId?: string; cursor?: string }): Promise<PlayerHistoryPage>;
  getPlayerAchievements(input: ProfileReadInput & { scope: AchievementScopeContext }): Promise<PlayerAchievements>;
  getPlayerUnlocks(input: ProfileReadInput & { scope: AchievementScopeContext; cursor?: string }): Promise<PlayerUnlockPage>;
  listPlayerAccess(input: { leagueId: string; userId: string; userIds?: string[]; cursor?: string; limit?: number }): Promise<PlayerAccessPage>;
}
const id = (prefix: string, bytes = 2048) => z.string().min(1).refine(value => {
  try { encodeURIComponent(value); } catch { return false; }
  return value.trim().length > 0 && Buffer.byteLength(prefix + value) <= bytes;
});
const playerId = id('PLAYER#'), leagueId = id('LEAGUE#'), seasonId = id('SEASON#', 1024), label = z.string().min(1);
export const playerPerformanceSchema = z.object({ player: z.object({ playerId, displayName: label, hasPortrait: z.boolean() }).strict(),
  league: z.object({ leagueId, name: label }).strict(), seasons: z.array(z.object({ seasonId, name: label }).strict()).max(258),
  selectedSeasonId: seasonId.nullable(), latest: appearanceSchema.nullable(), season: totalsSchema.nullable(), career: totalsSchema.nullable(),
  freshness: freshnessSchema, capabilities: z.object({ editProfile: z.boolean(), achievements: z.boolean() }).strict() }).strict();
export const playerHistoryPageSchema = z.object({ matches: z.array(appearanceSchema).max(20).nullable(), cursor: z.string().nullable(), freshness: freshnessSchema }).strict();
const uniqueClasses = (values: Array<{ achievementId: string }>) => new Set(values.map(value => value.achievementId)).size === values.length;
const achievementsFields = { playerId, leagueId, progress: z.array(progressSchema).length(23).refine(uniqueClasses).nullable(),
  honours: z.array(unlockSchema).max(23).refine(uniqueClasses).nullable(),
  firstUnlocks: z.array(unlockSchema).max(23).refine(uniqueClasses).refine(values => values.every(value => value.ordinal === 1)).nullable(),
  latestUnlocks: z.array(unlockSchema).max(46).nullable(), freshness: freshnessSchema };
export const playerAchievementsSchema = z.discriminatedUnion('scope', [
  z.object({ ...achievementsFields, scope: z.literal('season'), seasonId }).strict(),
  z.object({ ...achievementsFields, scope: z.literal('career'), seasonId: z.null() }).strict()
]);
export const playerUnlockPageSchema = z.object({ unlocks: z.array(unlockSchema).max(20).nullable(), cursor: z.string().nullable(), freshness: freshnessSchema }).strict();
export const playerAccessPageSchema = z.object({ leagueId, hasLeagueAcl: z.boolean(), players: z.array(z.object({ playerId, displayName: label }).strict()).max(20),
  cursor: z.string().nullable(), complete: z.boolean() }).strict();
export const myPlayerProfilesSchema = z.object({ profiles: z.array(z.object({ playerId, displayName: label, leagueId, leagueName: label }).strict()).max(5), cursor: z.string().nullable(), complete: z.boolean() }).strict();
const paths = ['/v1/my-player-profiles', '/v1/player-profile', '/v1/player-history', '/v1/player-achievements', '/v1/player-unlocks', '/v1/player-access', '/v1/achievement-catalogue'];
export const isPlayerProfileRoute = (method: string, route: string): boolean => method === 'GET' && paths.includes(route);
function query(raw: string, allowed: string[]): Record<string, string> {
  if (raw.length > 24_000) throw new URIError();
  const fields: Record<string, string> = Object.create(null);
  if (!raw) return fields;
  for (const field of raw.split('&')) {
    const at = field.indexOf('='); if (at < 0) throw new URIError();
    const key = decodeURIComponent(field.slice(0, at).replaceAll('+', ' '));
    const value = decodeURIComponent(field.slice(at + 1).replaceAll('+', ' ')); encodeURIComponent(value);
    if (!allowed.includes(key) || Object.hasOwn(fields, key)) throw new URIError();
    fields[key] = value;
  }
  return fields;
}
/** One handler for local HTTP and Lambda. Trusted account IDs come only from the
 * session; query player IDs remain authorisation hints, never ownership claims. */
export async function handlePlayerProfileRoute(input: { method: string; route: string; rawQueryString?: string;
  session: AuthSessionRecord | null; repository: PlayerProfileRepository; flags?: ProfileFeatureFlags }): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const response = (statusCode: number, error: string, message: string, code?: string) => ({ statusCode, payload: { error, message, ...(code ? { code } : {}) } });
  if (!input.session) return response(401, 'unauthorized', 'Sign in to continue.');
  if (!isPlayerProfileRoute(input.method, input.route)) return response(404, 'not_found', 'Not found.');
  const flags = input.flags ?? profileFeatureFlags();
  const catalogue = input.route === '/v1/achievement-catalogue', mine = input.route === '/v1/my-player-profiles';
  const needsAchievements = catalogue || ['/v1/player-achievements', '/v1/player-unlocks'].includes(input.route);
  if ((!catalogue && !flags.profiles) || (needsAchievements && !flags.achievements)) return response(404, 'not_found', 'Not found.');
  const invalid = () => response(400, 'bad_request', 'Check the player link and try again.');
  let fields: Record<string, string>;
  try {
    const allowed = catalogue ? [] : mine ? ['cursor'] : input.route === '/v1/player-access' ? ['leagueId', 'cursor', 'limit']
      : ['leagueId', 'playerId', 'viewerPlayerId', ...(['/v1/player-profile', '/v1/player-history', '/v1/player-achievements', '/v1/player-unlocks'].includes(input.route) ? ['seasonId'] : []),
        ...(['/v1/player-history', '/v1/player-unlocks'].includes(input.route) ? ['cursor'] : []),
        ...(['/v1/player-achievements', '/v1/player-unlocks'].includes(input.route) ? ['scope'] : [])];
    fields = query(input.rawQueryString ?? '', allowed);
    if (mine && fields.cursor !== undefined && (!fields.cursor || fields.cursor.length > 8192)) return invalid();
    if (!catalogue && !mine && (!leagueId.safeParse(fields.leagueId).success
      || (input.route !== '/v1/player-access' && !playerId.safeParse(fields.playerId).success)
      || (fields.viewerPlayerId !== undefined && !playerId.safeParse(fields.viewerPlayerId).success)
      || (fields.seasonId !== undefined && !seasonId.safeParse(fields.seasonId).success)
      || (fields.cursor !== undefined && (!fields.cursor || fields.cursor.length > 8192))
      || (fields.limit !== undefined && !/^(?:[1-9]|1[0-9]|20)$/.test(fields.limit)))) return invalid();
    if (needsAchievements && !catalogue && (fields.scope !== 'season' && fields.scope !== 'career'
      || fields.scope === 'season' && !fields.seasonId || fields.scope === 'career' && fields.seasonId !== undefined)) return invalid();
  } catch { return invalid(); }
  if (catalogue) return { statusCode: 200, payload: { ruleVersion: ACHIEVEMENT_RULE_VERSION,
    achievements: ACHIEVEMENT_DEFINITIONS.map(({ id, name, rarity, rule, icon }) => ({ id, name, rarity, rule, icon })),
    milestones: { common: [...COMMON_MILESTONES], rare: [...RARE_MILESTONES], commonRepeatEvery: 100, rareRepeatEvery: 10,
      legendaryRepeatEvery: 1, epicRepeatEvery: 1 }, conditions: ACHIEVEMENT_CONDITIONS } };
  const userId = input.session.subject ?? input.session.email, userIds = [...new Set([userId, input.session.email])];
  const base: ProfileReadInput = { leagueId: fields.leagueId, playerId: fields.playerId, userId, userIds,
    ...(fields.viewerPlayerId ? { viewerPlayerId: fields.viewerPlayerId } : {}) };
  try {
    if (mine) {
      const payload = myPlayerProfilesSchema.parse(await input.repository.listMyPlayerProfiles({ userId, userIds, cursor: fields.cursor }));
      if (payload.complete !== (payload.cursor === null)) throw new Error('Invalid profile discovery');
      return { statusCode: 200, payload };
    }
    if (input.route === '/v1/player-access') {
      const payload = playerAccessPageSchema.parse(await input.repository.listPlayerAccess({ leagueId: fields.leagueId, userId, userIds,
        cursor: fields.cursor, limit: fields.limit === undefined ? undefined : Number(fields.limit) }));
      if (payload.leagueId !== fields.leagueId || payload.complete !== (payload.cursor === null)) throw new Error('Invalid access projection');
      return { statusCode: 200, payload };
    }
    if (input.route === '/v1/player-profile') {
      const payload = playerPerformanceSchema.parse(await input.repository.getPlayerPerformance({ ...base, seasonId: fields.seasonId }));
      if (payload.league.leagueId !== fields.leagueId || (fields.seasonId !== undefined && payload.selectedSeasonId !== fields.seasonId)
        || (!flags.ownerEditing && payload.capabilities.editProfile) || (!flags.achievements && payload.capabilities.achievements)) throw new Error('Invalid profile projection');
      return { statusCode: 200, payload };
    }
    if (input.route === '/v1/player-history') return { statusCode: 200, payload: playerHistoryPageSchema.parse(await input.repository.getPlayerHistory({ ...base, seasonId: fields.seasonId, cursor: fields.cursor })) };
    const scope: AchievementScopeContext = fields.scope === 'season' ? { scope: 'season', seasonId: fields.seasonId } : { scope: 'career', seasonId: null };
    if (input.route === '/v1/player-achievements') {
      const payload = playerAchievementsSchema.parse(await input.repository.getPlayerAchievements({ ...base, scope }));
      if (payload.leagueId !== fields.leagueId || payload.scope !== scope.scope || payload.seasonId !== scope.seasonId)
        throw new Error('Invalid achievement projection');
      return { statusCode: 200, payload };
    }
    return { statusCode: 200, payload: playerUnlockPageSchema.parse(await input.repository.getPlayerUnlocks({ ...base, scope, cursor: fields.cursor })) };
  } catch (error) {
    if (error instanceof PlayerIdentityError) return response(error.status, error.category, error.message, error.code);
    if (error instanceof PlayerHistoryError) return response(error.code === 'invalid_cursor' ? 400 : error.code === 'history_changed' ? 409 : 503,
      error.code === 'invalid_cursor' ? 'bad_request' : error.code === 'history_changed' ? 'conflict' : 'unavailable',
      error.code === 'invalid_cursor' ? 'Start from the first page.' : error.code === 'history_changed' ? 'Player history changed. Refresh and try again.' : 'Player history is unavailable. Try again.', error.code);
    // Output-validation and storage failures must not echo a source payload, SDK
    // error, account identifier or transaction expression into the response.
    return response(503, 'unavailable', 'Player details could not be loaded. Try again.');
  }
}
