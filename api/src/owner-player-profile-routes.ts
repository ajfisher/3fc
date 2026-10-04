import { z } from 'zod';
import type { OwnerPlayerProfile } from '@3fc/contracts';
import type { AuthSessionRecord } from './auth/magic-link.js';
import { PlayerIdentityError, validPlayerIdentityId } from './data/player-identity.js';
import { ownerDisplayNameSchema, ownerProfileRevisionSchema } from './data/player-profile-work.js';

export type OwnerPlayerDetails = Omit<OwnerPlayerProfile, 'email'>;
export interface OwnerPlayerInput { playerId: string; userId: string; userIds?: string[] }
export interface OwnerPlayerProfileRepository {
  getOwnerPlayerProfile(input: OwnerPlayerInput): Promise<OwnerPlayerDetails>;
  renameOwnerPlayerProfile(input: OwnerPlayerInput & { displayName: string; expectedRevision: string; idempotencyKey: string }): Promise<OwnerPlayerDetails>;
}
export const OWNER_PROFILE_BODY_LIMIT = 8192;
const playerId = z.string().refine(validPlayerIdentityId);
export const ownerPlayerDetailsSchema = z.object({ playerId, displayName: z.string().min(1), hasPortrait: z.boolean(), revision: ownerProfileRevisionSchema }).strict();
const renameSchema = z.object({ displayName: ownerDisplayNameSchema, expectedRevision: ownerProfileRevisionSchema }).strict();
const idempotencySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const isOwnerPlayerProfileRoute = (method: string, route: string): boolean =>
  ['GET', 'PATCH'].includes(method) && route === '/v1/owner-player-profile';

export function parseOwnerProfileBody(raw: string): unknown {
  if (Buffer.byteLength(raw) > OWNER_PROFILE_BODY_LIMIT) throw new RangeError('Owner profile body is too large');
  return JSON.parse(raw);
}
function queryPlayer(raw: string): string {
  if (raw.length > 13000) throw new URIError();
  const entries = raw.split('&'); if (entries.length !== 1) throw new URIError();
  const at = entries[0].indexOf('='); if (at < 0) throw new URIError();
  const decode = (value: string) => decodeURIComponent(value.replaceAll('+', ' '));
  if (decode(entries[0].slice(0, at)) !== 'playerId') throw new URIError();
  return playerId.parse(decode(entries[0].slice(at + 1)));
}

/** Account identity comes only from the verified session. The private email is
 * added after the owner-fenced read and never enters mutation receipts. */
export async function handleOwnerPlayerProfileRoute(input: {
  method: string; route: string; rawQueryString?: string; body?: unknown; idempotencyKey?: unknown;
  session: AuthSessionRecord | null; repository: OwnerPlayerProfileRepository; enabled?: boolean;
}): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const error = (statusCode: number, category: string, message: string, code?: string) =>
    ({ statusCode, payload: { error: category, message, ...(code ? { code } : {}) } });
  if (!input.session) return error(401, 'unauthorized', 'Sign in to continue.');
  if (!isOwnerPlayerProfileRoute(input.method, input.route) || !(input.enabled ?? process.env.PLAYER_OWNER_EDITING_ENABLED === 'true'))
    return error(404, 'not_found', 'Not found.');
  let id: string;
  try { id = queryPlayer(input.rawQueryString ?? ''); }
  catch { return error(400, 'bad_request', 'Check the player link and try again.'); }
  const userId = input.session.subject ?? input.session.email;
  const base = { playerId: id, userId, userIds: [...new Set([userId, input.session.email])] };
  const parsed = input.method === 'PATCH' ? renameSchema.safeParse(input.body) : null;
  const key = input.method === 'PATCH' ? idempotencySchema.safeParse(input.idempotencyKey) : null;
  if (parsed && (!parsed.success || !key?.success)) return error(400, 'bad_request', 'Check the name and save request, then try again.');
  try {
    if (input.method === 'GET') {
      const details = ownerPlayerDetailsSchema.parse(await input.repository.getOwnerPlayerProfile(base));
      const email = z.string().email().parse(input.session.email);
      return { statusCode: 200, payload: { ...details, email } };
    }
    if (!parsed?.success || !key?.success) return error(400, 'bad_request', 'Check the name and save request, then try again.');
    const payload = ownerPlayerDetailsSchema.parse(await input.repository.renameOwnerPlayerProfile({ ...base, ...parsed.data, idempotencyKey: key.data }));
    return { statusCode: 200, payload };
  } catch (failure) {
    if (failure instanceof PlayerIdentityError) return error(failure.status, failure.category, failure.message, failure.code);
    return error(503, 'unavailable', 'Player details could not be loaded or saved. Try again.');
  }
}
