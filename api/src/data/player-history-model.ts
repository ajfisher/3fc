import { createHash } from 'node:crypto';
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';
import type { AchievementAccumulator, AwardEvidence, MatchFacts } from '../achievements/evaluate.js';
import type { PlayerAppearance } from '@3fc/contracts';

export type HistoryItem = Record<string, AttributeValue>;
export interface HistoryClient { send(command: unknown): Promise<unknown> }
export class PlayerHistoryError extends Error {
  constructor(public readonly code: 'history_unavailable' | 'history_changed' | 'invalid_cursor', message: string) { super(message); }
}
export const historyHash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const historyPartition = (leagueId: string, playerId: string) => `PLAYER_HISTORY#${historyHash(leagueId, playerId)}`;
export const historySourceKey = (leagueId: string) => ({ pk: `LEAGUE#${leagueId}`, sk: 'HISTORY_SOURCE' });
export const historySourceVersion = 1;
/** Immutable source and identity snapshots captured before collecting any history pages. */
export interface HistoryContext {
  leagueId: string;
  playerId: string;
  members: string[];
  displayName: string;
  sourceRevision: string;
  identityWriteVersion: string;
  identityEpoch: string;
  /** Conditions are server-built from strongly consistent authoritative reads, never queue/client input. */
  checks: TransactWriteItem[];
}
export interface HistoryGeneration {
  generation: string;
  context: HistoryContext;
  calculatedAt: string;
}
export interface HistoryPublication {
  generation: string;
  leagueId: string;
  playerId: string;
  sourceRevision: string;
  identityWriteVersion: string;
  identityEpoch: string;
  calculatedAt: string;
  latest: PlayerAppearance | null;
  seasons: Array<{ seasonId: string; lastPlayedAt: string }>;
  previousGeneration: string | null;
}
export interface HistorySummary { state: AchievementAccumulator }
export interface HistoryMatch { facts: MatchFacts; appearance: PlayerAppearance | null }
export type HistoryAward = AwardEvidence & { calculatedAt: string };
export interface HistoryPage<T> { items: T[]; cursor: string | null }
export function historyKey(pk: string, sk: string): HistoryItem { return { pk: { S: pk }, sk: { S: sk } }; }
export function historyRow(pk: string, sk: string, entityType: string, data: unknown): HistoryItem {
  const item = { ...historyKey(pk, sk), entityType: { S: entityType }, data: { S: JSON.stringify(data) } };
  if (Buffer.byteLength(pk) > 2048 || Buffer.byteLength(sk) > 1024 || Buffer.byteLength(JSON.stringify(item)) > 350_000)
    throw new PlayerHistoryError('history_unavailable', 'History record exceeds its storage budget.');
  return item;
}
export function historyBody<T>(item: HistoryItem, pk: string, sk: string, entityType: string): T {
  if (item.pk?.S !== pk || item.sk?.S !== sk || item.entityType?.S !== entityType || !item.data?.S)
    throw new PlayerHistoryError('history_unavailable', 'Malformed history record.');
  try { return JSON.parse(item.data.S) as T; }
  catch { throw new PlayerHistoryError('history_unavailable', 'Malformed history payload.'); }
}
