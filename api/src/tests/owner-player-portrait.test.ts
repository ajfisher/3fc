import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { BatchGetItemCommand, GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { PlayerPortraitService } from '../data/owner-player-portrait.js';
import { OwnerPlayerProfileService } from '../data/owner-player-profile.js';
import { historyRow, historyKey, type HistoryItem } from '../data/player-history-model.js';
import { identityDirectorySk, identityLeagueSk } from '../data/player-identity.js';
import { profileWorkPartition, profileMediaWorkKey, playerPresentationSchema } from '../data/player-profile-work.js';
import type { PortraitStore } from '../media/portrait-store.js';

const at = '2026-10-04T12:00:00.000Z', userId = 'owner-subject', email = 'private@example.test';
const input = { playerId: 'root', userId, userIds: [userId, email] }, readInput = { ...input, leagueId: 'league' };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const keyOf = (row: HistoryItem) => JSON.stringify([row.pk.S, row.sk.S]);
const body = (row: HistoryItem) => JSON.parse(row.data.S!);
class Memory {
  rows = new Map<string, HistoryItem>(); transactions: TransactWriteItem[][] = [];
  beforeCommit: ((actions: TransactWriteItem[]) => void) | null = null;
  loseAck: ((actions: TransactWriteItem[]) => boolean) | null = null;
  seed(pk: string, sk: string, type: string, data: unknown) { const row = historyRow(pk, sk, type, data); this.rows.set(keyOf(row), row); return row; }
  get(pk: string, sk: string) { return this.rows.get(keyOf(historyKey(pk, sk))); }
  update(pk: string, sk: string, patch: Record<string, unknown>) { const row = this.get(pk, sk)!; row.data = { S: JSON.stringify({ ...body(row), ...patch }) }; }
  ofType(type: string) { return [...this.rows.values()].filter(row => row.entityType.S === type); }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetItemCommand) {
      assert.equal(command.input.ConsistentRead, true); return { Item: structuredClone(this.rows.get(keyOf(command.input.Key!))) };
    }
    if (command instanceof BatchGetItemCommand) {
      const request = command.input.RequestItems!.table; assert.equal(request.ConsistentRead, true); assert(request.Keys!.length <= 100);
      return { Responses: { table: request.Keys!.flatMap(key => { const row = this.rows.get(keyOf(key)); return row ? [structuredClone(row)] : []; }) } };
    }
    assert(command instanceof TransactWriteItemsCommand, 'portrait operations never scan or enumerate history');
    const actions = command.input.TransactItems!; this.transactions.push(structuredClone(actions)); assert(actions.length <= 100);
    const keys = actions.map(action => keyOf(action.Put?.Item ?? action.ConditionCheck!.Key!)); assert.equal(new Set(keys).size, keys.length);
    this.beforeCommit?.(actions);
    const validity = actions.map(action => {
      const op = action.Put ?? action.ConditionCheck!, row = this.rows.get(keyOf(action.Put?.Item ?? action.ConditionCheck!.Key!));
      return op.ConditionExpression!.split(' AND ').every(expression => {
        const absent = expression.match(/^attribute_not_exists\((.+)\)$/); if (absent) return !row?.[absent[1]];
        const equal = expression.match(/^(\S+) = (\S+)$/); assert(equal);
        return JSON.stringify(row?.[op.ExpressionAttributeNames![equal[1]]]) === JSON.stringify(op.ExpressionAttributeValues![equal[2]]);
      });
    });
    if (validity.some(value => !value)) throw Object.assign(new Error('changed'), { name: 'TransactionCanceledException',
      CancellationReasons: validity.map(value => ({ Code: value ? 'None' : 'ConditionalCheckFailed' })) });
    for (const action of actions) if (action.Put) this.rows.set(keyOf(action.Put.Item!), structuredClone(action.Put.Item!));
    if (this.loseAck?.(actions)) throw new Error('lost acknowledgement');
    return {};
  }
}
function fixture() {
  const client = new Memory(); let now = at, enabled = true, encodeCalls = 0;
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'unknown', epoch: 'e1', writerVersion: 1 });
  client.seed('PLAYER#root', 'IDENTITY', 'playerIdentity', { playerId: 'root', rootId: 'root', members: ['root'], identityVersion: 1, writeVersion: 'w1', displayName: 'Player', formerNames: [] });
  client.seed('PLAYER#root', 'PROFILE', 'player', { playerId: 'root', nickname: 'Player', claimedByUserId: userId });
  client.seed('PLAYER#root', 'PRESENTATION', 'playerPresentation', { version: 1, playerId: 'root', nameRevision: randomUUID() });
  client.seed('LEAGUE#league', 'METADATA', 'league', { leagueId: 'league', name: 'League' });
  client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'd1' });
  client.seed('LEAGUE#league', identityDirectorySk('root'), 'leaguePlayer', { playerId: 'root', nickname: 'Player', formerNames: [], active: true });
  client.seed('PLAYER#root', identityLeagueSk('league'), 'playerLeagueMembership', { playerId: 'root', leagueId: 'league' });
  client.seed('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', { version: 1, enabled: true, revision: randomUUID(), ruleVersion: 1, activatedAt: at,
    manifest: { version: 1, writerVersion: 1, writerSha: 'a'.repeat(40), tableName: 'table', accountId: '301691475109', region: 'ap-southeast-2', reviewedPlan: 'https://github.com/ajfisher/3fc/pull/210', drainedAt: at, ruleVersion: 1 } });
  const objects = new Map<string, Buffer>(), puts: string[] = [], deletes: string[] = [];
  let onPut: (() => void | Promise<void>) | null = null, onGet: (() => void) | null = null;
  const store: PortraitStore = {
    async put(key, bytes) {
      const intent = client.ofType('playerProfileMediaWork').find(row => body(row).objectKey === key); assert(intent, 'durable intent precedes all object puts');
      assert.equal(body(intent).status, 'uploading'); puts.push(key);
      const existing = objects.get(key); if (existing) assert.deepEqual(existing, bytes, 'immutable object retry');
      objects.set(key, Buffer.from(bytes)); await onPut?.();
    },
    async get(key) { const bytes = objects.get(key); onGet?.(); return bytes ? Buffer.from(bytes) : null; },
    async delete(key) { deletes.push(key); objects.delete(key); }
  };
  const encode = async (raw: Buffer) => { encodeCalls++; const bytes = Buffer.concat([Buffer.from('processed:'), raw]);
    return { bytes, sha256: hash(bytes), contentType: 'image/png' as const }; };
  const options = { store, encode, now: () => now, processingEnabled: () => enabled };
  const service = new PlayerPortraitService(client, 'table', options), owner = new OwnerPlayerProfileService(client, 'table', options);
  const request = async (key = 'upload', raw = 'crop') => ({ ...input, expectedRevision: (await owner.read(input)).revision,
    idempotencyKey: key, contentType: 'image/png' as const, bytes: Buffer.from(raw) });
  const presentation = () => playerPresentationSchema.parse(body(client.get('PLAYER#root', 'PRESENTATION')!));
  return { client, service, owner, objects, puts, deletes, request, presentation, get encodeCalls() { return encodeCalls; },
    setNow: (value: string) => { now = value; }, pause: () => { enabled = false; }, onPut: (fn: typeof onPut) => { onPut = fn; }, onGet: (fn: typeof onGet) => { onGet = fn; } };
}

