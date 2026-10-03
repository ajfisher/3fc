import { randomUUID } from 'node:crypto';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type QueryCommandOutput, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { ACHIEVEMENT_RULE_VERSION } from '@3fc/contracts';
import { publicUnlock, type AchievementAccumulator } from '../achievements/evaluate.js';
import { historyQueueReferenceSchema, type HistoryQueueReference } from '../history-transport.js';
import { PlayerIdentityPlanner, PlayerIdentityError, identityCondition, identityDirectorySk, identityTombstoneSk, type IdentitySnapshot } from './player-identity.js';
import { HistorySource } from './player-history-source.js';
import { ResumableHistoryCollector } from './player-history-collector.js';
import { PlayerHistoryStore } from './player-history-store.js';
import { historyBody, historyHash, historyKey, historyRow, historyPartition, PlayerHistoryError,
  type HistoryClient, type HistoryContext, type HistoryGeneration, type HistoryItem, type HistoryPublication } from './player-history-model.js';
import { readHistoryReadiness } from './player-history-readiness.js';
import { historyMutationItems, historyWorkSchema, sendHistoryTransaction } from './player-history-work.js';

const text = z.string().min(1).refine(value => value.trim().length > 0);
const jobSchema = z.object({ version: z.literal(1), leagueId: text, playerId: text, status: z.enum(['pending', 'done', 'failed']),
  requestedRevision: text, spec: z.unknown().nullable(), updatedAt: z.string().datetime({ offset: true }), errorCode: text.optional() }).strict();
interface Job extends Omit<z.infer<typeof jobSchema>, 'spec'> { spec: HistoryGeneration | null }
interface Sweep { version: 1; id: string; leagueId: string; revision: string; readinessRevision: string;
  directoryData: string | null; phase: 'fanout' | 'verify' | 'complete'; cursor: string | null;
  enqueued: number; checked: number; startedAt: string; completedAt: string | null }
const sweepSchema = z.object({ version: z.literal(1), id: z.string().uuid(), leagueId: text, revision: text,
  readinessRevision: text, directoryData: z.string().nullable(), phase: z.enum(['fanout', 'verify', 'complete']),
  cursor: text.nullable(), enqueued: z.number().int().nonnegative(), checked: z.number().int().nonnegative(),
  startedAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }).nullable() }).strict();
