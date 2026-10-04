import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type QueryCommandOutput, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { aclSk, playerClaimSk } from './keys.js';
import { PLAYER_PRESENTATION_SK, playerPresentationSchema } from './player-profile-work.js';
import { IdentityReadCache } from './identity-read-cache.js';
import { readPlayerClaimsRevision } from './player-claims-revision.js';
import { PlayerIdentityPlanner, PlayerIdentityError, identityCondition, identityDirectorySk, identityLeagueSk,
  identityTombstoneSk, validPlayerIdentityId, boundedIdentityTransaction, type IdentityClient, type IdentitySnapshot } from './player-identity.js';
import { historyBody, historyHash, historyKey, type HistoryItem } from './player-history-model.js';

type Data = Record<string, unknown>;
type Snapshot = IdentitySnapshot<Data>;
export interface ProfileAccessInput { leagueId: string; playerId: string; userId: string; userIds?: readonly string[]; viewerPlayerId?: string }
export interface ProfileAccessSnapshot {
  player: { playerId: string; displayName: string; hasPortrait: boolean };
  league: { leagueId: string; name: string }; owner: boolean;
  /** Server-built conditions, never serialize this field into an API response. */
  checks: TransactWriteItem[];
}
export interface PlayerAccessPage {
  leagueId: string; hasLeagueAcl: boolean; players: Array<{ playerId: string; displayName: string }>;
  cursor: string | null; complete: boolean;
}
const text = z.string().min(1).refine(value => value.trim().length > 0);
const unavailable = (): never => { throw new PlayerIdentityError('player_profile_unavailable', 503, 'Player details could not be checked. Try again.'); };
const denied = (): never => { throw new PlayerIdentityError('player_profile_forbidden', 403, 'You cannot access this player in this league.'); };
const changed = (): never => { throw new PlayerIdentityError('player_profile_changed', 409, 'Player access changed. Refresh and try again.'); };
const badCursor = (): never => { throw new PlayerIdentityError('invalid_player_cursor', 400, 'Start a new player search.'); };
const validId = (value: unknown, prefix: string, maximum = 2048): value is string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(prefix + value) > maximum) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
};
const profileSchema = z.object({ playerId: text, nickname: text, claimedByUserId: text.nullable() });
const directorySchema = z.object({ playerId: text, active: z.boolean(), nickname: text });

/** Read-only league visibility. Current canonical ownership is distinct from ACL
 * authority, and query player IDs are lookup hints only. No request-wide scans. */