test('upload persists intent before object IO and publishes safe portrait and receipt atomically', async () => {
  const f = fixture(), previous = f.presentation(), request = await f.request();
  const result = await f.service.upload(request), pointer = f.presentation().portrait!;
  assert.equal(result.hasPortrait, true); assert.equal(result.revision, (await f.owner.read(input)).revision);
  assert.equal(f.presentation().nameRevision, previous.nameRevision); assert.match(pointer.objectKey, /^portraits\/[a-f0-9]{64}\/[0-9a-f-]{36}\.png$/);
  assert.equal(body(f.client.get(profileWorkPartition('root'), profileMediaWorkKey(pointer.jobId))!).status, 'active');
  const commit = f.client.transactions.find(actions => actions.some(action => action.Put?.Item?.entityType?.S === 'playerPortraitReceipt'))!;
  assert.deepEqual(commit.filter(action => action.Put).map(action => action.Put!.Item!.entityType.S).sort(), ['playerPortraitReceipt', 'playerPresentation', 'playerProfileMediaWork'].sort());
  assert.equal(f.client.ofType('playerPortraitRequest').length, 1); assert.equal(f.client.ofType('playerPortraitReceipt').length, 1);
  assert(!JSON.stringify(f.client.ofType('playerPortraitReceipt')).includes(email)); assert(!JSON.stringify(result).includes('objectKey'));
  assert.deepEqual(await f.service.read(readInput), f.objects.get(pointer.objectKey));
});

