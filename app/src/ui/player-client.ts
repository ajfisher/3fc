import { ACHIEVEMENT_CONDITIONS, ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_RULE_VERSION, COMMON_MILESTONES, RARE_MILESTONES, milestoneOrdinal, milestoneThreshold, type AchievementId, type AchievementProgress, type AchievementRarity, type AchievementScopeContext, type AchievementUnlock, type PlayerAchievements, type PlayerUnlockPage } from '@3fc/contracts';
import type { OwnerPlayerProfile, PlayerAppearance, PlayerHistoryPage, PlayerPerformance, PlayerTotals, ProjectionFreshness } from '@3fc/contracts';

export interface PlayerContext { leagueId: string; playerId: string; viewerPlayerId?: string }
export type OwnerDetails = Omit<OwnerPlayerProfile, 'email'>;
export interface PlayerSession { authenticated: boolean; session: { sessionId: string; subject?: string; email: string } | null }
export interface PlayerAccessPage { leagueId: string; hasLeagueAcl: boolean; players: Array<{ playerId: string; displayName: string }>; cursor: string | null; complete: boolean }
export interface MyPlayerProfilesPage {
  profiles: Array<{ playerId: string; displayName: string; leagueId: string; leagueName: string }>;
  cursor: string | null;
  complete: boolean;
}
export interface PlayerMutation { expectedRevision: string; idempotencyKey: string }
export class PlayerClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'PlayerClientError'; }
}
function bad(): never { throw new PlayerClientError(503, 'invalid_response', 'Player details are temporarily unavailable. Try again.'); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return bad(); return value as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim()) return bad(); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return bad(); return value; }
function count(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return bad(); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function list<T>(value: unknown, maximum: number, parse: (entry: unknown) => T): T[] { if (!Array.isArray(value) || value.length > maximum) return bad(); return value.map(parse); }
function choice<T extends string>(value: unknown, options: readonly T[]): T { if (!options.includes(value as T)) return bad(); return value as T; }
function date(value: unknown): string { const result = text(value); if (!Number.isFinite(Date.parse(result))) return bad(); return result; }
export function parseFreshness(value: unknown): ProjectionFreshness {
  const v = record(value); return { status: choice(v.status, ['ready', 'updating', 'unavailable']), coverage: choice(v.coverage, ['complete', 'partial', 'unknown']), revision: nullableText(v.revision), computedAt: v.computedAt === null ? null : date(v.computedAt) };
}
function totals(value: unknown): PlayerTotals | null {
  if (value === null) return null;
  const v = record(value), result = { played: count(v.played), goals: count(v.goals), assists: count(v.assists), ownGoals: count(v.ownGoals), wins: count(v.wins), draws: count(v.draws), losses: count(v.losses), goalsPerGame: v.goalsPerGame };
  if (typeof result.goalsPerGame !== 'number' || !Number.isFinite(result.goalsPerGame) || result.goalsPerGame < 0 || result.wins + result.draws + result.losses !== result.played
    || result.goalsPerGame !== (result.played ? result.goals / result.played : 0)) return bad();
  return { ...result, goalsPerGame: result.goalsPerGame };
}
function appearance(value: unknown): PlayerAppearance {
  const v = record(value); return { gameId: text(v.gameId), seasonId: text(v.seasonId), kickoffAt: date(v.kickoffAt), finishedAt: date(v.finishedAt), teamId: choice(v.teamId, ['red', 'blue', 'yellow']), outcome: choice(v.outcome, ['win', 'draw', 'loss']), goals: count(v.goals), assists: count(v.assists), ownGoals: count(v.ownGoals), scored: count(v.scored), conceded: count(v.conceded) };
}
export function parsePlayerPerformance(value: unknown): PlayerPerformance {
  const v = record(value), p = record(v.player), l = record(v.league), c = record(v.capabilities);
  const seasons = list(v.seasons, 258, entry => { const s = record(entry); return { seasonId: text(s.seasonId), name: text(s.name) }; });
  const selectedSeasonId = nullableText(v.selectedSeasonId);
  if (new Set(seasons.map(s => s.seasonId)).size !== seasons.length || selectedSeasonId !== null && !seasons.some(s => s.seasonId === selectedSeasonId)) return bad();
  return { player: { playerId: text(p.playerId), displayName: text(p.displayName), hasPortrait: bool(p.hasPortrait) }, league: { leagueId: text(l.leagueId), name: text(l.name) }, seasons, selectedSeasonId,
    latest: v.latest === null ? null : appearance(v.latest), season: totals(v.season), career: totals(v.career), freshness: parseFreshness(v.freshness), capabilities: { editProfile: bool(c.editProfile), achievements: bool(c.achievements) } };
}
export function parsePlayerHistory(value: unknown): PlayerHistoryPage {
  const v = record(value), matches = v.matches === null ? null : list(v.matches, 20, appearance), cursor = nullableText(v.cursor);
  if (matches === null && cursor !== null || matches && new Set(matches.map(m => m.gameId)).size !== matches.length) return bad();
  return { matches, cursor, freshness: parseFreshness(v.freshness) };
}
export interface AchievementCatalogue { ruleVersion: typeof ACHIEVEMENT_RULE_VERSION; achievements: Array<{ id: AchievementId; name: string; rarity: AchievementRarity; rule: string }> }
const achievementDefinitions = new Map<AchievementId, typeof ACHIEVEMENT_DEFINITIONS[number]>(ACHIEVEMENT_DEFINITIONS.map(value => [value.id, value]));
function achievementId(value: unknown): AchievementId { if (!achievementDefinitions.has(value as AchievementId)) return bad(); return value as AchievementId; }
function equalKnown(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((entry, index) => equalKnown(value[index], entry));
  if (expected && typeof expected === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.entries(expected).every(([key, entry]) => equalKnown((value as Record<string, unknown>)[key], entry)));
  return value === expected;
}
export function parseAchievementCatalogue(value: unknown): AchievementCatalogue {
  const v = record(value);
  if (v.ruleVersion !== ACHIEVEMENT_RULE_VERSION) throw new PlayerClientError(503, 'catalogue_changed', 'Achievement rules have changed. Reload to get the latest collection.');
  const entries = list(v.achievements, 23, entry => { const a = record(entry), id = achievementId(a.id), def = achievementDefinitions.get(id)!;
    if (a.name !== def.name || a.rarity !== def.rarity || a.rule !== def.rule) return bad();
    // API artwork is deliberately discarded. Only the bundled authored SVG is rendered.
    return { id, name: def.name, rarity: def.rarity, rule: def.rule };
  });
  if (entries.length !== 23 || new Set(entries.map(entry => entry.id)).size !== 23 || !equalKnown(v.conditions, ACHIEVEMENT_CONDITIONS)
    || !equalKnown(v.milestones, { common: [...COMMON_MILESTONES], rare: [...RARE_MILESTONES], commonRepeatEvery: 100, rareRepeatEvery: 10, legendaryRepeatEvery: 1, epicRepeatEvery: 1 })) return bad();
  return { ruleVersion: ACHIEVEMENT_RULE_VERSION, achievements: entries };
}
function achievementScope(value: unknown): AchievementScopeContext {
  const v = record(value); if (v.scope === 'season') return { scope: 'season', seasonId: text(v.seasonId) };
  if (v.scope === 'career' && v.seasonId === null) return { scope: 'career', seasonId: null }; return bad();
}
function matchesScope(value: AchievementScopeContext, expected: AchievementScopeContext) { return value.scope === expected.scope && value.seasonId === expected.seasonId; }
function parseUnlock(value: unknown): AchievementUnlock {
  const v = record(value), id = achievementId(v.achievementId), ordinal = count(v.ordinal), threshold = count(v.threshold);
  if (!ordinal || threshold !== milestoneThreshold(achievementDefinitions.get(id)!.rarity, ordinal)) return bad();
  return { id: text(v.id), achievementId: id, ordinal, threshold, earnedAt: date(v.earnedAt), gameId: text(v.gameId), ...achievementScope(v) };
}
function sameUnlock(left: AchievementUnlock | null, right: AchievementUnlock | null): boolean {
  return left === null || right === null ? left === right : left.id === right.id && left.achievementId === right.achievementId && left.ordinal === right.ordinal && left.threshold === right.threshold && left.earnedAt === right.earnedAt && left.gameId === right.gameId && matchesScope(left, right);
}
function parseProgress(value: unknown): AchievementProgress {
  const v = record(value), id = achievementId(v.achievementId), rarity = achievementDefinitions.get(id)!.rarity;
  const result = { achievementId: id, count: count(v.count), ordinal: count(v.ordinal), nextThreshold: count(v.nextThreshold), assessability: choice(v.assessability, ['complete', 'partial']), currentRun: v.currentRun === null ? null : count(v.currentRun), highest: v.highest === null ? null : parseUnlock(v.highest) };
  if (result.ordinal !== milestoneOrdinal(rarity, result.count) || result.nextThreshold !== milestoneThreshold(rarity, result.ordinal + 1)
    || (result.highest ? result.highest.achievementId !== id || result.highest.ordinal !== result.ordinal : result.ordinal !== 0)) return bad();
  const streak = ACHIEVEMENT_CONDITIONS.streakAppearances[id as keyof typeof ACHIEVEMENT_CONDITIONS.streakAppearances];
  if (streak ? result.currentRun === null || result.currentRun >= streak : result.currentRun !== null) return bad();
  return result;
}
export function parsePlayerAchievements(value: unknown): PlayerAchievements {
  const v = record(value), scope = achievementScope(v), progress = v.progress === null ? null : list(v.progress, 23, parseProgress);
  const honours = v.honours === null ? null : list(v.honours, 23, parseUnlock), firstUnlocks = v.firstUnlocks === null ? null : list(v.firstUnlocks, 23, parseUnlock), latestUnlocks = v.latestUnlocks === null ? null : list(v.latestUnlocks, 46, parseUnlock);
  if (progress && (progress.length !== 23 || new Set(progress.map(p => p.achievementId)).size !== 23)) return bad();
  for (const entries of [honours, firstUnlocks]) if (entries && (new Set(entries.map(a => a.achievementId)).size !== entries.length || entries.some(a => !matchesScope(a, scope)))) return bad();
  if (firstUnlocks?.some(a => a.ordinal !== 1) || latestUnlocks && new Set(latestUnlocks.map(a => `${a.scope}:${a.seasonId}:${a.achievementId}`)).size !== latestUnlocks.length) return bad();
  if (progress) for (const p of progress) {
    if (p.highest && !matchesScope(p.highest, scope) || honours && !sameUnlock(p.highest, honours.find(a => a.achievementId === p.achievementId) ?? null)) return bad();
    const first = firstUnlocks?.find(a => a.achievementId === p.achievementId);
    if (first && (!p.highest || Date.parse(first.earnedAt) > Date.parse(p.highest.earnedAt))) return bad();
  }
  return { playerId: text(v.playerId), leagueId: text(v.leagueId), ...scope, progress, honours, firstUnlocks, latestUnlocks, freshness: parseFreshness(v.freshness) };
}
export function parsePlayerUnlocks(value: unknown): PlayerUnlockPage {
  const v = record(value), unlocks = v.unlocks === null ? null : list(v.unlocks, 20, parseUnlock), cursor = nullableText(v.cursor);
  if (unlocks === null && cursor !== null || unlocks && new Set(unlocks.map(a => a.id)).size !== unlocks.length) return bad();
  return { unlocks, cursor, freshness: parseFreshness(v.freshness) };
}
function scopeQuery(scope: AchievementScopeContext) { return scope.scope === 'career' ? { scope: 'career' } : { scope: 'season', seasonId: scope.seasonId }; }

function owner(value: unknown): OwnerDetails {
  const v = record(value), revision = text(v.revision); if (!/^[a-f0-9]{64}$/.test(revision)) return bad();
  return { playerId: text(v.playerId), displayName: text(v.displayName), hasPortrait: bool(v.hasPortrait), revision };
}
function access(value: unknown): PlayerAccessPage {
  const v = record(value), cursor = nullableText(v.cursor), complete = bool(v.complete);
  if (complete !== (cursor === null)) return bad();
  return { leagueId: text(v.leagueId), hasLeagueAcl: bool(v.hasLeagueAcl), players: list(v.players, 20, entry => { const p = record(entry); return { playerId: text(p.playerId), displayName: text(p.displayName) }; }), cursor, complete };
}
export function parseMyPlayerProfiles(value: unknown): MyPlayerProfilesPage {
  const v = record(value), cursor = nullableText(v.cursor), complete = bool(v.complete);
  if (complete !== (cursor === null) || cursor !== null && cursor.length > 8192) return bad();
  const profiles = list(v.profiles, 5, entry => {
    const p = record(entry);
    return { playerId: text(p.playerId), displayName: text(p.displayName), leagueId: text(p.leagueId), leagueName: text(p.leagueName) };
  });
  if (new Set(profiles.map(p => JSON.stringify([p.leagueId, p.playerId]))).size !== profiles.length) return bad();
  return { profiles, cursor, complete };
}
export function playerHref(context: PlayerContext, seasonId?: string): string {
  return `/player?${params({ ...context, seasonId })}`;
}
function params(value: object): string { const result = new URLSearchParams(); for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result.set(key, String(entry)); return result.toString(); }
export function createPlayerClient(options: { baseUrl: string; fetch?: typeof fetch }) {
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function request<T>(path: string, signal: AbortSignal | undefined, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, init.method && init.method !== 'GET' ? 35_000 : 15_000);
    try {
      const response = await requestFetch(new URL(path, options.baseUrl).href, { ...init, credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        let code = 'request_failed'; try { const error = record(await response.json()); if (typeof error.code === 'string' && /^[a-z_]{1,80}$/.test(error.code)) code = error.code; } catch { /* Never expose raw error bodies. */ }
        const message = response.status === 401 ? 'Sign in to continue.' : response.status === 403 ? 'This player is not available to your account in this league.' : response.status === 409 ? 'Player details changed. Refresh and try again.' : response.status === 404 ? 'This feature is not available yet.' : 'Player details could not be loaded or saved. Try again.';
        throw new PlayerClientError(response.status, code, message);
      }
      return await read(response);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function json(path: string, signal?: AbortSignal, init?: RequestInit): Promise<unknown> {
    return request(path, signal, init ?? {}, async response => { try { return await response.json(); } catch { return bad(); } });
  }
  function mutation<T extends PlayerMutation>(path: string, method: string, input: T, signal?: AbortSignal) {
    const { idempotencyKey, ...body } = input;
    return json(path, signal, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) }).then(owner);
  }
  return {
    async logout(signal?: AbortSignal): Promise<void> { await request('/v1/auth/logout', signal, { method: 'POST' }, async response => { if (response.status !== 204) return bad(); }); },
    async session(signal?: AbortSignal): Promise<PlayerSession> {
      const v = record(await json('/v1/auth/session', signal));
      if (v.authenticated === false) return { authenticated: false, session: null };
      if (v.authenticated !== true) return bad();
      const s = record(v.session); return { authenticated: true, session: { sessionId: text(s.sessionId), email: text(s.email), ...(s.subject !== undefined ? { subject: text(s.subject) } : {}) } };
    },
    async performance(context: PlayerContext & { seasonId?: string }, signal?: AbortSignal) {
      const result = parsePlayerPerformance(await json(`/v1/player-profile?${params(context)}`, signal));
      if (result.league.leagueId !== context.leagueId || context.seasonId !== undefined && result.selectedSeasonId !== context.seasonId) return bad(); return result;
    },
    async history(context: PlayerContext, page: { seasonId?: string; cursor?: string } = {}, signal?: AbortSignal) {
      const result = parsePlayerHistory(await json(`/v1/player-history?${params({ ...context, ...page })}`, signal));
      if (page.seasonId !== undefined && result.matches?.some(m => m.seasonId !== page.seasonId)) return bad(); return result;
    },
    async access(leagueId: string, page: { cursor?: string } = {}, signal?: AbortSignal) {
      const result = access(await json(`/v1/player-access?${params({ leagueId, ...page, limit: 20 })}`, signal)); if (result.leagueId !== leagueId) return bad(); return result;
    },
    async myProfiles(page: { cursor?: string } = {}, signal?: AbortSignal): Promise<MyPlayerProfilesPage> {
      return parseMyPlayerProfiles(await json(`/v1/my-player-profiles?${params(page)}`, signal));
    },
    async catalogue(signal?: AbortSignal): Promise<AchievementCatalogue> { return parseAchievementCatalogue(await json('/v1/achievement-catalogue', signal)); },
    // Callers resolve aliases through performance() before requesting personal honours.
    async achievements(context: PlayerContext, scope: AchievementScopeContext, signal?: AbortSignal): Promise<PlayerAchievements> {
      const result = parsePlayerAchievements(await json(`/v1/player-achievements?${params({ ...context, ...scopeQuery(scope) })}`, signal));
      if (result.playerId !== context.playerId || result.leagueId !== context.leagueId || !matchesScope(result, scope)) return bad(); return result;
    },
    async unlocks(context: PlayerContext, scope: AchievementScopeContext, page: { cursor?: string } = {}, signal?: AbortSignal): Promise<PlayerUnlockPage> {
      const result = parsePlayerUnlocks(await json(`/v1/player-unlocks?${params({ ...context, ...scopeQuery(scope), ...page })}`, signal));
      if (result.unlocks?.some(a => !matchesScope(a, scope))) return bad(); return result;
    },
    async owner(playerId: string, signal?: AbortSignal): Promise<OwnerPlayerProfile> {
      const v = record(await json(`/v1/owner-player-profile?${params({ playerId })}`, signal)); return { ...owner(v), email: text(v.email) };
    },
    rename(playerId: string, input: PlayerMutation & { displayName: string }, signal?: AbortSignal) { return mutation(`/v1/owner-player-profile?${params({ playerId })}`, 'PATCH', input, signal); },
    uploadPortrait(playerId: string, input: PlayerMutation & { base64: string; contentType: 'image/png' }, signal?: AbortSignal) { return mutation(`/v1/owner-player-portrait?${params({ playerId })}`, 'PUT', input, signal); },
    removePortrait(playerId: string, input: PlayerMutation, signal?: AbortSignal) { return mutation(`/v1/owner-player-portrait?${params({ playerId })}`, 'DELETE', { ...input }, signal); },
    async portrait(context: PlayerContext, signal?: AbortSignal): Promise<Blob | null> {
      try { return await request(`/v1/player-portrait?${params(context)}`, signal, {}, async response => {
        const blob = await response.blob(); if (blob.type.split(';')[0] !== 'image/png' || blob.size < 8 || blob.size > 2 * 1024 * 1024) return bad(); return blob;
      }); } catch (error) { if (error instanceof PlayerClientError && error.status === 404 && error.code === 'request_failed') return null; throw error; }
    }
  };
}
export type PlayerClient = ReturnType<typeof createPlayerClient>;

/** Shared account controls on player pages do not expose account identifiers. */
export function bindPlayerAccount(document: Document, client: Pick<PlayerClient, 'logout'>, invalidate: () => void) {
  const window = document.defaultView!, button = document.getElementById('sign-out') as HTMLButtonElement | null;
  const actions = document.getElementById('account-actions'), status = document.getElementById('sign-out-status');
  let pending = false, uncertain = false, disposed = false;
  const handler = async () => {
    if (!button || button.disabled || pending) return;
    pending = true; uncertain = false; button.disabled = true; invalidate();
    const proof = (window as unknown as { ThreeFcPlayerProof?: { clear(): boolean } }).ThreeFcPlayerProof;
    if (proof?.clear() === false) { pending = false; uncertain = true; button.disabled = false; if (status) { status.hidden = false; status.textContent = 'Saved account data could not be cleared. Retry sign out.'; } return; }
    if (!proof) window.dispatchEvent(new window.Event('threefc:player-proof-cleared'));
    if (status) { status.hidden = false; status.textContent = 'Signing out…'; }
    try {
      await client.logout(); if (disposed) return;
      try { window.localStorage.removeItem('threefc.auth.return_to'); window.sessionStorage.removeItem('threefc.auth.callback'); } catch { /* Optional browser storage. */ }
      if (status) status.textContent = 'Signed out.';
      button.hidden = true;
    } catch {
      if (disposed) return;
      uncertain = true; button.disabled = false; button.textContent = 'Retry sign out';
      if (status) status.textContent = 'Sign out could not be confirmed. Retry to finish signing out.';
    } finally { pending = false; }
  };
  button?.addEventListener('click', handler);
  return { setAuthenticated(value: boolean) { if (disposed || pending || uncertain) return; if (actions) actions.hidden = !value; if (button) { button.disabled = !value; if (value) button.hidden = false; } },
    destroy() { disposed = true; button?.removeEventListener('click', handler); } };
}
