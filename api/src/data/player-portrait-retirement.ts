import { z } from 'zod';
import { validPlayerIdentityId, identityPut, type IdentitySnapshot } from './player-identity.js';
import { profileWorkPartition } from './player-profile-work.js';
const id = z.string().refine(validPlayerIdentityId), uuid = z.string().uuid();
export const profileMediaRetirementSchema = z.object({ version: z.literal(1), jobId: uuid, playerId: id,
  members: z.array(id).min(1).max(19), memberIndex: z.number().int().min(0).max(19),
  status: z.enum(['pending', 'done']), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true })
}).strict().refine(value => new Set(value.members).size === value.members.length && !value.members.includes(value.playerId)
  && value.memberIndex <= value.members.length && (value.status !== 'done' || value.memberIndex === value.members.length));
export type ProfileMediaRetirement = z.infer<typeof profileMediaRetirementSchema>;
export const profileMediaRetirementKey = (jobId: string) => `RETIRE#${uuid.parse(jobId)}`;
/** One bounded outbox row commits with identity consolidation; the worker walks
 * retired identities without adding up to nineteen writes to the source commit. */
export function portraitRetirementItem(tableName: string, playerId: string, members: string[], jobId: string, now: string) {
  const work = profileMediaRetirementSchema.parse({ version: 1, jobId, playerId, members, memberIndex: 0, status: 'pending', createdAt: now, updatedAt: now });
  const snapshot: IdentitySnapshot<null> = { pk: profileWorkPartition(playerId), sk: profileMediaRetirementKey(jobId), item: null, value: null };
  return identityPut(tableName, snapshot, 'playerProfileMediaRetirement', work, now);
}
