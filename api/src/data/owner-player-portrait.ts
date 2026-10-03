import { createHash, randomUUID } from 'node:crypto';
import { GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { encodePlayerPortrait, portraitObjectKey } from '../media/player-portrait.js';
import { createPortraitStore, type PortraitStore } from '../media/portrait-store.js';
import { OwnerPlayerProfileService, ownerProfileResult, safeOwnerPlayerProfileSchema, type OwnerProfileInput, type SafeOwnerPlayerProfile } from './owner-player-profile.js';
import { PlayerProfileAccess, type ProfileAccessInput } from './player-profile-access.js';
import { PlayerIdentityError, identityCondition, identityPut, boundedIdentityTransaction, type IdentityClient, type IdentitySnapshot } from './player-identity.js';
import { historyBody, historyKey, type HistoryItem } from './player-history-model.js';
import { readHistoryReadiness } from './player-history-readiness.js';
import { PLAYER_PRESENTATION_SK, playerPresentationSchema, ownerProfileIdempotencyKeySchema, ownerProfileRevisionSchema,
  profileWorkPartition, profileMediaWorkKey, profileMediaWorkSchema, type ProfileMediaWork, type PlayerPresentation, type PortraitPointer } from './player-profile-work.js';

export interface PortraitMutationInput extends OwnerProfileInput { expectedRevision: string; idempotencyKey: string }
export interface PortraitUploadInput extends PortraitMutationInput { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Uint8Array }
type Snapshot = IdentitySnapshot<Record<string, unknown> | null>;
type OwnerContext = Awaited<ReturnType<OwnerPlayerProfileService['loadContext']>>;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown) => digest(Buffer.from(JSON.stringify(value)));
const receiptSchema = z.object({ version: z.literal(1), requestHash: ownerProfileRevisionSchema, result: safeOwnerPlayerProfileSchema }).strict();
const requestSchema = z.object({ version: z.literal(1), requestHash: ownerProfileRevisionSchema, playerId: z.string().min(1),
  jobId: z.string().uuid(), expectedRevision: ownerProfileRevisionSchema }).strict();