test('replace and remove durably schedule the previous immutable object while restoring initials immediately', async () => {
  const f = fixture(); await f.service.upload(await f.request('first', 'one')); const first = f.presentation().portrait!;
  await f.service.upload(await f.request('second', 'two')); const second = f.presentation().portrait!;
  assert.notEqual(first.objectKey, second.objectKey);
  assert.equal(body(f.client.get(profileWorkPartition('root'), profileMediaWorkKey(first.jobId))!).status, 'cleanup');
  const nameRevision = f.presentation().nameRevision, current = await f.owner.read(input);
  const removed = await f.service.remove({ ...input, expectedRevision: current.revision, idempotencyKey: 'remove' });
  assert.equal(removed.hasPortrait, false); assert.equal(f.presentation().nameRevision, nameRevision); assert.equal(f.presentation().portrait, null);
  assert.equal(body(f.client.get(profileWorkPartition('root'), profileMediaWorkKey(second.jobId))!).status, 'cleanup');
  assert.equal(await f.service.read(readInput), null); assert.deepEqual(f.deletes, [], 'request path never deletes potentially published objects');
});

test('name changes preserve portraits and portrait revisions make stale name/photo requests fail', async () => {
  const f = fixture(), before = await f.owner.read(input); await f.service.upload(await f.request()); const photo = f.presentation().portrait!;
  await assert.rejects(f.owner.rename({ ...input, displayName: 'Stale', expectedRevision: before.revision, idempotencyKey: 'stale-name' }), error => (error as any).status === 409);
  const current = await f.owner.read(input);
  const renamed = await f.owner.rename({ ...input, displayName: 'New name', expectedRevision: current.revision, idempotencyKey: 'name' });
  assert.equal(renamed.hasPortrait, true); assert.deepEqual(f.presentation().portrait, photo);
  await assert.rejects(f.service.remove({ ...input, expectedRevision: current.revision, idempotencyKey: 'stale-photo' }), error => (error as any).status === 409);
});

test('lost final acknowledgement and exact paused retries never restore an older photo', async () => {
  const f = fixture(), firstRequest = await f.request('first', 'one');
  f.client.loseAck = actions => {
    if (!actions.some(action => action.Put?.Item?.entityType?.S === 'playerPortraitReceipt')) return false;
    f.client.loseAck = null; return true;
  };
  const saved = await f.service.upload(firstRequest); assert.equal(f.puts.length, 1);
  await f.service.upload(await f.request('second', 'two')); const currentPhoto = f.presentation().portrait;
  f.pause(); f.client.update('PLAYER_HISTORY', 'CONTROL', { enabled: false }); const beforePuts = f.puts.length, beforeEncodes = f.encodeCalls;
  assert.deepEqual(await f.service.upload(firstRequest), saved); assert.deepEqual(f.presentation().portrait, currentPhoto);
  assert.equal(f.puts.length, beforePuts); assert.equal(f.encodeCalls, beforeEncodes);
  await assert.rejects(f.service.upload({ ...firstRequest, bytes: Buffer.from('different') }), error => (error as any).status === 409);
  f.client.update('PLAYER#root', 'PROFILE', { claimedByUserId: 'stranger' });
  await assert.rejects(f.service.upload(firstRequest), error => (error as any).status === 403);
});

