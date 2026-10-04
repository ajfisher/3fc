import { randomUUID } from 'node:crypto';
import { GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { ACHIEVEMENT_RULE_VERSION } from '@3fc/contracts';
import { PlayerIdentityPlanner, identityCondition, type IdentitySnapshot } from './player-identity.js';
import { historyBody, historyKey, historyRow, PlayerHistoryError, type HistoryClient, type HistoryItem } from './player-history-model.js';

export const HISTORY_READINESS_KEY = { pk: 'PLAYER_HISTORY', sk: 'CONTROL' } as const;
export const historyActivationManifestSchema = z.object({
  version: z.literal(1), writerVersion: z.literal(1), writerSha: z.string().regex(/^[a-f0-9]{40}$/),
  tableName: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/), accountId: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  reviewedPlan: z.string().regex(/^https:\/\/github\.com\/ajfisher\/3fc\/(?:pull|issues)\/\d+$/),
  drainedAt: z.string().datetime({ offset: true }), ruleVersion: z.literal(ACHIEVEMENT_RULE_VERSION)
}).strict();
export type HistoryActivationManifest = z.infer<typeof historyActivationManifestSchema>;
export const historyReadinessSchema = z.object({ version: z.literal(1), enabled: z.literal(true), revision: z.string().uuid(),
  ruleVersion: z.literal(ACHIEVEMENT_RULE_VERSION), activatedAt: z.string().datetime({ offset: true }),
  manifest: historyActivationManifestSchema }).strict();
export type HistoryReadiness = z.infer<typeof historyReadinessSchema>;
export async function readHistoryReadiness(client: HistoryClient, tableName: string): Promise<IdentitySnapshot<HistoryReadiness>> {
  const { pk, sk } = HISTORY_READINESS_KEY;
  const item = (await client.send(new GetItemCommand({ TableName: tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item;
  const parsed = item && historyReadinessSchema.safeParse(historyBody(item, pk, sk, 'playerHistoryReadiness'));
  if (!item || !parsed || !parsed.success || parsed.data.manifest.tableName !== tableName)
    throw new PlayerHistoryError('history_unavailable', 'History deployment coverage has not been activated.');
  return { pk, sk, item, value: parsed.data };
}
/** Migration and import tools invalidate history in the same transaction as their write pause.
 * Re-activation requires a new verified deployment manifest; old publications remain retained. */
export function disableHistoryReadiness(tableName: string, reason: string, now: string): TransactWriteItem {
  return { Put: { TableName: tableName, Item: historyRow(HISTORY_READINESS_KEY.pk, HISTORY_READINESS_KEY.sk,
    'playerHistoryReadiness', { version: 1, enabled: false, revision: randomUUID(), reason, disabledAt: now }) } };
}
/** Operator-only: the CLI verifies account/table/live deployment and old-writer drain before
 * calling this service. No HTTP route exposes an activation manifest or caller-built checks. */
export async function activateHistory(client: HistoryClient, tableName: string, input: HistoryActivationManifest,
  now = new Date().toISOString()): Promise<HistoryReadiness> {
  const manifest = historyActivationManifestSchema.parse(input);
  if (manifest.tableName !== tableName || Date.parse(manifest.drainedAt) > Date.parse(now))
    throw new PlayerHistoryError('history_unavailable', 'History activation manifest is not applicable.');
  const planner = new PlayerIdentityPlanner(client, tableName), control = await planner.readControl();
  planner.requireCoverage(control);
  const { pk, sk } = HISTORY_READINESS_KEY;
  const item = (await client.send(new GetItemCommand({ TableName: tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
  if (item) {
    const previous = historyReadinessSchema.safeParse(historyBody(item, pk, sk, 'playerHistoryReadiness'));
    if (previous.success && JSON.stringify(previous.data.manifest) === JSON.stringify(manifest)) return previous.data;
  }
  const value: HistoryReadiness = { version: 1, enabled: true, revision: randomUUID(), ruleVersion: ACHIEVEMENT_RULE_VERSION,
    activatedAt: now, manifest };
  const check = identityCondition(tableName, { pk, sk, item, value: null }).ConditionCheck!;
  const { Key: _key, ...condition } = check;
  await client.send(new TransactWriteItemsCommand({ TransactItems: [identityCondition(tableName, control),
    { Put: { ...condition, Item: historyRow(pk, sk, 'playerHistoryReadiness', value) } }] }));
  return value;
}
