import { z } from 'zod';
import type { AuthSessionRecord } from './auth/magic-link.js';
import { PlayerIdentityError, validPlayerIdentityId } from './data/player-identity.js';
import { ownerProfileIdempotencyKeySchema, ownerProfileRevisionSchema } from './data/player-profile-work.js';
import { decodePortraitBase64, PortraitInputError } from './media/player-portrait.js';
import { ownerPlayerDetailsSchema, type OwnerPlayerDetails, type OwnerPlayerInput } from './owner-player-profile-routes.js';
import type { ProfileReadInput } from './data/player-profile-read.js';

export interface PlayerPortraitRepository {
  getPlayerPortrait(input: ProfileReadInput): Promise<Uint8Array | null>;
  putOwnerPlayerPortrait(input: OwnerPlayerInput & { expectedRevision: string; idempotencyKey: string;
    contentType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Buffer }): Promise<OwnerPlayerDetails>;
  removeOwnerPlayerPortrait(input: OwnerPlayerInput & { expectedRevision: string; idempotencyKey: string }): Promise<OwnerPlayerDetails>;
}
export type PlayerPortraitResponse = { kind: 'json'; statusCode: number; payload: Record<string, unknown> }
  | { kind: 'portrait'; statusCode: 200; bytes: Uint8Array };
export const PORTRAIT_JSON_BODY_LIMIT = 3 * 1024 * 1024;
export const PORTRAIT_DELETE_BODY_LIMIT = 8192;
export const PORTRAIT_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const playerId = z.string().refine(validPlayerIdentityId);
const leagueId = z.string().min(1).refine(value => {
  try { encodeURIComponent(value); return Boolean(value.trim()) && Buffer.byteLength(`LEAGUE#${value}`) <= 2048; } catch { return false; }
});
const upload = z.object({ expectedRevision: ownerProfileRevisionSchema,
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']), base64: z.string().min(1).max(2_796_204) }).strict();
const remove = z.object({ expectedRevision: ownerProfileRevisionSchema }).strict();
export const isPlayerPortraitRoute = (method: string, route: string): boolean =>
  (method === 'GET' && route === '/v1/player-portrait') || (['PUT', 'DELETE'].includes(method) && route === '/v1/owner-player-portrait');
export function parsePortraitBody(raw: string, method: string): unknown {
  if (Buffer.byteLength(raw) > (method === 'PUT' ? PORTRAIT_JSON_BODY_LIMIT : PORTRAIT_DELETE_BODY_LIMIT)) throw new RangeError('Portrait body too large');
  return JSON.parse(raw);
}
function fields(raw: string, allowed: string[]): Record<string, string> {
  if (raw.length > 24000) throw new URIError();
  const result: Record<string, string> = Object.create(null);
  for (const part of raw.split('&')) {
    const at = part.indexOf('='); if (at < 0) throw new URIError();
    const decode = (value: string) => decodeURIComponent(value.replaceAll('+', ' '));
    const key = decode(part.slice(0, at)), value = decode(part.slice(at + 1));
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new URIError();
    result[key] = value;
  }
  return result;
}

/** Media leaves this boundary as authenticated PNG bytes, never an object key or
 * storage URL. Mutation output is the same safe owner projection as name edits. */
export async function handlePlayerPortraitRoute(input: { method: string; route: string; rawQueryString?: string;
  body?: unknown; idempotencyKey?: unknown; session: AuthSessionRecord | null; repository: PlayerPortraitRepository;
  flags?: { profiles: boolean; ownerEditing: boolean } }): Promise<PlayerPortraitResponse> {
  const error = (statusCode: number, category: string, message: string, code?: string): PlayerPortraitResponse =>
    ({ kind: 'json', statusCode, payload: { error: category, message, ...(code ? { code } : {}) } });
  if (!input.session) return error(401, 'unauthorized', 'Sign in to continue.');
  const flags = input.flags ?? { profiles: process.env.PLAYER_PROFILES_ENABLED === 'true', ownerEditing: process.env.PLAYER_OWNER_EDITING_ENABLED === 'true' };
  const read = input.method === 'GET';
  if (!isPlayerPortraitRoute(input.method, input.route) || !(read ? flags.profiles : flags.ownerEditing)) return error(404, 'not_found', 'Not found.');
  let query: Record<string, string>;
  try {
    query = fields(input.rawQueryString ?? '', read ? ['leagueId', 'playerId', 'viewerPlayerId'] : ['playerId']);
    playerId.parse(query.playerId);
    if (read) { leagueId.parse(query.leagueId); if (query.viewerPlayerId !== undefined) playerId.parse(query.viewerPlayerId); }
  } catch { return error(400, 'bad_request', 'Check the player link and try again.'); }
  const userId = input.session.subject ?? input.session.email;
  const base = { playerId: query.playerId, userId, userIds: [...new Set([userId, input.session.email])] };
  if (read) {
    try {
      const bytes = await input.repository.getPlayerPortrait({ ...base, leagueId: query.leagueId,
        ...(query.viewerPlayerId !== undefined ? { viewerPlayerId: query.viewerPlayerId } : {}) });
      if (bytes === null) return error(404, 'portrait_not_found', 'This player has no portrait.');
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > 2 * 1024 * 1024
        || !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid portrait projection');
      return { kind: 'portrait', statusCode: 200, bytes };
    } catch (failure) {
      if (failure instanceof PlayerIdentityError) return error(failure.status, failure.category, failure.message, failure.code);
      return error(503, 'unavailable', 'Player portrait could not be loaded. Try again.');
    }
  }
  const key = ownerProfileIdempotencyKeySchema.safeParse(input.idempotencyKey);
  if (!key.success) return error(400, 'bad_request', 'Check the portrait save request and try again.');
  let operation: (() => Promise<OwnerPlayerDetails>);
  try {
    if (input.method === 'PUT') {
      const value = upload.parse(input.body), bytes = decodePortraitBase64(value.base64);
      operation = () => input.repository.putOwnerPlayerPortrait({ ...base, expectedRevision: value.expectedRevision,
        contentType: value.contentType, bytes, idempotencyKey: key.data });
    } else {
      const value = remove.parse(input.body);
      operation = () => input.repository.removeOwnerPlayerPortrait({ ...base, expectedRevision: value.expectedRevision, idempotencyKey: key.data });
    }
  } catch { return error(400, 'bad_request', 'Choose a valid cropped JPEG, PNG or WebP portrait and try again.'); }
  try { return { kind: 'json', statusCode: 200, payload: ownerPlayerDetailsSchema.parse(await operation()) }; }
  catch (failure) {
    if (failure instanceof PortraitInputError) return error(400, 'bad_request', 'Choose a valid cropped JPEG, PNG or WebP portrait and try again.');
    if (failure instanceof PlayerIdentityError) return error(failure.status, failure.category, failure.message, failure.code);
    return error(503, 'unavailable', 'Player portrait could not be saved. Try again.');
  }
}
