import { randomUUID } from 'node:crypto';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type QueryCommandOutput, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { IdentityReadCache } from './identity-read-cache.js';
import { PlayerIdentityPlanner, PlayerIdentityError, identityCondition, identityPut, identityDirectorySk,
  identityLeagueSk, identityTombstoneSk, boundedIdentityTransaction, validateIdentity, type IdentityClient, type IdentitySnapshot } from './player-identity.js';
import { historyBody, historyHash, historyKey, type HistoryItem } from './player-history-model.js';
import { readHistoryReadiness } from './player-history-readiness.js';
import { sendHistoryTransaction } from './player-history-work.js';
import { profileNameWorkSchema, profileWorkReferenceSchema, profileWorkPartition, profileNameWorkKey,
  playerPresentationSchema, PLAYER_PRESENTATION_SK, type ProfileNameWork, type ProfileWorkReference } from './player-profile-work.js';

type Snapshot = IdentitySnapshot<Record<string, unknown>>;
const text = z.string().min(1).refine(value => Boolean(value.trim()));
const directorySchema = z.object({ playerId: text, nickname: text, formerNames: z.array(text).max(20), active: z.boolean() });
const unavailable = (): never => { throw new PlayerIdentityError('profile_work_unavailable', 503, 'Player directory updates could not be checked.'); };
const conditional = (error: unknown): boolean => {
  const value = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return value?.name === 'ConditionalCheckFailedException' || (value?.name === 'TransactionCanceledException'
    && Boolean(value.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')));
};

/** Propagate a canonical name without changing historical player IDs. Each step
 * owns at most ten reverse memberships and one atomic directory/checkpoint write. */
export class ProfileNameWorker {
  constructor(private readonly client: IdentityClient, private readonly tableName: string,
    private readonly now: () => string = () => new Date().toISOString()) {}
  private async read(client: IdentityClient, pk: string, sk: string, type: string): Promise<Snapshot> {
    const item = (await client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
    const value = item ? historyBody<Record<string, unknown>>(item, pk, sk, type) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
    return { pk, sk, item, value };
  }
  private async page(pk: string, prefix: string, after: string | null, limit: number) {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } },
      ...(after ? { ExclusiveStartKey: historyKey(pk, after) } : {}) })) as QueryCommandOutput;
    const rows = result.Items ?? []; if (rows.length > limit) return unavailable();
    let previous = after;
    for (const row of rows) {
      const sk = row.sk?.S;
      if (row.pk?.S !== pk || !sk?.startsWith(prefix) || (previous && Buffer.compare(Buffer.from(sk), Buffer.from(previous)) <= 0)) return unavailable();
      previous = sk!;
    }
    const last = result.LastEvaluatedKey;
    if (!last || !Object.keys(last).length) return { rows, cursor: null };
    const cursor = last.sk?.S;
    if (last.pk?.S !== pk || !cursor?.startsWith(prefix) || (after && Buffer.compare(Buffer.from(cursor), Buffer.from(after)) <= 0)
      || !rows.length || cursor !== previous) return unavailable();
    return { rows, cursor: cursor! };
  }
  private work(snapshot: Snapshot, ref: ProfileWorkReference): ProfileNameWork {
    if (!snapshot.item) return unavailable();
    const work = profileNameWorkSchema.parse(snapshot.value);
    if (profileWorkPartition(work.playerId) !== snapshot.pk || historyHash(work.playerId) !== ref.playerHash
      || profileNameWorkKey(work.nameRevision) !== ref.key || work.jobId !== work.nameRevision) return unavailable();
    return work;
  }
  private async commit(snapshot: Snapshot, work: ProfileNameWork, checks: TransactWriteItem[]): Promise<void> {
    await sendHistoryTransaction(this.client, new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      ...checks, identityPut(this.tableName, snapshot, 'playerProfileNameWork', { ...work, updatedAt: this.now() }, this.now()),
    ]) }));
  }
  async process(input: ProfileWorkReference): Promise<{ done: boolean }> {
    const ref = profileWorkReferenceSchema.parse(input);
    try { return await this.step(ref); }
    catch (error) { if (conditional(error)) return { done: false }; throw error; }
  }
  private async step(ref: ProfileWorkReference): Promise<{ done: boolean }> {
    const snapshot = await this.read(this.client, `PLAYER_PROFILE_WORK#${ref.playerHash}`, ref.key, 'playerProfileNameWork');
    const work = this.work(snapshot, ref); if (work.status === 'done') return { done: true };
    const readiness = await readHistoryReadiness(this.client, this.tableName);
    const cache = new IdentityReadCache(this.client, this.tableName, { deadlineMs: Date.now() + 8000 });
    await cache.prefetch([{ pk: 'PLAYER_IDENTITY', sk: 'CONTROL' }, { pk: `PLAYER#${work.playerId}`, sk: 'IDENTITY' }]);
    const planner = new PlayerIdentityPlanner(cache, this.tableName), control = await planner.readControl(); planner.requireDirectory(control);
    const original = await this.read(cache, `PLAYER#${work.playerId}`, 'IDENTITY', 'playerIdentity');
    if (!original.item) return unavailable();
    const originalIdentity = validateIdentity(original.value, work.playerId), rootId = originalIdentity.rootId;
    await cache.prefetch([{ pk: `PLAYER#${rootId}`, sk: 'IDENTITY' }]);
    const root = await this.read(cache, `PLAYER#${rootId}`, 'IDENTITY', 'playerIdentity');
    if (!root.item) return unavailable();
    const identityHint = validateIdentity(root.value, rootId);
    await cache.prefetch([...identityHint.members.map(id => ({ pk: `PLAYER#${id}`, sk: 'IDENTITY' })),
      { pk: `PLAYER#${rootId}`, sk: PLAYER_PRESENTATION_SK }]);
    const resolved = await planner.resolve(work.playerId), presentation = await this.read(cache, `PLAYER#${rootId}`, PLAYER_PRESENTATION_SK, 'playerPresentation');
    const checks = [identityCondition(this.tableName, readiness), identityCondition(this.tableName, control),
      identityCondition(this.tableName, resolved.original), identityCondition(this.tableName, resolved.root), identityCondition(this.tableName, presentation)];
    const state = presentation.item ? playerPresentationSchema.parse(presentation.value) : null;
    if (state && state.playerId !== rootId) return unavailable();
    if (rootId !== work.playerId || state?.nameRevision !== work.nameRevision || resolved.root.value.displayName !== work.displayName) {
      await this.commit(snapshot, { ...work, status: 'done', completionReason: 'superseded' }, checks); return { done: true };
    }
    // A consolidation may expand/reorder the closure between pages. Ordinary
    // scoring only changes writeVersion; it does not reset this traversal.
    if (JSON.stringify(work.members) !== JSON.stringify(resolved.root.value.members)) {
      await this.commit(snapshot, { ...work, members: [...resolved.root.value.members], memberIndex: 0, cursor: null }, checks);
      return { done: false };
    }
    if (work.memberIndex >= work.members.length) {
      await this.commit(snapshot, { ...work, status: 'done', completionReason: 'completed' }, checks); return { done: true };
    }
    const member = work.members[work.memberIndex], pk = `PLAYER#${member}`;
    const page = await this.page(pk, 'LEAGUE#', work.cursor, 10);
    const memberships = page.rows.map(item => {
      const value = z.object({ playerId: z.literal(member), leagueId: text }).parse(historyBody(item, pk, item.sk!.S!, 'playerLeagueMembership'));
      if (item.sk?.S !== identityLeagueSk(value.leagueId)) return unavailable();
      return { pk, sk: item.sk.S, item, value };
    });
    const leagues = [...new Set(memberships.map(row => row.value.leagueId))];
    await cache.prefetch(leagues.flatMap(leagueId => [{ pk: `LEAGUE#${leagueId}`, sk: 'METADATA' },
      { pk: `LEAGUE#${leagueId}`, sk: 'PLAYER_DIRECTORY' }, { pk: `LEAGUE#${leagueId}`, sk: identityDirectorySk(rootId) },
      { pk: 'PLAYER_IDENTITY_TOMBSTONE', sk: identityTombstoneSk('league', [leagueId]) },
      { pk: `PLAYER#${rootId}`, sk: identityLeagueSk(leagueId) }]));
    const writes: TransactWriteItem[] = memberships.map(row => identityCondition(this.tableName, row));
    for (const leagueId of leagues) {
      const leaguePk = `LEAGUE#${leagueId}`;
      const tombstone = await this.read(cache, 'PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk('league', [leagueId]), 'playerIdentityTombstone');
      writes.push(identityCondition(this.tableName, tombstone));
      if (tombstone.item) {
        z.object({ kind: z.literal('league'), ids: z.tuple([z.literal(leagueId)]) }).parse(tombstone.value); continue;
      }
      const league = await this.read(cache, leaguePk, 'METADATA', 'league');
      if (!league.item || league.value.leagueId !== leagueId) return unavailable();
      const membership = await this.read(cache, `PLAYER#${rootId}`, identityLeagueSk(leagueId), 'playerLeagueMembership');
      if (!membership.item || membership.value.playerId !== rootId || membership.value.leagueId !== leagueId) return unavailable();
      const directory = await this.read(cache, leaguePk, identityDirectorySk(rootId), 'leaguePlayer');
      if (!directory.item) return unavailable();
      const entry = directorySchema.parse(directory.value); if (entry.playerId !== rootId) return unavailable();
      const revision = await this.read(cache, leaguePk, 'PLAYER_DIRECTORY', 'playerDirectoryRevision');
      if (!revision.item || !text.safeParse(revision.value.revision).success) return unavailable();
      writes.push(identityCondition(this.tableName, league), identityCondition(this.tableName, membership));
      if (!entry.active || (entry.nickname === work.displayName && JSON.stringify(entry.formerNames) === JSON.stringify(resolved.root.value.formerNames))) {
        writes.push(identityCondition(this.tableName, directory), identityCondition(this.tableName, revision)); continue;
      }
      writes.push(identityPut(this.tableName, directory, 'leaguePlayer', { ...directory.value, nickname: work.displayName,
        formerNames: [...resolved.root.value.formerNames] }, this.now()),
      identityPut(this.tableName, revision, 'playerDirectoryRevision', { revision: randomUUID() }, this.now()));
    }
    const memberIndex = page.cursor === null ? work.memberIndex + 1 : work.memberIndex;
    const done = memberIndex === work.members.length;
    await this.commit(snapshot, { ...work, memberIndex, cursor: page.cursor, status: done ? 'done' : 'pending',
      ...(done ? { completionReason: 'completed' as const } : {}) }, [...checks, ...writes]);
    return { done };
  }
  /** Operator recovery remains available when processing is paused. A filtered
   * page can be empty and still carry a continuation; never infer completion. */
  async pendingPage(playerId: string, cursor: string | null = null): Promise<{ refs: ProfileWorkReference[]; cursor: string | null }> {
    const pk = profileWorkPartition(playerId);
    if (cursor !== null && !/^NAME#[0-9a-f-]{36}$/i.test(cursor)) return unavailable();
    const page = await this.page(pk, 'NAME#', cursor, 20), refs: ProfileWorkReference[] = [];
    for (const item of page.rows) {
      const ref = profileWorkReferenceSchema.parse({ version: 1, kind: 'profile', playerHash: historyHash(playerId), key: item.sk!.S! });
      const work = this.work({ pk, sk: ref.key, item, value: historyBody(item, pk, ref.key, 'playerProfileNameWork') }, ref);
      if (work.playerId !== playerId) return unavailable();
      if (work.status === 'pending') refs.push(ref);
    }
    return { refs, cursor: page.cursor };
  }
}
