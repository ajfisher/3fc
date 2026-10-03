import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { seasonSk } from './keys.js';
import { historyBody, historyKey, historyRow, PlayerHistoryError, type HistoryClient, type HistoryItem } from './player-history-model.js';
import type { IdentitySnapshot } from './player-identity.js';

const identifier = z.string().min(1).refine(value => value.trim().length > 0);
const instant = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const profileSeasonCandidateSchema = z.object({ seasonId: identifier, name: identifier,
  startsOn: z.iso.date().nullable(), createdAt: instant }).strict();
export type ProfileSeasonCandidate = z.infer<typeof profileSeasonCandidateSchema>;
export const profileSeasonDefaultSchema = z.object({ version: z.literal(1), leagueId: identifier,
  sourceRevision: identifier, readinessRevision: identifier, computedAt: instant,
  season: profileSeasonCandidateSchema.nullable() }).strict();
export type ProfileSeasonDefault = z.infer<typeof profileSeasonDefaultSchema>;
export function profileSeasonDefaultKey(leagueId: string): { pk: string; sk: string } {
  identifier.parse(leagueId);
  const key = { pk: `LEAGUE#${leagueId}`, sk: 'PROFILE_SEASON_DEFAULT' };
  historyRow(key.pk, key.sk, 'keyBudget', null);
  return key;
}

/** Rank newest by start date (or UTC creation date when absent/unusable), creation instant,
 * then UTF-8 season ID. Every comparison is descending; IDs remain opaque. */
export function latestProfileSeasonCandidate(left: ProfileSeasonCandidate | null, right: ProfileSeasonCandidate): ProfileSeasonCandidate {
  if (!left) return right;
  const date = (right.startsOn ?? right.createdAt.slice(0, 10)).localeCompare(left.startsOn ?? left.createdAt.slice(0, 10));
  const created = right.createdAt.localeCompare(left.createdAt);
  return date > 0 || (date === 0 && (created > 0 || (created === 0 && Buffer.compare(Buffer.from(right.seasonId), Buffer.from(left.seasonId)) > 0))) ? right : left;
}

export function profileSeasonCandidateFromItem(item: HistoryItem, leagueId: string): ProfileSeasonCandidate {
  const metadata = z.object({ leagueId: z.literal(leagueId), seasonId: identifier, name: identifier,
    startsOn: z.unknown().optional() }).parse(historyBody(item, `LEAGUE#${leagueId}`, item.sk?.S ?? '', 'season'));
  if (item.sk?.S !== seasonSk(metadata.seasonId)) throw new PlayerHistoryError('history_unavailable', 'Season metadata scope mismatch.');
  // Existing season writers accept free-form dates. Such values provide no
  // ordering evidence; normalize them to null and use the creation date.
  const startsOn = z.iso.date().safeParse(metadata.startsOn);
  return profileSeasonCandidateSchema.parse({ seasonId: metadata.seasonId, name: metadata.name,
    startsOn: startsOn.success ? startsOn.data : null, createdAt: item.createdAt?.S });
}

/** Strong, constant-size read with the exact snapshot for the caller's final
 * access/source/readiness transaction. Missing row differs from season:null;
 * consumers must verify both source and readiness revisions before trusting it. */
export async function getProfileSeasonDefault(client: HistoryClient, tableName: string,
  leagueId: string): Promise<IdentitySnapshot<ProfileSeasonDefault | null>> {
  const { pk, sk } = profileSeasonDefaultKey(leagueId);
  const item = (await client.send(new GetItemCommand({ TableName: tableName,
    Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
  if (!item) return { pk, sk, item: null, value: null };
  const value = profileSeasonDefaultSchema.parse(historyBody(item, pk, sk, 'playerProfileSeasonDefault'));
  if (value.leagueId !== leagueId) throw new PlayerHistoryError('history_unavailable', 'Default season scope mismatch.');
  return { pk, sk, item, value };
}
