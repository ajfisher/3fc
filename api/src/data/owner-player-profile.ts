import { createHash, randomUUID } from 'node:crypto';
import { GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import type { OwnerPlayerProfile } from '@3fc/contracts';
import { IdentityReadCache } from './identity-read-cache.js';
import { PlayerIdentityPlanner, PlayerIdentityError, identityCondition, identityPut, boundedIdentityTransaction,
  validPlayerIdentityId, type IdentityClient, type IdentitySnapshot, type PlayerIdentity } from './player-identity.js';
import { historyBody, historyKey, type HistoryItem } from './player-history-model.js';
import { readHistoryReadiness } from './player-history-readiness.js';
import { PLAYER_PRESENTATION_SK, playerPresentationSchema, ownerDisplayNameSchema, ownerProfileRevisionSchema, ownerProfileIdempotencyKeySchema,
  profileWorkPartition, profileNameWorkKey, profileNameWorkSchema, type PlayerPresentation } from './player-profile-work.js';

export interface OwnerProfileInput { playerId: string; userId: string; userIds?: readonly string[] }
export interface RenameOwnerProfileInput extends OwnerProfileInput { displayName: string; expectedRevision: string; idempotencyKey: string }
export type SafeOwnerPlayerProfile = Omit<OwnerPlayerProfile, 'email'>;
type Data = Record<string, unknown>;
const profileSchema = z.object({ playerId: z.string().refine(validPlayerIdentityId), nickname: z.string().min(1), claimedByUserId: z.string().min(1).nullable() });
export const safeOwnerPlayerProfileSchema = z.object({ playerId: z.string().refine(validPlayerIdentityId), displayName: z.string().min(1), hasPortrait: z.boolean(), revision: ownerProfileRevisionSchema }).strict();
const safeSchema = safeOwnerPlayerProfileSchema;
const receiptSchema = z.object({ version: z.literal(1), requestHash: ownerProfileRevisionSchema, result: safeSchema }).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Semantic revision shared by names and photos; ordinary scoring writeVersion
 * changes still fence transactions but do not make an open settings form stale. */
export function ownerProfileResult(identity: PlayerIdentity, profile: Data, presentation: PlayerPresentation | null): SafeOwnerPlayerProfile {
  const media = presentation ? { version: presentation.version, playerId: presentation.playerId, nameRevision: presentation.nameRevision,
    portrait: presentation.portrait ?? null } : null;
  return { playerId: identity.playerId, displayName: identity.displayName, hasPortrait: Boolean(media?.portrait),
    revision: hash([identity.playerId, identity.identityVersion, identity.displayName, profile.claimedByUserId, profile.nickname, media]) };
}
function denied(): never { throw new PlayerIdentityError('owner_profile_forbidden', 403, 'Only the linked player can edit these details.'); }
function unavailable(): never { throw new PlayerIdentityError('owner_profile_unavailable', 503, 'Player details are temporarily unavailable.'); }
function changed(): never { throw new PlayerIdentityError('owner_profile_changed', 409, 'Player details changed. Refresh and try again.'); }
function conflict(): never { throw new PlayerIdentityError('owner_profile_request_conflict', 409, 'This request has changed. Retry the original request.'); }
function conditional(error: unknown): boolean {
  const value = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return value?.name === 'ConditionalCheckFailedException' || value?.name === 'TransactionConflictException'
    || (value?.name === 'TransactionCanceledException' && Boolean(value.CancellationReasons?.some(item => ['ConditionalCheckFailed', 'TransactionConflict'].includes(item.Code ?? '')))
      && value.CancellationReasons!.every(item => !item.Code || ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(item.Code)));
}

/** Owner settings are authorised directly from the current canonical claim.
 * League ACLs and caller-supplied owner hints never participate in this boundary. */
export class OwnerPlayerProfileService {
  private readonly now: () => string;
  private readonly processingEnabled: () => boolean;
  constructor(private readonly client: IdentityClient, private readonly tableName: string,
    options: { now?: () => string; processingEnabled?: () => boolean } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.processingEnabled = options.processingEnabled ?? (() => process.env.HISTORY_PROCESSING_ENABLED === 'true');
  }
  private async snapshot(client: IdentityClient, pk: string, sk: string, type: string): Promise<IdentitySnapshot<Data | null>> {
    const item = (await client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
    return { pk, sk, item, value: item ? historyBody<Data>(item, pk, sk, type) : null };
  }
  /** Internal server context only: raw authority snapshots must never be serialized. */
  async loadContext(input: OwnerProfileInput) {
    const accounts = [...new Set([input.userId, ...(input.userIds ?? [])])];
    if (!validPlayerIdentityId(input.playerId) || accounts.length > 2 || !accounts.every(id => {
      try { encodeURIComponent(id); return id.trim().length > 0 && Buffer.byteLength(`USER#${id}`) <= 2048; } catch { return false; }
    })) return denied();
    const cache = new IdentityReadCache(this.client, this.tableName, { deadlineMs: Date.now() + 6000 });
    await cache.prefetch([{ pk: 'PLAYER_IDENTITY', sk: 'CONTROL' }, { pk: `PLAYER#${input.playerId}`, sk: 'IDENTITY' }]);
    const planner = new PlayerIdentityPlanner(cache, this.tableName), control = await planner.readControl(); planner.requireDirectory(control);
    const original = await this.snapshot(cache, `PLAYER#${input.playerId}`, 'IDENTITY', 'playerIdentity');
    if (!original.value || !validPlayerIdentityId(original.value.rootId)) return denied();
    const rootId = original.value.rootId;
    await cache.prefetch([{ pk: `PLAYER#${rootId}`, sk: 'IDENTITY' }]);
    const root = await this.snapshot(cache, `PLAYER#${rootId}`, 'IDENTITY', 'playerIdentity');
    if (!root.value || !Array.isArray(root.value.members) || root.value.members.length > 20 || !root.value.members.every(validPlayerIdentityId)) return unavailable();
    await cache.prefetch([...root.value.members.map(id => ({ pk: `PLAYER#${id}`, sk: 'IDENTITY' })),
      { pk: `PLAYER#${rootId}`, sk: 'PROFILE' }, { pk: `PLAYER#${rootId}`, sk: PLAYER_PRESENTATION_SK }]);
    const identity = await planner.resolve(input.playerId);
    const profile = await this.snapshot(cache, `PLAYER#${rootId}`, 'PROFILE', 'player');
    if (!profile.value) return denied();
    const value = profileSchema.parse(profile.value);
    if (value.playerId !== rootId || value.claimedByUserId === null || !accounts.includes(value.claimedByUserId)) return denied();
    const presentation = await this.snapshot(cache, `PLAYER#${rootId}`, PLAYER_PRESENTATION_SK, 'playerPresentation');
    const media = presentation.value ? playerPresentationSchema.parse(presentation.value) : null;
    if (media && media.playerId !== rootId) return unavailable();
    const result = ownerProfileResult(identity.root.value, profile.value, media);
    const checks = [identityCondition(this.tableName, control), identityCondition(this.tableName, identity.root),
      identityCondition(this.tableName, profile), identityCondition(this.tableName, presentation),
      ...(identity.original.pk !== identity.root.pk ? [identityCondition(this.tableName, identity.original)] : [])];
    return { planner, control, identity, profile, presentation, media, result, checks };
  }
  private async fence(checks: TransactWriteItem[]): Promise<void> {
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction(checks) }));
  }
  async read(input: OwnerProfileInput): Promise<SafeOwnerPlayerProfile> {
    const context = await this.loadContext(input);
    try { await this.fence(context.checks); } catch (error) { if (conditional(error)) return changed(); throw error; }
    return context.result;
  }
  async rename(input: RenameOwnerProfileInput): Promise<SafeOwnerPlayerProfile> {
    const name = ownerDisplayNameSchema.safeParse(input.displayName), revision = ownerProfileRevisionSchema.safeParse(input.expectedRevision);
    if (!name.success || !revision.success || !ownerProfileIdempotencyKeySchema.safeParse(input.idempotencyKey).success)
      throw new PlayerIdentityError('owner_profile_invalid', 400, 'Check the player name and try again.');
    const receiptPk = profileWorkPartition(input.playerId), receiptSk = `RECEIPT#${hash([input.userId, input.idempotencyKey])}`;
    const requestHash = hash([input.playerId, name.data, revision.data]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const context = await this.loadContext(input);
      const receipt = await this.snapshot(this.client, receiptPk, receiptSk, 'playerProfileReceipt');
      if (receipt.value) {
        const saved = receiptSchema.parse(receipt.value); if (saved.requestHash !== requestHash) return conflict();
        // Replaying a completed mutation does not create processing work. It
        // remains available during a processing pause, after current canonical
        // ownership and the immutable receipt have both been fenced.
        try { await this.fence([...context.checks, identityCondition(this.tableName, receipt)]); }
        catch (error) { if (conditional(error) && attempt < 2) continue; if (conditional(error)) return changed(); throw error; }
        return saved.result;
      }
      if (!this.processingEnabled()) return unavailable();
      const readiness = await readHistoryReadiness(this.client, this.tableName);
      const base = [...context.checks, identityCondition(this.tableName, readiness)];
      if (context.result.revision !== revision.data) return changed();
      const now = z.string().datetime({ offset: true }).parse(this.now()), root = context.identity.root;
      let result = context.result;
      const actions: TransactWriteItem[] = [];
      if (name.data !== context.result.displayName) {
        const formerNames = [...new Set([...root.value.formerNames, root.value.displayName])].filter(value => value !== name.data);
        if (formerNames.length > 20) throw new PlayerIdentityError('owner_profile_name_history_full', 409, 'This name history needs organiser support.');
        const nameRevision = randomUUID(), presentation: PlayerPresentation = { ...context.media, version: 1, playerId: root.value.playerId, nameRevision };
        const profile: Data = { ...context.profile.value!, nickname: name.data };
        const nextIdentity = { ...root.value, displayName: name.data, formerNames, writeVersion: randomUUID() };
        result = ownerProfileResult(nextIdentity, profile, presentation);
        actions.push(identityPut(this.tableName, root, 'playerIdentity', nextIdentity, now),
          identityPut(this.tableName, context.profile, 'player', profile, now), identityPut(this.tableName, context.presentation, 'playerPresentation', presentation, now));
        const job = profileNameWorkSchema.parse({ version: 1, jobId: nameRevision, playerId: root.value.playerId, nameRevision, displayName: name.data,
          members: root.value.members, memberIndex: 0, cursor: null, status: 'pending', createdAt: now, updatedAt: now });
        actions.push(identityPut(this.tableName, { pk: profileWorkPartition(root.value.playerId), sk: profileNameWorkKey(nameRevision), item: null, value: null }, 'playerProfileNameWork', job, now));
      }
      const writtenKeys = new Set(actions.map(action => JSON.stringify([action.Put!.Item!.pk, action.Put!.Item!.sk])));
      actions.push(...base.filter(action => !writtenKeys.has(JSON.stringify([action.ConditionCheck!.Key!.pk, action.ConditionCheck!.Key!.sk]))),
        identityPut(this.tableName, receipt, 'playerProfileReceipt', { version: 1, requestHash, result }, now));
      try { await this.fence(actions); return result; }
      catch (error) {
        // A lost acknowledgement may already have committed the immutable
        // receipt. Re-enter through current ownership before replaying it.
        const saved = await this.snapshot(this.client, receiptPk, receiptSk, 'playerProfileReceipt');
        if ((saved.item || conditional(error)) && attempt < 2) continue;
        if (conditional(error)) return changed(); throw error;
      }
    }
    return changed();
  }
}
