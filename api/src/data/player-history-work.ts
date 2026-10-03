import { randomUUID } from 'node:crypto';
import { TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { historyRow, historySourceKey, historySourceVersion } from './player-history-model.js';

const identifier = z.string().min(1).refine(value => value.trim().length > 0);
export const historyMutationReasons = ['game-finished', 'goal-changed', 'roster-changed', 'kickoff-changed',
  'game-deleted', 'season-deleted', 'league-deleted', 'identity-consolidated', 'history-rebuild'] as const;
export type HistoryMutationReason = typeof historyMutationReasons[number];
export interface HistoryMutationInput {
  leagueId: string;
  reason: HistoryMutationReason;
  gameId?: string;
  seasonId?: string;
  playerId?: string;
}
const mutationFields = { leagueId: identifier, reason: z.enum(historyMutationReasons),
  gameId: identifier.optional(), seasonId: identifier.optional(), playerId: identifier.optional() };
function validateMutation(value: HistoryMutationInput, context: z.RefinementCtx): void {
    const required = value.reason === 'identity-consolidated' ? 'playerId'
      : value.reason === 'season-deleted' ? 'seasonId' : ['league-deleted', 'history-rebuild'].includes(value.reason) ? null : 'gameId';
    if (required && !value[required]) context.addIssue({ code: 'custom', message: `History mutation requires ${required}` });
}
const mutationSchema = z.object(mutationFields).strict().superRefine(validateMutation);
export const historyWorkSchema = z.object({ ...mutationFields, version: z.literal(1),
  revision: z.string().uuid(), createdAt: z.string().datetime({ offset: true }) }).strict().superRefine(validateMutation);
export interface HistoryWork extends HistoryMutationInput { version: 1; revision: string; createdAt: string }

interface HistoryTransactionClient { send(command: unknown): Promise<unknown> }
interface HistoryTransactionRetryOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

function isTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, CancellationReasons: reasons } = error as { name?: unknown; CancellationReasons?: unknown };
  if (name === 'TransactionConflictException') return true;
  if (name !== 'TransactionCanceledException' || !Array.isArray(reasons) || !reasons.length) return false;
  return reasons.some(reason => reason?.Code === 'TransactionConflict') && reasons.every(reason =>
    reason !== null && typeof reason === 'object' && (reason.Code === 'None' || reason.Code === 'TransactionConflict'));
}

/** Independent matches briefly contend on the shared league revision. Retry only
 * explicit transaction conflicts: ambiguous delivery and domain-condition failures
 * retain the caller's existing recovery path. Reuse the command, token and marker. */
export async function sendHistoryTransaction(client: HistoryTransactionClient, command: unknown,
  options: HistoryTransactionRetryOptions = {}): Promise<unknown> {
  const hasWork = command instanceof TransactWriteItemsCommand && command.input.TransactItems?.some(item =>
    item.Put?.Item?.entityType?.S === 'playerHistoryWork');
  if (!hasWork) return client.send(command);
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try { return await client.send(command); }
    catch (error) {
      if (attempt >= 3 || !isTransactionConflict(error)) throw error;
      // Bounded jitter avoids synchronising independent scorekeepers on the retry.
      await sleep(Math.round(25 * 2 ** attempt * (0.75 + random() * 0.5)));
    }
  }
}

/** A constant-size outbox appended to the SAME transaction as a source change.
 * Fresh UUID tokens avoid ABA without adding a league-wide read/CAS conflict to
 * live scoring. Domain conditions and idempotency still belong to the caller.
 * A marker is a durable obligation; successful queue delivery alone cannot remove it.
 * This writes no coverage/readiness claim and must never be called on saved replays. */
export function historyMutationItems(tableName: string, input: HistoryMutationInput, now: string): TransactWriteItem[] {
  identifier.parse(tableName);
  const mutation = mutationSchema.parse(input), createdAt = z.string().datetime({ offset: true })
    .transform(value => new Date(value).toISOString()).parse(now);
  const revision = randomUUID(), source = historySourceKey(mutation.leagueId);
  const work: HistoryWork = { ...mutation, version: 1, revision, createdAt };
  return [
    { Put: { TableName: tableName, Item: historyRow(source.pk, source.sk, 'playerHistorySource', {
      leagueId: mutation.leagueId, version: historySourceVersion, revision
    }) } },
    { Put: { TableName: tableName, Item: historyRow(source.pk, `HISTORY_WORK#${revision}`, 'playerHistoryWork', work),
      ConditionExpression: 'attribute_not_exists(pk)' } }
  ];
}