export class PlayerProfileAccess {
  constructor(private readonly client: IdentityClient, private readonly tableName: string) {}
  private accounts(input: { userId: string; userIds?: readonly string[] }): string[] {
    const accounts = [...new Set([input.userId, ...(input.userIds ?? [])])];
    if (accounts.length > 2 || !accounts.every(id => validId(id, 'USER#'))) return denied();
    return accounts;
  }
  private async read(cache: IdentityReadCache, pk: string, sk: string, type: string): Promise<Snapshot> {
    const item = (await cache.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
    const value = item ? historyBody<Data>(item, pk, sk, type) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
    return { pk, sk, item, value };
  }
  private async scope(leagueId: string, accounts: string[], claims: boolean) {
    if (!validId(leagueId, 'LEAGUE#')) return denied();
    const deadline = Date.now() + 8000;
    const cache = new IdentityReadCache(this.client, this.tableName, { deadlineMs: deadline,
      deadlineError: new PlayerIdentityError('player_profile_unavailable', 503, 'Player details took too long to load. Try again.') });
    const pk = `LEAGUE#${leagueId}`, tombstoneSk = identityTombstoneSk('league', [leagueId]);
    // An overlong ACL sort key cannot exist; it cannot provide an alternate grant.
    const aclAccounts = accounts.filter(id => validId(id, 'ACL#USER#', 1024));
    await cache.prefetch([{ pk, sk: 'METADATA' }, { pk, sk: 'PLAYER_DIRECTORY' },
      { pk: 'PLAYER_IDENTITY', sk: 'CONTROL' }, { pk: 'PLAYER_IDENTITY_TOMBSTONE', sk: tombstoneSk },
      ...aclAccounts.map(id => ({ pk, sk: aclSk(id) })),
      ...(claims ? accounts.map(id => ({ pk: `USER#${id}`, sk: 'PLAYER_CLAIMS_REVISION' })) : [])]);
    const planner = new PlayerIdentityPlanner(cache, this.tableName), control = await planner.readControl(); planner.requireDirectory(control);
    const league = await this.read(cache, pk, 'METADATA', 'league');
    if (!league.item || league.value.leagueId !== leagueId || !text.safeParse(league.value.name).success) return denied();
    const tombstone = await this.read(cache, 'PLAYER_IDENTITY_TOMBSTONE', tombstoneSk, 'playerIdentityTombstone');
    if (tombstone.item) return denied();
    const directory = await this.read(cache, pk, 'PLAYER_DIRECTORY', 'playerDirectoryRevision');
    if (directory.item) z.object({ revision: text }).strict().parse(directory.value);
    const checks = [identityCondition(this.tableName, league), identityCondition(this.tableName, tombstone),
      identityCondition(this.tableName, control), identityCondition(this.tableName, directory)];
    let hasLeagueAcl = false;
    for (const id of aclAccounts) {
      const acl = await this.read(cache, pk, aclSk(id), 'acl');
      checks.push(identityCondition(this.tableName, acl));
      if (!acl.item) continue;
      const value = z.object({ leagueId: z.literal(leagueId), userId: z.literal(id), role: z.enum(['admin', 'scorekeeper', 'viewer']) }).parse(acl.value);
      hasLeagueAcl ||= Boolean(value.role);
    }
    const revisions = claims ? await Promise.all(accounts.map(id => readPlayerClaimsRevision(cache, this.tableName, id))) : [];
    checks.push(...revisions.map(revision => identityCondition(this.tableName, revision)));
    return { cache, planner, deadline, league, directory, control, checks, hasLeagueAcl, revisions };
  }
  private async players(scope: Awaited<ReturnType<PlayerProfileAccess['scope']>>, leagueId: string, ids: readonly string[]) {
    if (ids.length > 20 || !ids.every(validPlayerIdentityId)) return unavailable();
    const originals = [...new Set(ids)];
    await scope.cache.prefetch(originals.map(id => ({ pk: `PLAYER#${id}`, sk: 'IDENTITY' })));
    const roots = new Set<string>();
    for (const id of originals) {
      const hint = await this.read(scope.cache, `PLAYER#${id}`, 'IDENTITY', 'playerIdentity');
      if (!hint.item || !validPlayerIdentityId(hint.value.rootId)) return unavailable();
      roots.add(hint.value.rootId);
    }
    await scope.cache.prefetch([...roots].map(id => ({ pk: `PLAYER#${id}`, sk: 'IDENTITY' })));
    const keys: Array<{ pk: string; sk: string }> = [];
    for (const root of roots) {
      const hint = await this.read(scope.cache, `PLAYER#${root}`, 'IDENTITY', 'playerIdentity');
      const members = hint.value.members;
      if (!Array.isArray(members) || members.length < 1 || members.length > 20 || !members.every(validPlayerIdentityId)) return unavailable();
      keys.push(...members.map(id => ({ pk: `PLAYER#${id}`, sk: 'IDENTITY' })),
        { pk: `PLAYER#${root}`, sk: 'PROFILE' }, { pk: `PLAYER#${root}`, sk: identityLeagueSk(leagueId) },
        { pk: `LEAGUE#${leagueId}`, sk: identityDirectorySk(root) });
    }
    await scope.cache.prefetch(keys);
    const result = new Map<string, { playerId: string; members: string[]; displayName: string; ownerId: string | null; inLeague: boolean; checks: TransactWriteItem[] }>();
    for (const id of originals) {
      const identity = await scope.planner.resolve(id), root = identity.root.value.playerId;
      const profile = await this.read(scope.cache, `PLAYER#${root}`, 'PROFILE', 'player');
      if (!profile.item) return unavailable();
      const value = profileSchema.parse(profile.value); if (value.playerId !== root) return unavailable();
      const directory = await this.read(scope.cache, `LEAGUE#${leagueId}`, identityDirectorySk(root), 'leaguePlayer');
      const membership = await this.read(scope.cache, `PLAYER#${root}`, identityLeagueSk(leagueId), 'playerLeagueMembership');
      let active = false;
      if (directory.item) { const entry = directorySchema.parse(directory.value); if (entry.playerId !== root) return unavailable(); active = entry.active; }
      if (membership.item && (membership.value.playerId !== root || membership.value.leagueId !== leagueId)) return unavailable();
      if (active && !membership.item) return unavailable();
      // Root closure changes are atomic with the root identity revision. Fencing
      // that root covers all bounded alias lookups without 400 transaction checks.
      result.set(id, { playerId: root, members: identity.root.value.members, displayName: identity.root.value.displayName, ownerId: value.claimedByUserId,
        inLeague: active && Boolean(membership.item), checks: [identityCondition(this.tableName, identity.root),
          identityCondition(this.tableName, profile), identityCondition(this.tableName, directory), identityCondition(this.tableName, membership)] });
    }
    return result;
  }
  async authorize(input: ProfileAccessInput): Promise<ProfileAccessSnapshot> {
    const accounts = this.accounts(input), scope = await this.scope(input.leagueId, accounts, false);
    const players = await this.players(scope, input.leagueId, [input.playerId]), target = players.get(input.playerId)!;
    if (!target.inLeague) return denied();
    const owner = target.ownerId !== null && accounts.includes(target.ownerId);
    const viewer = !scope.hasLeagueAcl && !owner && input.viewerPlayerId
      ? (await this.players(scope, input.leagueId, [input.viewerPlayerId])).get(input.viewerPlayerId) : undefined;
    if (!scope.hasLeagueAcl && !owner && !(viewer?.inLeague && viewer.ownerId !== null && accounts.includes(viewer.ownerId))) return denied();
    // Portrait presence belongs only to the selected target. Discovery may
    // already fence twenty roots; adding media checks there could exceed100.
    await scope.cache.prefetch([{ pk: `PLAYER#${target.playerId}`, sk: PLAYER_PRESENTATION_SK }]);
    const presentation = await this.read(scope.cache, `PLAYER#${target.playerId}`, PLAYER_PRESENTATION_SK, 'playerPresentation');
    const media = presentation.item ? playerPresentationSchema.parse(presentation.value) : null;
    if (media && media.playerId !== target.playerId) return unavailable();
    const checks = [...scope.checks, ...target.checks, ...(viewer ? viewer.checks : []), identityCondition(this.tableName, presentation)];
    this.deadline(scope.deadline);
    await this.assertCurrent(checks);
    return { player: { playerId: target.playerId, displayName: target.displayName, hasPortrait: Boolean(media?.portrait) },
      league: { leagueId: input.leagueId, name: scope.league.value.name as string }, owner, checks };
  }
  private deadline(deadline: number): void { if (Date.now() >= deadline) unavailable(); }
  private async representatives(scope: Awaited<ReturnType<PlayerProfileAccess['scope']>>, accounts: string[],
    players: Awaited<ReturnType<PlayerProfileAccess['players']>>) {
    const roots = new Map([...players.values()].filter(player => player.inLeague && player.ownerId !== null && accounts.includes(player.ownerId))
      .map(player => [player.playerId, player]));
    const selected = new Map<string, { account: string; playerId: string }>();
    const candidates = (ids: readonly string[]) => ids.flatMap(playerId => accounts.map(account => ({ account, playerId })));
    const read = async (root: string, values: Array<{ account: string; playerId: string }>) => {
      for (const candidate of values) {
        const claim = await this.read(scope.cache, `USER#${candidate.account}`, playerClaimSk(candidate.playerId), 'playerClaim');
        if (!claim.item) continue;
        if (claim.value.userId !== candidate.account || claim.value.playerId !== candidate.playerId) return unavailable();
        if (!selected.has(root)) selected.set(root, candidate);
      }
    };
    // Prefer a root claim, even when its namespace/account is visited later.
    // Only groups without one need the bounded (20 members x two accounts)
    // legacy alias search. Inspect every fetched record before returning a page.
    await scope.cache.prefetch([...roots.keys()].flatMap(id => candidates([id]))
      .map(value => ({ pk: `USER#${value.account}`, sk: playerClaimSk(value.playerId) })));
    for (const root of roots.keys()) await read(root, candidates([root]));
    const aliases = [...roots.values()].filter(player => !selected.has(player.playerId)).map(player => ({ root: player.playerId,
      values: candidates(player.members.filter(id => id !== player.playerId).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) }));
    await scope.cache.prefetch(aliases.flatMap(group => group.values)
      .map(value => ({ pk: `USER#${value.account}`, sk: playerClaimSk(value.playerId) })));
    for (const group of aliases) await read(group.root, group.values);
    // Claims revisions fence both presence and absence across all inspected
    // account rows; root checks fence the bounded alias closure. No seen-ID
    // list or additional per-candidate transaction actions are necessary.
    return selected;
  }
  async discover(input: { leagueId: string; userId: string; userIds?: readonly string[]; cursor?: string; limit?: number }): Promise<PlayerAccessPage> {
    const accounts = this.accounts(input), scope = await this.scope(input.leagueId, accounts, true), limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return badCursor();
    const binding = historyHash(input.leagueId, JSON.stringify(accounts), scope.control.value.epoch,
      scope.directory.item?.data?.S ?? '', JSON.stringify(scope.revisions.map(row => row.value.revision)));
    let accountIndex = 0, namespace = 'PLAYER#', last: string | null = null;
    if (input.cursor !== undefined) {
      try {
        if (!input.cursor || input.cursor.length > 8000 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) return badCursor();
        const parsed = z.object({ version: z.literal(1), binding: z.literal(binding), accountIndex: z.number().int().min(0).max(accounts.length - 1),
          namespace: z.enum(['PLAYER#', 'PLAYER_HASH#']), last: z.string().min(1).nullable() }).strict()
          .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
        if (parsed.last !== null && (!parsed.last.startsWith(parsed.namespace) || Buffer.byteLength(parsed.last) > 1024)) return badCursor();
        ({ accountIndex, namespace, last } = parsed);
      } catch { return badCursor(); }
    }
    const pk = `USER#${accounts[accountIndex]}`; this.deadline(scope.deadline);
    const page = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: namespace } },
      ...(last ? { ExclusiveStartKey: historyKey(pk, last) } : {}) })) as QueryCommandOutput;
    this.deadline(scope.deadline);
    const rows = page.Items ?? []; if (rows.length > limit) return unavailable();
    const claims = rows.map(row => {
      const claim = historyBody<Data>(row, pk, row.sk?.S ?? '', 'playerClaim');
      if (claim.userId !== accounts[accountIndex] || !validPlayerIdentityId(claim.playerId)
        || row.sk?.S !== playerClaimSk(claim.playerId) || !row.sk.S.startsWith(namespace)) return unavailable();
      return claim.playerId;
    });
    const resolved = await this.players(scope, input.leagueId, claims), players: PlayerAccessPage['players'] = [], seen = new Set<string>();
    const representatives = await this.representatives(scope, accounts, resolved);
    const checks = [...scope.checks];
    for (const [claimedId, player] of resolved) {
      // Fence excluded stale claims too: account/league eligibility must not
      // change while this bounded discovery page is being assembled.
      checks.push(...player.checks);
      if (!player.inLeague || player.ownerId === null || !accounts.includes(player.ownerId) || seen.has(player.playerId)) continue;
      const representative = representatives.get(player.playerId);
      if (!representative || representative.account !== accounts[accountIndex] || representative.playerId !== claimedId) continue;
      seen.add(player.playerId); players.push({ playerId: player.playerId, displayName: player.displayName });
    }
    const continuation = page.LastEvaluatedKey;
    const hasMore = continuation && Object.keys(continuation).length > 0;
    if (hasMore && (continuation.pk?.S !== pk || !continuation.sk?.S?.startsWith(namespace) || Buffer.byteLength(continuation.sk.S) > 1024
      || (last !== null && Buffer.compare(Buffer.from(continuation.sk.S), Buffer.from(last)) <= 0))) return unavailable();
    const next = hasMore ? { accountIndex, namespace, last: continuation.sk!.S! }
      : namespace === 'PLAYER#' ? { accountIndex, namespace: 'PLAYER_HASH#', last: null }
      : accountIndex + 1 < accounts.length ? { accountIndex: accountIndex + 1, namespace: 'PLAYER#', last: null } : null;
    this.deadline(scope.deadline); await this.assertCurrent(checks);
    return { leagueId: input.leagueId, hasLeagueAcl: scope.hasLeagueAcl, players,
      cursor: next ? Buffer.from(JSON.stringify({ version: 1, binding, ...next })).toString('base64url') : null, complete: next === null };
  }
  async assertCurrent(accessChecks: readonly TransactWriteItem[], projectionChecks: readonly TransactWriteItem[] = []): Promise<void> {
    const actions = [...accessChecks, ...projectionChecks], deduplicated = new Map<string, TransactWriteItem>();
    if (!actions.length || actions.length > 200) return unavailable();
    for (const action of actions) {
      if (!action.ConditionCheck || action.Put || action.Update || action.Delete || action.ConditionCheck.TableName !== this.tableName) return unavailable();
      const key = action.ConditionCheck.Key;
      if (!key?.pk?.S || !key.sk?.S || Object.keys(key).some(field => !['pk', 'sk'].includes(field))) return unavailable();
      const id = JSON.stringify([key.pk.S, key.sk.S]), previous = deduplicated.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(action)) return changed();
      deduplicated.set(id, action);
    }
    try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([...deduplicated.values()]) })); }
    catch (error) {
      const e = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (e.name === 'ConditionalCheckFailedException' || (e.name === 'TransactionCanceledException'
        && e.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')
        && e.CancellationReasons.every(reason => !reason.Code || ['None', 'ConditionalCheckFailed'].includes(reason.Code)))) return changed();
      throw error;
    }
  }
}
