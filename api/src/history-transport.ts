import { z } from 'zod';
import { historyHash } from './data/player-history-model.js';
import { historyWorkSchema } from './data/player-history-work.js';

const identifier = z.string().min(1).refine(value => value.trim().length > 0);
const leagueId = identifier.refine(value => Buffer.byteLength(`LEAGUE#${value}`, 'utf8') <= 2048);
export const historyQueueReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('work'), leagueId,
    key: z.string().regex(/^HISTORY_WORK#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('player'), leagueId,
    key: z.string().regex(/^HISTORY_JOB#[0-9a-f]{64}$/) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('directory'), leagueId,
    key: z.literal('PLAYER_DIRECTORY') }).strict()
]);
export type HistoryQueueReference = z.infer<typeof historyQueueReferenceSchema>;
export interface HistoryBatchResult { batchItemFailures: Array<{ itemIdentifier: string }> }
interface DispatchDependencies {
  enabled: () => boolean;
  send: (reference: HistoryQueueReference, delaySeconds?: number) => Promise<void>;
}
interface WorkerDependencies extends DispatchDependencies {
  process: (reference: HistoryQueueReference) => Promise<{ done: boolean }>;
}

/** Advance a few durable checkpoints per delivery, sequentially. Budgets are
 * checked between steps; an in-flight transaction always settles before return. */
export async function processHistorySteps(reference: HistoryQueueReference,
  process: WorkerDependencies['process'], options: { now?: () => number; remaining?: () => number } = {}): Promise<{ done: boolean }> {
  const now = options.now ?? (() => performance.now()), remaining = options.remaining ?? (() => Infinity);
  const startedAt = now();
  for (let step = 0; step < 8; step++) {
    if (now() - startedAt >= 5000 || remaining() < 15000) return { done: false };
    const result = await process(reference);
    if (!result || typeof result.done !== 'boolean') throw new Error('history_invalid_processing_result');
    if (result.done) return { done: true };
  }
  return { done: false };
}

const object = z.record(z.string(), z.unknown());
const stringAttribute = z.object({ S: z.string() }).strict();
const keysSchema = z.object({ pk: stringAttribute, sk: stringAttribute }).strict();
const imageSchema = z.object({ pk: stringAttribute, sk: stringAttribute,
  entityType: stringAttribute, data: stringAttribute }).passthrough();
const jobSchema = z.object({ version: z.literal(1), leagueId, playerId: identifier,
  status: z.enum(['pending', 'done', 'failed']) }).passthrough();
// identityPut stores timestamps as top-level DynamoDB attributes, not in data.
const directoryRevisionSchema = z.object({ revision: z.string().uuid() }).strict();
const streamRecordSchema = z.object({ eventSource: z.literal('aws:dynamodb'),
  eventName: z.enum(['INSERT', 'MODIFY', 'REMOVE']), dynamodb: z.object({
    SequenceNumber: z.string().regex(/^\d+$/), Keys: keysSchema,
    NewImage: z.unknown().optional()
  }).passthrough() }).passthrough();
const sqsRecordSchema = z.object({ eventSource: z.literal('aws:sqs'), messageId: identifier,
  body: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 8192) }).passthrough();

function records(event: unknown, limit: number): unknown[] {
  return z.object({ Records: z.array(z.unknown()).max(limit) }).passthrough().parse(event).Records;
}
function streamIdentifier(record: unknown): string {
  const parsed = object.parse(record), dynamodb = object.parse(parsed.dynamodb);
  return z.string().regex(/^\d+$/).parse(dynamodb.SequenceNumber);
}
function sqsIdentifier(record: unknown): string {
  return identifier.parse(object.parse(record).messageId);
}

function streamReference(value: unknown): HistoryQueueReference | null {
  const record = streamRecordSchema.parse(value);
  if (record.eventName === 'REMOVE') return null;
  const image = imageSchema.parse(record.dynamodb.NewImage), keys = record.dynamodb.Keys;
  if (keys.pk.S !== image.pk.S || keys.sk.S !== image.sk.S) throw new Error('history_stream_key_mismatch');
  const work = image.entityType.S === 'playerHistoryWork', job = image.entityType.S === 'playerHistoryJob';
  const directory = image.entityType.S === 'playerDirectoryRevision';
  if (!work && !job && !directory) {
    if (/^HISTORY_(WORK|JOB)#/.test(keys.sk.S) || keys.sk.S === 'PLAYER_DIRECTORY') throw new Error('history_stream_entity_mismatch');
    return null;
  }
  if (work && record.eventName !== 'INSERT') return null;
  const parsed: unknown = JSON.parse(image.data.S);
  let reference: HistoryQueueReference, pending = true;
  if (work) {
    const data = historyWorkSchema.parse(parsed);
    reference = { version: 1, kind: 'work', leagueId: data.leagueId, key: `HISTORY_WORK#${data.revision}` };
  } else if (job) {
    const data = jobSchema.parse(parsed);
    reference = { version: 1, kind: 'player', leagueId: data.leagueId, key: `HISTORY_JOB#${historyHash(data.playerId)}` };
    pending = data.status === 'pending';
  } else {
    directoryRevisionSchema.parse(parsed);
    if (!keys.pk.S.startsWith('LEAGUE#')) throw new Error('history_stream_scope_mismatch');
    reference = { version: 1, kind: 'directory', leagueId: keys.pk.S.slice('LEAGUE#'.length), key: 'PLAYER_DIRECTORY' };
  }
  if (keys.pk.S !== `LEAGUE#${reference.leagueId}` || keys.sk.S !== reference.key) throw new Error('history_stream_scope_mismatch');
  const safeReference = historyQueueReferenceSchema.parse(reference);
  return pending ? safeReference : null;
}

/** Queue delivery acknowledges only durable reference publication, never completion
 * of derivation. Invalid records remain retryable without forwarding their data. */
export function createHistoryDispatcher(dependencies: DispatchDependencies) {
  return async (event: unknown): Promise<HistoryBatchResult> => {
    const batch = records(event, 100);
    // Missing identifiers fail the whole invocation: fabricated IDs could lose work.
    const identifiers = batch.map(streamIdentifier), batchItemFailures: HistoryBatchResult['batchItemFailures'] = [];
    const enabled = dependencies.enabled();
    for (const [index, record] of batch.entries()) {
      try {
        if (!enabled) throw new Error('history_processing_disabled');
        const reference = streamReference(record);
        if (reference) await dependencies.send(reference, 0);
      } catch { batchItemFailures.push({ itemIdentifier: identifiers[index] }); }
    }
    return { batchItemFailures };
  };
}

/** Coordinator re-reads authoritative rows and owns idempotency/checkpoints. If a
 * continuation cannot be queued, retry the original message from that checkpoint. */
export function createHistoryWorker(dependencies: WorkerDependencies) {
  return async (event: unknown): Promise<HistoryBatchResult> => {
    const batch = records(event, 10), identifiers = batch.map(sqsIdentifier);
    const batchItemFailures: HistoryBatchResult['batchItemFailures'] = [], enabled = dependencies.enabled();
    for (const [index, record] of batch.entries()) {
      try {
        if (!enabled) throw new Error('history_processing_disabled');
        const parsed = sqsRecordSchema.parse(record), reference = historyQueueReferenceSchema.parse(JSON.parse(parsed.body));
        const result = await dependencies.process(reference);
        if (!result || typeof result.done !== 'boolean') throw new Error('history_invalid_processing_result');
        if (!result.done) await dependencies.send(reference, 1);
      } catch { batchItemFailures.push({ itemIdentifier: identifiers[index] }); }
    }
    return { batchItemFailures };
  };
}
