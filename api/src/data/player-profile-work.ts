import { z } from 'zod';
import { validPlayerIdentityId } from './player-identity.js';
import { historyHash } from './player-history-model.js';

const playerId = z.string().refine(validPlayerIdentityId), uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
export const ownerDisplayNameSchema = z.string().refine(value => {
  try { encodeURIComponent(value); } catch { return false; }
  return !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}).trim().min(1).max(80);
export const ownerProfileRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ownerProfileIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const PLAYER_PRESENTATION_SK = 'PRESENTATION';
export const playerPresentationSchema = z.object({ version: z.literal(1), playerId, nameRevision: uuid }).strict();
export type PlayerPresentation = z.infer<typeof playerPresentationSchema>;
export const profileNameWorkSchema = z.object({ version: z.literal(1), jobId: uuid, playerId, nameRevision: uuid,
  displayName: ownerDisplayNameSchema, members: z.array(playerId).min(1).max(20), memberIndex: z.number().int().min(0).max(20),
  cursor: z.string().regex(/^LEAGUE#[a-f0-9]{64}$/).nullable(), status: z.enum(['pending', 'done']), createdAt: instant, updatedAt: instant,
  completionReason: z.enum(['completed', 'superseded']).optional() }).strict().refine(value => value.jobId === value.nameRevision
    && value.members.includes(value.playerId) && new Set(value.members).size === value.members.length && value.memberIndex <= value.members.length);
export type ProfileNameWork = z.infer<typeof profileNameWorkSchema>;
export const profileWorkReferenceSchema = z.object({ version: z.literal(1), kind: z.literal('profile'),
  playerHash: z.string().regex(/^[a-f0-9]{64}$/), key: z.string().regex(/^NAME#[0-9a-f-]{36}$/).refine(value => uuid.safeParse(value.slice(5)).success) }).strict();
export type ProfileWorkReference = z.infer<typeof profileWorkReferenceSchema>;
export const profilePlayerHash = (id: string): string => historyHash(playerId.parse(id));
export const profileWorkPartition = (id: string): string => `PLAYER_PROFILE_WORK#${profilePlayerHash(id)}`;
export const profileNameWorkKey = (revision: string): string => `NAME#${uuid.parse(revision)}`;
export const profileWorkReference = (id: string, revision: string): ProfileWorkReference => ({ version: 1, kind: 'profile',
  playerHash: profilePlayerHash(id), key: profileNameWorkKey(revision) });