function unavailable(): never { throw new PlayerIdentityError('player_portrait_unavailable', 503, 'The player photo is temporarily unavailable.'); }
function changed(): never { throw new PlayerIdentityError('player_portrait_changed', 409, 'Player details changed. Refresh and try again.'); }
function conflict(): never { throw new PlayerIdentityError('player_portrait_request_conflict', 409, 'This request has changed. Retry the original request.'); }
function invalid(): never { throw new PlayerIdentityError('player_portrait_invalid', 400, 'Choose a valid cropped player photo.'); }
function conditional(error: unknown): boolean {
  const value = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return value?.name === 'ConditionalCheckFailedException' || value?.name === 'TransactionConflictException'
    || (value?.name === 'TransactionCanceledException' && Boolean(value.CancellationReasons?.some(reason => ['ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code ?? '')))
      && value.CancellationReasons!.every(reason => !reason.Code || ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code)));
}

/** Only processed portraits enter storage. Upload intents precede every object
 * put; publication and predecessor cleanup share an owner-fenced transaction. */
export class PlayerPortraitService {
  private readonly owner: OwnerPlayerProfileService;
  private readonly access: PlayerProfileAccess;
  private readonly now: () => string;
  private readonly processingEnabled: () => boolean;
  private readonly encode: typeof encodePlayerPortrait;
  private media?: PortraitStore;
  constructor(private readonly client: IdentityClient, private readonly tableName: string,
    options: { store?: PortraitStore; encode?: typeof encodePlayerPortrait; now?: () => string; processingEnabled?: () => boolean } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.processingEnabled = options.processingEnabled ?? (() => process.env.HISTORY_PROCESSING_ENABLED === 'true');
    this.owner = new OwnerPlayerProfileService(client, tableName, options); this.access = new PlayerProfileAccess(client, tableName);
    this.encode = options.encode ?? encodePlayerPortrait; this.media = options.store;
  }
  private store(): PortraitStore { return this.media ??= createPortraitStore(); }
  private async snapshot(pk: string, sk: string, type: string): Promise<Snapshot> {
    const item = (await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
    return { pk, sk, item, value: item ? historyBody<Record<string, unknown>>(item, pk, sk, type) : null };
  }
  private async transact(actions: TransactWriteItem[]): Promise<void> {
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction(actions) }));
  }
  private checks(context: OwnerContext, writes: TransactWriteItem[]): TransactWriteItem[] {
    const keys = new Set(writes.filter(action => action.Put).map(action => JSON.stringify([action.Put!.Item!.pk, action.Put!.Item!.sk])));
    return context.checks.filter(action => !keys.has(JSON.stringify([action.ConditionCheck!.Key!.pk, action.ConditionCheck!.Key!.sk])));
  }
  private request(input: PortraitMutationInput, operation: string, extra: unknown = null) {
    if (!ownerProfileRevisionSchema.safeParse(input.expectedRevision).success || !ownerProfileIdempotencyKeySchema.safeParse(input.idempotencyKey).success) return invalid();
    return { pk: profileWorkPartition(input.playerId), token: hash([input.userId, input.idempotencyKey]),
      requestHash: hash([operation, input.playerId, input.expectedRevision, extra]) };
  }
  private async replay(input: PortraitMutationInput, request: ReturnType<PlayerPortraitService['request']>, context: OwnerContext) {
    const receipt = await this.snapshot(request.pk, `PORTRAIT_RECEIPT#${request.token}`, 'playerPortraitReceipt');
    if (!receipt.value) return { receipt, result: null };
    const value = receiptSchema.parse(receipt.value); if (value.requestHash !== request.requestHash) return conflict();
    try { await this.transact([...context.checks, identityCondition(this.tableName, receipt)]); }
    catch (error) { if (conditional(error)) return changed(); throw error; }
    return { receipt, result: value.result };
  }
  private async reloadReplay(input: PortraitMutationInput, request: ReturnType<PlayerPortraitService['request']>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const context = await this.owner.loadContext(input);
      try { return { context, ...await this.replay(input, request, context) }; }
      catch (error) {
        if (error instanceof PlayerIdentityError && error.code === 'player_portrait_changed' && attempt < 2) continue;
        throw error;
      }
    }
    return changed();
  }
  private async completedOrChanged(input: PortraitMutationInput, request: ReturnType<PlayerPortraitService['request']>): Promise<SafeOwnerPlayerProfile> {
    const replay = await this.reloadReplay(input, request); return replay.result ?? changed();
  }
  private async recoverFinal(input: PortraitMutationInput, request: ReturnType<PlayerPortraitService['request']>, error: unknown): Promise<SafeOwnerPlayerProfile> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const replay = await this.reloadReplay(input, request); if (replay.result) return replay.result;
      if (conditional(error) && attempt < 2) await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      else break;
    }
    if (conditional(error)) return changed(); throw error;
  }
  private async readiness() { if (!this.processingEnabled()) return unavailable(); return readHistoryReadiness(this.client, this.tableName); }
  private mediaValue(snapshot: Snapshot, playerId: string, jobId: string): ProfileMediaWork {
    const work = profileMediaWorkSchema.parse(snapshot.value);
    if (work.playerId !== playerId || work.jobId !== jobId || snapshot.pk !== profileWorkPartition(playerId) || snapshot.sk !== profileMediaWorkKey(jobId)) return unavailable();
    return work;
  }
  private async predecessor(context: OwnerContext, now: string): Promise<TransactWriteItem[]> {
    const pointer = context.media?.portrait; if (!pointer) return [];
    const snapshot = await this.snapshot(profileWorkPartition(context.result.playerId), profileMediaWorkKey(pointer.jobId), 'playerProfileMediaWork');
    const value = this.mediaValue(snapshot, context.result.playerId, pointer.jobId);
    if (value.status !== 'active' || value.objectKey !== pointer.objectKey || value.digest !== pointer.digest || value.bytes !== pointer.bytes) return unavailable();
    // Identical requests can still have a bounded object put in flight after
    // this intent was published. Keep its original lease before deletion so a
    // late immutable retry cannot recreate an object after cleanup removes it.
    const notBefore = Date.parse(value.notBefore) > Date.parse(now) ? value.notBefore : now;
    return [identityPut(this.tableName, snapshot, 'playerProfileMediaWork', { ...value, status: 'cleanup', notBefore, updatedAt: now }, now)];
  }
  private async complete(input: PortraitMutationInput, request: ReturnType<PlayerPortraitService['request']>, context: OwnerContext,
    receipt: Snapshot, presentation: PlayerPresentation | null, other: TransactWriteItem[], readiness: Awaited<ReturnType<PlayerPortraitService['readiness']>>) {
    const now = this.now(), result = ownerProfileResult(context.identity.root.value, context.profile.value!, presentation);
    const writes = [...other, ...(presentation ? [identityPut(this.tableName, context.presentation, 'playerPresentation', presentation, now)] : []),
      identityPut(this.tableName, receipt, 'playerPortraitReceipt', { version: 1, requestHash: request.requestHash, result }, now)];
    try { await this.transact([...this.checks(context, writes), identityCondition(this.tableName, readiness), ...writes]); return result; }
    catch (error) {
      // Never delete a candidate object on an ambiguous commit: the receipt may
      // already point at it. Cleanup owns abandoned intent objects durably.
      return this.recoverFinal(input, request, error);
    }
  }
  async upload(input: PortraitUploadInput): Promise<SafeOwnerPlayerProfile> {
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || input.bytes.byteLength > 2 * 1024 * 1024
      || !['image/jpeg', 'image/png', 'image/webp'].includes(input.contentType)) return invalid();
    const request = this.request(input, 'upload', [input.contentType, digest(input.bytes)]), replay = await this.reloadReplay(input, request);
    if (replay.result) return replay.result;
    const initial = replay.context;
    const readiness = await this.readiness();
    if (initial.result.revision !== input.expectedRevision) return changed();
    let reservation = await this.snapshot(request.pk, `PORTRAIT_REQUEST#${request.token}`, 'playerPortraitRequest');
    let saved = reservation.value ? requestSchema.parse(reservation.value) : null;
    if (saved && saved.requestHash !== request.requestHash) return conflict();
    if (saved && (saved.playerId !== initial.result.playerId || saved.expectedRevision !== input.expectedRevision)) return changed();
    const encoded = await this.encode(Buffer.from(input.bytes));
    if (!encoded.bytes.length || encoded.bytes.length > 2 * 1024 * 1024 || encoded.contentType !== 'image/png' || digest(encoded.bytes) !== encoded.sha256) return unavailable();
    if (!saved) {
      const now = z.string().datetime({ offset: true }).parse(this.now()), jobId = randomUUID();
      saved = { version: 1, requestHash: request.requestHash, playerId: initial.result.playerId, jobId, expectedRevision: input.expectedRevision };
      const work = profileMediaWorkSchema.parse({ version: 1, jobId, playerId: saved.playerId, objectKey: portraitObjectKey(saved.playerId, jobId),
        digest: encoded.sha256, bytes: encoded.bytes.length, status: 'uploading', notBefore: new Date(Date.parse(now) + 120_000).toISOString(), createdAt: now, updatedAt: now });
      try { await this.transact([...initial.checks, identityCondition(this.tableName, readiness),
        identityPut(this.tableName, reservation, 'playerPortraitRequest', saved, now),
        identityPut(this.tableName, { pk: profileWorkPartition(saved.playerId), sk: profileMediaWorkKey(jobId), item: null, value: null }, 'playerProfileMediaWork', work, now)]); }
      catch (error) {
        // Another identical request may have won the reservation, or this
        // request may have committed despite a lost acknowledgement. Join only
        // its verified canonical reservation; never upload the losing job ID.
        saved = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const latest = await this.reloadReplay(input, request); if (latest.result) return latest.result;
          reservation = await this.snapshot(request.pk, reservation.sk, 'playerPortraitRequest');
          if (reservation.value) {
            const winner = requestSchema.parse(reservation.value);
            if (winner.requestHash !== request.requestHash) return conflict();
            if (winner.playerId !== latest.context.result.playerId || winner.expectedRevision !== input.expectedRevision
              || latest.context.result.revision !== input.expectedRevision) return this.completedOrChanged(input, request);
            saved = winner; break;
          }
          if (latest.context.result.revision !== input.expectedRevision) return this.completedOrChanged(input, request);
          if (attempt < 2 && conditional(error)) await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
          else break;
        }
        if (!saved) { if (conditional(error)) return changed(); throw error; }
      }
      reservation = await this.snapshot(request.pk, reservation.sk, 'playerPortraitRequest');
    }
    let intent = await this.snapshot(profileWorkPartition(saved.playerId), profileMediaWorkKey(saved.jobId), 'playerProfileMediaWork');
    let work = this.mediaValue(intent, saved.playerId, saved.jobId);
    if (work.status !== 'uploading') return this.completedOrChanged(input, request);
    if (work.digest !== encoded.sha256 || work.bytes !== encoded.bytes.length) return changed();
    // Never renew an old lease: cleanup may already be about to claim it. A
    // bounded5s put starts only with30s left inside the original120s window.
    if (Date.parse(work.notBefore) - Date.parse(this.now()) < 30_000) return changed();
    await this.store().put(work.objectKey, encoded.bytes, AbortSignal.timeout(5000));
    const finalReplay = await this.reloadReplay(input, request), current = finalReplay.context;
    if (finalReplay.result) return finalReplay.result;
    if (current.result.playerId !== saved.playerId || current.result.revision !== input.expectedRevision) return this.completedOrChanged(input, request);
    const finalReadiness = await this.readiness();
    intent = await this.snapshot(intent.pk, intent.sk, 'playerProfileMediaWork'); work = this.mediaValue(intent, saved.playerId, saved.jobId);
    if (work.status !== 'uploading') return this.completedOrChanged(input, request);
    if (Date.parse(work.notBefore) <= Date.parse(this.now())) return changed();
    const now = this.now(), pointer: PortraitPointer = { jobId: work.jobId, objectKey: work.objectKey, digest: work.digest, bytes: work.bytes,
      contentType: 'image/png', width: 512, height: 512 };
    const presentation: PlayerPresentation = { ...current.media, version: 1, playerId: saved.playerId, nameRevision: current.media?.nameRevision ?? randomUUID(), portrait: pointer };
    let predecessor: TransactWriteItem[];
    try { predecessor = await this.predecessor(current, now); }
    catch (error) { return this.recoverFinal(input, request, error); }
    const writes = [...predecessor, identityPut(this.tableName, intent, 'playerProfileMediaWork', { ...work, status: 'active', updatedAt: now }, now),
      identityCondition(this.tableName, reservation)];
    return this.complete(input, request, current, finalReplay.receipt, presentation, writes, finalReadiness);
  }
  async remove(input: PortraitMutationInput): Promise<SafeOwnerPlayerProfile> {
    const request = this.request(input, 'remove'), replay = await this.reloadReplay(input, request), context = replay.context;
    if (replay.result) return replay.result;
    const readiness = await this.readiness(); if (context.result.revision !== input.expectedRevision) return changed();
    const now = this.now(), presentation = context.media ? { ...context.media, portrait: null } : null;
    let predecessor: TransactWriteItem[];
    try { predecessor = await this.predecessor(context, now); }
    catch (error) { return this.recoverFinal(input, request, error); }
    return this.complete(input, request, context, replay.receipt, presentation, predecessor, readiness);
  }
  async read(input: ProfileAccessInput): Promise<Uint8Array | null> {
    const grant = await this.access.authorize(input), snapshot = await this.snapshot(`PLAYER#${grant.player.playerId}`, PLAYER_PRESENTATION_SK, 'playerPresentation');
    const value = snapshot.value ? playerPresentationSchema.parse(snapshot.value) : null;
    if (value && value.playerId !== grant.player.playerId) return unavailable();
    const pointer = value?.portrait; let bytes: Buffer | null = null;
    if (pointer) {
      bytes = await this.store().get(pointer.objectKey, AbortSignal.timeout(5000));
      if (!bytes || bytes.length !== pointer.bytes || digest(bytes) !== pointer.digest) return unavailable();
    }
    await this.access.assertCurrent(grant.checks, [identityCondition(this.tableName, snapshot)]); return bytes;
  }
}
