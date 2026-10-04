import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type QueryCommandOutput, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { PlayerIdentityPlanner, PlayerIdentityError, identityCondition, identityPut, boundedIdentityTransaction,
  validateIdentity, type IdentityClient, type IdentitySnapshot } from './player-identity.js';
import { historyBody, historyHash, historyKey, type HistoryItem } from './player-history-model.js';
import { readHistoryReadiness } from './player-history-readiness.js';
import { profileMediaWorkSchema, profileMediaWorkKey, profileWorkReferenceSchema, profileWorkPartition,
  playerPresentationSchema, type ProfileMediaWork, type ProfileWorkReference } from './player-profile-work.js';
import { profileMediaRetirementSchema, profileMediaRetirementKey } from './player-portrait-retirement.js';

type Snapshot = IdentitySnapshot<Record<string, unknown>>;
type Result = { done: boolean; delaySeconds?: number };
const unavailable = (): never => { throw new PlayerIdentityError('portrait_work_unavailable', 503, 'Portrait maintenance could not be checked.'); };
const conditional = (error: unknown) => {
  const value = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return value?.name === 'ConditionalCheckFailedException' || value?.name === 'TransactionConflictException'
    || (value?.name === 'TransactionCanceledException' && Boolean(value.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')));
};

/** Delete only objects whose durable upload has been closed to publication.
 * The worker never writes PLAYER records; visibility belongs to owner mutations. */
export class PlayerPortraitWorker {
  constructor(private readonly client: IdentityClient, private readonly tableName: string,
    private readonly store: { delete(key: string): Promise<void> }, private readonly now: () => string = () => new Date().toISOString()) {}
  private async read(pk: string, sk: string, type: string): Promise<Snapshot> {
    const item = (await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
    return { pk, sk, item, value: item ? historyBody<Record<string, unknown>>(item, pk, sk, type) : {} };
  }
  private async commit(actions: TransactWriteItem[]): Promise<void> {
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction(actions) }));
  }
  private media(snapshot: Snapshot, ref?: ProfileWorkReference): ProfileMediaWork {
    if (!snapshot.item) return unavailable();
    const work = profileMediaWorkSchema.parse(snapshot.value);
    if (snapshot.pk !== profileWorkPartition(work.playerId) || snapshot.sk !== profileMediaWorkKey(work.jobId)
      || (ref && (ref.playerHash !== historyHash(work.playerId) || ref.key !== snapshot.sk))) return unavailable();
    return work;
  }
  async process(input: ProfileWorkReference): Promise<Result> {
    const ref = profileWorkReferenceSchema.parse(input);
    try { return ref.key.startsWith('RETIRE#') ? await this.retire(ref) : await this.cleanup(ref); }
    catch (error) { if (conditional(error)) return { done: false }; throw error; }
  }
  private async authority() {
    const readiness = await readHistoryReadiness(this.client, this.tableName);
    const planner = new PlayerIdentityPlanner(this.client, this.tableName), control = await planner.readControl(); planner.requireDirectory(control);
    return [identityCondition(this.tableName, readiness), identityCondition(this.tableName, control)];
  }
  private async cleanup(ref: ProfileWorkReference): Promise<Result> {
    if (!ref.key.startsWith('MEDIA#')) return unavailable();
    const snapshot = await this.read(`PLAYER_PROFILE_WORK#${ref.playerHash}`, ref.key, 'playerProfileMediaWork'), work = this.media(snapshot, ref);
    if (work.status === 'deleted') return { done: true };
    const checks = await this.authority();
    const identity = await this.read(`PLAYER#${work.playerId}`, 'IDENTITY', 'playerIdentity');
    if (!identity.item) return unavailable();
    const player = validateIdentity(identity.value, work.playerId);
    const presentation = await this.read(identity.pk, 'PRESENTATION', 'playerPresentation');
    const display = presentation.item ? playerPresentationSchema.parse(presentation.value) : null;
    if (display && display.playerId !== work.playerId) return unavailable();
    const referenced = player.rootId === work.playerId && display?.portrait?.jobId === work.jobId;
    checks.push(identityCondition(this.tableName, identity), identityCondition(this.tableName, presentation));
    if (referenced) {
      if (work.status !== 'active' || display!.portrait!.objectKey !== work.objectKey
        || display!.portrait!.digest !== work.digest || display!.portrait!.bytes !== work.bytes) return unavailable();
      await this.commit([...checks, identityCondition(this.tableName, snapshot)]);
      return { done: true };
    }
    // Preserve the original lease even after publication/replacement: an identical
    // retry may still be completing its immutable put after another request won.
    // Waiting keeps that late put ahead of deletion, never behind it.
    if (work.status !== 'deleting') {
      const remaining = Date.parse(work.notBefore) - Date.parse(this.now());
      if (remaining > 0) return { done: false, delaySeconds: Math.min(900, Math.max(1, Math.ceil(remaining / 1000))) };
    }
    if (work.status !== 'deleting') {
      await this.commit([...checks, identityPut(this.tableName, snapshot, 'playerProfileMediaWork',
        { ...work, status: 'deleting', updatedAt: this.now() }, this.now())]);
      return { done: false };
    }
    // A previous delete or acknowledgement may have failed. Keys are immutable
    // and no finaliser accepts deleting/deleted, so repeating delete is safe.
    await this.commit([...checks, identityCondition(this.tableName, snapshot)]);
    await this.store.delete(work.objectKey);
    await this.commit([...checks, identityPut(this.tableName, snapshot, 'playerProfileMediaWork',
      { ...work, status: 'deleted', updatedAt: this.now() }, this.now())]);
    return { done: true };
  }
  private async retire(ref: ProfileWorkReference): Promise<Result> {
    const snapshot = await this.read(`PLAYER_PROFILE_WORK#${ref.playerHash}`, ref.key, 'playerProfileMediaRetirement');
    if (!snapshot.item) return unavailable();
    const work = profileMediaRetirementSchema.parse(snapshot.value);
    if (snapshot.pk !== profileWorkPartition(work.playerId) || ref.key !== profileMediaRetirementKey(work.jobId)) return unavailable();
    if (work.status === 'done') return { done: true };
    const checks = await this.authority(), member = work.members[work.memberIndex];
    if (!member) return unavailable();
    const identity = await this.read(`PLAYER#${member}`, 'IDENTITY', 'playerIdentity');
    if (!identity.item || validateIdentity(identity.value, member).rootId === member) return unavailable();
    const presentation = await this.read(identity.pk, 'PRESENTATION', 'playerPresentation');
    const display = presentation.item ? playerPresentationSchema.parse(presentation.value) : null;
    if (display && display.playerId !== member) return unavailable();
    checks.push(identityCondition(this.tableName, identity), identityCondition(this.tableName, presentation));
    if (display?.portrait) {
      const media = await this.read(profileWorkPartition(member), profileMediaWorkKey(display.portrait.jobId), 'playerProfileMediaWork');
      const value = this.media(media);
      if (value.objectKey !== display.portrait.objectKey || value.digest !== display.portrait.digest || value.bytes !== display.portrait.bytes) return unavailable();
      checks.push(value.status === 'active' ? identityPut(this.tableName, media, 'playerProfileMediaWork',
        { ...value, status: 'cleanup', updatedAt: this.now() }, this.now()) : identityCondition(this.tableName, media));
    }
    const memberIndex = work.memberIndex + 1, done = memberIndex === work.members.length;
    await this.commit([...checks, identityPut(this.tableName, snapshot, 'playerProfileMediaRetirement',
      { ...work, memberIndex, status: done ? 'done' : 'pending', updatedAt: this.now() }, this.now())]);
    return { done };
  }
  /** Bounded operator recovery, including filtered pages while writes are paused. */
  async pendingPage(playerId: string, kind: 'media' | 'retirement' = 'media', cursor: string | null = null) {
    const pk = profileWorkPartition(playerId), prefix = kind === 'media' ? 'MEDIA#' : 'RETIRE#';
    if (cursor && (!cursor.startsWith(prefix) || !profileWorkReferenceSchema.safeParse({ version: 1, kind: 'profile', playerHash: historyHash(playerId), key: cursor }).success)) return unavailable();
    const page = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: 20,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } },
      ...(cursor ? { ExclusiveStartKey: historyKey(pk, cursor) } : {}) })) as QueryCommandOutput;
    const rows = page.Items ?? []; if (rows.length > 20) return unavailable();
    const refs: ProfileWorkReference[] = []; let previous = cursor;
    for (const item of rows) {
      const sk = item.sk?.S;
      if (item.pk?.S !== pk || !sk?.startsWith(prefix) || (previous && Buffer.compare(Buffer.from(sk), Buffer.from(previous)) <= 0)) return unavailable();
      previous = sk!;
      const ref = profileWorkReferenceSchema.parse({ version: 1, kind: 'profile', playerHash: historyHash(playerId), key: sk });
      if (kind === 'media') {
        const value = this.media({ pk, sk: sk!, item, value: historyBody(item, pk, sk!, 'playerProfileMediaWork') }, ref);
        if (value.status !== 'deleted') refs.push(ref);
      } else {
        const value = profileMediaRetirementSchema.parse(historyBody(item, pk, sk!, 'playerProfileMediaRetirement'));
        if (value.playerId !== playerId || profileMediaRetirementKey(value.jobId) !== sk) return unavailable();
        if (value.status !== 'done') refs.push(ref);
      }
    }
    const last = page.LastEvaluatedKey;
    if (last && Object.keys(last).length && (last.pk?.S !== pk || !rows.length || last.sk?.S !== previous)) return unavailable();
    return { refs, cursor: last && Object.keys(last).length ? last.sk!.S! : null };
  }
}