test('an abandoned upload is retryable only inside its original lease and before cleanup claims it', async () => {
  for (const expired of [false, true]) {
    const f = fixture(), request = await f.request(); f.onPut(() => { throw new Error('upload response lost'); });
    await assert.rejects(f.service.upload(request), /upload response lost/); assert.equal(f.presentation().portrait, undefined);
    const intent = f.client.ofType('playerProfileMediaWork')[0], original = body(intent); assert.equal(original.status, 'uploading');
    f.onPut(null);
    if (expired) {
      f.setNow('2026-10-04T12:01:31.000Z'); const puts = f.puts.length;
      await assert.rejects(f.service.upload(request), error => (error as any).status === 409); assert.equal(f.puts.length, puts);
      assert.equal(body(intent).notBefore, original.notBefore, 'retries never extend cleanup lease');
    } else {
      const saved = await f.service.upload(request); assert.equal(saved.hasPortrait, true); assert.equal(f.client.ofType('playerProfileMediaWork').length, 1);
    }
  }
});

test('cleanup claim, ownership change and simultaneous rename prevent stale upload publication', async () => {
  for (const change of ['cleanup', 'owner', 'name']) {
    const f = fixture(), request = await f.request();
    f.onPut(async () => {
      if (change === 'cleanup') { const row = f.client.ofType('playerProfileMediaWork')[0]; f.client.update(row.pk.S!, row.sk.S!, { status: 'deleting' }); }
      if (change === 'owner') f.client.update('PLAYER#root', 'PROFILE', { claimedByUserId: 'stranger' });
      if (change === 'name') await f.owner.rename({ ...input, displayName: 'Changed during upload', expectedRevision: request.expectedRevision, idempotencyKey: 'racing-name' });
    });
    await assert.rejects(f.service.upload(request), error => [403, 409].includes((error as any).status));
    assert.equal(f.presentation().portrait, undefined); assert.equal(f.client.ofType('playerPortraitReceipt').length, 0);
    assert.equal(f.objects.size, 1); assert.deepEqual(f.deletes, [], 'orphan is retained for durable cleanup, never deleted after an ambiguous commit');
  }
});

test('league media reads recheck pointer and authority after fetch and reject foreign viewers or corrupted bytes', async () => {
  const f = fixture(); await f.service.upload(await f.request());
  await assert.rejects(f.service.read({ ...readInput, userId: 'stranger', userIds: ['stranger'] }), error => (error as any).status === 403);
  await assert.rejects(f.service.read({ ...readInput, leagueId: 'other' }));
  f.onGet(() => f.client.update('PLAYER#root', 'PRESENTATION', { portrait: null }));
  await assert.rejects(f.service.read(readInput), error => (error as any).status === 409);
  f.onGet(null); assert.equal(await f.service.read(readInput), null);
  const g = fixture(); await g.service.upload(await g.request()); g.objects.set(g.presentation().portrait!.objectKey, Buffer.from('corrupt'));
  await assert.rejects(g.service.read(readInput), error => (error as any).status === 503);
});

test('malformed and oversized crop inputs never create work and blank portrait removal remains idempotent', async () => {
  const f = fixture(), request = await f.request();
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1)])
    await assert.rejects(f.service.upload({ ...request, bytes }), error => (error as any).status === 400);
  const remove = { ...input, expectedRevision: request.expectedRevision, idempotencyKey: 'empty-remove' };
  const first = await f.service.remove(remove); assert.equal(first.hasPortrait, false); assert.deepEqual(await f.service.remove(remove), first);
  assert.equal(f.client.ofType('playerProfileMediaWork').length, 0); assert.equal(f.puts.length, 0);
});