const ackSchema = z.discriminatedUnion('disposition', [
  z.object({ version: z.literal(1), leagueId: text, revision: z.string().uuid(), disposition: z.literal('league-deleted'), completedAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ version: z.literal(1), leagueId: text, revision: z.string().uuid(), disposition: z.literal('reconciled'), satisfiedBy: text, sweepId: z.string().uuid(), completedAt: z.string().datetime({ offset: true }) }).strict()
]);
const directorySchema = z.object({ playerId: text, active: z.boolean() });
const directoryReceiptSchema = (leagueId: string) => z.object({ version: z.literal(1), leagueId: z.literal(leagueId), directoryData: text,
  readinessRevision: text, workKey: z.string().regex(/^HISTORY_WORK#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }).strict();
export const historyJobKey = (playerId: string) => `HISTORY_JOB#${historyHash(playerId)}`;
const semanticAchievements = (state: AchievementAccumulator | null) => state ? {
  counts: state.counts, uncertain: [...state.uncertain].sort(), runs: state.runs,
  highest: Object.entries(state.highest).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, award]) => [id, publicUnlock(award!)])
} : null;
const failure = (message: string): never => { throw new PlayerHistoryError('history_unavailable', message); };
const conditional = (error: unknown): boolean => {
  const value = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return value?.name === 'ConditionalCheckFailedException' || (value?.name === 'TransactionCanceledException'
    && Boolean(value.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')));
};
const contextSame = (a: HistoryContext, b: HistoryContext): boolean => JSON.stringify(a) === JSON.stringify(b);
export function publicationCurrent(publication: HistoryPublication | null, revision: string, readinessRevision: string): boolean {
  return publication?.sourceRevision === revision && publication.readinessRevision === readinessRevision
    && publication.ruleVersion === ACHIEVEMENT_RULE_VERSION;
}

/** A durable league sweep coalesces all marker revisions to the CURRENT source token.
 * No scan or request-time league history traversal. Each delivery advances one bounded
 * directory page or one persisted player generation checkpoint. Verification can advance
 * a stranded player job too, so recovery never depends solely on stream retention. */
export class HistoryCoordinator {
  private readonly source: HistorySource;
  private readonly store: PlayerHistoryStore;
  private readonly identities: PlayerIdentityPlanner;
  constructor(private readonly client: HistoryClient, private readonly tableName: string,
    private readonly now: () => string = () => new Date().toISOString()) {
    this.source = new HistorySource(client, tableName); this.store = new PlayerHistoryStore(client, tableName);
    this.identities = new PlayerIdentityPlanner(client, tableName);
  }
  private async get(pk: string, sk: string): Promise<HistoryItem | null> {
    historyRow(pk, sk, 'keyBudget', null);
    return (await this.client.send(new GetItemCommand({ TableName: this.tableName,
      Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
  }
  private snap(item: HistoryItem | null, pk: string, sk: string): IdentitySnapshot<null> { return { pk, sk, item, value: null }; }
  private check(item: HistoryItem | null, pk: string, sk: string): TransactWriteItem {
    return identityCondition(this.tableName, this.snap(item, pk, sk));
  }
  private put(item: HistoryItem | null, pk: string, sk: string, type: string, value: unknown): TransactWriteItem {
    const { Key: _key, ...condition } = this.check(item, pk, sk).ConditionCheck!;
    return { Put: { ...condition, Item: historyRow(pk, sk, type, value) } };
  }
  private async transact(actions: TransactWriteItem[]): Promise<void> {
    if (actions.length > 100 || Buffer.byteLength(JSON.stringify(actions)) > 3_500_000) failure('History work exceeds transaction budget.');
    await sendHistoryTransaction(this.client, new TransactWriteItemsCommand({ TransactItems: actions }));
  }
  private async page(pk: string, prefix: string, after: string | null, limit = 10): Promise<{ items: HistoryItem[]; cursor: string | null }> {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } },
      ...(after ? { ExclusiveStartKey: historyKey(pk, after) } : {}) })) as QueryCommandOutput;
    const items = response.Items ?? []; let previous = after;
    if (items.length > limit) failure('Oversized history work page.');
    for (const item of items) {
      const sk = item.sk?.S;
      if (item.pk?.S !== pk || !sk?.startsWith(prefix) || (previous && sk <= previous)) failure('Malformed history work page.');
      previous = sk!;
    }
    const key = response.LastEvaluatedKey;
    if (!key || !Object.keys(key).length) return { items, cursor: null };
    const cursor = key.sk?.S;
    if (key.pk?.S !== pk || !cursor?.startsWith(prefix) || (after && cursor <= after) || (previous && cursor < previous))
      failure('Nonadvancing history work cursor.');
    return { items, cursor: cursor! };
  }
  private async leagueSnapshot(leagueId: string) {
    const pk = `LEAGUE#${leagueId}`, readiness = await readHistoryReadiness(this.client, this.tableName);
    const control = await this.identities.readControl(); this.identities.requireDirectory(control);
    const league = await this.get(pk, 'METADATA');
    if (!league || historyBody<{ leagueId: string }>(league, pk, 'METADATA', 'league').leagueId !== leagueId) failure('League is unavailable.');
    const live = await this.identities.liveScope('league', [leagueId]);
    const source = await this.get(pk, 'HISTORY_SOURCE');
    if (!source) failure('League history source is not initialized.');
    const data = z.object({ version: z.literal(1), leagueId: z.literal(leagueId), revision: text })
      .parse(historyBody(source!, pk, 'HISTORY_SOURCE', 'playerHistorySource'));
    const directory = await this.get(pk, 'PLAYER_DIRECTORY');
    if (directory) z.object({ revision: text }).parse(historyBody(directory, pk, 'PLAYER_DIRECTORY', 'playerDirectoryRevision'));
    return { pk, revision: data.revision, readinessRevision: readiness.value.revision, directory,
      checks: [identityCondition(this.tableName, readiness), identityCondition(this.tableName, control),
        this.check(league, pk, 'METADATA'), live, this.check(source, pk, 'HISTORY_SOURCE'), this.check(directory, pk, 'PLAYER_DIRECTORY')] };
  }
  /** Internal route/worker primitive. Caller supplies only identifiers after authorisation;
   * source, identity and conditions are always reconstructed from authoritative records. */
  async ensurePlayer(leagueId: string, playerId: string, recoverFailed = false): Promise<HistoryQueueReference> {
    const context = await this.source.captureContext(leagueId, playerId), pk = `LEAGUE#${leagueId}`, key = historyJobKey(context.playerId);
    const directory = await this.get(pk, identityDirectorySk(context.playerId));
    if (!directory || !directorySchema.parse(historyBody(directory, pk, identityDirectorySk(context.playerId), 'leaguePlayer')).active)
      failure('Player has no active league directory association.');
    const existing = await this.get(pk, key), job = existing ? this.job(existing, leagueId, key) : null;
    const publication = await this.store.getPublication(leagueId, context.playerId);
    const current = publicationCurrent(publication, context.sourceRevision, context.readinessRevision!);
    if ((current && job?.status === 'done') || (!current && job?.status === 'pending' && job.spec && contextSame(job.spec.context, context))
      || (!recoverFailed && job?.status === 'failed' && job.spec && contextSame(job.spec.context, context)))
      return { version: 1, kind: 'player', leagueId, key };
    const next: Job = { version: 1, leagueId, playerId: context.playerId, status: current ? 'done' : 'pending',
      requestedRevision: context.sourceRevision, spec: current ? null : { generation: randomUUID(), context, calculatedAt: this.now() }, updatedAt: this.now() };
    await this.transact([...context.checks, this.check(directory, pk, identityDirectorySk(context.playerId)),
      this.put(existing, pk, key, 'playerHistoryJob', next)]);
    return { version: 1, kind: 'player', leagueId, key };
  }
  private job(item: HistoryItem, leagueId: string, key: string): Job {
    const job = jobSchema.parse(historyBody(item, `LEAGUE#${leagueId}`, key, 'playerHistoryJob')) as Job;
    if (job.leagueId !== leagueId || historyJobKey(job.playerId) !== key || (job.spec &&
      (job.spec.context?.leagueId !== leagueId || job.spec.context.playerId !== job.playerId || job.spec.context.sourceRevision !== job.requestedRevision)))
      failure('History job scope mismatch.');
    return job;
  }
  async process(input: HistoryQueueReference): Promise<{ done: boolean }> {
    const ref = historyQueueReferenceSchema.parse(input);
    try { return ref.kind === 'directory' ? await this.processDirectory(ref)
      : ref.kind === 'work' ? await this.processWork(ref) : await this.processPlayer(ref); }
    catch (error) {
      // Contending duplicate delivery never starts a speculative second checkpoint.
      // The next delivery rereads the durable state. Other failures retain SQS retry/DLQ.
      if (conditional(error) || (error instanceof PlayerHistoryError && error.code === 'history_changed')) return { done: false };
      throw error;
    }
  }
  private async deletedLeague(leagueId: string): Promise<HistoryItem | null> {
    const sk = identityTombstoneSk('league', [leagueId]), item = await this.get('PLAYER_IDENTITY_TOMBSTONE', sk);
    if (item) z.object({ kind: z.literal('league'), ids: z.tuple([z.literal(leagueId)]) })
      .parse(historyBody(item, 'PLAYER_IDENTITY_TOMBSTONE', sk, 'playerIdentityTombstone'));
    return item;
  }
  private async processPlayer(ref: HistoryQueueReference): Promise<{ done: boolean }> {
    const pk = `LEAGUE#${ref.leagueId}`, item = await this.get(pk, ref.key);
    if (!item) failure('Durable player job is missing.');
    const job = this.job(item!, ref.leagueId, ref.key);
    const deleted = await this.deletedLeague(ref.leagueId);
    if (deleted) {
      await this.transact([this.check(deleted, deleted.pk!.S!, deleted.sk!.S!),
        this.put(item, pk, ref.key, 'playerHistoryJob', { ...job, status: 'done', spec: null, updatedAt: this.now() })]);
      return { done: true };
    }
    const context = await this.source.captureContext(ref.leagueId, job.playerId);
    if (context.playerId !== job.playerId) {
      await this.ensurePlayer(ref.leagueId, context.playerId);
      await this.transact([...context.checks, this.put(item, pk, ref.key, 'playerHistoryJob', { ...job, status: 'done', spec: null, updatedAt: this.now() })]);
      return { done: true };
    }
    if (publicationCurrent(await this.store.getPublication(ref.leagueId, job.playerId), context.sourceRevision, context.readinessRevision!)) {
      if (job.status !== 'done') await this.transact([...context.checks,
        this.put(item, pk, ref.key, 'playerHistoryJob', { ...job, status: 'done', spec: null, updatedAt: this.now() })]);
      return { done: true };
    }
    if (!job.spec || !contextSame(job.spec.context, context)) { await this.ensurePlayer(ref.leagueId, job.playerId); return { done: false }; }
    if (job.status === 'failed') failure('History job needs source repair or explicit recovery.');
    try {
      const step = await this.store.beginGeneration(job.spec);
      if (step.phase === 'collecting') await this.store.collectNext(job.spec,
        new ResumableHistoryCollector(this.client, this.tableName, job.spec.generation).readPage);
      else if (step.phase === 'evaluating') {
        if (step.evaluationDone) await this.store.markComplete(job.spec); else await this.store.evaluateNext(job.spec);
      } else await this.store.publish(job.spec);
      return { done: false }; // A following delivery confirms the published pointer before marking this job done.
    } catch (error) {
      if ((error instanceof PlayerHistoryError && error.code === 'history_unavailable') || error instanceof z.ZodError
        || (error instanceof PlayerIdentityError && error.code === 'player_identity_unavailable')) {
        await this.transact([this.put(item, pk, ref.key, 'playerHistoryJob', { ...job, status: 'failed', errorCode: 'history_unavailable', updatedAt: this.now() })]);
      }
      throw error;
    }
  }
  /** Directory revisions commit with activation, including zero-appearance players.
   * Coalesce duplicate/old stream delivery against the CURRENT authoritative revision.
   * The receipt and ordinary work marker commit together; retries never invent another
   * rebuild after a lost acknowledgement, and queue continuations drain that marker. */
  private async processDirectory(ref: HistoryQueueReference): Promise<{ done: boolean }> {
    const deleted = await this.deletedLeague(ref.leagueId);
    if (deleted) {
      await this.transact([this.check(deleted, deleted.pk!.S!, deleted.sk!.S!)]);
      return { done: true };
    }
    const readiness = await readHistoryReadiness(this.client, this.tableName);
    const control = await this.identities.readControl(); this.identities.requireDirectory(control);
    const pk = `LEAGUE#${ref.leagueId}`, league = await this.get(pk, 'METADATA');
    if (!league || historyBody<{ leagueId: string }>(league, pk, 'METADATA', 'league').leagueId !== ref.leagueId)
      failure('League is unavailable.');
    const directory = await this.get(pk, 'PLAYER_DIRECTORY');
    if (!directory) failure('Directory revision is unavailable.');
    z.object({ revision: text }).strict().parse(historyBody(directory!, pk, 'PLAYER_DIRECTORY', 'playerDirectoryRevision'));
    const key = 'HISTORY_DIRECTORY', prior = await this.get(pk, key);
    const receipt = prior ? directoryReceiptSchema(ref.leagueId).parse(historyBody(prior, pk, key, 'playerHistoryDirectoryReceipt')) : null;
    if (receipt && receipt.directoryData === directory!.data!.S && receipt.readinessRevision === readiness.value.revision)
      return this.processWork({ version: 1, kind: 'work', leagueId: ref.leagueId, key: receipt.workKey });
    const actions = historyMutationItems(this.tableName, { leagueId: ref.leagueId, reason: 'history-rebuild' }, this.now());
    await this.transact([identityCondition(this.tableName, readiness), identityCondition(this.tableName, control),
      this.check(league, pk, 'METADATA'), await this.identities.liveScope('league', [ref.leagueId]),
      this.check(directory, pk, 'PLAYER_DIRECTORY'), this.put(prior, pk, key, 'playerHistoryDirectoryReceipt', {
        version: 1, leagueId: ref.leagueId, directoryData: directory!.data!.S!, readinessRevision: readiness.value.revision,
        workKey: actions[1].Put!.Item!.sk!.S!
      }), ...actions]);
    return { done: false };
  }
  private async processWork(ref: HistoryQueueReference): Promise<{ done: boolean }> {
    const pk = `LEAGUE#${ref.leagueId}`, marker = await this.get(pk, ref.key);
    if (!marker) failure('Durable history marker is missing.');
    const work = historyWorkSchema.parse(historyBody(marker!, pk, ref.key, 'playerHistoryWork'));
    if (work.leagueId !== ref.leagueId || ref.key !== `HISTORY_WORK#${work.revision}`) failure('History marker scope mismatch.');
    const ackKey = `HISTORY_ACK#${work.revision}`, ack = await this.get(pk, ackKey);
    if (ack) { this.acknowledgement(ack, ref.leagueId, work.revision); return { done: true }; }
    const deleted = await this.deletedLeague(ref.leagueId);
    if (deleted) {
      await this.transact([this.check(deleted, deleted.pk!.S!, deleted.sk!.S!), this.put(null, pk, ackKey, 'playerHistoryAcknowledgement',
        { version: 1, leagueId: ref.leagueId, revision: work.revision, disposition: 'league-deleted', completedAt: this.now() })]);
      return { done: true };
    }
    const scope = await this.leagueSnapshot(ref.leagueId), sweepItem = await this.get(pk, 'HISTORY_SWEEP');
    let sweep = sweepItem ? sweepSchema.parse(historyBody(sweepItem, pk, 'HISTORY_SWEEP', 'playerHistorySweep')) : null;
    if (!sweep || sweep.revision !== scope.revision || sweep.readinessRevision !== scope.readinessRevision || sweep.directoryData !== (scope.directory?.data?.S ?? null)) {
      sweep = { version: 1, id: randomUUID(), leagueId: ref.leagueId, revision: scope.revision, readinessRevision: scope.readinessRevision,
        directoryData: scope.directory?.data?.S ?? null, phase: 'fanout', cursor: null, enqueued: 0, checked: 0, startedAt: this.now(), completedAt: null };
      await this.transact([...scope.checks, this.put(sweepItem, pk, 'HISTORY_SWEEP', 'playerHistorySweep', sweep)]);
      return { done: false };
    }
    if (sweep.leagueId !== ref.leagueId) failure('History sweep scope mismatch.');
    if (sweep.phase === 'complete') {
      await this.transact([...scope.checks, this.check(sweepItem, pk, 'HISTORY_SWEEP'), this.put(null, pk, ackKey, 'playerHistoryAcknowledgement',
        { version: 1, leagueId: ref.leagueId, revision: work.revision, disposition: 'reconciled', satisfiedBy: sweep.revision, sweepId: sweep.id, completedAt: this.now() })]);
      return { done: true };
    }
    const page = await this.page(pk, 'PLAYER#', sweep.cursor);
    let count = 0;
    for (const row of page.items) {
      const entry = directorySchema.parse(historyBody(row, pk, row.sk!.S!, 'leaguePlayer'));
      if (row.sk?.S !== identityDirectorySk(entry.playerId)) failure('Malformed directory identity.');
      if (!entry.active) continue;
      const identity = await this.identities.resolve(entry.playerId);
      if (identity.root.value.playerId !== entry.playerId) failure('Alias remains active in league directory.');
      const jobRef = await this.ensurePlayer(ref.leagueId, entry.playerId);
      if (sweep.phase === 'verify' && !publicationCurrent(await this.store.getPublication(ref.leagueId, entry.playerId), scope.revision, scope.readinessRevision)) {
        await this.processPlayer(jobRef); return { done: false };
      }
      count++;
    }
    const next: Sweep = { ...sweep, cursor: page.cursor,
      enqueued: sweep.enqueued + (sweep.phase === 'fanout' ? count : 0), checked: sweep.checked + (sweep.phase === 'verify' ? count : 0) };
    if (page.cursor === null) {
      next.phase = sweep.phase === 'fanout' ? 'verify' : 'complete';
      if (next.phase === 'complete') next.completedAt = this.now();
    }
    await this.transact([...scope.checks, this.put(sweepItem, pk, 'HISTORY_SWEEP', 'playerHistorySweep', next)]);
    return { done: false };
  }
  /** Explicit bounded backfill start. Global activation is separate and cannot be inferred
   * from this writer token. Import/migration operators call this after verified activation. */
  async requestRebuild(leagueId: string): Promise<HistoryQueueReference> {
    text.parse(leagueId); const readiness = await readHistoryReadiness(this.client, this.tableName);
    const control = await this.identities.readControl(); this.identities.requireDirectory(control);
    const pk = `LEAGUE#${leagueId}`, league = await this.get(pk, 'METADATA');
    if (!league || historyBody<{ leagueId: string }>(league, pk, 'METADATA', 'league').leagueId !== leagueId) failure('League is unavailable.');
    const actions = historyMutationItems(this.tableName, { leagueId, reason: 'history-rebuild' }, this.now());
    const key = actions[1].Put!.Item!.sk!.S!;
    await this.transact([identityCondition(this.tableName, readiness), identityCondition(this.tableName, control),
      this.check(league, pk, 'METADATA'), await this.identities.liveScope('league', [leagueId]), ...actions]);
    return { version: 1, kind: 'work', leagueId, key };
  }
  /** Dry-run means deriving a separate immutable generation without publishing it.
   * Its stored comparison is resumable and contains no private account data. */
  async startComparison(leagueId: string, playerId: string): Promise<string> {
    const context = await this.source.captureContext(leagueId, playerId), comparisonId = randomUUID();
    const spec: HistoryGeneration = { generation: comparisonId, context, calculatedAt: this.now() };
    await this.transact([...context.checks, this.put(null, `LEAGUE#${leagueId}`, `HISTORY_COMPARE#${comparisonId}`,
      'playerHistoryComparison', { version: 1, leagueId, playerId: context.playerId, spec, result: null })]);
    return comparisonId;
  }
  async stepComparison(leagueId: string, comparisonId: string): Promise<{ done: boolean; result: unknown }> {
    z.string().uuid().parse(comparisonId);
    const pk = `LEAGUE#${leagueId}`, key = `HISTORY_COMPARE#${comparisonId}`, row = await this.get(pk, key);
    if (!row) failure('History comparison does not exist.');
    const value = z.object({ version: z.literal(1), leagueId: z.literal(leagueId), playerId: text, spec: z.unknown(), result: z.unknown().nullable() })
      .strict().parse(historyBody(row!, pk, key, 'playerHistoryComparison'));
    const spec = value.spec as HistoryGeneration;
    if (spec.generation !== comparisonId || spec.context.leagueId !== leagueId || spec.context.playerId !== value.playerId)
      failure('History comparison scope mismatch.');
    if (value.result !== null) return { done: true, result: value.result };
    const context = await this.source.captureContext(leagueId, value.playerId);
    if (!contextSame(context, spec.context)) throw new PlayerHistoryError('history_changed', 'Source changed; start a new comparison.');
    const step = await this.store.beginGeneration(spec);
    if (step.phase === 'collecting') await this.store.collectNext(spec, new ResumableHistoryCollector(this.client, this.tableName, comparisonId).readPage);
    else if (step.phase === 'evaluating') {
      if (step.evaluationDone) await this.store.markComplete(spec); else await this.store.evaluateNext(spec);
    } else if (step.phase === 'complete') {
      const publicationPk = historyPartition(leagueId, value.playerId);
      const publicationRow = await this.get(publicationPk, 'PUBLISHED');
      const publication = await this.store.getPublication(leagueId, value.playerId);
      if ((publicationRow ? historyBody<HistoryPublication>(publicationRow, publicationPk, 'PUBLISHED', 'playerHistoryPublication').generation : undefined)
        !== publication?.generation) throw new PlayerHistoryError('history_changed', 'Published comparison source changed.');
      const before = await this.store.getSummary(leagueId, value.playerId, { scope: 'career', seasonId: null });
      const after = await this.store.previewCareer(spec);
      const current = await this.store.getPublication(leagueId, value.playerId);
      if (current?.generation !== publication?.generation) throw new PlayerHistoryError('history_changed', 'Published comparison source changed.');
      const result = { comparisonScope: 'career-summary', comparisonIncludes: ['totals', 'progress', 'assessability', 'streaks', 'highest-milestones'], priorGeneration: publication?.generation ?? null, comparisonGeneration: comparisonId,
        totalsChanged: JSON.stringify(before?.state.totals ?? null) !== JSON.stringify(after.state.totals),
        achievementsChanged: JSON.stringify(semanticAchievements(before?.state ?? null)) !== JSON.stringify(semanticAchievements(after.state)),
        before: before?.state ?? null, after: after.state };
      await this.transact([...context.checks, this.check(publicationRow, publicationPk, 'PUBLISHED'),
        this.put(row, pk, key, 'playerHistoryComparison', { ...value, result })]);
      return { done: true, result };
    } else failure('Comparison generation was unexpectedly published.');
    return { done: false, result: null };
  }
  private acknowledgement(row: HistoryItem, leagueId: string, revision: string) {
    const value = ackSchema.parse(historyBody(row, `LEAGUE#${leagueId}`, `HISTORY_ACK#${revision}`, 'playerHistoryAcknowledgement'));
    if (value.leagueId !== leagueId || value.revision !== revision) failure('History acknowledgement scope mismatch.');
    return value;
  }
  /** Recovery discovers durable markers/jobs by league key, never a table scan.
   * A page is not completion; callers retain its continuation and drain each returned ref. */
  async pendingPage(leagueId: string, kind: 'work' | 'player', cursor: string | null = null) {
    text.parse(leagueId); const prefix = kind === 'work' ? 'HISTORY_WORK#' : 'HISTORY_JOB#';
    if (cursor !== null && (!cursor.startsWith(prefix) || Buffer.byteLength(cursor) > 1024)) failure('Invalid recovery continuation.');
    const refs: HistoryQueueReference[] = [];
    // The directory revision itself is the durable obligation. Recover it even if
    // its stream record aged out before the bridge could create HISTORY_WORK.
    if (kind === 'work' && cursor === null && !await this.deletedLeague(leagueId)) {
      const pk = `LEAGUE#${leagueId}`, directory = await this.get(pk, 'PLAYER_DIRECTORY');
      if (directory) {
        z.object({ revision: text }).strict().parse(historyBody(directory, pk, 'PLAYER_DIRECTORY', 'playerDirectoryRevision'));
        const readiness = await readHistoryReadiness(this.client, this.tableName), receipt = await this.get(pk, 'HISTORY_DIRECTORY');
        const value = receipt ? directoryReceiptSchema(leagueId).parse(historyBody(receipt, pk,
          'HISTORY_DIRECTORY', 'playerHistoryDirectoryReceipt')) : null;
        if (value?.directoryData !== directory.data!.S || value?.readinessRevision !== readiness.value.revision)
          refs.push({ version: 1, kind: 'directory', leagueId, key: 'PLAYER_DIRECTORY' });
      }
    }
    const page = await this.page(`LEAGUE#${leagueId}`, prefix, cursor, 20 - refs.length);
    for (const row of page.items) {
      const key = row.sk!.S!;
      if (kind === 'work') {
        const work = historyWorkSchema.parse(historyBody(row, `LEAGUE#${leagueId}`, key, 'playerHistoryWork'));
        const ack = await this.get(`LEAGUE#${leagueId}`, `HISTORY_ACK#${work.revision}`);
        if (ack) this.acknowledgement(ack, leagueId, work.revision); else refs.push({ version: 1, kind, leagueId, key });
      } else if (this.job(row, leagueId, key).status !== 'done') refs.push({ version: 1, kind, leagueId, key });
    }
    return { refs, cursor: page.cursor };
  }
  async recoverPlayer(leagueId: string, playerId: string): Promise<HistoryQueueReference> { return this.ensurePlayer(leagueId, playerId, true); }
  async status(leagueId: string): Promise<Sweep | null> {
    const pk = `LEAGUE#${text.parse(leagueId)}`, row = await this.get(pk, 'HISTORY_SWEEP');
    return row ? sweepSchema.parse(historyBody(row, pk, 'HISTORY_SWEEP', 'playerHistorySweep')) : null;
  }
}
